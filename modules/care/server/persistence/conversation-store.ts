/**
 * Conversation store + causal projection.
 *
 * The projection (thread pointer, waiting SLA, remote unread) is DERIVED from the message set
 * by `recomputeProjection`, never accumulated from arrival order, so late/out-of-order/edited/
 * deleted messages, history and recovery all converge to the same state.
 *
 * "Before/after" between two messages never uses the random local ID. In order of authority:
 *   1. native order keys, when both messages share a namespace and both have one;
 *   2. explicit reply linkage (a reply quoting / In-Reply-To the question answers it);
 *   3. strictly different timestamps.
 * Equal timestamps with none of the above are UNORDERED and resolve conservatively (a reply does
 * not answer, a watermark does not cover).
 *
 *  - pointer      newest non-deleted message by (sent_at, local id): display order only
 *  - waiting      oldest live-observed, relevant customer inbound with no answering operator/agent/
 *                 self outbound. Relevant = direct/email thread, or (group/topic) explicitly
 *                 directed at this account. History/recovery-only sightings never start waiting.
 *  - remote unread live-observed customer inbound NOT covered by the provider's read watermark
 *                 (watermark kept in native coordinates, forward-only)
 *  - local seen   dashboard-only marker; provider receipts never write it
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { CareError } from '../../../_lib/care-kit/errors.js';
import type { CareConversationKind, CareConversationRecord, CareReadDirection } from '../../../_lib/care-kit/types.js';
import {
  CARE_CONVERSATION_KINDS,
  oneOf,
  requireConversationKindForChannel,
  requireSafeInteger,
} from '../../../_lib/care-kit/validation.js';
import { decryptNullable, encryptCareField, type CareKeyInput } from './crypto.js';
import { requireAccountRow, requireCustomerExists } from './shared.js';

/** Coordinates of a provider read/receipt watermark. Native key first, timestamp as fallback. */
export interface WatermarkTarget {
  namespace: string;
  /** Fixed-width native order key, when the provider gives this message an order. */
  orderKey: string | null;
  /** Timestamp of the held target message; null when the target is not held (ordered boxes only). */
  sentAtMs: number | null;
  /** Local message row, when held. */
  messageId: string | null;
}

export interface PendingReceipt {
  accountId: string;
  eventId: string;
  externalConversationKey: string;
  namespace: string | null;
  nativeMessageId: string;
  direction: CareReadDirection;
}

/** Lifecycle labels the bridge/projector write via `setStatus`; the column itself accepts any short label. */
export const CONVERSATION_STATUSES = ['active', 'source_deleted'] as const;
export type CareConversationStatus = (typeof CONVERSATION_STATUSES)[number];

function requireNonEmptyStringLocal(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw new CareError('INVALID_COMMAND', 'status must be a short non-empty string', 400);
  }
}

export class CareConversationStore {
  constructor(
    private readonly db: Database.Database,
    private readonly key?: CareKeyInput,
  ) {}

