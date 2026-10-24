import type { ModuleContext } from '../../../src/modules/sdk.js';


interface EmailAssignmentDbRow extends Omit<EmailAssignment, 'review_keywords' | 'primary_only' | 'enabled'> {
  review_keywords: string;
  primary_only: number;
  enabled: number;
}


export type EmailAccountStatus = 'ACTIVE' | 'EXPIRED' | 'MISSING';

export type EmailDirection = 'in' | 'out';

/** customer = the other side; self = written by the owner in Gmail itself;
 *  agent = sent by an assigned agent; operator = sent from the dashboard. */
export type EmailSenderType = 'customer' | 'self' | 'agent' | 'operator';

export type EmailCategory = 'primary' | 'promotions' | 'social' | 'updates' | 'forums' | '';

export type EmailAssignmentScope = 'account' | 'domain' | 'sender';

export type EmailAssignmentMode = 'observe' | 'draft' | 'auto';

/** queued = an auto reply waiting for its send_after (undo window). */
export type EmailRunStatus = 'draft' | 'queued' | 'sent' | 'skipped' | 'failed';

export type EmailOutboxStatus = 'draft' | 'pending' | 'sending' | 'sent' | 'failed' | 'discarded';


export interface EmailAccountRow {
  id: string;
  connection_id: string;
  entity_id: string;
  email_address: string;
  display_name: string;
  status: EmailAccountStatus;
  sync_enabled: number;
  poll_minutes: number;
  backfill_days: number;
  signature: string;
  daily_send_cap: number;
  /** Seconds. null = never synced: the next sync is the backfill. */
  sync_cursor: number | null;
  /** Seconds. The agent only answers mail received at/after this. */
  care_since: number | null;
  last_poll_at: number | null;
  last_error: string;
  created_at: number;
  updated_at: number;
}


export interface EmailAccountPatch {
  entityId?: string;
  emailAddress?: string;
  displayName?: string;
  status?: EmailAccountStatus;
  syncEnabled?: boolean;
  pollMinutes?: number;
  backfillDays?: number;
  signature?: string;
  dailySendCap?: number;
  syncCursor?: number | null;
  careSince?: number | null;
  lastPollAt?: number | null;
  lastError?: string;
}


export interface EmailThreadRow {
  id: number;
  account_id: string;
  gmail_thread_id: string;
  subject: string;
  /** Lower-cased address of the other side. */
  customer_email: string;
  customer_name: string;
  /** Reply-To of the latest inbound ('' = reply to customer_email). */
  reply_to: string;
  /** Milliseconds. */
  last_message_at: number;
  last_preview: string;
  last_direction: EmailDirection | '';
  message_count: number;
  unread_count: number;
  category: EmailCategory;
  /** Non-empty = the latest inbound looked automated (newsletter, no-reply…). */
  automated_reason: string;
  paused_until: number | null;
  opted_out: number;
  /** Last inbound email_messages.id the responder already decided on. */
  agent_handled_message_id: number | null;
  created_at: number;
}


export interface EmailThreadUpsert {
  accountId: string;
  gmailThreadId: string;
  subject?: string;
  customerEmail?: string;
  customerName?: string;
  replyTo?: string;
  category?: EmailCategory;
}


export type EmailThreadView = 'all' | 'needs_reply' | 'drafts' | 'agent' | 'automated';


export interface EmailThreadListRow extends EmailThreadRow {
  draft_count: number;
  pending_count: number;
}


export interface EmailAttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}


export interface EmailMessageRow {
  id: number;
  thread_id: number;
  account_id: string;
  gmail_message_id: string;
  direction: EmailDirection;
  sender_type: EmailSenderType;
  from_email: string;
  from_name: string;
  /** JSON string[] of lower-cased addresses. */
  to_json: string;
  cc_json: string;
  subject: string;
  body_text: string;
  /** Raw HTML as received; sanitize when rendering. */
  body_html: string;
  snippet: string;
  /** JSON Record<string,string> with lower-cased header names (subset). */
  headers_json: string;
  /** JSON string[] of Gmail label ids. */
  labels_json: string;
  /** JSON EmailAttachmentMeta[]. */
  attachments_json: string;
  origin: 'live' | 'backfill';
  /** Milliseconds. */
  sent_at: number;
  created_at: number;
}


export interface EmailMessageInsert {
  threadId: number;
  accountId: string;
  gmailMessageId: string;
  direction: EmailDirection;
  senderType: EmailSenderType;
  fromEmail: string;
  fromName?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  snippet?: string;
  headers?: Record<string, string>;
  labels?: string[];
  attachments?: EmailAttachmentMeta[];
  origin: 'live' | 'backfill';
  sentAtMs: number;
}


export interface EmailAssignment {
  id: number;
  account_id: string;
  scope: EmailAssignmentScope;
  /** '' for scope 'account'; lower-cased domain or address otherwise. */
  match_value: string;
  agent_id: string;
  mode: EmailAssignmentMode;
  instructions: string;
  review_keywords: string[];
  primary_only: boolean;
  max_replies_per_thread_day: number;
  human_pause_minutes: number;
  auto_delay_seconds: number;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}


export interface EmailAssignmentInput {
  accountId: string;
  scope: EmailAssignmentScope;
  matchValue?: string;
  agentId: string;
  mode?: EmailAssignmentMode;
  instructions?: string;
  reviewKeywords?: string[];
  primaryOnly?: boolean;
  maxRepliesPerThreadDay?: number;
  humanPauseMinutes?: number;
  autoDelaySeconds?: number;
  enabled?: boolean;
}


