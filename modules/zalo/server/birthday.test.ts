import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createZaloAccount,
  createZaloTemplate,
  getZaloBirthdayGreeting,
  getZaloBirthdayThread,
  getZaloThread,
  insertZaloMedia,
  listZaloBirthdayGreetings,
  saveZaloBirthdayConfig,
  setZaloThreadBirthDate,
  setZaloThreadOptedOut,
  updateZaloBirthdayGreeting,
  upsertZaloThread,
  ZALO_BIRTHDAY_DEFAULTS,
  type ZaloBirthdayConfig,
} from './store.js';
import { _initTestDatabase } from './test-db.js';
import {
  ageOnBirthday,
  celebratedOn,
  monthDaysFor,
  normalizeBirthDateInput,
  parseProfileBirthDate,
  plannedOccasionsFor,
  timeInQuietWindow,
  validateBirthdayConfig,
} from './birthday-schedule.js';
import {
  listUpcomingBirthdays,
  noteBirthDateFromProfile,
  planBirthdayGreetings,
  runBirthdayBackfill,
  runBirthdaySenderTick,
} from './birthday.js';
import type { MarketingDeps } from './marketing-deps.js';
import { ZaloSendError } from './sender.js';

// 10:00 on 10 Mar 2026 in Asia/Ho_Chi_Minh; the default send time (09:00) is already due.
const birthDateOf = (id: number) => getZaloBirthdayThread(id)?.birth_date ?? null;

const NOW = new Date('2026-03-10T03:00:00Z');
const DUE = Math.floor(new Date('2026-03-10T02:00:00Z').getTime() / 1000);

describe('birth date parsing', () => {
  it('parses sdob in the three shapes and falls back to dob', () => {
    expect(parseProfileBirthDate('02/07/2008', 0, NOW)).toBe('2008-07-02');
    expect(parseProfileBirthDate('1990-03-10', 0, NOW)).toBe('1990-03-10');
    expect(parseProfileBirthDate('15/08', 0, NOW)).toBe('0000-08-15');
    expect(parseProfileBirthDate('', Date.UTC(1995, 4, 20, 17) / 1000, NOW)).toBe('1995-05-21'); // 00:00 UTC+7
    expect(parseProfileBirthDate('', Date.UTC(1995, 4, 20) / 1000, NOW)).toBe('1995-05-20');
  });

  it('rejects junk and treats an implausible year as unknown', () => {
    expect(parseProfileBirthDate('', 0, NOW)).toBeNull();
    expect(parseProfileBirthDate(undefined, undefined, NOW)).toBeNull();
    expect(parseProfileBirthDate('31/02/1990', 0, NOW)).toBeNull();
    expect(parseProfileBirthDate('abc', 'x', NOW)).toBeNull();
    expect(parseProfileBirthDate('10/03/0000', 0, NOW)).toBe('0000-03-10');
    expect(parseProfileBirthDate('', 5, NOW)).toBeNull();
  });

  it('keeps 29 Feb only when the year is unknown or a leap year', () => {
    expect(parseProfileBirthDate('29/02/2000', 0, NOW)).toBe('2000-02-29');
    expect(parseProfileBirthDate('29/02/2001', 0, NOW)).toBeNull();
    expect(parseProfileBirthDate('29/02', 0, NOW)).toBe('0000-02-29');
  });

  it('normalises operator input', () => {
    expect(normalizeBirthDateInput('1990-03-10', NOW)).toBe('1990-03-10');
    expect(normalizeBirthDateInput('03-10', NOW)).toBe('0000-03-10');
    expect(normalizeBirthDateInput('0000-03-10', NOW)).toBe('0000-03-10');
    expect(normalizeBirthDateInput('1890-03-10', NOW)).toBeNull();
    expect(normalizeBirthDateInput('2999-03-10', NOW)).toBeNull();
    expect(normalizeBirthDateInput('13-40', NOW)).toBeNull();
    expect(normalizeBirthDateInput('10/03/1990', NOW)).toBeNull();
  });

  it('computes age only when the year is known', () => {
    expect(ageOnBirthday('1990-03-10', '2026-03-10')).toBe(36);
    expect(ageOnBirthday('0000-03-10', '2026-03-10')).toBeNull();
  });
});

