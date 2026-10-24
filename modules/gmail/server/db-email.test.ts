import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  approveEmailDraft,
  cancelEmailPending,
  claimDueEmailOutbox,
  countEmailAgentReplies,
  countEmailAgentRunsSince,
  countEmailApiCallsSince,
  countEmailOutbox,
  countEmailSentSince,
  countEmailThreads,
  DEFAULT_EMAIL_PROTECTION,
  deleteEmailAccount,
  deleteEmailAssignment,
  discardEmailOutbox,
  enqueueEmailOutbox,
  failInterruptedEmailOutbox,
  findEmailMessageByGmailId,
  getEmailAccount,
  getEmailMessage,
  getEmailMessages,
  getEmailOutbox,
  getEmailProtectionSettings,
  getEmailSetting,
  getEmailThread,
  getEmailThreadByGmail,
  insertEmailAgentRun,
  insertEmailMessage,
  lastEmailHumanReplyAt,
  listEmailAccountAddresses,
  listEmailAccounts,
  listEmailAgentRuns,
  listEmailAssignments,
  listEmailOutbox,
  listEmailThreads,
  listEmailThreadsAwaitingAgent,
  markEmailOutboxFailed,
  markEmailOutboxSent,
  markEmailThreadRead,
  pruneEmailAgentRuns,
  pruneEmailApiCalls,
  recordEmailApiCall,
  recordEmailThreadActivity,
  returnEmailOutboxToDraft,
  saveEmailProtectionSettings,
  setEmailSetting,
  setEmailThreadHandled,
  setEmailThreadOptedOut,
  setEmailThreadPause,
  updateEmailAccount,
  updateEmailAgentRunStatus,
  upsertEmailAccountFromConnection,
  upsertEmailAssignment,
  upsertEmailThread,
  type EmailAccountRow,
  type EmailMessageInsert,
} from './test-db.js';

const now = (): number => Math.floor(Date.now() / 1000);

let account: EmailAccountRow;
let seq = 0;

function msg(threadId: number, over: Partial<EmailMessageInsert> = {}): number {
  seq += 1;
  const id = insertEmailMessage({
    threadId,
    accountId: account.id,
    gmailMessageId: `g${seq}`,
    direction: 'in',
    senderType: 'customer',
    fromEmail: 'Cust@Acme.com',
    origin: 'live',
    sentAtMs: 1_000_000 + seq,
    bodyText: 'hello',
    ...over,
  });
  if (id === null) throw new Error('duplicate message in test setup');
  return id;
}

/** Messages are "old enough" for the awaiting-agent query without sleeping. */
const MIN_AGE_ZERO = { minAgeSec: 0, limit: 50 };

beforeEach(() => {
  _initTestDatabase();
  seq = 0;
  account = upsertEmailAccountFromConnection({
    connectionId: 'ca_1',
    entityId: 'ent_1',
    status: 'ACTIVE',
    emailAddress: 'Owner@Shop.com',
  });
});

