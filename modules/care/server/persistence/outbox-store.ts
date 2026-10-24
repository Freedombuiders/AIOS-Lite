/**
 * CC-11 durable outbox: delivery intents, attempts and receipts.
 *
 * One `care_delivery_intents` row is the whole life of a delivery (draft -> pending -> sending -> sent,
 * with retry_wait / uncertain / needs_review / failed / cancelled / discarded on the side). Each RPC
 * is one `care_delivery_attempts` row that is INSERTED BEFORE the provider is contacted, carrying the
 * native retry token that every retry of the intent reuses verbatim.
 *
 * Rules enforced here, in SQL, so no caller and no second process handle can skip them:
 *  - (account, clientRequestId) is unique; the same key with a different payload hash is a 409;
 *  - one `sending` intent per account (partial unique index = one delivery lane per account);
 *  - claim, attempt start and release are fenced by the account row (core owner, active, send flag,
 *    owner epoch) in the same statement, so a lease or claim token alone is never authority;
 *  - target, body, recipients, reply reference and tokens are immutable once written; a draft edit
 *    bumps the payload revision and drops the approval;
 *  - an attempt that already reached the provider is never repeated automatically: a lost lease or
 *    a crash with an open attempt becomes `uncertain`, and `uncertain` never returns to `pending`
 *    with a new token. Late evidence (receipt / reconcile) resolves the ORIGINAL attempt even from
 *    an old epoch, and never grants that epoch permission to send more;
 *  - outcome + intent state + canonical message + event commit in ONE transaction; no model or
 *    network call ever runs inside it.
 * All message text, recipients and error detail are encrypted at rest like the other Care stores.
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { CareError } from '../../../_lib/care-kit/errors.js';
import type { ChatDeliveryCommand, EmailDeliveryCommand } from '../../../_lib/care-kit/contract.js';
import type { CareActorType, CareChannel, CareIntentPurpose, CareReceiptLevel } from '../../../_lib/care-kit/types.js';
import { CARE_CHANNELS, oneOf, requireNonEmptyString, requireSafeInteger } from '../../../_lib/care-kit/validation.js';
import {
  decryptCareJson,
  decryptNullable,
  encryptCareField,
  encryptCareJson,
  encryptNullable,
  resolveEncryptionKey,
  type CareKeyInput,
} from './crypto.js';
import { CareEventStore } from './event-store.js';
import { requireAccountRow, requireConversationOfAccount } from './shared.js';

// ── Types ────────────────────────────────────────────────────────────────────────────────────

/** CareDeliveryStatus plus `needs_review` (guide section 5: reconcile may end in manual review). */
export type OutboxStatus =
  | 'draft'
  | 'pending'
  | 'sending'
  | 'sent'
  | 'retry_wait'
  | 'uncertain'
  | 'needs_review'
  | 'failed'
  | 'cancelled'
  | 'discarded';

export const OUTBOX_STATUSES: readonly OutboxStatus[] = [
  'draft',
  'pending',
  'sending',
  'sent',
  'retry_wait',
  'uncertain',
  'needs_review',
  'failed',
  'cancelled',
  'discarded',
];

export type OutboxAttemptOutcome = 'accepted' | 'uncertain' | 'retryable' | 'terminal' | 'review';

/** The immutable part of a delivery: what a DeliveryCommand carries besides runtime fields. */
export type OutboxPayload =
  | Pick<ChatDeliveryCommand, 'kind' | 'channel' | 'text' | 'target'>
  | Pick<EmailDeliveryCommand, 'kind' | 'channel' | 'text' | 'target' | 'bcc'>;

export interface OutboxIntentRecord {
  id: string;
  accountId: string;
  conversationId: string | null;
  clientRequestId: string;
  actor: CareActorType;
  purpose: CareIntentPurpose;
  status: OutboxStatus;
  statusReason: string | null;
  channel: CareChannel;
  payload: OutboxPayload;
  payloadHash: string;
  payloadRevision: number;
  approvedRevision: number | null;
  contextRevision: number | null;
  policyRevision: string | null;
  /** Local canonical message this delivery answers (the native ID is baked into the target). */
  replyMessageId: string | null;
  /** Native retry token, persisted before any RPC and reused by every attempt. */
  adapterRetryToken: string;
  sourceRunId: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  queueSeq: number | null;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAtMs: number;
  ownerEpoch: number;
  leaseOwner: string | null;
  leaseExpiresAtMs: number | null;
  claimToken: string | null;
  claimGeneration: number;
  receiptLevel: CareReceiptLevel | null;
  canonicalMessageId: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  sentAtMs: number | null;
}

export interface OutboxAttemptRecord {
  id: string;
  intentId: string;
  accountId: string;
  attemptNo: number;
  requestToken: string;
  ownerEpoch: number;
  workerId: string | null;
  outcome: OutboxAttemptOutcome | null;
  receiptLevel: CareReceiptLevel | null;
  nativeMessageId: string | null;
  remoteTimestampMs: number | null;
  errorCode: string | null;
  error: string | null;
  startedAtMs: number;
  finishedAtMs: number | null;
}

export interface OutboxClaim {
  intentId: string;
  accountId: string;
  workerId: string;
  claimToken: string;
  claimGeneration: number;
  ownerEpoch: number;
  leaseExpiresAtMs: number;
}

export interface OutboxInsertInput {
  accountId: string;
  conversationId: string | null;
  clientRequestId: string;
  actor: CareActorType;
  purpose: CareIntentPurpose;
  status: 'draft' | 'pending';
  payload: OutboxPayload;
  payloadHash: string;
  adapterRetryToken: string;
  replyMessageId?: string | null;
  contextRevision?: number | null;
  policyRevision?: string | null;
  sourceRunId?: string | null;
  createdBy?: string | null;
  maxAttempts?: number;
  /** Earliest dispatch time (auto-reply delay, scheduled window). Defaults to now. */
  notBeforeMs?: number;
  nowMs?: number;
}

export interface MaterializeContext {
  intent: OutboxIntentRecord;
  attempt: OutboxAttemptRecord;
  nativeMessageId: string | null;
  remoteTimestampMs: number | null;
}

/** Runs INSIDE the commit transaction on first acceptance; returns the canonical message ID (or null). */
export type OutboxMaterializer = (ctx: MaterializeContext) => string | null;

export interface AttemptOutcomeInput {
  attemptId: string;
  outcome: OutboxAttemptOutcome;
  receiptLevel?: CareReceiptLevel;
  nativeMessageId?: string | null;
  remoteTimestampMs?: number | null;
  errorCode?: string | null;
  error?: string | null;
  retryAtMs?: number | null;
  nowMs?: number;
  materialize?: OutboxMaterializer;
}

export interface AttemptOutcomeResult {
  applied: boolean;
  /** Why nothing (or only part) was applied. */
  note: string | null;
  intent: OutboxIntentRecord;
  attempt: OutboxAttemptRecord;
}

export type ReleaseTarget = 'pending' | 'needs_review' | 'cancelled';

export interface CancelResult {
  cancelled: boolean;
  status: OutboxStatus;
  /** Honest hint for the UI: a request that already left is never promised as recalled. */
  hint: 'cancelled' | 'request_underway' | 'uncertain' | 'sent' | 'not_cancellable';
  intent: OutboxIntentRecord;
}