export interface EmailAgentRunInput {
  threadId: number;
  assignmentId?: number | null;
  agentId?: string;
  triggerMessageId?: number | null;
  status: EmailRunStatus;
  skipReason?: string;
  replyText?: string;
  note?: string;
  latencyMs?: number;
  costUsd?: number;
}


export interface EmailAgentRunRow {
  id: number;
  thread_id: number;
  assignment_id: number | null;
  agent_id: string;
  trigger_message_id: number | null;
  status: EmailRunStatus;
  skip_reason: string;
  reply_text: string;
  note: string;
  latency_ms: number;
  cost_usd: number;
  created_at: number;
  thread_subject: string;
  customer_email: string;
  account_id: string;
}


export interface EmailOutboxRow {
  id: number;
  thread_id: number;
  account_id: string;
  body: string;
  to_email: string;
  cc_json: string;
  origin: 'operator' | 'agent';
  agent_id: string;
  run_id: number | null;
  status: EmailOutboxStatus;
  /** Seconds; a pending row is sent once now >= send_after. */
  send_after: number | null;
  /** Why an agent reply needs a human (review keyword, quiet hours…). */
  review_reason: string;
  /** Seconds; set when the owner approved an agent draft (the sender then skips agent holds). */
  approved_at: number | null;
  gmail_message_id: string;
  message_id: number | null;
  error: string;
  created_at: number;
  sent_at: number | null;
}


export interface EmailProtectionSettings {
  /** Agent replies (draft+queued+sent) per agent per local day, all mailboxes. */
  agentDailyReplyCap: number;
  /** Composio calls per hour for email, all mailboxes together. */
  apiBudgetPerHour: number;
  /** Inbound older than this is never answered automatically. */
  staleHours: number;
  /** Auto replies inside the window are held until it ends (send_after = window end). */
  quietHours: { enabled: boolean; start: string; end: string };
  timezone: string;
  /** Extra sender patterns treated as automated (substring of the address, lower-case). */
  extraAutomatedPatterns: string[];
}