describe('29 February rule', () => {
  it('matches 02-29 on 28 Feb in common years only', () => {
    expect(monthDaysFor(new Date(Date.UTC(2026, 1, 28)))).toEqual(['02-28', '02-29']);
    expect(monthDaysFor(new Date(Date.UTC(2028, 1, 28)))).toEqual(['02-28']);
    expect(monthDaysFor(new Date(Date.UTC(2028, 1, 29)))).toEqual(['02-29']);
  });

  it('celebrates 02-29 on 28 Feb in a common year', () => {
    expect(celebratedOn('1992-02-29', 2026)).toBe('2026-02-28');
    expect(celebratedOn('1992-02-29', 2028)).toBe('2028-02-29');
    expect(celebratedOn('1992-03-01', 2026)).toBe('2026-03-01');
  });
});

describe('plannedOccasionsFor', () => {
  const spec = {
    timezone: 'Asia/Ho_Chi_Minh', sendTime: '09:00', lateToleranceMinutes: 180,
    beforeEnabled: true, beforeDays: 3, onDayEnabled: true, afterEnabled: true, afterDays: 2,
  };

  it('derives the birthday to look for from the send day', () => {
    const p = plannedOccasionsFor(spec, NOW);
    expect(p.map((o) => [o.occasion, o.birthdayOn])).toEqual([
      ['before', '2026-03-13'], ['on_day', '2026-03-10'], ['after', '2026-03-08'],
    ]);
    expect(p.every((o) => o.dueAt === DUE)).toBe(true);
  });

  it('uses the calendar day of the configured timezone, not UTC', () => {
    // 20:00 UTC on 9 Mar is already 10 Mar in Vietnam.
    const p = plannedOccasionsFor({ ...spec, beforeEnabled: false, afterEnabled: false }, new Date('2026-03-09T20:00:00Z'));
    expect(p[0].birthdayOn).toBe('2026-03-10');
  });

  it('includes 02-29 when the looked-up day is 28 Feb of a common year', () => {
    const p = plannedOccasionsFor({ ...spec, beforeEnabled: false, afterEnabled: false }, new Date('2026-02-28T03:00:00Z'));
    expect(p[0].monthDays).toEqual(['02-28', '02-29']);
  });
});

describe('config validation and quiet window', () => {
  const ok = {
    timezone: 'Asia/Ho_Chi_Minh', sendTime: '09:00', lateToleranceMinutes: 180,
    beforeEnabled: false, beforeDays: 3, onDayEnabled: true, afterEnabled: false, afterDays: 1,
    perNickDailyQuota: 30, minDelaySec: 30, maxDelaySec: 90,
  };

  it('accepts the defaults and rejects bad values', () => {
    expect(validateBirthdayConfig(ok)).toEqual([]);
    expect(validateBirthdayConfig({ ...ok, sendTime: '25:00' })).not.toEqual([]);
    expect(validateBirthdayConfig({ ...ok, timezone: 'Nowhere/City' })).not.toEqual([]);
    expect(validateBirthdayConfig({ ...ok, minDelaySec: 2 })).not.toEqual([]);
    expect(validateBirthdayConfig({ ...ok, maxDelaySec: 10 })).not.toEqual([]);
    expect(validateBirthdayConfig({ ...ok, beforeEnabled: true, beforeDays: 99 })).not.toEqual([]);
    expect(validateBirthdayConfig({ ...ok, lateToleranceMinutes: 5000 })).not.toEqual([]);
  });

  it('detects a send time inside a quiet window that wraps midnight', () => {
    expect(timeInQuietWindow('23:30', '22:00', '07:00')).toBe(true);
    expect(timeInQuietWindow('06:59', '22:00', '07:00')).toBe(true);
    expect(timeInQuietWindow('09:00', '22:00', '07:00')).toBe(false);
  });
});

