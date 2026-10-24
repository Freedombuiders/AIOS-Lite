/**
 * Durable job queue with lease, claim token and account-level fencing.
 *
 * Every claim AND every completion/failure/release/renewal is checked against the CURRENT
 * account row in the same statement: owner epoch must equal the job's epoch, and the
 * per-job-type gates (write owner, desired state, ai/sync/send flags, Telegram AI ban) must
 * still hold. A claim token or lease alone is never sufficient authority.
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { CareError } from '../../../_lib/care-kit/errors.js';
import type { CareJobRecord, CareJobType } from '../../../_lib/care-kit/types.js';
import { CARE_JOB_TYPES, oneOf, requireSafeInteger } from '../../../_lib/care-kit/validation.js';
import { decryptCareJson, decryptNullable, encryptCareField, encryptCareJson, type CareKeyInput } from './crypto.js';
import { requireAccountRow, requireConversationOfAccount } from './shared.js';

const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Per job type gate over an account row. Telegram AI is prohibited by design (V1), so
 * inbound_turn never runs for a personal (MTProto) account regardless of the flag. Telegram BOT accounts pass this
 * coarse SQL gate only: the per-group consent gate is checked when the job is enqueued (ingest) and again by the agent
 * turn before any model call. 'draining' blocks every new claim
 * except housekeeping.
 */
function gateSql(job: string, acct: string): string {
  return `(
    (${job}.job_type = 'inbound_turn' AND ${acct}.write_owner = 'core' AND ${acct}.desired_state = 'active'
       AND ${acct}.ai_enabled = 1 AND ${acct}.sync_enabled = 1
       AND (${acct}.channel <> 'telegram' OR ${acct}.connector_kind = 'telegram-bot'))
    OR (${job}.job_type = 'outbox_dispatch' AND ${acct}.write_owner = 'core' AND ${acct}.desired_state = 'active'
       AND ${acct}.send_enabled = 1)
    OR (${job}.job_type = 'sync_poll' AND ${acct}.write_owner = 'core' AND ${acct}.desired_state = 'active'
       AND ${acct}.sync_enabled = 1)
    OR (${job}.job_type = 'cleanup' AND ${acct}.desired_state <> 'disconnected')
  )`;
}

/** EXISTS fence usable inside UPDATE ... WHERE on care_jobs. */
const FENCE_SQL = `EXISTS (
  SELECT 1 FROM care_accounts fa
  WHERE fa.id = care_jobs.account_id
    AND fa.owner_epoch = care_jobs.owner_epoch
    AND ${gateSql('care_jobs', 'fa')}
)`;

const CAS_SQL = `id = ? AND status = 'claimed' AND lease_owner = ? AND claim_token = ? AND lease_expires_at >= ?`;

export class CareJobStore {
  constructor(
    private readonly db: Database.Database,
    private readonly key?: CareKeyInput,
  ) {}