/** Open Gmail poll window of a mailbox (see email_sync_windows). */
export interface EmailSyncWindow {
  account_id: string;
  kind: 'backfill' | 'poll';
  query: string;
  page_size: number;
  /** Seconds. Becomes email_accounts.sync_cursor when the window completes. */
  window_end: number;
  /** Token of the NEXT page to read; null = start of the window. */
  page_token: string | null;
  pages_done: number;
  restarts: number;
  started_at: number;
  updated_at: number;
}
export function createEmailStore(db: ModuleContext['db'], cipher: ModuleContext['crypto']) {
const encryptField = cipher.encrypt;
const decryptField = cipher.decrypt;
const nowSec = () => Math.floor(Date.now()/1000);
const parseStringArray = (s: string): string[] => { try { const a: unknown = JSON.parse(s); return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } };
// DB access functions
// Extracted verbatim from GỐC src/db.ts (prefixes: email).
// The original module-level `db` handle must be replaced by an injected handle.

// @email-db

/** Empty stays empty: nothing to protect, and '' is the column default. */
const encEmail = (s: string): string => (s ? encryptField(s) : '');

const decEmail = (s: string): string => (s ? decryptField(s) : '');


function mapEmailThread<T extends EmailThreadRow>(row: T): T {
  return { ...row, last_preview: decEmail(row.last_preview) };
}


function mapEmailMessage(row: EmailMessageRow): EmailMessageRow {
  return {
    ...row,
    body_text: decEmail(row.body_text),
    body_html: decEmail(row.body_html),
    snippet: decEmail(row.snippet),
  };
}


function mapEmailOutbox(row: EmailOutboxRow): EmailOutboxRow {
  return { ...row, body: decEmail(row.body) };
}


function mapEmailRun(row: EmailAgentRunRow): EmailAgentRunRow {
  return { ...row, reply_text: decEmail(row.reply_text) };
}


function mapEmailAssignment(row: EmailAssignmentDbRow): EmailAssignment {
  return {
    ...row,
    review_keywords: parseStringArray(row.review_keywords),
    primary_only: row.primary_only === 1,
    enabled: row.enabled === 1,
  };
}


const emailLowerDbs = new WeakSet<object>();


/** SQLite's lower() is ASCII-only; subjects and names are Vietnamese (Đ, Ơ…), so search folds with JS. */
function registerEmailLower(): void {
  if (emailLowerDbs.has(db)) return;
  db.function('email_lower', { deterministic: true }, (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : s));
  emailLowerDbs.add(db);
}


/** Lower-cased, trimmed address; '' stays ''. */
const normEmailAddr = (s: string | undefined): string => (s ?? '').trim().toLowerCase();


/** Insert on first sight of a connection (sync off), else refresh entity/status. */
function upsertEmailAccountFromConnection(input: {
  connectionId: string;
  entityId: string;
  status: EmailAccountStatus;
  emailAddress?: string;
}): EmailAccountRow {
  const now = nowSec();
  const address = normEmailAddr(input.emailAddress);
  return db.prepare(
    `INSERT INTO email_accounts (id, connection_id, entity_id, email_address, status, sync_enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(connection_id) DO UPDATE SET
       entity_id = excluded.entity_id,
       status = excluded.status,
       email_address = CASE WHEN excluded.email_address <> '' THEN excluded.email_address ELSE email_accounts.email_address END,
       updated_at = excluded.updated_at
     RETURNING *`,
  ).get(crypto.randomUUID(), input.connectionId, input.entityId, address, input.status, now, now) as EmailAccountRow;
}

function listEmailAccounts(): EmailAccountRow[] {
  return db.prepare(`SELECT * FROM email_accounts ORDER BY created_at, email_address, id`).all() as EmailAccountRow[];
}

function getEmailAccount(id: string): EmailAccountRow | undefined {
  return db.prepare(`SELECT * FROM email_accounts WHERE id = ?`).get(id) as EmailAccountRow | undefined;
}

function getEmailAccountByConnection(connectionId: string): EmailAccountRow | undefined {
  return db.prepare(`SELECT * FROM email_accounts WHERE connection_id = ?`).get(connectionId) as EmailAccountRow | undefined;
}

/** Only the fields present in the patch change; updated_at is bumped. */
function updateEmailAccount(id: string, patch: EmailAccountPatch): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, value: unknown): void => { sets.push(`${col} = ?`); params.push(value); };
  if (patch.entityId !== undefined) set('entity_id', patch.entityId);
  if (patch.emailAddress !== undefined) set('email_address', normEmailAddr(patch.emailAddress));
  if (patch.displayName !== undefined) set('display_name', patch.displayName);
  if (patch.status !== undefined) set('status', patch.status);
  if (patch.syncEnabled !== undefined) set('sync_enabled', patch.syncEnabled ? 1 : 0);
  if (patch.pollMinutes !== undefined) set('poll_minutes', patch.pollMinutes);
  if (patch.backfillDays !== undefined) set('backfill_days', patch.backfillDays);
  if (patch.signature !== undefined) set('signature', patch.signature);
  if (patch.dailySendCap !== undefined) set('daily_send_cap', patch.dailySendCap);
  if (patch.syncCursor !== undefined) set('sync_cursor', patch.syncCursor);
  if (patch.careSince !== undefined) set('care_since', patch.careSince);
  if (patch.lastPollAt !== undefined) set('last_poll_at', patch.lastPollAt);
  if (patch.lastError !== undefined) set('last_error', patch.lastError);
  set('updated_at', nowSec());
  db.prepare(`UPDATE email_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
}

/** Deletes the account and its threads, messages, assignments, runs and outbox rows. */
function deleteEmailAccount(id: string): void {
  db.transaction(() => {
    const threads = `SELECT id FROM email_threads WHERE account_id = ?`;
    db.prepare(`DELETE FROM email_outbox WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM email_agent_runs WHERE thread_id IN (${threads})`).run(id);
    db.prepare(`DELETE FROM email_messages WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM email_threads WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM email_assignments WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM email_sync_windows WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM email_accounts WHERE id = ?`).run(id);
  })();
}

/** Lower-cased addresses of every connected mailbox (mail between them is internal). */
function listEmailAccountAddresses(): string[] {
  const rows = db.prepare(`SELECT email_address FROM email_accounts WHERE email_address <> ''`).all() as Array<{ email_address: string }>;
  return rows.map((r) => r.email_address.toLowerCase());
}


/** Insert or update; on update only non-empty provided fields overwrite. */
function upsertEmailThread(input: EmailThreadUpsert): EmailThreadRow {
  const row = db.prepare(
    `INSERT INTO email_threads (account_id, gmail_thread_id, subject, customer_email, customer_name, reply_to, category, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, gmail_thread_id) DO UPDATE SET
       subject = CASE WHEN excluded.subject <> '' THEN excluded.subject ELSE email_threads.subject END,
       customer_email = CASE WHEN excluded.customer_email <> '' THEN excluded.customer_email ELSE email_threads.customer_email END,
       customer_name = CASE WHEN excluded.customer_name <> '' THEN excluded.customer_name ELSE email_threads.customer_name END,
       reply_to = CASE WHEN excluded.reply_to <> '' THEN excluded.reply_to ELSE email_threads.reply_to END,
       category = CASE WHEN excluded.category <> '' THEN excluded.category ELSE email_threads.category END
     RETURNING *`,
  ).get(
    input.accountId,
    input.gmailThreadId,
    input.subject ?? '',
    normEmailAddr(input.customerEmail),
    input.customerName ?? '',
    normEmailAddr(input.replyTo),
    input.category ?? '',
    nowSec(),
  ) as EmailThreadRow;
  return mapEmailThread(row);
}

function getEmailThread(id: number): EmailThreadRow | undefined {
  const row = db.prepare(`SELECT * FROM email_threads WHERE id = ?`).get(id) as EmailThreadRow | undefined;
  return row ? mapEmailThread(row) : undefined;
}

function getEmailThreadByGmail(accountId: string, gmailThreadId: string): EmailThreadRow | undefined {
  const row = db.prepare(
    `SELECT * FROM email_threads WHERE account_id = ? AND gmail_thread_id = ?`,
  ).get(accountId, gmailThreadId) as EmailThreadRow | undefined;
  return row ? mapEmailThread(row) : undefined;
}


/**
 * Bumps message_count and, when atMs >= last_message_at, the last_* columns
 * (preview, direction, automated_reason). incrementUnread adds one to
 * unread_count (live inbound only); an outbound message resets it to 0.
 */
function recordEmailThreadActivity(threadId: number, activity: {
  atMs: number;
  preview: string;
  direction: EmailDirection;
  automatedReason?: string;
  incrementUnread?: boolean;
}): void {
  const inbound = activity.direction === 'in';
  // Outbound leaves automated_reason alone (a replied newsletter stays in the
  // automated view); inbound always rewrites it so a human mail clears it.
  const automated = inbound ? (activity.automatedReason ?? '') : (activity.automatedReason ?? null);
  db.prepare(
    `UPDATE email_threads SET
       message_count = message_count + 1,
       unread_count = CASE WHEN @inbound = 0 THEN 0 WHEN @inc = 1 THEN unread_count + 1 ELSE unread_count END,
       last_preview = CASE WHEN @at >= last_message_at THEN @preview ELSE last_preview END,
       last_direction = CASE WHEN @at >= last_message_at THEN @direction ELSE last_direction END,
       automated_reason = CASE WHEN @at >= last_message_at AND @automated IS NOT NULL THEN @automated ELSE automated_reason END,
       last_message_at = CASE WHEN @at >= last_message_at THEN @at ELSE last_message_at END
     WHERE id = @id`,
  ).run({
    id: threadId,
    at: activity.atMs,
    preview: encEmail(activity.preview),
    direction: activity.direction,
    automated,
    inbound: inbound ? 1 : 0,
    inc: activity.incrementUnread ? 1 : 0,
  });
}


/**
 * Newest first by last_message_at. Views:
 *   needs_reply  last_direction='in' AND automated_reason='' AND opted_out=0
 *   drafts       has an outbox row in status 'draft'
 *   agent        has an agent run with status draft/queued/sent
 *   automated    automated_reason<>'' OR category NOT IN ('primary','')
 * q matches subject, customer_email, customer_name (LIKE, case-insensitive).
 * beforeMs pages on last_message_at.
 */
function listEmailThreads(filter: {
  accountId?: string;
  view?: EmailThreadView;
  q?: string;
  beforeMs?: number;
  limit?: number;
}): EmailThreadListRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.accountId) { where.push('t.account_id = ?'); params.push(filter.accountId); }
  switch (filter.view) {
    case 'needs_reply':
      where.push(`t.last_direction = 'in' AND t.automated_reason = '' AND t.opted_out = 0`);
      break;
    case 'drafts':
      where.push(`EXISTS (SELECT 1 FROM email_outbox o WHERE o.thread_id = t.id AND o.status = 'draft')`);
      break;
    case 'agent':
      where.push(`EXISTS (SELECT 1 FROM email_agent_runs r WHERE r.thread_id = t.id AND r.status IN ('draft', 'queued', 'sent'))`);
      break;
    case 'automated':
      where.push(`(t.automated_reason <> '' OR t.category NOT IN ('primary', ''))`);
      break;
    default:
      break;
  }
  const q = filter.q?.trim().toLowerCase();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    registerEmailLower();
    where.push(
      `(email_lower(t.subject) LIKE ? ESCAPE '\\' OR email_lower(t.customer_email) LIKE ? ESCAPE '\\' OR email_lower(t.customer_name) LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like);
  }
  if (filter.beforeMs !== undefined) { where.push('t.last_message_at < ?'); params.push(filter.beforeMs); }
  const rows = db.prepare(
    `SELECT t.*,
       (SELECT COUNT(*) FROM email_outbox o WHERE o.thread_id = t.id AND o.status = 'draft') AS draft_count,
       (SELECT COUNT(*) FROM email_outbox o WHERE o.thread_id = t.id AND o.status = 'pending') AS pending_count
     FROM email_threads t
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY t.last_message_at DESC, t.id DESC LIMIT ?`,
  ).all(...params, Math.min(filter.limit ?? 50, 500)) as EmailThreadListRow[];
  return rows.map(mapEmailThread);
}

