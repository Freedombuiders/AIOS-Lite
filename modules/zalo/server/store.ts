// Zalo store: SQL access for every zalo_* table (module-owned). Handle comes from compat getDb().
// Derived from the owner's db.ts zalo sections.
import crypto from 'node:crypto';
import path from 'node:path';
import { db } from './compat.js';
import { decryptField, encryptField } from './field-crypto.js';
import { foldVietnamese, renderText } from './content.js';
import { ZALO_MEDIA_DIR, type ZaloAttachment } from './media.js';
import { normalizeZaloStyles, type ZaloStyle } from './rich-text.js';

// ── Zalo customer care ───────────────────────────────────────────────
//
// Written by the zalo daemon (sessions, listener, outbox worker,
// care bridge) and read by the pages. sent_at on messages is milliseconds;
// every other *_at column is seconds like the rest of this file.

export type ZaloAccountStatus = 'disconnected' | 'qr_pending' | 'connecting' | 'connected' | 'session_expired';
export type ZaloThreadType = 'user' | 'group';
/** customer = the other side; self = typed on the nick's own phone/Zalo app;
 *  agent = sent by an assigned agent; operator = sent from the dashboard;
 *  broadcast = a marketing send (group/list broadcast, birthday). */
export type ZaloSenderType = 'customer' | 'self' | 'agent' | 'operator' | 'broadcast';

const nowSec = (): number => Math.floor(Date.now() / 1000);

export interface ZaloAccountRow {
  id: string;
  label: string;
  zalo_uid: string | null;
  display_name: string;
  avatar_url: string;
  status: ZaloAccountStatus;
  chat_enabled: number;
  daily_message_cap: number;
  manual_disconnect: number;
  last_error: string;
  last_connected_at: number | null;
  created_at: number;
  updated_at: number;
  has_session: number;
  /** JSON of per-category limit overrides for this nick ('{}' = defaults). */
  limits_json: string;
  /** Non-empty = sending was locked automatically after repeated Zalo rejections. */
  send_lock_reason: string;
  warmup_enabled: number;
  warmup_started_at: number | null;
}

const ZALO_ACCOUNT_COLUMNS = `id, label, zalo_uid, display_name, avatar_url, status,
  chat_enabled, daily_message_cap, manual_disconnect, last_error, last_connected_at,
  created_at, updated_at, (session_enc IS NOT NULL) AS has_session,
  limits_json, send_lock_reason, warmup_enabled, warmup_started_at`;

export function createZaloAccount(label: string, opts: { warmup?: boolean } = {}): ZaloAccountRow {
  const id = crypto.randomUUID();
  const now = nowSec();
  db.prepare(
    `INSERT INTO zalo_accounts (id, label, daily_message_cap, warmup_enabled, created_at, updated_at) VALUES (?, ?, 1000, ?, ?, ?)`,
  ).run(id, label.trim(), opts.warmup ? 1 : 0, now, now);
  return getZaloAccount(id)!;
}

export function listZaloAccounts(): ZaloAccountRow[] {
  return db.prepare(`SELECT ${ZALO_ACCOUNT_COLUMNS} FROM zalo_accounts ORDER BY created_at`).all() as ZaloAccountRow[];
}

export function getZaloAccount(id: string): ZaloAccountRow | undefined {
  return db.prepare(`SELECT ${ZALO_ACCOUNT_COLUMNS} FROM zalo_accounts WHERE id = ?`).get(id) as ZaloAccountRow | undefined;
}

/** Id of the account (other than `exceptId`) already holding this Zalo uid. */
export function findZaloAccountIdByUid(zaloUid: string, exceptId?: string): string | null {
  const row = db.prepare(
    `SELECT id FROM zalo_accounts WHERE zalo_uid = ? AND id != ?`,
  ).get(zaloUid, exceptId ?? '') as { id: string } | undefined;
  return row?.id ?? null;
}

/** Zalo uids of every connected-at-least-once nick — used to stop AI↔AI loops. */
export function listZaloAccountUids(): string[] {
  return (db.prepare(`SELECT zalo_uid FROM zalo_accounts WHERE zalo_uid IS NOT NULL`).all() as Array<{ zalo_uid: string }>)
    .map((r) => r.zalo_uid);
}

export function getZaloAccountSession(id: string): string | null {
  const row = db.prepare(`SELECT session_enc FROM zalo_accounts WHERE id = ?`).get(id) as { session_enc: string | null } | undefined;
  return row?.session_enc ? decryptField(row.session_enc) : null;
}

export function saveZaloAccountSession(id: string, sessionJson: string | null): void {
  db.prepare(`UPDATE zalo_accounts SET session_enc = ?, updated_at = ? WHERE id = ?`)
    .run(sessionJson === null ? null : encryptField(sessionJson), nowSec(), id);
}

export interface ZaloAccountStatePatch {
  status?: ZaloAccountStatus;
  zalo_uid?: string | null;
  display_name?: string;
  avatar_url?: string;
  last_error?: string;
  last_connected_at?: number | null;
  manual_disconnect?: number;
}

export interface ZaloAccountSettingsPatch {
  label?: string;
  chat_enabled?: number;
  daily_message_cap?: number;
  limits_json?: string;
  send_lock_reason?: string;
  warmup_enabled?: number;
  warmup_started_at?: number | null;
}

function updateZaloAccountColumns(id: string, patch: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = Object.keys(patch).filter((k) => allowed.includes(k) && patch[k] !== undefined);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE zalo_accounts SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => patch[k]), nowSec(), id);
}

export function updateZaloAccountState(id: string, patch: ZaloAccountStatePatch): void {
  updateZaloAccountColumns(id, patch as Record<string, unknown>, [
    'status', 'zalo_uid', 'display_name', 'avatar_url', 'last_error', 'last_connected_at', 'manual_disconnect',
  ]);
}

export function updateZaloAccountSettings(id: string, patch: ZaloAccountSettingsPatch): void {
  updateZaloAccountColumns(id, patch as Record<string, unknown>, [
    'label', 'chat_enabled', 'daily_message_cap',
    'limits_json', 'send_lock_reason', 'warmup_enabled', 'warmup_started_at',
  ]);
}

/** Removes the account and everything recorded under it. */
export function deleteZaloAccount(id: string): void {
  db.transaction(() => {
    const threadIds = `SELECT id FROM zalo_threads WHERE account_id = ?`;
    db.prepare(`DELETE FROM zalo_outbox WHERE thread_id IN (${threadIds})`).run(id);
    db.prepare(`DELETE FROM zalo_messages WHERE thread_id IN (${threadIds})`).run(id);
    db.prepare(`DELETE FROM zalo_threads WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM zalo_accounts WHERE id = ?`).run(id);
  })();
}

export interface ZaloThreadRow {
  id: number;
  account_id: string;
  thread_type: ZaloThreadType;
  external_id: string;
  name: string;
  avatar_url: string;
  members_count: number | null;
  global_id: string;
  last_message_at: number;
  last_preview: string;
  last_sender_type: string;
  unread_count: number;
  paused_until: number | null;
  pause_reason: string;
  /** 1 = the customer asked to stop receiving marketing; marketing sends skip the thread. */
  opted_out: number;
  opted_out_at: number | null;
  created_at: number;
}

function decryptThread(row: ZaloThreadRow): ZaloThreadRow {
  return { ...row, last_preview: row.last_preview ? decryptField(row.last_preview) : '' };
}

export interface ZaloThreadUpsert {
  accountId: string;
  threadType: ZaloThreadType;
  externalId: string;
  name?: string;
  avatarUrl?: string;
  membersCount?: number | null;
  globalId?: string;
}

/** Insert or refresh a thread. Empty name/avatar never overwrite known values. */
export function upsertZaloThread(input: ZaloThreadUpsert): ZaloThreadRow {
  const row = db.prepare(
    `INSERT INTO zalo_threads (account_id, thread_type, external_id, name, avatar_url, members_count, global_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, external_id) DO UPDATE SET
       name = CASE WHEN excluded.name != '' THEN excluded.name ELSE zalo_threads.name END,
       avatar_url = CASE WHEN excluded.avatar_url != '' THEN excluded.avatar_url ELSE zalo_threads.avatar_url END,
       members_count = COALESCE(excluded.members_count, zalo_threads.members_count),
       global_id = CASE WHEN excluded.global_id != '' THEN excluded.global_id ELSE zalo_threads.global_id END
     RETURNING *`,
  ).get(
    input.accountId,
    input.threadType,
    input.externalId,
    input.name ?? '',
    input.avatarUrl ?? '',
    input.membersCount ?? null,
    input.globalId ?? '',
    nowSec(),
  ) as ZaloThreadRow;
  return decryptThread(row);
}

export function getZaloThread(id: number): ZaloThreadRow | undefined {
  const row = db.prepare(`SELECT * FROM zalo_threads WHERE id = ?`).get(id) as ZaloThreadRow | undefined;
  return row ? decryptThread(row) : undefined;
}

export function getZaloThreadByExternal(accountId: string, externalId: string): ZaloThreadRow | undefined {
  const row = db.prepare(`SELECT * FROM zalo_threads WHERE account_id = ? AND external_id = ?`)
    .get(accountId, externalId) as ZaloThreadRow | undefined;
  return row ? decryptThread(row) : undefined;
}

export function countZaloThreads(accountId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM zalo_threads WHERE account_id = ?`).get(accountId) as { n: number }).n;
}

/**
 * Move the thread's "last message" pointer forward. Backfilled history never
 * regresses it (an older sent_at loses to the stored one) and never touches
 * the unread counter.
 */
export function recordZaloThreadActivity(
  threadId: number,
  input: { sentAtMs: number; preview: string; senderType: ZaloSenderType; live: boolean },
): void {
  const inbound = input.senderType === 'customer';
  db.prepare(
    `UPDATE zalo_threads SET
       last_preview = CASE WHEN ? >= last_message_at THEN ? ELSE last_preview END,
       last_sender_type = CASE WHEN ? >= last_message_at THEN ? ELSE last_sender_type END,
       last_message_at = MAX(last_message_at, ?),
       unread_count = CASE WHEN ? THEN unread_count + 1 WHEN ? THEN 0 ELSE unread_count END
     WHERE id = ?`,
  ).run(
    input.sentAtMs, encryptField(input.preview.slice(0, 200)),
    input.sentAtMs, input.senderType,
    input.sentAtMs,
    input.live && inbound ? 1 : 0,
    input.live && !inbound ? 1 : 0,
    threadId,
  );
}

export interface ZaloThreadListRow extends ZaloThreadRow {
  account_label: string;
  account_display_name: string;
}

export function listZaloThreads(filter: {
  accountId?: string;
  threadType?: ZaloThreadType;
  search?: string;
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
} = {}): { threads: ZaloThreadListRow[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.accountId) { where.push('t.account_id = ?'); params.push(filter.accountId); }
  if (filter.threadType) { where.push('t.thread_type = ?'); params.push(filter.threadType); }
  if (filter.search?.trim()) { where.push('t.name LIKE ?'); params.push(`%${filter.search.trim()}%`); }
  if (filter.unreadOnly) where.push(`t.last_sender_type = 'customer'`);
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  const rows = db.prepare(
    `SELECT t.*, a.label AS account_label, a.display_name AS account_display_name
     FROM zalo_threads t JOIN zalo_accounts a ON a.id = t.account_id
     ${whereSql}
     ORDER BY t.last_message_at DESC, t.id DESC
     LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as ZaloThreadListRow[];
  const total = (db.prepare(
    `SELECT COUNT(*) AS n FROM zalo_threads t ${whereSql}`,
  ).get(...params) as { n: number }).n;
  return { threads: rows.map((r) => ({ ...r, last_preview: r.last_preview ? decryptField(r.last_preview) : '' })), total };
}