  /**
   * Idempotent per (account, dedupeKey): a second enqueue with the same key returns the first job.
   * The enqueuing epoch must equal the account's current epoch (a stale runtime cannot enqueue).
   */
  enqueueJob(job: {
    accountId: string;
    jobType: CareJobType;
    conversationId?: string | null;
    dedupeKey?: string | null;
    payload: Record<string, unknown>;
    dueAtMs?: number;
    ownerEpoch?: number;
    maxAttempts?: number;
  }): CareJobRecord {
    const run = this.db.transaction(() => {
      const account = requireAccountRow(this.db, job.accountId);
      const jobType = oneOf(CARE_JOB_TYPES, job.jobType, 'jobType');
      const epoch = requireSafeInteger(job.ownerEpoch ?? account.ownerEpoch, 'ownerEpoch', 1);
      if (epoch !== account.ownerEpoch) {
        throw new CareError(
          'FENCING_REJECTED',
          `Job epoch ${epoch} does not match account epoch ${account.ownerEpoch}`,
          409,
        );
      }
      if (job.conversationId) requireConversationOfAccount(this.db, job.conversationId, job.accountId);
      const now = Date.now();
      const dueAt = requireSafeInteger(job.dueAtMs ?? now, 'dueAtMs', 0);
      const maxAttempts = requireSafeInteger(job.maxAttempts ?? 5, 'maxAttempts', 1);

      const payloadJson = JSON.stringify(job.payload ?? {});
      if (payloadJson === undefined || Buffer.byteLength(payloadJson) > MAX_PAYLOAD_BYTES) {
        throw new CareError('INVALID_COMMAND', 'Job payload must be JSON within the size bound', 400);
      }

      if (job.dedupeKey) {
        const existing = this.db
          .prepare('SELECT * FROM care_jobs WHERE account_id = ? AND dedupe_key = ?')
          .get(job.accountId, job.dedupeKey) as any;
        if (existing) return this.mapRow(existing);
      }

      const id = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO care_jobs (
             id, account_id, job_type, conversation_id, dedupe_key, payload_enc,
             status, owner_epoch, due_at, attempts, max_attempts, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?, ?)`,
        )
        .run(
          id,
          job.accountId,
          jobType,
          job.conversationId ?? null,
          job.dedupeKey ?? null,
          encryptCareJson(job.payload ?? {}, this.key),
          epoch,
          dueAt,
          maxAttempts,
          now,
          now,
        );
      return this.getJob(id)!;
    });
    return run();
  }

  getJob(id: string): CareJobRecord | null {
    const row = this.db.prepare('SELECT * FROM care_jobs WHERE id = ?').get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  /**
   * Claims due jobs under current account state. Lease-expired claimed jobs are reclaimable
   * (new token, new generation) unless their attempts are exhausted, in which case they fail.
   */
  claimJobs(opts: {
    workerId: string;
    /** Allowed accounts. Omitted = unscoped worker; an explicitly EMPTY list claims nothing. */
    accountIds?: string[];
    /** Allowed job types. Omitted = all; an explicitly EMPTY list claims nothing. */
    jobTypes?: CareJobType[];
    leaseDurationMs: number;
    currentEpoch: number;
    limit?: number;
    nowMs?: number;
  }): CareJobRecord[] {
    requireSafeInteger(opts.currentEpoch, 'currentEpoch', 1);
    requireSafeInteger(opts.leaseDurationMs, 'leaseDurationMs', 1);
    const workerId = typeof opts.workerId === 'string' && opts.workerId.length > 0 ? opts.workerId : null;
    if (!workerId) throw new CareError('INVALID_COMMAND', 'workerId is required', 400);
    if (opts.accountIds !== undefined && opts.accountIds.length === 0) return [];
    if (opts.jobTypes !== undefined && opts.jobTypes.length === 0) return [];
    for (const t of opts.jobTypes ?? []) oneOf(CARE_JOB_TYPES, t, 'jobType');
    const now = opts.nowMs ?? Date.now();
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 10) || 1, 1), 100);
    const leaseExpires = now + opts.leaseDurationMs;

    // The SAME scope applies to claiming and to lease-exhaustion housekeeping: a worker scoped to
    // account A / epoch N / some job types can neither claim nor fail anyone else's jobs.
    const scopeParams: any[] = [];
    let scopeSql = '';
    if (opts.accountIds && opts.accountIds.length > 0) {
      scopeSql += ` AND ${'{J}'}.account_id IN (${opts.accountIds.map(() => '?').join(',')})`;
      scopeParams.push(...opts.accountIds);
    }
    if (opts.jobTypes && opts.jobTypes.length > 0) {
      scopeSql += ` AND ${'{J}'}.job_type IN (${opts.jobTypes.map(() => '?').join(',')})`;
      scopeParams.push(...opts.jobTypes);
    }

    const runClaim = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE care_jobs
           SET status = 'failed', lease_owner = NULL, claim_token = NULL, last_error_enc = ?, updated_at = ?
           WHERE status = 'claimed' AND lease_expires_at < ? AND attempts >= max_attempts
             AND owner_epoch = ?${scopeSql.replaceAll('{J}', 'care_jobs')}`,
        )
        .run(encryptCareField('lease_expired_attempts_exhausted', this.key), now, now, opts.currentEpoch, ...scopeParams);

      let candidateSql = `
        SELECT j.id
        FROM care_jobs j
        JOIN care_accounts a ON j.account_id = a.id
        WHERE (j.status = 'pending' OR (j.status = 'claimed' AND j.lease_expires_at < ?))
          AND j.attempts < j.max_attempts
          AND j.due_at <= ?
          AND j.owner_epoch = ?
          AND a.owner_epoch = ?
          AND ${gateSql('j', 'a')}
      `;
      const params: any[] = [now, now, opts.currentEpoch, opts.currentEpoch];

      candidateSql += scopeSql.replaceAll('{J}', 'j');
      params.push(...scopeParams);
      candidateSql += ' ORDER BY j.due_at ASC, j.created_at ASC, j.id ASC LIMIT ?';
      params.push(limit);

      const candidates = this.db.prepare(candidateSql).all(...params) as Array<{ id: string }>;
      if (candidates.length === 0) return [];

      const update = this.db.prepare(`
        UPDATE care_jobs
        SET status = 'claimed', lease_owner = ?, lease_expires_at = ?, claim_token = ?,
            claim_generation = claim_generation + 1, attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at < ?))
      `);

      const claimedIds: string[] = [];
      for (const { id } of candidates) {
        if (update.run(workerId, leaseExpires, crypto.randomUUID(), now, id, now).changes > 0) claimedIds.push(id);
      }
      if (claimedIds.length === 0) return [];
      const rows = this.db
        .prepare(`SELECT * FROM care_jobs WHERE id IN (${claimedIds.map(() => '?').join(',')}) ORDER BY due_at ASC, created_at ASC, id ASC`)
        .all(...claimedIds) as any[];
      return rows.map((r) => this.mapRow(r));
    });

