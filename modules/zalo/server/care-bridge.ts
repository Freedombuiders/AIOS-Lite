/**
 * Care bridge: the care-facing control routes of the Zalo daemon. The daemon owns the zca-js sessions; the AIOS
 * process (care module, through the Zalo connector) reaches them over the token-authenticated loopback channel (control.ts). These
 * routes are the MINIMAL surface Care needs, all under `/care/accounts/:zaloAccountId/...`:
 *
 *   GET  status            connected / own uid / honest features / send budget status
 *   POST send              ONE text message for a Care delivery attempt
 *   GET  send-status       what this daemon remembers about a request id (hard evidence for reconcile)
 *   GET  feed              live slice (peek, never consumes)       POST feed/ack   acknowledge up to a seq
 *   POST history/direct    ask Zalo to push older 1-1 messages      POST history/group   recent group messages
 *   POST title             best-effort display name (budgeted)
 *
 * Rules (each has a test):
 *  - every route needs the control token, and only works while the care module is linked (`bridged`);
 *  - `send` additionally needs the nick to exist and not be send-locked / chat-off; otherwise nothing is sent. It goes straight to `api.sendMessage` through
 *    the shared ZaloLimiter and the nick's send lock: it NEVER writes zalo_messages / zalo_outbox / zalo_threads;
 *  - the daemon keeps a once-only ledger per request id: a repeat of an accepted request returns the same ack,
 *    a repeat of an unresolved one is refused (never a second send).
 */

import crypto from 'crypto';

import type { CareActorType } from '../../_lib/care-kit/index.js';
import { addZaloUsage, getZaloAccount, getZaloUsage } from './store.js';
import {
  ZaloTransportError,
  type ZaloLivePage,
  type ZaloQuoteTarget,
  type ZaloSeenTarget,
  type ZaloThreadKind,
  type ZaloTransport,
} from './connectors/zalo/transport.js';
import { legacySendState, ZcaZaloTransport, type ZcaPoolLike } from './connectors/zalo/zca-transport.js';
import { getZaloProtectionSettings, localDay, startOfLocalDayMs } from './limits.js';
import type { ZaloSessionPool } from './session.js';

export interface CareControlRequest {
  method: string;
  /** Path segments, e.g. ['care','accounts','<id>','send']. */
  parts: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
  /** Value of the control-token header. */
  token: string | undefined;
}

export interface CareControlResponse {
  status: number;
  data: unknown;
}

export interface CareSendGateResult {
  allow: boolean;
  code: string;
}

export interface CareControlDeps {
  transport: ZaloTransport & { startListening?(accountId: string): void };
  token: string;
  /** Ownership + epoch + switches for a CORE send. Must fail closed. */
  sendGate: (zaloAccountId: string, epoch: number | null, actor: CareActorType) => CareSendGateResult;
  /** Is the Zalo account bridged to a Care account at all? */
  bridged: (zaloAccountId: string) => boolean;
  /** Called once per accepted send (durable daily counting). */
  onAccepted?: (zaloAccountId: string, nowMs: number) => void;
  now?: () => number;
}

interface LedgerEntry {
  state: 'started' | 'accepted' | 'failed_definite' | 'uncertain';
  hash: string;
  msgId?: string;
  tsMs?: number;
}

const LEDGER_MAX = 5000;
const MAX_TEXT = 2000;
const ACTORS: readonly string[] = ['manual', 'approved', 'auto'];

