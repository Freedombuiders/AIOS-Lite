import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createZaloAccount,
  getZaloAccount,
  getZaloMessages,
  insertZaloMessage,
  saveZaloProtectionSettings,
  updateZaloAccountSettings,
  upsertZaloThread,
} from './store.js';
import { _initTestDatabase } from './test-db.js';
import { ZaloLimiter } from './limits.js';
import { ZaloSendError, ZaloSender } from './sender.js';
import type { ZaloSessionPool } from './session.js';

// 2026-10-07 10:00 in Ho Chi Minh — outside the default 22:00–07:00 quiet hours.
const DAYTIME = new Date('2026-10-07T03:00:00Z');
const NIGHT = new Date('2026-10-07T16:30:00Z'); // 23:30 local

interface FakeApi {
  sendMessage: ReturnType<typeof vi.fn>;
  sendTypingEvent: ReturnType<typeof vi.fn>;
}

function fakeApi(): FakeApi {
  let next = 1000;
  return {
    sendMessage: vi.fn(async (content: { attachments?: string[] }) => ({
      message: content.attachments ? null : { msgId: next++ },
      attachment: (content.attachments ?? []).map(() => ({ msgId: next++ })),
    })),
    sendTypingEvent: vi.fn(async () => ({})),
  };
}

function fakePool(api: FakeApi | null): ZaloSessionPool {
  return {
    getApi: () => api,
    reconnect: async () => {},
    limiter: new ZaloLimiter(),
  } as unknown as ZaloSessionPool;
}

/** What zca-js throws when Zalo rejects a request. */
function zaloReject(code: number): Error {
  return Object.assign(new Error('Zalo rejected the request'), { code });
}