// ── DB-backed behaviour ──────────────────────────────────────────────

function customer(accountId: string, externalId: string, name: string, birthDate: string | null) {
  const t = upsertZaloThread({ accountId, threadType: 'user', externalId, name });
  if (birthDate) setZaloThreadBirthDate(t.id, birthDate);
  return t;
}

function config(patch: Partial<ZaloBirthdayConfig> = {}): ZaloBirthdayConfig {
  const { updatedAt: _u, ...base } = ZALO_BIRTHDAY_DEFAULTS;
  return saveZaloBirthdayConfig({ ...base, accountIds: [], ...patch });
}

function template(text = 'Chúc mừng sinh nhật {name}!') {
  return createZaloTemplate({ name: 'SN', text, styles: [], attachmentIds: [] }).id;
}

interface SendCall { threadId: number; text?: string; attachments?: unknown[]; senderType: string; bulk?: boolean }

function fakeDeps(opts: { sendImpl?: (call: SendCall, n: number) => void; budget?: number; connected?: boolean } = {}) {
  const calls: SendCall[] = [];
  const getUserInfo = vi.fn();
  const deps = {
    pool: { getApi: vi.fn(() => (opts.connected === false ? null : { getUserInfo })) },
    sender: {
      sendRich: vi.fn(async (call: SendCall) => {
        opts.sendImpl?.(call, calls.length);
        calls.push(call);
        return { messageIds: [calls.length] };
      }),
      bulkBudgetRemaining: vi.fn(() => opts.budget ?? 100),
      tryConsume: vi.fn(() => true),
    },
    notify: vi.fn(async () => {}),
  };
  return { deps: deps as unknown as MarketingDeps, calls, getUserInfo, raw: deps };
}

const rt = { now: () => NOW, sleep: async () => {}, rng: () => 0 };

describe('noteBirthDateFromProfile', () => {
  let accountId: string;
  beforeEach(() => {
    _initTestDatabase();
    accountId = createZaloAccount('Nick').id;
  });

  it('fills an empty birth date once and never overwrites it', () => {
    const t = customer(accountId, 'u1', 'Lan', null);
    noteBirthDateFromProfile(t.id, { sdob: '10/03/1990' });
    expect(birthDateOf(t.id)).toBe('1990-03-10');
    noteBirthDateFromProfile(t.id, { sdob: '11/04/1991' });
    expect(birthDateOf(t.id)).toBe('1990-03-10');
  });

  it('ignores groups and never throws', () => {
    const g = upsertZaloThread({ accountId, threadType: 'group', externalId: 'g1', name: 'Nhóm' });
    noteBirthDateFromProfile(g.id, { sdob: '10/03/1990' });
    expect(birthDateOf(g.id)).toBeNull();
    expect(() => noteBirthDateFromProfile(99999, { sdob: '10/03/1990' })).not.toThrow();
    expect(() => noteBirthDateFromProfile(g.id, null as unknown as Record<string, unknown>)).not.toThrow();
    expect(getZaloThread(g.id)).toBeTruthy();
  });
});

