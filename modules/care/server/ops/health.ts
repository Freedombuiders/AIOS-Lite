/**
 * Care health snapshot (CC-21): one read-only view of whether each source is alive, how far behind it is and
 * what needs a human. Pure functions over an injected handle/stores and an injected clock; nothing here
 * writes, calls a connector or decrypts anything.
 *
 * What it never contains: message text, titles, labels, native account ids, contact data, cursors,
 * claim/retry tokens, credentials or process addresses (pid/host). Every field is a count, an age in
 * milliseconds, a state enum, a stable code or an opaque ID. Free-form strings that do appear (a lock
 * holder id) pass through the log scrubber.
 */
import type Database from 'better-sqlite3';
import type { CareStores } from '../persistence/index.js';
import { CARE_SCHEMA_VERSION } from '../persistence/schema.js';
import { metaGet, scalar, tableExists } from './db-util.js';
import { scrubCareLogString } from './log-scrub.js';

export type HealthLevel = 'ok' | 'warn' | 'error';

export interface CareHealthOptions {
  nowMs?: number;
  /** Build identifier to report. Default: CLAUDECLAW_BUILD_VERSION / npm_package_version / 'unknown'. */
  buildVersion?: string;
  /** Sync older than this is stale for an account that should be syncing. Default 10 minutes. */
  staleSyncMs?: number;
  /** Due work waiting longer than this raises QUEUE_BACKLOG. Default 5 minutes. */
  queueWarnMs?: number;
  /** Only these accounts are reported and counted (per-source read gate). Default: all. */
  accountFilter?: (accountId: string) => boolean;
}

export type HealthIssue =
  | 'ACCOUNT_ERROR'
  | 'ACCOUNT_DEGRADED'
  | 'SYNC_STALE'
  | 'NO_CHECKPOINT'
  | 'LOCK_NOT_HELD'
  | 'QUEUE_BACKLOG'
  | 'EXPIRED_LEASES'
  | 'OUTBOX_UNCERTAIN'
  | 'OUTBOX_NEEDS_REVIEW'
  | 'COOLDOWN_ACTIVE'
  | 'BACKLOG_HELD'
  | 'BRIDGE_LAG';

export type LockState = 'none' | 'live' | 'expired' | 'released' | 'stale_generation' | 'owner_mismatch';

export interface JobQueueHealth {
  pending: number;
  /** Pending jobs whose due time has passed. */
  due: number;
  claimed: number;
  failed: number;
  expiredLeases: number;
  /** Age of the longest-waiting due pending job; null when nothing is due. */
  oldestDueAgeMs: number | null;
}

export interface AccountHealth {
  id: string;
  channel: string;
  connectorKind: string;
  desiredState: string;
  healthStatus: string;
  flags: { sync: boolean; send: boolean; ai: boolean };
  owner: { writeOwner: string; epoch: number };
  lock: { state: LockState; holderId: string | null; role: string | null; generation: number | null; lockSeq: number | null; heartbeatAgeMs: number | null; expiresInMs: number | null };
  sync: {
    checkpoints: Array<{ namespace: string; revision: number; ageMs: number; coveredUntilMs: number | null; coverageLagMs: number | null }>;
    lastSyncAgeMs: number | null;
  };
  events: { count: number; lastEventAgeMs: number | null };
  bridge: { status: string; appliedSeq: number; unappliedEntries: number; oldestUnappliedAgeMs: number | null; pins: number } | null;
  queues: Record<string, JobQueueHealth>;
  outbox: {
    byStatus: Record<string, number>;
    uncertain: number;
    needsReview: number;
    oldestDueAgeMs: number | null;
    nextAttemptAtMs: number | null;
    nextAttemptInMs: number | null;
    cooldownUntilMs: number | null;
    cooldownActive: boolean;
  };
  heldBacklog: number;
  issues: HealthIssue[];
  level: HealthLevel;
}

