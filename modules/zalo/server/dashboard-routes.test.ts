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

function app(): Hono {
  const a = new Hono();
  registerZaloRoutes(a, {
    supervisor: { pid: () => null, restart: async () => {} },
    agentIds: () => ['main'],
    runLean: async () => ({ ok: true, output: '', taskId: 1, runId: null }),
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
});