describe('planner', () => {
  let accountId: string;
  beforeEach(() => {
    _initTestDatabase();
    accountId = createZaloAccount('Nick').id;
  });

  it('plans nothing while disabled or without a template', () => {
    customer(accountId, 'u1', 'Lan', '1990-03-10');
    config({ enabled: false, onDayTemplateId: template() });
    expect(planBirthdayGreetings(NOW)).toEqual({ created: 0, existing: 0 });
    config({ enabled: true, onDayTemplateId: null });
    expect(planBirthdayGreetings(NOW).created).toBe(0);
  });

  it('is idempotent and picks up customers added later', () => {
    customer(accountId, 'u1', 'Lan', '1990-03-10');
    config({ enabled: true, onDayTemplateId: template() });
    expect(planBirthdayGreetings(NOW)).toEqual({ created: 1, existing: 0 });
    expect(planBirthdayGreetings(NOW)).toEqual({ created: 0, existing: 1 });
    customer(accountId, 'u2', 'Minh', '0000-03-10');
    expect(planBirthdayGreetings(NOW)).toEqual({ created: 1, existing: 1 });
    const { greetings } = listZaloBirthdayGreetings();
    expect(greetings.map((g) => [g.thread_name, g.occasion, g.birthday_on, g.due_at, g.state])).toEqual(
      expect.arrayContaining([['Lan', 'on_day', '2026-03-10', DUE, 'pending']]),
    );
  });

  it('excludes opted-out customers, groups, other birthdays and nicks outside the list', () => {
    const other = createZaloAccount('Nick 2').id;
    const optedOut = customer(accountId, 'u1', 'Lan', '1990-03-10');
    setZaloThreadOptedOut(optedOut.id, true);
    customer(accountId, 'u2', 'Khác ngày', '1990-03-11');
    customer(other, 'u3', 'Nick khác', '1990-03-10');
    customer(accountId, 'u4', 'Đủ điều kiện', '1985-03-10');
    config({ enabled: true, onDayTemplateId: template(), accountIds: [accountId] });
    planBirthdayGreetings(NOW);
    const { greetings } = listZaloBirthdayGreetings();
    expect(greetings.map((g) => g.thread_name)).toEqual(['Đủ điều kiện']);
  });

  it('greets 29 Feb birthdays on 28 Feb of a common year', () => {
    customer(accountId, 'u1', 'Nhuận', '1992-02-29');
    config({ enabled: true, onDayTemplateId: template() });
    expect(planBirthdayGreetings(new Date('2026-02-28T03:00:00Z')).created).toBe(1);
    expect(listZaloBirthdayGreetings().greetings[0].birthday_on).toBe('2026-02-28');
  });

  it('plans before/after occasions off the right dates', () => {
    customer(accountId, 'ub', 'Trước', '1990-03-13');
    customer(accountId, 'ua', 'Sau', '1990-03-08');
    config({
      enabled: true, beforeEnabled: true, beforeDays: 3, beforeTemplateId: template(),
      onDayEnabled: false, afterEnabled: true, afterDays: 2, afterTemplateId: template(),
    });
    planBirthdayGreetings(NOW);
    const rows = listZaloBirthdayGreetings().greetings.map((g) => [g.thread_name, g.occasion]).sort();
    expect(rows).toEqual([['Sau', 'after'], ['Trước', 'before']]);
  });

  it('re-times pending rows after a send-time change but leaves forced ones', () => {
    const a = customer(accountId, 'u1', 'Lan', '1990-03-10');
    customer(accountId, 'u2', 'Minh', '1991-03-10');
    config({ enabled: true, onDayTemplateId: template() });
    planBirthdayGreetings(NOW);
    const forced = listZaloBirthdayGreetings().greetings.find((g) => g.thread_id === a.id)!;
    updateZaloBirthdayGreeting(forced.id, { forced: true, dueAt: 123 });
    config({ enabled: true, onDayTemplateId: template(), sendTime: '10:00' });
    planBirthdayGreetings(NOW);
    const dues = new Map(listZaloBirthdayGreetings().greetings.map((g) => [g.thread_name, g.due_at]));
    expect(dues.get('Lan')).toBe(123);
    expect(dues.get('Minh')).toBe(DUE + 3600);
  });
});