function tokenOk(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(typeof given === 'string' ? given : '');
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const str = (v: unknown, max = 512): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

const DIGITS = /^\d{1,40}$/;

/** Validates the quoted-message wire data of a send request; null = absent or malformed (the send is then refused). */
function parseQuote(v: unknown): ZaloQuoteTarget | null {
  if (!v || typeof v !== 'object') return null;
  const q = v as Record<string, unknown>;
  if (!str(q.msgId, 40) || !DIGITS.test(q.msgId as string) || !str(q.cliMsgId, 40) || !DIGITS.test(q.cliMsgId as string)) return null;
  if (!str(q.uidFrom, 64) || !str(q.ts, 20) || !str(q.msgType, 64) || typeof q.content !== 'string' || q.content.length > MAX_TEXT) return null;
  if (typeof q.ttl !== 'number' || !Number.isSafeInteger(q.ttl) || q.ttl < 0) return null;
  if (q.propertyExt !== undefined && JSON.stringify(q.propertyExt).length > 2000) return null;
  return {
    msgId: q.msgId as string,
    cliMsgId: q.cliMsgId as string,
    uidFrom: q.uidFrom as string,
    ts: q.ts as string,
    ttl: q.ttl,
    msgType: q.msgType as string,
    content: q.content,
    ...(q.propertyExt !== undefined ? { propertyExt: q.propertyExt } : {}),
  };
}

function parseSeen(v: unknown): ZaloSeenTarget | null {
  if (!v || typeof v !== 'object') return null;
  const q = v as Record<string, unknown>;
  const n = (x: unknown): number | null => (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : null);
  if (q.threadKind !== 'user' && q.threadKind !== 'group') return null;
  if (!str(q.msgId, 40) || !DIGITS.test(q.msgId as string) || !str(q.cliMsgId, 40) || !DIGITS.test(q.cliMsgId as string)) return null;
  if (!str(q.uidFrom, 64) || !str(q.idTo, 64) || !str(q.msgType, 64) || !str(q.ts, 20)) return null;
  const st = n(q.st);
  const at = n(q.at);
  const cmd = n(q.cmd);
  if (st === null || at === null || cmd === null) return null;
  return { threadKind: q.threadKind, msgId: q.msgId as string, cliMsgId: q.cliMsgId as string, uidFrom: q.uidFrom as string, idTo: q.idTo as string, msgType: q.msgType as string, st, at, cmd, ts: q.ts as string };
}

function failure(e: unknown): { ok: false; kind: string; message: string; retryAfterMs?: number } {
  if (e instanceof ZaloTransportError) {
    return { ok: false, kind: e.kind, message: e.message.slice(0, 300), ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}) };
  }
  return { ok: false, kind: 'unknown', message: String((e as Error)?.message ?? e).slice(0, 300) };
}

export interface CareControl {
  /** Returns null when the request is not a Care route (the daemon continues with its own routing). */
  handle(req: CareControlRequest): Promise<CareControlResponse | null>;
  /** Call when a nick comes up: starts buffering its websocket for Care if the account is bridged. */
  onConnected(zaloAccountId: string): void;
  /** Call when the care link switches on: starts buffering every nick that is already up. */
  onLinked(zaloAccountIds: string[]): void;
}

