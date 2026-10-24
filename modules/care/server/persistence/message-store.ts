/**
 * Canonical message store. Every entrypoint validates account/conversation/identity/namespace
 * consistency itself (not only the ingest pipeline). Bodies and metadata are encrypted; BCC is
 * stripped from shared metadata before persistence.
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { CareError } from '../../../_lib/care-kit/errors.js';
import { deriveNativeOrderKey, isCausalOrderToken, isNativeOrderToken, isValidMessageNamespace } from '../../../_lib/care-kit/checkpoint.js';
import { sanitizeSharedMetadata } from '../domain/metadata.js';
import type { CareChannel, CareMessageMetadata, CareMessageRecord, NormalizedMessage } from '../../../_lib/care-kit/types.js';
import {
  CARE_DIRECTIONS,
  CARE_ORIGINS,
  CARE_SENDER_ROLES,
  oneOf,
  requireNonEmptyString,
  requireTimestampMs,
} from '../../../_lib/care-kit/validation.js';
import { decryptCareFieldStrict, decryptCareJson, encryptCareField, encryptCareJson, type CareKeyInput } from './crypto.js';
import { requireAccountRow, requireConversationOfAccount } from './shared.js';

const MAX_BODY_CHARS = 1_000_000;
const MAX_NATIVE_ID_CHARS = 512;

/** Reply-link refs stored in plaintext (lookup identifiers): own RFC Message-ID, and what this message answers. */
function linkRefs(metadata: CareMessageMetadata): { refId: string | null; replyToRef: string | null } {
  if (metadata.type === 'email') {
    return {
      refId: metadata.messageIdHeader ? metadata.messageIdHeader.trim().slice(0, 998) : null,
      replyToRef: metadata.inReplyToHeader ? metadata.inReplyToHeader.trim().slice(0, 998) : null,
    };
  }
  return { refId: null, replyToRef: metadata.quote?.messageId ? String(metadata.quote.messageId).slice(0, 512) : null };
}

export interface StoredTombstone {
  accountId: string;
  namespace: string;
  nativeMessageId: string;
  externalConversationKey: string | null;
  deletedAtMs: number;
}

export interface MessageInsertOptions {
  /** Group/topic only: message exactly targets this account (mention/quote of the account). */
  directedAtAccount?: boolean;
  /**
   * Overrides the default (`origin === 'live'`). Only a legacy BRIDGE sets this: a row the
   * legacy daemon observed live is stored with origin 'history' (never a trigger for Care) but
   * counts for waiting/unread, because the customer really did write it live.
   */
  liveObserved?: boolean;
}

export class CareMessageStore {
  constructor(
    private readonly db: Database.Database,
    private readonly key?: CareKeyInput,
  ) {}

  /** Validates the envelope against the owning account's channel; throws CareError before any write. */
  assertValid(msg: NormalizedMessage, accountChannel: CareChannel): void {
    const channel = accountChannel;
    if (!isValidMessageNamespace(channel, msg.nativeMessageNamespace)) {
      throw new CareError(
        'INVALID_TARGET',
        `Message namespace '${msg.nativeMessageNamespace}' is not valid for channel '${channel}'`,
        400,
      );
    }
    requireNonEmptyString(msg.nativeMessageId, 'nativeMessageId', MAX_NATIVE_ID_CHARS);
    oneOf(CARE_DIRECTIONS, msg.direction, 'direction');
    oneOf(CARE_SENDER_ROLES, msg.senderRole, 'senderRole');
    oneOf(CARE_ORIGINS, msg.origin, 'origin');
    requireTimestampMs(msg.sentAtMs, 'sentAtMs');
    if (typeof msg.text !== 'string' || msg.text.length > MAX_BODY_CHARS) {
      throw new CareError('INVALID_COMMAND', 'Message text must be a string within the size bound', 400);
    }
    const metadataType = msg.metadata?.type;
    if ((channel === 'email') !== (metadataType === 'email') || (metadataType !== 'email' && metadataType !== 'chat')) {
      throw new CareError('INVALID_TARGET', `Message metadata '${String(metadataType)}' is not valid for channel '${channel}'`, 400);
    }
    if (msg.nativeOrder !== undefined && msg.nativeOrder !== null && !isNativeOrderToken(msg.nativeOrder)) {
      throw new CareError('INVALID_COMMAND', 'nativeOrder must be 1-40 digits', 400);
    }
    if (msg.nativeVersion !== null && msg.nativeVersion !== undefined && typeof msg.nativeVersion !== 'string') {
      throw new CareError('INVALID_COMMAND', 'nativeVersion must be a string or null', 400);
    }
  }

