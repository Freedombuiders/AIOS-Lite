import fs from 'node:fs';
import path from 'node:path';
import { defineModule, type ModuleContext } from '../../../src/modules/sdk.js';
import type { CareConnector } from '../../_lib/care-kit/index.js';
import { ZaloCareConnector } from './connectors/zalo/zalo-connector.js';
import { createDaemonZaloTransport } from './connectors/zalo/daemon-transport.js';
import { callZaloDaemon, DEFAULT_ZALO_CONTROL_PORT } from './control.js';
import { registerZaloRoutes } from './dashboard-routes.js';
import { setZaloDataDir } from './paths.js';
import { createZaloSupervisor, type ZaloSupervisor } from './supervisor.js';
import { getZaloMessages, getZaloThreadByExternal, listZaloAccounts, type ZaloThreadRow } from './store.js';
import { prepareTurnImages } from './turn-images.js';

/** What the care module exposes (modules/care provides.careChannels). Only what zalo uses. */
export interface CareProvides {
  careChannels: {
    register(connector: CareConnector): void;
    unregister(kind: string): void;
    ensureAccount(input: { id: string; channel: 'zalo'; connectorKind: string; label: string; address?: string }): { id: string; epoch: number };
    getActiveEpoch(accountId: string): number;
  };
}

const LINK_TICK_MS = 5_000;

interface Runtime {
  supervisor: ZaloSupervisor;
  connector: ZaloCareConnector;
  /** Connector currently registered with care (null = not linked). */
  linked: boolean;
  /** zalo account ids already announced to care (ensureAccount is idempotent, this only avoids repeats). */
  ensured: Set<string>;
  /** Last config pushed to the daemon, and the daemon pid it was pushed to. */
  pushed: { pid: number | null; marketingEnabled: boolean; careLinked: boolean } | null;
  noticeSeq: number;
  stopTick?: () => void;
}

const runtimes = new WeakMap<ModuleContext, Runtime>();

function isFileDb(ctx: ModuleContext): boolean {
  return Boolean(ctx.db.name) && ctx.db.name !== ':memory:' && !ctx.db.memory;
}

function runtime(ctx: ModuleContext): Runtime {
  let rt = runtimes.get(ctx);
  if (rt) return rt;
  setZaloDataDir(ctx.dataDir);
  const port = Math.trunc(Number(ctx.settings.get<number>('controlPort', DEFAULT_ZALO_CONTROL_PORT))) || DEFAULT_ZALO_CONTROL_PORT;
  const care = () => ctx.modules.get<CareProvides>('care')?.careChannels;
  const supervisor = createZaloSupervisor({
    rootDir: path.resolve(ctx.dir, '..', '..'),
    dataDir: ctx.dataDir,
    dbPath: ctx.db.name,
    port,
    log: ctx.log,
    env: { ZALO_MARKETING_ENABLED: ctx.settings.get<boolean>('marketingEnabled', true) ? '1' : '0' },
  });
  const connector = new ZaloCareConnector({
    transport: createDaemonZaloTransport(),
    // The daemon does not fence by epoch; follow care's value when it offers one.
    getActiveEpoch: (accountId) => care()?.getActiveEpoch(accountId) ?? 1,
    resolveThreadKind: (accountId, externalKey) => {
      const t = getZaloThreadByExternal(accountId, externalKey);
      return t ? (t.thread_type === 'group' ? 'group' : 'user') : null;
    },
  });
  rt = { supervisor, connector, linked: false, ensured: new Set(), pushed: null, noticeSeq: 0 };
  runtimes.set(ctx, rt);
  return rt;
}

/** Register with care when it is enabled, unregister when it is not. Safe to call repeatedly. */
function syncCareLink(ctx: ModuleContext, rt: Runtime): void {
  const care = ctx.modules.isEnabled('care') ? ctx.modules.get<CareProvides>('care')?.careChannels : undefined;
  if (care && !rt.linked) {
    care.register(rt.connector);
    rt.linked = true;
    ctx.log.info('zalo channel registered with care');
  }
  if (care && rt.linked) {
    for (const a of listZaloAccounts()) {
      if (rt.ensured.has(a.id)) continue;
      care.ensureAccount({ id: a.id, channel: 'zalo', connectorKind: rt.connector.kind, label: a.display_name || a.label || a.id, ...(a.zalo_uid ? { address: a.zalo_uid } : {}) });
      rt.ensured.add(a.id);
    }
  } else if (!care && rt.linked) {
    try {
      ctx.modules.get<CareProvides>('care')?.careChannels.unregister(rt.connector.kind);
    } catch { /* care already gone */ }
    rt.linked = false;
    rt.ensured.clear();
  }
}