function markEmailThreadRead(threadId: number): void {
  db.prepare(`UPDATE email_threads SET unread_count = 0 WHERE id = ?`).run(threadId);
}

function setEmailThreadPause(threadId: number, untilSec: number | null): void {
  db.prepare(`UPDATE email_threads SET paused_until = ? WHERE id = ?`).run(untilSec, threadId);
}

function setEmailThreadOptedOut(threadId: number, optedOut: boolean): void {
  db.prepare(`UPDATE email_threads SET opted_out = ? WHERE id = ?`).run(optedOut ? 1 : 0, threadId);
}

function setEmailThreadHandled(threadId: number, messageId: number): void {
  db.prepare(`UPDATE email_threads SET agent_handled_message_id = ? WHERE id = ?`).run(messageId, threadId);
}

function countEmailThreads(accountId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM email_threads WHERE account_id = ?`).get(accountId) as { n: number }).n;
}


/**
 * Threads the responder still has to look at: the newest message is an
 * inbound, origin 'live', with id > COALESCE(agent_handled_message_id, 0),
 * and older than minAgeSec (lets a customer's second mail land first).
 * Oldest first. Returns thread ids.
 */
function listEmailThreadsAwaitingAgent(opts: { minAgeSec: number; limit: number }): number[] {
  const rows = db.prepare(
    `SELECT t.id FROM email_threads t
     JOIN email_messages m ON m.id = (
       SELECT id FROM email_messages WHERE thread_id = t.id ORDER BY sent_at DESC, id DESC LIMIT 1
     )
     WHERE m.direction = 'in' AND m.origin = 'live'
       AND m.id > COALESCE(t.agent_handled_message_id, 0)
       AND m.created_at <= ?
     ORDER BY m.sent_at, m.id LIMIT ?`,
  ).all(nowSec() - opts.minAgeSec, Math.min(opts.limit, 500)) as Array<{ id: number }>;
  return rows.map((r) => r.id);
}


/** Returns the new id, or null when (account_id, gmail_message_id) already exists. */
function insertEmailMessage(input: EmailMessageInsert): number | null {
  const row = db.prepare(
    `INSERT INTO email_messages (
       thread_id, account_id, gmail_message_id, direction, sender_type, from_email, from_name,
       to_json, cc_json, subject, body_text, body_html, snippet, headers_json, labels_json,
       attachments_json, origin, sent_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, gmail_message_id) DO NOTHING
     RETURNING id`,
  ).get(
    input.threadId,
    input.accountId,
    input.gmailMessageId,
    input.direction,
    input.senderType,
    normEmailAddr(input.fromEmail),
    input.fromName ?? '',
    JSON.stringify((input.to ?? []).map(normEmailAddr)),
    JSON.stringify((input.cc ?? []).map(normEmailAddr)),
    input.subject ?? '',
    encEmail(input.bodyText ?? ''),
    encEmail(input.bodyHtml ?? ''),
    encEmail(input.snippet ?? ''),
    JSON.stringify(input.headers ?? {}),
    JSON.stringify(input.labels ?? []),
    JSON.stringify(input.attachments ?? []),
    input.origin,
    input.sentAtMs,
    nowSec(),
  ) as { id: number } | undefined;
  return row?.id ?? null;
}

function getEmailMessage(id: number): EmailMessageRow | undefined {
  const row = db.prepare(`SELECT * FROM email_messages WHERE id = ?`).get(id) as EmailMessageRow | undefined;
  return row ? mapEmailMessage(row) : undefined;
}

/** Oldest → newest. limit keeps the NEWEST n; beforeMs pages backwards. */
function getEmailMessages(threadId: number, opts: { limit?: number; beforeMs?: number } = {}): EmailMessageRow[] {
  const where = ['thread_id = ?'];
  const params: unknown[] = [threadId];
  if (opts.beforeMs !== undefined) { where.push('sent_at < ?'); params.push(opts.beforeMs); }
  const rows = db.prepare(
    `SELECT * FROM email_messages WHERE ${where.join(' AND ')} ORDER BY sent_at DESC, id DESC LIMIT ?`,
  ).all(...params, Math.min(opts.limit ?? 50, 500)) as EmailMessageRow[];
  return rows.reverse().map(mapEmailMessage);
}

function findEmailMessageByGmailId(accountId: string, gmailMessageId: string): EmailMessageRow | undefined {
  const row = db.prepare(
    `SELECT * FROM email_messages WHERE account_id = ? AND gmail_message_id = ?`,
  ).get(accountId, gmailMessageId) as EmailMessageRow | undefined;
  return row ? mapEmailMessage(row) : undefined;
}

/** ms of the newest outbound with sender_type 'self' or 'operator', or null. */
function lastEmailHumanReplyAt(threadId: number): number | null {
  const row = db.prepare(
    `SELECT MAX(sent_at) AS at FROM email_messages
     WHERE thread_id = ? AND direction = 'out' AND sender_type IN ('self', 'operator')`,
  ).get(threadId) as { at: number | null };
  return row.at;
}

/** Outbound messages sent through us (sender_type agent/operator) since sinceMs. */
function countEmailSentSince(accountId: string, sinceMs: number): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM email_messages
     WHERE account_id = ? AND direction = 'out' AND sender_type IN ('agent', 'operator') AND sent_at >= ?`,
  ).get(accountId, sinceMs) as { n: number }).n;
}


