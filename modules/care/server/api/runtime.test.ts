import { afterEach, describe, expect, it } from 'vitest';
import { CareOutboxService, toCareOutboxDto } from '../application/outbox-service.js';
import { setRuntimeSwitch } from '../runtime/switches.js';
import { chatMessage, createEligibleAccount } from '../test-fixtures.js';
import type { CareApiError, CareOutboxIntentDto, CareReplyAcceptedDto } from './dto.js';
import type { CareHoldDto, CareSwitchDto } from './dto-ops.js';
import { makeFileApi } from './test-helpers.js';

let api: ReturnType<typeof makeFileApi> | null = null;
afterEach(() => {
  api?.close();
  api = null;
});
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

function setup(deps: Parameters<typeof makeFileApi>[0] = {}, opts: Parameters<typeof makeFileApi>[1] = {}) {
  const a = makeFileApi(deps, opts);
  api = a;
  const account = createEligibleAccount(a.stores, { channel: 'zalo', nativeAccountId: 'zalo-RT' });
  a.put(chatMessage(account, { senderIdentityKey: 'u-1', externalConversationKey: 'peer:1', nativeMessageId: 'm1', sentAtMs: 1_000 }));
  const conv = a.stores.conversations.getConversationByExternalKey(account.id, 'peer:1')!;
  return { a, stores: a.stores, db: a.fx.a, account, conv };
}

