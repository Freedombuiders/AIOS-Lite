/**
 * Composition root of the Care runtime (CC-12). Nothing here starts by itself: importing this module or calling
 * `createCareRuntime` creates objects only; `startCareRuntime` is the one explicit entry that begins scheduling
 * and the supervised worker loop, and no boot code calls it.
 *
 *   inbound_turn    -> CareAgentTurn.run (runner = injected AgentRunner, drafts through createCareDraftSink)
 *   outbox_dispatch -> CareOutboxDispatcher (guard = ONE dispatch gate + policy eligibility, see care-guard.ts)
 *   sync_poll       -> connector.sync -> ingest pipeline (epoch-stamped) -> checkpoint
 *   cleanup         -> epoch-superseded jobs and old housekeeping rows
 *
 * Also wires the switch/backlog composition (re-enable parks care_jobs AND outbox intents).
 */
import type Database from 'better-sqlite3';
import type { AgentRunner } from '../application/agent-ports.js';
import { CareAgentTurn, type AgentTurnConfig } from '../application/agent-turn.js';
import { CareOutboxDispatcher, type DispatcherOptions } from '../application/dispatch.js';
import { CareIngestPipeline } from '../application/ingest.js';
import { CareError } from '../../../_lib/care-kit/errors.js';
import type { CareKeyInput } from '../persistence/crypto.js';
import { resolveEncryptionKey } from '../persistence/crypto.js';
import { getCareHealth, type CareHealth, type CareHealthOptions, type HealthLevel } from '../ops/health.js';
import { runRetentionLoop, type CareRetentionPolicy, type RetentionResult } from '../ops/retention.js';
import { CareOutboxService, createCareDraftSink, createCareReplyPort } from '../application/outbox-service.js';
import type { CareStores } from '../persistence/index.js';
import { readRuntimeSwitches } from '../persistence/ownership-store.js';
import type { KillSwitchState } from '../policy/eligibility.js';
import { careJobsBacklogSource, type BacklogSource } from './backlog.js';
import { systemClock, type RuntimeClock } from './clock.js';
import { createCareDispatchGuard, OUTBOX_BACKLOG_KIND } from './care-guard.js';
import { evaluateDispatchGate } from './gates.js';
import { createCareHandlers, type ConnectorRegistry, type HandlerDeps } from './handlers.js';
import { setRuntimeSwitch, type SetRuntimeSwitchOptions, type SetRuntimeSwitchResult } from './switches.js';
import { Supervisor } from './supervisor.js';
import { CareWorker, type TickReport, type WorkerConfig, type WorkerEvent } from './worker.js';

type AgentTurnDepsLike = ConstructorParameters<typeof CareAgentTurn>[0];

export interface CareRuntimeDeps {
  db: Database.Database;
  stores: CareStores;
  connectors: ConnectorRegistry;
  runner: AgentRunner;
  /** Extra policy layer (e.g. per-account overrides). Combined with the persisted switches; the stricter side wins. */
  killSwitches?: () => KillSwitchState;
  /** Module scope check (reply.draft / reply.send) handed to the agent turn. */
  onTurnOutcome?: HandlerDeps['onTurnOutcome'];
  agentCan?: AgentTurnDepsLike['agentCan'];
  skillFor?: AgentTurnDepsLike['skillFor'];
  conversationControl?: AgentTurnDepsLike['conversationControl'];
  autoDelaySeconds?: AgentTurnDepsLike['autoDelaySeconds'];
  quietHours?: AgentTurnDepsLike['quietHours'];
  signatureFor?: AgentTurnDepsLike['signatureFor'];
  /**
   * The Care encryption key. REQUIRED for the retention loop: without a usable key, redaction of erased content cannot
   * rewrite bridge artifacts (it would only count them as unredacted), so the runtime refuses to start the loop and
   * reports it in health.
   */
  key?: CareKeyInput;
  retention?: { intervalMs?: number; policy?: () => CareRetentionPolicy; batch?: number };
  workerId: string;
  clock?: RuntimeClock;
  worker?: Partial<Omit<WorkerConfig, 'workerId'>>;
  agentTurn?: Partial<AgentTurnConfig>;
  dispatcher?: Partial<Omit<DispatcherOptions, 'stores' | 'guard' | 'resolveConnector' | 'workerId'>>;
  schedule?: { outboxPollMs?: number; syncPollMs?: number; cleanupMs?: number };
  handlers?: { syncMaxPages?: number; syncPageLimit?: number; dispatchPerJob?: number };
  onEvent?: (e: WorkerEvent) => void;
}