function listEmailAssignments(accountId?: string): EmailAssignment[] {
  const rows = (accountId
    ? db.prepare(`SELECT * FROM email_assignments WHERE account_id = ? ORDER BY scope, id`).all(accountId)
    : db.prepare(`SELECT * FROM email_assignments ORDER BY account_id, scope, id`).all()) as EmailAssignmentDbRow[];
  return rows.map(mapEmailAssignment);
}

function getEmailAssignment(id: number): EmailAssignment | undefined {
  const row = db.prepare(`SELECT * FROM email_assignments WHERE id = ?`).get(id) as EmailAssignmentDbRow | undefined;
  return row ? mapEmailAssignment(row) : undefined;
}

/** One per (account, scope, match_value); saving again replaces it. match_value is lower-cased/trimmed, '' for 'account'. */
function upsertEmailAssignment(input: EmailAssignmentInput): EmailAssignment {
  const now = nowSec();
  const matchValue = input.scope === 'account' ? '' : normEmailAddr(input.matchValue);
  const keywords = [...new Set((input.reviewKeywords ?? []).map((k) => k.trim()).filter(Boolean))];
  const row = db.prepare(
    `INSERT INTO email_assignments (
       account_id, scope, match_value, agent_id, mode, instructions, review_keywords, primary_only,
       max_replies_per_thread_day, human_pause_minutes, auto_delay_seconds, enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, scope, match_value) DO UPDATE SET
       agent_id = excluded.agent_id,
       mode = excluded.mode,
       instructions = excluded.instructions,
       review_keywords = excluded.review_keywords,
       primary_only = excluded.primary_only,
       max_replies_per_thread_day = excluded.max_replies_per_thread_day,
       human_pause_minutes = excluded.human_pause_minutes,
       auto_delay_seconds = excluded.auto_delay_seconds,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at
     RETURNING *`,
  ).get(
    input.accountId,
    input.scope,
    matchValue,
    input.agentId,
    input.mode ?? 'draft',
    input.instructions ?? '',
    JSON.stringify(keywords),
    (input.primaryOnly ?? true) ? 1 : 0,
    input.maxRepliesPerThreadDay ?? 3,
    input.humanPauseMinutes ?? 240,
    input.autoDelaySeconds ?? 120,
    (input.enabled ?? true) ? 1 : 0,
    now,
    now,
  ) as EmailAssignmentDbRow;
  return mapEmailAssignment(row);
}

function deleteEmailAssignment(id: number): boolean {
  return db.prepare(`DELETE FROM email_assignments WHERE id = ?`).run(id).changes > 0;
}


