import { afterEach, describe, expect, it } from 'vitest';
import { chatMessage, createEligibleAccount } from '../test-fixtures.js';
import type { CareApiError, CareTaskDto } from './dto.js';
import { makeFileApi } from './test-helpers.js';

let api: ReturnType<typeof makeFileApi> | null = null;
afterEach(() => {
  api?.close();
  api = null;
});
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const NOW = 1_800_000_000_000;

/** Two customers on one account, a third on another account. Time is pinned so overdue/waiting are exact. */
function setup(deps: Parameters<typeof makeFileApi>[0] = {}) {
  const a = makeFileApi(deps);
  api = a;
  a.clock.now = NOW;
  const zA = createEligibleAccount(a.stores, { channel: 'zalo', nativeAccountId: 'zalo-A' });
  const zB = createEligibleAccount(a.stores, { channel: 'zalo', nativeAccountId: 'zalo-B' });
  const put = (acct: typeof zA, sender: string, key: string, id: string, at: number) =>
    a.put(chatMessage(acct, { senderIdentityKey: sender, externalConversationKey: key, nativeMessageId: id, sentAtMs: at, text: `from ${sender}` })).messageId!;
  const mA1 = put(zA, 'u-1', 'peer:1', 'a1', NOW - 3_600_000);
  const mA2 = put(zA, 'u-2', 'peer:2', 'a2', NOW - 120_000);
  const mB1 = put(zB, 'u-1', 'peer:B', 'b1', NOW - 60_000);
  const idOf = (acct: typeof zA, ext: string) => a.stores.identities.getIdentityByExternal(acct.id, 'user', ext)!;
  const c1 = a.stores.customers.getCustomer(idOf(zA, 'u-1').customerId)!;
  const c2 = a.stores.customers.getCustomer(idOf(zA, 'u-2').customerId)!;
  const cB = a.stores.customers.getCustomer(idOf(zB, 'u-1').customerId)!;
  const conv = (acct: typeof zA, key: string) => a.stores.conversations.getConversationByExternalKey(acct.id, key)!;
  return { a, stores: a.stores, zA, zB, mA1, mA2, mB1, c1, c2, cB, conv1: conv(zA, 'peer:1'), conv2: conv(zA, 'peer:2'), convB: conv(zB, 'peer:B') };
}