describe('ZaloSender', () => {
  let accountId: string;
  let threadId: number;
  let api: FakeApi;
  let sender: ZaloSender;
  let notify: ReturnType<typeof vi.fn>;
  let sleeps: number[];
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DAYTIME);
    _initTestDatabase();
    accountId = createZaloAccount('Nick').id;
    threadId = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1', name: 'An' }).id;
    api = fakeApi();
    notify = vi.fn(async () => {});
    sleeps = [];
    sender = new ZaloSender(fakePool(api), { notify, sleep: async (ms) => { sleeps.push(ms); } });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zalo-sender-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function file(name: string): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, 'x');
    return p;
  }

  function sendTo(tid: number = threadId) {
    return sender.sendText({ threadId: tid, text: 'chào', senderType: 'operator' });
  }

  describe('sendRich', () => {
    it('sends text with normalised styles and stores the remote id', async () => {
      const { messageIds } = await sender.sendRich({
        threadId, text: 'Khuyến mãi lớn', senderType: 'broadcast',
        styles: [{ st: 'b', start: 0, len: 9 }, { st: 'bogus', start: 0, len: 3 }],
      });
      expect(messageIds).toHaveLength(1);
      const [content, tid] = api.sendMessage.mock.calls[0];
      expect(content).toEqual({ msg: 'Khuyến mãi lớn', styles: [{ st: 'b', start: 0, len: 9 }] });
      expect(tid).toBe('u1');
      const stored = getZaloMessages(threadId);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ sender_type: 'broadcast', zalo_msg_id: '1000', body: 'Khuyến mãi lớn' });
    });

    it('omits an empty styles array and ignores mentions in a 1-1 chat', async () => {
      await sender.sendRich({
        threadId, text: 'hi', senderType: 'operator', styles: [{ st: 'b', start: 10, len: 2 }],
        mentions: [{ uid: 'x', pos: 0, len: 2, type: 0 }],
      });
      expect(api.sendMessage.mock.calls[0][0]).toEqual({ msg: 'hi' });
    });

    it('passes mentions in groups', async () => {
      const g = upsertZaloThread({ accountId, threadType: 'group', externalId: 'g1', name: 'Nhóm' }).id;
      await sender.sendRich({ threadId: g, text: '@An chào', senderType: 'agent', mentions: [{ uid: 'u9', pos: 0, len: 3, type: 0 }] });
      expect(api.sendMessage.mock.calls[0][0]).toEqual({ msg: '@An chào', mentions: [{ uid: 'u9', pos: 0, len: 3 }] });
    });

    it('sends text first, waits 0.8–2.5 s, then the attachments in one call', async () => {
      const img = file('a.jpg');
      const doc = file('b.pdf');
      const { messageIds } = await sender.sendRich({
        threadId, text: 'Tài liệu', senderType: 'broadcast',
        attachments: [{ path: img, kind: 'image' }, { path: doc, kind: 'file', name: 'Bảng giá.pdf' }],
      });
      expect(messageIds).toHaveLength(3);
      expect(api.sendMessage).toHaveBeenCalledTimes(2);
      expect(api.sendMessage.mock.calls[1][0]).toEqual({ msg: '', attachments: [img, doc] });
      expect(sleeps).toHaveLength(1);
      expect(sleeps[0]).toBeGreaterThanOrEqual(800);
      expect(sleeps[0]).toBeLessThanOrEqual(2500);
      const rows = getZaloMessages(threadId);
      expect(rows.map((r) => r.content_type)).toEqual(['text', 'image', 'file']);
      expect(JSON.parse(rows[2].body)).toMatchObject({ title: 'Bảng giá.pdf' });
      expect(rows.every((r) => r.zalo_msg_id !== null)).toBe(true);
    });

    it('rejects empty sends and missing files without calling Zalo', async () => {
      await expect(sender.sendRich({ threadId, senderType: 'operator' })).rejects.toMatchObject({ code: 'INVALID' });
      await expect(sender.sendRich({ threadId, senderType: 'operator', attachments: [{ path: '/nope/x.jpg', kind: 'image' }] }))
        .rejects.toMatchObject({ code: 'INVALID' });
      expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it('reports the rows already sent when the attachment step fails', async () => {
      // Every call after the text step fails (exec retries network blips).
      api.sendMessage.mockImplementationOnce(async () => ({ message: { msgId: 7 }, attachment: [] }));
      api.sendMessage.mockImplementation(async () => { throw new Error('fetch failed'); });
      const err = await sender.sendRich({
        threadId, text: 'a', senderType: 'broadcast', attachments: [{ path: file('c.jpg'), kind: 'image' }],
      }).catch((e: unknown) => e) as ZaloSendError;
      expect(err).toBeInstanceOf(ZaloSendError);
      expect(err.messageIds).toHaveLength(1);
      // The failed attachment row is gone, the text row stays.
      expect(getZaloMessages(threadId)).toHaveLength(1);
    }, 10_000);
  });

  describe('bulk sends', () => {
    it('are refused in quiet hours but not for operators', async () => {
      vi.setSystemTime(NIGHT);
      await expect(sender.sendRich({ threadId, text: 'sale', senderType: 'broadcast', bulk: true }))
        .rejects.toMatchObject({ code: 'QUIET_HOURS' });
      expect(api.sendMessage).not.toHaveBeenCalled();
      await expect(sender.sendRich({ threadId, text: 'chào anh', senderType: 'operator' })).resolves.toBeTruthy();
    });

    it('stop when the bulk share of the daily cap is used up', async () => {
      updateZaloAccountSettings(accountId, { daily_message_cap: 10 });
      saveZaloProtectionSettings({ bulkSharePercent: 50 });
      expect(sender.bulkBudgetRemaining(accountId)).toBe(5);
      for (let i = 0; i < 5; i++) await sender.sendRich({ threadId, text: `km ${i}`, senderType: 'broadcast', bulk: true });
      expect(sender.bulkBudgetRemaining(accountId)).toBe(0);
      await expect(sender.sendRich({ threadId, text: 'km 6', senderType: 'broadcast', bulk: true }))
        .rejects.toMatchObject({ code: 'BULK_BUDGET' });
      // Operators still have the other half of the cap.
      await expect(sendTo()).resolves.toBeTruthy();
    });

    it('budget is the smaller of the bulk share and what is left of the cap', () => {
      updateZaloAccountSettings(accountId, { daily_message_cap: 10 });
      saveZaloProtectionSettings({ bulkSharePercent: 60 });
      expect(sender.bulkBudgetRemaining(accountId)).toBe(6);
      // 8 human messages leave 2 of the 10, fewer than the 6 the share allows.
      for (let i = 0; i < 8; i++) {
        insertZaloMessage({ threadId, zaloMsgId: `h${i}`, senderType: 'self', body: 'x', contentType: 'text', origin: 'live', sentAtMs: Date.now() - 1000 });
      }
      expect(sender.bulkBudgetRemaining(accountId)).toBe(2);
      expect(sender.bulkBudgetRemaining('missing')).toBe(0);
    });

    it('shrink with the warm-up cap', () => {
      const t0 = Math.floor(Date.now() / 1000);
      updateZaloAccountSettings(accountId, { warmup_enabled: 1, warmup_started_at: t0 });
      // Week 1: 30 messages, 60 % for marketing.
      expect(sender.bulkBudgetRemaining(accountId)).toBe(18);
    });
  });

  describe('limits shared by every send', () => {
    it('sendText stops at the daily cap', async () => {
      updateZaloAccountSettings(accountId, { daily_message_cap: 2 });
      await sendTo();
      await sendTo();
      await expect(sendTo()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      expect(api.sendMessage).toHaveBeenCalledTimes(2);
    });

    it('a warming-up nick is held to its week-1 cap', async () => {
      saveZaloProtectionSettings({ warmupSchedule: [3, 6, 9], limits: { message: { burst: 100 } } });
      updateZaloAccountSettings(accountId, { warmup_enabled: 1, warmup_started_at: Math.floor(Date.now() / 1000) });
      for (let i = 0; i < 3; i++) await sendTo();
      await expect(sendTo()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    });

    it('sendText stops at the burst limit', async () => {
      for (let i = 0; i < 20; i++) await sendTo();
      await expect(sendTo()).rejects.toMatchObject({ code: 'RATE_LIMITED', message: expect.stringContaining('quá nhanh') });
    });

    it('refuses while chat is off, and says LOCKED for an automatic lock', async () => {
      updateZaloAccountSettings(accountId, { chat_enabled: 0 });
      await expect(sendTo()).rejects.toMatchObject({ code: 'CHAT_DISABLED' });
      updateZaloAccountSettings(accountId, { send_lock_reason: '3 lần bị Zalo từ chối' });
      await expect(sendTo()).rejects.toMatchObject({ code: 'LOCKED' });
      await expect(sender.sendRich({ threadId, text: 'x', senderType: 'broadcast', bulk: true })).rejects.toMatchObject({ code: 'LOCKED' });
    });

    it('tryConsume draws on the category budget', () => {
      saveZaloProtectionSettings({ limits: { friend_action: { daily: 2, burst: 5 } } });
      expect(sender.tryConsume(accountId, 'friend_action')).toBe(true);
      expect(sender.tryConsume(accountId, 'friend_action')).toBe(true);
      expect(sender.tryConsume(accountId, 'friend_action')).toBe(false);
    });

    it('typing pings are counted as chat_action', () => {
      saveZaloProtectionSettings({ limits: { chat_action: { daily: 2, burst: 10 } } });
      const thread = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1' });
      const stop = sender.startTyping(thread);
      stop();
      const stop2 = sender.startTyping(thread);
      stop2();
      sender.startTyping(thread)();
      expect(api.sendTypingEvent).toHaveBeenCalledTimes(2);
    });
  });

  describe('restriction auto-lock', () => {
    let threadB: number;

    beforeEach(() => {
      threadB = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u2', name: 'Bình' }).id;
      api.sendMessage.mockImplementation(async () => { throw zaloReject(-1); });
    });

    it('locks the nick after 3 rejections across 2 threads and notifies', async () => {
      await expect(sendTo(threadId)).rejects.toMatchObject({ code: 'API_ERROR', message: expect.stringContaining('[zalo:-1]') });
      await expect(sendTo(threadId)).rejects.toMatchObject({ code: 'API_ERROR' });
      expect(getZaloAccount(accountId)?.chat_enabled).toBe(1);
      await expect(sendTo(threadB)).rejects.toMatchObject({ code: 'API_ERROR' });

      const acc = getZaloAccount(accountId)!;
      expect(acc.chat_enabled).toBe(0);
      expect(acc.send_lock_reason).toContain('3 lần');
      expect(acc.send_lock_reason).toContain('[zalo:-1]');
      expect(notify).toHaveBeenCalledTimes(1);
      expect(String(notify.mock.calls[0][0])).toContain('khoá');
      expect(api.sendMessage).toHaveBeenCalledTimes(3);

      await expect(sendTo(threadB)).rejects.toMatchObject({ code: 'LOCKED' });
      expect(api.sendMessage).toHaveBeenCalledTimes(3);
    });

    it('needs threshold + 2 failures when they all hit one thread', async () => {
      for (let i = 0; i < 4; i++) await sendTo(threadId).catch(() => {});
      expect(getZaloAccount(accountId)?.chat_enabled).toBe(1);
      await sendTo(threadId).catch(() => {});
      expect(getZaloAccount(accountId)).toMatchObject({ chat_enabled: 0 });
      expect(getZaloAccount(accountId)?.send_lock_reason).toContain('5 lần');
    });

    it('a successful send resets the count', async () => {
      await sendTo(threadId).catch(() => {});
      await sendTo(threadB).catch(() => {});
      api.sendMessage.mockImplementationOnce(async () => ({ message: { msgId: 1 }, attachment: [] }));
      await sendTo(threadB);
      api.sendMessage.mockImplementation(async () => { throw zaloReject(-1); });
      await sendTo(threadId).catch(() => {});
      await sendTo(threadB).catch(() => {});
      expect(getZaloAccount(accountId)?.chat_enabled).toBe(1);
    });

    it('does not lock when the threshold is 0', async () => {
      saveZaloProtectionSettings({ restrictionLockThreshold: 0 });
      for (let i = 0; i < 6; i++) await sendTo(i % 2 ? threadB : threadId).catch(() => {});
      expect(getZaloAccount(accountId)?.chat_enabled).toBe(1);
    });

    it('ignores offline nicks and rate limits', async () => {
      const offline = new ZaloSender(fakePool(null), { notify });
      for (let i = 0; i < 6; i++) {
        await expect(offline.sendText({ threadId: i % 2 ? threadB : threadId, text: 'x', senderType: 'operator' }))
          .rejects.toMatchObject({ code: 'NOT_CONNECTED' });
      }
      expect(getZaloAccount(accountId)?.chat_enabled).toBe(1);
    });

    it('does not count network failures', async () => {
      api.sendMessage.mockImplementation(async () => { throw new Error('read ECONNRESET'); });
      vi.useRealTimers(); // exec backs off between network retries
      for (let i = 0; i < 2; i++) {
        await sendTo(i ? threadB : threadId).catch(() => {});
      }
      expect(getZaloAccount(accountId)?.chat_enabled).toBe(1);
    }, 15_000);
  });
});
