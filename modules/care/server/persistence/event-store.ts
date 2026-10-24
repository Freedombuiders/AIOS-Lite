/**
 * Durable event ledger (key: account_id + event_id) and adapter-owned typed checkpoints.
 *
 * The ledger journal is read by SSE/consumers, so its payload is a strict ALLOWLIST of ID-like
 * scalars: message text, titles, subjects, error notes and arbitrary adapter fields never enter
 * it. Where a consumer genuinely needs the full detail, an encrypted `replay` payload can be
 * attached (replay_enc) instead.
 */

import type Database from 'better-sqlite3';
import { CareError } from '../../../_lib/care-kit/errors.js';
import { compareCausalOrder, isCausalOrderToken, isValidCheckpointBox, type CareCheckpoint } from '../../../_lib/care-kit/checkpoint.js';
import type { CareEventRecord } from '../../../_lib/care-kit/types.js';
import { requireNonEmptyString, requireSafeInteger } from '../../../_lib/care-kit/validation.js';
import { decryptCareJson, encryptCareJson, type CareKeyInput } from './crypto.js';
import { requireAccountRow, requireConversationOfAccount } from './shared.js';

const EVENT_PAYLOAD_ALLOWLIST = new Set([
  'messageId',
  'nativeMessageId',
  'nativeNamespace',
  'direction',
  'senderRole',
  'origin',
  'sentAtMs',
  'nativeVersion',
  'conversationId',
  'kind',
  'healthStatus',
  'errorCode',
  'outcome',
  'job',
  'checkpointOutcome',
  'clientRequestId',
  'receiptLevel',
  'readDirection',
  'remoteReadMessageId',
]);

const MAX_SCALAR_STRING = 256;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Drops every key outside the allowlist and every non-scalar / oversized / unsafe value. */
export function scrubEventPayload(payload: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (!EVENT_PAYLOAD_ALLOWLIST.has(key)) continue;
    if (value === null || typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'number') {
      if (Number.isFinite(value)) out[key] = value;
    } else if (typeof value === 'string') {
      if (value.length > MAX_SCALAR_STRING) continue;
      if (key === 'errorCode' && !ERROR_CODE_PATTERN.test(value)) continue;
      out[key] = value;
    }
  }
  return out;
}

export class CareEventStore {
  constructor(
    private readonly db: Database.Database,
    private readonly key?: CareKeyInput,
  ) {}

