import { beforeEach, describe, expect, it } from 'vitest';

import { createZaloAccount,
  getZaloAccount,
  getZaloProtectionSettings,
  insertZaloMessage,
  saveZaloProtectionSettings,
  updateZaloAccountSettings,
  upsertZaloThread,
  type ZaloAccountRow,
} from './store.js';
import { _initTestDatabase } from './test-db.js';
import {
  classifyZaloError,
  DEFAULT_LIMITS,
  effectiveLimit,
  effectiveMessageCap,
  isNoise,
  isQuietHours,
  isWithinHours,
  localDay,
  matchesOptOut,
  startOfLocalDayMs,
  warmupWeek,
  ZaloLimiter,
} from './limits.js';
import { ZaloSendError } from './sender.js';

const TZ = 'Asia/Ho_Chi_Minh';
const DAY = 86400;

/** Local HCM wall time as a Date (UTC+7, no DST). */
function hcm(iso: string): Date {
  return new Date(`${iso}+07:00`);
}

function account(over: Partial<ZaloAccountRow> = {}): ZaloAccountRow {
  return {
    id: 'acc', label: 'Nick', zalo_uid: 'me', display_name: '', avatar_url: '', status: 'connected',
    chat_enabled: 1, daily_message_cap: 200, manual_disconnect: 0, last_error: '', last_connected_at: null,
    created_at: 0, updated_at: 0, has_session: 1,
    limits_json: '{}', send_lock_reason: '', warmup_enabled: 0, warmup_started_at: null,
    ...over,
  };
}

describe('time in the settings timezone', () => {
  it('detects windows that cross midnight', () => {
    expect(isWithinHours(hcm('2026-10-07T23:00:00'), '22:00', '07:00', TZ)).toBe(true);
    expect(isWithinHours(hcm('2026-10-07T03:30:00'), '22:00', '07:00', TZ)).toBe(true);
    expect(isWithinHours(hcm('2026-10-07T22:00:00'), '22:00', '07:00', TZ)).toBe(true);
    expect(isWithinHours(hcm('2026-10-07T07:00:00'), '22:00', '07:00', TZ)).toBe(false);
    expect(isWithinHours(hcm('2026-10-07T12:00:00'), '22:00', '07:00', TZ)).toBe(false);
  });

  it('handles same-day windows and an empty window', () => {
    expect(isWithinHours(hcm('2026-10-07T13:00:00'), '12:00', '14:00', TZ)).toBe(true);
    expect(isWithinHours(hcm('2026-10-07T14:00:00'), '12:00', '14:00', TZ)).toBe(false);
    expect(isWithinHours(hcm('2026-10-07T13:00:00'), '09:00', '09:00', TZ)).toBe(false);
  });

  it('uses the timezone, not the machine clock', () => {
    // 16:30 UTC is 23:30 in Ho Chi Minh but 09:30 in Los Angeles.
    const at = new Date('2026-10-07T16:30:00Z');
    expect(isWithinHours(at, '22:00', '07:00', TZ)).toBe(true);
    expect(isWithinHours(at, '22:00', '07:00', 'America/Los_Angeles')).toBe(false);
  });

  it('computes the local day and its midnight', () => {
    const at = new Date('2026-10-07T20:00:00Z'); // 03:00 on 8 Oct in HCM
    expect(localDay(at, TZ)).toBe('2026-10-08');
    expect(new Date(startOfLocalDayMs(at, TZ)).toISOString()).toBe('2026-10-07T17:00:00.000Z');
    const noon = new Date('2026-10-07T05:00:00Z'); // 12:00 on 7 Oct
    expect(new Date(startOfLocalDayMs(noon, TZ)).toISOString()).toBe('2026-10-06T17:00:00.000Z');
  });
});

