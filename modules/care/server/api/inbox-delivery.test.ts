import { afterEach, describe, expect, it } from 'vitest';
import { CareOutboxService } from '../application/outbox-service.js';
import { createTestCareDatabase } from '../persistence/index.js';
import { TEST_KEY } from '../test-fixtures.js';
import type { CareApiError } from './dto.js';
import type { CareInlineDraftDto } from './dto-inbox.js';
import { T0, emailAccount, seedChat, wrapApi, zaloAccount, type ApiFixture } from './test-helpers.js';

let api: ApiFixture | null = null;
afterEach(() => {
  api?.close();
  api = null;
});
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

function setup(deps: Parameters<typeof wrapApi>[2] = {}) {
  const t = createTestCareDatabase(':memory:', TEST_KEY);
  const raw = t.rawDbForTestIsolationOnly;
  api = wrapApi(t.stores, raw, deps, () => t.close());
  const zalo = zaloAccount(t.stores);
  const mail = emailAccount(t.stores);
  const zc = seedChat(t.stores, zalo, 'peer:z', 'Z', [{ at: T0 }]);
  const mc = seedChat(t.stores, mail, 'peer:m', 'M', [], 'email_thread');
  return { api, zalo, mail, zc, mc, service: new CareOutboxService(raw, t.stores) };
}

const replyUrl = (id: string) => `/api/m/care/conversations/${id}/replies`;

describe('core replies without a port', () => {
  it('answers 501 UNSUPPORTED_CAPABILITY', async () => {
    const { api: a, zc } = setup();
    const res = await a.send('POST', replyUrl(zc.id), { clientRequestId: 'req-00000001', text: 'Xin chao' });
    expect(res.status).toBe(501);
    expect(await json<CareApiError>(res)).toEqual({ code: 'UNSUPPORTED_CAPABILITY', message: 'Reply delivery is not enabled yet.' });
  });
});

describe('core drafts', () => {
  it('GET /conversations/:id/drafts lists the conversation drafts with the read gate', async () => {
    const holder: { closed: Set<string> } = { closed: new Set() };
    const { api: a, zalo, zc, mc, service } = setup({ canReadSource: (id) => !holder.closed.has(id) });
    const core = service.createDraft({ accountId: zalo.id, conversationId: zc.id, clientRequestId: 'agent-turn:run-1', actor: 'approved', content: { kind: 'chat', text: 'core draft' }, createdBy: 'agent:sales' }).intent;

    const res = await a.get(`/api/m/care/conversations/${zc.id}/drafts`);
    expect(res.status).toBe(200);
    const { items } = await json<{ items: CareInlineDraftDto[] }>(res);
    expect(items.map((d) => [d.id, d.source, d.text])).toEqual([[core.id, 'core', 'core draft']]);
    expect(items[0]).toMatchObject({ agentId: 'sales', channel: 'zalo', status: 'draft', accountId: zalo.id, email: null });

    expect((await json<{ items: unknown[] }>(await a.get(`/api/m/care/conversations/${mc.id}/drafts`))).items).toEqual([]);
    expect((await a.get('/api/m/care/conversations/missing/drafts')).status).toBe(404);
    holder.closed.add(zalo.id);
    expect((await a.get(`/api/m/care/conversations/${zc.id}/drafts`)).status).toBe(404);
  });

  it('GET /inline-drafts lists newest first, honours limit and the per-account read gate', async () => {
    const holder: { closed: Set<string> } = { closed: new Set() };
    const { api: a, zalo, mail, zc, mc, service } = setup({ canReadSource: (id) => !holder.closed.has(id) });
    const d1 = service.createDraft({ accountId: zalo.id, conversationId: zc.id, clientRequestId: 'draft-core-0001', actor: 'approved', content: { kind: 'chat', text: 'one' } }).intent;
    const d2 = service.createDraft({ accountId: mail.id, conversationId: mc.id, clientRequestId: 'draft-core-0002', actor: 'approved', content: { kind: 'email', text: 'two', to: ['a@example.com'], subject: 'Re: Quote' } }).intent;
    a.db.prepare('UPDATE care_delivery_intents SET created_at = ? WHERE id = ?').run(T0 + 1, d1.id);
    a.db.prepare('UPDATE care_delivery_intents SET created_at = ? WHERE id = ?').run(T0 + 3, d2.id);

    const { items } = await json<{ items: CareInlineDraftDto[] }>(await a.get('/api/m/care/inline-drafts'));
    expect(items.map((d) => d.createdAtMs)).toEqual([T0 + 3, T0 + 1]);
    expect(items[0]).toMatchObject({ channel: 'email', email: { subject: 'Re: Quote' } });
    expect((await json<{ items: unknown[] }>(await a.get('/api/m/care/inline-drafts?limit=1'))).items).toHaveLength(1);
    for (const bad of ['0', '201', 'x']) expect((await a.get(`/api/m/care/inline-drafts?limit=${bad}`)).status).toBe(400);
    holder.closed.add(zalo.id);
    expect((await json<{ items: CareInlineDraftDto[] }>(await a.get('/api/m/care/inline-drafts'))).items.map((d) => d.channel)).toEqual(['email']);
  });

  it('core draft ids use the core approve schema (expectedRevision is required)', async () => {
    const { api: a, zalo, zc, service } = setup();
    const core = service.createDraft({ accountId: zalo.id, conversationId: zc.id, clientRequestId: 'draft-core-0003', actor: 'approved', content: { kind: 'chat', text: 'hi' } }).intent;
    expect((await a.send('POST', `/api/m/care/drafts/${core.id}/approve`, { text: 'x' })).status).toBe(400);
  });
});
