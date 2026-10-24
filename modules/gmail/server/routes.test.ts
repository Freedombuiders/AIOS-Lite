import { afterEach, beforeEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerEmailRoutes } from './routes.js';
import { makeContext } from './test-context.js';
let h: ReturnType<typeof makeContext>, app: Hono;
beforeEach(() => { h = makeContext(); app = new Hono(); registerEmailRoutes(app, h.ctx, h.store, h.api, h.sync); });
afterEach(() => h.close());
it('lists account DTOs without exposing credentials', async () => {
  const r = await app.request('/accounts'); expect(r.status).toBe(200);
  const body = await r.json(); expect(body.accounts[0].emailAddress).toBe('shop@example.com'); expect(JSON.stringify(body)).not.toContain('fake-key');
});
it('validates patches and records a fresh activation boundary', async () => {
  const request = (body: unknown) => app.request(`/accounts/${h.accountId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect((await request({ pollMinutes: 1 })).status).toBe(400);
  await request({ syncEnabled: false }); await request({ syncEnabled: true, signature: 'Trân trọng' });
  expect(h.store.getEmailAccount(h.accountId)).toMatchObject({ sync_enabled: 1, poll_minutes: 2, backfill_days: 0, signature: 'Trân trọng', care_since: Math.floor(Date.now() / 1000) });
});
it('does not expose legacy agent assignment or draft routes', async () => {
  expect((await app.request('/assignments')).status).toBe(404);
  expect((await app.request('/threads/1/draft', { method: 'POST' })).status).toBe(404);
});
it('deletes connector state together with the account', async () => {
  h.sync.connector.store.ensureMailbox(h.accountId, 1);
  expect((await app.request(`/accounts/${h.accountId}`, { method: 'DELETE' })).status).toBe(200);
  expect(h.sync.connector.store.getMailbox(h.accountId)).toBeNull();
});
it('keeps send-attempt evidence when a mailbox or the service is re-enabled', async () => {
  h.sync.connector.store.prepareAttempt({ accountId: h.accountId, token: 'token-history', clientRequestId: 'history', threadKey: 'thread', payloadHash: 'p', textHash: 't', actor: 'manual' });
  h.sync.connector.store.markRpcStarted(h.accountId, 'token-history');
  const patch = (syncEnabled: boolean) => app.request(`/accounts/${h.accountId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ syncEnabled }) });
  await patch(false); await patch(true);
  expect(h.sync.connector.store.getAttempt(h.accountId, 'token-history')?.rpcCount).toBe(1);
  expect(Number(h.store.getEmailSetting(`activation_ms:${h.accountId}`))).toBeGreaterThan(0);
});