export interface ScheduleReport {
  outbox: number;
  sync: number;
  cleanup: number;
}

export type RetentionState = 'not_started' | 'running' | 'stopped' | 'refused_no_key';

export interface RetentionHealth {
  state: RetentionState;
  /** Why the loop is not running, when that is a problem (e.g. `missing_or_unusable_key`). */
  reason: string | null;
  lastRunAtMs: number | null;
  lastResult: Pick<RetentionResult, 'redaction' | 'pruned'> | null;
  lastError: string | null;
}

export type CareRuntimeHealth = CareHealth & { retention: RetentionHealth };

export interface CareRuntime {
  readonly worker: CareWorker;
  /** The registry the dispatcher and sync use (channel connectors are registered by the channel modules). */
  readonly connectors: ConnectorRegistry;
  readonly service: CareOutboxService;
  readonly dispatcher: CareOutboxDispatcher;
  readonly turn: CareAgentTurn;
  /** The ingest pipeline wired with the receipt callback (delivery.confirmed -> outbox.recordReceipt). */
  readonly ingest: CareIngestPipeline;
  /** The outbox as a backlog source (parked for review when a runtime switch or an account is re-enabled). */
  readonly backlogSource: BacklogSource;
  /** Port for the API layer (CareReplyPort): replies go through the same durable outbox. */
  readonly replyPort: ReturnType<typeof createCareReplyPort>;
  /** Persisted switches combined with the injected policy layer. */
  killState(): KillSwitchState;
  /** Enqueues due housekeeping/dispatch/sync jobs (deduped per time bucket) for accounts the gate lets work. */
  schedule(nowMs?: number): ScheduleReport;
  /** schedule() then one worker pass. */
  tick(): Promise<TickReport>;
  /** Runtime switch change that also parks the care_jobs AND outbox backlog when a switch comes back on. */
  setSwitch(key: string, enabled: boolean, opts: SetRuntimeSwitchOptions): SetRuntimeSwitchResult;
  /** Startup recovery of this worker's own outbox leases (in-flight attempts become `uncertain`, never pending). */
  recover(): { uncertain: number; released: number };
  /**
   * Starts the scheduled retention/redaction loop. Refuses (state `refused_no_key`, health level `error`) without a
   * usable Care key. Called by startCareRuntime; never automatically.
   */
  startRetention(): Supervisor | null;
  retentionHealth(): RetentionHealth;
  /** Care health for the API: ops health plus the runtime's retention state. */
  getCareHealth(opts?: CareHealthOptions): CareRuntimeHealth;
  /** Explicit start; see startCareRuntime. */
  start(): Supervisor;
  /** Graceful stop: drain the worker, release locks, stop the loop. */
  stop(timeoutMs?: number): Promise<{ drained: boolean; abandonedAccounts: string[] }>;
}

/** Pending / retrying outbox intents older than the re-enable moment are parked for review, like jobs. */
export function careOutboxBacklogSource(db: Database.Database): BacklogSource {
  return {
    kind: OUTBOX_BACKLOG_KIND,
    listPendingBefore({ cutoffMs, accountIds }) {
      if (accountIds !== null && accountIds.length === 0) return [];
      const scope = accountIds === null ? '' : ` AND account_id IN (${accountIds.map(() => '?').join(',')})`;
      const rows = db
        .prepare(
          `SELECT id, account_id FROM care_delivery_intents
           WHERE status IN ('pending','retry_wait') AND created_at <= ?${scope} ORDER BY created_at ASC, id ASC`,
        )
        .all(cutoffMs, ...(accountIds ?? [])) as Array<{ id: string; account_id: string }>;
      return rows.map((r) => ({ kind: OUTBOX_BACKLOG_KIND, id: r.id, accountId: r.account_id }));
    },
  };
}