describe('accounts', () => {
  it('inserts with sync off and lower-cased address, then refreshes on the same connection', () => {
    expect(account.sync_enabled).toBe(0);
    expect(account.email_address).toBe('owner@shop.com');
    expect(account.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(account.sync_cursor).toBeNull();

    updateEmailAccount(account.id, { syncEnabled: true, signature: 'Shop' });
    const again = upsertEmailAccountFromConnection({ connectionId: 'ca_1', entityId: 'ent_2', status: 'EXPIRED' });
    expect(again.id).toBe(account.id);
    expect(again.entity_id).toBe('ent_2');
    expect(again.status).toBe('EXPIRED');
    expect(again.email_address).toBe('owner@shop.com'); // not provided: kept
    expect(again.sync_enabled).toBe(1); // not touched
    expect(again.signature).toBe('Shop');
    expect(listEmailAccounts()).toHaveLength(1);

    const withAddr = upsertEmailAccountFromConnection({
      connectionId: 'ca_1', entityId: 'ent_2', status: 'ACTIVE', emailAddress: 'New@Shop.com',
    });
    expect(withAddr.email_address).toBe('new@shop.com');
  });

  it('updateEmailAccount only changes the patched fields and bumps updated_at', () => {
    updateEmailAccount(account.id, {
      syncEnabled: true,
      pollMinutes: 5,
      careSince: 1234,
      syncCursor: 99,
      lastPollAt: 100,
      lastError: 'boom',
      displayName: 'Shop',
      dailySendCap: 10,
      backfillDays: 3,
    });
    const a = getEmailAccount(account.id)!;
    expect(a).toMatchObject({
      sync_enabled: 1, poll_minutes: 5, care_since: 1234, sync_cursor: 99, last_poll_at: 100,
      last_error: 'boom', display_name: 'Shop', daily_send_cap: 10, backfill_days: 3,
      entity_id: 'ent_1', status: 'ACTIVE',
    });
    updateEmailAccount(account.id, { careSince: null, syncEnabled: false });
    const b = getEmailAccount(account.id)!;
    expect(b.care_since).toBeNull();
    expect(b.sync_enabled).toBe(0);
    expect(b.poll_minutes).toBe(5);
    expect(b.updated_at).toBeGreaterThanOrEqual(a.updated_at);
  });

  it('lists lower-cased mailbox addresses and skips accounts without one', () => {
    upsertEmailAccountFromConnection({ connectionId: 'ca_2', entityId: 'e', status: 'ACTIVE' });
    expect(listEmailAccountAddresses()).toEqual(['owner@shop.com']);
  });

  it('deleteEmailAccount cascades to threads, messages, assignments, runs and outbox only for that account', () => {
    const other = upsertEmailAccountFromConnection({ connectionId: 'ca_2', entityId: 'e', status: 'ACTIVE', emailAddress: 'b@x.com' });
    const t = upsertEmailThread({ accountId: account.id, gmailThreadId: 'T1', subject: 'Hi', customerEmail: 'c@x.com' });
    const keep = upsertEmailThread({ accountId: other.id, gmailThreadId: 'T1', subject: 'Keep' });
    msg(t.id);
    upsertEmailAssignment({ accountId: account.id, scope: 'account', agentId: 'a' });
    upsertEmailAssignment({ accountId: other.id, scope: 'account', agentId: 'a' });
    insertEmailAgentRun({ threadId: t.id, status: 'draft', agentId: 'a' });
    enqueueEmailOutbox({ threadId: t.id, accountId: account.id, body: 'x', toEmail: 'c@x.com', origin: 'agent', status: 'draft' });

    deleteEmailAccount(account.id);

    expect(getEmailAccount(account.id)).toBeUndefined();
    expect(getEmailThread(t.id)).toBeUndefined();
    expect(getEmailMessages(t.id)).toEqual([]);
    expect(listEmailAssignments(account.id)).toEqual([]);
    expect(listEmailAgentRuns({ threadId: t.id })).toEqual([]);
    expect(listEmailOutbox({ threadId: t.id })).toEqual([]);
    expect(getEmailThread(keep.id)).toBeDefined();
    expect(listEmailAssignments(other.id)).toHaveLength(1);
  });
});

describe('threads', () => {
  it('upserts: lower-cases addresses and only overwrites with non-empty values', () => {
    const a = upsertEmailThread({
      accountId: account.id, gmailThreadId: 'T1', subject: 'Order', customerEmail: ' Cust@Acme.com ',
      customerName: 'Cust', replyTo: 'Reply@Acme.com', category: 'primary',
    });
    expect(a).toMatchObject({
      customer_email: 'cust@acme.com', reply_to: 'reply@acme.com', category: 'primary',
      message_count: 0, unread_count: 0, last_message_at: 0, opted_out: 0, paused_until: null,
    });
    const b = upsertEmailThread({ accountId: account.id, gmailThreadId: 'T1', subject: '', customerName: 'New name' });
    expect(b.id).toBe(a.id);
    expect(b.subject).toBe('Order');
    expect(b.customer_email).toBe('cust@acme.com');
    expect(b.customer_name).toBe('New name');
    expect(b.category).toBe('primary');
    expect(getEmailThreadByGmail(account.id, 'T1')?.id).toBe(a.id);
    expect(getEmailThreadByGmail(account.id, 'nope')).toBeUndefined();
    expect(countEmailThreads(account.id)).toBe(1);
  });

  it('recordEmailThreadActivity: counts, unread rules and last_* only for the newest message', () => {
    const t = upsertEmailThread({ accountId: account.id, gmailThreadId: 'T1' });
    recordEmailThreadActivity(t.id, { atMs: 2000, preview: 'first', direction: 'in', incrementUnread: true, automatedReason: 'no-reply' });
    recordEmailThreadActivity(t.id, { atMs: 3000, preview: 'second', direction: 'in', incrementUnread: true });
    let row = getEmailThread(t.id)!;
    expect(row).toMatchObject({
      message_count: 2, unread_count: 2, last_message_at: 3000, last_preview: 'second',
      last_direction: 'in', automated_reason: '', // newest inbound rewrites it
    });

    // An older message that arrives late counts but does not rewind last_*.
    recordEmailThreadActivity(t.id, { atMs: 1000, preview: 'ancient', direction: 'in' });
    row = getEmailThread(t.id)!;
    expect(row).toMatchObject({ message_count: 3, unread_count: 2, last_message_at: 3000, last_preview: 'second' });

    // Inbound without incrementUnread (backfill) does not bump unread.
    recordEmailThreadActivity(t.id, { atMs: 3500, preview: 'backfill', direction: 'in' });
    expect(getEmailThread(t.id)!.unread_count).toBe(2);

    // Outbound resets unread and leaves automated_reason alone.
    recordEmailThreadActivity(t.id, { atMs: 4000, preview: 'ours', direction: 'out' });
    row = getEmailThread(t.id)!;
    expect(row).toMatchObject({ unread_count: 0, last_direction: 'out', last_preview: 'ours', message_count: 5 });
  });

  it('keeps an inbound automated_reason when an outbound reply follows', () => {
    const t = upsertEmailThread({ accountId: account.id, gmailThreadId: 'T1' });
    recordEmailThreadActivity(t.id, { atMs: 2000, preview: 'news', direction: 'in', automatedReason: 'list-unsubscribe' });
    recordEmailThreadActivity(t.id, { atMs: 3000, preview: 'ok', direction: 'out' });
    expect(getEmailThread(t.id)!.automated_reason).toBe('list-unsubscribe');
  });

  it('helpers: read, pause, opt-out, handled', () => {
    const t = upsertEmailThread({ accountId: account.id, gmailThreadId: 'T1' });
    recordEmailThreadActivity(t.id, { atMs: 2000, preview: 'p', direction: 'in', incrementUnread: true });
    markEmailThreadRead(t.id);
    setEmailThreadPause(t.id, 5555);
    setEmailThreadOptedOut(t.id, true);
    setEmailThreadHandled(t.id, 7);
    expect(getEmailThread(t.id)).toMatchObject({ unread_count: 0, paused_until: 5555, opted_out: 1, agent_handled_message_id: 7 });
    setEmailThreadPause(t.id, null);
    setEmailThreadOptedOut(t.id, false);
    expect(getEmailThread(t.id)).toMatchObject({ paused_until: null, opted_out: 0 });
  });
});

describe('messages', () => {
  it('round-trips bodies and dedupes on (account, gmail id)', () => {
    const t = upsertEmailThread({ accountId: account.id, gmailThreadId: 'T1' });
    const id = insertEmailMessage({
      threadId: t.id, accountId: account.id, gmailMessageId: 'm1', direction: 'in', senderType: 'customer',
      fromEmail: 'Cust@Acme.com', fromName: 'Cust', to: ['Owner@Shop.com'], cc: ['X@Y.com'], subject: 'Hi',
      bodyText: 'Xin chào, tôi cần hỗ trợ', bodyHtml: '<p>Xin chào</p>', snippet: 'Xin chào',
      headers: { 'message-id': '<a@b>' }, labels: ['INBOX'], attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', size: 1, attachmentId: 'x' }],
      origin: 'live', sentAtMs: 5000,
    });
    expect(id).toBeGreaterThan(0);
    const dup = insertEmailMessage({
      threadId: t.id, accountId: account.id, gmailMessageId: 'm1', direction: 'in', senderType: 'customer',
      fromEmail: 'c@x.com', origin: 'live', sentAtMs: 5000,
    });
    expect(dup).toBeNull();

    const row = getEmailMessage(id!)!;
    expect(row).toMatchObject({
      body_text: 'Xin chào, tôi cần hỗ trợ', body_html: '<p>Xin chào</p>', snippet: 'Xin chào',
      from_email: 'cust@acme.com', from_name: 'Cust', subject: 'Hi', origin: 'live', sent_at: 5000,
    });
    expect(JSON.parse(row.to_json)).toEqual(['owner@shop.com']);
    expect(JSON.parse(row.cc_json)).toEqual(['x@y.com']);
    expect(JSON.parse(row.labels_json)).toEqual(['INBOX']);
    expect(JSON.parse(row.headers_json)).toEqual({ 'message-id': '<a@b>' });
    expect(JSON.parse(row.attachments_json)).toHaveLength(1);
    expect(findEmailMessageByGmailId(account.id, 'm1')?.body_text).toBe('Xin chào, tôi cần hỗ trợ');
    expect(findEmailMessageByGmailId(account.id, 'zzz')).toBeUndefined();
  });

  it('keeps empty bodies empty', () => {
    const t = upsertEmailThread({ accountId: account.id, gmailThreadId: 'T1' });
    const id = msg(t.id, { bodyText: '', bodyHtml: undefined, snippet: undefined });
    expect(getEmailMessage(id)).toMatchObject({ body_text: '', body_html: '', snippet: '' });
  });

  it('getEmailMessages returns oldest to newest, limit keeps the newest, beforeMs pages back', () => {
    const t = upsertEmailThread({ accountId: account.id, gmailThreadId: 'T1' });
    const ids = [1, 2, 3, 4, 5].map((n) => msg(t.id, { sentAtMs: n * 1000, bodyText: `m${n}` }));
    expect(getEmailMessages(t.id).map((m) => m.id)).toEqual(ids);
    expect(getEmailMessages(t.id, { limit: 2 }).map((m) => m.body_text)).toEqual(['m4', 'm5']);
    expect(getEmailMessages(t.id, { limit: 2, beforeMs: 4000 }).map((m) => m.body_text)).toEqual(['m2', 'm3']);
  });

  it('lastEmailHumanReplyAt and countEmailSentSince look at the right sender types', () => {
    const t = upsertEmailThread({ accountId: account.id, gmailThreadId: 'T1' });
    expect(lastEmailHumanReplyAt(t.id)).toBeNull();
    msg(t.id, { direction: 'out', senderType: 'agent', sentAtMs: 9000 });
    expect(lastEmailHumanReplyAt(t.id)).toBeNull();
    msg(t.id, { direction: 'out', senderType: 'self', sentAtMs: 5000 });
    msg(t.id, { direction: 'out', senderType: 'operator', sentAtMs: 7000 });
    msg(t.id, { direction: 'in', senderType: 'customer', sentAtMs: 20000 });
    expect(lastEmailHumanReplyAt(t.id)).toBe(7000);
    expect(countEmailSentSince(account.id, 0)).toBe(2); // agent + operator, not self
    expect(countEmailSentSince(account.id, 8000)).toBe(1);
    expect(countEmailSentSince('other', 0)).toBe(0);
  });
});

describe('listEmailThreads', () => {
  function mk(gid: string, atMs: number, over: Partial<Parameters<typeof upsertEmailThread>[0]> = {}) {
    const t = upsertEmailThread({ accountId: account.id, gmailThreadId: gid, subject: `Subject ${gid}`, customerEmail: `${gid}@acme.com`, ...over });
    recordEmailThreadActivity(t.id, { atMs, preview: `preview ${gid}`, direction: 'in', incrementUnread: true });
    return t;
  }

  it('orders newest first, decrypts previews, pages with beforeMs and limit', () => {
    const a = mk('a', 1000);
    const b = mk('b', 3000);
    const c = mk('c', 2000);
    const rows = listEmailThreads({});
    expect(rows.map((r) => r.id)).toEqual([b.id, c.id, a.id]);
    expect(rows[0]!.last_preview).toBe('preview b');
    expect(listEmailThreads({ beforeMs: 2000 }).map((r) => r.id)).toEqual([a.id]);
    expect(listEmailThreads({ limit: 1 }).map((r) => r.id)).toEqual([b.id]);
  });

  it('filters by account', () => {
    const other = upsertEmailAccountFromConnection({ connectionId: 'ca_2', entityId: 'e', status: 'ACTIVE' });
    mk('a', 1000);
    const t = upsertEmailThread({ accountId: other.id, gmailThreadId: 'z' });
    recordEmailThreadActivity(t.id, { atMs: 5000, preview: 'p', direction: 'in' });
    expect(listEmailThreads({ accountId: other.id }).map((r) => r.id)).toEqual([t.id]);
    expect(listEmailThreads({})).toHaveLength(2);
  });

  it('needs_reply view: last inbound, not automated, not opted out', () => {
    const a = mk('a', 1000);
    const replied = mk('b', 2000);
    recordEmailThreadActivity(replied.id, { atMs: 2500, preview: 'ours', direction: 'out' });
    const auto = upsertEmailThread({ accountId: account.id, gmailThreadId: 'n' });
    recordEmailThreadActivity(auto.id, { atMs: 3000, preview: 'news', direction: 'in', automatedReason: 'no-reply' });
    const optedOut = mk('o', 4000);
    setEmailThreadOptedOut(optedOut.id, true);
    expect(listEmailThreads({ view: 'needs_reply' }).map((r) => r.id)).toEqual([a.id]);
  });

  it('drafts view and draft/pending counts', () => {
    const a = mk('a', 1000);
    const b = mk('b', 2000);
    enqueueEmailOutbox({ threadId: a.id, accountId: account.id, body: 'd1', toEmail: 'a@acme.com', origin: 'agent', status: 'draft' });
    enqueueEmailOutbox({ threadId: a.id, accountId: account.id, body: 'd2', toEmail: 'a@acme.com', origin: 'agent', status: 'draft' });
    enqueueEmailOutbox({ threadId: b.id, accountId: account.id, body: 'p', toEmail: 'b@acme.com', origin: 'operator', status: 'pending' });
    const drafts = listEmailThreads({ view: 'drafts' });
    expect(drafts.map((r) => r.id)).toEqual([a.id]);
    expect(drafts[0]).toMatchObject({ draft_count: 2, pending_count: 0 });
    const all = listEmailThreads({});
    expect(all.find((r) => r.id === b.id)).toMatchObject({ draft_count: 0, pending_count: 1 });
  });

  it('agent view: threads with a draft/queued/sent run, not skipped/failed', () => {
    const a = mk('a', 1000);
    const b = mk('b', 2000);
    const c = mk('c', 3000);
    insertEmailAgentRun({ threadId: a.id, status: 'sent', agentId: 'x' });
    insertEmailAgentRun({ threadId: b.id, status: 'skipped', agentId: 'x' });
    insertEmailAgentRun({ threadId: c.id, status: 'queued', agentId: 'x' });
    expect(listEmailThreads({ view: 'agent' }).map((r) => r.id)).toEqual([c.id, a.id]);
  });

  it('automated view: automated reason or non-primary category', () => {
    mk('p', 1000, { category: 'primary' });
    const promo = mk('promo', 2000, { category: 'promotions' });
    const auto = upsertEmailThread({ accountId: account.id, gmailThreadId: 'n', category: 'primary' });
    recordEmailThreadActivity(auto.id, { atMs: 3000, preview: 'n', direction: 'in', automatedReason: 'no-reply' });
    mk('uncat', 4000); // category '' counts as primary
    expect(listEmailThreads({ view: 'automated' }).map((r) => r.id)).toEqual([auto.id, promo.id]);
  });

  it('q matches subject, email and name case-insensitively and treats % and _ literally', () => {
    const a = mk('a', 1000, { subject: 'Báo giá Đơn Hàng', customerName: 'Nguyễn Văn A' });
    const b = mk('b', 2000, { subject: '100% off_sale', customerEmail: 'someone@Shop.vn' });
    mk('c', 3000, { subject: 'other' });
    expect(listEmailThreads({ q: 'ĐƠN hàng' }).map((r) => r.id)).toEqual([a.id]);
    expect(listEmailThreads({ q: 'SOMEONE@shop' }).map((r) => r.id)).toEqual([b.id]);
    expect(listEmailThreads({ q: 'văn a' }).map((r) => r.id)).toEqual([a.id]);
    expect(listEmailThreads({ q: '100%' }).map((r) => r.id)).toEqual([b.id]);
    expect(listEmailThreads({ q: 'off_s' }).map((r) => r.id)).toEqual([b.id]);
    expect(listEmailThreads({ q: '%' }).map((r) => r.id)).toEqual([b.id]);
    expect(listEmailThreads({ q: '   ' })).toHaveLength(3);
  });
});

describe('listEmailThreadsAwaitingAgent', () => {
  it('returns threads whose newest message is an unhandled live inbound', () => {
    const t = upsertEmailThread({ accountId: account.id, gmailThreadId: 'T1' });
    const m = msg(t.id);
    expect(listEmailThreadsAwaitingAgent(MIN_AGE_ZERO)).toEqual([t.id]);
    setEmailThreadHandled(t.id, m);
    expect(listEmailThreadsAwaitingAgent(MIN_AGE_ZERO)).toEqual([]);
    const m2 = msg(t.id); // a new inbound after the handled marker
    expect(listEmailThreadsAwaitingAgent(MIN_AGE_ZERO)).toEqual([t.id]);
    setEmailThreadHandled(t.id, m2);
    expect(listEmailThreadsAwaitingAgent(MIN_AGE_ZERO)).toEqual([]);
  });

  it('waits minAgeSec, skips backfill and threads whose newest message is outbound', () => {
    const fresh = upsertEmailThread({ accountId: account.id, gmailThreadId: 'fresh' });
    msg(fresh.id);
    expect(listEmailThreadsAwaitingAgent({ minAgeSec: 30, limit: 10 })).toEqual([]);
    expect(listEmailThreadsAwaitingAgent({ minAgeSec: 0, limit: 10 })).toEqual([fresh.id]);

    const old = upsertEmailThread({ accountId: account.id, gmailThreadId: 'old' });
    msg(old.id, { origin: 'backfill' });
    expect(listEmailThreadsAwaitingAgent(MIN_AGE_ZERO)).toEqual([fresh.id]);

    const answered = upsertEmailThread({ accountId: account.id, gmailThreadId: 'answered' });
    msg(answered.id, { sentAtMs: 1000 });
    msg(answered.id, { direction: 'out', senderType: 'self', sentAtMs: 2000 });
    expect(listEmailThreadsAwaitingAgent(MIN_AGE_ZERO)).toEqual([fresh.id]);
  });

  it('orders oldest first and honours the limit', () => {
    const a = upsertEmailThread({ accountId: account.id, gmailThreadId: 'a' });
    const b = upsertEmailThread({ accountId: account.id, gmailThreadId: 'b' });
    const c = upsertEmailThread({ accountId: account.id, gmailThreadId: 'c' });
    msg(b.id, { sentAtMs: 2000 });
    msg(c.id, { sentAtMs: 3000 });
    msg(a.id, { sentAtMs: 1000 });
    expect(listEmailThreadsAwaitingAgent(MIN_AGE_ZERO)).toEqual([a.id, b.id, c.id]);
    expect(listEmailThreadsAwaitingAgent({ minAgeSec: 0, limit: 2 })).toEqual([a.id, b.id]);
  });
});

describe('assignments', () => {
  it('upsert replaces the row for the same (account, scope, match) and lower-cases match_value', () => {
    const a = upsertEmailAssignment({
      accountId: account.id, scope: 'domain', matchValue: '  Acme.COM ', agentId: 'one', mode: 'auto',
      instructions: 'be nice', reviewKeywords: ['Hoàn tiền', ' ', 'hoàn tiền'], primaryOnly: false,
      maxRepliesPerThreadDay: 5, humanPauseMinutes: 10, autoDelaySeconds: 30, enabled: false,
    });
    expect(a).toMatchObject({
      scope: 'domain', match_value: 'acme.com', agent_id: 'one', mode: 'auto', instructions: 'be nice',
      review_keywords: ['Hoàn tiền', 'hoàn tiền'], primary_only: false, max_replies_per_thread_day: 5,
      human_pause_minutes: 10, auto_delay_seconds: 30, enabled: false,
    });
    const b = upsertEmailAssignment({ accountId: account.id, scope: 'domain', matchValue: 'ACME.com', agentId: 'two' });
    expect(b.id).toBe(a.id);
    expect(b).toMatchObject({
      agent_id: 'two', mode: 'draft', instructions: '', review_keywords: [], primary_only: true,
      max_replies_per_thread_day: 3, human_pause_minutes: 240, auto_delay_seconds: 120, enabled: true,
    });
    expect(b.created_at).toBe(a.created_at);
    expect(listEmailAssignments(account.id)).toHaveLength(1);
  });

  it('account scope ignores match_value; lists per account; deletes', () => {
    const a = upsertEmailAssignment({ accountId: account.id, scope: 'account', matchValue: 'ignored', agentId: 'x' });
    expect(a.match_value).toBe('');
    const again = upsertEmailAssignment({ accountId: account.id, scope: 'account', agentId: 'y' });
    expect(again.id).toBe(a.id);
    const s = upsertEmailAssignment({ accountId: account.id, scope: 'sender', matchValue: 'Bob@Acme.com', agentId: 'x' });
    expect(s.match_value).toBe('bob@acme.com');
    expect(listEmailAssignments().map((r) => r.id)).toEqual([a.id, s.id]);
    expect(deleteEmailAssignment(a.id)).toBe(true);
    expect(deleteEmailAssignment(a.id)).toBe(false);
    expect(listEmailAssignments(account.id).map((r) => r.id)).toEqual([s.id]);
  });
});

describe('agent runs', () => {
  it('stores and lists runs with thread info and decrypted reply', () => {
    const t = upsertEmailThread({ accountId: account.id, gmailThreadId: 'T1', subject: 'Báo giá', customerEmail: 'c@x.com' });
    const id = insertEmailAgentRun({ threadId: t.id, agentId: 'a', status: 'queued', replyText: 'Dạ vâng', latencyMs: 12, costUsd: 0.5, triggerMessageId: 3 });
    const [run] = listEmailAgentRuns({ threadId: t.id });
    expect(run).toMatchObject({
      id, reply_text: 'Dạ vâng', thread_subject: 'Báo giá', customer_email: 'c@x.com', account_id: account.id,
      status: 'queued', latency_ms: 12, cost_usd: 0.5, trigger_message_id: 3, assignment_id: null,
    });
    updateEmailAgentRunStatus(id, 'sent', 'đã gửi');
    expect(listEmailAgentRuns()[0]).toMatchObject({ status: 'sent', note: 'đã gửi' });
    updateEmailAgentRunStatus(id, 'draft');
    expect(listEmailAgentRuns()[0]).toMatchObject({ status: 'draft', note: 'đã gửi' });
    expect(listEmailAgentRuns({ accountId: 'nope' })).toEqual([]);
    expect(listEmailAgentRuns({ accountId: account.id })).toHaveLength(1);
  });

  it('counts only draft/queued/sent runs inside the window', () => {
    const t = upsertEmailThread({ accountId: account.id, gmailThreadId: 'T1' });
    const t2 = upsertEmailThread({ accountId: account.id, gmailThreadId: 'T2' });
    for (const status of ['draft', 'queued', 'sent', 'skipped', 'failed'] as const) {
      insertEmailAgentRun({ threadId: t.id, agentId: 'a', status });
    }
    insertEmailAgentRun({ threadId: t2.id, agentId: 'a', status: 'sent' });
    insertEmailAgentRun({ threadId: t2.id, agentId: 'b', status: 'sent' });
    expect(countEmailAgentReplies(t.id, now() - 60)).toBe(3);
    expect(countEmailAgentReplies(t.id, now() + 60)).toBe(0);
    expect(countEmailAgentRunsSince('a', now() - 60)).toBe(4);
    expect(countEmailAgentRunsSince('b', now() - 60)).toBe(1);
    expect(countEmailAgentRunsSince('a', now() + 60)).toBe(0);
  });

  it('prunes old runs', () => {
    const t = upsertEmailThread({ accountId: account.id, gmailThreadId: 'T1' });
    insertEmailAgentRun({ threadId: t.id, agentId: 'a', status: 'sent' });
    expect(pruneEmailAgentRuns(60)).toBe(0);
    expect(pruneEmailAgentRuns(-1)).toBe(1);
    expect(listEmailAgentRuns()).toEqual([]);
  });
});

describe('outbox lifecycle', () => {
  function mkThread() {
    return upsertEmailThread({ accountId: account.id, gmailThreadId: `T${++seq}`, customerEmail: 'c@x.com' });
  }
  const enqueue = (threadId: number, over: Partial<Parameters<typeof enqueueEmailOutbox>[0]> = {}) =>
    enqueueEmailOutbox({ threadId, accountId: account.id, body: 'Xin chào', toEmail: 'C@X.com', origin: 'agent', agentId: 'a', status: 'draft', ...over });

  it('draft -> approve (edited) -> claim -> sent', () => {
    const t = mkThread();
    const id = enqueue(t.id, { reviewReason: 'Có từ khoá', cc: ['Boss@X.com'] });
    let row = getEmailOutbox(id)!;
    expect(row).toMatchObject({
      status: 'draft', send_after: null, body: 'Xin chào', to_email: 'c@x.com', review_reason: 'Có từ khoá',
      origin: 'agent', agent_id: 'a', run_id: null, gmail_message_id: '', message_id: null, error: '', sent_at: null,
    });
    expect(JSON.parse(row.cc_json)).toEqual(['boss@x.com']);
    expect(claimDueEmailOutbox(now() + 100)).toBeNull(); // drafts are never claimed

    expect(approveEmailDraft(id, '  Đã sửa  ')).toBe(true);
    expect(approveEmailDraft(id)).toBe(false); // no longer a draft
    row = getEmailOutbox(id)!;
    expect(row).toMatchObject({ status: 'pending', body: 'Đã sửa', review_reason: 'Có từ khoá' });
    expect(row.send_after).toBeGreaterThan(0);

    const claimed = claimDueEmailOutbox(now() + 1)!;
    expect(claimed).toMatchObject({ id, status: 'sending', body: 'Đã sửa' });
    expect(claimDueEmailOutbox(now() + 1)).toBeNull();

    markEmailOutboxSent(id, { gmailMessageId: 'gm1', messageId: 42 });
    expect(getEmailOutbox(id)).toMatchObject({ status: 'sent', gmail_message_id: 'gm1', message_id: 42, error: '' });
    expect(getEmailOutbox(id)!.sent_at).toBeGreaterThan(0);
  });

  it('approve with a blank edit keeps the original body', () => {
    const id = enqueue(mkThread().id, { body: 'original' });
    approveEmailDraft(id, '   ');
    expect(getEmailOutbox(id)).toMatchObject({ status: 'pending', body: 'original' });
  });

  it('pending rows wait for send_after and are claimed oldest-due first', () => {
    const t = mkThread();
    const base = now();
    const later = enqueue(t.id, { status: 'pending', sendAfter: base + 600, body: 'later' });
    const soon = enqueue(t.id, { status: 'pending', sendAfter: base + 60, body: 'soon' });
    const noDelay = enqueue(t.id, { status: 'pending', body: 'now' });
    expect(getEmailOutbox(noDelay)!.send_after).toBeGreaterThanOrEqual(base);
    expect(claimDueEmailOutbox(base + 10)!.id).toBe(noDelay);
    expect(claimDueEmailOutbox(base + 10)).toBeNull();
    expect(claimDueEmailOutbox(base + 120)!.id).toBe(soon);
    expect(claimDueEmailOutbox(base + 120)).toBeNull();
    expect(getEmailOutbox(later)!.status).toBe('pending');
    expect(claimDueEmailOutbox(base + 700)!.id).toBe(later);
  });

  it('cancel pending -> draft, discard, return to draft', () => {
    const t = mkThread();
    const pending = enqueue(t.id, { status: 'pending', sendAfter: now() + 600 });
    expect(cancelEmailPending(pending)).toBe(true);
    expect(getEmailOutbox(pending)).toMatchObject({ status: 'draft', send_after: null, review_reason: 'Đã huỷ tự gửi' });
    expect(cancelEmailPending(pending)).toBe(false);

    expect(discardEmailOutbox(pending)).toBe(true);
    expect(getEmailOutbox(pending)!.status).toBe('discarded');
    expect(discardEmailOutbox(pending)).toBe(false);
    const p2 = enqueue(t.id, { status: 'pending' });
    expect(discardEmailOutbox(p2)).toBe(true);

    const p3 = enqueue(t.id, { status: 'pending' });
    claimDueEmailOutbox(now() + 1);
    expect(getEmailOutbox(p3)!.status).toBe('sending');
    expect(returnEmailOutboxToDraft(p3, 'Khách vừa trả lời')).toBe(true);
    expect(getEmailOutbox(p3)).toMatchObject({ status: 'draft', send_after: null, review_reason: 'Khách vừa trả lời' });
    expect(returnEmailOutboxToDraft(p3, 'again')).toBe(false); // already a draft

    const p4 = enqueue(t.id, { status: 'pending' });
    expect(returnEmailOutboxToDraft(p4, 'từ pending')).toBe(true);
    expect(getEmailOutbox(p4)!.status).toBe('draft');
  });

  it('failed rows keep a truncated error; interrupted sends are failed once', () => {
    const t = mkThread();
    const a = enqueue(t.id, { status: 'pending' });
    const b = enqueue(t.id, { status: 'pending' });
    const c = enqueue(t.id, { status: 'pending' });
    claimDueEmailOutbox(now() + 1);
    claimDueEmailOutbox(now() + 1);
    markEmailOutboxFailed(a, 'x'.repeat(900));
    expect(getEmailOutbox(a)).toMatchObject({ status: 'failed' });
    expect(getEmailOutbox(a)!.error).toHaveLength(500);
    expect(failInterruptedEmailOutbox()).toBe(1);
    expect(getEmailOutbox(b)).toMatchObject({ status: 'failed', error: 'interrupted' });
    expect(getEmailOutbox(c)!.status).toBe('pending');
    expect(failInterruptedEmailOutbox()).toBe(0);
  });

  it('lists and counts by thread, account and status', () => {
    const t1 = mkThread();
    const t2 = mkThread();
    const d = enqueue(t1.id);
    const p = enqueue(t1.id, { status: 'pending' });
    enqueue(t2.id);
    expect(listEmailOutbox({ threadId: t1.id }).map((r) => r.id)).toEqual([p, d]);
    expect(listEmailOutbox({ threadId: t1.id, statuses: ['draft'] }).map((r) => r.id)).toEqual([d]);
    expect(listEmailOutbox({ accountId: account.id })).toHaveLength(3);
    expect(listEmailOutbox({ accountId: 'x' })).toEqual([]);
    expect(countEmailOutbox('draft')).toBe(2);
    expect(countEmailOutbox('pending', account.id)).toBe(1);
    expect(countEmailOutbox('draft', 'x')).toBe(0);
  });
});

describe('settings', () => {
  it('get/set round-trip', () => {
    expect(getEmailSetting('k')).toBeNull();
    setEmailSetting('k', 'v1');
    setEmailSetting('k', 'v2');
    expect(getEmailSetting('k')).toBe('v2');
  });

  it('protection defaults, and the defaults object is never mutated', () => {
    const s = getEmailProtectionSettings();
    expect(s).toEqual(DEFAULT_EMAIL_PROTECTION);
    s.quietHours.enabled = true;
    s.extraAutomatedPatterns.push('x');
    expect(getEmailProtectionSettings()).toEqual(DEFAULT_EMAIL_PROTECTION);
    expect(DEFAULT_EMAIL_PROTECTION.quietHours.enabled).toBe(false);
  });

  it('protection: partial update merges, persists and deep-merges quietHours', () => {
    const a = saveEmailProtectionSettings({ agentDailyReplyCap: 50, quietHours: { enabled: true } });
    expect(a).toMatchObject({ agentDailyReplyCap: 50, quietHours: { enabled: true, start: '21:00', end: '07:00' }, staleHours: 72 });
    const b = saveEmailProtectionSettings({ quietHours: { start: '22:30' }, timezone: 'America/New_York' });
    expect(b.quietHours).toEqual({ enabled: true, start: '22:30', end: '07:00' });
    expect(b.agentDailyReplyCap).toBe(50);
    expect(getEmailProtectionSettings()).toEqual(b);
  });

  it('protection: clamps numbers and ignores invalid values', () => {
    const s = saveEmailProtectionSettings({
      agentDailyReplyCap: 99999, apiBudgetPerHour: 1, staleHours: 0.4,
      quietHours: { enabled: 'yes', start: '25:00', end: '7:00' }, timezone: 'Not/AZone',
    });
    expect(s.agentDailyReplyCap).toBe(10000);
    expect(s.apiBudgetPerHour).toBe(10);
    expect(s.staleHours).toBe(1);
    expect(s.quietHours).toEqual(DEFAULT_EMAIL_PROTECTION.quietHours);
    expect(s.timezone).toBe(DEFAULT_EMAIL_PROTECTION.timezone);

    const t = saveEmailProtectionSettings({ agentDailyReplyCap: 'lots', apiBudgetPerHour: Number.NaN, staleHours: 9999, quietHours: 'no', timezone: 42 });
    expect(t.agentDailyReplyCap).toBe(10000); // invalid type: keeps the current value
    expect(t.apiBudgetPerHour).toBe(10);
    expect(t.staleHours).toBe(720);
    expect(() => saveEmailProtectionSettings(null)).not.toThrow();
    expect(() => saveEmailProtectionSettings('garbage')).not.toThrow();
    expect(() => saveEmailProtectionSettings([1, 2])).not.toThrow();
    expect(getEmailProtectionSettings()).toEqual(t);
  });

  it('protection: extraAutomatedPatterns are trimmed, lower-cased, deduped and bounded', () => {
    const many = Array.from({ length: 80 }, (_, i) => `Pattern${i}`);
    const s = saveEmailProtectionSettings({ extraAutomatedPatterns: [' Billing@ ', '', 7, 'x'.repeat(101), 'billing@', ...many] });
    expect(s.extraAutomatedPatterns).toHaveLength(50);
    expect(s.extraAutomatedPatterns.slice(0, 3)).toEqual(['billing@', 'pattern0', 'pattern1']);
    expect(saveEmailProtectionSettings({ extraAutomatedPatterns: 'nope' }).extraAutomatedPatterns).toHaveLength(50);
    expect(saveEmailProtectionSettings({ extraAutomatedPatterns: [] }).extraAutomatedPatterns).toEqual([]);
  });

  it('protection: a corrupt stored value falls back to the defaults', () => {
    setEmailSetting('protection', '{not json');
    expect(getEmailProtectionSettings()).toEqual(DEFAULT_EMAIL_PROTECTION);
    setEmailSetting('protection', JSON.stringify({ staleHours: 5, quietHours: { start: 'bad' } }));
    expect(getEmailProtectionSettings()).toMatchObject({ staleHours: 5, quietHours: { start: '21:00' } });
  });
});

describe('api calls', () => {
  it('records, counts since and prunes', () => {
    const base = now();
    recordEmailApiCall('sync', true, base - 7200);
    recordEmailApiCall('sync', false, base - 100);
    recordEmailApiCall('send', true);
    expect(countEmailApiCallsSince(base - 3600)).toBe(2);
    expect(countEmailApiCallsSince(base - 10000)).toBe(3);
    expect(pruneEmailApiCalls(base - 3600)).toBe(1);
    expect(countEmailApiCallsSince(0)).toBe(2);
  });
});