  insertMessage(
    msg: NormalizedMessage,
    conversationId: string,
    senderIdentityId: string | null = null,
    customId?: string,
    opts: MessageInsertOptions = {},
  ): CareMessageRecord {
    const run = this.db.transaction(() => {
      const account = requireAccountRow(this.db, msg.accountId);
      requireConversationOfAccount(this.db, conversationId, msg.accountId);
      this.assertValid(msg, account.channel);
      if (senderIdentityId) {
        const identity = this.db.prepare('SELECT account_id FROM care_identities WHERE id = ?').get(senderIdentityId) as
          | { account_id: string }
          | undefined;
        if (!identity) throw new CareError('INVALID_TARGET', `Sender identity not found: ${senderIdentityId}`, 404);
        if (identity.account_id !== msg.accountId) {
          throw new CareError('INVALID_TARGET', 'Cross-account sender identity mismatch', 400);
        }
      }

      const id = customId ?? crypto.randomUUID();
      const metadata = sanitizeSharedMetadata(msg.metadata);
      const refs = linkRefs(metadata);
      this.db
        .prepare(
          `INSERT INTO care_messages (
             id, conversation_id, account_id, native_message_namespace, native_message_id,
             native_version, direction, sender_identity_id, sender_role, body_enc,
             metadata_enc, origin, sent_at, native_order_key, ref_id, reply_to_ref, live_observed,
             directed_at_account, is_deleted, tombstone, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
        )
        .run(
          id,
          conversationId,
          msg.accountId,
          msg.nativeMessageNamespace,
          msg.nativeMessageId,
          msg.nativeVersion ?? null,
          msg.direction,
          senderIdentityId,
          msg.senderRole,
          encryptCareField(msg.text, this.key),
          encryptCareJson(metadata, this.key),
          msg.origin,
          msg.sentAtMs,
          deriveNativeOrderKey(msg.nativeMessageNamespace, msg.nativeMessageId, msg.nativeOrder),
          refs.refId,
          refs.replyToRef,
          (opts.liveObserved ?? msg.origin === 'live') ? 1 : 0,
          opts.directedAtAccount ? 1 : 0,
          Date.now(),
        );

      return this.getMessage(id)!;
    });
    return run();
  }

  /** Records a delete that arrived before (or without) the original body. */
  insertTombstone(
    accountId: string,
    conversationId: string,
    nativeMessageNamespace: string,
    nativeMessageId: string,
    sentAtMs: number,
  ): CareMessageRecord {
    const run = this.db.transaction(() => {
      const account = requireAccountRow(this.db, accountId);
      requireConversationOfAccount(this.db, conversationId, accountId);
      if (!isValidMessageNamespace(account.channel, nativeMessageNamespace)) {
        throw new CareError('INVALID_TARGET', `Message namespace '${nativeMessageNamespace}' is not valid for channel '${account.channel}'`, 400);
      }
      requireNonEmptyString(nativeMessageId, 'nativeMessageId', MAX_NATIVE_ID_CHARS);
      requireTimestampMs(sentAtMs, 'sentAtMs');
      const id = crypto.randomUUID();
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO care_messages (
             id, conversation_id, account_id, native_message_namespace, native_message_id,
             native_version, direction, sender_role, body_enc, metadata_enc,
             origin, sent_at, directed_at_account, is_deleted, deleted_at, tombstone, created_at
           ) VALUES (?, ?, ?, ?, ?, NULL, 'in', 'system', '', '', 'live', ?, 0, 1, ?, 1, ?)`,
        )
        .run(id, conversationId, accountId, nativeMessageNamespace, nativeMessageId, sentAtMs, now, now);
      return this.getMessage(id)!;
    });
    return run();
  }