describe('quiet hours from settings', () => {
  beforeEach(() => _initTestDatabase());

  it('follows the saved window and the on/off switch', () => {
    expect(isQuietHours(hcm('2026-10-07T23:15:00'))).toBe(true);
    expect(isQuietHours(hcm('2026-10-07T10:00:00'))).toBe(false);
    saveZaloProtectionSettings({ quietHours: { start: '12:00', end: '13:00' } });
    expect(isQuietHours(hcm('2026-10-07T12:30:00'))).toBe(true);
    expect(isQuietHours(hcm('2026-10-07T23:15:00'))).toBe(false);
    saveZaloProtectionSettings({ quietHours: { enabled: false } });
    expect(isQuietHours(hcm('2026-10-07T12:30:00'))).toBe(false);
  });
});

describe('warm-up', () => {
  const start = Math.floor(hcm('2026-10-01T09:00:00').getTime() / 1000);
  const schedule = [30, 80, 150];

  it('moves to the next week every 7 days and ends after the schedule', () => {
    const acc = account({ warmup_enabled: 1, warmup_started_at: start });
    const at = (days: number) => new Date((start + days * DAY) * 1000);
    expect(warmupWeek(acc, at(0), schedule)).toBe(1);
    expect(warmupWeek(acc, at(6), schedule)).toBe(1);
    expect(warmupWeek(acc, at(7), schedule)).toBe(2);
    expect(warmupWeek(acc, at(14), schedule)).toBe(3);
    expect(warmupWeek(acc, at(21), schedule)).toBe(0);
  });

  it('does nothing while disabled or before the first connect', () => {
    expect(warmupWeek(account({ warmup_enabled: 0, warmup_started_at: start }), new Date(), schedule)).toBe(0);
    expect(warmupWeek(account({ warmup_enabled: 1, warmup_started_at: null }), new Date(), schedule)).toBe(0);
  });

  describe('message cap', () => {
    beforeEach(() => _initTestDatabase());

    it('is the lower of the nick cap and the warm-up cap', () => {
      const acc = account({ warmup_enabled: 1, warmup_started_at: start });
      expect(effectiveMessageCap(acc, new Date((start + 2 * DAY) * 1000))).toBe(30);
      expect(effectiveMessageCap(acc, new Date((start + 9 * DAY) * 1000))).toBe(80);
      expect(effectiveMessageCap(acc, new Date((start + 30 * DAY) * 1000))).toBe(200);
      expect(effectiveMessageCap({ ...acc, daily_message_cap: 20 }, new Date((start + 2 * DAY) * 1000))).toBe(20);
    });

    it('uses the saved warm-up schedule', () => {
      saveZaloProtectionSettings({ warmupSchedule: [5, 10] });
      const acc = account({ warmup_enabled: 1, warmup_started_at: start });
      expect(effectiveMessageCap(acc, new Date((start + DAY) * 1000))).toBe(5);
      expect(effectiveMessageCap(acc, new Date((start + 15 * DAY) * 1000))).toBe(200);
    });
  });
});

describe('effective limits', () => {
  beforeEach(() => _initTestDatabase());

  it('layers code default → global override → nick override, field by field', () => {
    const plain = account();
    expect(effectiveLimit(plain, 'query')).toMatchObject({ daily: 2000, burst: 30, windowMs: 30_000 });

    saveZaloProtectionSettings({ limits: { query: { daily: 1500, burst: 10 } } });
    expect(effectiveLimit(plain, 'query')).toMatchObject({ daily: 1500, burst: 10, windowMs: 30_000 });

    const nick = account({ limits_json: JSON.stringify({ query: { daily: 400, windowSec: 60 } }) });
    expect(effectiveLimit(nick, 'query')).toMatchObject({ daily: 400, burst: 10, windowMs: 60_000 });
    // Untouched categories keep the code default.
    expect(effectiveLimit(nick, 'profile')).toMatchObject({ daily: DEFAULT_LIMITS.profile.daily, burst: 3 });
  });

  it('treats a message.daily override as a ceiling on the nick cap', () => {
    saveZaloProtectionSettings({ limits: { message: { daily: 120 } } });
    expect(effectiveMessageCap(account())).toBe(120);
    expect(effectiveMessageCap(account({ limits_json: '{"message":{"daily":50}}' }))).toBe(50);
    expect(effectiveMessageCap(account({ daily_message_cap: 80 }))).toBe(80);
  });

  it('ignores a corrupt per-nick override', () => {
    expect(effectiveLimit(account({ limits_json: '{not json' }), 'query').daily).toBe(2000);
  });
});

