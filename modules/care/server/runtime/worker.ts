/**
 * Care worker loop skeleton. It ORCHESTRATES injected handlers (`inbound_turn`, `outbox_dispatch`, `sync_poll`,
 * `cleanup`) and nothing else: no connector SDK, no provider, no model import lives here.
 *
 * Per account, per tick:  gate (work/send) -> ownership lock (acquire/renew, generation = owner_epoch) ->
 * epoch-fenced claim (one delivery lane per account) -> per-job gate (+ backlog hold) -> handler -> CAS outcome.
 *
 * Authority is never inferred from having claimed a job: every step re-checks the account row (epoch, owner,
 * switches) and the holder lock, and every outcome write is the job store's own fenced CAS. A handler that is
 * about to cause an RPC must call `ctx.assertAuthorised()` (or `heartbeat()`) immediately before it.
 */
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { CareError } from '../../../_lib/care-kit/errors.js';
import type { CareChannel, CareJobRecord, CareJobType } from '../../../_lib/care-kit/types.js';
import type { CareStores } from '../persistence/index.js';
import type { OwnershipLock } from '../persistence/ownership-store.js';
import { systemClock, type RuntimeClock } from './clock.js';
import { leastRecentlyServedFairness, type FairnessPolicy } from './fairness.js';
import { evaluateDispatchGate, type DispatchDecision } from './gates.js';
import { DEFAULT_BACKOFF, Supervisor, type BackoffPolicy, type SupervisorEvent } from './supervisor.js';
import { JOB_BACKLOG_KIND } from './backlog.js';

export type JobOutcome =
  | { kind: 'done' }
  /** Transient failure; goes back to pending after `backoffMs` while attempts remain. */
  | { kind: 'retry'; error: string; backoffMs?: number }
  | { kind: 'fail'; error: string }
  /** Hand the job back untouched (attempt refunded). */
  | { kind: 'release' };

export interface JobContext {
  job: CareJobRecord;
  accountId: string;
  channel: CareChannel;
  /** The owner epoch this lane runs under; equal to job.ownerEpoch. */
  epoch: number;
  lock: OwnershipLock;
  signal: AbortSignal;
  clock: RuntimeClock;
  /** Renews the holder lock AND the job lease. false = authority lost: stop, do not dispatch. */
  heartbeat(): boolean;
  /** Re-evaluates the full dispatch gate (+ lock + backlog hold). Throws FENCING_REJECTED when not allowed. */
  assertAuthorised(): void;
}

export type JobHandler = (ctx: JobContext) => Promise<JobOutcome> | JobOutcome;
export type WorkerHandlers = Partial<Record<CareJobType, JobHandler>>;

export interface WorkerConfig {
  /** Holder id for the ownership lock and the job lease owner. Must be unique per worker instance. */
  workerId: string;
  /** Random per process start; NOT a PID. Defaults to a fresh UUID. */
  processToken?: string;
  lockTtlMs?: number;
  leaseMs?: number;
  batchPerAccount?: number;
  maxConcurrentAccounts?: number;
  idleSleepMs?: number;
  drainTimeoutMs?: number;
  defaultRetryBackoffMs?: number;
  backoff?: Partial<BackoffPolicy>;
  pid?: number;
  host?: string;
}

export interface WorkerEvent {
  type:
    | 'lock_denied'
    | 'lock_lost'
    | 'gate_denied'
    | 'job_done'
    | 'job_retry'
    | 'job_failed'
    | 'job_released'
    | 'job_held'
    | 'job_fenced'
    | 'handler_error'
    | 'account_error'
    | 'drain_timeout';
  accountId?: string;
  jobId?: string;
  code?: string;
}

export interface WorkerDeps {
  db: Database.Database;
  stores: CareStores;
  handlers: WorkerHandlers;
  config: WorkerConfig;
  clock?: RuntimeClock;
  fairness?: FairnessPolicy;
  onEvent?: (e: WorkerEvent) => void;
  onSupervisorEvent?: (e: SupervisorEvent) => void;
}

export interface AccountTickReport {
  skipped?: string;
  claimed: number;
  done: number;
  retried: number;
  failed: number;
  released: number;
  held: number;
  fenced: number;
}

export interface TickReport {
  accounts: Record<string, AccountTickReport>;
  jobsClaimed: number;
}

export interface DrainReport {
  drained: boolean;
  /** Accounts whose lane did not finish in time; their lock is deliberately NOT released. */
  abandonedAccounts: string[];
}