export function createCareControl(deps: CareControlDeps): CareControl {
  const ledger = new Map<string, LedgerEntry>();
  const remember = (key: string, e: LedgerEntry) => {
    ledger.set(key, e);
    if (ledger.size > LEDGER_MAX) ledger.delete(ledger.keys().next().value as string);
  };

  async function send(zid: string, body: Record<string, unknown>): Promise<CareControlResponse> {
    const threadId = str(body.threadId);
    const requestId = str(body.requestId, 256);
    const text = typeof body.text === 'string' ? body.text : '';
    const kind = body.threadKind;
    const epoch = typeof body.ownerEpoch === 'number' && Number.isSafeInteger(body.ownerEpoch) ? body.ownerEpoch : null;
    const actor = typeof body.actor === 'string' && ACTORS.includes(body.actor) ? (body.actor as CareActorType) : 'manual';
    if (!threadId || !requestId || (kind !== 'user' && kind !== 'group') || text.trim() === '' || text.length > MAX_TEXT) {
      return { status: 400, data: { ok: false, kind: 'rejected', message: 'invalid send request' } };
    }

    // Ownership first: nothing below runs for an account Care does not own.
    const gate = deps.sendGate(zid, epoch, actor);
    if (!gate.allow) {
      const fenced = gate.code === 'STALE_EPOCH' || gate.code === 'EPOCH_REQUIRED';
      return { status: 409, data: { ok: false, kind: fenced ? 'fenced' : 'send_locked', code: gate.code, message: `Care does not allow this send (${gate.code})` } };
    }

    // A quoted reply travels with the quoted message's wire data; a malformed one is refused, never sent unquoted.
    let quote: ZaloQuoteTarget | undefined;
    if (body.quote !== undefined && body.quote !== null) {
      const parsed = parseQuote(body.quote);
      if (!parsed) return { status: 400, data: { ok: false, kind: 'rejected', message: 'invalid quote data' } };
      quote = parsed;
    }

    const key = `${zid}|${requestId}`;
    const hash = crypto.createHash('sha256').update(JSON.stringify(quote ? [threadId, kind, text, quote.msgId] : [threadId, kind, text])).digest('hex');
    const known = ledger.get(key);
    if (known) {
      if (known.hash !== hash) return { status: 409, data: { ok: false, kind: 'rejected', message: 'requestId was used with a different payload' } };
      if (known.state === 'accepted') return { status: 200, data: { ok: true, msgId: known.msgId, tsMs: known.tsMs, repeated: true } };
      if (known.state === 'started' || known.state === 'uncertain') {
        return { status: 200, data: { ok: false, kind: 'unresolved', message: 'An earlier attempt of this request is unresolved; not sending again' } };
      }
      // failed_definite: the earlier attempt provably did not leave.
    }

    const entry: LedgerEntry = { state: 'started', hash };
    remember(key, entry); // persisted-before-RPC equivalent for the daemon's lifetime
    try {
      const ack = await deps.transport.send(zid, { threadId, threadKind: kind as ZaloThreadKind, text, requestId, ...(quote ? { quote } : {}) });
      if (!ack.msgId) {
        entry.state = 'uncertain';
        deps.onAccepted?.(zid, (deps.now ?? Date.now)());
        return { status: 200, data: { ok: true, tsMs: ack.tsMs } };
      }
      entry.state = 'accepted';
      entry.msgId = ack.msgId;
      entry.tsMs = ack.tsMs ?? (deps.now ?? Date.now)();
      deps.onAccepted?.(zid, entry.tsMs);
      return { status: 200, data: { ok: true, msgId: ack.msgId, tsMs: entry.tsMs } };
    } catch (e) {
      const f = failure(e);
      const definite = ['not_connected', 'session_expired', 'send_locked', 'fenced', 'rate_limited', 'rejected'].includes(f.kind);
      entry.state = definite ? 'failed_definite' : 'uncertain';
      return { status: 200, data: f };
    }
  }

  return {
    onConnected(zid) {
      try {
        if (deps.bridged(zid)) deps.transport.startListening?.(zid);
      } catch {
        /* a Care problem must never disturb the legacy session */
      }
    },

    onLinked(ids) {
      for (const zid of ids) this.onConnected(zid);
    },

    async handle(req) {
      if (req.parts[0] !== 'care') return null;
      if (!tokenOk(req.token, deps.token)) return { status: 401, data: { error: 'unauthorized' } };
      if (req.parts[1] !== 'accounts' || !req.parts[2] || !req.parts[3]) return { status: 404, data: { error: 'not found' } };
      const zid = req.parts[2];
      if (!deps.bridged(zid)) return { status: 404, data: { error: 'care is not linked' } };
      const route = req.parts.slice(3).join('/');
      const t = deps.transport;
      const b = req.body;

      try {
        if (req.method === 'GET' && route === 'status') {
          return {
            status: 200,
            data: {
              connected: await t.isConnected(zid),
              ownUid: await t.ownUid(zid),
              features: await t.features(zid),
              rate: await t.rateStatus(zid),
            },
          };
        }
        if (req.method === 'POST' && route === 'send') return await send(zid, b);
        if (req.method === 'GET' && route === 'send-status') {
          const requestId = req.query.get('requestId');
          const e = requestId ? ledger.get(`${zid}|${requestId}`) : undefined;
          return { status: 200, data: e ? { state: e.state, msgId: e.msgId, tsMs: e.tsMs } : { state: null } };
        }
        if (req.method === 'GET' && route === 'feed') {
          const limit = Math.max(1, Math.min(Number(req.query.get('limit') ?? 50) || 50, 500));
          const after = Math.max(0, Number(req.query.get('after') ?? 0) || 0);
          const page: ZaloLivePage = await t.peekLive(zid, 500);
          const fresh = page.items.filter((i) => i.seq > after);
          return { status: 200, data: { ...page, items: fresh.slice(0, limit), hasMore: page.hasMore || fresh.length > limit } };
        }
        if (req.method === 'POST' && route === 'feed/ack') {
          const feedId = str(b.feedId, 128);
          const upTo = typeof b.upToSeq === 'number' && Number.isSafeInteger(b.upToSeq) && b.upToSeq >= 0 ? b.upToSeq : null;
          if (!feedId || upTo === null) return { status: 400, data: { error: 'feedId and upToSeq required' } };
          await t.ackLive(zid, feedId, upTo);
          return { status: 200, data: { ok: true } };
        }
        if (req.method === 'POST' && route === 'history/direct') {
          await t.requestDirectHistory(zid, typeof b.cursor === 'string' && b.cursor.trim() ? b.cursor : null);
          return { status: 200, data: { ok: true } };
        }
        if (req.method === 'POST' && route === 'history/group') {
          const groupId = str(b.groupId);
          if (!groupId) return { status: 400, data: { error: 'groupId required' } };
          const count = Math.max(1, Math.min(Number(b.count) || 50, 200));
          return { status: 200, data: { ok: true, messages: await t.readGroupHistory(zid, groupId, count) } };
        }
        if (req.method === 'POST' && route === 'seen') {
          // Not a message: a read signal. Still only for an account Care owns (the bridged check above), and only with full wire data.
          const target = parseSeen(b.seen);
          const threadId = str(b.threadId);
          const nativeMessageId = str(b.nativeMessageId, 64);
          if (!target || !threadId || !nativeMessageId) return { status: 400, data: { ok: false, kind: 'rejected', message: 'invalid seen request' } };
          await t.markRead(zid, threadId, nativeMessageId, target);
          return { status: 200, data: { ok: true } };
        }
        if (req.method === 'POST' && route === 'title') {
          const threadId = str(b.threadId);
          if (!threadId || (b.kind !== 'user' && b.kind !== 'group')) return { status: 400, data: { error: 'threadId and kind required' } };
          return { status: 200, data: { title: await t.resolveTitle(zid, threadId, b.kind) } };
        }
      } catch (e) {
        return { status: 200, data: failure(e) };
      }
      return { status: 404, data: { error: 'not found' } };
    },
  };
}