describe('tasks through CareTaskService', () => {
  it('derives the scope and source link, and flags overdue', async () => {
    const w = setup();
    const post = (body: Record<string, unknown>) => w.a.send('POST', '/api/m/care/tasks', { dueAtMs: NOW + 1000, title: 't', ...body });

    const wide = await json<CareTaskDto>(await post({ customerId: w.c1.id, title: 'customer wide' }));
    expect(wide).toMatchObject({ scope: 'customer', accountId: null, sourceMessageId: null, overdue: false });
    const acct = await json<CareTaskDto>(await post({ customerId: w.c1.id, accountId: w.zA.id, title: 'account scoped', dueAtMs: NOW - 5_000 }));
    expect(acct).toMatchObject({ scope: 'account', accountId: w.zA.id, overdue: true });
    const convTask = await json<CareTaskDto>(await post({ customerId: w.c1.id, conversationId: w.conv1.id, title: 'conversation scoped' }));
    expect(convTask).toMatchObject({ scope: 'conversation', conversationId: w.conv1.id, accountId: w.zA.id });
    const sourced = await json<CareTaskDto>(await post({ customerId: w.c1.id, sourceMessageId: w.mA1, title: 'from a message' }));
    expect(sourced).toMatchObject({ scope: 'conversation', sourceMessageId: w.mA1, conversationId: w.conv1.id });

    // other customer's conversation / message, another account's message, an account the customer is not on
    for (const body of [
      { customerId: w.c1.id, conversationId: w.conv2.id },
      { customerId: w.c1.id, sourceMessageId: w.mA2 },
      { customerId: w.c1.id, sourceMessageId: w.mB1 },
      { customerId: w.c1.id, accountId: w.zB.id },
      { customerId: w.c1.id, conversationId: w.conv1.id, accountId: w.zB.id },
      { customerId: w.c1.id, conversationId: w.conv2.id, sourceMessageId: w.mA1 },
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await json<CareApiError>(res)).code).toBe('INVALID_TARGET');
    }
    expect((await post({ customerId: 'nope' })).status).toBe(404);
    expect((await post({ customerId: w.c1.id, sourceMessageId: 'nope' })).status).toBe(404);
    expect((await post({ customerId: w.c1.id, extra: 1 })).status).toBe(400);
  });

  it('filters, pages by due date, and overdue is open-and-late only', async () => {
    const w = setup();
    const mk = async (title: string, dueAtMs: number, extra: Record<string, unknown> = {}) =>
      json<CareTaskDto>(await w.a.send('POST', '/api/m/care/tasks', { customerId: w.c1.id, title, dueAtMs, ...extra }));
    const late = await mk('late', NOW - 1000, { owner: 'lan' });
    const later = await mk('later', NOW - 500);
    await mk('future', NOW + 9000, { conversationId: w.conv1.id });
    await w.a.send('PATCH', `/api/m/care/tasks/${later.id}`, { expectedRevision: 1, done: true });

    const all = await json<{ items: CareTaskDto[]; nextCursor: string | null }>(await w.a.get('/api/m/care/tasks?limit=2'));
    expect(all.items.map((t) => t.title)).toEqual(['late', 'later']);
    const rest = await json<{ items: CareTaskDto[]; nextCursor: string | null }>(await w.a.get(`/api/m/care/tasks?limit=2&cursor=${all.nextCursor}`));
    expect(rest.items.map((t) => t.title)).toEqual(['future']);
    expect(rest.nextCursor).toBeNull();

    const titles = async (q: string) => (await json<{ items: CareTaskDto[] }>(await w.a.get(`/api/m/care/tasks?${q}`))).items.map((t) => t.title);
    expect(await titles('overdue=1')).toEqual(['late']); // `later` is done, `future` is not late
    expect(await titles('overdue=0')).toEqual(['later', 'future']);
    expect(await titles('done=1')).toEqual(['later']);
    expect(await titles('owner=lan')).toEqual(['late']);
    expect(await titles('scope=conversation')).toEqual(['future']);
    expect(await titles(`conversation=${w.conv1.id}`)).toEqual(['future']);
    expect(await titles(`dueBefore=${NOW - 700}`)).toEqual(['late']);
    expect(await titles(`customer=${w.c2.id}`)).toEqual([]);
    expect((await w.a.get('/api/m/care/tasks?scope=bogus')).status).toBe(400);
    expect(late.overdue).toBe(true);
  });

  it('patches with a revision check, normalises the owner label and keeps the revision on a no-op', async () => {
    const w = setup();
    const t = await json<CareTaskDto>(await w.a.send('POST', '/api/m/care/tasks', { customerId: w.c1.id, title: 'x', dueAtMs: NOW + 1, owner: ' lan ' }));
    expect(t.owner).toBe('lan');
    const patch = (rev: number, body: Record<string, unknown>) => w.a.send('PATCH', `/api/m/care/tasks/${t.id}`, { expectedRevision: rev, ...body });

    expect(await json<CareTaskDto>(await patch(1, { title: 'renamed', dueAtMs: NOW - 10 }))).toMatchObject({ title: 'renamed', revision: 2, overdue: true });
    expect(await json<CareTaskDto>(await patch(2, { owner: '' }))).toMatchObject({ owner: null, revision: 3 });
    expect(await json<CareTaskDto>(await patch(3, { done: true }))).toMatchObject({ done: true, overdue: false, revision: 4 });
    expect((await json<CareTaskDto>(await patch(4, { done: true }))).revision).toBe(4);
    const stale = await patch(2, { title: 'lost update' });
    expect(stale.status).toBe(409);
    expect(await json<CareApiError>(stale)).toMatchObject({ code: 'STALE_REVISION', currentRevision: 4 });
    expect((await patch(4, {})).status).toBe(400);
    expect((await w.a.send('PATCH', '/api/m/care/tasks/nope', { expectedRevision: 1, done: true })).status).toBe(404);
  });

  it('treats a task of a closed source as missing everywhere, without costing a page slot', async () => {
    const closed = new Set<string>();
    const w = setup({ canReadSource: (id) => !closed.has(id) });
    const mk = async (title: string, dueAtMs: number, extra: Record<string, unknown>) =>
      json<CareTaskDto>(await w.a.send('POST', '/api/m/care/tasks', { title, dueAtMs, ...extra }));
    await mk('a-1', NOW + 1, { customerId: w.c1.id, accountId: w.zA.id });
    const hiddenOnes = [await mk('b-1', NOW + 2, { customerId: w.cB.id, accountId: w.zB.id }), await mk('b-2', NOW + 3, { customerId: w.cB.id, accountId: w.zB.id })];
    await mk('a-2', NOW + 4, { customerId: w.c1.id, accountId: w.zA.id });
    await mk('wide', NOW + 5, { customerId: w.c1.id });
    closed.add(w.zB.id);

    const walked: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      const page: { items: CareTaskDto[]; nextCursor: string | null } = await json(await w.a.get(`/api/m/care/tasks?limit=1${cursor ? `&cursor=${cursor}` : ''}`));
      expect(page.items.length).toBeLessThanOrEqual(1);
      walked.push(...page.items.map((t) => t.title));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(walked).toEqual(['a-1', 'a-2', 'wide']);

    expect((await w.a.send('PATCH', `/api/m/care/tasks/${hiddenOnes[0].id}`, { expectedRevision: 1, done: true })).status).toBe(404);
    expect(w.stores.tasks.getTask(hiddenOnes[0].id)!.done).toBe(false);
    expect((await w.a.send('POST', '/api/m/care/tasks', { customerId: w.cB.id, accountId: w.zB.id, title: 'x', dueAtMs: NOW })).status).toBe(404);
    expect((await w.a.send('POST', '/api/m/care/tasks', { customerId: w.cB.id, conversationId: w.convB.id, title: 'x', dueAtMs: NOW })).status).toBe(404);
    expect((await w.a.get(`/api/m/care/tasks?account=${w.zB.id}`)).status).toBe(404);
  });
});

