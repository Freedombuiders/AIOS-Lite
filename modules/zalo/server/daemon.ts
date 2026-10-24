/**
 * Zalo daemon — the one process that owns the zca-js sessions.
 *
 * Zalo allows a single web listener per account, so exactly one process
 * may hold them. Keeping it out of the AIOS process means a restart does
 * not drop every Zalo socket, and a crash inside the unofficial library
 * cannot take AIOS down with it. The AIOS process supervises
 * this daemon (supervisor.ts).
 *
 *   node dist/modules/zalo/server/daemon.js   (env: ZALO_CONTROL_PORT, ZALO_CONTROL_TOKEN, ZALO_DATA_DIR, ZALO_DB_PATH)
 */

import '../../../src/modules/compat/crash-guard.js';

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';

import { isProcessAlive, logger } from './compat.js';
import { bindDaemonCompat } from './daemon-bind.js';
import { backfillAccount, GroupSyncLoop, syncGroupList } from './history.js';
import { localDay } from './limits.js';
import { startBirthdayWorker } from './birthday.js';
import { startGroupBroadcastWorker } from './group-broadcast.js';
import { startListBroadcastWorker } from './list-broadcast.js';
import type { MarketingDeps, WorkerHandle } from './marketing-deps.js';
import { buildCareControl, careLink, type CareControl } from './care-bridge.js';
import { ZALO_TOKEN_HEADER } from './control.js';
import { setZaloDataDir, ZALO_PID_FILE } from './paths.js';
import { ZaloSender } from './sender.js';
import { ZaloSessionPool } from './session.js';
import { threadProfiles } from './profiles.js';
import { resolveSticker, stickerId } from './stickers.js';
import {
  failInterruptedZaloOutbox,
  getZaloAccount,
  getZaloMessage,
  getZaloProtectionSettings,
  getZaloThread,
  listZaloAccounts,
  pruneZaloUsage,
} from './store.js';

const OUTBOX_POLL_MS = 2_000;
const MAX_NOTICES = 50;

// ── Environment handed over by the supervisor ───────────────────────
const env = process.env;
const CONTROL_PORT = Number(env.ZALO_CONTROL_PORT);
const controlToken = env.ZALO_CONTROL_TOKEN ?? '';
if (!Number.isInteger(CONTROL_PORT) || CONTROL_PORT <= 0 || !controlToken || !env.ZALO_DATA_DIR || !env.ZALO_DB_PATH) {
  logger.fatal('zalo daemon: missing ZALO_CONTROL_PORT / ZALO_CONTROL_TOKEN / ZALO_DATA_DIR / ZALO_DB_PATH');
  process.exit(1);
}
setZaloDataDir(env.ZALO_DATA_DIR);
fs.mkdirSync(env.ZALO_DATA_DIR, { recursive: true, mode: 0o700 });

// ── Single instance ─────────────────────────────────────────────────
try {
  const old = parseInt(fs.readFileSync(ZALO_PID_FILE, 'utf-8').trim(), 10);
  if (Number.isFinite(old) && old !== process.pid && isProcessAlive(old)) {
    logger.warn({ pid: old }, 'zalo daemon already running — exiting');
    process.exit(0);
  }
} catch { /* no pid file */ }

// Same database file as the AIOS process (WAL); module tables only.
bindDaemonCompat(env.ZALO_DB_PATH);
fs.writeFileSync(ZALO_PID_FILE, String(process.pid), { mode: 0o600 });

process.on('unhandledRejection', (reason) => {
  logger.error({ err: String((reason as Error)?.message ?? reason) }, 'zalo daemon: unhandled rejection');
});

const interrupted = failInterruptedZaloOutbox();
if (interrupted > 0) logger.warn({ interrupted }, 'zalo outbox rows interrupted by the previous run marked failed');

// ── Operator notices: the AIOS process polls GET /notices and raises them as attention items ──
let noticeSeq = 0;
const notices: Array<{ seq: number; text: string; at: number }> = [];
async function notify(text: string): Promise<void> {
  notices.push({ seq: ++noticeSeq, text: text.slice(0, 1500), at: Date.now() });
  if (notices.length > MAX_NOTICES) notices.shift();
}

// ── Runtime config pushed by the AIOS process (POST /config) ────────
const runtime = { marketingEnabled: true };

