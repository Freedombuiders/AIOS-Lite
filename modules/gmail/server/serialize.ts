/**
 * Row → DTO mappers for /api/email/*. Pure: callers pass the account address
 * (for the Gmail deep link) so a list needs one account lookup, not one per row.
 */

import type {
  EmailAccountRow, EmailAgentRunRow, EmailAssignment, EmailMessageRow, EmailOutboxRow,
  EmailThreadListRow, EmailThreadRow,
} from './store.js';
import type {
  EmailAccountDto, EmailAssignmentDto, EmailAttachmentDto, EmailMessageDto, EmailOutboxDto,
  EmailRunDto, EmailThreadSummaryDto,
} from './dto.js';
type EmailSkipReason = string;
const EMAIL_SKIP_REASON_LABEL: Record<string, string> = {};

function parseList<T>(json: string): T[] {
  try {
    const v = JSON.parse(json || '[]') as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export function gmailThreadUrl(accountEmail: string, gmailThreadId: string): string {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(accountEmail)}#all/${gmailThreadId}`;
}

export function presentAccount(
  a: EmailAccountRow, counts: { sentToday: number; threadCount: number; draftCount: number },
): EmailAccountDto {
  return {
    id: a.id,
    connectionId: a.connection_id,
    emailAddress: a.email_address,
    displayName: a.display_name,
    status: a.status,
    syncEnabled: a.sync_enabled === 1,
    pollMinutes: a.poll_minutes,
    backfillDays: a.backfill_days,
    signature: a.signature,
    dailySendCap: a.daily_send_cap,
    sentToday: counts.sentToday,
    threadCount: counts.threadCount,
    draftCount: counts.draftCount,
    lastPollAt: a.last_poll_at,
    careSince: a.care_since,
    lastError: a.last_error,
    createdAt: a.created_at,
  };
}

export function presentThread(
  t: EmailThreadRow | EmailThreadListRow, accountEmail: string, counts?: { draftCount: number; pendingCount: number },
): EmailThreadSummaryDto {
  const listed = t as Partial<EmailThreadListRow>;
  return {
    id: t.id,
    accountId: t.account_id,
    gmailThreadId: t.gmail_thread_id,
    subject: t.subject,
    customerEmail: t.customer_email,
    customerName: t.customer_name,
    lastMessageAt: t.last_message_at,
    lastPreview: t.last_preview,
    lastDirection: t.last_direction,
    messageCount: t.message_count,
    unreadCount: t.unread_count,
    category: t.category,
    automatedReason: t.automated_reason,
    pausedUntil: t.paused_until,
    optedOut: t.opted_out === 1,
    draftCount: counts?.draftCount ?? listed.draft_count ?? 0,
    pendingCount: counts?.pendingCount ?? listed.pending_count ?? 0,
    gmailUrl: gmailThreadUrl(accountEmail, t.gmail_thread_id),
  };
}

export function presentMessage(m: EmailMessageRow): EmailMessageDto {
  const attachments = parseList<EmailAttachmentDto>(m.attachments_json).map((a) => ({
    filename: String(a.filename ?? ''),
    mimeType: String(a.mimeType ?? ''),
    size: Number(a.size) || 0,
  }));
  return {
    id: m.id,
    direction: m.direction,
    senderType: m.sender_type,
    fromEmail: m.from_email,
    fromName: m.from_name,
    to: parseList<string>(m.to_json),
    cc: parseList<string>(m.cc_json),
    subject: m.subject,
    bodyText: m.body_text,
    bodyHtml: m.body_html,
    snippet: m.snippet,
    attachments,
    origin: m.origin,
    sentAt: m.sent_at,
  };
}

export function presentOutbox(o: EmailOutboxRow): EmailOutboxDto {
  return {
    id: o.id,
    threadId: o.thread_id,
    body: o.body,
    toEmail: o.to_email,
    origin: o.origin,
    agentId: o.agent_id,
    status: o.status,
    sendAfter: o.send_after,
    reviewReason: o.review_reason,
    error: o.error,
    createdAt: o.created_at,
    sentAt: o.sent_at,
  };
}

export function presentRun(r: EmailAgentRunRow): EmailRunDto {
  return {
    id: r.id,
    threadId: r.thread_id,
    threadSubject: r.thread_subject,
    customerEmail: r.customer_email,
    accountId: r.account_id,
    agentId: r.agent_id,
    status: r.status,
    skipReason: r.skip_reason,
    skipLabel: r.skip_reason ? EMAIL_SKIP_REASON_LABEL[r.skip_reason as EmailSkipReason] ?? '' : '',
    replyText: r.reply_text,
    note: r.note,
    latencyMs: r.latency_ms,
    costUsd: r.cost_usd,
    createdAt: r.created_at,
  };
}

export function presentAssignment(a: EmailAssignment): EmailAssignmentDto {
  return {
    id: a.id,
    accountId: a.account_id,
    scope: a.scope,
    matchValue: a.match_value,
    agentId: a.agent_id,
    mode: a.mode,
    instructions: a.instructions,
    reviewKeywords: a.review_keywords,
    primaryOnly: !!a.primary_only,
    maxRepliesPerThreadDay: a.max_replies_per_thread_day,
    humanPauseMinutes: a.human_pause_minutes,
    autoDelaySeconds: a.auto_delay_seconds,
    enabled: !!a.enabled,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}