// ── Real wiring (used by daemon.ts only) ─────────────────────────────────────────────────────

/** Link state pushed by the AIOS process: is the care module enabled and registered? Care routes answer 404 while it is not. */
export const careLink = { linked: false };

/** Send gate for a care send arriving over the control channel. Fails closed; the limiter and the nick lock apply on top. */
export function defaultCareSendGate(zaloAccountId: string, _epoch: number | null, _actor: CareActorType): CareSendGateResult {
  try {
    const acc = getZaloAccount(zaloAccountId);
    if (!acc) return { allow: false, code: 'UNKNOWN_ACCOUNT' };
    if (acc.send_lock_reason) return { allow: false, code: 'SEND_LOCKED' };
    if (!acc.chat_enabled) return { allow: false, code: 'CHAT_DISABLED' };
    return { allow: true, code: 'OK' };
  } catch {
    return { allow: false, code: 'GATE_ERROR' };
  }
}

const CARE_USAGE_CATEGORY = 'care_message' as never;

/** Durable count of the sends care made today for this nick (care sends write no zalo_messages row): feeds the daily cap. */
export function careSentToday(zaloAccountId: string, nowMs: number): number {
  try {
    const day = localDay(new Date(nowMs), getZaloProtectionSettings().timezone);
    return (getZaloUsage(zaloAccountId, day) as Record<string, number>)[CARE_USAGE_CATEGORY as string] ?? 0;
  } catch {
    return 0;
  }
}

export function noteCareSend(zaloAccountId: string, nowMs: number): void {
  try {
    addZaloUsage(zaloAccountId, localDay(new Date(nowMs), getZaloProtectionSettings().timezone), CARE_USAGE_CATEGORY, 1);
  } catch {
    /* counting must never break a send */
  }
}

export interface CareBridgeOptions {
  quoteReplies?: boolean;
  seenMarker?: boolean;
}

export function buildCareControl(pool: ZaloSessionPool, token: string, opts: CareBridgeOptions = {}): CareControl {
  const transport = new ZcaZaloTransport({
    pool: pool as unknown as ZcaPoolLike,
    limiter: pool.limiter as never,
    sendState: legacySendState,
    coreSentToday: careSentToday,
    // Quoted replies and the seen marker stay OFF unless the owner enables them in module settings (not verified natively).
    quoteReplies: opts.quoteReplies === true,
    seenMarker: opts.seenMarker === true,
  });
  return createCareControl({
    transport,
    token,
    sendGate: defaultCareSendGate,
    bridged: () => careLink.linked,
    onAccepted: noteCareSend,
  });
}