describe('runtime switches', () => {
  it('lists effective state with the documented defaults and changes a switch through the audited path', async () => {
    const { a } = setup({}, { moduleOn: false });
    const list = (await json<{ items: CareSwitchDto[] }>(await a.get('/api/m/care/runtime/switches'))).items;
    const by = (k: string) => list.find((s) => s.key === k)!;
    expect(by('module')).toMatchObject({ enabled: false, explicit: false });
    expect(by('dispatch')).toMatchObject({ enabled: true, explicit: false });
    expect(list.map((s) => s.key)).toEqual(expect.arrayContaining(['auto_send', 'channel:zalo', 'channel:email', 'channel:telegram', 'path:api', 'path:worker']));

    const on = await json<{ previous: boolean | null; enabled: boolean; reenabled: boolean }>(
      await a.send('PUT', '/api/m/care/runtime/switches', { key: 'module', enabled: true, reason: 'go live' }),
    );
    expect(on).toMatchObject({ previous: null, enabled: true, reenabled: true });
    const after = (await json<{ items: CareSwitchDto[] }>(await a.get('/api/m/care/runtime/switches'))).items.find((s) => s.key === 'module')!;
    expect(after).toMatchObject({ enabled: true, explicit: true, changedBy: 'dashboard', reason: 'go live' });
    expect(a.fx.a.prepare('SELECT COUNT(*) AS n FROM care_runtime_switch_log').get()).toEqual({ n: 1 });

    expect((await a.send('PUT', '/api/m/care/runtime/switches', { key: 'bogus', enabled: true })).status).toBe(400);
    expect((await a.send('PUT', '/api/m/care/runtime/switches', { key: 'channel:sms', enabled: true })).status).toBe(400);
    expect((await a.send('PUT', '/api/m/care/runtime/switches', { key: 'module', enabled: 'yes' })).status).toBe(400);
    expect((await a.send('PUT', '/api/m/care/runtime/switches', { key: 'module', enabled: true, actor: 'x' })).status).toBe(400);
  });

  it('parks the older backlog on re-enable; release/discard are explicit and release asks the gate first', async () => {
    const { a, stores, db, account, conv } = setup();
    const job = (key: string) =>
      stores.jobs.enqueueJob({ accountId: account.id, jobType: 'inbound_turn', conversationId: conv.id, dedupeKey: key, payload: { messageId: key }, ownerEpoch: account.ownerEpoch });
    const j1 = job('one');
    const j2 = job('two');
    a.clock.now = Date.now() + 60_000;
    await a.send('PUT', '/api/m/care/runtime/switches', { key: 'dispatch', enabled: false });
    const res = await json<{ reenabled: boolean; held: number }>(await a.send('PUT', '/api/m/care/runtime/switches', { key: 'dispatch', enabled: true }));
    expect(res).toMatchObject({ reenabled: true, held: 2 });

    const holds = (await json<{ items: CareHoldDto[] }>(await a.get('/api/m/care/runtime/holds'))).items;
    expect(holds.map((h) => h.itemId).sort()).toEqual([j1.id, j2.id].sort());
    expect(holds[0]).toMatchObject({ itemKind: 'job', accountId: account.id, status: 'held', reason: 're-enabled:dispatch' });
    expect(JSON.stringify(holds)).not.toContain('messageId');

    // release while the module is off: refused by the gate, still held
    setRuntimeSwitch(db, 'module', false, { actor: 't' });
    const denied = await a.send('POST', `/api/m/care/runtime/holds/job/${j1.id}/release`, {});
    expect(denied.status).toBe(403);
    expect((await json<CareApiError>(denied)).details?.reason).toBe('MODULE_DISABLED');
    expect((await json<{ items: CareHoldDto[] }>(await a.get('/api/m/care/runtime/holds'))).items).toHaveLength(2);
    setRuntimeSwitch(db, 'module', true, { actor: 't' });

    expect(await json(await a.send('POST', `/api/m/care/runtime/holds/job/${j1.id}/release`, {}))).toEqual({ released: true, requeuedJobId: null });
    expect((await a.send('POST', `/api/m/care/runtime/holds/job/${j1.id}/release`, {})).status).toBe(404); // no longer held
    expect(await json(await a.send('POST', `/api/m/care/runtime/holds/job/${j2.id}/discard`, {}))).toEqual({ discarded: true });
    expect((await json<{ items: CareHoldDto[] }>(await a.get('/api/m/care/runtime/holds'))).items).toHaveLength(0);
    const resolved = (await json<{ items: CareHoldDto[] }>(await a.get('/api/m/care/runtime/holds?status=discarded'))).items;
    expect(resolved.map((h) => h.itemId)).toEqual([j2.id]);
    expect((await a.get('/api/m/care/runtime/holds?status=bogus')).status).toBe(400);
    expect((await a.send('POST', '/api/m/care/runtime/holds/Bad-Kind/x/release', {})).status).toBe(400);
  });

  it('shows holds of an open source only', async () => {
    const closed = new Set<string>();
    const { a, stores, account, conv } = setup({ canReadSource: (id) => !closed.has(id) });
    const j = stores.jobs.enqueueJob({ accountId: account.id, jobType: 'inbound_turn', conversationId: conv.id, dedupeKey: 'k', payload: {}, ownerEpoch: account.ownerEpoch });
    a.clock.now = Date.now() + 60_000;
    await a.send('PUT', '/api/m/care/runtime/switches', { key: 'path:api', enabled: false });
    await a.send('PUT', '/api/m/care/runtime/switches', { key: 'path:api', enabled: true });
    closed.add(account.id);
    expect((await json<{ items: unknown[] }>(await a.get('/api/m/care/runtime/holds'))).items).toEqual([]);
    expect((await a.send('POST', `/api/m/care/runtime/holds/job/${j.id}/discard`, {})).status).toBe(404);
  });
});