async function pushConfig(ctx: ModuleContext, rt: Runtime): Promise<void> {
  const pid = rt.supervisor.pid();
  if (pid === null) return;
  const want = { pid, marketingEnabled: ctx.settings.get<boolean>('marketingEnabled', true), careLinked: rt.linked };
  const last = rt.pushed;
  if (last && last.pid === want.pid && last.marketingEnabled === want.marketingEnabled && last.careLinked === want.careLinked) return;
  const res = await callZaloDaemon('POST', '/config', { body: { marketingEnabled: want.marketingEnabled, careLinked: want.careLinked }, timeoutMs: 3_000 });
  if (res.status === 200) rt.pushed = want;
}

async function pollNotices(ctx: ModuleContext, rt: Runtime): Promise<void> {
  if (rt.supervisor.pid() === null) return;
  const res = await callZaloDaemon<{ notices?: Array<{ seq: number; text: string }> }>('GET', `/notices?after=${rt.noticeSeq}`, { timeoutMs: 3_000 });
  for (const n of res.data.notices ?? []) {
    rt.noticeSeq = Math.max(rt.noticeSeq, n.seq);
    const [title, ...rest] = n.text.split('\n');
    ctx.attention.raise({ key: `zalo:notice:${n.seq}`, title: (title ?? 'Zalo').slice(0, 200), detail: rest.join('\n').trim() || undefined, link: '/m/zalo', severity: 'warn' });
  }
}

export default defineModule({
  routes(app, ctx) {
    const rt = runtime(ctx);
    registerZaloRoutes(app, {
      supervisor: rt.supervisor,
      agentIds: () => ctx.agents.list().map((a) => a.id),
      runLean: (input) => ctx.agents.runLean(input),
    });
  },

  start(ctx) {
    const rt = runtime(ctx);
    fs.mkdirSync(ctx.dataDir, { recursive: true, mode: 0o700 });
    syncCareLink(ctx, rt);
    if (!isFileDb(ctx)) {
      ctx.log.warn('zalo daemon needs a file database; not started');
      return;
    }
    rt.supervisor.start();
    rt.stopTick = ctx.schedule.every('zalo-link', LINK_TICK_MS, async () => {
      syncCareLink(ctx, rt);
      try {
        await pushConfig(ctx, rt);
        await pollNotices(ctx, rt);
      } catch (err) {
        ctx.log.debug({ err: String(err) }, 'zalo daemon not reachable yet');
      }
    });
  },

  async stop(ctx) {
    const rt = runtimes.get(ctx);
    if (!rt) return;
    rt.stopTick?.();
    if (rt.linked) {
      try {
        ctx.modules.get<CareProvides>('care')?.careChannels.unregister(rt.connector.kind);
      } catch { /* care already gone */ }
      rt.linked = false;
    }
    await rt.supervisor.stop();
    rt.pushed = null;
    runtimes.delete(ctx);
  },

  provides: (ctx) => ({
    /** Nicks the module knows (for care's channel/account pickers). */
    accounts() {
      return listZaloAccounts().map((a) => ({
        id: a.id,
        label: a.display_name || a.label,
        zaloUid: a.zalo_uid,
        status: a.status,
        chatEnabled: a.chat_enabled === 1,
        sendLockReason: a.send_lock_reason,
      }));
    },
    /** Download the customer's latest images of a thread for an agent turn; call cleanup() when the turn ends. */
    turnImages(accountId: string, externalKey: string, opts: { signal?: AbortSignal; canReadImages?: boolean } = {}) {
      const thread: ZaloThreadRow | undefined = getZaloThreadByExternal(accountId, externalKey);
      if (!thread) return Promise.resolve({ context: '', cleanup: () => {} });
      return prepareTurnImages(getZaloMessages(thread.id, { limit: 30 }), opts.signal ?? new AbortController().signal, opts.canReadImages ?? true);
    },
    daemon: () => ({ pid: runtimes.get(ctx)?.supervisor.pid() ?? null }),
  }),
});