const emptyReport = (): AccountTickReport => ({ claimed: 0, done: 0, retried: 0, failed: 0, released: 0, held: 0, fenced: 0 });

export class CareWorker {
  private readonly clock: RuntimeClock;
  private readonly fairness: FairnessPolicy;
  private readonly cfg: Required<Omit<WorkerConfig, 'backoff' | 'pid' | 'host'>> & Pick<WorkerConfig, 'backoff' | 'pid' | 'host'>;
  private readonly locks = new Map<string, OwnershipLock>();
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly lastServed = new Map<string, number>();
  private readonly served = new Map<string, number>();
  private readonly abort = new AbortController();
  private _draining = false;
  private supervisor: Supervisor | null = null;

  constructor(private readonly deps: WorkerDeps) {
    this.clock = deps.clock ?? systemClock;
    this.fairness = deps.fairness ?? leastRecentlyServedFairness;
    const c = deps.config;
    this.cfg = {
      workerId: c.workerId,
      processToken: c.processToken ?? crypto.randomUUID(),
      lockTtlMs: c.lockTtlMs ?? 30_000,
      leaseMs: c.leaseMs ?? 60_000,
      batchPerAccount: c.batchPerAccount ?? 1,
      maxConcurrentAccounts: c.maxConcurrentAccounts ?? 4,
      idleSleepMs: c.idleSleepMs ?? 1_000,
      drainTimeoutMs: c.drainTimeoutMs ?? 30_000,
      defaultRetryBackoffMs: c.defaultRetryBackoffMs ?? 5_000,
      backoff: c.backoff,
      pid: c.pid,
      host: c.host,
    };
  }

  get draining(): boolean {
    return this._draining;
  }

  /** Locks this worker currently believes it holds (diagnostics / tests). */
  heldLocks(): OwnershipLock[] {
    return [...this.locks.values()];
  }

  // ── loop ───────────────────────────────────────────────────────────────────────────────────