/** Persisted runtime switches as policy layers (everything default ON: Adding the module is the opt-in). */
export function killStateFromSwitches(db: Database.Database): KillSwitchState {
  const sw = readRuntimeSwitches(db);
  const on = (key: string, dflt: boolean) => sw.get(key)?.enabled ?? dflt;
  return {
    moduleEnabled: on('module', true),
    aiEnabled: on('ai', true),
    autoSendEnabled: on('auto_send', true),
    channels: {
      zalo: { moduleEnabled: on('channel:zalo', true) },
      email: { moduleEnabled: on('channel:email', true) },
      telegram: { moduleEnabled: on('channel:telegram', true) },
    },
  };
}

export function mergeKillStates(a: KillSwitchState, b: KillSwitchState | undefined): KillSwitchState {
  if (!b) return a;
  const both = (x: boolean, y: boolean) => x && y;
  const layer = (x?: { moduleEnabled?: boolean; aiEnabled?: boolean; autoSendEnabled?: boolean }, y?: typeof x) => ({
    ...(x?.moduleEnabled === false || y?.moduleEnabled === false ? { moduleEnabled: false } : {}),
    ...(x?.aiEnabled === false || y?.aiEnabled === false ? { aiEnabled: false } : {}),
    ...(x?.autoSendEnabled === false || y?.autoSendEnabled === false ? { autoSendEnabled: false } : {}),
  });
  const channels: NonNullable<KillSwitchState['channels']> = {};
  for (const ch of ['zalo', 'email', 'telegram'] as const) {
    const l = layer(a.channels?.[ch], b.channels?.[ch]);
    if (Object.keys(l).length) channels[ch] = l;
  }
  return {
    moduleEnabled: both(a.moduleEnabled, b.moduleEnabled),
    aiEnabled: both(a.aiEnabled, b.aiEnabled),
    autoSendEnabled: both(a.autoSendEnabled, b.autoSendEnabled),
    channels,
    ...(b.accounts ? { accounts: b.accounts } : {}),
  };
}

