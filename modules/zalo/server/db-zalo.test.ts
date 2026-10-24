import { beforeEach, describe, expect, it } from 'vitest';

import {
  claimNextZaloOutbox,
  countZaloOutboundSince,
  createZaloAccount,
  deleteZaloAccount,
  addZaloUsage,
  countZaloBroadcastSince,
  enqueueZaloOutbox,
  failInterruptedZaloOutbox,
  getZaloAccount,
  getZaloProtectionSettings,
  getZaloUsage,
  saveZaloProtectionSettings,
  setZaloThreadOptedOut,
  updateZaloAccountSettings,
  getZaloAccountSession,
  getZaloMessages,
  getZaloThread,
  insertZaloMessage,
  lastZaloHumanReplyAt,
  listZaloAccounts,
  listZaloOutbox,
  listZaloThreads,
  markZaloMessagesRecalled,
  recordZaloThreadActivity,
  saveZaloAccountSession,
  searchZaloMessages,
  setZaloMessageRemoteIds,
  upsertZaloThread,
} from './store.js';
import { _initTestDatabase } from './test-db.js';

describe('zalo db', () => {
  let accountId: string;

  beforeEach(() => {
    _initTestDatabase();
    accountId = createZaloAccount('Nick test').id;
  });

  it('stores the session encrypted and reports has_session', () => {
    expect(listZaloAccounts()[0].has_session).toBe(0);
    saveZaloAccountSession(accountId, '{"imei":"x"}');
    expect(getZaloAccountSession(accountId)).toBe('{"imei":"x"}');
    expect(listZaloAccounts()[0].has_session).toBe(1);
  });

  it('upserts threads without wiping known names', () => {
    const t = upsertZaloThread({ accountId, threadType: 'group', externalId: 'g1', name: 'Nhóm A', membersCount: 10 });
    const again = upsertZaloThread({ accountId, threadType: 'group', externalId: 'g1' });
    expect(again.id).toBe(t.id);
    expect(again.name).toBe('Nhóm A');
    expect(again.members_count).toBe(10);
  });

  it('dedupes messages on (thread, zalo id) and keeps bodies encrypted at rest', () => {
    const t = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1', name: 'An' });
    const first = insertZaloMessage({
      threadId: t.id, zaloMsgId: '7000000000000000001', senderType: 'customer', body: 'Giá khoá học?',
      contentType: 'text', origin: 'live', sentAtMs: 1_000,
    });
    const dup = insertZaloMessage({
      threadId: t.id, zaloMsgId: '7000000000000000001', senderType: 'customer', body: 'Giá khoá học?',
      contentType: 'text', origin: 'backfill', sentAtMs: 1_000,
    });
    expect(first).not.toBeNull();
    expect(dup).toBeNull();
    const msgs = getZaloMessages(t.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe('Giá khoá học?');
    expect(searchZaloMessages({ query: 'gia khoa', accountId })).toHaveLength(1);
  });

  it('moves the thread pointer forward only, and counts unread for live inbound', () => {
    const t = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1' });
    recordZaloThreadActivity(t.id, { sentAtMs: 2_000, preview: 'mới', senderType: 'customer', live: true });
    recordZaloThreadActivity(t.id, { sentAtMs: 1_000, preview: 'cũ', senderType: 'customer', live: false });
    let row = getZaloThread(t.id)!;
    expect(row.last_preview).toBe('mới');
    expect(row.unread_count).toBe(1);
    recordZaloThreadActivity(t.id, { sentAtMs: 3_000, preview: 'trả lời', senderType: 'agent', live: true });
    row = getZaloThread(t.id)!;
    expect(row.unread_count).toBe(0);
    expect(row.last_sender_type).toBe('agent');
    expect(listZaloThreads({ accountId, unreadOnly: true }).threads).toHaveLength(0);
  });

  it('attaches remote ids to an outbound row and drops a phone-echo duplicate', () => {
    const t = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1' });
    const outbound = insertZaloMessage({ threadId: t.id, zaloMsgId: null, senderType: 'agent', body: 'Dạ', contentType: 'text', origin: 'outbound', sentAtMs: 5 })!;
    insertZaloMessage({ threadId: t.id, zaloMsgId: '55', senderType: 'self', body: 'Dạ', contentType: 'text', origin: 'live', sentAtMs: 6 });
    setZaloMessageRemoteIds(outbound, '55', '9');
    const msgs = getZaloMessages(t.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].sender_type).toBe('agent');
    expect(msgs[0].zalo_msg_id).toBe('55');
  });

  it('recalls by global or client id', () => {
    const t = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1' });
    insertZaloMessage({ threadId: t.id, zaloMsgId: '100', cliMsgId: '200', senderType: 'customer', body: 'x', contentType: 'text', origin: 'live', sentAtMs: 1 });
    expect(markZaloMessagesRecalled(accountId, { cliMsgId: '200' })).toBe(1);
    expect(getZaloMessages(t.id)[0].is_deleted).toBe(1);
  });

  it('tracks human replies and the nick cap from history', () => {
    const t = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1' });
    insertZaloMessage({ threadId: t.id, zaloMsgId: '1', senderType: 'self', body: 'a', contentType: 'text', origin: 'live', sentAtMs: 10_000 });
    insertZaloMessage({ threadId: t.id, zaloMsgId: '2', senderType: 'self', body: 'b', contentType: 'text', origin: 'backfill', sentAtMs: 20_000 });
    insertZaloMessage({ threadId: t.id, zaloMsgId: '3', senderType: 'agent', body: 'c', contentType: 'text', origin: 'outbound', sentAtMs: 30_000 });
    expect(lastZaloHumanReplyAt(t.id)).toBe(10_000);
    expect(countZaloOutboundSince(accountId, 0)).toBe(2);
  });

  it('runs the outbox: claim once, interrupted rows fail', () => {
    const t = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1' });
    const first = enqueueZaloOutbox({ threadId: t.id, body: 'gửi ngay', origin: 'operator' });
    enqueueZaloOutbox({ threadId: t.id, body: 'gửi sau', origin: 'operator' });
    const claimed = claimNextZaloOutbox();
    expect(claimed?.id).toBe(first);
    expect(claimed?.body).toBe('gửi ngay');
    expect(claimNextZaloOutbox()?.body).toBe('gửi sau');
    expect(claimNextZaloOutbox()).toBeNull();
    expect(failInterruptedZaloOutbox()).toBe(2);
    expect(listZaloOutbox({ threadId: t.id, statuses: ['failed'] })).toHaveLength(2);
  });

  it('deletes an account with all its data', () => {
    const t = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1' });
    insertZaloMessage({ threadId: t.id, zaloMsgId: '1', senderType: 'customer', body: 'hi', contentType: 'text', origin: 'live', sentAtMs: 1 });
    enqueueZaloOutbox({ threadId: t.id, body: 'x', origin: 'operator' });
    deleteZaloAccount(accountId);
    expect(listZaloAccounts()).toHaveLength(0);
    expect(getZaloThread(t.id)).toBeUndefined();
    expect(getZaloMessages(t.id, {})).toHaveLength(0);
    expect(listZaloOutbox({ threadId: t.id })).toHaveLength(0);
  });
  it('counts marketing sends in the nick cap and separately as broadcast', () => {
    const t = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1' });
    insertZaloMessage({ threadId: t.id, zaloMsgId: null, senderType: 'broadcast', body: 'khuyến mãi', contentType: 'text', origin: 'outbound', sentAtMs: 5_000 });
    insertZaloMessage({ threadId: t.id, zaloMsgId: null, senderType: 'operator', body: 'chào', contentType: 'text', origin: 'outbound', sentAtMs: 6_000 });
    expect(countZaloOutboundSince(accountId, 0)).toBe(2);
    expect(countZaloBroadcastSince(accountId, 0)).toBe(1);
    expect(countZaloBroadcastSince(accountId, 5_500)).toBe(0);
  });

  it('merges, validates and clamps the protection settings', () => {
    expect(getZaloProtectionSettings()).toMatchObject({
      timezone: 'Asia/Ho_Chi_Minh', quietHours: { enabled: true, start: '22:00', end: '07:00' },
      agentDailyReplyCap: 500, restrictionLockThreshold: 3, warmupSchedule: [30, 80, 150], bulkSharePercent: 60,
    });
    const saved = saveZaloProtectionSettings({
      quietHours: { start: '23:30', end: 'bad' }, bulkSharePercent: 250, restrictionLockThreshold: 0,
      timezone: 'Not/AZone', warmupSchedule: [10, 20], limits: { query: { daily: 50 }, nope: { daily: 1 } },
    });
    expect(saved.quietHours).toEqual({ enabled: true, start: '23:30', end: '07:00' });
    expect(saved.bulkSharePercent).toBe(100);
    expect(saved.restrictionLockThreshold).toBe(0);
    expect(saved.timezone).toBe('Asia/Ho_Chi_Minh');
    expect(saved.warmupSchedule).toEqual([10, 20]);
    expect(saved.limits).toEqual({ query: { daily: 50 } });
    // A later partial save keeps earlier fields.
    expect(saveZaloProtectionSettings({ agentDailyReplyCap: 40 })).toMatchObject({ agentDailyReplyCap: 40, bulkSharePercent: 100 });
    expect(getZaloProtectionSettings().agentDailyReplyCap).toBe(40);
  });

  it('stores warm-up, lock and per-nick limits on the account', () => {
    expect(getZaloAccount(accountId)).toMatchObject({ warmup_enabled: 0, warmup_started_at: null, send_lock_reason: '', limits_json: '{}' });
    const fresh = createZaloAccount('Nick mới', { warmup: true });
    expect(fresh.warmup_enabled).toBe(1);
    updateZaloAccountSettings(accountId, { send_lock_reason: 'bị từ chối', chat_enabled: 0, limits_json: '{"query":{"daily":5}}' });
    expect(getZaloAccount(accountId)).toMatchObject({ send_lock_reason: 'bị từ chối', chat_enabled: 0, limits_json: '{"query":{"daily":5}}' });
  });

  it('accumulates daily usage per category and day', () => {
    addZaloUsage(accountId, '2026-10-07', 'query');
    addZaloUsage(accountId, '2026-10-07', 'query', 4);
    addZaloUsage(accountId, '2026-10-08', 'query');
    expect(getZaloUsage(accountId, '2026-10-07')).toEqual({ query: 5 });
    expect(getZaloUsage(accountId, '2026-10-08')).toEqual({ query: 1 });
  });

  it('marks a thread as opted out', () => {
    const t = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1' });
    expect(getZaloThread(t.id)?.opted_out).toBe(0);
    setZaloThreadOptedOut(t.id, true);
    expect(getZaloThread(t.id)).toMatchObject({ opted_out: 1 });
    expect(getZaloThread(t.id)?.opted_out_at).toBeGreaterThan(0);
    setZaloThreadOptedOut(t.id, false);
    expect(getZaloThread(t.id)).toMatchObject({ opted_out: 0, opted_out_at: null });

  });
});