  /** One scheduling pass over every active core account, bounded concurrency, fairness-ordered. */
  async runOnce(): Promise<TickReport> {
    const report: TickReport = { accounts: {}, jobsClaimed: 0 };
    if (this._draining) return report;
    const now = this.clock.now();
    const rows = this.deps.db
      .prepare(`SELECT id, channel, owner_epoch FROM care_accounts WHERE write_owner = 'core' AND desired_state = 'active'`)
      .all() as Array<{ id: string; channel: string; owner_epoch: number }>;
    const accounts = rows.map((r) => ({ id: r.id, channel: r.channel, ownerEpoch: Number(r.owner_epoch) }));
    const order = this.fairness.order(accounts, { nowMs: now, lastServedAtMs: this.lastServed, servedCount: this.served });
    const queue = order.filter((id) => accounts.some((a) => a.id === id) && !this.lanes.has(id));

    const runLane = async (id: string) => {
      const lane = this.serveAccount(id).then(
        (r) => {
          report.accounts[id] = r;
          report.jobsClaimed += r.claimed;
        },
        (e) => {
          this.emit({ type: 'account_error', accountId: id, code: e instanceof CareError ? e.code : 'ERROR' });
          report.accounts[id] = { ...emptyReport(), skipped: 'error' };
        },
      );
      this.lanes.set(id, lane);
      try {
        await lane;
      } finally {
        this.lanes.delete(id);
        this.lastServed.set(id, this.clock.now());
      }
    };
    const runners = Array.from({ length: Math.min(this.cfg.maxConcurrentAccounts, queue.length) }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) await runLane(id);
    });
    await Promise.all(runners);
    return report;
  }

  /** Supervised forever-loop: crash -> backoff -> restart; fatal/exhausted -> stays down. */
  start(): Supervisor {
    if (this.supervisor) return this.supervisor;
    this.supervisor = new Supervisor({
      name: `care-worker:${this.cfg.workerId}`,
      clock: this.clock,
      backoff: { ...DEFAULT_BACKOFF, ...this.cfg.backoff },
      isFatal: (e) => e instanceof CareError && e.code === 'CREDENTIAL_DECODE_FAILED',
      onEvent: this.deps.onSupervisorEvent,
      run: async (signal) => {
        while (!signal.aborted && !this._draining) {
          const r = await this.runOnce();
          if (r.jobsClaimed === 0) await this.clock.sleep(this.cfg.idleSleepMs, signal);
        }
      },
    });
    this.supervisor.start();
    return this.supervisor;
  }

  /**
   * Graceful drain: stop taking work, let running lanes finish (bounded), then release locks of accounts whose
   * lane finished. A lane still running past the timeout keeps its lock until it expires so nobody else can
   * start dispatching next to an RPC that may still be in flight; its handlers get an abort signal.
   */
  async drain(timeoutMs = this.cfg.drainTimeoutMs): Promise<DrainReport> {
    this._draining = true;
    const running = [...this.lanes.entries()];
    let timedOut = false;
    if (running.length > 0) {
      const settled = Promise.all(running.map(([, p]) => p)).then(() => 'done' as const);
      const timer = this.clock.sleep(timeoutMs).then(() => 'timeout' as const);
      timedOut = (await Promise.race([settled, timer])) === 'timeout';
    }
    const abandoned: string[] = [];
    if (timedOut) {
      this.abort.abort();
      for (const [id] of running) if (this.lanes.has(id)) abandoned.push(id);
      this.emit({ type: 'drain_timeout', code: String(abandoned.length) });
    }
    for (const [id, lock] of this.locks) {
      if (abandoned.includes(id)) continue;
      this.deps.stores.ownership.release(lock, this.clock.now());
      this.locks.delete(id);
    }
    if (this.supervisor) await this.supervisor.stop();
    return { drained: abandoned.length === 0, abandonedAccounts: abandoned };
  }

  // ── per account ────────────────────────────────────────────────────────────────────────────

  private emit(e: WorkerEvent): void {
    this.deps.onEvent?.(e);
  }

  private gate(accountId: string, epoch: number, operation: 'send' | 'work', extra: { lock?: OwnershipLock; item?: { kind: string; id: string } } = {}): DispatchDecision {
    return evaluateDispatchGate(this.deps.db, accountId, epoch, 'core', 'job', { operation, nowMs: this.clock.now(), ...extra });
  }

  private async serveAccount(accountId: string): Promise<AccountTickReport> {
    const report = emptyReport();
    const { db, stores, handlers } = this.deps;
    const row = db.prepare('SELECT channel, owner_epoch FROM care_accounts WHERE id = ?').get(accountId) as { channel: CareChannel; owner_epoch: number } | undefined;
    if (!row) return { ...report, skipped: 'ACCOUNT_NOT_FOUND' };
    const epoch = Number(row.owner_epoch);

    // account-level gate BEFORE taking any lock or claiming anything
    const work = this.gate(accountId, epoch, 'work');
    if (!work.allow) {
      this.emit({ type: 'gate_denied', accountId, code: work.code });
      return { ...report, skipped: work.code };
    }
    const send = this.gate(accountId, epoch, 'send');

    const lock = this.ensureLock(accountId, epoch);
    if (!lock) return { ...report, skipped: 'LOCK_DENIED' };

    const jobTypes = (Object.keys(handlers) as CareJobType[]).filter((t) => handlers[t] && (t !== 'outbox_dispatch' || send.allow));
    if (jobTypes.length === 0) return { ...report, skipped: send.allow ? 'NO_HANDLERS' : (send as { code: string }).code };

    const jobs = stores.jobs.claimJobs({
      workerId: this.cfg.workerId,
      accountIds: [accountId],
      jobTypes,
      leaseDurationMs: this.cfg.leaseMs,
      currentEpoch: epoch,
      limit: this.cfg.batchPerAccount,
      nowMs: this.clock.now(),
    });
    report.claimed = jobs.length;
    // one delivery lane per account: strictly sequential
    for (const job of jobs) {
      if (this._draining && this.abort.signal.aborted) {
        stores.jobs.releaseJob(job.id, this.cfg.workerId, job.claimToken!, this.clock.now());
        report.released += 1;
        continue;
      }
      await this.processJob(job, row.channel, epoch, lock, report);
    }
    if (jobs.length > 0) this.served.set(accountId, (this.served.get(accountId) ?? 0) + jobs.length);
    return report;
  }

  /** Acquire or renew the holder lock under the account's CURRENT epoch. null = another authority holds it. */
  private ensureLock(accountId: string, epoch: number): OwnershipLock | null {
    const own = this.deps.stores.ownership;
    const now = this.clock.now();
    const existing = this.locks.get(accountId);
    if (existing) {
      const r = own.renew(existing, { ttlMs: this.cfg.lockTtlMs, nowMs: now });
      if (r.ok) {
        this.locks.set(accountId, r.lock);
        return r.lock;
      }
      this.locks.delete(accountId);
      this.emit({ type: 'lock_lost', accountId, code: r.reason });
    }
    const a = own.acquire({
      accountId,
      holderId: this.cfg.workerId,
      processToken: this.cfg.processToken,
      role: 'core',
      generation: epoch,
      ttlMs: this.cfg.lockTtlMs,
      nowMs: now,
      pid: this.cfg.pid,
      host: this.cfg.host,
    });
    if (!a.ok) {
      this.emit({ type: 'lock_denied', accountId, code: a.reason });
      return null;
    }
    this.locks.set(accountId, a.lock);
    return a.lock;
  }

  private async processJob(job: CareJobRecord, channel: CareChannel, epoch: number, lock: OwnershipLock, report: AccountTickReport): Promise<void> {
    const { stores, handlers } = this.deps;
    const token = job.claimToken!;
    const workerId = this.cfg.workerId;
    const now = () => this.clock.now();
    const operation = job.jobType === 'outbox_dispatch' ? 'send' : 'work';
    const item = { kind: JOB_BACKLOG_KIND, id: job.id };

    const decision = this.gate(job.accountId, epoch, operation, { lock, item });
    if (!decision.allow) {
      this.emit({ type: decision.code === 'BACKLOG_HELD' ? 'job_held' : 'gate_denied', accountId: job.accountId, jobId: job.id, code: decision.code });
      if (decision.code === 'BACKLOG_HELD') {
        // parked for explicit review: terminal here, the hold row keeps it findable (see releaseHeldJob)
        if (stores.jobs.failJob(job.id, workerId, token, 'backlog_held', false, 0, now())) report.held += 1;
        else report.fenced += 1;
      } else if (stores.jobs.releaseJob(job.id, workerId, token, now())) report.released += 1;
      else report.fenced += 1;
      return;
    }

    let current = lock;
    const ctx: JobContext = {
      job,
      accountId: job.accountId,
      channel,
      epoch,
      lock,
      signal: this.abort.signal,
      clock: this.clock,
      heartbeat: () => {
        const r = stores.ownership.renew(current, { ttlMs: this.cfg.lockTtlMs, nowMs: now() });
        if (!r.ok) return false;
        current = r.lock;
        this.locks.set(job.accountId, r.lock);
        return stores.jobs.renewLease(job.id, workerId, token, this.cfg.leaseMs, now());
      },
      assertAuthorised: () => {
        const d = this.gate(job.accountId, epoch, operation, { lock: current, item });
        if (!d.allow) throw new CareError('FENCING_REJECTED', `Dispatch no longer authorised: ${d.code}`, 409, { code: d.code });
      },
    };

    let outcome: JobOutcome;
    try {
      outcome = await handlers[job.jobType]!(ctx);
    } catch (e) {
      const fenced = e instanceof CareError && e.code === 'FENCING_REJECTED';
      this.emit({ type: fenced ? 'job_fenced' : 'handler_error', accountId: job.accountId, jobId: job.id, code: e instanceof CareError ? e.code : 'ERROR' });
      // A fenced handler did NOT dispatch; anything else is an unknown outcome and goes through the retry path,
      // where an RPC-capable handler is expected to have recorded its own attempt state before throwing.
      outcome = fenced ? { kind: 'release' } : { kind: 'retry', error: e instanceof Error ? e.message : 'handler error' };
    }

    let applied: boolean;
    switch (outcome.kind) {
      case 'done':
        applied = stores.jobs.completeJob(job.id, workerId, token, now());
        if (applied) report.done += 1;
        this.emit({ type: 'job_done', accountId: job.accountId, jobId: job.id });
        break;
      case 'retry':
        applied = stores.jobs.failJob(job.id, workerId, token, outcome.error, true, outcome.backoffMs ?? this.cfg.defaultRetryBackoffMs, now());
        if (applied) report.retried += 1;
        this.emit({ type: 'job_retry', accountId: job.accountId, jobId: job.id });
        break;
      case 'fail':
        applied = stores.jobs.failJob(job.id, workerId, token, outcome.error, false, 0, now());
        if (applied) report.failed += 1;
        this.emit({ type: 'job_failed', accountId: job.accountId, jobId: job.id });
        break;
      default:
        applied = stores.jobs.releaseJob(job.id, workerId, token, now());
        if (applied) report.released += 1;
        this.emit({ type: 'job_released', accountId: job.accountId, jobId: job.id });
    }
    if (!applied) {
      // Account fenced the job (epoch/owner/gate changed) or the lease was lost: the CAS refused. Never retried here.
      report.fenced += 1;
      this.emit({ type: 'job_fenced', accountId: job.accountId, jobId: job.id, code: 'OUTCOME_REFUSED' });
    }
  }
}