export function createCareRuntime(deps: CareRuntimeDeps): CareRuntime {
  const { db, stores } = deps;
  const clock = deps.clock ?? systemClock;
  const now = () => clock.now();
  const killState = (): KillSwitchState => mergeKillStates(killStateFromSwitches(db), deps.killSwitches?.());

  // fail closed: the Care owner epoch is the only authority; an unknown account has no epoch
  const ownerEpochOf = (accountId: string): number => {
    const row = db.prepare('SELECT owner_epoch FROM care_accounts WHERE id = ?').get(accountId) as { owner_epoch: number } | undefined;
    if (!row) throw new CareError('INVALID_TARGET', 'Unknown Care account', 404);
    return Number(row.owner_epoch);
  };
  const connectors: ConnectorRegistry = deps.connectors;

  let worker!: CareWorker;
  const service = new CareOutboxService(db, stores, { now });
  const guard = createCareDispatchGuard({
    db,
    stores,
    killSwitches: killState,
    lockFor: (accountId) => worker?.heldLocks().find((l) => l.accountId === accountId),
  });
  const dispatcher = new CareOutboxDispatcher({
    stores,
    guard,
    resolveConnector: (account) => connectors.forAccount(account),
    workerId: `${deps.workerId}:outbox`,
    now,
    ...deps.dispatcher,
  });
  const draftSink = createCareDraftSink(service, stores, { now });
  const turn = new CareAgentTurn({
    db,
    stores,
    runner: deps.runner,
    draftSink,
    killSwitches: killState,
    now,
    config: deps.agentTurn,
    ...(deps.agentCan ? { agentCan: deps.agentCan } : {}),
    ...(deps.skillFor ? { skillFor: deps.skillFor } : {}),
    ...(deps.conversationControl ? { conversationControl: deps.conversationControl } : {}),
    ...(deps.autoDelaySeconds ? { autoDelaySeconds: deps.autoDelaySeconds } : {}),
    ...(deps.quietHours ? { quietHours: deps.quietHours } : {}),
    ...(deps.signatureFor ? { signatureFor: deps.signatureFor } : {}),
  });
  // provider receipts (delivery.confirmed) reach the outbox after the ingest commit; the handler is idempotent
  const ingest = new CareIngestPipeline(db, stores, { onDeliveryConfirmed: (r) => void service.recordReceipt(r) });
  const replyPort = createCareReplyPort({
    service,
    stores,
    reconcile: async (intentId) => (await dispatcher.reconcile(intentId)).intent,
  });

  const handlers = createCareHandlers({ db, stores, turn, dispatcher, ingest, connectors, now, ...(deps.onTurnOutcome ? { onTurnOutcome: deps.onTurnOutcome } : {}), ...deps.handlers });
  worker = new CareWorker({ db, stores, handlers, clock, onEvent: deps.onEvent, config: { workerId: deps.workerId, ...deps.worker } });

  // ── retention loop ────────────────────────────────────────────────────────────────────────
  const keyUsable = (() => {
    if (deps.key === undefined) return false;
    try {
      resolveEncryptionKey(deps.key); // strict: exactly 32 bytes, never the unavailable marker
      return true;
    } catch {
      return false;
    }
  })();
  const retentionState: RetentionHealth = { state: 'not_started', reason: null, lastRunAtMs: null, lastResult: null, lastError: null };
  let retentionLoop: Supervisor | null = null;

  const outboxPollMs = deps.schedule?.outboxPollMs ?? 2_000;
  const syncPollMs = deps.schedule?.syncPollMs ?? 60_000;
  const cleanupMs = deps.schedule?.cleanupMs ?? 3_600_000;

  const runtime: CareRuntime = {
    worker,
    connectors,
    service,
    dispatcher,
    turn,
    ingest,
    backlogSource: careOutboxBacklogSource(db),
    replyPort,
    killState,
    schedule(nowMs = now()) {
      const report: ScheduleReport = { outbox: 0, sync: 0, cleanup: 0 };
      const accounts = db
        .prepare(`SELECT id, owner_epoch, sync_enabled, send_enabled FROM care_accounts WHERE write_owner = 'core' AND desired_state = 'active'`)
        .all() as Array<{ id: string; owner_epoch: number; sync_enabled: number; send_enabled: number }>;
      for (const a of accounts) {
        const epoch = Number(a.owner_epoch);
        const account = stores.accounts.getAccount(a.id);
        // never queue work the gate would refuse right now (module off, path off, ...): nothing piles up behind a switch
        if (!evaluateDispatchGate(db, a.id, epoch, 'core', 'schedule', { operation: 'work', nowMs }).allow) continue;
        const enqueue = (jobType: 'outbox_dispatch' | 'sync_poll' | 'cleanup', key: string) =>
          stores.jobs.enqueueJob({ accountId: a.id, jobType, dedupeKey: key, payload: {}, ownerEpoch: epoch, dueAtMs: nowMs });
        if (a.send_enabled === 1) {
          const open = db
            .prepare(`SELECT 1 FROM care_delivery_intents WHERE account_id = ? AND status IN ('pending','retry_wait','sending','uncertain') LIMIT 1`)
            .get(a.id);
          if (open) {
            enqueue('outbox_dispatch', `outbox:${Math.floor(nowMs / outboxPollMs)}`);
            report.outbox += 1;
          }
        }
        // Only connectors that ask for it are polled by the worker; push channels ingest through careChannels.ingest.
        if (a.sync_enabled === 1 && account && connectors.forAccount(account)?.careManagedSync === true) {
          enqueue('sync_poll', `sync:${Math.floor(nowMs / syncPollMs)}`);
          report.sync += 1;
        }
        enqueue('cleanup', `cleanup:${Math.floor(nowMs / cleanupMs)}`);
        report.cleanup += 1;
      }
      return report;
    },
    async tick() {
      runtime.schedule();
      return worker.runOnce();
    },
    setSwitch(key, enabled, opts) {
      return setRuntimeSwitch(db, key, enabled, { ...opts, extraSources: [careOutboxBacklogSource(db), ...(opts.extraSources ?? [])] });
    },
    recover() {
      return dispatcher.recover();
    },
    startRetention() {
      if (retentionLoop) return retentionLoop;
      if (!keyUsable) {
        retentionState.state = 'refused_no_key';
        retentionState.reason = 'missing_or_unusable_key';
        return null;
      }
      retentionState.state = 'running';
      retentionState.reason = null;
      retentionLoop = new Supervisor({
        name: 'care-retention',
        clock,
        run: (signal) =>
          runRetentionLoop(
            {
              db,
              clock,
              key: deps.key,
              ...(deps.retention?.intervalMs !== undefined ? { intervalMs: deps.retention.intervalMs } : {}),
              ...(deps.retention?.policy ? { policy: deps.retention.policy } : {}),
              ...(deps.retention?.batch !== undefined ? { batch: deps.retention.batch } : {}),
              onResult: (r) => {
                retentionState.lastRunAtMs = r.atMs;
                retentionState.lastResult = { redaction: r.redaction, pruned: r.pruned };
                retentionState.lastError = null;
              },
              onError: (info) => {
                retentionState.lastError = (typeof info.error === 'string' ? info.error : JSON.stringify(info.error ?? 'error')).slice(0, 300);
              },
            },
            signal,
          ),
      });
      retentionLoop.start();
      return retentionLoop;
    },
    retentionHealth: () => ({ ...retentionState }),
    getCareHealth(opts = {}) {
      const base = getCareHealth(db, stores, { nowMs: now(), ...opts });
      const retention = { ...retentionState };
      let level: HealthLevel = base.level;
      // erased content that cannot be redacted is a privacy failure, not a warning
      if (retention.state === 'refused_no_key') level = 'error';
      else if ((retention.lastError || (retention.lastResult?.redaction.artifactsUnredacted ?? 0) > 0) && level === 'ok') level = 'warn';
      return { ...base, level, retention };
    },
    start: () => startCareRuntime(runtime, { clock, idleSleepMs: deps.worker?.idleSleepMs }),
    async stop(timeoutMs) {
      const report = await worker.drain(timeoutMs);
      // every connector this runtime built is closed; one failing must not keep the others (or the shutdown) from finishing
      await retentionLoop?.stop();
      if (retentionLoop) retentionState.state = 'stopped';
      retentionLoop = null;
      await loops.get(runtime)?.stop();
      loops.delete(runtime);
      return report;
    },
  };
  return runtime;
}