  /**
   * Appends a ledger row. A plain INSERT: callers must check `hasEvent` first inside the same
   * (immediate) transaction; a duplicate (account, event) surfaces as a constraint error and
   * rolls the surrounding effects back rather than being silently ignored.
   */
  appendEvent(event: {
    eventId: string;
    accountId: string;
    conversationId?: string | null;
    eventType: string;
    checkpoint?: { namespace: string; cursor: string } | null;
    epoch?: number;
    payload: Record<string, unknown>;
    replay?: Record<string, unknown>;
  }): CareEventRecord {
    const run = this.db.transaction(() => {
      requireAccountRow(this.db, event.accountId);
      const eventId = requireNonEmptyString(event.eventId, 'eventId', 256);
      const eventType = requireNonEmptyString(event.eventType, 'eventType', 64);
      const epoch = requireSafeInteger(event.epoch ?? 1, 'epoch', 1);
      if (event.conversationId) requireConversationOfAccount(this.db, event.conversationId, event.accountId);

      const info = this.db
        .prepare(
          `INSERT INTO care_events (
             event_id, account_id, conversation_id, event_type, checkpoint_namespace, checkpoint_cursor,
             epoch, payload_json, replay_enc, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          eventId,
          event.accountId,
          event.conversationId ?? null,
          eventType,
          event.checkpoint?.namespace ?? null,
          event.checkpoint?.cursor ?? null,
          epoch,
          JSON.stringify(scrubEventPayload(event.payload)),
          event.replay ? encryptCareJson(event.replay, this.key) : null,
          Date.now(),
        );
      return this.getEventBySeq(Number(info.lastInsertRowid))!;
    });
    return run();
  }

  hasEvent(accountId: string, eventId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM care_events WHERE account_id = ? AND event_id = ?').get(accountId, eventId));
  }

  getEvent(accountId: string, eventId: string): CareEventRecord | null {
    const row = this.db.prepare('SELECT * FROM care_events WHERE account_id = ? AND event_id = ?').get(accountId, eventId) as any;
    return row ? this.mapRow(row) : null;
  }

  getEventBySeq(seq: number): CareEventRecord | null {
    const row = this.db.prepare('SELECT * FROM care_events WHERE seq = ?').get(seq) as any;
    return row ? this.mapRow(row) : null;
  }

  listEventsSince(afterSeq = 0, limit = 100): CareEventRecord[] {
    const capped = Math.min(Math.max(Math.trunc(limit) || 1, 1), 1000);
    const rows = this.db
      .prepare('SELECT * FROM care_events WHERE seq > ? ORDER BY seq ASC LIMIT ?')
      .all(afterSeq, capped) as any[];
    return rows.map((r) => this.mapRow(r));
  }

  /** Decrypts the optional replay payload of a ledger row. */
  getReplay(accountId: string, eventId: string): Record<string, unknown> | null {
    const row = this.db
      .prepare('SELECT replay_enc FROM care_events WHERE account_id = ? AND event_id = ?')
      .get(accountId, eventId) as { replay_enc: string | null } | undefined;
    return row?.replay_enc ? decryptCareJson<Record<string, unknown>>(row.replay_enc, this.key) : null;
  }

  private mapRow(row: any): CareEventRecord {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = {};
    }
    return {
      seq: Number(row.seq),
      eventId: row.event_id,
      accountId: row.account_id,
      conversationId: row.conversation_id,
      eventType: row.event_type,
      checkpoint:
        row.checkpoint_namespace !== null && row.checkpoint_namespace !== undefined
          ? { namespace: row.checkpoint_namespace, cursor: row.checkpoint_cursor }
          : null,
      epoch: Number(row.epoch),
      payload,
      createdAtMs: Number(row.created_at),
    };
  }
}

export type CheckpointOutcome = 'inserted' | 'advanced' | 'unchanged' | 'regression_ignored';

export interface StoredCheckpoint {
  accountId: string;
  namespace: string;
  cursor: string;
  position: string | null;
  revision: number;
  updatedAtMs: number;
}

/**
 * Adapter-owned checkpoints. Core never orders an opaque cursor by itself:
 *  - `expectedCursor` given  -> compare-and-set against the stored cursor (null = box must be new);
 *    a mismatch is STALE_REVISION and aborts the surrounding ingest transaction;
 *  - else `position` given   -> monotonic: an older position is ignored (effects still apply),
 *    an equal one is a no-op, a newer one advances;
 *  - else                    -> only a first-ever checkpoint of a box may be written; replacing an
 *    existing cursor without ordering information is rejected.
 * Both given: CAS first, then the position must not regress. `expectedRevision` is an
 * additional/alternative CAS on the stored revision counter (0 = box must be new); it counts as
 * an adapter-owned expectation just like `expectedCursor`.
 */
export class CareCheckpointStore {
  constructor(private readonly db: Database.Database) {}

  get(accountId: string, namespace: string): StoredCheckpoint | null {
    const row = this.db
      .prepare('SELECT * FROM care_sync_state WHERE account_id = ? AND cursor_namespace = ?')
      .get(accountId, namespace) as any;
    return row
      ? {
          accountId: row.account_id,
          namespace: row.cursor_namespace,
          cursor: row.opaque_cursor,
          position: row.position ?? null,
          revision: Number(row.revision),
          updatedAtMs: Number(row.updated_at),
        }
      : null;
  }

  advance(accountId: string, checkpoint: CareCheckpoint, nowMs?: number): CheckpointOutcome {
    const run = this.db.transaction(() => {
      const account = requireAccountRow(this.db, accountId);
      if (!checkpoint || typeof checkpoint !== 'object') {
        throw new CareError('INVALID_CURSOR', 'Checkpoint must be a typed { namespace, cursor } object', 400);
      }
      if (!isValidCheckpointBox(account.channel, checkpoint.namespace)) {
        throw new CareError(
          'INVALID_CURSOR',
          `Checkpoint box '${String(checkpoint.namespace)}' is not valid for channel '${account.channel}'`,
          400,
        );
      }
      const cursor = requireNonEmptyString(checkpoint.cursor, 'checkpoint cursor', 2048);
      const hasPosition = checkpoint.position !== undefined && checkpoint.position !== null;
      if (hasPosition && !isCausalOrderToken(checkpoint.position)) {
        throw new CareError('INVALID_CURSOR', 'Checkpoint position must be digits or dotted digits', 400);
      }
      const position = hasPosition ? (checkpoint.position as string) : null;
      const hasExpectedRevision = checkpoint.expectedRevision !== undefined;
      if (hasExpectedRevision) requireSafeInteger(checkpoint.expectedRevision, 'expectedRevision', 0);
      const hasExpected = checkpoint.expectedCursor !== undefined || hasExpectedRevision;

      const current = this.get(accountId, checkpoint.namespace);
      const now = nowMs ?? Date.now();

      if (hasExpectedRevision && (current?.revision ?? 0) !== checkpoint.expectedRevision) {
        throw new CareError(
          'STALE_REVISION',
          `Checkpoint '${checkpoint.namespace}' revision mismatch (expected ${checkpoint.expectedRevision})`,
          409,
        );
      }

      if (checkpoint.expectedCursor !== undefined && (current?.cursor ?? null) !== checkpoint.expectedCursor) {
        throw new CareError(
          'STALE_REVISION',
          `Checkpoint '${checkpoint.namespace}' expectation mismatch (stored cursor differs from expectedCursor)`,
          409,
        );
      }

      if (!current) {
        this.db
          .prepare(
            `INSERT INTO care_sync_state (account_id, cursor_namespace, opaque_cursor, position, revision, updated_at)
             VALUES (?, ?, ?, ?, 1, ?)`,
          )
          .run(accountId, checkpoint.namespace, cursor, position, now);
        return 'inserted' as const;
      }

      let outcome: CheckpointOutcome;
      if (hasPosition && current.position !== null) {
        const cmp = compareCausalOrder(position, current.position);
        if (cmp === null) {
          throw new CareError('INVALID_CURSOR', 'Checkpoint positions are not comparable', 400);
        }
        if (cmp < 0) {
          if (hasExpected) {
            throw new CareError('INVALID_CURSOR', 'Checkpoint position regresses despite a matching expectedCursor', 409);
          }
          return 'regression_ignored' as const;
        }
        if (cmp === 0 && cursor !== current.cursor && !hasExpected) {
          // Two different opaque states at the SAME causal position cannot be ordered by core.
          throw new CareError(
            'INVALID_CURSOR',
            `Checkpoint '${checkpoint.namespace}' already holds a different state at position ${current.position}; supply expectedCursor to replace it`,
            409,
          );
        }
        outcome = cmp === 0 && cursor === current.cursor ? 'unchanged' : 'advanced';
      } else if (hasExpected) {
        outcome = cursor === current.cursor && position === current.position ? 'unchanged' : 'advanced';
      } else if (hasPosition && current.position === null) {
        // First positioned write for a box that only had an unordered cursor: nothing to compare against.
        throw new CareError(
          'INVALID_CURSOR',
          `Checkpoint '${checkpoint.namespace}' has no stored position; supply expectedCursor to replace it`,
          400,
        );
      } else {
        throw new CareError(
          'INVALID_CURSOR',
          `Checkpoint '${checkpoint.namespace}' already exists; replacing it needs expectedCursor or a causal position`,
          400,
        );
      }

      if (outcome === 'unchanged') return outcome;
      this.db
        .prepare(
          `UPDATE care_sync_state
           SET opaque_cursor = ?, position = ?, revision = revision + 1, updated_at = ?
           WHERE account_id = ? AND cursor_namespace = ?`,
        )
        .run(cursor, position, now, accountId, checkpoint.namespace);
      return outcome;
    });
    return run.immediate();
  }
}