describe('GET /metrics/waiting and /metrics/overdue', () => {
  it('groups waiting conversations and overdue tasks per owner and per account against the SLA', async () => {
    const closed = new Set<string>();
    const w = setup({ canReadSource: (id) => !closed.has(id) });
    w.stores.customers.updateCustomer(w.c1.id, { owner: 'lan' });
    w.stores.customers.updateCustomer(w.cB.id, { owner: 'minh' });

    // waiting: conv1 (1h, owner lan), conv2 (2m, no owner), convB (1m, owner minh)
    const byOwner = await json<{ by: string; slaMs: number; items: Array<{ owner: string | null; waiting: number; breached: number; oldestWaitingSinceMs: number }> }>(
      await w.a.get('/api/m/care/metrics/waiting?slaMs=300000'),
    );
    expect(byOwner).toMatchObject({ by: 'owner', slaMs: 300_000, nowMs: NOW });
    const owner = (name: string | null) => byOwner.items.find((i) => i.owner === name)!;
    expect(owner('lan')).toMatchObject({ waiting: 1, breached: 1, oldestWaitingSinceMs: NOW - 3_600_000 });
    expect(owner(null)).toMatchObject({ waiting: 1, breached: 0 });
    expect(owner('minh')).toMatchObject({ waiting: 1, breached: 0 });

    const byAccount = await json<{ items: Array<{ accountId: string; waiting: number; breached: number }> }>(await w.a.get('/api/m/care/metrics/waiting?by=account&slaMs=300000'));
    expect(byAccount.items.find((i) => i.accountId === w.zA.id)).toMatchObject({ waiting: 2, breached: 1 });
    expect(byAccount.items.find((i) => i.accountId === w.zB.id)).toMatchObject({ waiting: 1, breached: 0 });
    const one = await json<{ items: Array<{ accountId: string }> }>(await w.a.get(`/api/m/care/metrics/waiting?by=account&account=${w.zB.id}`));
    expect(one.items.map((i) => i.accountId)).toEqual([w.zB.id]);

    // reading locally does not resolve the wait; an operator reply does
    const waitingA = async () =>
      (await json<{ items: Array<{ accountId: string; waiting: number }> }>(await w.a.get('/api/m/care/metrics/waiting?by=account'))).items.find((i) => i.accountId === w.zA.id)?.waiting;
    w.stores.conversations.markLocalSeen(w.conv2.id, w.stores.messages.listMessages(w.conv2.id)[0].id);
    expect(await waitingA()).toBe(2);
    w.stores.messages.insertMessage(
      chatMessage(w.zA, { externalConversationKey: 'peer:2', nativeMessageId: 'reply-1', direction: 'out', senderRole: 'operator', sentAtMs: NOW - 1_000, text: 'answered' }),
      w.conv2.id,
    );
    w.stores.conversations.recomputeProjection(w.conv2.id);
    expect(await waitingA()).toBe(1);

    // overdue tasks
    const mk = (body: Record<string, unknown>) => w.a.send('POST', '/api/m/care/tasks', { title: 't', ...body });
    await mk({ customerId: w.c1.id, dueAtMs: NOW - 10_000, owner: 'lan', accountId: w.zA.id });
    await mk({ customerId: w.c1.id, dueAtMs: NOW - 5_000, owner: 'lan' });
    await mk({ customerId: w.cB.id, dueAtMs: NOW - 1_000, owner: 'minh', accountId: w.zB.id });
    await mk({ customerId: w.c1.id, dueAtMs: NOW + 1_000, owner: 'lan' }); // not late
    const done = await json<CareTaskDto>(await mk({ customerId: w.c1.id, dueAtMs: NOW - 2_000, owner: 'lan' }));
    await w.a.send('PATCH', `/api/m/care/tasks/${done.id}`, { expectedRevision: 1, done: true }); // late but done

    const od = await json<{ items: Array<{ owner: string | null; overdue: number; oldestDueAtMs: number }> }>(await w.a.get('/api/m/care/metrics/overdue'));
    expect(od.items.find((i) => i.owner === 'lan')).toMatchObject({ overdue: 2, oldestDueAtMs: NOW - 10_000 });
    expect(od.items.find((i) => i.owner === 'minh')).toMatchObject({ overdue: 1 });
    const odAcc = await json<{ items: Array<{ accountId: string | null; overdue: number }> }>(await w.a.get('/api/m/care/metrics/overdue?by=account'));
    expect(odAcc.items.find((i) => i.accountId === null)).toMatchObject({ overdue: 1 }); // customer-wide, no account
    expect(odAcc.items.find((i) => i.accountId === w.zA.id)).toMatchObject({ overdue: 1 });

    // a closed source contributes no rows and no counts
    closed.add(w.zB.id);
    const hiddenWaiting = await json<{ items: Array<{ accountId: string }> }>(await w.a.get('/api/m/care/metrics/waiting?by=account'));
    expect(hiddenWaiting.items.map((i) => i.accountId)).not.toContain(w.zB.id);
    const hiddenOverdue = await json<{ items: Array<{ owner: string | null }> }>(await w.a.get('/api/m/care/metrics/overdue'));
    expect(hiddenOverdue.items.find((i) => i.owner === 'minh')).toBeUndefined();
    expect((await w.a.get(`/api/m/care/metrics/waiting?account=${w.zB.id}`)).status).toBe(404);

    expect((await w.a.get('/api/m/care/metrics/waiting?by=team')).status).toBe(400);
    expect((await w.a.get('/api/m/care/metrics/overdue?by=team')).status).toBe(400);
    expect((await w.a.get('/api/m/care/metrics/waiting?slaMs=-1')).status).toBe(400);
  });
});