const loops = new WeakMap<CareRuntime, Supervisor>();

/**
 * The only function that begins scheduling and worker activity. Call it explicitly (never from boot code):
 * recovers this worker's own in-flight outbox leases as `uncertain`, then runs schedule + worker passes under
 * supervision (backoff on crash, bounded crash loop, fatal errors stop it).
 */
export function startCareRuntime(runtime: CareRuntime, opts: { clock?: RuntimeClock; idleSleepMs?: number } = {}): Supervisor {
  const existing = loops.get(runtime);
  if (existing) return existing;
  const clock = opts.clock ?? systemClock;
  const idle = opts.idleSleepMs ?? 1_000;
  runtime.recover();
  runtime.startRetention();
  let swept = false;
  const supervisor = new Supervisor({
    name: 'care-runtime',
    clock,
    run: async (signal) => {
      if (!swept) {
        swept = true;
        // restart sweep: uncertain intents are resolved by evidence only; a failure here must not stop the loop
        try {
          await runtime.dispatcher.reconcileAllUncertain();
        } catch {
          /* reconcile is retried by the next explicit reconcile / late receipt */
        }
      }
      while (!signal.aborted && !runtime.worker.draining) {
        const report = await runtime.tick();
        if (report.jobsClaimed === 0) await clock.sleep(idle, signal);
      }
    },
  });
  loops.set(runtime, supervisor);
  supervisor.start();
  return supervisor;
}

export { careJobsBacklogSource };
