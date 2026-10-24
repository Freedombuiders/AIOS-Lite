import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import { createZaloAccount,
  createZaloTemplate,
  getZaloBirthdayConfig,
  getZaloBirthdayGreeting,
  getZaloBirthdayThread,
  saveZaloProtectionSettings,
  setZaloThreadBirthDate,
  setZaloThreadOptedOut,
  updateZaloBirthdayGreeting,
  upsertZaloThread,
} from './store.js';
import { _initTestDatabase } from './test-db.js';
import { planBirthdayGreetings } from './birthday.js';
import { registerZaloBirthdayRoutes } from './routes-birthday.js';

function app(): Hono {
  const a = new Hono();
  registerZaloBirthdayRoutes(a);
  return a;
}

function send(a: Hono, method: string, url: string, body?: unknown) {
  return a.request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}


/** Today's MM-DD in the feature's default timezone (the machine's own zone may differ). */
function todayMmdd(): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Ho_Chi_Minh', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('month')}-${get('day')}`;
}

async function json<T = Record<string, any>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('zalo birthday routes', () => {
  let accountId: string;
  let tplId: number;

  beforeEach(() => {
    _initTestDatabase();
    accountId = createZaloAccount('Nick').id;
    tplId = createZaloTemplate({ name: 'SN', text: 'Chúc mừng {name}', styles: [], attachmentIds: [] }).id;
  });

  describe('config', () => {
    it('returns defaults (feature off) and the quiet-hours flag', async () => {
      const body = await json(await send(app(), 'GET', '/birthday/config'));
      expect(body.config).toMatchObject({ enabled: false, sendTime: '09:00', timezone: 'Asia/Ho_Chi_Minh', lateToleranceMinutes: 180 });
      expect(body.sendTimeInQuietHours).toBe(false);
    });

    it('saves a valid config and flags a send time inside quiet hours', async () => {
      const a = app();
      const res = await send(a, 'PUT', '/birthday/config', {
        enabled: true, onDayTemplateId: tplId, sendTime: '23:00', accountIds: [accountId],
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.config).toMatchObject({ enabled: true, onDayTemplateId: tplId, sendTime: '23:00', accountIds: [accountId] });
      saveZaloProtectionSettings({ quietHours: { enabled: true, start: '22:00', end: '07:00' } });
      const again = await json(await send(a, 'GET', '/birthday/config'));
      expect(again.sendTimeInQuietHours).toBe(true);
    });

    it.each([
      [{ sendTime: '9am' }],
      [{ timezone: 'Mars/Base' }],
      [{ lateToleranceMinutes: 99999 }],
      [{ minDelaySec: 1 }],
      [{ minDelaySec: 60, maxDelaySec: 30 }],
      [{ perNickDailyQuota: 0 }],
      [{ beforeEnabled: true, beforeDays: 0, beforeTemplateId: 1 }],
      [{ onDayTemplateId: 424242 }],
      [{ accountIds: ['không-có'] }],
      [{ enabled: true, onDayTemplateId: null }],
      [{ enabled: true, onDayEnabled: false }],
    ])('rejects %j with a Vietnamese error and keeps the old config', async (patch) => {
      const res = await send(app(), 'PUT', '/birthday/config', patch);
      expect(res.status).toBe(400);
      expect(typeof (await json(res)).error).toBe('string');
      expect(getZaloBirthdayConfig().enabled).toBe(false);
      expect(getZaloBirthdayConfig().sendTime).toBe('09:00');
    });

    it('merges a partial update over the stored config', async () => {
      const a = app();
      await send(a, 'PUT', '/birthday/config', { onDayTemplateId: tplId, minDelaySec: 40, maxDelaySec: 80 });
      const res = await send(a, 'PUT', '/birthday/config', { sendTime: '08:30' });
      expect(res.status).toBe(200);
      expect(getZaloBirthdayConfig()).toMatchObject({ sendTime: '08:30', onDayTemplateId: tplId, minDelaySec: 40, maxDelaySec: 80 });
    });
  });

  describe('birth date', () => {
    it('sets, normalises and clears a 1-1 thread birth date', async () => {
      const a = app();
      const t = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1', name: 'Lan' });
      let res = await send(a, 'PATCH', `/threads/${t.id}/birth-date`, { birthDate: '1990-03-10' });
      expect(res.status).toBe(200);
      expect(getZaloBirthdayThread(t.id)!.birth_date).toBe('1990-03-10');
      res = await send(a, 'PATCH', `/threads/${t.id}/birth-date`, { birthDate: '07-04' });
      expect((await json(res)).birthDate).toBe('0000-07-04');
      expect((await json(await send(a, 'GET', `/threads/${t.id}/birth-date`))).birthDate).toBe('0000-07-04');
      res = await send(a, 'PATCH', `/threads/${t.id}/birth-date`, { birthDate: null });
      expect(res.status).toBe(200);
      expect(getZaloBirthdayThread(t.id)!.birth_date).toBeNull();
    });

    it('validates input, thread existence and thread type', async () => {
      const a = app();
      const t = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1', name: 'Lan' });
      const g = upsertZaloThread({ accountId, threadType: 'group', externalId: 'g1', name: 'Nhóm' });
      expect((await send(a, 'PATCH', `/threads/${t.id}/birth-date`, { birthDate: '31-02' })).status).toBe(400);
      expect((await send(a, 'PATCH', `/threads/${t.id}/birth-date`, { birthDate: 'hôm qua' })).status).toBe(400);
      expect((await send(a, 'PATCH', `/threads/${t.id}/birth-date`, {})).status).toBe(400);
      expect((await send(a, 'PATCH', '/threads/99999/birth-date', { birthDate: '1990-01-01' })).status).toBe(404);
      expect((await send(a, 'PATCH', `/threads/${g.id}/birth-date`, { birthDate: '1990-01-01' })).status).toBe(400);
    });
  });

  describe('stats, upcoming and greetings', () => {
    function enable() {
      return send(app(), 'PUT', '/birthday/config', { enabled: true, onDayTemplateId: tplId });
    }

    it('reports birth-date coverage per nick', async () => {
      const t = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1', name: 'Lan' });
      upsertZaloThread({ accountId, threadType: 'user', externalId: 'u2', name: 'Minh' });
      upsertZaloThread({ accountId, threadType: 'group', externalId: 'g1', name: 'Nhóm' });
      setZaloThreadBirthDate(t.id, '1990-03-10');
      const body = await json(await send(app(), 'GET', '/birthday/stats'));
      expect(body).toMatchObject({ threads: 2, withBirthDate: 1 });
      expect(body.nicks[0]).toMatchObject({ accountId, threads: 2, withBirthDate: 1 });
    });

    it('lists upcoming birthdays and history, filtered by state', async () => {
      const a = app();
      await enable();
      const t = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1', name: 'Lan' });
      setZaloThreadBirthDate(t.id, `0000-${todayMmdd()}`);
      planBirthdayGreetings();
      const up = await json(await send(a, 'GET', '/birthday/upcoming'));
      expect(up.upcoming.some((u: { name: string }) => u.name === 'Lan')).toBe(true);
      const all = await json(await send(a, 'GET', '/birthday/greetings'));
      expect(all.total).toBe(1);
      expect(all.greetings[0]).toMatchObject({ name: 'Lan', occasion: 'on_day', state: 'pending' });
      expect((await json(await send(a, 'GET', '/birthday/greetings?state=sent'))).total).toBe(0);
      expect((await send(a, 'GET', '/birthday/greetings?state=bogus')).status).toBe(400);
    });

    it('send-now re-queues a greeting, skip retires it, and both guard bad states', async () => {
      const a = app();
      await enable();
      const t = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1', name: 'Lan' });
      setZaloThreadBirthDate(t.id, `0000-${todayMmdd()}`);
      planBirthdayGreetings();
      const id = (await json(await send(a, 'GET', '/birthday/greetings'))).greetings[0].id as number;

      let res = await send(a, 'POST', `/birthday/greetings/${id}/skip`);
      expect(res.status).toBe(200);
      expect(getZaloBirthdayGreeting(id)).toMatchObject({ state: 'skipped', skip_reason: 'MANUAL' });
      expect((await send(a, 'POST', `/birthday/greetings/${id}/skip`)).status).toBe(409);

      res = await send(a, 'POST', `/birthday/greetings/${id}/send-now`);
      expect(res.status).toBe(200);
      const g = getZaloBirthdayGreeting(id)!;
      expect(g).toMatchObject({ state: 'pending', forced: 1 });
      expect(g.due_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));

      setZaloThreadOptedOut(t.id, true);
      expect((await send(a, 'POST', `/birthday/greetings/${id}/send-now`)).status).toBe(409);
      expect((await send(a, 'POST', '/birthday/greetings/9999/send-now')).status).toBe(404);
    });

    it('refuses send-now on an already sent greeting', async () => {
      const a = app();
      await enable();
      const t = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1', name: 'Lan' });
      setZaloThreadBirthDate(t.id, `0000-${todayMmdd()}`);
      planBirthdayGreetings();
      const id = (await json(await send(a, 'GET', '/birthday/greetings'))).greetings[0].id as number;
      updateZaloBirthdayGreeting(id, { state: 'sent', sentAt: 1 });
      expect((await send(a, 'POST', `/birthday/greetings/${id}/send-now`)).status).toBe(409);
    });

    it('creates the row on demand for a not-yet-planned birthday (by-key)', async () => {
      const a = app();
      await enable();
      const t = upsertZaloThread({ accountId, threadType: 'user', externalId: 'u1', name: 'Lan' });
      setZaloThreadBirthDate(t.id, '1992-02-29');
      const key = { threadId: t.id, occasion: 'on_day', birthdayOn: '2027-02-28' };
      const res = await send(a, 'POST', '/birthday/greetings/by-key/skip', key);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(getZaloBirthdayGreeting(body.greeting.id)).toMatchObject({ state: 'skipped', birthday_on: '2027-02-28' });
      // Not the date this birth date is celebrated on, or an unknown action.
      expect((await send(a, 'POST', '/birthday/greetings/by-key/skip', { ...key, birthdayOn: '2027-03-01' })).status).toBe(400);
      expect((await send(a, 'POST', '/birthday/greetings/by-key/explode', key)).status).toBe(400);
      expect((await send(a, 'POST', '/birthday/greetings/by-key/skip', { ...key, occasion: 'before' })).status).toBe(409);
    });
  });
});