  getMessage(id: string): CareMessageRecord | null {
    const row = this.db.prepare('SELECT * FROM care_messages WHERE id = ?').get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  getMessageByNativeId(accountId: string, namespace: string, nativeMessageId: string): CareMessageRecord | null {
    const row = this.db
      .prepare('SELECT * FROM care_messages WHERE account_id = ? AND native_message_namespace = ? AND native_message_id = ?')
      .get(accountId, namespace, nativeMessageId) as any;
    return row ? this.mapRow(row) : null;
  }

  /**
   * Finds a message by native ID alone, only when it is unambiguous within the account.
   * Used to resolve provider receipts that carry no namespace.
   */
  findUniqueByNativeId(accountId: string, nativeMessageId: string): CareMessageRecord | null {
    const rows = this.db
      .prepare('SELECT * FROM care_messages WHERE account_id = ? AND native_message_id = ? LIMIT 2')
      .all(accountId, nativeMessageId) as any[];
    return rows.length === 1 ? this.mapRow(rows[0]) : null;
  }

  /** Newest-first keyset page; `before` is the last item of the previous page. Excludes deleted messages. */
  listMessages(
    conversationId: string,
    opts: { limit?: number; before?: { sentAtMs: number; id: string } } = {},
  ): CareMessageRecord[] {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50) || 1, 1), 500);
    let sql = 'SELECT * FROM care_messages WHERE conversation_id = ? AND is_deleted = 0';
    const params: any[] = [conversationId];
    if (opts.before) {
      sql += ' AND (sent_at < ? OR (sent_at = ? AND id < ?))';
      params.push(opts.before.sentAtMs, opts.before.sentAtMs, opts.before.id);
    }
    sql += ' ORDER BY sent_at DESC, id DESC LIMIT ?';
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as any[]).map((r) => this.mapRow(r));
  }

  /**
   * Newest-first live messages of one conversation (not deleted, not a tombstone), at most `limit`, optionally only
   * those at or before `upTo` (inclusive keyset on (sent_at, id)). Used to build agent context up to a trigger message.
   */
  listByConversation(conversationId: string, opts: { limit?: number; upTo?: { sentAtMs: number; id: string } } = {}): CareMessageRecord[] {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50) || 1, 1), 500);
    let sql = 'SELECT * FROM care_messages WHERE conversation_id = ? AND is_deleted = 0 AND tombstone = 0';
    const params: any[] = [conversationId];
    if (opts.upTo) {
      sql += ' AND (sent_at < ? OR (sent_at = ? AND id <= ?))';
      params.push(opts.upTo.sentAtMs, opts.upTo.sentAtMs, opts.upTo.id);
    }
    sql += ' ORDER BY sent_at DESC, id DESC LIMIT ?';
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as any[]).map((r) => this.mapRow(r));
  }

  /** Number of rows with this native ID in the account (used to refuse ambiguous namespace-less receipts). */
  countByNativeId(accountId: string, nativeMessageId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM care_messages WHERE account_id = ? AND native_message_id = ?')
      .get(accountId, nativeMessageId) as { n: number };
    return Number(row.n);
  }

  /**
   * A genuine live observation of a message first seen through history/recovery/edit. The
   * original `origin` (provenance) is kept; only the durable flag flips. Idempotent.
   */
  markLiveObserved(id: string): boolean {
    const res = this.db
      .prepare('UPDATE care_messages SET live_observed = 1 WHERE id = ? AND live_observed = 0 AND is_deleted = 0')
      .run(id);
    return res.changes > 0;
  }

  // ── tombstones for deletes that arrive before the message (peer possibly unknown) ──────────
  getTombstone(accountId: string, namespace: string, nativeMessageId: string): StoredTombstone | null {
    const row = this.db
      .prepare('SELECT * FROM care_tombstones WHERE account_id = ? AND native_message_namespace = ? AND native_message_id = ?')
      .get(accountId, namespace, nativeMessageId) as any;
    return row
      ? {
          accountId: row.account_id,
          namespace: row.native_message_namespace,
          nativeMessageId: row.native_message_id,
          externalConversationKey: row.external_conversation_key ?? null,
          deletedAtMs: Number(row.deleted_at),
        }
      : null;
  }

  recordTombstone(
    accountId: string,
    namespace: string,
    nativeMessageId: string,
    externalConversationKey: string | null,
    deletedAtMs: number,
  ): StoredTombstone {
    const account = requireAccountRow(this.db, accountId);
    if (!isValidMessageNamespace(account.channel, namespace)) {
      throw new CareError('INVALID_TARGET', `Message namespace '${namespace}' is not valid for channel '${account.channel}'`, 400);
    }
    requireNonEmptyString(nativeMessageId, 'nativeMessageId', MAX_NATIVE_ID_CHARS);
    requireTimestampMs(deletedAtMs, 'deletedAtMs');
    this.db
      .prepare(
        `INSERT INTO care_tombstones (account_id, native_message_namespace, native_message_id, external_conversation_key, deleted_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, native_message_namespace, native_message_id) DO UPDATE SET
           external_conversation_key = COALESCE(care_tombstones.external_conversation_key, excluded.external_conversation_key)`,
      )
      .run(accountId, namespace, nativeMessageId, externalConversationKey, deletedAtMs, Date.now());
    return this.getTombstone(accountId, namespace, nativeMessageId)!;
  }

  deleteTombstone(accountId: string, namespace: string, nativeMessageId: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM care_tombstones WHERE account_id = ? AND native_message_namespace = ? AND native_message_id = ?')
        .run(accountId, namespace, nativeMessageId).changes > 0
    );
  }

  /**
   * Bridge only: a legacy echo/provisional row got its real remote ID (or lost it to a dedupe).
   * The canonical row keeps its identity; only the native key moves. Refuses to steal a key held
   * by another row.
   */
  rekeyNative(id: string, nativeMessageId: string, nativeOrder?: string | null): boolean {
    const run = this.db.transaction(() => {
      requireNonEmptyString(nativeMessageId, 'nativeMessageId', MAX_NATIVE_ID_CHARS);
      const row = this.db.prepare('SELECT account_id, native_message_namespace, native_message_id FROM care_messages WHERE id = ?').get(id) as
        | { account_id: string; native_message_namespace: string; native_message_id: string }
        | undefined;
      if (!row) return false;
      if (row.native_message_id === nativeMessageId) return false;
      const holder = this.db
        .prepare('SELECT id FROM care_messages WHERE account_id = ? AND native_message_namespace = ? AND native_message_id = ?')
        .get(row.account_id, row.native_message_namespace, nativeMessageId) as { id: string } | undefined;
      if (holder && holder.id !== id) {
        throw new CareError('CONFIGURATION_CONFLICT', 'Native message key is already held by another message', 409);
      }
      const key = deriveNativeOrderKey(row.native_message_namespace, nativeMessageId, nativeOrder);
      this.db
        .prepare('UPDATE care_messages SET native_message_id = ?, native_order_key = COALESCE(?, native_order_key) WHERE id = ?')
        .run(nativeMessageId, key, id);
      return true;
    });
    return run();
  }

  /**
   * Bridge only, for a legacy row that was HARD-deleted (cleanup, echo de-duplication, failed-send
   * rollback — not a customer-visible recall): purge it like any delete AND release its native
   * key so a successor row may legitimately take it. Idempotent.
   */
  retireHardDeleted(id: string): boolean {
    const run = this.db.transaction(() => {
      this.softDeleteMessage(id);
      const res = this.db
        .prepare(
          `UPDATE care_messages SET native_message_id = ?, native_order_key = NULL
           WHERE id = ? AND native_message_id NOT LIKE 'retired:%'`,
        )
        .run(`retired:${id}`, id);
      return res.changes > 0;
    });
    return run();
  }

  /** Bridge only: re-apply a legacy row's current content to its canonical message. */
  updateBridgedContent(id: string, text: string, metadata: CareMessageMetadata, opts: { directedAtAccount?: boolean } = {}): boolean {
    if (typeof text !== 'string' || text.length > MAX_BODY_CHARS) {
      throw new CareError('INVALID_COMMAND', 'Message text must be a string within the size bound', 400);
    }
    const clean = sanitizeSharedMetadata(metadata);
    const refs = linkRefs(clean);
    const res = this.db
      .prepare(
        `UPDATE care_messages
         SET body_enc = ?, metadata_enc = ?, directed_at_account = COALESCE(?, directed_at_account),
             ref_id = ?, reply_to_ref = ?
         WHERE id = ? AND is_deleted = 0`,
      )
      .run(
        encryptCareField(text, this.key),
        encryptCareJson(clean, this.key),
        opts.directedAtAccount === undefined ? null : opts.directedAtAccount ? 1 : 0,
        refs.refId,
        refs.replyToRef,
        id,
      );
    return res.changes > 0;
  }

  /** Purges body + metadata and marks the row a tombstone; the native key stays to block resurrection. */
  softDeleteMessage(id: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE care_messages
         SET is_deleted = 1, tombstone = 1, deleted_at = ?, body_enc = '', metadata_enc = '', directed_at_account = 0,
             ref_id = NULL, reply_to_ref = NULL
         WHERE id = ? AND is_deleted = 0`,
      )
      .run(Date.now(), id);
    return res.changes > 0;
  }

  /**
   * Applies an edit. `nativeVersion` must be a validated causal token: there is no arrival-time
   * fallback, an unordered edit never reaches this method.
   */
  updateMessageVersion(
    id: string,
    nativeVersion: string,
    newText: string,
    metadata: CareMessageMetadata,
    opts: MessageInsertOptions = {},
  ): boolean {
    if (!isCausalOrderToken(nativeVersion)) {
      throw new CareError('INVALID_COMMAND', 'Edits require a validated causal nativeVersion', 400);
    }
    if (typeof newText !== 'string' || newText.length > MAX_BODY_CHARS) {
      throw new CareError('INVALID_COMMAND', 'Message text must be a string within the size bound', 400);
    }
    const clean = sanitizeSharedMetadata(metadata);
    const refs = linkRefs(clean);
    const res = this.db
      .prepare(
        `UPDATE care_messages
         SET native_version = ?, body_enc = ?, metadata_enc = ?, directed_at_account = ?,
             ref_id = ?, reply_to_ref = ?
         WHERE id = ? AND is_deleted = 0`,
      )
      .run(
        nativeVersion,
        encryptCareField(newText, this.key),
        encryptCareJson(clean, this.key),
        opts.directedAtAccount ? 1 : 0,
        refs.refId,
        refs.replyToRef,
        id,
      );
    return res.changes > 0;
  }

  private mapRow(row: any): CareMessageRecord {
    // Purged rows (tombstones) carry '' instead of ciphertext; everything else must decrypt strictly.
    const text = row.body_enc ? decryptCareFieldStrict(row.body_enc, this.key) : '';
    const metadata: CareMessageMetadata = row.metadata_enc
      ? decryptCareJson<CareMessageMetadata>(row.metadata_enc, this.key)
      : { type: 'chat' };

    return {
      id: row.id,
      conversationId: row.conversation_id,
      accountId: row.account_id,
      nativeMessageNamespace: row.native_message_namespace,
      nativeMessageId: row.native_message_id,
      nativeVersion: row.native_version,
      direction: row.direction,
      senderIdentityId: row.sender_identity_id,
      senderRole: row.sender_role,
      text,
      metadata,
      origin: row.origin,
      sentAtMs: Number(row.sent_at),
      nativeOrderKey: row.native_order_key ?? null,
      liveObserved: Boolean(row.live_observed),
      directedAtAccount: Boolean(row.directed_at_account),
      isDeleted: Boolean(row.is_deleted),
      deletedAtMs: row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at),
      tombstone: Boolean(row.tombstone),
      createdAtMs: Number(row.created_at),
    };
  }
}