describe('ZaloLimiter', () => {
  let accountId: string;
  let threadId: number;

  beforeEach(() => {
    _initTestDatabase();
    accountId = createZaloAccount('Nick').id;
    threadId = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1' }).id;
  });

  it('enforces the burst window and frees it afterwards', () => {
    const lim = new ZaloLimiter();
    const t0 = hcm('2026-10-07T10:00:00').getTime();
    for (let i = 0; i < DEFAULT_LIMITS.profile.burst; i++) expect(lim.consume(accountId, 'profile', 1, t0 + i).ok).toBe(true);
    const blocked = lim.check(accountId, 'profile', 1, t0 + 100);
    expect(blocked).toMatchObject({ ok: false, reason: 'burst' });
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(lim.check(accountId, 'profile', 1, t0 + 61_000).ok).toBe(true);
  });

  it('enforces the daily cap and resets at local midnight', () => {
    saveZaloProtectionSettings({ limits: { group_read: { daily: 3, burst: 100 } } });
    const lim = new ZaloLimiter();
    const evening = hcm('2026-10-07T23:50:00').getTime();
    expect(lim.consume(accountId, 'group_read', 3, evening).ok).toBe(true);
    expect(lim.check(accountId, 'group_read', 1, evening + 1000)).toMatchObject({ ok: false, reason: 'daily' });
    expect(lim.remaining(accountId, 'group_read', evening + 1000)).toBe(0);
    const nextMorning = hcm('2026-10-08T00:10:00').getTime();
    expect(lim.remaining(accountId, 'group_read', nextMorning)).toBe(3);
    expect(lim.consume(accountId, 'group_read', 1, nextMorning).ok).toBe(true);
  });

  it('counts messages from the history, so a restart does not reset them', () => {
    updateZaloAccountSettings(accountId, { daily_message_cap: 3 });
    const now = hcm('2026-10-07T10:00:00').getTime();
    for (let i = 0; i < 3; i++) {
      insertZaloMessage({ threadId, zaloMsgId: String(i + 1), senderType: 'operator', body: 'x', contentType: 'text', origin: 'outbound', sentAtMs: now - 1000 });
    }
    // Yesterday's message does not count.
    insertZaloMessage({ threadId, zaloMsgId: '99', senderType: 'operator', body: 'cũ', contentType: 'text', origin: 'outbound', sentAtMs: hcm('2026-10-06T10:00:00').getTime() });
    const fresh = new ZaloLimiter();
    expect(fresh.used(accountId, 'message', now)).toBe(3);
    expect(fresh.check(accountId, 'message', 1, now)).toMatchObject({ ok: false, reason: 'daily' });
    expect(fresh.remaining(accountId, 'message', now)).toBe(0);
  });

  it('reports usage against each category limit', () => {
    const lim = new ZaloLimiter();
    const now = hcm('2026-10-07T10:00:00').getTime();
    lim.consume(accountId, 'query', 4, now);
    const usage = lim.usage(accountId, now);
    expect(usage.query).toEqual({ used: 4, limit: 2000 });
    expect(usage.message).toEqual({ used: 0, limit: 1000 });
    expect(Object.keys(usage)).toHaveLength(9);
  });

  it('applies the per-nick override immediately', () => {
    updateZaloAccountSettings(accountId, { limits_json: JSON.stringify({ query: { daily: 2 } }) });
    const lim = new ZaloLimiter();
    const now = hcm('2026-10-07T10:00:00').getTime();
    expect(lim.consume(accountId, 'query', 2, now).ok).toBe(true);
    expect(lim.check(accountId, 'query', 1, now)).toMatchObject({ ok: false, reason: 'daily' });
    expect(getZaloProtectionSettings().limits).toEqual({});
    expect(getZaloAccount(accountId)?.limits_json).toContain('query');
  });
});