const RECEIPT_RANK: Record<CareReceiptLevel, number> = { accepted: 1, delivered: 2, read: 3 };
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_ERROR_CHARS = 1000;

export function receiptRank(level: CareReceiptLevel | null | undefined): number {
  return level ? RECEIPT_RANK[level] : 0;
}

/** Normalises a free-form reason into an event-safe machine code. */
export function toReasonCode(reason: string | null | undefined, fallback = 'UNSPECIFIED'): string {
  const cleaned = String(reason ?? '')
    .replace(/[^A-Za-z0-9_.:-]+/g, '_')
    .slice(0, 64);
  return ERROR_CODE.test(cleaned) ? cleaned : fallback;
}

/** Deterministic, key-sorted JSON (used for the payload hash). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// ── Schema ───────────────────────────────────────────────────────────────────────────────────

const STATUS_SQL = OUTBOX_STATUSES.map((s) => `'${s}'`).join(',');

/** Additive and idempotent; called from createCareSchema inside its IMMEDIATE transaction on every boot. */
export function ensureOutboxSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS care_delivery_intents (
      id                  TEXT PRIMARY KEY,
      account_id          TEXT NOT NULL REFERENCES care_accounts(id) ON DELETE CASCADE,
      conversation_id     TEXT REFERENCES care_conversations(id) ON DELETE SET NULL,
      client_request_id   TEXT NOT NULL,
      actor               TEXT NOT NULL CHECK (actor IN ('manual','approved','auto')),
      purpose             TEXT NOT NULL CHECK (purpose IN ('care','campaign')),
      status              TEXT NOT NULL CHECK (status IN (${STATUS_SQL})),
      status_reason       TEXT,
      channel             TEXT NOT NULL CHECK (channel IN ('zalo','telegram','email')),
      payload_enc         TEXT NOT NULL,
      payload_hash        TEXT NOT NULL,
      payload_revision    INTEGER NOT NULL DEFAULT 1 CHECK (payload_revision >= 1),
      approved_revision   INTEGER,
      context_revision    INTEGER,
      policy_revision     TEXT,
      reply_message_id    TEXT,
      adapter_retry_token TEXT NOT NULL,
      source_run_id       TEXT,
      created_by_enc      TEXT,
      approved_by_enc     TEXT,
      queue_seq           INTEGER,
      attempt_count       INTEGER NOT NULL DEFAULT 0,
      max_attempts        INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
      next_attempt_at     INTEGER NOT NULL DEFAULT 0,
      owner_epoch         INTEGER NOT NULL CHECK (owner_epoch >= 1),
      lease_owner         TEXT,
      lease_expires_at    INTEGER,
      claim_token         TEXT,
      claim_generation    INTEGER NOT NULL DEFAULT 0,
      last_claim_seq      INTEGER NOT NULL DEFAULT 0,
      receipt_level       TEXT CHECK (receipt_level IS NULL OR receipt_level IN ('accepted','delivered','read')),
      canonical_message_id TEXT,
      last_error_code     TEXT,
      last_error_enc      TEXT,
      transition_seq      INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      sent_at             INTEGER,
      UNIQUE(account_id, client_request_id)
    );

    -- One delivery lane per account, enforced by the database for every handle and process.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_care_delivery_one_sending
      ON care_delivery_intents(account_id) WHERE status = 'sending';
    -- A native retry token belongs to exactly one intent of an account.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_care_delivery_token
      ON care_delivery_intents(account_id, adapter_retry_token);
    CREATE INDEX IF NOT EXISTS idx_care_delivery_due
      ON care_delivery_intents(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_care_delivery_conversation
      ON care_delivery_intents(conversation_id, queue_seq) WHERE conversation_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_care_delivery_account_status
      ON care_delivery_intents(account_id, status, queue_seq);

    CREATE TABLE IF NOT EXISTS care_delivery_attempts (
      id                TEXT PRIMARY KEY,
      intent_id         TEXT NOT NULL REFERENCES care_delivery_intents(id) ON DELETE CASCADE,
      account_id        TEXT NOT NULL REFERENCES care_accounts(id) ON DELETE CASCADE,
      attempt_no        INTEGER NOT NULL CHECK (attempt_no >= 1),
      request_token     TEXT NOT NULL,
      owner_epoch       INTEGER NOT NULL CHECK (owner_epoch >= 1),
      claim_token       TEXT,
      worker_id         TEXT,
      outcome           TEXT CHECK (outcome IS NULL OR outcome IN ('accepted','uncertain','retryable','terminal','review')),
      receipt_level     TEXT CHECK (receipt_level IS NULL OR receipt_level IN ('accepted','delivered','read')),
      native_message_id TEXT,
      remote_timestamp  INTEGER,
      error_code        TEXT,
      error_enc         TEXT,
      started_at        INTEGER NOT NULL,
      finished_at       INTEGER,
      UNIQUE(intent_id, attempt_no)
    );

    CREATE INDEX IF NOT EXISTS idx_care_delivery_attempts_intent
      ON care_delivery_attempts(intent_id, attempt_no);
    CREATE INDEX IF NOT EXISTS idx_care_delivery_attempts_native
      ON care_delivery_attempts(account_id, native_message_id) WHERE native_message_id IS NOT NULL;
  `);
}

// Account gate for sending (same shape as the outbox_dispatch job gate).
const SEND_GATE_SQL = `a.write_owner = 'core' AND a.desired_state = 'active' AND a.send_enabled = 1`;
const OPEN_STATUSES_BLOCKING_ORDER = `'pending','retry_wait','sending','uncertain'`;

function err(code: ConstructorParameters<typeof CareError>[0], message: string, status = 409, details?: unknown): never {
  throw new CareError(code, message, status, details);
}

// ── Store ────────────────────────────────────────────────────────────────────────────────────

export class CareOutboxStore {
  private readonly events: CareEventStore;

  constructor(
    private readonly db: Database.Database,
    private readonly key?: CareKeyInput,
  ) {
    this.events = new CareEventStore(db, key);
  }

  /** HMAC of the canonical immutable payload; keyed so a short body cannot be dictionary-tested from the DB. */
  hashPayload(value: unknown): string {
    return crypto.createHmac('sha256', resolveEncryptionKey(this.key)).update(canonicalJson(value)).digest('hex');
  }

  // ── reads ──────────────────────────────────────────────────────────────────────────────────

  getIntent(id: string): OutboxIntentRecord | null {
    const row = this.db.prepare('SELECT * FROM care_delivery_intents WHERE id = ?').get(id) as any;
    return row ? this.mapIntent(row) : null;
  }

  getIntentByRequest(accountId: string, clientRequestId: string): OutboxIntentRecord | null {
    const row = this.db
      .prepare('SELECT * FROM care_delivery_intents WHERE account_id = ? AND client_request_id = ?')
      .get(accountId, clientRequestId) as any;
    return row ? this.mapIntent(row) : null;
  }

  listIntents(filter: { accountId?: string; conversationId?: string; statuses?: OutboxStatus[]; limit?: number } = {}): OutboxIntentRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.accountId) {
      where.push('account_id = ?');
      params.push(filter.accountId);
    }
    if (filter.conversationId) {
      where.push('conversation_id = ?');
      params.push(filter.conversationId);
    }
    if (filter.statuses) {
      if (filter.statuses.length === 0) return [];
      for (const s of filter.statuses) oneOf(OUTBOX_STATUSES, s, 'status');
      where.push(`status IN (${filter.statuses.map(() => '?').join(',')})`);
      params.push(...filter.statuses);
    }
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 100) || 1, 1), 500);
    const rows = this.db
      .prepare(
        `SELECT * FROM care_delivery_intents ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit) as any[];
    return rows.map((r) => this.mapIntent(r));
  }

  getAttempt(id: string): OutboxAttemptRecord | null {
    const row = this.db.prepare('SELECT * FROM care_delivery_attempts WHERE id = ?').get(id) as any;
    return row ? this.mapAttempt(row) : null;
  }

  listAttempts(intentId: string): OutboxAttemptRecord[] {
    return (this.db.prepare('SELECT * FROM care_delivery_attempts WHERE intent_id = ? ORDER BY attempt_no ASC').all(intentId) as any[]).map((r) =>
      this.mapAttempt(r),
    );
  }

  getOpenAttempt(intentId: string): OutboxAttemptRecord | null {
    const row = this.db
      .prepare('SELECT * FROM care_delivery_attempts WHERE intent_id = ? AND outcome IS NULL ORDER BY attempt_no DESC LIMIT 1')
      .get(intentId) as any;
    return row ? this.mapAttempt(row) : null;
  }

  // ── intent creation / draft lifecycle ──────────────────────────────────────────────────────

  /**
   * Idempotent per (account, clientRequestId): the same key with the same payload hash returns the
   * first intent (`created: false`); a different hash is a 409. The queue position and the owner
   * epoch snapshot are assigned when the intent becomes `pending`.
   */
  insertIntent(input: OutboxInsertInput): { intent: OutboxIntentRecord; created: boolean } {
    const run = this.db.transaction(() => {
      const account = requireAccountRow(this.db, input.accountId);
      const clientRequestId = requireNonEmptyString(input.clientRequestId, 'clientRequestId', 256);
      if (input.conversationId) requireConversationOfAccount(this.db, input.conversationId, input.accountId);
      oneOf(CARE_CHANNELS, input.payload?.channel, 'channel');
      if (input.payload.channel !== account.channel) {
        err('INVALID_TARGET', `Payload channel '${input.payload.channel}' does not match account channel '${account.channel}'`, 400);
      }
      requireNonEmptyString(input.adapterRetryToken, 'adapterRetryToken', 128);

      const existing = this.db
        .prepare('SELECT * FROM care_delivery_intents WHERE account_id = ? AND client_request_id = ?')
        .get(input.accountId, clientRequestId) as any;
      if (existing) {
        if (existing.payload_hash !== input.payloadHash) {
          err(
            'DUPLICATE_REQUEST_PAYLOAD_MISMATCH',
            `clientRequestId '${clientRequestId}' already exists with a different payload`,
            409,
          );
        }
        return { intent: this.mapIntent(existing), created: false };
      }

      const now = input.nowMs ?? Date.now();
      const id = crypto.randomUUID();
      const pending = input.status === 'pending';
      this.db
        .prepare(
          `INSERT INTO care_delivery_intents (
             id, account_id, conversation_id, client_request_id, actor, purpose, status, channel,
             payload_enc, payload_hash, payload_revision, approved_revision, context_revision, policy_revision,
             reply_message_id, adapter_retry_token, source_run_id, created_by_enc, queue_seq, max_attempts,
             next_attempt_at, owner_epoch, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.accountId,
          input.conversationId,
          clientRequestId,
          input.actor,
          input.purpose,
          input.status,
          input.payload.channel,
          encryptCareJson(input.payload, this.key),
          input.payloadHash,
          pending ? 1 : null,
          input.contextRevision ?? null,
          input.policyRevision ?? null,
          input.replyMessageId ?? null,
          input.adapterRetryToken,
          input.sourceRunId ?? null,
          encryptNullable(input.createdBy ?? null, this.key),
          pending ? this.nextQueueSeq() : null,
          input.maxAttempts ?? 5,
          input.notBeforeMs ?? now,
          account.ownerEpoch,
          now,
          now,
        );
      this.emit(id, pending ? 'outbox.enqueued' : 'outbox.draft_created', { outcome: input.status });
      return { intent: this.getIntent(id)!, created: true };
    });
    return run.immediate();
  }

  /**
   * Edit: bumps the payload revision, drops any approval and returns the intent to `draft`.
   * Allowed for a draft, and for a pending/needs_review intent that never reached a provider (no
   * attempt row). Anything that was attempted keeps its payload and token (a changed body under the
   * same token would be a different message).
   */
  updatePayload(
    id: string,
    input: {
      expectedRevision: number;
      payload: OutboxPayload;
      payloadHash: string;
      contextRevision?: number | null;
      policyRevision?: string | null;
      nowMs?: number;
    },
  ): OutboxIntentRecord {
    const run = this.db.transaction(() => {
      const row = this.requireRow(id);
      if (input.expectedRevision !== row.payload_revision) {
        err('STALE_REVISION', `Draft revision is ${row.payload_revision}, edit was based on ${input.expectedRevision}`, 409, {
          currentRevision: row.payload_revision,
        });
      }
      const editable = row.status === 'draft' || ((row.status === 'pending' || row.status === 'needs_review') && row.attempt_count === 0);
      if (!editable) err('CONFIGURATION_CONFLICT', `Intent in status '${row.status}' can no longer be edited`, 409);
      if (row.channel !== input.payload.channel) err('INVALID_TARGET', 'Channel of an intent is immutable', 400);

      const now = input.nowMs ?? Date.now();
      this.db
        .prepare(
          `UPDATE care_delivery_intents SET
             status = 'draft', status_reason = NULL, payload_enc = ?, payload_hash = ?,
             payload_revision = payload_revision + 1, approved_revision = NULL, approved_by_enc = NULL, queue_seq = NULL,
             context_revision = COALESCE(?, context_revision), policy_revision = COALESCE(?, policy_revision),
             updated_at = ?
           WHERE id = ?`,
        )
        .run(
          encryptCareJson(input.payload, this.key),
          input.payloadHash,
          input.contextRevision ?? null,
          input.policyRevision ?? null,
          now,
          id,
        );
      this.emit(id, 'outbox.edited', { outcome: 'draft' });
      return this.getIntent(id)!;
    });
    return run.immediate();
  }

  /**
   * Approve exactly the reviewed revision. A stale revision (the draft was edited since review) or a
   * changed context is a 409 that requires re-review; it never sends the older or newer text silently.
   * Repeating an approval of the same revision is idempotent.
   */
  approve(
    id: string,
    input: { expectedRevision: number; approvedBy?: string | null; currentContextRevision?: number | null; nowMs?: number },
  ): OutboxIntentRecord {
    const run = this.db.transaction(() => {
      const row = this.requireRow(id);
      if (row.status !== 'draft') {
        if (row.approved_revision !== null && row.approved_revision === input.expectedRevision && row.status !== 'discarded') {
          return this.mapIntent(row);
        }
        err('CONFIGURATION_CONFLICT', `Intent in status '${row.status}' cannot be approved`, 409);
      }
      if (input.expectedRevision !== row.payload_revision) {
        err('STALE_REVISION', `Draft revision is ${row.payload_revision}, review was of ${input.expectedRevision}`, 409, {
          currentRevision: row.payload_revision,
        });
      }
      if (
        row.context_revision !== null &&
        input.currentContextRevision !== undefined &&
        input.currentContextRevision !== null &&
        input.currentContextRevision !== row.context_revision
      ) {
        err('STALE_REVISION', 'Conversation context changed since the draft was written; re-review required', 409, {
          currentRevision: row.payload_revision,
        });
      }
      const account = requireAccountRow(this.db, row.account_id);
      const now = input.nowMs ?? Date.now();
      this.db
        .prepare(
          `UPDATE care_delivery_intents SET
             status = 'pending', status_reason = NULL, approved_revision = payload_revision, approved_by_enc = ?,
             actor = CASE WHEN actor = 'manual' THEN 'manual' ELSE 'approved' END,
             queue_seq = ?, next_attempt_at = ?, owner_epoch = ?, updated_at = ?
           WHERE id = ? AND status = 'draft'`,
        )
        .run(encryptNullable(input.approvedBy ?? null, this.key), this.nextQueueSeq(), now, account.ownerEpoch, now, id);
      this.emit(id, 'outbox.approved', { outcome: 'pending' });
      return this.getIntent(id)!;
    });
    return run.immediate();
  }

  discard(id: string, nowMs?: number): OutboxIntentRecord {
    const run = this.db.transaction(() => {
      const row = this.requireRow(id);
      if (row.status === 'discarded') return this.mapIntent(row);
      if (row.status !== 'draft' && row.status !== 'needs_review') {
        err('CONFIGURATION_CONFLICT', `Intent in status '${row.status}' cannot be discarded`, 409);
      }
      this.db
        .prepare(`UPDATE care_delivery_intents SET status = 'discarded', queue_seq = NULL, updated_at = ? WHERE id = ?`)
        .run(nowMs ?? Date.now(), id);
      this.emit(id, 'outbox.discarded', { outcome: 'discarded' });
      return this.getIntent(id)!;
    });
    return run.immediate();
  }

  /**
   * Cancels only what has not gone out: pending, retry_wait, or claimed-but-no-attempt-yet. Once an
   * attempt row exists the request may be underway, so the answer is a hint, never a recall promise.
   */
  cancel(id: string, nowMs?: number): CancelResult {
    const run = this.db.transaction((): CancelResult => {
      const row = this.requireRow(id);
      const now = nowMs ?? Date.now();
      if (row.status === 'cancelled') return { cancelled: true, status: 'cancelled', hint: 'cancelled', intent: this.mapIntent(row) };
      const cancellable =
        row.status === 'pending' ||
        row.status === 'retry_wait' ||
        (row.status === 'sending' && !this.hasOpenAttempt(id));
      if (!cancellable) {
        const hint =
          row.status === 'sending'
            ? 'request_underway'
            : row.status === 'uncertain'
              ? 'uncertain'
              : row.status === 'sent'
                ? 'sent'
                : 'not_cancellable';
        return { cancelled: false, status: row.status, hint, intent: this.mapIntent(row) };
      }
      this.db
        .prepare(
          `UPDATE care_delivery_intents SET status = 'cancelled', status_reason = 'CANCELLED', queue_seq = NULL,
             lease_owner = NULL, lease_expires_at = NULL, claim_token = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(now, id);
      this.emit(id, 'outbox.cancelled', { outcome: 'cancelled', errorCode: 'CANCELLED' });
      return { cancelled: true, status: 'cancelled', hint: 'cancelled', intent: this.getIntent(id)! };
    });
    return run.immediate();
  }

  // ── claim / lease / attempt ────────────────────────────────────────────────────────────────

  /**
   * Claims at most ONE due intent per account (one delivery lane), oldest-served account first so a
   * busy account cannot starve the others. Order inside a conversation is preserved: an intent waits
   * while an earlier one of the same conversation is still pending / retrying / sending / uncertain.
   * Stale-epoch intents are never claimed. Housekeeping (due retries -> pending, expired leases ->
   * uncertain / pending) runs in the same transaction so a dead lane heals before it is scheduled.
   */
  claimDue(opts: {
    workerId: string;
    leaseDurationMs: number;
    limit?: number;
    accountIds?: string[];
    /** Optional per-account epoch the caller believes it holds; a mismatch skips that account. */
    expectedEpochs?: Record<string, number>;
    nowMs?: number;
  }): OutboxClaim[] {
    const workerId = requireNonEmptyString(opts.workerId, 'workerId', 256);
    requireSafeInteger(opts.leaseDurationMs, 'leaseDurationMs', 1);
    if (opts.accountIds !== undefined && opts.accountIds.length === 0) return [];
    const now = opts.nowMs ?? Date.now();
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 5) || 1, 1), 100);

    const run = this.db.transaction((): OutboxClaim[] => {
      this.promoteDueRetriesTx(now);
      this.recoverExpiredTx(now, undefined);

      const params: unknown[] = [now];
      let scope = '';
      if (opts.accountIds) {
        scope = ` AND c.account_id IN (${opts.accountIds.map(() => '?').join(',')})`;
        params.push(...opts.accountIds);
      }
      const candidates = this.db
        .prepare(
          `SELECT c.id AS id, c.account_id AS account_id, a.owner_epoch AS epoch
           FROM care_delivery_intents c
           JOIN care_accounts a ON a.id = c.account_id
           WHERE c.status = 'pending' AND c.next_attempt_at <= ?
             AND c.owner_epoch = a.owner_epoch AND ${SEND_GATE_SQL}${scope}
             AND NOT EXISTS (SELECT 1 FROM care_delivery_intents s WHERE s.account_id = c.account_id AND s.status = 'sending')
             AND NOT EXISTS (
               SELECT 1 FROM care_delivery_intents o
               WHERE o.account_id = c.account_id AND o.id <> c.id AND c.conversation_id IS NOT NULL
                 AND o.conversation_id = c.conversation_id AND o.queue_seq < c.queue_seq
                 AND o.status IN (${OPEN_STATUSES_BLOCKING_ORDER}))
           ORDER BY (SELECT COALESCE(MAX(x.last_claim_seq), 0) FROM care_delivery_intents x WHERE x.account_id = c.account_id) ASC,
                    c.queue_seq ASC, c.id ASC`,
        )
        .all(...params) as Array<{ id: string; account_id: string; epoch: number }>;

      const claims: OutboxClaim[] = [];
      const seenAccounts = new Set<string>();
      const lease = now + opts.leaseDurationMs;
      for (const cand of candidates) {
        if (claims.length >= limit) break;
        if (seenAccounts.has(cand.account_id)) continue;
        seenAccounts.add(cand.account_id);
        const expected = opts.expectedEpochs?.[cand.account_id];
        if (expected !== undefined && expected !== Number(cand.epoch)) continue;

        const claimToken = crypto.randomUUID();
        const res = this.db
          .prepare(
            `UPDATE care_delivery_intents SET
               status = 'sending', status_reason = NULL, lease_owner = ?, lease_expires_at = ?, claim_token = ?,
               claim_generation = claim_generation + 1,
               last_claim_seq = (SELECT COALESCE(MAX(last_claim_seq), 0) + 1 FROM care_delivery_intents),
               updated_at = ?
             WHERE id = ? AND status = 'pending'`,
          )
          .run(workerId, lease, claimToken, now, cand.id);
        if (res.changes === 0) continue;
        const row = this.db.prepare('SELECT claim_generation FROM care_delivery_intents WHERE id = ?').get(cand.id) as {
          claim_generation: number;
        };
        claims.push({
          intentId: cand.id,
          accountId: cand.account_id,
          workerId,
          claimToken,
          claimGeneration: Number(row.claim_generation),
          ownerEpoch: Number(cand.epoch),
          leaseExpiresAtMs: lease,
        });
      }
      return claims;
    });
    return run.immediate();
  }

  /** Extends a valid lease (never shortens it). False once reclaimed / released / settled. */
  renewLease(claim: OutboxClaim, extendMs: number, nowMs?: number): boolean {
    requireSafeInteger(extendMs, 'extendMs', 1);
    const now = nowMs ?? Date.now();
    return (
      this.db
        .prepare(
          `UPDATE care_delivery_intents SET lease_expires_at = MAX(COALESCE(lease_expires_at, 0), ?), updated_at = ?
           WHERE id = ? AND status = 'sending' AND lease_owner = ? AND claim_token = ?`,
        )
        .run(now + extendMs, now, claim.intentId, claim.workerId, claim.claimToken).changes > 0
    );
  }

  /**
   * Persists the attempt (with the intent's retry token) BEFORE the provider is contacted. Fenced in
   * the same statement by lease validity, the account's current owner epoch and the send gates; null
   * means "do not call the provider". No open attempt may exist.
   */
  beginAttempt(claim: OutboxClaim, nowMs?: number): OutboxAttemptRecord | null {
    const now = nowMs ?? Date.now();
    const run = this.db.transaction((): OutboxAttemptRecord | null => {
      const res = this.db
        .prepare(
          `UPDATE care_delivery_intents SET attempt_count = attempt_count + 1, updated_at = ?
           WHERE id = ? AND status = 'sending' AND lease_owner = ? AND claim_token = ? AND lease_expires_at >= ?
             AND NOT EXISTS (SELECT 1 FROM care_delivery_attempts t WHERE t.intent_id = care_delivery_intents.id AND t.outcome IS NULL)
             AND EXISTS (
               SELECT 1 FROM care_accounts a
               WHERE a.id = care_delivery_intents.account_id AND a.owner_epoch = care_delivery_intents.owner_epoch AND ${SEND_GATE_SQL})`,
        )
        .run(now, claim.intentId, claim.workerId, claim.claimToken, now);
      if (res.changes === 0) return null;
      const row = this.requireRow(claim.intentId);
      const attemptId = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO care_delivery_attempts (id, intent_id, account_id, attempt_no, request_token, owner_epoch, claim_token, worker_id, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(attemptId, row.id, row.account_id, row.attempt_count, row.adapter_retry_token, row.owner_epoch, claim.claimToken, claim.workerId, now);
      return this.getAttempt(attemptId)!;
    });
    return run.immediate();
  }

  /**
   * Gives a claimed intent back WITHOUT an attempt (guard denial, closed gate, lost fence). Only
   * valid while no attempt exists for the claim: absence of an attempt row is proof that no RPC
   * started, because the row is written before the RPC.
   */
  releaseWithoutAttempt(
    claim: OutboxClaim,
    to: { status: ReleaseTarget; reason: string; nextAttemptAtMs?: number },
    nowMs?: number,
  ): boolean {
    const now = nowMs ?? Date.now();
    const reason = toReasonCode(to.reason);
    const run = this.db.transaction((): boolean => {
      const res = this.db
        .prepare(
          `UPDATE care_delivery_intents SET
             status = ?, status_reason = ?, next_attempt_at = ?, queue_seq = CASE WHEN ? = 'pending' THEN queue_seq ELSE NULL END,
             lease_owner = NULL, lease_expires_at = NULL, claim_token = NULL, updated_at = ?
           WHERE id = ? AND status = 'sending' AND claim_token = ?
             AND NOT EXISTS (SELECT 1 FROM care_delivery_attempts t WHERE t.intent_id = care_delivery_intents.id AND t.outcome IS NULL)`,
        )
        .run(to.status, reason, to.nextAttemptAtMs ?? now, to.status, now, claim.intentId, claim.claimToken);
      if (res.changes === 0) return false;
      this.emit(claim.intentId, to.status === 'pending' ? 'outbox.deferred' : `outbox.${to.status}`, {
        outcome: to.status,
        errorCode: reason,
      });
      return true;
    });
    return run.immediate();
  }

  // ── outcome (one transaction) ──────────────────────────────────────────────────────────────

  /**
   * Records what happened to an attempt: attempt outcome + intent state + canonical message
   * (`materialize`) + event, all in ONE transaction. Evidence of provider acceptance is applied to the
   * ORIGINAL attempt whatever the intent's lease or epoch says: a late receipt resolves it but never
   * grants permission to send more. Failure outcomes only move an intent that is still waiting on that
   * very attempt (sending / uncertain).
   */
  commitAttempt(input: AttemptOutcomeInput): AttemptOutcomeResult {
    const run = this.db.transaction((): AttemptOutcomeResult => {
      const now = input.nowMs ?? Date.now();
      const attemptRow = this.db.prepare('SELECT * FROM care_delivery_attempts WHERE id = ?').get(input.attemptId) as any;
      if (!attemptRow) err('NOT_FOUND', `Outbox attempt not found: ${input.attemptId}`, 404);
      const intentRow = this.requireRow(attemptRow.intent_id);
      const attempt = this.mapAttempt(attemptRow);
      const accepted = input.outcome === 'accepted';
      const level: CareReceiptLevel | null = accepted ? input.receiptLevel ?? 'accepted' : null;

      // An attempt that already settled can only have its receipt level raised.
      if (attempt.outcome !== null && attempt.outcome !== 'uncertain') {
        if (attempt.outcome === 'accepted' && accepted) return this.raiseReceiptTx(intentRow.id, attempt, level!, input, now);
        return { applied: false, note: 'ATTEMPT_ALREADY_SETTLED', intent: this.mapIntent(intentRow), attempt };
      }

      const errorCode = input.errorCode ? toReasonCode(input.errorCode) : null;
      const errorEnc = input.error ? encryptCareField(String(input.error).slice(0, MAX_ERROR_CHARS), this.key) : null;
      this.db
        .prepare(
          `UPDATE care_delivery_attempts SET outcome = ?, receipt_level = ?, native_message_id = COALESCE(?, native_message_id),
             remote_timestamp = COALESCE(?, remote_timestamp), error_code = ?, error_enc = ?, finished_at = ?
           WHERE id = ?`,
        )
        .run(
          input.outcome,
          level,
          input.nativeMessageId ?? null,
          input.remoteTimestampMs ?? null,
          errorCode,
          errorEnc,
          now,
          input.attemptId,
        );
      const settled = this.getAttempt(input.attemptId)!;
      const status = intentRow.status as OutboxStatus;
      const latest = Number(
        (this.db.prepare('SELECT MAX(attempt_no) AS n FROM care_delivery_attempts WHERE intent_id = ?').get(intentRow.id) as { n: number | null }).n ?? 0,
      );
      const isLatest = settled.attemptNo === latest;

      if (accepted) {
        if (status === 'sent') return this.raiseReceiptTx(intentRow.id, settled, level!, input, now, true);
        if (status === 'failed') {
          // The provider accepted something we recorded as terminally rejected: a human must look.
          this.setStatusTx(intentRow.id, 'needs_review', 'RECEIPT_AFTER_FAILURE', now);
          this.emit(intentRow.id, 'outbox.needs_review', { outcome: 'needs_review', errorCode: 'RECEIPT_AFTER_FAILURE' });
          return { applied: true, note: 'RECEIPT_AFTER_FAILURE', intent: this.getIntent(intentRow.id)!, attempt: settled };
        }
        if (status === 'cancelled' || status === 'discarded' || status === 'draft') {
          this.emit(intentRow.id, 'outbox.anomaly', { outcome: status, errorCode: 'RECEIPT_FOR_UNSENT_INTENT' });
          return { applied: false, note: 'RECEIPT_FOR_UNSENT_INTENT', intent: this.mapIntent(intentRow), attempt: settled };
        }
        const intent = this.mapIntent(intentRow);
        const canonicalId =
          intent.canonicalMessageId ??
          input.materialize?.({
            intent,
            attempt: settled,
            nativeMessageId: input.nativeMessageId ?? settled.nativeMessageId,
            remoteTimestampMs: input.remoteTimestampMs ?? settled.remoteTimestampMs,
          }) ??
          null;
        this.db
          .prepare(
            `UPDATE care_delivery_intents SET status = 'sent', status_reason = NULL, sent_at = COALESCE(sent_at, ?),
               receipt_level = ?, canonical_message_id = ?, last_error_code = NULL, last_error_enc = NULL, queue_seq = NULL,
               lease_owner = NULL, lease_expires_at = NULL, claim_token = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(input.remoteTimestampMs ?? now, level, canonicalId, now, intentRow.id);
        this.emit(intentRow.id, 'outbox.sent', {
          outcome: 'sent',
          receiptLevel: level ?? undefined,
          messageId: canonicalId ?? undefined,
          nativeMessageId: input.nativeMessageId ?? settled.nativeMessageId ?? undefined,
        });
        return { applied: true, note: null, intent: this.getIntent(intentRow.id)!, attempt: settled };
      }

      // Non-acceptance: only the attempt the intent is waiting on can move it.
      const waiting = (status === 'sending' || status === 'uncertain') && isLatest;
      if (!waiting) {
        return { applied: false, note: 'INTENT_NOT_WAITING_ON_ATTEMPT', intent: this.mapIntent(intentRow), attempt: settled };
      }
      switch (input.outcome) {
        case 'uncertain':
          if (status === 'sending') {
            this.setStatusTx(intentRow.id, 'uncertain', errorCode ?? 'UNCERTAIN', now, errorCode, errorEnc);
            this.emit(intentRow.id, 'outbox.uncertain', { outcome: 'uncertain', errorCode: errorCode ?? 'UNCERTAIN' });
          }
          break;
        case 'retryable': {
          if (intentRow.attempt_count >= intentRow.max_attempts) {
            this.setStatusTx(intentRow.id, 'failed', 'RETRIES_EXHAUSTED', now, errorCode, errorEnc);
            this.emit(intentRow.id, 'outbox.failed', { outcome: 'failed', errorCode: 'RETRIES_EXHAUSTED' });
          } else {
            this.setStatusTx(intentRow.id, 'retry_wait', errorCode ?? 'RETRYABLE', now, errorCode, errorEnc, input.retryAtMs ?? now);
            this.emit(intentRow.id, 'outbox.retry_wait', { outcome: 'retry_wait', errorCode: errorCode ?? 'RETRYABLE' });
          }
          break;
        }
        case 'terminal':
          this.setStatusTx(intentRow.id, 'failed', errorCode ?? 'TERMINAL', now, errorCode, errorEnc);
          this.emit(intentRow.id, 'outbox.failed', { outcome: 'failed', errorCode: errorCode ?? 'TERMINAL' });
          break;
        case 'review':
          this.setStatusTx(intentRow.id, 'needs_review', errorCode ?? 'REVIEW', now, errorCode, errorEnc);
          this.emit(intentRow.id, 'outbox.needs_review', { outcome: 'needs_review', errorCode: errorCode ?? 'REVIEW' });
          break;
      }
      return { applied: true, note: null, intent: this.getIntent(intentRow.id)!, attempt: settled };
    });
    return run.immediate();
  }

  /**
   * Fallback when the commit transaction itself failed AFTER the provider answered: keep the evidence
   * (native ID) and park the intent as `uncertain` so recovery reconciles it instead of re-sending.
   * Deliberately tiny and event-free so it can succeed where the full commit could not.
   */
  parkUncertain(attemptId: string, evidence: { nativeMessageId?: string | null; remoteTimestampMs?: number | null; reason: string }, nowMs?: number): boolean {
    const now = nowMs ?? Date.now();
    const reason = toReasonCode(evidence.reason, 'COMMIT_FAILED');
    const run = this.db.transaction((): boolean => {
      const a = this.db
        .prepare(
          `UPDATE care_delivery_attempts SET outcome = 'uncertain', native_message_id = COALESCE(?, native_message_id),
             remote_timestamp = COALESCE(?, remote_timestamp), error_code = ?, finished_at = ?
           WHERE id = ? AND outcome IS NULL`,
        )
        .run(evidence.nativeMessageId ?? null, evidence.remoteTimestampMs ?? null, reason, now, attemptId);
      if (a.changes === 0) return false;
      this.db
        .prepare(
          `UPDATE care_delivery_intents SET status = 'uncertain', status_reason = ?, last_error_code = ?,
             lease_owner = NULL, lease_expires_at = NULL, claim_token = NULL, updated_at = ?
           WHERE status = 'sending' AND id = (SELECT intent_id FROM care_delivery_attempts WHERE id = ?)`,
        )
        .run(reason, reason, now, attemptId);
      return true;
    });
    return run.immediate();
  }

  /**
   * Housekeeping for dead workers. Expired `sending` leases: an open attempt means the RPC may have
   * happened, so the intent becomes `uncertain` (never back to pending); no attempt row means no RPC
   * started, so the intent is released to pending. `ownWorkerId` treats that worker's own leases as
   * expired (a freshly restarted process holds nothing).
   */
  recoverInFlight(opts: { nowMs?: number; ownWorkerId?: string } = {}): { uncertain: number; released: number } {
    const now = opts.nowMs ?? Date.now();
    const run = this.db.transaction(() => this.recoverExpiredTx(now, opts.ownWorkerId));
    return run.immediate();
  }

  /** retry_wait -> pending once due. */
  promoteDueRetries(nowMs?: number): number {
    const now = nowMs ?? Date.now();
    return this.db.transaction(() => this.promoteDueRetriesTx(now)).immediate();
  }

  // ── uncertain / review resolution ──────────────────────────────────────────────────────────

  /** uncertain -> retry_wait (same token, connector dedupes) or needs_review (no guarantee). CAS on status. */
  resolveUncertain(id: string, to: { status: 'retry_wait' | 'needs_review'; reason: string; nextAttemptAtMs?: number }, nowMs?: number): boolean {
    const now = nowMs ?? Date.now();
    const reason = toReasonCode(to.reason);
    const run = this.db.transaction((): boolean => {
      const res = this.db
        .prepare(
          `UPDATE care_delivery_intents SET status = ?, status_reason = ?, next_attempt_at = ?, updated_at = ?
           WHERE id = ? AND status = 'uncertain'`,
        )
        .run(to.status, reason, to.nextAttemptAtMs ?? now, now, id);
      if (res.changes === 0) return false;
      this.emit(id, `outbox.${to.status}`, { outcome: to.status, errorCode: reason });
      return true;
    });
    return run.immediate();
  }

  /**
   * Explicit human decision on a needs_review intent. `resend` accepts that a duplicate is possible
   * (the operator took responsibility) and re-queues it with the SAME token and an extra attempt
   * allowance; `abandon` ends it as failed.
   */
  resolveReview(id: string, decision: 'resend' | 'abandon', nowMs?: number): OutboxIntentRecord {
    const now = nowMs ?? Date.now();
    const run = this.db.transaction(() => {
      const row = this.requireRow(id);
      if (row.status !== 'needs_review') err('CONFIGURATION_CONFLICT', `Intent in status '${row.status}' is not awaiting review`, 409);
      if (decision === 'resend') {
        this.db
          .prepare(
            `UPDATE care_delivery_intents SET status = 'pending', status_reason = 'REVIEW_RESEND', next_attempt_at = ?,
               max_attempts = MAX(max_attempts, attempt_count + 1), queue_seq = COALESCE(queue_seq, ?), updated_at = ?
             WHERE id = ?`,
          )
          .run(now, this.nextQueueSeq(), now, id);
        this.emit(id, 'outbox.review_resend', { outcome: 'pending', errorCode: 'REVIEW_RESEND' });
      } else {
        this.db
          .prepare(`UPDATE care_delivery_intents SET status = 'failed', status_reason = 'REVIEW_ABANDONED', queue_seq = NULL, updated_at = ? WHERE id = ?`)
          .run(now, id);
        this.emit(id, 'outbox.failed', { outcome: 'failed', errorCode: 'REVIEW_ABANDONED' });
      }
      return this.getIntent(id)!;
    });
    return run.immediate();
  }

  /**
   * Cutover housekeeping: pending / retry_wait intents whose epoch no longer matches the account can
   * never be claimed again; park them for review instead of leaving them silently stuck or sending
   * the backlog under a new owner. In-flight (sending / uncertain) ones are left to recovery.
   */
  supersedeStaleEpochIntents(accountId: string, nowMs?: number): number {
    const now = nowMs ?? Date.now();
    const run = this.db.transaction((): number => {
      const rows = this.db
        .prepare(
          `SELECT id FROM care_delivery_intents
           WHERE account_id = ? AND status IN ('pending','retry_wait')
             AND owner_epoch <> (SELECT owner_epoch FROM care_accounts WHERE id = ?)`,
        )
        .all(accountId, accountId) as Array<{ id: string }>;
      for (const { id } of rows) {
        this.setStatusTx(id, 'needs_review', 'SUPERSEDED_BY_EPOCH', now);
        this.emit(id, 'outbox.needs_review', { outcome: 'needs_review', errorCode: 'SUPERSEDED_BY_EPOCH' });
      }
      return rows.length;
    });
    return run.immediate();
  }

  /**
   * Locates the attempt a provider receipt / echo refers to. By (account, clientRequestId) the FIRST
   * attempt that is still unresolved wins (the original one), else the one with a matching native ID,
   * else the latest accepted one. By native ID alone, an exact match.
   */
  findAttemptForReceipt(ref: { accountId: string; clientRequestId?: string; nativeMessageId?: string }): OutboxAttemptRecord | null {
    if (ref.clientRequestId) {
      const intent = this.getIntentByRequest(ref.accountId, ref.clientRequestId);
      if (!intent) return null;
      const attempts = this.listAttempts(intent.id);
      if (attempts.length === 0) return null;
      if (ref.nativeMessageId) {
        const byNative = attempts.find((a) => a.nativeMessageId === ref.nativeMessageId);
        if (byNative) return byNative;
      }
      return (
        attempts.find((a) => a.outcome === null || a.outcome === 'uncertain') ??
        [...attempts].reverse().find((a) => a.outcome === 'accepted') ??
        null
      );
    }
    if (ref.nativeMessageId) {
      const row = this.db
        .prepare('SELECT * FROM care_delivery_attempts WHERE account_id = ? AND native_message_id = ? ORDER BY attempt_no ASC LIMIT 1')
        .get(ref.accountId, ref.nativeMessageId) as any;
      return row ? this.mapAttempt(row) : null;
    }
    return null;
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────

  private requireRow(id: string): any {
    const row = this.db.prepare('SELECT * FROM care_delivery_intents WHERE id = ?').get(id);
    if (!row) err('NOT_FOUND', `Outbox intent not found: ${id}`, 404);
    return row;
  }

  private hasOpenAttempt(intentId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM care_delivery_attempts WHERE intent_id = ? AND outcome IS NULL').get(intentId));
  }

  private nextQueueSeq(): number {
    return Number((this.db.prepare('SELECT COALESCE(MAX(queue_seq), 0) + 1 AS n FROM care_delivery_intents').get() as { n: number }).n);
  }

  private setStatusTx(
    id: string,
    status: OutboxStatus,
    reason: string,
    now: number,
    errorCode?: string | null,
    errorEnc?: string | null,
    nextAttemptAtMs?: number,
  ): void {
    const terminal = status === 'failed' || status === 'cancelled' || status === 'discarded' || status === 'sent';
    this.db
      .prepare(
        `UPDATE care_delivery_intents SET status = ?, status_reason = ?,
           last_error_code = COALESCE(?, last_error_code), last_error_enc = COALESCE(?, last_error_enc),
           next_attempt_at = COALESCE(?, next_attempt_at), queue_seq = CASE WHEN ? = 1 THEN NULL ELSE queue_seq END,
           lease_owner = NULL, lease_expires_at = NULL, claim_token = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, reason, errorCode ?? null, errorEnc ?? null, nextAttemptAtMs ?? null, terminal ? 1 : 0, now, id);
  }

  private raiseReceiptTx(
    intentId: string,
    attempt: OutboxAttemptRecord,
    level: CareReceiptLevel,
    input: AttemptOutcomeInput,
    now: number,
    attemptJustSettled = false,
  ): AttemptOutcomeResult {
    if (input.nativeMessageId) {
      this.db.prepare('UPDATE care_delivery_attempts SET native_message_id = COALESCE(native_message_id, ?) WHERE id = ?').run(input.nativeMessageId, attempt.id);
    }
    const raised = receiptRank(level) > receiptRank(attempt.receiptLevel);
    if (raised) {
      this.db.prepare('UPDATE care_delivery_attempts SET receipt_level = ? WHERE id = ?').run(level, attempt.id);
    }
    const intent = this.requireRow(intentId);
    const intentRaised = receiptRank(level) > receiptRank(intent.receipt_level);
    if (intentRaised) {
      this.db.prepare('UPDATE care_delivery_intents SET receipt_level = ?, updated_at = ? WHERE id = ?').run(level, now, intentId);
      this.emit(intentId, 'outbox.receipt', { outcome: String(intent.status), receiptLevel: level, nativeMessageId: input.nativeMessageId ?? undefined });
    }
    return {
      applied: raised || intentRaised || attemptJustSettled,
      note: raised || intentRaised ? null : 'RECEIPT_ALREADY_RECORDED',
      intent: this.getIntent(intentId)!,
      attempt: this.getAttempt(attempt.id)!,
    };
  }

  private promoteDueRetriesTx(now: number): number {
    return this.db
      .prepare(`UPDATE care_delivery_intents SET status = 'pending', updated_at = ? WHERE status = 'retry_wait' AND next_attempt_at <= ?`)
      .run(now, now).changes;
  }

  private recoverExpiredTx(now: number, ownWorkerId: string | undefined): { uncertain: number; released: number } {
    const rows = this.db
      .prepare(
        `SELECT id FROM care_delivery_intents
         WHERE status = 'sending' AND (lease_expires_at < ? OR (? IS NOT NULL AND lease_owner = ?))`,
      )
      .all(now, ownWorkerId ?? null, ownWorkerId ?? null) as Array<{ id: string }>;
    let uncertain = 0;
    let released = 0;
    for (const { id } of rows) {
      const open = this.getOpenAttempt(id);
      if (open) {
        this.db
          .prepare(`UPDATE care_delivery_attempts SET outcome = 'uncertain', error_code = 'LEASE_EXPIRED_IN_FLIGHT', finished_at = ? WHERE id = ? AND outcome IS NULL`)
          .run(now, open.id);
        this.setStatusTx(id, 'uncertain', 'LEASE_EXPIRED_IN_FLIGHT', now, 'LEASE_EXPIRED_IN_FLIGHT');
        this.emit(id, 'outbox.uncertain', { outcome: 'uncertain', errorCode: 'LEASE_EXPIRED_IN_FLIGHT' });
        uncertain += 1;
      } else {
        this.db
          .prepare(
            `UPDATE care_delivery_intents SET status = 'pending', status_reason = 'LEASE_EXPIRED_NO_ATTEMPT',
               lease_owner = NULL, lease_expires_at = NULL, claim_token = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(now, id);
        this.emit(id, 'outbox.deferred', { outcome: 'pending', errorCode: 'LEASE_EXPIRED_NO_ATTEMPT' });
        released += 1;
      }
    }
    return { uncertain, released };
  }

  /** Appends a scrubbed, ID-only ledger event for a transition (inside the caller's transaction). */
  private emit(
    intentId: string,
    eventType: string,
    extra: { outcome?: string; errorCode?: string; receiptLevel?: string; messageId?: string; nativeMessageId?: string },
  ): void {
    const row = this.db
      .prepare(
        `UPDATE care_delivery_intents SET transition_seq = transition_seq + 1 WHERE id = ?
         RETURNING account_id, conversation_id, client_request_id, owner_epoch, transition_seq, channel`,
      )
      .get(intentId) as
      | { account_id: string; conversation_id: string | null; client_request_id: string; owner_epoch: number; transition_seq: number; channel: string }
      | undefined;
    if (!row) return;
    this.events.appendEvent({
      eventId: `outbox:${intentId}:${row.transition_seq}`,
      accountId: row.account_id,
      conversationId: row.conversation_id,
      eventType,
      epoch: Number(row.owner_epoch),
      payload: {
        clientRequestId: row.client_request_id,
        kind: row.channel,
        outcome: extra.outcome,
        errorCode: extra.errorCode,
        receiptLevel: extra.receiptLevel,
        messageId: extra.messageId,
        nativeMessageId: extra.nativeMessageId,
      },
    });
  }

  private mapIntent(row: any): OutboxIntentRecord {
    return {
      id: row.id,
      accountId: row.account_id,
      conversationId: row.conversation_id,
      clientRequestId: row.client_request_id,
      actor: row.actor,
      purpose: row.purpose,
      status: row.status,
      statusReason: row.status_reason,
      channel: row.channel,
      payload: decryptCareJson<OutboxPayload>(row.payload_enc, this.key),
      payloadHash: row.payload_hash,
      payloadRevision: Number(row.payload_revision),
      approvedRevision: row.approved_revision === null ? null : Number(row.approved_revision),
      contextRevision: row.context_revision === null ? null : Number(row.context_revision),
      policyRevision: row.policy_revision ?? null,
      replyMessageId: row.reply_message_id,
      adapterRetryToken: row.adapter_retry_token,
      sourceRunId: row.source_run_id,
      createdBy: decryptNullable(row.created_by_enc, this.key),
      approvedBy: decryptNullable(row.approved_by_enc, this.key),
      queueSeq: row.queue_seq === null ? null : Number(row.queue_seq),
      attemptCount: Number(row.attempt_count),
      maxAttempts: Number(row.max_attempts),
      nextAttemptAtMs: Number(row.next_attempt_at),
      ownerEpoch: Number(row.owner_epoch),
      leaseOwner: row.lease_owner,
      leaseExpiresAtMs: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
      claimToken: row.claim_token,
      claimGeneration: Number(row.claim_generation),
      receiptLevel: row.receipt_level,
      canonicalMessageId: row.canonical_message_id,
      lastErrorCode: row.last_error_code,
      lastError: decryptNullable(row.last_error_enc, this.key),
      createdAtMs: Number(row.created_at),
      updatedAtMs: Number(row.updated_at),
      sentAtMs: row.sent_at === null ? null : Number(row.sent_at),
    };
  }

  private mapAttempt(row: any): OutboxAttemptRecord {
    return {
      id: row.id,
      intentId: row.intent_id,
      accountId: row.account_id,
      attemptNo: Number(row.attempt_no),
      requestToken: row.request_token,
      ownerEpoch: Number(row.owner_epoch),
      workerId: row.worker_id,
      outcome: row.outcome,
      receiptLevel: row.receipt_level,
      nativeMessageId: row.native_message_id,
      remoteTimestampMs: row.remote_timestamp === null ? null : Number(row.remote_timestamp),
      errorCode: row.error_code,
      error: decryptNullable(row.error_enc, this.key),
      startedAtMs: Number(row.started_at),
      finishedAtMs: row.finished_at === null ? null : Number(row.finished_at),
    };
  }
}