export function markZaloThreadRead(threadId: number): void {
  db.prepare(`UPDATE zalo_threads SET unread_count = 0 WHERE id = ?`).run(threadId);
}

/** untilSec = null clears the pause. */
export function setZaloThreadPause(threadId: number, untilSec: number | null, reason: string): void {
  db.prepare(`UPDATE zalo_threads SET paused_until = ?, pause_reason = ? WHERE id = ?`)
    .run(untilSec, untilSec === null ? '' : reason, threadId);
}

export interface ZaloMessageRow {
  id: number;
  thread_id: number;
  zalo_msg_id: string | null;
  cli_msg_id: string | null;
  sender_type: ZaloSenderType;
  sender_uid: string;
  sender_name: string;
  body: string;
  content_type: string;
  quote_json: string | null;
  mentions_json: string | null;
  origin: 'live' | 'backfill' | 'outbound';
  is_deleted: number;
  sent_at: number;
  created_at: number;
}

const ZALO_MESSAGE_COLUMNS = `id, thread_id, zalo_msg_id, cli_msg_id, sender_type, sender_uid, sender_name,
  body, content_type, quote_json, mentions_json, origin, is_deleted, sent_at, created_at`;

function decryptZaloMessage(row: ZaloMessageRow): ZaloMessageRow {
  return {
    ...row,
    body: decryptField(row.body),
    quote_json: row.quote_json ? decryptField(row.quote_json) : null,
  };
}

export interface ZaloMessageInsert {
  threadId: number;
  zaloMsgId: string | null;
  cliMsgId?: string | null;
  senderType: ZaloSenderType;
  senderUid?: string;
  senderName?: string;
  body: string;
  contentType: string;
  quote?: unknown;
  mentions?: unknown;
  origin: 'live' | 'backfill' | 'outbound';
  sentAtMs: number;
}

function zaloMsgIdNum(zaloMsgId: string | null | undefined): bigint | null {
  if (!zaloMsgId || !/^\d{1,19}$/.test(zaloMsgId)) return null;
  const n = BigInt(zaloMsgId);
  return n <= 9223372036854775807n ? n : null;
}

/** Returns the new row id, or null when this Zalo message id is already stored. */
export function insertZaloMessage(input: ZaloMessageInsert): number | null {
  const info = db.prepare(
    `INSERT OR IGNORE INTO zalo_messages
       (thread_id, zalo_msg_id, msg_id_num, cli_msg_id, sender_type, sender_uid, sender_name, body,
        content_type, quote_json, mentions_json, origin, sent_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.threadId,
    input.zaloMsgId || null,
    zaloMsgIdNum(input.zaloMsgId),
    input.cliMsgId || null,
    input.senderType,
    input.senderUid ?? '',
    input.senderName ?? '',
    encryptField(input.body),
    input.contentType,
    input.quote ? encryptField(JSON.stringify(input.quote)) : null,
    input.mentions ? JSON.stringify(input.mentions) : null,
    input.origin,
    input.sentAtMs,
    nowSec(),
  );
  return info.changes > 0 ? Number(info.lastInsertRowid) : null;
}

/**
 * Attach Zalo's ids to an outbound row once the send resolves. If the echo
 * already landed as a separate phone-typed row with the same id, that echo
 * is the duplicate and is dropped.
 */
export function setZaloMessageRemoteIds(messageId: number, zaloMsgId: string, cliMsgId?: string | null): void {
  db.transaction(() => {
    const row = db.prepare(`SELECT thread_id FROM zalo_messages WHERE id = ?`).get(messageId) as { thread_id: number } | undefined;
    if (!row) return;
    db.prepare(
      `DELETE FROM zalo_messages WHERE thread_id = ? AND zalo_msg_id = ? AND id != ? AND sender_type = 'self'`,
    ).run(row.thread_id, zaloMsgId, messageId);
    db.prepare(
      `UPDATE OR IGNORE zalo_messages SET zalo_msg_id = ?, msg_id_num = ?, cli_msg_id = COALESCE(?, cli_msg_id) WHERE id = ?`,
    ).run(zaloMsgId, zaloMsgIdNum(zaloMsgId), cliMsgId || null, messageId);
  })();
}

export function deleteZaloMessage(messageId: number): void {
  db.prepare(`DELETE FROM zalo_messages WHERE id = ?`).run(messageId);
}

/** Soft-delete recalled messages. Zalo references the original by either id. */
export function markZaloMessagesRecalled(accountId: string, refs: { globalMsgId?: string; cliMsgId?: string }): number {
  const ids = [refs.globalMsgId, refs.cliMsgId].filter((v): v is string => !!v);
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(', ');
  const info = db.prepare(
    `UPDATE zalo_messages SET is_deleted = 1
     WHERE is_deleted = 0
       AND thread_id IN (SELECT id FROM zalo_threads WHERE account_id = ?)
       AND (zalo_msg_id IN (${placeholders}) OR cli_msg_id IN (${placeholders}))`,
  ).run(accountId, ...ids, ...ids);
  return info.changes;
}

export function getZaloMessage(id: number): ZaloMessageRow | undefined {
  const row = db.prepare(`SELECT ${ZALO_MESSAGE_COLUMNS} FROM zalo_messages WHERE id = ?`).get(id) as ZaloMessageRow | undefined;
  return row ? decryptZaloMessage(row) : undefined;
}

/** Oldest-first page of a thread; `beforeMs` pages further back. */
export function getZaloMessages(threadId: number, opts: { beforeMs?: number; limit?: number } = {}): ZaloMessageRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const rows = (opts.beforeMs
    ? db.prepare(
      `SELECT ${ZALO_MESSAGE_COLUMNS} FROM zalo_messages WHERE thread_id = ? AND sent_at < ?
       ORDER BY sent_at DESC, msg_id_num DESC, id DESC LIMIT ?`,
    ).all(threadId, opts.beforeMs, limit)
    : db.prepare(
      `SELECT ${ZALO_MESSAGE_COLUMNS} FROM zalo_messages WHERE thread_id = ?
       ORDER BY sent_at DESC, msg_id_num DESC, id DESC LIMIT ?`,
    ).all(threadId, limit)) as ZaloMessageRow[];
  return rows.reverse().map(decryptZaloMessage);
}

/** Messages sent by this nick today (phone, agent, dashboard or marketing) — the nick cap. */
export function countZaloOutboundSince(accountId: string, sinceMs: number): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM zalo_messages m JOIN zalo_threads t ON t.id = m.thread_id
     WHERE t.account_id = ? AND m.sender_type IN ('self', 'agent', 'operator', 'broadcast')
       AND m.origin != 'backfill' AND m.sent_at >= ?`,
  ).get(accountId, sinceMs) as { n: number }).n;
}

/** Latest message a human sent into this thread (phone or dashboard), ms. */
export function lastZaloHumanReplyAt(threadId: number): number | null {
  const row = db.prepare(
    `SELECT MAX(sent_at) AS at FROM zalo_messages
     WHERE thread_id = ? AND sender_type IN ('self', 'operator') AND origin != 'backfill'`,
  ).get(threadId) as { at: number | null };
  return row.at;
}

export interface ZaloSearchHit extends ZaloMessageRow {
  thread_name: string;
  thread_type: ZaloThreadType;
  account_id: string;
}

/**
 * Bodies are encrypted, so search decrypts the newest `scanLimit` messages
 * in scope and filters in memory (diacritic-insensitive).
 */
