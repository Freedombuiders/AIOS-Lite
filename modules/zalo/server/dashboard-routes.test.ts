import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import { createZaloAccount,
  getZaloAccount,
  getZaloThread,
  insertZaloMessage,
  updateZaloAccountSettings,
  updateZaloAccountState,
  listZaloOutbox,
  upsertZaloThread,
} from './store.js';
import { _initTestDatabase } from './test-db.js';
import { configureZaloControl } from './control.js';
import { registerZaloRoutes } from './dashboard-routes.js';

function app(opts: { marketing?: boolean; runLean?: () => Promise<never> } = {}): Hono {
  const a = new Hono();
  registerZaloRoutes(a, {
    supervisor: { pid: () => null, restart: async () => {} },
    agentIds: () => ['main'],
    runLean: (opts.runLean ?? (async () => ({ ok: true, output: '', taskId: 1, runId: null }))) as never,
    ...(opts.marketing === undefined ? {} : { marketingEnabled: () => opts.marketing! }),
  });
  return a;
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function post(a: Hono, url: string, body?: unknown) {
  return a.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('zalo dashboard routes', () => {
  let accountId: string;
  let threadId: number;

  beforeEach(() => {
    configureZaloControl(null); // no daemon: control calls answer "unavailable"
    _initTestDatabase();
    accountId = createZaloAccount('Nick test').id;
    const t = upsertZaloThread({ accountId, threadType: 'group', externalId: 'g1', name: 'Nhóm học viên' });
    threadId = t.id;
    insertZaloMessage({
      threadId, zaloMsgId: '1', senderType: 'customer', senderName: 'An', body: 'Khi nào học?',
      contentType: 'text', origin: 'live', sentAtMs: Date.now(),
    });
  });

  it('returns rendered messages and queues operator sends', async () => {
    const a = app();
    const msgs = await json<{ messages: Array<{ text: string; senderType: string }> }>(
      await a.request(`/threads/${threadId}/messages`),
    );
    expect(msgs.messages[0]).toMatchObject({ text: 'Khi nào học?', senderType: 'customer' });

    expect((await post(a, `/threads/${threadId}/send`, { text: '   ' })).status).toBe(400);
    expect((await post(a, `/threads/${threadId}/send`, { text: 'Tối thứ 3 nhé' })).status).toBe(200);
    const queued = listZaloOutbox({ threadId, statuses: ['pending'] });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ body: 'Tối thứ 3 nhé', origin: 'operator' });
  });

  it('pauses and resumes a thread', async () => {
    const a = app();
    await post(a, `/threads/${threadId}/pause`, { minutes: 15 });
    let detail = await json<{ thread: { pausedUntil: number | null; pauseReason: string } }>(await a.request(`/threads/${threadId}`));
    expect(detail.thread.pausedUntil).toBeGreaterThan(Date.now() / 1000);
    expect(detail.thread.pauseReason).toBe('manual');
    await post(a, `/threads/${threadId}/pause`, { minutes: null });
    detail = await json(await a.request(`/threads/${threadId}`));
    expect(detail.thread.pausedUntil).toBeNull();
  });

  it('reports the daemon as unavailable when it is not running', async () => {
    const res = await post(app(), `/accounts/${accountId}/login-qr`);
    expect(res.status).toBe(503);
  });
  function put(a: Hono, url: string, body: unknown) {
    return a.request(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  function patch(a: Hono, url: string, body: unknown) {
    return a.request(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  it('reads and saves the protection settings with validation', async () => {
    const a = app();
    const initial = await json<{ settings: { quietHours: { start: string } }; defaults: Record<string, { daily: number }>; categories: string[] }>(
      await a.request('/settings'),
    );
    expect(initial.settings.quietHours.start).toBe('22:00');
    expect(initial.defaults.message.daily).toBe(1000);
    expect(initial.categories).toContain('group_read');

    expect((await put(a, '/settings', { quietHours: { start: '25:00' } })).status).toBe(400);
    expect((await put(a, '/settings', { timezone: 'Mars/Base' })).status).toBe(400);
    const res = await put(a, '/settings', {
      quietHours: { enabled: false, start: '21:00', end: '06:30' }, agentDailyReplyCap: 120, limits: { query: { daily: 300 } },
    });
    expect(res.status).toBe(200);
    const saved = (await json<{ settings: { quietHours: { enabled: boolean; start: string }; agentDailyReplyCap: number; limits: unknown } }>(res)).settings;
    expect(saved).toMatchObject({ quietHours: { enabled: false, start: '21:00' }, agentDailyReplyCap: 120, limits: { query: { daily: 300 } } });
  });

  it('shows usage, warm-up and lock state on accounts and updates them', async () => {
    const a = app();
    let list = await json<{ accounts: Array<Record<string, any>> }>(await a.request('/accounts'));
    expect(list.accounts[0]).toMatchObject({
      sendLockReason: '', warmup: { enabled: false, week: 0, cap: null }, effectiveMessageCap: 1000, limits: {},
    });
    expect(list.accounts[0].usage.message).toEqual({ used: 0, limit: 1000 });

    // Enabling warm-up on a never-connected nick starts the schedule at first connect.
    expect((await patch(a, `/accounts/${accountId}`, { warmupEnabled: true })).status).toBe(200);
    expect(getZaloAccount(accountId)).toMatchObject({ warmup_enabled: 1, warmup_started_at: null });
    // A nick that has connected before starts its schedule right away.
    updateZaloAccountSettings(accountId, { warmup_enabled: 0 });
    updateZaloAccountState(accountId, { zalo_uid: 'uid-1' });
    await patch(a, `/accounts/${accountId}`, { warmupEnabled: true });
    list = await json(await a.request('/accounts'));
    expect(list.accounts[0].warmup).toMatchObject({ enabled: true, week: 1, cap: 30 });
    expect(list.accounts[0].effectiveMessageCap).toBe(30);
    expect(list.accounts[0].usage.message.limit).toBe(30);

    await patch(a, `/accounts/${accountId}`, { limits: { group_read: { daily: 100, burst: 5 }, bogus: { daily: 1 } } });
    list = await json(await a.request('/accounts'));
    expect(list.accounts[0].limits).toEqual({ group_read: { daily: 100, burst: 5 } });
    expect(list.accounts[0].usage.group_read.limit).toBe(100);
    await patch(a, `/accounts/${accountId}`, { limits: null });
    expect(getZaloAccount(accountId)?.limits_json).toBe('{}');

    // Turning sending back on clears an automatic lock.
    updateZaloAccountSettings(accountId, { chat_enabled: 0, send_lock_reason: 'bị từ chối' });
    list = await json(await a.request('/accounts'));
    expect(list.accounts[0].sendLockReason).toBe('bị từ chối');
    await patch(a, `/accounts/${accountId}`, { chatEnabled: true });
    expect(getZaloAccount(accountId)).toMatchObject({ chat_enabled: 1, send_lock_reason: '' });
  });

  it('creates accounts in warm-up by default and honours warmup: false', async () => {
    const a = app();
    const first = await json<{ account: { id: string } }>(await post(a, '/accounts', { label: 'Mới' }));
    expect(getZaloAccount(first.account.id)?.warmup_enabled).toBe(1);
    const second = await json<{ account: { id: string } }>(await post(a, '/accounts', { label: 'Nick cũ', warmup: false }));
    expect(getZaloAccount(second.account.id)?.warmup_enabled).toBe(0);
  });

  it('toggles a thread opt-out and reports it on list and detail', async () => {
    const a = app();
    expect((await post(a, `/threads/${threadId}/opt-out`, { optedOut: 'yes' })).status).toBe(400);
    expect((await post(a, '/threads/9999/opt-out', { optedOut: true })).status).toBe(404);
    expect((await post(a, `/threads/${threadId}/opt-out`, { optedOut: true })).status).toBe(200);
    expect(getZaloThread(threadId)?.opted_out).toBe(1);
    const detail = await json<{ thread: { optedOut: boolean } }>(await a.request(`/threads/${threadId}`));
    expect(detail.thread.optedOut).toBe(true);
    const list = await json<{ threads: Array<{ optedOut: boolean }> }>(await a.request('/threads'));
    expect(list.threads[0].optedOut).toBe(true);
    await post(a, `/threads/${threadId}/opt-out`, { optedOut: false });
    expect(getZaloThread(threadId)?.opted_out).toBe(0);
  });

  describe('marketing switch', () => {
    const MARKETING_GETS = ['/templates', '/templates/variables', '/templates/1', '/group-broadcasts', '/group-broadcasts/1', '/list-broadcasts', '/list-broadcasts/1', '/birthday/config', '/birthday/stats', '/birthday/upcoming', '/media/1/raw'];
    const MARKETING_POSTS = ['/templates', '/templates/render', '/templates/variants', '/media', '/group-broadcasts', '/group-broadcasts/preview-cost', '/list-broadcasts', '/list-broadcasts/estimate', '/birthday/greetings/by-key/skip'];

    it('answers 404 on every marketing path by default (no switch given) and never calls the model', async () => {
      let modelCalls = 0;
      const a = app({ runLean: async () => { modelCalls++; throw new Error('must not run'); } });
      for (const url of MARKETING_GETS) expect((await a.request(url)).status, `GET ${url}`).toBe(404);
      for (const url of MARKETING_POSTS) expect((await post(a, url, {})).status, `POST ${url}`).toBe(404);
      expect((await post(a, '/templates/variants', { text: 'xin chào', count: 2 })).status).toBe(404);
      expect((await a.request(`/threads/${threadId}/birth-date`)).status).toBe(404);
      expect((await a.request(`/threads/${threadId}/birth-date`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
      expect((await a.request('/templates/1', { method: 'DELETE' })).status).toBe(404);
      expect(modelCalls).toBe(0);
    });

    it('keeps the chat routes working while marketing is off', async () => {
      const a = app({ marketing: false });
      expect((await a.request('/accounts')).status).toBe(200);
      expect((await a.request('/threads')).status).toBe(200);
      expect((await a.request('/overview?from=2026-11-01&to=2026-11-07&prevFrom=2026-10-25&prevTo=2026-10-31')).status).toBe(200);
      expect((await a.request('/settings')).status).toBe(200);
    });

    it('serves the marketing routes again when the switch is on, read on every request', async () => {
      let on = true;
      const a = new Hono();
      registerZaloRoutes(a, {
        supervisor: { pid: () => null, restart: async () => {} },
        agentIds: () => ['main'],
        runLean: async () => ({ ok: true, output: '', taskId: 1, runId: null }),
        marketingEnabled: () => on,
      });
      expect((await a.request('/templates')).status).toBe(200);
      expect((await a.request('/group-broadcasts')).status).toBe(200);
      expect((await a.request('/list-broadcasts')).status).toBe(200);
      expect((await a.request('/birthday/config')).status).toBe(200);
      on = false;
      expect((await a.request('/templates')).status).toBe(404);
      expect((await a.request('/birthday/config')).status).toBe(404);
    });
  });

  describe('GET /accounts/:id/usage', () => {
    it('counts what the nick sent today against its cap, and 404s for an unknown nick', async () => {
      const a = app();
      const before = await json<{ sentToday: number; cap: number; burst: { limit: number; windowSec: number }; accountId: string }>(await a.request(`/accounts/${accountId}/usage`));
      expect(before).toMatchObject({ accountId, sentToday: 0, burst: { limit: 20, windowSec: 30 } });
      expect(before.cap).toBe(1000);
      expect((await json<{ cap: number }>(await a.request(`/accounts/${accountId}/usage`))).cap).toBe(1000);
      for (const [i, senderType] of (['self', 'agent', 'operator'] as const).entries()) {
        insertZaloMessage({ threadId, zaloMsgId: `s${i}`, senderType, body: 'trả lời', contentType: 'text', origin: 'live', sentAtMs: Date.now() });
      }
      // customer messages and backfilled history do not count
      insertZaloMessage({ threadId, zaloMsgId: 'c1', senderType: 'customer', body: 'hỏi', contentType: 'text', origin: 'live', sentAtMs: Date.now() });
      insertZaloMessage({ threadId, zaloMsgId: 'b1', senderType: 'self', body: 'cũ', contentType: 'text', origin: 'backfill', sentAtMs: Date.now() });
      const after = await json<{ sentToday: number; cap: number; warmup: { enabled: boolean } }>(await a.request(`/accounts/${accountId}/usage`));
      expect(after.sentToday).toBe(3);
      expect(after.cap).toBe(1000);
      expect(after.warmup.enabled).toBe(false);
      expect((await a.request('/accounts/nope/usage')).status).toBe(404);
    });

    it('reports the warm-up cap (30, 80, 150 per week) for a new nick', async () => {
      const a = app();
      updateZaloAccountSettings(accountId, { warmup_enabled: 1, warmup_started_at: Math.floor(Date.now() / 1000) });
      const week1 = await json<{ cap: number; warmup: { enabled: boolean; week: number; schedule: number[] } }>(await a.request(`/accounts/${accountId}/usage`));
      expect(week1.warmup).toMatchObject({ enabled: true, week: 1, schedule: [30, 80, 150] });
      expect(week1.cap).toBe(30);
    });
  });
});