export interface CareHealth {
  atMs: number;
  level: HealthLevel;
  build: { version: string; careSchemaRuntime: number; careSchemaStored: number | null };
  gates: { moduleEnabled: boolean; dispatchEnabled: boolean; autoSendEnabled: boolean; channels: Record<string, boolean> };
  journal: { latestSeq: number; oldestRetainedSeq: number | null; retainedEvents: number };
  sourceJournal: { maxSeq: number; unappliedEntries: number; oldestUnappliedAgeMs: number | null };
  totals: { accounts: number; uncertain: number; needsReview: number; heldBacklog: number; dueJobs: number; withIssues: number };
  lastRestore: { atMs: number; held: boolean; intentsParked: number; jobsReleased: number; locksReleased: number } | null;
  accounts: AccountHealth[];
}

const DEFAULT_STALE_SYNC_MS = 10 * 60_000;
const DEFAULT_QUEUE_WARN_MS = 5 * 60_000;
const JOB_TYPES = ['inbound_turn', 'outbox_dispatch', 'sync_poll', 'cleanup'] as const;
const CHANNELS = ['zalo', 'telegram', 'email'] as const;

export function resolveBuildVersion(): string {
  const raw = process.env.CLAUDECLAW_BUILD_VERSION || process.env.npm_package_version || 'unknown';
  return /^[A-Za-z0-9._+-]{1,64}$/.test(raw) ? raw : 'unknown';
}

const worst = (a: HealthLevel, b: HealthLevel): HealthLevel => (a === 'error' || b === 'error' ? 'error' : a === 'warn' || b === 'warn' ? 'warn' : 'ok');
const age = (now: number, at: number | null | undefined): number | null => (at === null || at === undefined ? null : Math.max(0, now - Number(at)));

type Row = Record<string, any>;

function groupBy(rows: Row[]): Map<string, Row[]> {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const list = m.get(r.account_id);
    if (list) list.push(r);
    else m.set(r.account_id, [r]);
  }
  return m;
}

export function getCareHealth(db: Database.Database, stores: CareStores, opts: CareHealthOptions = {}): CareHealth {
  // One deferred read transaction: every number below comes from the same committed snapshot.
  return db.transaction((): CareHealth => build(db, stores, opts))();
}