describe('sender', () => {
  let accountId: string;
  let tplId: number;

  function setup(patch: Partial<ZaloBirthdayConfig> = {}, birth = '1990-03-10') {
    const t = customer(accountId, 'u1', 'Nguyễn Thị Lan', birth);
    config({ enabled: true, onDayTemplateId: tplId, ...patch });
    planBirthdayGreetings(NOW);
    return { thread: t, greeting: listZaloBirthdayGreetings().greetings[0] };
  }

  beforeEach(() => {
    _initTestDatabase();
    accountId = createZaloAccount('Nick').id;
    tplId = template('Chúc mừng sinh nhật {name}, tròn {age} tuổi!');
  });

  afterEach(() => vi.restoreAllMocks());

  it('sends a marketing message from the thread nick with the rendered template, once', async () => {
    const { thread, greeting } = setup();
    const { deps, calls } = fakeDeps();
    const r = await runBirthdaySenderTick(deps, rt);
    expect(r.sent).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      threadId: thread.id, text: 'Chúc mừng sinh nhật Lan, tròn 36 tuổi!', senderType: 'broadcast', bulk: true,
    });
    const g = getZaloBirthdayGreeting(greeting.id)!;
    expect(g.state).toBe('sent');
    expect(g.sent_at).toBeTruthy();
    expect(JSON.parse(g.message_ids)).toEqual([1]);
    await runBirthdaySenderTick(deps, rt);
    expect(calls).toHaveLength(1);
  });

  it('drops the age when the birth year is unknown', async () => {
    setup({}, '0000-03-10');
    const { deps, calls } = fakeDeps();
    await runBirthdaySenderTick(deps, rt);
    expect(calls[0].text).toBe('Chúc mừng sinh nhật Lan, tròn  tuổi!');
  });

  it('skips greetings past the late tolerance (TOO_LATE) without sending', async () => {
    const { greeting } = setup();
    const { deps, calls } = fakeDeps();
    const late = new Date(NOW.getTime() + 4 * 3600_000); // 13:00 > 09:00 + 180 min
    const r = await runBirthdaySenderTick(deps, { ...rt, now: () => late });
    expect(r.skipped).toBe(1);
    expect(calls).toHaveLength(0);
    expect(getZaloBirthdayGreeting(greeting.id)).toMatchObject({ state: 'skipped', skip_reason: 'TOO_LATE' });
  });

  it('does not send before the due time', async () => {
    setup();
    const { deps, calls } = fakeDeps();
    const early = new Date('2026-03-10T01:00:00Z');
    await runBirthdaySenderTick(deps, { ...rt, now: () => early });
    expect(calls).toHaveLength(0);
  });

  it('skips opted-out customers even if they opted out after planning', async () => {
    const { thread, greeting } = setup();
    setZaloThreadOptedOut(thread.id, true);
    const { deps, calls } = fakeDeps();
    await runBirthdaySenderTick(deps, rt);
    expect(calls).toHaveLength(0);
    expect(getZaloBirthdayGreeting(greeting.id)).toMatchObject({ state: 'skipped', skip_reason: 'OPTED_OUT' });
  });

  it('skips when the template was deleted', async () => {
    const { greeting } = setup({ onDayTemplateId: tplId });
    config({ enabled: true, onDayTemplateId: 9999 });
    const { deps } = fakeDeps();
    await runBirthdaySenderTick(deps, rt);
    expect(getZaloBirthdayGreeting(greeting.id)).toMatchObject({ state: 'skipped', skip_reason: 'NO_TEMPLATE' });
  });

  it.each(['QUIET_HOURS', 'BULK_BUDGET', 'RATE_LIMITED', 'NOT_CONNECTED', 'CHAT_DISABLED', 'LOCKED'] as const)(
    'leaves the greeting pending on nick-level error %s and sends it later',
    async (code) => {
      const { greeting } = setup();
      let fail = true;
      const { deps, calls } = fakeDeps({ sendImpl: () => { if (fail) throw new ZaloSendError('x', code); } });
      const r = await runBirthdaySenderTick(deps, rt);
      expect(r).toMatchObject({ sent: 0, failed: 0, waiting: 1 });
      expect(getZaloBirthdayGreeting(greeting.id)).toMatchObject({ state: 'pending', skip_reason: `WAIT_${code}` });
      fail = false;
      await runBirthdaySenderTick(deps, rt);
      expect(getZaloBirthdayGreeting(greeting.id)!.state).toBe('sent');
      expect(calls).toHaveLength(1);
    },
  );

  it('marks other errors failed with a classified code', async () => {
    const { greeting } = setup();
    const { deps } = fakeDeps({ sendImpl: () => { throw new ZaloSendError('boom', 'API_ERROR'); } });
    const r = await runBirthdaySenderTick(deps, rt);
    expect(r.failed).toBe(1);
    const g = getZaloBirthdayGreeting(greeting.id)!;
    expect(g.state).toBe('failed');
    expect(g.error_code).not.toBe('');
  });

  it('waits when the nick is offline, over quota or out of bulk budget', async () => {
    const { greeting } = setup({ perNickDailyQuota: 1 });
    const offline = fakeDeps({ connected: false });
    await runBirthdaySenderTick(offline.deps, rt);
    expect(getZaloBirthdayGreeting(greeting.id)).toMatchObject({ state: 'pending', skip_reason: 'WAIT_NOT_CONNECTED' });
    const noBudget = fakeDeps({ budget: 0 });
    await runBirthdaySenderTick(noBudget.deps, rt);
    expect(getZaloBirthdayGreeting(greeting.id)).toMatchObject({ state: 'pending', skip_reason: 'WAIT_BULK_BUDGET' });
    expect(offline.calls.length + noBudget.calls.length).toBe(0);
  });

  it('enforces the per-nick daily quota across greetings', async () => {
    customer(accountId, 'u2', 'Minh', '1991-03-10');
    customer(accountId, 'u3', 'Hoa', '1992-03-10');
    const { thread } = setup({ perNickDailyQuota: 2 });
    expect(thread.id).toBeTruthy();
    const { deps, calls } = fakeDeps();
    await runBirthdaySenderTick(deps, rt);
    expect(calls).toHaveLength(2);
    const states = listZaloBirthdayGreetings().greetings.map((g) => g.state).sort();
    expect(states).toEqual(['pending', 'sent', 'sent']);
  });

  it('sends at most 5 greetings per tick', async () => {
    for (let i = 0; i < 7; i++) customer(accountId, `x${i}`, `Khách ${i}`, `199${i}-03-10`);
    config({ enabled: true, onDayTemplateId: tplId });
    planBirthdayGreetings(NOW);
    const { deps, calls } = fakeDeps();
    await runBirthdaySenderTick(deps, rt);
    expect(calls).toHaveLength(5);
  });

  it('keeps sent_steps so a retry never resends a delivered step', async () => {
    const media = insertZaloMedia({ file_name: 'a.pdf', mime: 'application/pdf', kind: 'file', size: 1, rel_path: 'a.pdf' });
    const withFile = createZaloTemplate({ name: 'SN+file', text: 'Chúc {name}', styles: [], attachmentIds: [media.id] }).id;
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const { greeting } = setup({ onDayTemplateId: withFile });
    let failAttachment = true;
    const { deps, calls } = fakeDeps({
      sendImpl: (call) => { if (call.attachments && failAttachment) throw new ZaloSendError('x', 'RATE_LIMITED'); },
    });
    await runBirthdaySenderTick(deps, rt);
    let g = getZaloBirthdayGreeting(greeting.id)!;
    expect(g).toMatchObject({ state: 'pending', sent_steps: 1 });
    expect(calls.map((c) => Boolean(c.text))).toEqual([true]);

    failAttachment = false;
    await runBirthdaySenderTick(deps, rt);
    g = getZaloBirthdayGreeting(greeting.id)!;
    expect(g).toMatchObject({ state: 'sent', sent_steps: 2 });
    // The text was sent exactly once; only the attachment step was retried.
    expect(calls.filter((c) => c.text)).toHaveLength(1);
    expect(calls.filter((c) => c.attachments)).toHaveLength(1);
  });

  it('does nothing for rows once the feature is switched off, and a forced row is sent immediately', async () => {
    const { greeting } = setup();
    config({ enabled: false, onDayTemplateId: tplId });
    const { deps, calls } = fakeDeps();
    await runBirthdaySenderTick(deps, rt);
    expect(calls).toHaveLength(0);
    expect(getZaloBirthdayGreeting(greeting.id)!.state).toBe('pending');
    config({ enabled: true, onDayTemplateId: tplId });
    updateZaloBirthdayGreeting(greeting.id, { dueAt: Math.floor(NOW.getTime() / 1000), forced: true });
    await runBirthdaySenderTick(deps, rt);
    expect(calls).toHaveLength(1);
  });
});

