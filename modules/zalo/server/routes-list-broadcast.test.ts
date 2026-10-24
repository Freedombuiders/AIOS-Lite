import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import { createZaloAccount,
  createZaloTemplate,
  getZaloListBroadcast,
  listZaloListRecipients,
  setZaloThreadOptedOut,
  updateZaloListRecipient,
  upsertZaloThread,
} from './store.js';
import { _initTestDatabase } from './test-db.js';
import { registerZaloListBroadcastRoutes } from './routes-list-broadcast.js';

function app(): Hono {
  const a = new Hono();
  registerZaloListBroadcastRoutes(a);
  return a;
}

function send(a: Hono, method: string, url: string, body?: unknown) {
  return a.request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('list broadcast routes', () => {
  let nick: string;
  let templateId: number;
  const BASE = '/list-broadcasts';

  function body(over: Record<string, unknown> = {}) {
    return { name: 'Tri ân khách cũ', templateId, accountIds: [nick], ...over };
  }

  beforeEach(() => {
    _initTestDatabase();
    nick = createZaloAccount('Nick 1').id;
    templateId = createZaloTemplate({ name: 'Chào', text: 'Chào {name}', styles: [], attachmentIds: [] }).id;
  });

  describe('create/update validation', () => {
    it('creates a draft with defaults', async () => {
      const res = await send(app(), 'POST', BASE, body());
      expect(res.status).toBe(201);
      const { broadcast } = await json(res);
      expect(broadcast).toMatchObject({
        state: 'draft', windowStart: '08:00', windowEnd: '17:00', dailyQuota: 100, perNickDailyQuota: 40,
        minDelaySec: 45, maxDelaySec: 90, timezone: 'Asia/Ho_Chi_Minh',
      });
    });

    it.each([
      ['empty name', { name: ' ' }, /Tên chiến dịch/],
      ['unknown template', { templateId: 9999 }, /Mẫu tin không tồn tại/],
      ['no nick', { accountIds: [] }, /ít nhất một nick/],
      ['unknown nick', { accountIds: ['nope'] }, /nick Zalo không tồn tại/],
      ['bad window time', { windowStart: '8h' }, /HH:mm/],
      ['same start/end', { windowStart: '09:00', windowEnd: '09:00' }, /trùng/],
      ['bad timezone', { timezone: 'Mars/Base' }, /Múi giờ/],
      ['bad weekday', { daysOfWeek: [9] }, /Ngày trong tuần/],
      ['end before start date', { startDate: '2026-10-10', endDate: '2026-10-01' }, /sau ngày bắt đầu/],
      ['daily quota too high', { dailyQuota: 2001 }, /Hạn mức mỗi ngày/],
      ['daily quota zero', { dailyQuota: 0 }, /Hạn mức mỗi ngày/],
      ['delay below floor', { minDelaySec: 19 }, /Giãn cách tối thiểu/],
      ['delay above cap', { maxDelaySec: 901 }, /Giãn cách tối đa/],
      ['max below min', { minDelaySec: 60, maxDelaySec: 30 }, /lớn hơn hoặc bằng/],
      ['bad filter days', { filter: { activeWithinDays: 0 } }, /Số ngày hoạt động/],
    ])('rejects %s', async (_label, over, message) => {
      const res = await send(app(), 'POST', BASE, body(over));
      expect(res.status).toBe(400);
      expect((await json(res)).error).toMatch(message);
    });

    it('edits only drafts and paused campaigns', async () => {
      const a = app();
      const { broadcast } = await json(await send(a, 'POST', BASE, body()));
      let res = await send(a, 'PATCH', `${BASE}/${broadcast.id}`, body({ name: 'Đổi tên' }));
      expect(res.status).toBe(200);
      expect((await json(res)).broadcast.name).toBe('Đổi tên');

      upsertZaloThread({ accountId: nick, threadType: 'user', externalId: 'u1', name: 'An' });
      await send(a, 'POST', `${BASE}/${broadcast.id}/activate`);
      res = await send(a, 'PATCH', `${BASE}/${broadcast.id}`, body());
      expect(res.status).toBe(400);
    });

    it('returns 404 for unknown campaigns', async () => {
      expect((await send(app(), 'GET', `${BASE}/99`)).status).toBe(404);
      expect((await send(app(), 'POST', `${BASE}/99/pause`)).status).toBe(404);
    });
  });

  describe('previews', () => {
    it('counts matching chats with a sample of 20, excluding opted-out customers', async () => {
      for (let i = 0; i < 25; i++) upsertZaloThread({ accountId: nick, threadType: 'user', externalId: `u${i}`, name: `Khách ${i}` });
      upsertZaloThread({ accountId: nick, threadType: 'group', externalId: 'g1', name: 'Nhóm' });
      const out = upsertZaloThread({ accountId: nick, threadType: 'user', externalId: 'out', name: 'Từ chối' });
      setZaloThreadOptedOut(out.id, true);

      const res = await send(app(), 'POST', `${BASE}/preview-recipients`, { accountIds: [nick], filter: {} });
      const data = await json(res);
      expect(data.count).toBe(25);
      expect(data.sample).toHaveLength(20);
      expect(data.perAccount[nick]).toBe(25);
    });

    it('estimates days and warns about a short window', async () => {
      const res = await send(app(), 'POST', `${BASE}/estimate`, body({ windowStart: '09:00', windowEnd: '09:30', recipientCount: 500 }));
      const { estimate } = await json(res);
      expect(estimate.sendingDays).toBe(13); // 500 / min(100, 40 per nick)
      expect(estimate.warnings.join(' ')).toMatch(/Khung giờ/);
    });
  });

  describe('lifecycle', () => {
    async function draft(a: Hono) {
      const { broadcast } = await json(await send(a, 'POST', BASE, body()));
      return broadcast.id as number;
    }

    it('activates by building recipients from existing 1-1 chats only', async () => {
      const a = app();
      const id = await draft(a);
      upsertZaloThread({ accountId: nick, threadType: 'user', externalId: 'u1', name: 'An' });
      upsertZaloThread({ accountId: nick, threadType: 'group', externalId: 'g1', name: 'Nhóm' });
      const out = upsertZaloThread({ accountId: nick, threadType: 'user', externalId: 'u2', name: 'Bình' });
      setZaloThreadOptedOut(out.id, true);

      const res = await send(a, 'POST', `${BASE}/${id}/activate`);
      expect(res.status).toBe(200);
      const data = await json(res);
      expect(data.broadcast.state).toBe('active');
      expect(data.sync).toMatchObject({ added: 1, total: 1 });
      expect(listZaloListRecipients(id).recipients).toHaveLength(1);
    });

    it('refuses to activate when no customer matches', async () => {
      const a = app();
      const id = await draft(a);
      const res = await send(a, 'POST', `${BASE}/${id}/activate`);
      expect(res.status).toBe(400);
      expect(getZaloListBroadcast(id)!.state).toBe('draft');
    });

    it('pauses, resumes and cancels with state checks', async () => {
      const a = app();
      const id = await draft(a);
      upsertZaloThread({ accountId: nick, threadType: 'user', externalId: 'u1', name: 'An' });

      expect((await send(a, 'POST', `${BASE}/${id}/pause`)).status).toBe(409); // not active yet
      await send(a, 'POST', `${BASE}/${id}/activate`);
      expect((await send(a, 'POST', `${BASE}/${id}/pause`)).status).toBe(200);
      expect(getZaloListBroadcast(id)).toMatchObject({ state: 'paused', pausedReason: 'MANUAL' });
      expect((await send(a, 'POST', `${BASE}/${id}/resume`)).status).toBe(200);
      expect(getZaloListBroadcast(id)!.state).toBe('active');
      expect((await send(a, 'POST', `${BASE}/${id}/cancel`)).status).toBe(200);
      expect((await send(a, 'POST', `${BASE}/${id}/cancel`)).status).toBe(409);
    });

    it('syncs new chats into a running campaign without touching existing recipients', async () => {
      const a = app();
      const id = await draft(a);
      upsertZaloThread({ accountId: nick, threadType: 'user', externalId: 'u1', name: 'An' });
      await send(a, 'POST', `${BASE}/${id}/activate`);
      upsertZaloThread({ accountId: nick, threadType: 'user', externalId: 'u2', name: 'Bình' });

      const data = await json(await send(a, 'POST', `${BASE}/${id}/sync-recipients`));
      expect(data).toMatchObject({ added: 1, total: 2 });
    });

    it('retries failed recipients under the attempt limit and skips on demand', async () => {
      const a = app();
      const id = await draft(a);
      for (let i = 0; i < 3; i++) upsertZaloThread({ accountId: nick, threadType: 'user', externalId: `u${i}`, name: `K${i}` });
      await send(a, 'POST', `${BASE}/${id}/activate`);
      const [r1, r2, r3] = listZaloListRecipients(id).recipients;
      updateZaloListRecipient(r1.id, { state: 'failed', attempts: 1, error_code: 'UNKNOWN' });
      updateZaloListRecipient(r2.id, { state: 'failed', attempts: 3, error_code: 'UNKNOWN' });

      expect((await json(await send(a, 'POST', `${BASE}/${id}/retry-failed`))).requeued).toBe(1);
      expect(listZaloListRecipients(id, { state: 'failed' }).recipients.map((r) => r.id)).toEqual([r2.id]);

      expect((await send(a, 'POST', `${BASE}/${id}/recipients/${r3.id}/skip`)).status).toBe(200);
      expect(listZaloListRecipients(id, { state: 'skipped' }).recipients.map((r) => r.id)).toEqual([r3.id]);
      expect((await send(a, 'POST', `${BASE}/${id}/recipients/${r3.id}/skip`)).status).toBe(409); // already skipped
    });

    it('lists recipients filtered by state and shows counters on detail', async () => {
      const a = app();
      const id = await draft(a);
      upsertZaloThread({ accountId: nick, threadType: 'user', externalId: 'u1', name: 'An' });
      await send(a, 'POST', `${BASE}/${id}/activate`);

      const detail = await json(await send(a, 'GET', `${BASE}/${id}`));
      expect(detail.broadcast.counts).toMatchObject({ total: 1, pending: 1 });
      expect(detail.estimate.sendingDays).toBe(1);
      expect(typeof detail.windowOpenNow).toBe('boolean');

      const pending = await json(await send(a, 'GET', `${BASE}/${id}/recipients?state=pending`));
      expect(pending.total).toBe(1);
      const sent = await json(await send(a, 'GET', `${BASE}/${id}/recipients?state=sent`));
      expect(sent.total).toBe(0);
    });

    it('deletes only campaigns that are not running', async () => {
      const a = app();
      const id = await draft(a);
      upsertZaloThread({ accountId: nick, threadType: 'user', externalId: 'u1', name: 'An' });
      await send(a, 'POST', `${BASE}/${id}/activate`);
      expect((await send(a, 'DELETE', `${BASE}/${id}`)).status).toBe(409);
      await send(a, 'POST', `${BASE}/${id}/cancel`);
      expect((await send(a, 'DELETE', `${BASE}/${id}`)).status).toBe(200);
      expect(getZaloListBroadcast(id)).toBeUndefined();
      expect(listZaloListRecipients(id).total).toBe(0);
    });

    it('drops pending recipients of a nick removed from the campaign', async () => {
      const nick2 = createZaloAccount('Nick 2').id;
      const a = app();
      const { broadcast } = await json(await send(a, 'POST', BASE, body({ accountIds: [nick, nick2] })));
      upsertZaloThread({ accountId: nick, threadType: 'user', externalId: 'u1', name: 'An' });
      upsertZaloThread({ accountId: nick2, threadType: 'user', externalId: 'u2', name: 'Bình' });
      await send(a, 'POST', `${BASE}/${broadcast.id}/activate`);
      await send(a, 'POST', `${BASE}/${broadcast.id}/pause`);

      await send(a, 'PATCH', `${BASE}/${broadcast.id}`, body({ accountIds: [nick] }));
      const skipped = listZaloListRecipients(broadcast.id, { state: 'skipped' }).recipients;
      expect(skipped).toHaveLength(1);
      expect(skipped[0].error_code).toBe('NICK_REMOVED');
    });
  });
});