  /**
   * Creates the conversation or, when (account, externalKey) already exists, refreshes title/kind.
   * Kind must be valid for the account's channel (an email account only has email threads).
   */
  upsertConversation(input: {
    id?: string;
    accountId: string;
    externalKey: string;
    kind: CareConversationKind;
    title: string;
    primaryCustomerId?: string | null;
  }): CareConversationRecord {
    const run = this.db.transaction(() => {
      const account = requireAccountRow(this.db, input.accountId);
      if (typeof input.externalKey !== 'string' || input.externalKey.length === 0 || input.externalKey.length > 1024) {
        throw new CareError('INVALID_COMMAND', 'externalKey must be a non-empty string', 400);
      }
      const kind = requireConversationKindForChannel(account.channel, input.kind);
      const title = typeof input.title === 'string' ? input.title : '';

      const existing = this.getConversationByExternalKey(input.accountId, input.externalKey);
      if (existing) {
        if (existing.title !== title || existing.kind !== kind) {
          this.db
            .prepare('UPDATE care_conversations SET title_enc = ?, kind = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
            .run(encryptCareField(title, this.key), kind, Date.now(), existing.id);
          this.recomputeProjection(existing.id);
        }
        return this.getConversation(existing.id)!;
      }

      if (input.primaryCustomerId) requireCustomerExists(this.db, input.primaryCustomerId);
      const id = input.id ?? crypto.randomUUID();
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO care_conversations (
             id, account_id, external_key, kind, title_enc, primary_customer_id,
             status, is_paused, is_opted_out, remote_unread_count, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', 0, 0, 0, 1, ?, ?)`,
        )
        .run(id, input.accountId, input.externalKey, kind, encryptCareField(title, this.key), input.primaryCustomerId ?? null, now, now);
      return this.getConversation(id)!;
    });
    return run();
  }

  /** Bridge only: lifecycle label ('active' | 'source_deleted'); revision bumps only on change. */
  setStatus(id: string, status: string): boolean {
    requireNonEmptyStringLocal(status);
    return (
      this.db
        .prepare('UPDATE care_conversations SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND status <> ?')
        .run(status, Date.now(), id, status).changes > 0
    );
  }

  setPrimaryCustomer(id: string, customerId: string | null): void {
    if (customerId) requireCustomerExists(this.db, customerId);
    this.db
      .prepare('UPDATE care_conversations SET primary_customer_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
      .run(customerId, Date.now(), id);
  }

  getConversation(id: string): CareConversationRecord | null {
    const row = this.db.prepare('SELECT * FROM care_conversations WHERE id = ?').get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  getConversationByExternalKey(accountId: string, externalKey: string): CareConversationRecord | null {
    const row = this.db
      .prepare('SELECT * FROM care_conversations WHERE account_id = ? AND external_key = ?')
      .get(accountId, externalKey) as any;
    return row ? this.mapRow(row) : null;
  }

  /** Keyset pagination on (last_message_at DESC, id DESC); the cursor is the last row of the previous page. */
  listConversations(
    opts: {
      accountId?: string;
      limit?: number;
      cursor?: { lastActivityAtMs: number; id: string };
    } = {},
  ): CareConversationRecord[] {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50) || 1, 1), 500);
    let sql = 'SELECT * FROM care_conversations';
    const params: any[] = [];
    const conditions: string[] = [];

    if (opts.accountId) {
      conditions.push('account_id = ?');
      params.push(opts.accountId);
    }
    if (opts.cursor) {
      conditions.push('(last_message_at < ? OR (last_message_at = ? AND id < ?))');
      params.push(opts.cursor.lastActivityAtMs, opts.cursor.lastActivityAtMs, opts.cursor.id);
    }
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY last_message_at DESC, id DESC LIMIT ?';
    params.push(limit);

    return (this.db.prepare(sql).all(...params) as any[]).map((r) => this.mapRow(r));
  }

  /**
   * Recomputes pointer/waiting/remote-unread from the message set. Idempotent: a no-op write
   * (and no revision bump) when nothing changed, so replays never churn revisions.
   */
  recomputeProjection(id: string): CareConversationRecord {
    const run = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM care_conversations WHERE id = ?').get(id) as any;
      if (!row) throw new CareError('NOT_FOUND', `Conversation not found: ${id}`, 404);

      const last = this.db
        .prepare(
          `SELECT id, sent_at FROM care_messages
           WHERE conversation_id = ? AND is_deleted = 0
           ORDER BY sent_at DESC, id DESC LIMIT 1`,
        )
        .get(id) as { id: string; sent_at: number } | undefined;

      const needsMention = row.kind === 'group' || row.kind === 'topic';
      // A question is answered by a reply that is causally after it OR explicitly linked to it.
      const waiting = { since: this.waitingSince(id, needsMention) };

      // Remote unread = live-observed customer inbound not covered by the read watermark.
      let unread: { n: number };
      if (row.remote_read_ns) {
        unread = this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM care_messages m
             WHERE m.conversation_id = @c AND m.is_deleted = 0 AND m.direction = 'in'
               AND m.sender_role = 'customer' AND m.live_observed = 1
               AND NOT (
                 COALESCE(m.id = @wid, 0)
                 OR (@wkey IS NOT NULL AND m.native_message_namespace = @wns
                     AND m.native_order_key IS NOT NULL AND m.native_order_key <= @wkey)
                 OR (@wsent IS NOT NULL AND m.sent_at < @wsent
                     AND NOT (m.native_message_namespace = @wns AND m.native_order_key IS NOT NULL AND @wkey IS NOT NULL))
               )`,
          )
          .get({
            c: id,
            wid: row.remote_read_message_id ?? null,
            wns: row.remote_read_ns,
            wkey: row.remote_read_key ?? null,
            wsent: row.remote_read_sent_at ?? null,
          }) as { n: number };
      } else {
        unread = this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM care_messages
             WHERE conversation_id = ? AND is_deleted = 0 AND direction = 'in'
               AND sender_role = 'customer' AND live_observed = 1`,
          )
          .get(id) as { n: number };
      }