function build(db: Database.Database, stores: CareStores, opts: CareHealthOptions): CareHealth {
  const now = opts.nowMs ?? Date.now();
  const staleSyncMs = opts.staleSyncMs ?? DEFAULT_STALE_SYNC_MS;
  const queueWarnMs = opts.queueWarnMs ?? DEFAULT_QUEUE_WARN_MS;
  const allow = opts.accountFilter ?? (() => true);

  const switches = new Map(stores.ownership.listSwitches().map((s) => [s.key, s.enabled]));
  const on = (key: string, defaultOn: boolean) => switches.get(key) ?? defaultOn;
  const gates = {
    moduleEnabled: on('module', false),
    dispatchEnabled: on('dispatch', true),
    autoSendEnabled: on('auto_send', true),
    channels: Object.fromEntries(CHANNELS.map((c) => [c, on(`channel:${c}`, true)])),
  };

  const accountRows = (
    db
      .prepare(
        `SELECT id, channel, connector_kind, desired_state, health_status, sync_enabled, send_enabled, ai_enabled, write_owner, owner_epoch
         FROM care_accounts ORDER BY created_at, id`,
      )
      .all() as Array<Record<string, any>>
  ).filter((a) => allow(a.id));

  const holders = new Map((db.prepare('SELECT * FROM care_account_holders').all() as Array<Record<string, any>>).map((h) => [h.account_id as string, h]));
  const sync = groupBy(db.prepare('SELECT account_id, cursor_namespace, revision, covered_until, updated_at FROM care_sync_state ORDER BY account_id, cursor_namespace').all() as Row[]);
  const events = new Map((db.prepare('SELECT account_id, COUNT(*) AS n, MAX(created_at) AS last FROM care_events GROUP BY account_id').all() as Array<Record<string, any>>).map((r) => [r.account_id as string, r]));
  const jobs = groupBy(
    db
      .prepare(
        `SELECT account_id, job_type, status, COUNT(*) AS n,
                MIN(CASE WHEN status = 'pending' AND due_at <= @now THEN due_at END) AS oldest_due,
                SUM(CASE WHEN status = 'pending' AND due_at <= @now THEN 1 ELSE 0 END) AS due,
                SUM(CASE WHEN status = 'claimed' AND lease_expires_at < @now THEN 1 ELSE 0 END) AS expired
         FROM care_jobs GROUP BY account_id, job_type, status`,
      )
      .all({ now }) as Row[],
  );
  const outboxStatus = groupBy(db.prepare('SELECT account_id, status, COUNT(*) AS n FROM care_delivery_intents GROUP BY account_id, status').all() as Row[]);
  const outboxTiming = new Map(
    (
      db
        .prepare(
          `SELECT account_id,
                  MIN(CASE WHEN status = 'pending' AND MAX(next_attempt_at, created_at) <= @now THEN MAX(next_attempt_at, created_at) END) AS oldest_due,
                  MIN(CASE WHEN status IN ('retry_wait','pending') AND next_attempt_at > @now THEN next_attempt_at END) AS next_at,
                  MAX(CASE WHEN status = 'retry_wait' AND last_error_code = 'RATE_LIMITED' AND next_attempt_at > @now THEN next_attempt_at END) AS cooldown_until
           FROM care_delivery_intents GROUP BY account_id`,
        )
        .all({ now }) as Array<Record<string, any>>
    ).map((r) => [r.account_id as string, r]),
  );
  const holds = new Map((db.prepare(`SELECT account_id, COUNT(*) AS n FROM care_backlog_holds WHERE status = 'held' GROUP BY account_id`).all() as Array<Record<string, any>>).map((r) => [r.account_id as string, Number(r.n)]));
  const bridges = new Map((db.prepare('SELECT care_account_id, status, applied_seq FROM care_bridge_state').all() as Array<Record<string, any>>).map((r) => [r.care_account_id as string, r]));
  const unapplied = new Map(
    (
      db
        .prepare(
          `SELECT j.account_id, COUNT(*) AS n, MIN(j.created_at) AS oldest
           FROM care_source_journal j
           WHERE j.applied_at IS NULL
             AND j.seq > COALESCE((SELECT s.applied_seq FROM care_bridge_state s WHERE s.care_account_id = j.account_id AND s.status <> 'disabled'), -1)
           GROUP BY j.account_id`,
        )
        .all() as Array<Record<string, any>>
    ).map((r) => [r.account_id as string, r]),
  );
  const pins = new Map((db.prepare('SELECT care_account_id, COUNT(*) AS n FROM care_journal_pins GROUP BY care_account_id').all() as Array<Record<string, any>>).map((r) => [r.care_account_id as string, Number(r.n)]));

  const accounts: AccountHealth[] = accountRows.map((a) => {
    const id = a.id as string;
    const issues: HealthIssue[] = [];
    const epoch = Number(a.owner_epoch);

    // lock holder liveness
    const h = holders.get(id);
    let lockState: LockState = 'none';
    if (h) {
      if (Number(h.generation) !== epoch) lockState = 'stale_generation';
      else if (h.role !== a.write_owner) lockState = 'owner_mismatch';
      else if (h.released_at !== null) lockState = 'released';
      else if (Number(h.expires_at) < now) lockState = 'expired';
      else lockState = 'live';
    }
    const lock: AccountHealth['lock'] = {
      state: lockState,
      holderId: h ? scrubCareLogString(String(h.holder_id), 80) : null,
      role: h ? String(h.role) : null,
      generation: h ? Number(h.generation) : null,
      lockSeq: h ? Number(h.lock_seq) : null,
      heartbeatAgeMs: h ? age(now, h.heartbeat_at) : null,
      expiresInMs: h && h.released_at === null ? Number(h.expires_at) - now : null,
    };

    // sync coverage
    const checkpoints = (sync.get(id) ?? []).map((c) => ({
      namespace: scrubCareLogString(String(c.cursor_namespace), 64),
      revision: Number(c.revision),
      ageMs: age(now, c.updated_at) ?? 0,
      coveredUntilMs: c.covered_until === null ? null : Number(c.covered_until),
      coverageLagMs: c.covered_until === null ? null : Math.max(0, now - Number(c.covered_until)),
    }));
    const lastSyncAgeMs = checkpoints.length ? Math.min(...checkpoints.map((c) => c.ageMs)) : null;

    // queues
    const queues: Record<string, JobQueueHealth> = {};
    for (const t of JOB_TYPES) queues[t] = { pending: 0, due: 0, claimed: 0, failed: 0, expiredLeases: 0, oldestDueAgeMs: null };
    let oldestDue: number | null = null;
    for (const r of jobs.get(id) ?? []) {
      const q = (queues[r.job_type] ??= { pending: 0, due: 0, claimed: 0, failed: 0, expiredLeases: 0, oldestDueAgeMs: null });
      if (r.status === 'pending') {
        q.pending += Number(r.n);
        q.due += Number(r.due ?? 0);
      }
      else if (r.status === 'claimed') q.claimed += Number(r.n);
      else if (r.status === 'failed') q.failed += Number(r.n);
      q.expiredLeases += Number(r.expired ?? 0);
      if (r.oldest_due !== null && r.oldest_due !== undefined) {
        const ageMs = age(now, r.oldest_due)!;
        q.oldestDueAgeMs = Math.max(q.oldestDueAgeMs ?? 0, ageMs);
        oldestDue = Math.max(oldestDue ?? 0, ageMs);
      }
    }

    // outbox
    const byStatus: Record<string, number> = {};
    for (const r of outboxStatus.get(id) ?? []) byStatus[r.status] = Number(r.n);
    const t = outboxTiming.get(id);
    const nextAt = t?.next_at === null || t?.next_at === undefined ? null : Number(t.next_at);
    const cooldownUntil = t?.cooldown_until === null || t?.cooldown_until === undefined ? null : Number(t.cooldown_until);
    const outboxOldest = t ? age(now, t.oldest_due) : null;
    const uncertain = byStatus.uncertain ?? 0;
    const needsReview = byStatus.needs_review ?? 0;

    const ev = events.get(id);
    const b = bridges.get(id);
    const un = unapplied.get(id);
    const bridge: AccountHealth['bridge'] = b
      ? { status: String(b.status), appliedSeq: Number(b.applied_seq), unappliedEntries: Number(un?.n ?? 0), oldestUnappliedAgeMs: age(now, un?.oldest), pins: pins.get(id) ?? 0 }
      : null;
    const held = holds.get(id) ?? 0;

    const coreActive = a.write_owner === 'core' && a.desired_state === 'active';
    if (a.health_status === 'error') issues.push('ACCOUNT_ERROR');
    else if (a.health_status === 'degraded') issues.push('ACCOUNT_DEGRADED');
    if (coreActive && Number(a.sync_enabled) === 1) {
      if (checkpoints.length === 0) issues.push('NO_CHECKPOINT');
      else if ((lastSyncAgeMs ?? 0) > staleSyncMs) issues.push('SYNC_STALE');
    }
    if (coreActive && lockState !== 'live') issues.push('LOCK_NOT_HELD');
    if ((oldestDue ?? 0) > queueWarnMs || (outboxOldest ?? 0) > queueWarnMs) issues.push('QUEUE_BACKLOG');
    if (Object.values(queues).some((q) => q.expiredLeases > 0)) issues.push('EXPIRED_LEASES');
    if (uncertain > 0) issues.push('OUTBOX_UNCERTAIN');
    if (needsReview > 0) issues.push('OUTBOX_NEEDS_REVIEW');
    if (cooldownUntil !== null) issues.push('COOLDOWN_ACTIVE');
    if (held > 0) issues.push('BACKLOG_HELD');
    if (bridge && bridge.status !== 'disabled' && bridge.unappliedEntries > 0 && (bridge.oldestUnappliedAgeMs ?? 0) > queueWarnMs) issues.push('BRIDGE_LAG');

    const level: HealthLevel = issues.includes('ACCOUNT_ERROR') ? 'error' : issues.length ? 'warn' : 'ok';
    return {
      id,
      channel: a.channel,
      connectorKind: a.connector_kind,
      desiredState: a.desired_state,
      healthStatus: a.health_status,
      flags: { sync: Number(a.sync_enabled) === 1, send: Number(a.send_enabled) === 1, ai: Number(a.ai_enabled) === 1 },
      owner: { writeOwner: a.write_owner, epoch },
      lock,
      sync: { checkpoints, lastSyncAgeMs },
      events: { count: Number(ev?.n ?? 0), lastEventAgeMs: age(now, ev?.last) },
      bridge,
      queues,
      outbox: {
        byStatus,
        uncertain,
        needsReview,
        oldestDueAgeMs: outboxOldest,
        nextAttemptAtMs: nextAt,
        nextAttemptInMs: nextAt === null ? null : nextAt - now,
        cooldownUntilMs: cooldownUntil,
        cooldownActive: cooldownUntil !== null,
      },
      heldBacklog: held,
      issues,
      level,
    };
  });

  const ids = new Set(accounts.map((a) => a.id));
  const sum = (f: (a: AccountHealth) => number) => accounts.reduce((n, a) => n + f(a), 0);
  const unappliedTotal = [...unapplied.entries()].filter(([id]) => ids.has(id));
  const maxSeq = scalar(db, 'SELECT MAX(seq) FROM care_source_journal') ?? 0;
  const seqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'care_events'").get() as { seq: number } | undefined;
  const latest = Math.max(Number(seqRow?.seq ?? 0), scalar(db, 'SELECT MAX(seq) FROM care_events') ?? 0);

  let lastRestore: CareHealth['lastRestore'] = null;
  const raw = tableExists(db, 'care_schema_meta') ? metaGet(db, 'last_restore') : null;
  if (raw) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      lastRestore = { atMs: Number(j.atMs), held: Boolean(j.held), intentsParked: Number(j.intentsParked ?? 0), jobsReleased: Number(j.jobsReleased ?? 0), locksReleased: Number(j.locksReleased ?? 0) };
    } catch {
      lastRestore = null;
    }
  }

  const storedVersion = metaGet(db, 'schema_version');
  return {
    atMs: now,
    level: accounts.reduce<HealthLevel>((l, a) => worst(l, a.level), 'ok'),
    build: {
      version: opts.buildVersion ?? resolveBuildVersion(),
      careSchemaRuntime: CARE_SCHEMA_VERSION,
      careSchemaStored: storedVersion !== null && /^\d+$/.test(storedVersion) ? Number(storedVersion) : null,
    },
    gates,
    journal: {
      latestSeq: latest,
      oldestRetainedSeq: scalar(db, 'SELECT MIN(seq) FROM care_events'),
      retainedEvents: scalar(db, 'SELECT COUNT(*) FROM care_events') ?? 0,
    },
    sourceJournal: {
      maxSeq,
      unappliedEntries: unappliedTotal.reduce((n, [, r]) => n + Number(r.n), 0),
      oldestUnappliedAgeMs: unappliedTotal.length ? Math.max(...unappliedTotal.map(([, r]) => age(now, r.oldest) ?? 0)) : null,
    },
    totals: {
      accounts: accounts.length,
      uncertain: sum((a) => a.outbox.uncertain),
      needsReview: sum((a) => a.outbox.needsReview),
      heldBacklog: sum((a) => a.heldBacklog),
      dueJobs: sum((a) => Object.values(a.queues).reduce((n, q) => n + q.due, 0)),
      withIssues: accounts.filter((a) => a.issues.length > 0).length,
    },
    lastRestore,
    accounts,
  };
}