function insertEmailAgentRun(input: EmailAgentRunInput): number {
  const info = db.prepare(
    `INSERT INTO email_agent_runs (
       thread_id, assignment_id, agent_id, trigger_message_id, status, skip_reason, reply_text, note,
       latency_ms, cost_usd, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.threadId,
    input.assignmentId ?? null,
    input.agentId ?? '',
    input.triggerMessageId ?? null,
    input.status,
    input.skipReason ?? '',
    encEmail(input.replyText ?? ''),
    input.note ?? '',
    input.latencyMs ?? 0,
    input.costUsd ?? 0,
    nowSec(),
  );
  return Number(info.lastInsertRowid);
}

function updateEmailAgentRunStatus(id: number, status: EmailRunStatus, note?: string): void {
  if (note === undefined) {
    db.prepare(`UPDATE email_agent_runs SET status = ? WHERE id = ?`).run(status, id);
  } else {
    db.prepare(`UPDATE email_agent_runs SET status = ?, note = ? WHERE id = ?`).run(status, note, id);
  }
}

function listEmailAgentRuns(opts: { threadId?: number; accountId?: string; limit?: number } = {}): EmailAgentRunRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.threadId) { where.push('r.thread_id = ?'); params.push(opts.threadId); }
  if (opts.accountId) { where.push('t.account_id = ?'); params.push(opts.accountId); }
  const rows = db.prepare(
    `SELECT r.*, t.subject AS thread_subject, t.customer_email, t.account_id
     FROM email_agent_runs r JOIN email_threads t ON t.id = r.thread_id
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
  ).all(...params, Math.min(opts.limit ?? 50, 500)) as EmailAgentRunRow[];
  return rows.map(mapEmailRun);
}

/** Runs in this thread since sinceSec with status draft/queued/sent. */
function countEmailAgentReplies(threadId: number, sinceSec: number): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM email_agent_runs
     WHERE thread_id = ? AND status IN ('draft', 'queued', 'sent') AND created_at >= ?`,
  ).get(threadId, sinceSec) as { n: number }).n;
}

/** Runs by this agent (all threads) since sinceSec with status draft/queued/sent. */
function countEmailAgentRunsSince(agentId: string, sinceSec: number): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM email_agent_runs
     WHERE agent_id = ? AND status IN ('draft', 'queued', 'sent') AND created_at >= ?`,
  ).get(agentId, sinceSec) as { n: number }).n;
}

function pruneEmailAgentRuns(retentionDays = 60): number {
  const cutoff = nowSec() - retentionDays * 86400;
  return db.prepare(`DELETE FROM email_agent_runs WHERE created_at < ?`).run(cutoff).changes;
}