export function searchZaloMessages(opts: {
  query: string;
  accountId?: string;
  threadId?: number;
  limit?: number;
  scanLimit?: number;
}): ZaloSearchHit[] {
  const needle = foldVietnamese(opts.query).trim();
  if (!needle) return [];
  const where: string[] = ['m.is_deleted = 0'];
  const params: unknown[] = [];
  if (opts.accountId) { where.push('t.account_id = ?'); params.push(opts.accountId); }
  if (opts.threadId) { where.push('m.thread_id = ?'); params.push(opts.threadId); }
  const rows = db.prepare(
    `SELECT m.id, m.thread_id, m.zalo_msg_id, m.cli_msg_id, m.sender_type, m.sender_uid, m.sender_name,
            m.body, m.content_type, m.quote_json, m.mentions_json, m.origin, m.is_deleted, m.sent_at, m.created_at,
            t.name AS thread_name, t.thread_type, t.account_id
     FROM zalo_messages m JOIN zalo_threads t ON t.id = m.thread_id
     WHERE ${where.join(' AND ')}
     ORDER BY m.sent_at DESC LIMIT ?`,
  ).all(...params, Math.min(opts.scanLimit ?? 20000, 100000)) as ZaloSearchHit[];
  const limit = Math.min(opts.limit ?? 50, 500);
  const hits: ZaloSearchHit[] = [];
  for (const row of rows) {
    const body = decryptField(row.body);
    if (foldVietnamese(renderText(row.content_type, body)).includes(needle) || foldVietnamese(row.sender_name).includes(needle)) {
      hits.push({ ...row, body, quote_json: null });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

export type ZaloOutboxStatus = 'draft' | 'pending' | 'sending' | 'sent' | 'failed' | 'discarded';

export interface ZaloOutboxRow {
  id: number;
  thread_id: number;
  body: string;
  mentions_json: string | null;
  origin: 'operator' | 'agent';
  agent_id: string;
  run_id: number | null;
  status: ZaloOutboxStatus;
  message_id: number | null;
  error: string;
  /** Seconds. */
  created_at: number;
  sent_at: number | null;
  /** JSON `[{ mediaId }]` (zalo_media ids sent after the text); '[]' for text-only rows. */
  attachments_json: string;
  /** JSON array of Zalo style ranges over `body`; '[]' for plain rows. */
  styles_json: string;
}

function decryptOutbox(row: ZaloOutboxRow): ZaloOutboxRow {
  return { ...row, body: decryptField(row.body) };
}

export function enqueueZaloOutbox(input: {
  threadId: number;
  body: string;
  mentions?: unknown;
  origin: 'operator' | 'agent';
  agentId?: string;
  runId?: number | null;
  status?: 'pending' | 'draft';
  /** Shared inbox: uploads (zalo_media ids) the sender posts after the text. */
  attachments?: Array<{ mediaId: string }>;
  /** Shared inbox: Zalo rich-text ranges over `body` (already aligned to the stored text). */
  styles?: Array<{ st: string; start: number; len: number; indentSize?: number }>;
}): number {
  const info = db.prepare(
    `INSERT INTO zalo_outbox (thread_id, body, mentions_json, origin, agent_id, run_id, status, created_at, attachments_json, styles_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.threadId,
    // encryptField('') does not round-trip (empty payload); an attachment-only reply stores ''.
    input.body ? encryptField(input.body) : '',
    input.mentions ? JSON.stringify(input.mentions) : null,
    input.origin,
    input.agentId ?? '',
    input.runId ?? null,
    input.status ?? 'pending',
    nowSec(),
    JSON.stringify((input.attachments ?? []).map((a) => ({ mediaId: String(a.mediaId) }))),
    JSON.stringify(input.styles ?? []),
  );
  return Number(info.lastInsertRowid);
}

export function getZaloOutbox(id: number): ZaloOutboxRow | undefined {
  const row = db.prepare(`SELECT * FROM zalo_outbox WHERE id = ?`).get(id) as ZaloOutboxRow | undefined;
  return row ? decryptOutbox(row) : undefined;
}

/** Atomically move the oldest pending row to 'sending' and return it. */
export function claimNextZaloOutbox(): ZaloOutboxRow | null {
  return db.transaction(() => {
    const next = db.prepare(
      `SELECT id FROM zalo_outbox WHERE status = 'pending' ORDER BY created_at, id LIMIT 1`,
    ).get() as { id: number } | undefined;
    if (!next) return null;
    const claimed = db.prepare(`UPDATE zalo_outbox SET status = 'sending' WHERE id = ? AND status = 'pending'`).run(next.id);
    if (claimed.changes === 0) return null;
    return getZaloOutbox(next.id) ?? null;
  })();
}

export function markZaloOutboxSent(id: number, messageId: number): void {
  db.prepare(`UPDATE zalo_outbox SET status = 'sent', message_id = ?, error = '', sent_at = ? WHERE id = ?`)
    .run(messageId, nowSec(), id);
}

export function markZaloOutboxFailed(id: number, error: string): void {
  db.prepare(`UPDATE zalo_outbox SET status = 'failed', error = ? WHERE id = ?`).run(error.slice(0, 500), id);
}

/**
 * A row left in 'sending' means the daemon died mid-send. Whether Zalo got
 * it is unknown, so it is failed rather than retried (no double sends).
 */
export function failInterruptedZaloOutbox(): number {
  return db.prepare(`UPDATE zalo_outbox SET status = 'failed', error = 'interrupted' WHERE status = 'sending'`).run().changes;
}

export function listZaloOutbox(opts: { threadId?: number; statuses?: ZaloOutboxStatus[]; limit?: number } = {}): ZaloOutboxRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.threadId) { where.push('thread_id = ?'); params.push(opts.threadId); }
  if (opts.statuses?.length) {
    where.push(`status IN (${opts.statuses.map(() => '?').join(', ')})`);
    params.push(...opts.statuses);
  }
  const rows = db.prepare(
    `SELECT * FROM zalo_outbox ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(...params, Math.min(opts.limit ?? 50, 500)) as ZaloOutboxRow[];
  return rows.map(decryptOutbox);
}

/**
 * Move each mention to where its @tag now sits in an edited body; a tag the
 * operator deleted loses its mention.
 */
function reanchorZaloMentions(oldBody: string, newBody: string, mentionsJson: string | null): string | null {
  let mentions: Array<{ pos: number; len: number }>;
  try { mentions = mentionsJson ? JSON.parse(mentionsJson) : []; } catch { return null; }
  if (!Array.isArray(mentions) || mentions.length === 0) return null;
  const out: unknown[] = [];
  let from = 0;
  for (const m of [...mentions].sort((a, b) => a.pos - b.pos)) {
    const tag = oldBody.slice(m.pos, m.pos + m.len);
    const at = tag ? newBody.indexOf(tag, from) : -1;
    if (at < 0) continue;
    out.push({ ...m, pos: at });
    from = at + tag.length;
  }
  return out.length ? JSON.stringify(out) : null;
}

/** Shared inbox: pending → discarded, only while the sender has not claimed the row (claiming flips it to 'sending'). */
export function cancelZaloPending(id: number): boolean {
  return db.prepare(`UPDATE zalo_outbox SET status = 'discarded' WHERE id = ? AND status = 'pending'`).run(id).changes > 0;
}

// @zalo-db:care-inbox
// Shared inbox v2: cache of inbound media (src/zalo/media-cache.ts). Times are seconds.

export interface ZaloMediaCacheRow {
  message_id: number;
  idx: number;
  rel_path: string;
  mime: string;
  file_name: string;
  size: number;
  fetched_at: number;
  /** '' = stored; otherwise the short reason of the last failed download. */
  error: string;
}

export function getZaloMediaCache(messageId: number, idx: number): ZaloMediaCacheRow | undefined {
  return db.prepare(`SELECT * FROM zalo_media_cache WHERE message_id = ? AND idx = ?`).get(messageId, idx) as ZaloMediaCacheRow | undefined;
}

export function saveZaloMediaCache(input: Omit<ZaloMediaCacheRow, 'fetched_at'> & { fetched_at?: number }): void {
  db.prepare(
    `INSERT INTO zalo_media_cache (message_id, idx, rel_path, mime, file_name, size, fetched_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id, idx) DO UPDATE SET
       rel_path = excluded.rel_path, mime = excluded.mime, file_name = excluded.file_name,
       size = excluded.size, fetched_at = excluded.fetched_at, error = excluded.error`,
  ).run(input.message_id, input.idx, input.rel_path, input.mime, input.file_name, input.size, input.fetched_at ?? nowSec(), input.error);
}

export function deleteZaloMediaCache(messageId: number, idx: number): void {
  db.prepare(`DELETE FROM zalo_media_cache WHERE message_id = ? AND idx = ?`).run(messageId, idx);
}

// Zalo feature sections — each owner adds its functions under its marker.

// @zalo-db:protection
// Anti-ban protection: settings, per-day SDK usage, opt-outs. The limiter and
// quiet-hours math live in src/zalo/limits.ts and read these.

const ZALO_LIMIT_CATEGORIES = [
  'message', 'chat_action', 'reaction', 'group_read', 'query',
  'friend_lookup', 'friend_action', 'profile', 'contact_sync',
] as const;

/** Partial per-category override; absent field = fall through to the next level. */
export interface ZaloLimitOverride {
  daily?: number;
  burst?: number;
  windowSec?: number;
}
export type ZaloLimitOverrides = Partial<Record<(typeof ZALO_LIMIT_CATEGORIES)[number], ZaloLimitOverride>>;

export interface ZaloProtectionSettings {
  /** IANA timezone used for quiet hours and for "today" in every daily quota. */
  timezone: string;
  quietHours: { enabled: boolean; start: string; end: string };
  /** Replies (sent + drafted) one agent may produce per day across all threads. */
  agentDailyReplyCap: number;
  /** Consecutive Zalo rejections before a nick is locked; 0 = never auto-lock. */
  restrictionLockThreshold: number;
  /** Messages/day for warm-up weeks 1..n. */
  warmupSchedule: number[];
  /** Share of the nick's daily cap marketing sends may use. */
  bulkSharePercent: number;
  /** Global per-category overrides (below per-nick overrides, above code defaults). */
  limits: ZaloLimitOverrides;
}

export const ZALO_PROTECTION_DEFAULTS: ZaloProtectionSettings = {
  timezone: 'Asia/Ho_Chi_Minh',
  quietHours: { enabled: true, start: '22:00', end: '07:00' },
  agentDailyReplyCap: 500,
  restrictionLockThreshold: 3,
  warmupSchedule: [30, 80, 150],
  bulkSharePercent: 60,
  limits: {},
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : fallback;
}

function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function validClock(v: unknown): v is string {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

/** Keep only known categories and positive integer fields; drops empty entries. */
export function sanitizeZaloLimitOverrides(raw: unknown): ZaloLimitOverrides {
  const out: ZaloLimitOverrides = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const cat of ZALO_LIMIT_CATEGORIES) {
    const o = (raw as Record<string, unknown>)[cat];
    if (!o || typeof o !== 'object') continue;
    const entry: ZaloLimitOverride = {};
    const f = o as Record<string, unknown>;
    if (f.daily !== undefined && f.daily !== null && f.daily !== '') entry.daily = clampInt(f.daily, 1, 100_000, 1);
    if (f.burst !== undefined && f.burst !== null && f.burst !== '') entry.burst = clampInt(f.burst, 1, 1_000, 1);
    if (f.windowSec !== undefined && f.windowSec !== null && f.windowSec !== '') entry.windowSec = clampInt(f.windowSec, 1, 3_600, 30);
    if (Object.keys(entry).length > 0) out[cat] = entry;
  }
  return out;
}

/** Merge a partial/untrusted object over a base, clamping every field. */
function mergeProtectionSettings(base: ZaloProtectionSettings, raw: unknown): ZaloProtectionSettings {
  if (!raw || typeof raw !== 'object') return base;
  const p = raw as Record<string, unknown>;
  const q = (p.quietHours && typeof p.quietHours === 'object' ? p.quietHours : {}) as Record<string, unknown>;
  const schedule = Array.isArray(p.warmupSchedule)
    ? p.warmupSchedule.slice(0, 8).map((n) => clampInt(n, 1, 2000, 0)).filter((n) => n > 0)
    : [];
  return {
    timezone: validTimezone(p.timezone) ? p.timezone : base.timezone,
    quietHours: {
      enabled: typeof q.enabled === 'boolean' ? q.enabled : base.quietHours.enabled,
      start: validClock(q.start) ? q.start : base.quietHours.start,
      end: validClock(q.end) ? q.end : base.quietHours.end,
    },
    agentDailyReplyCap: p.agentDailyReplyCap !== undefined ? clampInt(p.agentDailyReplyCap, 1, 5000, base.agentDailyReplyCap) : base.agentDailyReplyCap,
    restrictionLockThreshold: p.restrictionLockThreshold !== undefined ? clampInt(p.restrictionLockThreshold, 0, 20, base.restrictionLockThreshold) : base.restrictionLockThreshold,
    warmupSchedule: schedule.length > 0 ? schedule : base.warmupSchedule,
    bulkSharePercent: p.bulkSharePercent !== undefined ? clampInt(p.bulkSharePercent, 0, 100, base.bulkSharePercent) : base.bulkSharePercent,
    limits: p.limits !== undefined ? sanitizeZaloLimitOverrides(p.limits) : base.limits,
  };
}

/** Stored protection settings merged over the defaults. Never throws. */
export function getZaloProtectionSettings(): ZaloProtectionSettings {
  try {
    const row = db.prepare(`SELECT value FROM zalo_settings WHERE key = 'protection'`).get() as { value: string } | undefined;
    if (!row) return ZALO_PROTECTION_DEFAULTS;
    return mergeProtectionSettings(ZALO_PROTECTION_DEFAULTS, JSON.parse(row.value));
  } catch {
    return ZALO_PROTECTION_DEFAULTS;
  }
}

/** Validate and persist a partial update; returns the resulting full settings. */
export function saveZaloProtectionSettings(partial: unknown): ZaloProtectionSettings {
  const merged = mergeProtectionSettings(getZaloProtectionSettings(), partial);
  db.prepare(
    `INSERT INTO zalo_settings (key, value, updated_at) VALUES ('protection', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(merged), nowSec());
  return merged;
}

/** Today's usage per category for one nick (`day` = local date, YYYY-MM-DD). */
export function getZaloUsage(accountId: string, day: string): Record<string, number> {
  const rows = db.prepare(`SELECT category, count FROM zalo_usage WHERE account_id = ? AND day = ?`)
    .all(accountId, day) as Array<{ category: string; count: number }>;
  return Object.fromEntries(rows.map((r) => [r.category, r.count]));
}

export function addZaloUsage(accountId: string, day: string, category: string, by = 1): void {
  db.prepare(
    `INSERT INTO zalo_usage (account_id, day, category, count) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, day, category) DO UPDATE SET count = count + excluded.count`,
  ).run(accountId, day, category, by);
}

/** Drop usage rows older than `keepDays` (local dates sort lexicographically). */
export function pruneZaloUsage(beforeDay: string): number {
  return db.prepare(`DELETE FROM zalo_usage WHERE day < ?`).run(beforeDay).changes;
}

/** Marketing (broadcast) messages this nick sent since `sinceMs`. */
export function countZaloBroadcastSince(accountId: string, sinceMs: number): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM zalo_messages m JOIN zalo_threads t ON t.id = m.thread_id
     WHERE t.account_id = ? AND m.sender_type = 'broadcast' AND m.origin != 'backfill' AND m.sent_at >= ?`,
  ).get(accountId, sinceMs) as { n: number }).n;
}

export function setZaloThreadOptedOut(threadId: number, optedOut: boolean): void {
  db.prepare(`UPDATE zalo_threads SET opted_out = ?, opted_out_at = ? WHERE id = ?`)
    .run(optedOut ? 1 : 0, optedOut ? nowSec() : null, threadId);
}

// @zalo-db:templates

export interface ZaloMediaRow {
  id: number;
  file_name: string;
  mime: string;
  kind: 'image' | 'file' | 'video';
  size: number;
  rel_path: string;
  created_at: number;
}

export function insertZaloMedia(input: Omit<ZaloMediaRow, 'id' | 'created_at'>): ZaloMediaRow {
  const info = db.prepare(
    `INSERT INTO zalo_media (file_name, mime, kind, size, rel_path, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.file_name, input.mime, input.kind, input.size, input.rel_path, nowSec());
  return getZaloMedia(Number(info.lastInsertRowid))!;
}

export function getZaloMedia(id: number): ZaloMediaRow | undefined {
  return db.prepare(`SELECT * FROM zalo_media WHERE id = ?`).get(id) as ZaloMediaRow | undefined;
}

export function deleteZaloMediaRow(id: number): boolean {
  return db.prepare(`DELETE FROM zalo_media WHERE id = ?`).run(id).changes > 0;
}

export interface ZaloTemplateRow {
  id: number;
  name: string;
  text: string;
  styles: ZaloStyle[];
  attachments: Array<ZaloAttachment & { mediaId: number }>;
  created_at: number;
  updated_at: number;
}

export interface ZaloTemplateInput {
  name: string;
  text: string;
  styles: ZaloStyle[];
  /** zalo_media ids, in send order. */
  attachmentIds: number[];
}

interface ZaloTemplateDbRow {
  id: number;
  name: string;
  body: string;
  styles_json: string;
  attachments_json: string;
  created_at: number;
  updated_at: number;
}

function parseJsonArray(raw: string): unknown[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Media ids a template row references (also used to find orphaned uploads). */
function templateMediaIds(row: Pick<ZaloTemplateDbRow, 'attachments_json'>): number[] {
  return parseJsonArray(row.attachments_json).filter((v): v is number => Number.isInteger(v));
}

function hydrateZaloTemplate(row: ZaloTemplateDbRow): ZaloTemplateRow {
  const attachments: ZaloTemplateRow['attachments'] = [];
  for (const mediaId of templateMediaIds(row)) {
    const media = getZaloMedia(mediaId);
    // A deleted upload just drops out of the template instead of breaking sends.
    if (!media) continue;
    attachments.push({ mediaId, path: path.join(ZALO_MEDIA_DIR, media.rel_path), kind: media.kind, name: media.file_name });
  }
  return {
    id: row.id,
    name: row.name,
    text: row.body,
    styles: normalizeZaloStyles(parseJsonArray(row.styles_json), row.body.length),
    attachments,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getZaloTemplate(id: number): ZaloTemplateRow | undefined {
  const row = db.prepare(`SELECT * FROM zalo_templates WHERE id = ?`).get(id) as ZaloTemplateDbRow | undefined;
  return row ? hydrateZaloTemplate(row) : undefined;
}

export function listZaloTemplates(): ZaloTemplateRow[] {
  const rows = db.prepare(`SELECT * FROM zalo_templates ORDER BY updated_at DESC, id DESC`).all() as ZaloTemplateDbRow[];
  return rows.map(hydrateZaloTemplate);
}

export function createZaloTemplate(input: ZaloTemplateInput): ZaloTemplateRow {
  const now = nowSec();
  const info = db.prepare(
    `INSERT INTO zalo_templates (name, body, styles_json, attachments_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.name, input.text, JSON.stringify(input.styles), JSON.stringify(input.attachmentIds), now, now);
  return getZaloTemplate(Number(info.lastInsertRowid))!;
}

/** Returns the updated row plus the media ids it no longer references. */
export function updateZaloTemplate(id: number, input: ZaloTemplateInput): { row: ZaloTemplateRow; removedMediaIds: number[] } | undefined {
  const before = db.prepare(`SELECT * FROM zalo_templates WHERE id = ?`).get(id) as ZaloTemplateDbRow | undefined;
  if (!before) return undefined;
  db.prepare(
    `UPDATE zalo_templates SET name = ?, body = ?, styles_json = ?, attachments_json = ?, updated_at = ? WHERE id = ?`,
  ).run(input.name, input.text, JSON.stringify(input.styles), JSON.stringify(input.attachmentIds), nowSec(), id);
  const kept = new Set(input.attachmentIds);
  return { row: getZaloTemplate(id)!, removedMediaIds: templateMediaIds(before).filter((m) => !kept.has(m)) };
}

/** Returns the media ids the deleted template referenced, or null when it did not exist. */
export function deleteZaloTemplate(id: number): number[] | null {
  const row = db.prepare(`SELECT * FROM zalo_templates WHERE id = ?`).get(id) as ZaloTemplateDbRow | undefined;
  if (!row) return null;
  db.prepare(`DELETE FROM zalo_templates WHERE id = ?`).run(id);
  return templateMediaIds(row);
}

/** True while any template still lists this upload. */
export function isZaloMediaReferenced(mediaId: number): boolean {
  const rows = db.prepare(`SELECT attachments_json FROM zalo_templates`).all() as Array<{ attachments_json: string }>;
  return rows.some((r) => templateMediaIds(r).includes(mediaId));
}

/** Uploads older than `olderThanSec` that no template references (abandoned editor sessions). */
export function listUnreferencedZaloMedia(olderThanSec: number): ZaloMediaRow[] {
  const cutoff = nowSec() - olderThanSec;
  const old = db.prepare(`SELECT * FROM zalo_media WHERE created_at < ?`).all(cutoff) as ZaloMediaRow[];
  return old.filter((m) => !isZaloMediaReferenced(m.id));
}

// @zalo-db:group-broadcast

export type ZaloBroadcastScheduleKind = 'now' | 'daily' | 'weekly' | 'monthly';
export type ZaloBroadcastState = 'draft' | 'active' | 'paused' | 'completed' | 'cancelled';
export type ZaloBroadcastTrigger = 'schedule' | 'manual' | 'retry';
export type ZaloBroadcastRunState = 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'skipped';
export type ZaloBroadcastTargetState = 'pending' | 'sent' | 'failed' | 'skipped';

export interface ZaloBroadcastRow {
  id: number;
  name: string;
  account_id: string;
  template_id: number;
  /** zalo_threads ids of the groups (all belong to account_id). */
  target_thread_ids: number[];
  schedule_kind: ZaloBroadcastScheduleKind;
  times_of_day: string[];
  days_of_week: number[];
  days_of_month: number[];
  timezone: string;
  start_date: string | null;
  end_date: string | null;
  min_delay_sec: number;
  max_delay_sec: number;
  state: ZaloBroadcastState;
  paused_reason: string;
  consecutive_failed_runs: number;
  next_run_at: number | null;
  /** Occurrences before this instant are never caught up (set on activate/resume). */
  activated_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ZaloBroadcastRunRow {
  id: number;
  broadcast_id: number;
  scheduled_for: number;
  triggered_by: ZaloBroadcastTrigger;
  state: ZaloBroadcastRunState;
  skip_reason: string;
  total_targets: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface ZaloBroadcastTargetRow {
  id: number;
  run_id: number;
  thread_id: number;
  state: ZaloBroadcastTargetState;
  attempts: number;
  sent_steps: string[];
  error_code: string;
  error_message: string;
  message_ids: number[];
  sent_at: number | null;
}

export interface ZaloBroadcastInput {
  name: string;
  accountId: string;
  templateId: number;
  targetThreadIds: number[];
  scheduleKind: ZaloBroadcastScheduleKind;
  timesOfDay: string[];
  daysOfWeek: number[];
  daysOfMonth: number[];
  timezone: string;
  startDate: string | null;
  endDate: string | null;
  minDelaySec: number;
  maxDelaySec: number;
}

function parseJsonList<T>(raw: string | null | undefined): T[] {
  try {
    const v = JSON.parse(raw || '[]') as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function broadcastFromRaw(r: Record<string, unknown>): ZaloBroadcastRow {
  return {
    ...(r as unknown as ZaloBroadcastRow),
    target_thread_ids: parseJsonList<number>(r.target_thread_ids as string),
    times_of_day: parseJsonList<string>(r.times_of_day as string),
    days_of_week: parseJsonList<number>(r.days_of_week as string),
    days_of_month: parseJsonList<number>(r.days_of_month as string),
  };
}

function broadcastTargetFromRaw(r: Record<string, unknown>): ZaloBroadcastTargetRow {
  return {
    ...(r as unknown as ZaloBroadcastTargetRow),
    sent_steps: parseJsonList<string>(r.sent_steps as string),
    message_ids: parseJsonList<number>(r.message_ids as string),
  };
}

export function createZaloBroadcast(input: ZaloBroadcastInput): ZaloBroadcastRow {
  const now = nowSec();
  const info = db.prepare(
    `INSERT INTO zalo_broadcasts
       (name, account_id, template_id, target_thread_ids, schedule_kind, times_of_day, days_of_week,
        days_of_month, timezone, start_date, end_date, min_delay_sec, max_delay_sec, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.name, input.accountId, input.templateId, JSON.stringify(input.targetThreadIds), input.scheduleKind,
    JSON.stringify(input.timesOfDay), JSON.stringify(input.daysOfWeek), JSON.stringify(input.daysOfMonth),
    input.timezone, input.startDate, input.endDate, input.minDelaySec, input.maxDelaySec, now, now,
  );
  return getZaloBroadcast(Number(info.lastInsertRowid))!;
}

export function getZaloBroadcast(id: number): ZaloBroadcastRow | undefined {
  const r = db.prepare(`SELECT * FROM zalo_broadcasts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? broadcastFromRaw(r) : undefined;
}

export function listZaloBroadcasts(): ZaloBroadcastRow[] {
  return (db.prepare(`SELECT * FROM zalo_broadcasts ORDER BY updated_at DESC, id DESC`).all() as Record<string, unknown>[])
    .map(broadcastFromRaw);
}

/** Campaigns the scheduler scans every tick ('now' campaigns only ever get manual runs). */
export function listScheduledActiveZaloBroadcasts(): ZaloBroadcastRow[] {
  return (db.prepare(`SELECT * FROM zalo_broadcasts WHERE state = 'active' AND schedule_kind != 'now'`).all() as Record<string, unknown>[])
    .map(broadcastFromRaw);
}

export function updateZaloBroadcast(id: number, patch: Partial<ZaloBroadcastInput>): void {
  const map: Array<[keyof ZaloBroadcastInput, string, (v: never) => unknown]> = [
    ['name', 'name', (v) => v],
    ['accountId', 'account_id', (v) => v],
    ['templateId', 'template_id', (v) => v],
    ['targetThreadIds', 'target_thread_ids', (v) => JSON.stringify(v)],
    ['scheduleKind', 'schedule_kind', (v) => v],
    ['timesOfDay', 'times_of_day', (v) => JSON.stringify(v)],
    ['daysOfWeek', 'days_of_week', (v) => JSON.stringify(v)],
    ['daysOfMonth', 'days_of_month', (v) => JSON.stringify(v)],
    ['timezone', 'timezone', (v) => v],
    ['startDate', 'start_date', (v) => v],
    ['endDate', 'end_date', (v) => v],
    ['minDelaySec', 'min_delay_sec', (v) => v],
    ['maxDelaySec', 'max_delay_sec', (v) => v],
  ];
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column, encode] of map) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(encode(patch[key] as never));
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE zalo_broadcasts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, nowSec(), id);
}

export function setZaloBroadcastState(
  id: number,
  state: ZaloBroadcastState,
  extra: { pausedReason?: string; nextRunAt?: number | null; activatedAt?: number | null; consecutiveFailedRuns?: number } = {},
): void {
  const sets = ['state = ?', 'paused_reason = ?'];
  const values: unknown[] = [state, extra.pausedReason ?? ''];
  if (extra.nextRunAt !== undefined) { sets.push('next_run_at = ?'); values.push(extra.nextRunAt); }
  if (extra.activatedAt !== undefined) { sets.push('activated_at = ?'); values.push(extra.activatedAt); }
  if (extra.consecutiveFailedRuns !== undefined) { sets.push('consecutive_failed_runs = ?'); values.push(extra.consecutiveFailedRuns); }
  db.prepare(`UPDATE zalo_broadcasts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, nowSec(), id);
}

/**
 * Bookkeeping that must not bump updated_at: the list is sorted by it, and the
 * scheduler tick would otherwise reorder campaigns every minute.
 */
export function setZaloBroadcastNextRun(id: number, nextRunAt: number | null): void {
  db.prepare(`UPDATE zalo_broadcasts SET next_run_at = ? WHERE id = ?`).run(nextRunAt, id);
}

export function setZaloBroadcastFailureCount(id: number, count: number): void {
  db.prepare(`UPDATE zalo_broadcasts SET consecutive_failed_runs = ? WHERE id = ?`).run(count, id);
}

export function deleteZaloBroadcast(id: number): void {
  db.transaction(() => {
    db.prepare(
      `DELETE FROM zalo_broadcast_targets WHERE run_id IN (SELECT id FROM zalo_broadcast_runs WHERE broadcast_id = ?)`,
    ).run(id);
    db.prepare(`DELETE FROM zalo_broadcast_runs WHERE broadcast_id = ?`).run(id);
    db.prepare(`DELETE FROM zalo_broadcasts WHERE id = ?`).run(id);
  })();
}

/**
 * Create a run with one pending target per thread. Returns null when a run for
 * the same (broadcast, scheduled_for, trigger) already exists — that unique key
 * is what makes the scheduler tick idempotent.
 */
export function insertZaloBroadcastRun(input: {
  broadcastId: number;
  scheduledFor: number;
  triggeredBy: ZaloBroadcastTrigger;
  targets: Array<{ threadId: number; attempts?: number; sentSteps?: string[]; messageIds?: number[] }>;
}): ZaloBroadcastRunRow | null {
  return db.transaction(() => {
    const info = db.prepare(
      `INSERT OR IGNORE INTO zalo_broadcast_runs (broadcast_id, scheduled_for, triggered_by, total_targets, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(input.broadcastId, input.scheduledFor, input.triggeredBy, input.targets.length, nowSec());
    if (info.changes === 0) return null;
    const runId = Number(info.lastInsertRowid);
    const insert = db.prepare(
      `INSERT INTO zalo_broadcast_targets (run_id, thread_id, attempts, sent_steps, message_ids) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const t of input.targets) {
      insert.run(runId, t.threadId, t.attempts ?? 0, JSON.stringify(t.sentSteps ?? []), JSON.stringify(t.messageIds ?? []));
    }
    return getZaloBroadcastRun(runId)!;
  })();
}

export function getZaloBroadcastRun(id: number): ZaloBroadcastRunRow | undefined {
  return db.prepare(`SELECT * FROM zalo_broadcast_runs WHERE id = ?`).get(id) as ZaloBroadcastRunRow | undefined;
}

export function listZaloBroadcastRuns(broadcastId: number, limit = 20): ZaloBroadcastRunRow[] {
  return db.prepare(
    `SELECT * FROM zalo_broadcast_runs WHERE broadcast_id = ? ORDER BY scheduled_for DESC, id DESC LIMIT ?`,
  ).all(broadcastId, Math.min(Math.max(limit, 1), 200)) as ZaloBroadcastRunRow[];
}

export function getLatestZaloBroadcastRun(broadcastId: number): ZaloBroadcastRunRow | undefined {
  return listZaloBroadcastRuns(broadcastId, 1)[0];
}

/** Atomically take the oldest pending run (pending → running). */
export function claimNextZaloBroadcastRun(): ZaloBroadcastRunRow | null {
  return db.transaction(() => {
    const next = db.prepare(
      `SELECT id FROM zalo_broadcast_runs WHERE state = 'pending' ORDER BY scheduled_for ASC, id ASC LIMIT 1`,
    ).get() as { id: number } | undefined;
    if (!next) return null;
    db.prepare(`UPDATE zalo_broadcast_runs SET state = 'running', started_at = ? WHERE id = ? AND state = 'pending'`)
      .run(nowSec(), next.id);
    return getZaloBroadcastRun(next.id) ?? null;
  })();
}

export function hasOtherRunningZaloBroadcastRun(broadcastId: number, exceptRunId: number): boolean {
  return db.prepare(
    `SELECT 1 FROM zalo_broadcast_runs WHERE broadcast_id = ? AND id != ? AND state = 'running' LIMIT 1`,
  ).get(broadcastId, exceptRunId) !== undefined;
}

export function hasZaloBroadcastRunStartedSince(broadcastId: number, exceptRunId: number, sinceSec: number): boolean {
  return db.prepare(
    `SELECT 1 FROM zalo_broadcast_runs WHERE broadcast_id = ? AND id != ? AND started_at IS NOT NULL AND started_at >= ? LIMIT 1`,
  ).get(broadcastId, exceptRunId, sinceSec) !== undefined;
}

export function hasActiveZaloBroadcastRun(broadcastId: number): boolean {
  return db.prepare(
    `SELECT 1 FROM zalo_broadcast_runs WHERE broadcast_id = ? AND state IN ('pending', 'running') LIMIT 1`,
  ).get(broadcastId) !== undefined;
}

export function countZaloBroadcastTargets(runId: number): Record<ZaloBroadcastTargetState, number> {
  const rows = db.prepare(
    `SELECT state, COUNT(*) AS n FROM zalo_broadcast_targets WHERE run_id = ? GROUP BY state`,
  ).all(runId) as Array<{ state: ZaloBroadcastTargetState; n: number }>;
  const out: Record<ZaloBroadcastTargetState, number> = { pending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const r of rows) out[r.state] = r.n;
  return out;
}

export function finishZaloBroadcastRun(
  id: number,
  result: { state: ZaloBroadcastRunState; skipReason?: string; counts?: Record<ZaloBroadcastTargetState, number> },
): void {
  const c = result.counts;
  db.prepare(
    `UPDATE zalo_broadcast_runs
     SET state = ?, skip_reason = ?, finished_at = ?,
         sent_count = COALESCE(?, sent_count), failed_count = COALESCE(?, failed_count),
         skipped_count = COALESCE(?, skipped_count)
     WHERE id = ?`,
  ).run(result.state, result.skipReason ?? '', nowSec(), c?.sent ?? null, c?.failed ?? null, c?.skipped ?? null, id);
}

export function listZaloBroadcastTargets(runId: number, filter: { state?: ZaloBroadcastTargetState } = {}): ZaloBroadcastTargetRow[] {
  const rows = filter.state
    ? db.prepare(`SELECT * FROM zalo_broadcast_targets WHERE run_id = ? AND state = ? ORDER BY id`).all(runId, filter.state)
    : db.prepare(`SELECT * FROM zalo_broadcast_targets WHERE run_id = ? ORDER BY id`).all(runId);
  return (rows as Record<string, unknown>[]).map(broadcastTargetFromRaw);
}

export function updateZaloBroadcastTarget(
  id: number,
  patch: {
    state?: ZaloBroadcastTargetState;
    attempts?: number;
    sentSteps?: string[];
    messageIds?: number[];
    errorCode?: string;
    errorMessage?: string;
    sentAt?: number | null;
  },
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => { sets.push(`${column} = ?`); values.push(value); };
  if (patch.state !== undefined) add('state', patch.state);
  if (patch.attempts !== undefined) add('attempts', patch.attempts);
  if (patch.sentSteps !== undefined) add('sent_steps', JSON.stringify(patch.sentSteps));
  if (patch.messageIds !== undefined) add('message_ids', JSON.stringify(patch.messageIds));
  if (patch.errorCode !== undefined) add('error_code', patch.errorCode);
  if (patch.errorMessage !== undefined) add('error_message', patch.errorMessage.slice(0, 500));
  if (patch.sentAt !== undefined) add('sent_at', patch.sentAt);
  if (sets.length === 0) return;
  db.prepare(`UPDATE zalo_broadcast_targets SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
}

/** Runs left 'running' by a previous daemon: concurrency is 1, so none can be live at boot. */
export function failInterruptedZaloBroadcastRuns(): number {
  return db.prepare(
    `UPDATE zalo_broadcast_runs SET state = 'failed', skip_reason = 'INTERRUPTED', finished_at = ? WHERE state = 'running'`,
  ).run(nowSec()).changes;
}

export function sweepZaloBroadcastRuns(
  nowSecs: number,
  limits: { pendingMaxAgeSec: number; runningMaxAgeSec: number },
): { stale: number; stuck: number } {
  const stale = db.prepare(
    `UPDATE zalo_broadcast_runs SET state = 'skipped', skip_reason = 'STALE', finished_at = ?
     WHERE state = 'pending' AND created_at < ?`,
  ).run(nowSecs, nowSecs - limits.pendingMaxAgeSec).changes;
  const stuck = db.prepare(
    `UPDATE zalo_broadcast_runs SET state = 'failed', skip_reason = 'STUCK', finished_at = ?
     WHERE state = 'running' AND started_at < ?`,
  ).run(nowSecs, nowSecs - limits.runningMaxAgeSec).changes;
  return { stale, stuck };
}

// @zalo-db:list-broadcast
export type ZaloListBroadcastState = 'draft' | 'active' | 'paused' | 'completed' | 'cancelled';
export type ZaloListRecipientState = 'pending' | 'sent' | 'failed' | 'skipped';

/** Who a list broadcast targets, beyond "1-1 chats of the chosen nicks, not opted out". */
export interface ZaloListFilter {
  /** Only chats with a message in the last N days. */
  activeWithinDays?: number | null;
  /** Diacritic-insensitive substring of the customer's name. */
  nameContains?: string;
  /** Skip chats an agent/human handoff currently pauses (default true). */
  excludePaused?: boolean;
  /** Thread ids removed by hand. */
  excludeThreadIds?: number[];
  /** Thread ids added by hand even when the other filters would drop them. */
  includeThreadIds?: number[];
}

export interface ZaloListBroadcast {
  id: number;
  name: string;
  templateId: number;
  accountIds: string[];
  filter: ZaloListFilter;
  windowStart: string;
  windowEnd: string;
  daysOfWeek: number[];
  timezone: string;
  startDate: string | null;
  endDate: string | null;
  dailyQuota: number;
  perNickDailyQuota: number;
  minDelaySec: number;
  maxDelaySec: number;
  state: ZaloListBroadcastState;
  pausedReason: string;
  consecutiveFailedBatches: number;
  lastEmptyBatchAt: number | null;
  recipientsSyncedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ZaloListBroadcastInput {
  name: string;
  templateId: number;
  accountIds: string[];
  filter: ZaloListFilter;
  windowStart: string;
  windowEnd: string;
  daysOfWeek: number[];
  timezone: string;
  startDate: string | null;
  endDate: string | null;
  dailyQuota: number;
  perNickDailyQuota: number;
  minDelaySec: number;
  maxDelaySec: number;
}

export interface ZaloListRecipientRow {
  id: number;
  broadcast_id: number;
  thread_id: number;
  account_id: string;
  name_snapshot: string;
  state: ZaloListRecipientState;
  sent_steps: number;
  attempts: number;
  error_code: string;
  sent_at: number | null;
  created_at: number;
}

export interface ZaloListBatchRow {
  id: number;
  broadcast_id: number;
  started_at: number;
  finished_at: number | null;
  sent: number;
  failed: number;
  skipped: number;
  stop_reason: string;
}

export interface ZaloListCounts {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
}

function parseJsonOr<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function toListBroadcast(r: Record<string, unknown>): ZaloListBroadcast {
  return {
    id: r.id as number,
    name: r.name as string,
    templateId: r.template_id as number,
    accountIds: parseJsonOr<string[]>(r.account_ids as string, []),
    filter: parseJsonOr<ZaloListFilter>(r.filter_json as string, {}),
    windowStart: r.window_start as string,
    windowEnd: r.window_end as string,
    daysOfWeek: parseJsonOr<number[]>(r.days_of_week as string, []),
    timezone: r.timezone as string,
    startDate: (r.start_date as string | null) ?? null,
    endDate: (r.end_date as string | null) ?? null,
    dailyQuota: r.daily_quota as number,
    perNickDailyQuota: r.per_nick_daily_quota as number,
    minDelaySec: r.min_delay_sec as number,
    maxDelaySec: r.max_delay_sec as number,
    state: r.state as ZaloListBroadcastState,
    pausedReason: r.paused_reason as string,
    consecutiveFailedBatches: r.consecutive_failed_batches as number,
    lastEmptyBatchAt: (r.last_empty_batch_at as number | null) ?? null,
    recipientsSyncedAt: (r.recipients_synced_at as number | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export function createZaloListBroadcast(input: ZaloListBroadcastInput): ZaloListBroadcast {
  const now = nowSec();
  const row = db.prepare(
    `INSERT INTO zalo_list_broadcasts
       (name, template_id, account_ids, filter_json, window_start, window_end, days_of_week, timezone,
        start_date, end_date, daily_quota, per_nick_daily_quota, min_delay_sec, max_delay_sec, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(
    input.name, input.templateId, JSON.stringify(input.accountIds), JSON.stringify(input.filter),
    input.windowStart, input.windowEnd, JSON.stringify(input.daysOfWeek), input.timezone,
    input.startDate, input.endDate, input.dailyQuota, input.perNickDailyQuota,
    input.minDelaySec, input.maxDelaySec, now, now,
  ) as Record<string, unknown>;
  return toListBroadcast(row);
}

export function updateZaloListBroadcast(id: number, input: ZaloListBroadcastInput): ZaloListBroadcast | undefined {
  const row = db.prepare(
    `UPDATE zalo_list_broadcasts SET
       name = ?, template_id = ?, account_ids = ?, filter_json = ?, window_start = ?, window_end = ?,
       days_of_week = ?, timezone = ?, start_date = ?, end_date = ?, daily_quota = ?,
       per_nick_daily_quota = ?, min_delay_sec = ?, max_delay_sec = ?, updated_at = ?
     WHERE id = ? RETURNING *`,
  ).get(
    input.name, input.templateId, JSON.stringify(input.accountIds), JSON.stringify(input.filter),
    input.windowStart, input.windowEnd, JSON.stringify(input.daysOfWeek), input.timezone,
    input.startDate, input.endDate, input.dailyQuota, input.perNickDailyQuota,
    input.minDelaySec, input.maxDelaySec, nowSec(), id,
  ) as Record<string, unknown> | undefined;
  return row ? toListBroadcast(row) : undefined;
}

export function getZaloListBroadcast(id: number): ZaloListBroadcast | undefined {
  const row = db.prepare(`SELECT * FROM zalo_list_broadcasts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? toListBroadcast(row) : undefined;
}

export function listZaloListBroadcasts(state?: ZaloListBroadcastState): ZaloListBroadcast[] {
  const rows = (state
    ? db.prepare(`SELECT * FROM zalo_list_broadcasts WHERE state = ? ORDER BY id DESC`).all(state)
    : db.prepare(`SELECT * FROM zalo_list_broadcasts ORDER BY id DESC`).all()) as Record<string, unknown>[];
  return rows.map(toListBroadcast);
}

/** Delete a campaign with its recipients and batch log. */
export function deleteZaloListBroadcast(id: number): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM zalo_list_recipients WHERE broadcast_id = ?`).run(id);
    db.prepare(`DELETE FROM zalo_list_batches WHERE broadcast_id = ?`).run(id);
    db.prepare(`DELETE FROM zalo_list_broadcasts WHERE id = ?`).run(id);
  })();
}

export function setZaloListBroadcastState(id: number, state: ZaloListBroadcastState, pausedReason = ''): void {
  // Leaving a paused/failed streak (resume, re-activate) starts the safety counters afresh.
  const reset = state === 'active'
    ? `, consecutive_failed_batches = 0, last_empty_batch_at = NULL` : '';
  db.prepare(`UPDATE zalo_list_broadcasts SET state = ?, paused_reason = ?, updated_at = ?${reset} WHERE id = ?`)
    .run(state, pausedReason, nowSec(), id);
}

/** Record a finished batch's effect on the campaign's safety counters. */
export function setZaloListBroadcastBatchOutcome(
  id: number,
  patch: { consecutiveFailedBatches: number; lastEmptyBatchAt: number | null },
): void {
  db.prepare(`UPDATE zalo_list_broadcasts SET consecutive_failed_batches = ?, last_empty_batch_at = ?, updated_at = ? WHERE id = ?`)
    .run(patch.consecutiveFailedBatches, patch.lastEmptyBatchAt, nowSec(), id);
}

export function markZaloListRecipientsSynced(id: number): void {
  db.prepare(`UPDATE zalo_list_broadcasts SET recipients_synced_at = ?, updated_at = ? WHERE id = ?`)
    .run(nowSec(), nowSec(), id);
}

export interface ZaloListCandidate {
  threadId: number;
  accountId: string;
  name: string;
  lastMessageAt: number;
}

/**
 * Existing 1-1 chats of the given nicks that may be messaged: never opted out,
 * optionally active recently / not paused by a handoff, minus manual excludes.
 * `nameMatches` runs in JS because SQLite's LIKE can't fold Vietnamese
 * diacritics. Most recently active chats come first so a cap keeps the warm ones.
 */
export function findZaloListCandidates(
  accountIds: string[],
  filter: ZaloListFilter,
  opts: { nameMatches?: (name: string) => boolean; limit: number; nowMs?: number },
): ZaloListCandidate[] {
  if (accountIds.length === 0) return [];
  const nowMs = opts.nowMs ?? Date.now();
  const where = [`t.thread_type = 'user'`, `t.opted_out = 0`, `t.account_id IN (${accountIds.map(() => '?').join(',')})`];
  const params: unknown[] = [...accountIds];
  if (filter.activeWithinDays && filter.activeWithinDays > 0) {
    where.push('t.last_message_at >= ?');
    params.push(nowMs - filter.activeWithinDays * 86_400_000);
  }
  if (filter.excludePaused !== false) {
    where.push('(t.paused_until IS NULL OR t.paused_until <= ?)');
    params.push(Math.floor(nowMs / 1000));
  }
  const rows = db.prepare(
    `SELECT t.id, t.account_id, t.name, t.last_message_at FROM zalo_threads t
     WHERE ${where.join(' AND ')} ORDER BY t.last_message_at DESC, t.id DESC`,
  ).all(...params) as Array<{ id: number; account_id: string; name: string; last_message_at: number }>;

  const excluded = new Set(filter.excludeThreadIds ?? []);
  const out: ZaloListCandidate[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    if (excluded.has(r.id)) continue;
    if (opts.nameMatches && !opts.nameMatches(r.name)) continue;
    seen.add(r.id);
    out.push({ threadId: r.id, accountId: r.account_id, name: r.name, lastMessageAt: r.last_message_at });
    if (out.length >= opts.limit) return out;
  }

  // Manual includes bypass the soft filters but never the hard rules
  // (1-1 only, chosen nicks only, not opted out, not excluded).
  const include = (filter.includeThreadIds ?? []).filter((id) => !seen.has(id) && !excluded.has(id));
  if (include.length > 0) {
    const extra = db.prepare(
      `SELECT t.id, t.account_id, t.name, t.last_message_at FROM zalo_threads t
       WHERE t.thread_type = 'user' AND t.opted_out = 0
         AND t.account_id IN (${accountIds.map(() => '?').join(',')})
         AND t.id IN (${include.map(() => '?').join(',')})`,
    ).all(...accountIds, ...include) as Array<{ id: number; account_id: string; name: string; last_message_at: number }>;
    for (const r of extra) {
      if (out.length >= opts.limit) break;
      out.push({ threadId: r.id, accountId: r.account_id, name: r.name, lastMessageAt: r.last_message_at });
    }
  }
  return out;
}

/**
 * Add recipients; chats already in the campaign are left untouched. Stops once
 * `maxNew` new rows were added (the per-campaign cap) and reports whether
 * candidates were left over.
 */
export function addZaloListRecipients(
  broadcastId: number,
  rows: ZaloListCandidate[],
  maxNew = Number.POSITIVE_INFINITY,
): { added: number; capped: boolean } {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO zalo_list_recipients (broadcast_id, thread_id, account_id, name_snapshot, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const now = nowSec();
  let added = 0;
  let capped = false;
  db.transaction(() => {
    for (const r of rows) {
      if (added >= maxNew) { capped = true; break; }
      added += stmt.run(broadcastId, r.threadId, r.accountId, r.name, now).changes;
    }
  })();
  return { added, capped };
}

/** Nicks removed from a campaign: their still-pending recipients can no longer be served. */
export function skipZaloListRecipientsOutsideAccounts(broadcastId: number, accountIds: string[]): number {
  if (accountIds.length === 0) return 0;
  return db.prepare(
    `UPDATE zalo_list_recipients SET state = 'skipped', error_code = 'NICK_REMOVED'
     WHERE broadcast_id = ? AND state = 'pending' AND account_id NOT IN (${accountIds.map(() => '?').join(',')})`,
  ).run(broadcastId, ...accountIds).changes;
}

export function countZaloListRecipients(broadcastId: number): ZaloListCounts {
  const rows = db.prepare(
    `SELECT state, COUNT(*) AS n FROM zalo_list_recipients WHERE broadcast_id = ? GROUP BY state`,
  ).all(broadcastId) as Array<{ state: ZaloListRecipientState; n: number }>;
  const counts: ZaloListCounts = { total: 0, pending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const r of rows) { counts[r.state] = r.n; counts.total += r.n; }
  return counts;
}

export function listZaloListRecipients(
  broadcastId: number,
  opts: { state?: ZaloListRecipientState; limit?: number; offset?: number } = {},
): { recipients: ZaloListRecipientRow[]; total: number } {
  const where = ['broadcast_id = ?'];
  const params: unknown[] = [broadcastId];
  if (opts.state) { where.push('state = ?'); params.push(opts.state); }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const recipients = db.prepare(
    `SELECT * FROM zalo_list_recipients WHERE ${where.join(' AND ')} ORDER BY id LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as ZaloListRecipientRow[];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM zalo_list_recipients WHERE ${where.join(' AND ')}`)
    .get(...params) as { n: number }).n;
  return { recipients, total };
}

export function getZaloListRecipient(id: number): ZaloListRecipientRow | undefined {
  return db.prepare(`SELECT * FROM zalo_list_recipients WHERE id = ?`).get(id) as ZaloListRecipientRow | undefined;
}

/** Oldest pending recipients of one nick in a campaign. */
export function listPendingZaloListRecipients(broadcastId: number, accountId: string, limit: number): ZaloListRecipientRow[] {
  return db.prepare(
    `SELECT * FROM zalo_list_recipients WHERE broadcast_id = ? AND account_id = ? AND state = 'pending'
     ORDER BY id LIMIT ?`,
  ).all(broadcastId, accountId, limit) as ZaloListRecipientRow[];
}

export function updateZaloListRecipient(
  id: number,
  patch: Partial<Pick<ZaloListRecipientRow, 'state' | 'sent_steps' | 'attempts' | 'error_code' | 'sent_at'>>,
): void {
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (keys.length === 0) return;
  db.prepare(`UPDATE zalo_list_recipients SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => patch[k]), id);
}

/** Failed recipients with attempts left go back to pending; sent_steps is kept so no step repeats. */
export function requeueFailedZaloListRecipients(broadcastId: number, maxAttempts: number): number {
  return db.prepare(
    `UPDATE zalo_list_recipients SET state = 'pending', error_code = ''
     WHERE broadcast_id = ? AND state = 'failed' AND attempts < ?`,
  ).run(broadcastId, maxAttempts).changes;
}

/** Operator drops a pending/failed recipient from the campaign. */
export function skipZaloListRecipient(id: number): boolean {
  return db.prepare(
    `UPDATE zalo_list_recipients SET state = 'skipped', error_code = 'MANUAL' WHERE id = ? AND state IN ('pending', 'failed')`,
  ).run(id).changes > 0;
}

/**
 * Messages sent by list campaigns in [startSec, endSec): for a nick across ALL
 * campaigns (nick quota) and/or for one campaign (daily quota).
 */
export function countZaloListSent(filter: { accountId?: string; broadcastId?: number }, startSec: number, endSec: number): number {
  const where = [`state = 'sent'`, 'sent_at >= ?', 'sent_at < ?'];
  const params: unknown[] = [startSec, endSec];
  if (filter.accountId) { where.push('account_id = ?'); params.push(filter.accountId); }
  if (filter.broadcastId !== undefined) { where.push('broadcast_id = ?'); params.push(filter.broadcastId); }
  return (db.prepare(`SELECT COUNT(*) AS n FROM zalo_list_recipients WHERE ${where.join(' AND ')}`)
    .get(...params) as { n: number }).n;
}

/** Live facts about a thread right before sending to it. */
export function getZaloListThreadState(threadId: number): { name: string; optedOut: boolean; isUser: boolean } | undefined {
  const row = db.prepare(`SELECT name, opted_out, thread_type FROM zalo_threads WHERE id = ?`)
    .get(threadId) as { name: string; opted_out: number; thread_type: string } | undefined;
  return row ? { name: row.name, optedOut: row.opted_out === 1, isUser: row.thread_type === 'user' } : undefined;
}

export function startZaloListBatch(broadcastId: number): number {
  return Number(db.prepare(`INSERT INTO zalo_list_batches (broadcast_id, started_at) VALUES (?, ?)`)
    .run(broadcastId, nowSec()).lastInsertRowid);
}

export function finishZaloListBatch(
  id: number,
  result: { sent: number; failed: number; skipped: number; stopReason: string },
): void {
  db.prepare(`UPDATE zalo_list_batches SET finished_at = ?, sent = ?, failed = ?, skipped = ?, stop_reason = ? WHERE id = ?`)
    .run(nowSec(), result.sent, result.failed, result.skipped, result.stopReason, id);
}

export function listZaloListBatches(broadcastId: number, limit = 20): ZaloListBatchRow[] {
  return db.prepare(`SELECT * FROM zalo_list_batches WHERE broadcast_id = ? ORDER BY id DESC LIMIT ?`)
    .all(broadcastId, limit) as ZaloListBatchRow[];
}

/** A batch the daemon died in the middle of (finished_at never set). Called once at worker start. */
export function closeDanglingZaloListBatches(): number {
  return db.prepare(`UPDATE zalo_list_batches SET finished_at = ?, stop_reason = 'RESTART' WHERE finished_at IS NULL`)
    .run(nowSec()).changes;
}

// @zalo-db:birthday

// ── Birthday greetings (C2) ──────────────────────────────────────────
// Birth dates live on zalo_threads.birth_date ('YYYY-MM-DD', '0000-MM-DD' when
// the year is unknown). Config is one row; greetings are the planned/sent queue.

export type ZaloBirthdayOccasion = 'before' | 'on_day' | 'after';
export type ZaloBirthdayState = 'pending' | 'sent' | 'failed' | 'skipped';

export interface ZaloBirthdayConfig {
  enabled: boolean;
  sendTime: string;
  timezone: string;
  lateToleranceMinutes: number;
  beforeEnabled: boolean;
  beforeDays: number;
  beforeTemplateId: number | null;
  onDayEnabled: boolean;
  onDayTemplateId: number | null;
  afterEnabled: boolean;
  afterDays: number;
  afterTemplateId: number | null;
  perNickDailyQuota: number;
  minDelaySec: number;
  maxDelaySec: number;
  /** Empty = every nick. */
  accountIds: string[];
  updatedAt: number;
}

export const ZALO_BIRTHDAY_DEFAULTS: ZaloBirthdayConfig = {
  enabled: false,
  sendTime: '09:00',
  timezone: 'Asia/Ho_Chi_Minh',
  lateToleranceMinutes: 180,
  beforeEnabled: false,
  beforeDays: 3,
  beforeTemplateId: null,
  onDayEnabled: true,
  onDayTemplateId: null,
  afterEnabled: false,
  afterDays: 1,
  afterTemplateId: null,
  perNickDailyQuota: 30,
  minDelaySec: 30,
  maxDelaySec: 90,
  accountIds: [],
  updatedAt: 0,
};

interface ZaloBirthdayConfigRow {
  enabled: number; send_time: string; timezone: string; late_tolerance_minutes: number;
  before_enabled: number; before_days: number; before_template_id: number | null;
  on_day_enabled: number; on_day_template_id: number | null;
  after_enabled: number; after_days: number; after_template_id: number | null;
  per_nick_daily_quota: number; min_delay_sec: number; max_delay_sec: number;
  account_ids: string; updated_at: number;
}

export function getZaloBirthdayConfig(): ZaloBirthdayConfig {
  const r = db.prepare(`SELECT * FROM zalo_birthday_config WHERE id = 1`).get() as ZaloBirthdayConfigRow | undefined;
  if (!r) return { ...ZALO_BIRTHDAY_DEFAULTS, accountIds: [] };
  let accountIds: string[] = [];
  try {
    const parsed = JSON.parse(r.account_ids);
    if (Array.isArray(parsed)) accountIds = parsed.map(String);
  } catch { /* keep [] = all nicks */ }
  return {
    enabled: r.enabled === 1,
    sendTime: r.send_time,
    timezone: r.timezone,
    lateToleranceMinutes: r.late_tolerance_minutes,
    beforeEnabled: r.before_enabled === 1,
    beforeDays: r.before_days,
    beforeTemplateId: r.before_template_id,
    onDayEnabled: r.on_day_enabled === 1,
    onDayTemplateId: r.on_day_template_id,
    afterEnabled: r.after_enabled === 1,
    afterDays: r.after_days,
    afterTemplateId: r.after_template_id,
    perNickDailyQuota: r.per_nick_daily_quota,
    minDelaySec: r.min_delay_sec,
    maxDelaySec: r.max_delay_sec,
    accountIds,
    updatedAt: r.updated_at,
  };
}

export function saveZaloBirthdayConfig(c: Omit<ZaloBirthdayConfig, 'updatedAt'>): ZaloBirthdayConfig {
  db.prepare(
    `INSERT INTO zalo_birthday_config (
       id, enabled, send_time, timezone, late_tolerance_minutes,
       before_enabled, before_days, before_template_id,
       on_day_enabled, on_day_template_id,
       after_enabled, after_days, after_template_id,
       per_nick_daily_quota, min_delay_sec, max_delay_sec, account_ids, updated_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       enabled = excluded.enabled, send_time = excluded.send_time, timezone = excluded.timezone,
       late_tolerance_minutes = excluded.late_tolerance_minutes,
       before_enabled = excluded.before_enabled, before_days = excluded.before_days,
       before_template_id = excluded.before_template_id,
       on_day_enabled = excluded.on_day_enabled, on_day_template_id = excluded.on_day_template_id,
       after_enabled = excluded.after_enabled, after_days = excluded.after_days,
       after_template_id = excluded.after_template_id,
       per_nick_daily_quota = excluded.per_nick_daily_quota,
       min_delay_sec = excluded.min_delay_sec, max_delay_sec = excluded.max_delay_sec,
       account_ids = excluded.account_ids, updated_at = excluded.updated_at`,
  ).run(
    c.enabled ? 1 : 0, c.sendTime, c.timezone, c.lateToleranceMinutes,
    c.beforeEnabled ? 1 : 0, c.beforeDays, c.beforeTemplateId,
    c.onDayEnabled ? 1 : 0, c.onDayTemplateId,
    c.afterEnabled ? 1 : 0, c.afterDays, c.afterTemplateId,
    c.perNickDailyQuota, c.minDelaySec, c.maxDelaySec, JSON.stringify(c.accountIds), nowSec(),
  );
  return getZaloBirthdayConfig();
}

// ── Birth dates on threads ───────────────────────────────────────────

/** Manual edit: set (or clear with null) a 1-1 thread's birth date and stamp the lookup time. */
export function setZaloThreadBirthDate(threadId: number, birthDate: string | null): boolean {
  return db.prepare(
    `UPDATE zalo_threads SET birth_date = ?, birth_date_checked_at = ? WHERE id = ? AND thread_type = 'user'`,
  ).run(birthDate, nowSec(), threadId).changes > 0;
}

/**
 * Record what a profile lookup found. Only fills an empty birth date (a manual
 * or earlier value wins) and only on 1-1 threads; the lookup time is stamped
 * either way so backfill does not ask again for 30 days. Returns true when a
 * birth date was written.
 */
export function noteZaloThreadBirthDate(threadId: number, birthDate: string | null): boolean {
  const info = db.prepare(
    `UPDATE zalo_threads SET
       birth_date = CASE WHEN birth_date IS NULL THEN ? ELSE birth_date END,
       birth_date_checked_at = ?
     WHERE id = ? AND thread_type = 'user'`,
  ).run(birthDate, nowSec(), threadId);
  if (info.changes === 0 || birthDate === null) return false;
  const row = db.prepare(`SELECT birth_date FROM zalo_threads WHERE id = ?`).get(threadId) as { birth_date: string | null };
  return row.birth_date === birthDate;
}

export function markZaloBirthDateChecked(threadId: number, atSec: number): void {
  db.prepare(`UPDATE zalo_threads SET birth_date_checked_at = ? WHERE id = ?`).run(atSec, threadId);
}

export interface ZaloBirthdayThread {
  id: number;
  account_id: string;
  external_id: string;
  name: string;
  birth_date: string | null;
  opted_out: number;
  thread_type: ZaloThreadType;
}

export function getZaloBirthdayThread(threadId: number): ZaloBirthdayThread | undefined {
  return db.prepare(
    `SELECT id, account_id, external_id, name, birth_date, opted_out, thread_type FROM zalo_threads WHERE id = ?`,
  ).get(threadId) as ZaloBirthdayThread | undefined;
}

/** 1-1 threads without a birth date that were not looked up recently, most active first. */
export function listZaloBirthDateBackfillCandidates(accountId: string, checkedBeforeSec: number, limit: number): ZaloBirthdayThread[] {
  return db.prepare(
    `SELECT id, account_id, external_id, name, birth_date, opted_out, thread_type FROM zalo_threads
     WHERE account_id = ? AND thread_type = 'user' AND birth_date IS NULL
       AND (birth_date_checked_at IS NULL OR birth_date_checked_at < ?)
     ORDER BY last_message_at DESC, id DESC LIMIT ?`,
  ).all(accountId, checkedBeforeSec, limit) as ZaloBirthdayThread[];
}

/** Profile lookups stamped since `sinceSec` — the per-day backfill budget survives restarts. */
export function countZaloBirthDateChecksSince(accountId: string, sinceSec: number): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM zalo_threads WHERE account_id = ? AND thread_type = 'user' AND birth_date_checked_at >= ?`,
  ).get(accountId, sinceSec) as { n: number }).n;
}

/**
 * 1-1 threads (not opted out) whose birthday matches one of `monthDays`
 * ('MM-DD'). `accountIds` empty = every nick.
 */
export function findZaloBirthdayThreads(monthDays: string[], accountIds: string[], limit = 500): ZaloBirthdayThread[] {
  if (monthDays.length === 0) return [];
  const where = [
    `thread_type = 'user'`,
    `opted_out = 0`,
    `birth_date IS NOT NULL`,
    `substr(birth_date, 6) IN (${monthDays.map(() => '?').join(',')})`,
  ];
  const params: unknown[] = [...monthDays];
  if (accountIds.length > 0) {
    where.push(`account_id IN (${accountIds.map(() => '?').join(',')})`);
    params.push(...accountIds);
  }
  return db.prepare(
    `SELECT id, account_id, external_id, name, birth_date, opted_out, thread_type FROM zalo_threads
     WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`,
  ).all(...params, limit) as ZaloBirthdayThread[];
}

export interface ZaloBirthdayNickStats {
  accountId: string;
  label: string;
  threads: number;
  withBirthDate: number;
}

/** Coverage per nick: how many 1-1 threads already have a birth date. */
export function getZaloBirthdayStats(): ZaloBirthdayNickStats[] {
  const rows = db.prepare(
    `SELECT a.id AS accountId, COALESCE(NULLIF(a.display_name, ''), a.label) AS label,
            COUNT(t.id) AS threads,
            COALESCE(SUM(CASE WHEN t.birth_date IS NOT NULL THEN 1 ELSE 0 END), 0) AS withBirthDate
     FROM zalo_accounts a
     LEFT JOIN zalo_threads t ON t.account_id = a.id AND t.thread_type = 'user'
     GROUP BY a.id ORDER BY a.created_at`,
  ).all() as ZaloBirthdayNickStats[];
  return rows;
}

// ── Greetings queue ──────────────────────────────────────────────────

export interface ZaloBirthdayGreetingRow {
  id: number;
  thread_id: number;
  account_id: string;
  occasion: ZaloBirthdayOccasion;
  birthday_on: string;
  due_at: number;
  state: ZaloBirthdayState;
  skip_reason: string;
  error_code: string;
  sent_steps: number;
  message_ids: string;
  sent_at: number | null;
  forced: number;
  created_at: number;
}

export interface ZaloBirthdayGreetingListRow extends ZaloBirthdayGreetingRow {
  thread_name: string;
  account_label: string;
  birth_date: string | null;
}

const BIRTHDAY_LIST_SELECT = `SELECT g.*, t.name AS thread_name, t.birth_date AS birth_date,
    COALESCE(NULLIF(a.display_name, ''), a.label, '') AS account_label
  FROM zalo_birthday_greetings g
  JOIN zalo_threads t ON t.id = g.thread_id
  LEFT JOIN zalo_accounts a ON a.id = g.account_id`;

/** INSERT OR IGNORE on the (thread, occasion, birthday) key. True when a new row was created. */
export function insertZaloBirthdayGreeting(input: {
  threadId: number;
  accountId: string;
  occasion: ZaloBirthdayOccasion;
  birthdayOn: string;
  dueAt: number;
}): boolean {
  return db.prepare(
    `INSERT OR IGNORE INTO zalo_birthday_greetings (thread_id, account_id, occasion, birthday_on, due_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.threadId, input.accountId, input.occasion, input.birthdayOn, input.dueAt, nowSec()).changes > 0;
}

/** Re-time still-pending greetings of an occasion after the send time changed (never ones forced by hand). */
export function retimePendingZaloBirthdayGreetings(occasion: ZaloBirthdayOccasion, birthdayOn: string, dueAt: number): number {
  return db.prepare(
    `UPDATE zalo_birthday_greetings SET due_at = ?
     WHERE state = 'pending' AND forced = 0 AND occasion = ? AND birthday_on = ? AND due_at != ?`,
  ).run(dueAt, occasion, birthdayOn, dueAt).changes;
}

/** Greetings whose due time falls in [startSec, endSec) — the planner's per-day cap. */
export function countZaloBirthdayGreetingsDueBetween(startSec: number, endSec: number): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM zalo_birthday_greetings WHERE due_at >= ? AND due_at < ?`,
  ).get(startSec, endSec) as { n: number }).n;
}

export function listDueZaloBirthdayGreetings(nowSecValue: number, limit: number): ZaloBirthdayGreetingRow[] {
  return db.prepare(
    `SELECT * FROM zalo_birthday_greetings WHERE state = 'pending' AND due_at <= ? ORDER BY due_at, id LIMIT ?`,
  ).all(nowSecValue, limit) as ZaloBirthdayGreetingRow[];
}

export function getZaloBirthdayGreeting(id: number): ZaloBirthdayGreetingRow | undefined {
  return db.prepare(`SELECT * FROM zalo_birthday_greetings WHERE id = ?`).get(id) as ZaloBirthdayGreetingRow | undefined;
}

export interface ZaloBirthdayGreetingPatch {
  state?: ZaloBirthdayState;
  skipReason?: string;
  errorCode?: string;
  sentSteps?: number;
  messageIds?: number[];
  sentAt?: number | null;
  dueAt?: number;
  forced?: boolean;
  accountId?: string;
}

export function updateZaloBirthdayGreeting(id: number, patch: ZaloBirthdayGreetingPatch): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, v: unknown) => { sets.push(`${col} = ?`); params.push(v); };
  if (patch.state !== undefined) add('state', patch.state);
  if (patch.skipReason !== undefined) add('skip_reason', patch.skipReason);
  if (patch.errorCode !== undefined) add('error_code', patch.errorCode);
  if (patch.sentSteps !== undefined) add('sent_steps', patch.sentSteps);
  if (patch.messageIds !== undefined) add('message_ids', JSON.stringify(patch.messageIds));
  if (patch.sentAt !== undefined) add('sent_at', patch.sentAt);
  if (patch.dueAt !== undefined) add('due_at', patch.dueAt);
  if (patch.forced !== undefined) add('forced', patch.forced ? 1 : 0);
  if (patch.accountId !== undefined) add('account_id', patch.accountId);
  if (sets.length === 0) return;
  db.prepare(`UPDATE zalo_birthday_greetings SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
}

/** Greetings a nick sent in [startSec, endSec) — drives its daily quota. */
export function countZaloBirthdaySentBetween(accountId: string, startSec: number, endSec: number): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM zalo_birthday_greetings WHERE account_id = ? AND state = 'sent' AND sent_at >= ? AND sent_at < ?`,
  ).get(accountId, startSec, endSec) as { n: number }).n;
}

export function listZaloBirthdayGreetings(opts: {
  states?: ZaloBirthdayState[];
  limit?: number;
  offset?: number;
} = {}): { greetings: ZaloBirthdayGreetingListRow[]; total: number } {
  const where = opts.states && opts.states.length > 0 ? `WHERE g.state IN (${opts.states.map(() => '?').join(',')})` : '';
  const params: unknown[] = opts.states ?? [];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const greetings = db.prepare(
    `${BIRTHDAY_LIST_SELECT} ${where} ORDER BY g.due_at DESC, g.id DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as ZaloBirthdayGreetingListRow[];
  const total = (db.prepare(
    `SELECT COUNT(*) AS n FROM zalo_birthday_greetings g ${where}`,
  ).get(...params) as { n: number }).n;
  return { greetings, total };
}

/** Greetings for birthdays on/between two 'YYYY-MM-DD' dates (inclusive). */
export function listZaloBirthdayGreetingsByBirthday(fromDate: string, toDate: string): ZaloBirthdayGreetingRow[] {
  return db.prepare(
    `SELECT * FROM zalo_birthday_greetings WHERE birthday_on >= ? AND birthday_on <= ?`,
  ).all(fromDate, toDate) as ZaloBirthdayGreetingRow[];
}

/** Account label for a nick (display name, else the label); '' when unknown. */
export function zaloAccountDisplayLabel(accountId: string): string {
  const row = db.prepare(
    `SELECT COALESCE(NULLIF(display_name, ''), label) AS l FROM zalo_accounts WHERE id = ?`,
  ).get(accountId) as { l: string } | undefined;
  return row?.l ?? '';
}