      const nextLastId = last ? last.id : null;
      const nextLastAt = last ? Number(last.sent_at) : 0;
      const nextWaiting = waiting.since === null || waiting.since === undefined ? null : Number(waiting.since);
      const nextUnread = Number(unread.n);

      const curWaiting = row.waiting_since === null || row.waiting_since === undefined ? null : Number(row.waiting_since);
      if (
        row.last_message_id === nextLastId &&
        Number(row.last_message_at) === nextLastAt &&
        curWaiting === nextWaiting &&
        Number(row.remote_unread_count) === nextUnread
      ) {
        return this.mapRow(row);
      }

      this.db
        .prepare(
          `UPDATE care_conversations
           SET last_message_id = ?, last_message_at = ?, waiting_since = ?, remote_unread_count = ?,
               revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(nextLastId, nextLastAt, nextWaiting, nextUnread, Date.now(), id);
      return this.getConversation(id)!;
    });
    return run();
  }

  /**
   * Oldest live-observed customer inbound (directed at the account, for groups/topics) that no operator/agent/self reply
   * answers, or null. Same rule as the nested `NOT EXISTS` it replaced, evaluated in one pass over the conversation:
   * that statement compared every question with every reply (quadratic in the conversation size) and ran for every
   * conversation touched by every bridge backfill chunk, which is what made backfill time grow faster than the data.
   *
   * A reply `r` answers a question `q` when ANY of:
   *   (a) r.reply_to_ref equals q.native_message_id or q.ref_id                              (explicit linkage)
   *   (b) same namespace, both order keys known, r.key > q.key                               (native order)
   *   (c) r.sent_at > q.sent_at, and the pair is not comparable by native order: the
   *       namespaces differ, or either key is missing                                        (timestamps)
   * Equal timestamps without (a)/(b) stay UNORDERED: not answered. Order keys are fixed-width digit strings, so the
   * JS string comparison equals SQLite's.
   */
  private waitingSince(conversationId: string, needsMention: boolean): number | null {
    const questions = this.db
      .prepare(
        `SELECT sent_at, native_message_namespace AS ns, native_order_key AS k, native_message_id AS nid, ref_id
         FROM care_messages
         WHERE conversation_id = ? AND is_deleted = 0 AND direction = 'in' AND sender_role = 'customer' AND live_observed = 1
           ${needsMention ? 'AND directed_at_account = 1' : ''}`,
      )
      .all(conversationId) as Array<{ sent_at: number; ns: string; k: string | null; nid: string; ref_id: string | null }>;
    if (questions.length === 0) return null;
    const replies = this.db
      .prepare(
        `SELECT sent_at, native_message_namespace AS ns, native_order_key AS k, reply_to_ref
         FROM care_messages
         WHERE conversation_id = ? AND is_deleted = 0 AND direction = 'out' AND sender_role IN ('operator','agent','self')`,
      )
      .all(conversationId) as Array<{ sent_at: number; ns: string; k: string | null; reply_to_ref: string | null }>;

    const linked = new Set<string>();
    const maxKeyByNs = new Map<string, string>();
    const maxSentByNs = new Map<string, number>(); // replies WITH an order key, per namespace
    let maxSentNoKey = -Infinity; // replies without an order key
    let maxSentAny = -Infinity;
    for (const r of replies) {
      if (r.reply_to_ref !== null) linked.add(r.reply_to_ref);
      const sent = Number(r.sent_at);
      if (sent > maxSentAny) maxSentAny = sent;
      if (r.k === null) {
        if (sent > maxSentNoKey) maxSentNoKey = sent;
      } else {
        const key = maxKeyByNs.get(r.ns);
        if (key === undefined || r.k > key) maxKeyByNs.set(r.ns, r.k);
        const at = maxSentByNs.get(r.ns);
        if (at === undefined || sent > at) maxSentByNs.set(r.ns, sent);
      }
    }
    const answered = (q: (typeof questions)[number]): boolean => {
      if (linked.has(q.nid) || (q.ref_id !== null && linked.has(q.ref_id))) return true;
      const sent = Number(q.sent_at);
      if (q.k === null) return maxSentAny > sent; // no order key on the question: every reply is compared by time
      const key = maxKeyByNs.get(q.ns);
      if (key !== undefined && key > q.k) return true;
      if (maxSentNoKey > sent) return true;
      for (const [ns, at] of maxSentByNs) if (ns !== q.ns && at > sent) return true;
      return false;
    };
    let since: number | null = null;
    for (const q of questions) {
      const sent = Number(q.sent_at);
      if ((since === null || sent < since) && !answered(q)) since = sent;
    }
    return since;
  }

  /** Dashboard-only "I have seen up to here". Provider receipts must use `advanceRemoteWatermark`. */
  markLocalSeen(id: string, messageId: string): CareConversationRecord {
    const run = this.db.transaction(() => {
      const msg = this.db.prepare('SELECT conversation_id FROM care_messages WHERE id = ?').get(messageId) as
        | { conversation_id: string }
        | undefined;
      if (!msg || msg.conversation_id !== id) {
        throw new CareError('INVALID_TARGET', 'Local seen marker must reference a message of this conversation', 400);
      }
      this.db
        .prepare(
          `UPDATE care_conversations SET local_seen_message_id = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND (local_seen_message_id IS NOT ?)`,
        )
        .run(messageId, Date.now(), id, messageId);
      return this.getConversation(id)!;
    });
    return run();
  }

  /** Bridge only: the legacy thread has unread messages again, so nothing is "seen up to" any more. */
  clearLocalSeen(id: string): boolean {
    return (
      this.db
        .prepare('UPDATE care_conversations SET local_seen_message_id = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND local_seen_message_id IS NOT NULL')
        .run(Date.now(), id).changes > 0
    );
  }

  /**
   * Provider receipt coverage in NATIVE coordinates, forward-only:
   *  - inbound  : the remote account read customer messages up to the target (drives remote unread)
   *  - outbound : the customer read our messages up to the target (receipt level, not unread)
   * "Newer" is decided by native order keys within a namespace, else strictly larger timestamp;
   * never by local IDs. Returns false when the watermark would move backwards or stay put.
   */
  advanceRemoteWatermark(id: string, direction: CareReadDirection, target: WatermarkTarget): boolean {
    const run = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM care_conversations WHERE id = ?').get(id) as any;
      if (!row) throw new CareError('NOT_FOUND', `Conversation not found: ${id}`, 404);
      if (target.messageId) {
        const msg = this.db.prepare('SELECT conversation_id FROM care_messages WHERE id = ?').get(target.messageId) as
          | { conversation_id: string }
          | undefined;
        if (!msg || msg.conversation_id !== id) {
          throw new CareError('INVALID_TARGET', 'Remote read watermark must reference a message of this conversation', 400);
        }
      }

      const p = direction === 'inbound' ? 'remote_read' : 'remote_receipt';
      const curNs = row[`${p}_ns`] as string | null;
      if (curNs) {
        const curKey = row[`${p}_key`] as string | null;
        const curSent = row[`${p}_sent_at`] === null || row[`${p}_sent_at`] === undefined ? null : Number(row[`${p}_sent_at`]);
        let newer = false;
        if (curNs === target.namespace && curKey && target.orderKey) newer = target.orderKey > curKey;
        else if (curSent !== null && target.sentAtMs !== null) newer = target.sentAtMs > curSent;
        if (!newer) return false;
      }

      this.db
        .prepare(
          `UPDATE care_conversations
           SET ${p}_message_id = ?, ${p}_ns = ?, ${p}_key = ?, ${p}_sent_at = ?, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(target.messageId, target.namespace, target.orderKey, target.sentAtMs, Date.now(), id);
      if (direction === 'inbound') this.recomputeProjection(id);
      return true;
    });
    return run();
  }

  // ── receipts whose target message is not held yet ────────────────────────────────────────
  /** Durable effect of the ORIGINAL provider event; idempotent per (account, eventId). */
  addPendingReceipt(r: PendingReceipt): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO care_pending_receipts
           (account_id, event_id, external_conversation_key, native_message_namespace, native_message_id, direction, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.accountId, r.eventId, r.externalConversationKey, r.namespace, r.nativeMessageId, r.direction, Date.now());
  }

  listPendingReceipts(accountId: string, externalConversationKey: string, namespace: string, nativeMessageId: string): PendingReceipt[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM care_pending_receipts
         WHERE account_id = ? AND external_conversation_key = ? AND native_message_id = ?
           AND (native_message_namespace IS NULL OR native_message_namespace = ?)
         ORDER BY created_at ASC, event_id ASC`,
      )
      .all(accountId, externalConversationKey, nativeMessageId, namespace) as any[];
    return rows.map((r) => ({
      accountId: r.account_id,
      eventId: r.event_id,
      externalConversationKey: r.external_conversation_key,
      namespace: r.native_message_namespace ?? null,
      nativeMessageId: r.native_message_id,
      direction: r.direction,
    }));
  }

  deletePendingReceipt(accountId: string, eventId: string): boolean {
    return this.db.prepare('DELETE FROM care_pending_receipts WHERE account_id = ? AND event_id = ?').run(accountId, eventId).changes > 0;
  }

  /** Retention: receipts that never found their target. */
  purgePendingReceiptsBefore(beforeMs: number): number {
    return this.db.prepare('DELETE FROM care_pending_receipts WHERE created_at < ?').run(beforeMs).changes;
  }

  /** Revision bumps only when a flag actually changes, so a bridge replay leaves it alone. */
  setCareFlags(
    id: string,
    flags: { isPaused?: boolean; pausedUntilMs?: number | null; isOptedOut?: boolean },
  ): boolean {
    const setUntil = flags.pausedUntilMs !== undefined;
    if (setUntil && flags.pausedUntilMs !== null) requireSafeInteger(flags.pausedUntilMs, 'pausedUntilMs', 0);
    const run = this.db.transaction(() => {
      const cur = this.db.prepare('SELECT is_paused, paused_until, is_opted_out FROM care_conversations WHERE id = ?').get(id) as
        | { is_paused: number; paused_until: number | null; is_opted_out: number }
        | undefined;
      if (!cur) return false;
      const nextPaused = flags.isPaused === undefined ? cur.is_paused : flags.isPaused ? 1 : 0;
      const nextUntil = setUntil ? flags.pausedUntilMs ?? null : cur.paused_until;
      const nextOpt = flags.isOptedOut === undefined ? cur.is_opted_out : flags.isOptedOut ? 1 : 0;
      const same =
        nextPaused === cur.is_paused && (nextUntil ?? null) === (cur.paused_until ?? null) && nextOpt === cur.is_opted_out;
      if (same) return true;
      this.db
        .prepare(
          `UPDATE care_conversations SET is_paused = ?, paused_until = ?, is_opted_out = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
        )
        .run(nextPaused, nextUntil, nextOpt, Date.now(), id);
      return true;
    });
    return run();
  }

  /** Opt-out of automatic care/marketing for this conversation. Revision bumps only on change. */
  setOptedOut(id: string, optedOut: boolean): boolean {
    return this.setCareFlags(id, { isOptedOut: optedOut });
  }

  private mapRow(row: any): CareConversationRecord {
    oneOf(CARE_CONVERSATION_KINDS, row.kind, 'stored conversation kind');
    return {
      id: row.id,
      accountId: row.account_id,
      externalKey: row.external_key,
      kind: row.kind,
      title: decryptNullable(row.title_enc, this.key) ?? '',
      primaryCustomerId: row.primary_customer_id,
      status: row.status,
      isPaused: Boolean(row.is_paused),
      pausedUntilMs: row.paused_until === null || row.paused_until === undefined ? null : Number(row.paused_until),
      isOptedOut: Boolean(row.is_opted_out),
      waitingSinceMs: row.waiting_since === null || row.waiting_since === undefined ? null : Number(row.waiting_since),
      remoteUnreadCount: Number(row.remote_unread_count),
      localSeenMessageId: row.local_seen_message_id,
      remoteReadMessageId: row.remote_read_message_id,
      remoteReceiptMessageId: row.remote_receipt_message_id,
      lastMessageId: row.last_message_id,
      lastMessageAtMs: Number(row.last_message_at),
      revision: Number(row.revision),
      createdAtMs: Number(row.created_at),
      updatedAtMs: Number(row.updated_at),
    };
  }
}