// ── Wiring ──────────────────────────────────────────────────────────
const groupSync = new GroupSyncLoop();
const backfilling = new Set<string>();
// The pool's hooks close over the care control built right after it.
let careControl: CareControl | null = null;
const pool = new ZaloSessionPool({
  // Messages are stored by ingest; the care module reads them through the feed (care-bridge), nothing answers here.
  onMessage: () => {},
  onConnected: (accountId, ctx, firstLogin) => {
    careControl?.onConnected(accountId);
    groupSync.start(ctx);
    if (firstLogin) {
      backfilling.add(accountId);
      void backfillAccount(ctx).finally(() => backfilling.delete(accountId));
    } else {
      void syncGroupList(ctx).catch((err) => logger.warn({ accountId, err: String(err) }, 'zalo group list sync failed'));
    }
    void sender.drainOutbox();
  },
  onDisconnected: (accountId) => groupSync.stop(accountId),
});
careControl = buildCareControl(pool, controlToken, {
  quoteReplies: env.ZALO_CARE_QUOTE === '1',
  seenMarker: env.ZALO_CARE_SEEN === '1',
});
const sender = new ZaloSender(pool, { notify });

const outboxTimer = setInterval(() => void sender.drainOutbox(), OUTBOX_POLL_MS);

// Marketing workers (Zalo › Marketing): each polls its own SQLite tables.
const marketingDeps: MarketingDeps = { pool, sender, notify };
let marketingWorkers: WorkerHandle[] = [];
function setMarketing(enabled: boolean): void {
  runtime.marketingEnabled = enabled;
  if (enabled && marketingWorkers.length === 0) {
    marketingWorkers = [
      startGroupBroadcastWorker(marketingDeps),
      startListBroadcastWorker(marketingDeps),
      startBirthdayWorker(marketingDeps),
    ];
  } else if (!enabled && marketingWorkers.length > 0) {
    for (const w of marketingWorkers) { try { w.stop(); } catch { /* ignore */ } }
    marketingWorkers = [];
  }
}
setMarketing(env.ZALO_MARKETING_ENABLED !== '0');
const pruneTimer = setInterval(() => {
  try {
    // Daily SDK counters are only read for today; keep two weeks for debugging.
    pruneZaloUsage(localDay(new Date(Date.now() - 14 * 86400_000), getZaloProtectionSettings().timezone));
  } catch { /* ignore */ }
}, 24 * 3600_000);
pruneTimer.unref?.();

// ── Control server (loopback only) ──────────────────────────────────
function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf-8'); if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) as Record<string, unknown> : {}); } catch { resolve({}); }
    });
  });
}

function accountState(accountId: string) {
  return {
    live: pool.getLiveStatus(accountId),
    qr: pool.getQrState(accountId),
    backfilling: backfilling.has(accountId),
  };
}