function enqueueEmailOutbox(input: {
  threadId: number;
  accountId: string;
  body: string;
  toEmail: string;
  cc?: string[];
  origin: 'operator' | 'agent';
  agentId?: string;
  runId?: number | null;
  status: 'draft' | 'pending';
  /** Defaults to now for 'pending', null for 'draft'. */
  sendAfter?: number | null;
  reviewReason?: string;
}): number {
  const now = nowSec();
  const sendAfter = input.sendAfter !== undefined ? input.sendAfter : (input.status === 'pending' ? now : null);
  const info = db.prepare(
    `INSERT INTO email_outbox (
       thread_id, account_id, body, to_email, cc_json, origin, agent_id, run_id, status, send_after,
       review_reason, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.threadId,
    input.accountId,
    encEmail(input.body),
    normEmailAddr(input.toEmail),
    JSON.stringify((input.cc ?? []).map(normEmailAddr)),
    input.origin,
    input.agentId ?? '',
    input.runId ?? null,
    input.status,
    sendAfter,
    input.reviewReason ?? '',
    now,
  );
  return Number(info.lastInsertRowid);
}

function getEmailOutbox(id: number): EmailOutboxRow | undefined {
  const row = db.prepare(`SELECT * FROM email_outbox WHERE id = ?`).get(id) as EmailOutboxRow | undefined;
  return row ? mapEmailOutbox(row) : undefined;
}

/** Atomically moves the oldest pending row with send_after <= nowSec to 'sending'. */
function claimDueEmailOutbox(now: number): EmailOutboxRow | null {
  return db.transaction(() => {
    const next = db.prepare(
      `SELECT id FROM email_outbox
       WHERE status = 'pending' AND send_after IS NOT NULL AND send_after <= ?
       ORDER BY send_after, id LIMIT 1`,
    ).get(now) as { id: number } | undefined;
    if (!next) return null;
    const claimed = db.prepare(`UPDATE email_outbox SET status = 'sending' WHERE id = ? AND status = 'pending'`).run(next.id);
    if (claimed.changes === 0) return null;
    return getEmailOutbox(next.id) ?? null;
  })();
}

function markEmailOutboxSent(id: number, sent: { gmailMessageId: string; messageId: number | null }): void {
  db.prepare(
    `UPDATE email_outbox SET status = 'sent', gmail_message_id = ?, message_id = ?, error = '', sent_at = ? WHERE id = ?`,
  ).run(sent.gmailMessageId, sent.messageId, nowSec(), id);
}

function markEmailOutboxFailed(id: number, error: string): void {
  db.prepare(`UPDATE email_outbox SET status = 'failed', error = ? WHERE id = ?`).run(error.slice(0, 500), id);
}

/** sending → failed('interrupted') at startup: unknown whether Gmail got it, so never resent. */
function failInterruptedEmailOutbox(): number {
  return db.prepare(`UPDATE email_outbox SET status = 'failed', error = 'interrupted' WHERE status = 'sending'`).run().changes;
}

/** Moves a 'sending' (or 'pending') row back to 'draft' with a reason, e.g. a pre-send check failed. */
function returnEmailOutboxToDraft(id: number, reason: string): boolean {
  return db.prepare(
    `UPDATE email_outbox SET status = 'draft', send_after = NULL, approved_at = NULL, review_reason = ?
     WHERE id = ? AND status IN ('sending', 'pending')`,
  ).run(reason, id).changes > 0;
}

function listEmailOutbox(opts: { threadId?: number; accountId?: string; statuses?: EmailOutboxStatus[]; limit?: number } = {}): EmailOutboxRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.threadId) { where.push('thread_id = ?'); params.push(opts.threadId); }
  if (opts.accountId) { where.push('account_id = ?'); params.push(opts.accountId); }
  if (opts.statuses?.length) {
    where.push(`status IN (${opts.statuses.map(() => '?').join(', ')})`);
    params.push(...opts.statuses);
  }
  const rows = db.prepare(
    `SELECT * FROM email_outbox ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(...params, Math.min(opts.limit ?? 50, 500)) as EmailOutboxRow[];
  return rows.map(mapEmailOutbox);
}

function countEmailOutbox(status: EmailOutboxStatus, accountId?: string): number {
  const row = accountId
    ? db.prepare(`SELECT COUNT(*) AS n FROM email_outbox WHERE status = ? AND account_id = ?`).get(status, accountId)
    : db.prepare(`SELECT COUNT(*) AS n FROM email_outbox WHERE status = ?`).get(status);
  return (row as { n: number }).n;
}

/** draft → pending, send_after = now, optionally with the operator's edited body. */
function approveEmailDraft(id: number, editedBody?: string): boolean {
  const edited = editedBody?.trim();
  // review_reason stays: it records why the agent reply needed a human.
  return db.prepare(
    `UPDATE email_outbox SET status = 'pending', send_after = ?, approved_at = ?, body = COALESCE(?, body)
     WHERE id = ? AND status = 'draft'`,
  ).run(nowSec(), nowSec(), edited ? encryptField(edited) : null, id).changes > 0;
}

/** draft or pending → discarded. */
function discardEmailOutbox(id: number): boolean {
  return db.prepare(
    `UPDATE email_outbox SET status = 'discarded' WHERE id = ? AND status IN ('draft', 'pending')`,
  ).run(id).changes > 0;
}

/** pending → draft (operator pressed "Huỷ tự gửi" during the undo window). */
function cancelEmailPending(id: number): boolean {
  return db.prepare(
    `UPDATE email_outbox SET status = 'draft', send_after = NULL, approved_at = NULL, review_reason = 'Đã huỷ tự gửi'
     WHERE id = ? AND status = 'pending'`,
  ).run(id).changes > 0;
}

/** Shared inbox: a pending human reply is withdrawn before the worker claims it (pending → discarded, never to draft). */
function cancelEmailOperatorPending(id: number): boolean {
  return db.prepare(
    `UPDATE email_outbox SET status = 'discarded' WHERE id = ? AND status = 'pending' AND origin = 'operator'`,
  ).run(id).changes > 0;
}

/** Shared inbox: rows waiting for review (status draft) of these threads and/or one mailbox, newest first. At least one filter is expected. */
function listEmailDrafts(opts: { threadIds?: readonly number[]; accountId?: string; limit?: number }): EmailOutboxRow[] {
  const where: string[] = [`status = 'draft'`];
  const params: unknown[] = [];
  if (opts.threadIds) {
    if (opts.threadIds.length === 0) return [];
    where.push(`thread_id IN (${opts.threadIds.map(() => '?').join(', ')})`);
    params.push(...opts.threadIds);
  }
  if (opts.accountId) { where.push('account_id = ?'); params.push(opts.accountId); }
  const rows = db.prepare(
    `SELECT * FROM email_outbox WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(...params, Math.min(Math.max(opts.limit ?? 100, 1), 500)) as EmailOutboxRow[];
  return rows.map(mapEmailOutbox);
}


function getEmailSetting(key: string): string | null {
  const row = db.prepare(`SELECT value FROM email_settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setEmailSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO email_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, nowSec());
}


const DEFAULT_EMAIL_PROTECTION: EmailProtectionSettings = {
  agentDailyReplyCap: 300,
  apiBudgetPerHour: 300,
  staleHours: 72,
  quietHours: { enabled: false, start: '21:00', end: '07:00' },
  timezone: 'Asia/Ho_Chi_Minh',
  extraAutomatedPatterns: [],
};


/** Stored under email_settings key 'protection'; missing/invalid fields fall back to the defaults. */
const EMAIL_QUIET_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;


function clampEmailInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}


function isValidEmailTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}


/** Overlays the valid fields of `raw` on `base`; anything invalid keeps the base value. */
function applyEmailProtection(base: EmailProtectionSettings, raw: unknown): EmailProtectionSettings {
  const next: EmailProtectionSettings = { ...base, quietHours: { ...base.quietHours } };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return next;
  const r = raw as Record<string, unknown>;
  next.agentDailyReplyCap = clampEmailInt(r.agentDailyReplyCap, 1, 10000, base.agentDailyReplyCap);
  next.apiBudgetPerHour = clampEmailInt(r.apiBudgetPerHour, 10, 100000, base.apiBudgetPerHour);
  next.staleHours = clampEmailInt(r.staleHours, 1, 720, base.staleHours);
  const q = r.quietHours;
  if (q && typeof q === 'object' && !Array.isArray(q)) {
    const qh = q as Record<string, unknown>;
    if (typeof qh.enabled === 'boolean') next.quietHours.enabled = qh.enabled;
    if (typeof qh.start === 'string' && EMAIL_QUIET_TIME_RE.test(qh.start)) next.quietHours.start = qh.start;
    if (typeof qh.end === 'string' && EMAIL_QUIET_TIME_RE.test(qh.end)) next.quietHours.end = qh.end;
  }
  if (typeof r.timezone === 'string' && r.timezone && isValidEmailTimezone(r.timezone)) next.timezone = r.timezone;
  if (Array.isArray(r.extraAutomatedPatterns)) {
    // Over-long patterns are dropped, not cut: a shorter substring would match more senders.
    const cleaned = r.extraAutomatedPatterns
      .filter((p): p is string => typeof p === 'string')
      .map((p) => p.trim().toLowerCase())
      .filter((p) => p.length > 0 && p.length <= 100);
    next.extraAutomatedPatterns = [...new Set(cleaned)].slice(0, 50);
  }
  return next;
}