    return runClaim.immediate();
  }

  /** CAS: exact worker + token, claimed, lease valid, and the account still authorises this job. */
  completeJob(jobId: string, workerId: string, claimToken: string, nowMs?: number): boolean {
    const now = nowMs ?? Date.now();
    const res = this.db
      .prepare(
        `UPDATE care_jobs SET status = 'completed', updated_at = ?
         WHERE ${CAS_SQL} AND ${FENCE_SQL}`,
      )
      .run(now, jobId, workerId, claimToken, now);
    return res.changes > 0;
  }

  /**
   * CAS failure in ONE statement (no read-then-write window): retryable failures with attempts
   * left return to pending after the backoff, everything else becomes terminal.
   */
  failJob(
    jobId: string,
    workerId: string,
    claimToken: string,
    error: string,
    canRetry = true,
    backoffMs = 5000,
    nowMs?: number,
  ): boolean {
    const now = nowMs ?? Date.now();
    const retry = canRetry ? 1 : 0;
    const res = this.db
      .prepare(
        `UPDATE care_jobs SET
           status = CASE WHEN ? = 1 AND attempts < max_attempts THEN 'pending' ELSE 'failed' END,
           due_at = CASE WHEN ? = 1 AND attempts < max_attempts THEN ? ELSE due_at END,
           lease_owner = NULL, lease_expires_at = NULL, claim_token = NULL,
           last_error_enc = ?, updated_at = ?
         WHERE ${CAS_SQL} AND ${FENCE_SQL}`,
      )
      .run(retry, retry, now + backoffMs, encryptCareField(String(error).slice(0, 1000), this.key), now, jobId, workerId, claimToken, now);
    return res.changes > 0;
  }

  /** Returns a claimed job to pending without counting a failure (attempt is refunded). */
  releaseJob(jobId: string, workerId: string, claimToken: string, nowMs?: number): boolean {
    const now = nowMs ?? Date.now();
    const res = this.db
      .prepare(
        `UPDATE care_jobs
         SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, claim_token = NULL,
             attempts = MAX(attempts - 1, 0), updated_at = ?
         WHERE ${CAS_SQL} AND ${FENCE_SQL}`,
      )
      .run(now, jobId, workerId, claimToken, now);
    return res.changes > 0;
  }

  /**
   * Extends a still-valid lease; never shortens it (the new expiry is the later of the current
   * one and now + extendMs). Fails once the lease lapsed, was reclaimed, or the account fenced
   * the job.
   */
  renewLease(jobId: string, workerId: string, claimToken: string, extendMs: number, nowMs?: number): boolean {
    requireSafeInteger(extendMs, 'extendMs', 1);
    const now = nowMs ?? Date.now();
    const res = this.db
      .prepare(
        `UPDATE care_jobs SET lease_expires_at = MAX(lease_expires_at, ?), updated_at = ?
         WHERE ${CAS_SQL} AND ${FENCE_SQL}`,
      )
      .run(now + extendMs, now, jobId, workerId, claimToken, now);
    return res.changes > 0;
  }

  /**
   * Terminally fails open jobs whose epoch no longer matches the account (they can never be
   * claimed or completed again). Explicit housekeeping for cutover (CC-12), not run implicitly.
   */
  supersedeStaleEpochJobs(accountId: string, nowMs?: number): number {
    const now = nowMs ?? Date.now();
    const res = this.db
      .prepare(
        `UPDATE care_jobs
         SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, claim_token = NULL,
             last_error_enc = ?, updated_at = ?
         WHERE account_id = ? AND status IN ('pending','claimed')
           AND owner_epoch <> (SELECT owner_epoch FROM care_accounts WHERE id = ?)`,
      )
      .run(encryptCareField('superseded_by_epoch', this.key), now, accountId, accountId);
    return res.changes;
  }

  private mapRow(row: any): CareJobRecord {
    return {
      id: row.id,
      accountId: row.account_id,
      jobType: row.job_type,
      conversationId: row.conversation_id,
      dedupeKey: row.dedupe_key,
      payload: decryptCareJson<Record<string, unknown>>(row.payload_enc, this.key),
      status: row.status,
      ownerEpoch: Number(row.owner_epoch),
      claimToken: row.claim_token,
      leaseOwner: row.lease_owner,
      leaseExpiresAtMs: row.lease_expires_at === null || row.lease_expires_at === undefined ? null : Number(row.lease_expires_at),
      dueAtMs: Number(row.due_at),
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      lastError: decryptNullable(row.last_error_enc, this.key),
      createdAtMs: Number(row.created_at),
      updatedAtMs: Number(row.updated_at),
    };
  }
}