const server = http.createServer((req, res) => {
  void (async () => {
    const token = req.headers[ZALO_TOKEN_HEADER];
    const given = Buffer.from(typeof token === 'string' ? token : '');
    const expected = Buffer.from(controlToken);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/status') {
      send(res, 200, {
        pid: process.pid,
        accounts: Object.fromEntries(listZaloAccounts().map((a) => [a.id, accountState(a.id)])),
      });
      return;
    }
    if (parts[0] === 'care' && careControl) {
      const care = await careControl.handle({
        method,
        parts,
        query: url.searchParams,
        body: method === 'POST' ? await readBody(req) : {},
        token: typeof token === 'string' ? token : undefined,
      });
      if (care) { send(res, care.status, care.data); return; }
    }
    if (method === 'GET' && url.pathname === '/notices') {
      const after = Number(url.searchParams.get('after') ?? 0) || 0;
      send(res, 200, { notices: notices.filter((n) => n.seq > after) });
      return;
    }
    if (method === 'POST' && url.pathname === '/config') {
      const body = await readBody(req);
      if (typeof body.marketingEnabled === 'boolean') setMarketing(body.marketingEnabled);
      if (typeof body.careLinked === 'boolean') {
        const was = careLink.linked;
        careLink.linked = body.careLinked;
        if (body.careLinked && !was) careControl?.onLinked(listZaloAccounts().map((a) => a.id));
      }
      send(res, 200, { ok: true, marketingEnabled: runtime.marketingEnabled, careLinked: careLink.linked });
      return;
    }
    if (method === 'POST' && url.pathname === '/outbox/kick') {
      void sender.drainOutbox();
      send(res, 200, { ok: true });
      return;
    }
    if (parts[0] === 'messages' && parts[2] === 'sticker' && method === 'GET') {
      const message = getZaloMessage(Number(parts[1]));
      const thread = message && getZaloThread(message.thread_id);
      const id = message && message.content_type === 'sticker' && !message.is_deleted ? stickerId(message.body) : null;
      if (!thread || !id) { send(res, 404, { error: 'Không tìm thấy sticker' }); return; }
      const ctx = pool.getContext(thread.account_id);
      if (!ctx) { send(res, 409, { error: 'Nick chưa kết nối' }); return; }
      send(res, 200, await resolveSticker(ctx, id));
      return;
    }
    if (parts[0] === 'threads' && parts[2] === 'profiles' && method === 'GET') {
      const thread = getZaloThread(Number(parts[1]));
      if (!thread) { send(res, 404, { error: 'Không tìm thấy hội thoại' }); return; }
      const ctx = pool.getContext(thread.account_id);
      if (!ctx) { send(res, 409, { error: 'Nick chưa kết nối' }); return; }
      send(res, 200, await threadProfiles(ctx, thread.id));
      return;
    }
    if (parts[0] === 'accounts' && parts[1]) {
      const accountId = parts[1];
      if (!getZaloAccount(accountId)) { send(res, 404, { error: 'unknown account' }); return; }
      const action = parts[2] ?? '';
      if (method === 'GET' && action === 'state') { send(res, 200, accountState(accountId)); return; }
      if (method === 'POST') {
        await readBody(req);
        switch (action) {
          case 'login-qr':
            pool.startQrLogin(accountId);
            send(res, 200, { ok: true });
            return;
          case 'cancel-qr':
            pool.cancelQrLogin(accountId);
            send(res, 200, { ok: true });
            return;
          case 'reconnect':
            await pool.resume(accountId);
            send(res, 200, { ok: true, ...accountState(accountId) });
            return;
          case 'disconnect':
            pool.disconnect(accountId, { manual: true });
            send(res, 200, { ok: true });
            return;
          case 'forget':
            pool.disconnect(accountId, { manual: true, forgetSession: true });
            send(res, 200, { ok: true });
            return;
          case 'sync-history': {
            const ctx = pool.getContext(accountId);
            if (!ctx) { send(res, 409, { error: 'Nick chưa kết nối' }); return; }
            if (!backfilling.has(accountId)) {
              backfilling.add(accountId);
              void backfillAccount(ctx).finally(() => backfilling.delete(accountId));
            }
            send(res, 200, { ok: true, started: true });
            return;
          }
          case 'sync-groups': {
            const ctx = pool.getContext(accountId);
            if (!ctx) { send(res, 409, { error: 'Nick chưa kết nối' }); return; }
            const ids = await syncGroupList(ctx);
            send(res, 200, { ok: true, groups: ids.length });
            return;
          }
        }
      }
    }
    send(res, 404, { error: 'not found' });
  })().catch((err) => {
    logger.error({ err: String(err) }, 'zalo control request failed');
    if (!res.headersSent) send(res, 500, { error: String((err as Error)?.message ?? err) });
  });
});

server.on('error', (err) => {
  logger.fatal({ err: String(err), port: CONTROL_PORT }, 'zalo control server failed to bind — exiting');
  process.exit(1);
});
server.listen(CONTROL_PORT, '127.0.0.1', () => {
  logger.info({ port: CONTROL_PORT, pid: process.pid }, 'zalo daemon control server listening');
});

// ── Shutdown ────────────────────────────────────────────────────────
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('zalo daemon shutting down');
  clearInterval(outboxTimer);
  setMarketing(false);
  groupSync.stopAll();
  pool.stopAll();
  server.close();
  try {
    if (fs.readFileSync(ZALO_PID_FILE, 'utf-8').trim() === String(process.pid)) fs.unlinkSync(ZALO_PID_FILE);
  } catch { /* already gone */ }
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

void pool.startAll().catch((err) => logger.error({ err: String(err) }, 'zalo startAll failed'));
logger.info('zalo daemon started');