function cloneEmailProtection(p: EmailProtectionSettings): EmailProtectionSettings {
  return { ...p, quietHours: { ...p.quietHours }, extraAutomatedPatterns: [...p.extraAutomatedPatterns] };
}


function getEmailProtectionSettings(): EmailProtectionSettings {
  const base = cloneEmailProtection(DEFAULT_EMAIL_PROTECTION);
  const stored = getEmailSetting('protection');
  if (!stored) return base;
  try {
    return applyEmailProtection(base, JSON.parse(stored) as unknown);
  } catch {
    return base;
  }
}

/** Validates and clamps a partial update, merges it, stores it, returns the result. */
function saveEmailProtectionSettings(partial: unknown): EmailProtectionSettings {
  const current = getEmailProtectionSettings();
  // A partial update only carries the fields it changes, so absent keys must
  // keep the current value (applyEmailProtection already falls back per field).
  const next = applyEmailProtection(current, partial);
  setEmailSetting('protection', JSON.stringify(next));
  return next;
}


function recordEmailApiCall(area: string, ok: boolean, atSec: number = nowSec()): void {
  db.prepare(`INSERT INTO email_api_calls (area, ok, created_at) VALUES (?, ?, ?)`).run(area, ok ? 1 : 0, atSec);
}

function countEmailApiCallsSince(sinceSec: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM email_api_calls WHERE created_at >= ?`).get(sinceSec) as { n: number }).n;
}

function pruneEmailApiCalls(beforeSec: number): number {
  return db.prepare(`DELETE FROM email_api_calls WHERE created_at < ?`).run(beforeSec).changes;
}

function getEmailSyncWindow(accountId: string): EmailSyncWindow | undefined {
  return db.prepare(`SELECT * FROM email_sync_windows WHERE account_id = ?`).get(accountId) as EmailSyncWindow | undefined;
}

function saveEmailSyncWindow(w: Omit<EmailSyncWindow, 'updated_at'>): void {
  db.prepare(
    `INSERT INTO email_sync_windows (account_id, kind, query, page_size, window_end, page_token, pages_done, restarts, started_at, updated_at)
     VALUES (@account_id, @kind, @query, @page_size, @window_end, @page_token, @pages_done, @restarts, @started_at, @now)
     ON CONFLICT(account_id) DO UPDATE SET
       kind = excluded.kind, query = excluded.query, page_size = excluded.page_size, window_end = excluded.window_end,
       page_token = excluded.page_token, pages_done = excluded.pages_done, restarts = excluded.restarts,
       started_at = excluded.started_at, updated_at = excluded.updated_at`,
  ).run({ ...w, now: nowSec() });
}

function clearEmailSyncWindow(accountId: string): void {
  db.prepare(`DELETE FROM email_sync_windows WHERE account_id = ?`).run(accountId);
}


/**
 * Runs `fn` as ONE write transaction on the email handle (BEGIN IMMEDIATE; nested inside another
 * transaction it becomes a savepoint). Everything `fn` writes through the email_* helpers commits
 * or rolls back together, including rows the Care capture triggers journal inside those same
 * statements. Deliberately takes a callback instead of handing out the database handle.
 */
function runEmailAtomic<T>(fn: () => T): T {
  return db.transaction(fn).immediate();
}
return { upsertEmailAccountFromConnection, listEmailAccounts, getEmailAccount, getEmailAccountByConnection, updateEmailAccount, deleteEmailAccount, listEmailAccountAddresses, upsertEmailThread, getEmailThread, getEmailThreadByGmail, recordEmailThreadActivity, listEmailThreads, markEmailThreadRead, setEmailThreadPause, setEmailThreadOptedOut, setEmailThreadHandled, countEmailThreads, listEmailThreadsAwaitingAgent, insertEmailMessage, getEmailMessage, getEmailMessages, findEmailMessageByGmailId, lastEmailHumanReplyAt, countEmailSentSince, listEmailAssignments, getEmailAssignment, upsertEmailAssignment, deleteEmailAssignment, insertEmailAgentRun, updateEmailAgentRunStatus, listEmailAgentRuns, countEmailAgentReplies, countEmailAgentRunsSince, pruneEmailAgentRuns, enqueueEmailOutbox, getEmailOutbox, claimDueEmailOutbox, markEmailOutboxSent, markEmailOutboxFailed, failInterruptedEmailOutbox, returnEmailOutboxToDraft, listEmailOutbox, countEmailOutbox, approveEmailDraft, discardEmailOutbox, cancelEmailPending, cancelEmailOperatorPending, listEmailDrafts, getEmailSetting, setEmailSetting, DEFAULT_EMAIL_PROTECTION, getEmailProtectionSettings, saveEmailProtectionSettings, recordEmailApiCall, countEmailApiCallsSince, pruneEmailApiCalls, getEmailSyncWindow, saveEmailSyncWindow, clearEmailSyncWindow, runEmailAtomic };
}
export type EmailStore = ReturnType<typeof createEmailStore>;
