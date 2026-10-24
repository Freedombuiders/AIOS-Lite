/**
 * Re-enable never auto-sends backlog. When a module / dispatch / channel / path switch (or an account) comes
 * back ON, everything still pending that is OLDER than that moment is parked in care_backlog_holds. The gate
 * refuses held items (BACKLOG_HELD) until a person explicitly releases or discards them.
 *
 * Sources are injected ports so the outbox (CC-11) can park its own intents without this file knowing
 * its schema; the built-in source covers care_jobs.
 */
import type Database from 'better-sqlite3';
import { CareError } from '../../../_lib/care-kit/errors.js';
import type { CareStores } from '../persistence/index.js';
import { CareOwnershipStore } from '../persistence/ownership-store.js';

export interface BacklogItem {
  kind: string;
  id: string;
  accountId: string;
}

export interface BacklogSource {
  readonly kind: string;
  /** Pending (not yet dispatched) items created at or before `cutoffMs` (conservative: a same-millisecond item is held); `accountIds: null` = every account. */
  listPendingBefore(scope: { cutoffMs: number; accountIds: string[] | null }): BacklogItem[];
  /** Optional: move the item into the source's own review state (runs in the same transaction as the hold). */
  park?(items: BacklogItem[]): void;
}

export const JOB_BACKLOG_KIND = 'job';

/** care_jobs source: pending outbox_dispatch / inbound_turn jobs. sync_poll / cleanup are housekeeping and never held. */
export function careJobsBacklogSource(db: Database.Database): BacklogSource {
  return {
    kind: JOB_BACKLOG_KIND,
    listPendingBefore({ cutoffMs, accountIds }) {
      if (accountIds !== null && accountIds.length === 0) return [];
      const scope = accountIds === null ? '' : ` AND account_id IN (${accountIds.map(() => '?').join(',')})`;
      const rows = db
        .prepare(
          `SELECT id, account_id FROM care_jobs
           WHERE status = 'pending' AND job_type IN ('outbox_dispatch','inbound_turn') AND created_at <= ?${scope}
           ORDER BY created_at ASC, id ASC`,
        )
        .all(cutoffMs, ...(accountIds ?? [])) as Array<{ id: string; account_id: string }>;
      return rows.map((r) => ({ kind: JOB_BACKLOG_KIND, id: r.id, accountId: r.account_id }));
    },
  };
}

export interface MarkBacklogHeldOptions {
  /** Re-enable moment: items created at or before it are parked. */
  cutoffMs: number;
  accountIds?: string[] | null;
  /** Defaults to the care_jobs source. Pass `[...defaults, outboxSource]` to add more. */
  sources?: BacklogSource[];
  actor: string;
  reason: string;
  nowMs?: number;
}

export function markBacklogHeld(db: Database.Database, opts: MarkBacklogHeldOptions): { held: number; byKind: Record<string, number> } {
  const store = new CareOwnershipStore(db);
  const sources = opts.sources ?? [careJobsBacklogSource(db)];
  const run = db.transaction(() => {
    const byKind: Record<string, number> = {};
    let held = 0;
    for (const source of sources) {
      const items = source.listPendingBefore({ cutoffMs: opts.cutoffMs, accountIds: opts.accountIds ?? null });
      if (items.length === 0) continue;
      const n = store.holdItems(items, { cutoffMs: opts.cutoffMs, reason: opts.reason, actor: opts.actor, nowMs: opts.nowMs });
      source.park?.(items);
      byKind[source.kind] = (byKind[source.kind] ?? 0) + n;
      held += n;
    }
    return { held, byKind };
  });
  return run.immediate();
}

/**
 * Explicit review: release a held job. A job still pending simply becomes claimable again; a job the worker
 * already parked (terminally failed as `backlog_held`) is re-enqueued under the CURRENT epoch with a derived
 * dedupe key, so the release is idempotent and the old failed row stays as history.
 */
export function releaseHeldJob(stores: CareStores, db: Database.Database, jobId: string, actor: string, nowMs?: number): { released: boolean; requeuedJobId: string | null } {
  const ownership = new CareOwnershipStore(db);
  const run = db.transaction(() => {
    const job = stores.jobs.getJob(jobId);
    if (!job) throw new CareError('NOT_FOUND', `Job not found: ${jobId}`, 404);
    if (!ownership.resolveHold(JOB_BACKLOG_KIND, jobId, 'released', { actor, nowMs })) return { released: false, requeuedJobId: null };
    if (job.status !== 'failed') return { released: true, requeuedJobId: null };
    const account = stores.accounts.getAccount(job.accountId);
    if (!account) return { released: true, requeuedJobId: null };
    const clone = stores.jobs.enqueueJob({
      accountId: job.accountId,
      jobType: job.jobType,
      conversationId: job.conversationId,
      dedupeKey: `released:${job.id}`,
      payload: job.payload,
      ownerEpoch: account.ownerEpoch,
      dueAtMs: nowMs,
    });
    return { released: true, requeuedJobId: clone.id };
  });
  return run.immediate();
}

export function discardHeldJob(db: Database.Database, jobId: string, actor: string, nowMs?: number): boolean {
  return new CareOwnershipStore(db).resolveHold(JOB_BACKLOG_KIND, jobId, 'discarded', { actor, nowMs });
}