describe('classifyZaloError', () => {
  it('maps sender error codes', () => {
    expect(classifyZaloError(new ZaloSendError('x', 'RATE_LIMITED'))).toBe('RATE_LIMIT');
    expect(classifyZaloError(new ZaloSendError('x', 'NOT_CONNECTED'))).toBe('NICK_OFFLINE');
    expect(classifyZaloError(new ZaloSendError('x', 'QUIET_HOURS'))).toBe('QUIET_HOURS');
    expect(classifyZaloError(new ZaloSendError('x', 'BULK_BUDGET'))).toBe('BULK_BUDGET');
    expect(classifyZaloError(new ZaloSendError('x', 'LOCKED'))).toBe('LOCKED');
  });

  it('reads Zalo error codes out of the message', () => {
    expect(classifyZaloError(new ZaloSendError('Invalid parameter [zalo:114]', 'API_ERROR'))).toBe('ZALO_114');
    expect(classifyZaloError(new Error('boom [zalo:-1]'))).toBe('ZALO_-1');
  });

  it('recognises group and network failures, else unknown', () => {
    expect(classifyZaloError(new Error('You are not a member of this group'))).toBe('NOT_IN_GROUP');
    expect(classifyZaloError(new Error('kicked from group'))).toBe('NOT_IN_GROUP');
    expect(classifyZaloError(new Error('fetch failed'))).toBe('NETWORK');
    expect(classifyZaloError(new Error('read ECONNRESET'))).toBe('NETWORK');
    expect(classifyZaloError(new Error('something odd'))).toBe('UNKNOWN');
    expect(classifyZaloError('plain string')).toBe('UNKNOWN');
  });
});

describe('isNoise', () => {
  it('matches bare acknowledgements', () => {
    for (const t of ['ok', 'OK!', 'oke', 'okay.', 'Dạ', 'vâng', 'ừ', 'ừm', 'uhm', 'tks', 'Thanks!!', '👍', '❤️', '  ok  ']) {
      expect(isNoise(t), t).toBe(true);
    }
  });

  it('does not match real sentences or empty text', () => {
    for (const t of ['ok nhưng giá bao nhiêu', 'cảm ơn shop nhiều', 'dạ cho em hỏi', '', '   ']) {
      expect(isNoise(t), t).toBe(false);
    }
  });
});

describe('matchesOptOut', () => {
  it('matches opt-out phrases with and without diacritics', () => {
    for (const t of [
      'Đừng nhắn tin cho mình nữa', 'không nhắn nữa nhé', 'Tôi không muốn nhận tin', 'hủy đăng ký giúp', 'huỷ đăng ký',
      'đừng làm phiền tôi', 'unsubscribe', 'STOP', 'please stop', 'dung nhan tin nua', 'khong muon nhan quang cao',
    ]) {
      expect(matchesOptOut(t), t).toBe(true);
    }
  });

  it('does not fire on look-alikes', () => {
    for (const t of ['Đúng, nhận được rồi ạ', 'bus stops here', 'cho mình hỏi học phí', 'không nhận được tin của shop']) {
      expect(matchesOptOut(t), t).toBe(false);
    }
  });
});

it('sets the effective daily ceiling to 1000 messages for a nick without warmup', () => {
  const acc = account({ daily_message_cap: 1000, warmup_enabled: 0 });
  expect(effectiveMessageCap(acc)).toBe(1000);
  expect(effectiveLimit(acc, 'message').daily).toBe(1000);
});