describe('backfill', () => {
  let accountId: string;
  beforeEach(() => {
    _initTestDatabase();
    accountId = createZaloAccount('Nick').id;
  });

  it('reads profiles within the query budget, stores birth dates and does not repeat', async () => {
    const a = customer(accountId, 'u1', 'Lan', null);
    customer(accountId, 'u2', 'Minh', '1990-01-01');
    const { deps, getUserInfo, raw } = fakeDeps();
    getUserInfo.mockResolvedValue({ changed_profiles: { u1: { sdob: '10/03/1990' } } });
    const r = await runBirthdayBackfill(deps, rt);
    expect(r).toEqual({ looked: 1, found: 1 });
    expect(getUserInfo).toHaveBeenCalledTimes(1);
    expect(raw.sender.tryConsume).toHaveBeenCalledWith(accountId, 'query');
    expect(birthDateOf(a.id)).toBe('1990-03-10');
    expect((await runBirthdayBackfill(deps, rt)).looked).toBe(0);
  });

  it('stops when the limiter refuses and retries a failed lookup after a day, not a month', async () => {
    const a = customer(accountId, 'u1', 'Lan', null);
    const refused = fakeDeps();
    refused.raw.sender.tryConsume.mockReturnValue(false);
    expect((await runBirthdayBackfill(refused.deps, rt)).looked).toBe(0);
    expect(refused.getUserInfo).not.toHaveBeenCalled();

    const failing = fakeDeps();
    failing.getUserInfo.mockRejectedValue(new Error('network'));
    await runBirthdayBackfill(failing.deps, rt);
    expect(failing.getUserInfo).toHaveBeenCalledTimes(1);
    const tomorrow = new Date(NOW.getTime() + 2 * 86_400_000);
    const ok = fakeDeps();
    ok.getUserInfo.mockResolvedValue({ changed_profiles: { u1: { sdob: '' } } });
    await runBirthdayBackfill(ok.deps, { ...rt, now: () => tomorrow });
    expect(ok.getUserInfo).toHaveBeenCalledTimes(1);
    expect(a.id).toBeTruthy();
  });
});

describe('upcoming', () => {
  it('lists birthdays in the window with the state of each occasion', () => {
    _initTestDatabase();
    const accountId = createZaloAccount('Nick').id;
    customer(accountId, 'u1', 'Hôm nay', '1990-03-10');
    customer(accountId, 'u2', 'Tuần sau', '1990-03-17');
    customer(accountId, 'u3', 'Xa', '1990-06-01');
    config({ enabled: true, onDayTemplateId: template() });
    planBirthdayGreetings(NOW);
    const up = listUpcomingBirthdays(NOW, 14);
    expect(up.map((u) => [u.name, u.birthdayOn, u.daysUntil])).toEqual([
      ['Hôm nay', '2026-03-10', 0], ['Tuần sau', '2026-03-17', 7],
    ]);
    expect(up[0].occasions[0]).toMatchObject({ occasion: 'on_day', state: 'pending' });
    expect(up[0].age).toBe(36);
    expect(up[1].occasions[0]).toMatchObject({ state: 'planned', greetingId: null, sendOn: '2026-03-17' });
  });
});