describe('send-like routes ask the dispatch gate before enqueueing', () => {
  const body = (id: string) => ({ clientRequestId: `reply-${id}-0001`, text: 'Dạ vâng ạ' });

  it('POST /replies is refused by every gate layer and enqueues nothing', async () => {
    const { a, stores, db, account, conv } = setup((fx) => ({ outboxService: new CareOutboxService(fx.a, fx.storesA) }));
    const url = `/api/m/care/conversations/${conv.id}/replies`;
    const intents = () => (db.prepare('SELECT COUNT(*) AS n FROM care_delivery_intents').get() as { n: number }).n;
    const expectDenied = async (id: string, status: number, reason: string) => {
      const res = await a.send('POST', url, body(id));
      expect(res.status).toBe(status);
      expect((await json<CareApiError>(res)).details?.reason).toBe(reason);
      expect(intents()).toBe(0);
    };

    setRuntimeSwitch(db, 'dispatch', false, { actor: 't' });
    await expectDenied('kill', 403, 'KILL_SWITCH');
    setRuntimeSwitch(db, 'dispatch', true, { actor: 't' });
    setRuntimeSwitch(db, 'channel:zalo', false, { actor: 't' });
    await expectDenied('chan', 403, 'CHANNEL_DISABLED');
    setRuntimeSwitch(db, 'channel:zalo', true, { actor: 't' });
    setRuntimeSwitch(db, 'path:api', false, { actor: 't' });
    await expectDenied('path', 403, 'PATH_DISABLED');
    setRuntimeSwitch(db, 'path:api', true, { actor: 't' });
    stores.accounts.updateAccountFlags(account.id, { sendEnabled: false });
    await expectDenied('flag', 403, 'SEND_DISABLED');
    stores.accounts.updateAccountFlags(account.id, { sendEnabled: true, desiredState: 'paused' });
    await expectDenied('state', 409, 'ACCOUNT_NOT_ACTIVE');
    stores.accounts.updateAccountFlags(account.id, { desiredState: 'active' });
    setRuntimeSwitch(db, 'module', false, { actor: 't' });
    await expectDenied('module', 403, 'MODULE_DISABLED');
    setRuntimeSwitch(db, 'module', true, { actor: 't' });

    // all clear: the default port built from the outbox service accepts, and a duplicate returns the same intent
    const ok = await a.send('POST', url, body('ok'));
    expect(ok.status).toBe(202);
    const first = await json<CareReplyAcceptedDto>(ok);
    expect(first.intent.status).toBe('pending');
    expect(intents()).toBe(1);
    const dup = await json<CareReplyAcceptedDto>(await a.send('POST', url, body('ok')));
    expect(dup).toMatchObject({ intentId: first.intentId, duplicate: true });
    expect(intents()).toBe(1);
    const changed = await a.send('POST', url, { ...body('ok'), text: 'Khác' });
    expect(changed.status).toBe(409);

    // status / cancel / reconcile through the same port
    expect((await json<CareOutboxIntentDto>(await a.get(`/api/m/care/outbox/${first.intentId}`))).status).toBe('pending');
    const cancelled = await json<CareOutboxIntentDto>(await a.send('POST', `/api/m/care/outbox/${first.intentId}/cancel`, {}));
    expect(cancelled.status).toBe('cancelled');
    const reconcile = await a.send('POST', `/api/m/care/outbox/${first.intentId}/reconcile`, {});
    expect(reconcile.status).toBe(422); // no dispatcher wired into this port
    expect((await json<CareApiError>(reconcile)).code).toBe('UNSUPPORTED_CAPABILITY');
    expect((await a.get('/api/m/care/outbox/nope')).status).toBe(404);
    expect((await json<{ replyEnabled: boolean }>(await a.get('/api/m/care/status'))).replyEnabled).toBe(true);
  });
});

describe('needs_review is passed through the outbox DTO', () => {
  it('shows needs_review as-is, before and after an attempt, on the outbox and draft views', async () => {
    const { a, stores, db, account, conv } = setup((fx) => ({ outboxService: new CareOutboxService(fx.a, fx.storesA) }));
    const service = new CareOutboxService(db, stores);
    const { intent } = service.enqueue({ accountId: account.id, conversationId: conv.id, clientRequestId: 'review-req-0001', actor: 'manual', content: { kind: 'chat', text: 'hi' } });

    db.prepare(`UPDATE care_delivery_intents SET status = 'needs_review', queue_seq = NULL WHERE id = ?`).run(intent.id);
    expect(toCareOutboxDto(stores.outbox.getIntent(intent.id)!).status).toBe('needs_review');
    expect((await json<CareOutboxIntentDto>(await a.get(`/api/m/care/outbox/${intent.id}`))).status).toBe('needs_review');
    expect((await json<{ items: Array<{ status: string }> }>(await a.get('/api/m/care/drafts?status=needs_review'))).items.map((i) => i.status)).toEqual(['needs_review']);

    // an intent that already had an attempt is not folded into 'uncertain' either
    db.prepare(`UPDATE care_delivery_intents SET attempt_count = 2 WHERE id = ?`).run(intent.id);
    expect(toCareOutboxDto(stores.outbox.getIntent(intent.id)!).status).toBe('needs_review');
    expect((await json<CareOutboxIntentDto>(await a.get(`/api/m/care/outbox/${intent.id}`))).status).toBe('needs_review');
  });
});
