import { afterEach, describe, expect, it } from 'vitest';
import type { CareApiError } from './dto.js';
import type { CareCustomerCareDto, CareLinkPreviewDto, CareLinkResultDto, CareTimelinePageDto, CareUnlinkPreviewDto, CareUnlinkResultDto } from './dto-ops.js';
import { chatMessage, createEligibleAccount, emailMessage } from '../test-fixtures.js';
import { makeFileApi } from './test-helpers.js';

let api: ReturnType<typeof makeFileApi> | null = null;
afterEach(() => {
  api?.close();
  api = null;
});

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

/** Same native person u-1 on two Zalo accounts + one email buyer: three identities, three customers, no merging. */
function world(deps: Parameters<typeof makeFileApi>[0] = {}) {
  const a = makeFileApi(deps);
  api = a;
  const { stores } = a;
  const zA = createEligibleAccount(stores, { channel: 'zalo', nativeAccountId: 'zalo-A' });
  const zB = createEligibleAccount(stores, { channel: 'zalo', nativeAccountId: 'zalo-B' });
  const mail = createEligibleAccount(stores, { channel: 'email', nativeAccountId: 'shop@example.com' });
  a.put(chatMessage(zA, { senderIdentityKey: 'u-1', externalConversationKey: 'peer:A', nativeMessageId: 'a1', sentAtMs: 1_000, text: 'hello from zalo A' }));
  a.put(chatMessage(zB, { senderIdentityKey: 'u-1', externalConversationKey: 'peer:B', nativeMessageId: 'b1', sentAtMs: 2_000, text: 'hello from zalo B' }));
  a.put(emailMessage(mail, { senderIdentityKey: 'buyer@example.com', externalConversationKey: 'thread:C', nativeMessageId: 'g1', sentAtMs: 3_000, text: 'hello by email' }));
  const idA = stores.identities.getIdentityByExternal(zA.id, 'user', 'u-1')!;
  const idB = stores.identities.getIdentityByExternal(zB.id, 'user', 'u-1')!;
  const idC = stores.identities.getIdentityByExternal(mail.id, 'email', 'buyer@example.com')!;
  const cust = (i: { customerId: string }) => stores.customers.getCustomer(i.customerId)!;
  const revs = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, stores.customers.getCustomer(id)!.revision]));
  return {
    a, stores, zA, zB, mail, idA, idB, idC, cA: cust(idA), cB: cust(idB), cC: cust(idC), revs,
    convA: stores.conversations.getConversationByExternalKey(zA.id, 'peer:A')!,
    convB: stores.conversations.getConversationByExternalKey(zB.id, 'peer:B')!,
    convC: stores.conversations.getConversationByExternalKey(mail.id, 'thread:C')!,
  };
}

describe('GET /customers/:id/timeline', () => {
  it('merges linked conversations newest first with the original reply target, paginated', async () => {
    const w = world();
    const before = await json<CareTimelinePageDto>(await w.a.get(`/api/m/care/customers/${w.cA.id}/timeline`));
    expect(before.items.map((i) => i.text)).toEqual(['hello from zalo A']);

    const link = await w.a.send('POST', '/api/m/care/identities/link', {
      identityIds: [w.idB.id, w.idC.id],
      targetCustomerId: w.cA.id,
      expectedRevisions: w.revs(w.cA.id, w.cB.id, w.cC.id),
      keepTargetForUnresolved: true,
    });
    expect(link.status).toBe(200);

    const all = await json<CareTimelinePageDto>(await w.a.get(`/api/m/care/customers/${w.cA.id}/timeline`));
    expect(all.items.map((i) => i.text)).toEqual(['hello by email', 'hello from zalo B', 'hello from zalo A']);
    expect(all.items.map((i) => i.channel)).toEqual(['email', 'zalo', 'zalo']);
    expect(all.items[1].replyTarget).toEqual({ conversationId: w.convB.id, accountId: w.zB.id });

    const p1 = await json<CareTimelinePageDto>(await w.a.get(`/api/m/care/customers/${w.cA.id}/timeline?limit=2`));
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await json<CareTimelinePageDto>(await w.a.get(`/api/m/care/customers/${w.cA.id}/timeline?limit=2&cursor=${p1.nextCursor}`));
    expect([...p1.items, ...p2.items].map((i) => i.messageId)).toEqual(all.items.map((i) => i.messageId));
    expect(p2.nextCursor).toBeNull();

    expect((await w.a.get(`/api/m/care/customers/${w.cA.id}/timeline?cursor=garbage`)).status).toBe(400);
    expect((await w.a.get('/api/m/care/customers/nope/timeline')).status).toBe(404);
  });

  it('leaves out a source whose read gate is closed, with no rows and no cursor hint', async () => {
    const closed = new Set<string>();
    const w = world({ canReadSource: (id) => !closed.has(id) });
    await w.a.send('POST', '/api/m/care/identities/link', {
      identityIds: [w.idB.id],
      targetCustomerId: w.cA.id,
      expectedRevisions: w.revs(w.cA.id, w.cB.id),
      keepTargetForUnresolved: true,
    });
    closed.add(w.zB.id);
    const res = await w.a.get(`/api/m/care/customers/${w.cA.id}/timeline`);
    const text = await res.text();
    expect(JSON.parse(text).items.map((i: { text: string }) => i.text)).toEqual(['hello from zalo A']);
    expect(text).not.toContain('hello from zalo B');
  });
});

describe('identity link / preview / unlink', () => {
  it('previews, rejects stale revisions, links idempotently and refuses a request id reused with another payload', async () => {
    const w = world();
    const body = { identityIds: [w.idB.id, w.idC.id], targetCustomerId: w.cA.id };
    const preview = await json<CareLinkPreviewDto>(await w.a.send('POST', '/api/m/care/identities/preview-link', body));
    expect(preview.noop).toBe(false);
    expect(preview.people.map((p) => p.role).sort()).toEqual(['source', 'source', 'target']);
    expect(preview.expectedRevisions).toEqual(w.revs(w.cA.id, w.cB.id, w.cC.id));
    expect(w.stores.identities.getIdentity(w.idB.id)!.customerId).toBe(w.cB.id); // preview wrote nothing

    const stale = await w.a.send('POST', '/api/m/care/identities/link', {
      ...body,
      expectedRevisions: { ...preview.expectedRevisions, [w.cB.id]: 99 },
      keepTargetForUnresolved: true,
    });
    expect(stale.status).toBe(409);
    expect((await json<CareApiError>(stale)).code).toBe('STALE_REVISION');

    const link = { ...body, expectedRevisions: preview.expectedRevisions, keepTargetForUnresolved: true, requestId: 'link-req-0001' };
    const first = await json<CareLinkResultDto>(await w.a.send('POST', '/api/m/care/identities/link', link));
    expect(first).toMatchObject({ applied: true, targetCustomerId: w.cA.id });
    expect(first.movedIdentityIds.sort()).toEqual([w.idB.id, w.idC.id].sort());
    expect(w.stores.identities.getIdentity(w.idB.id)!.customerId).toBe(w.cA.id);
    expect(w.a.fx.a.prepare('SELECT COUNT(*) AS n FROM care_messages').get()).toEqual({ n: 3 }); // no message moved or copied

    const replay = await json<CareLinkResultDto>(await w.a.send('POST', '/api/m/care/identities/link', link));
    expect(replay).toMatchObject({ applied: true, replayed: true });
    const other = await w.a.send('POST', '/api/m/care/identities/link', { ...link, identityIds: [w.idB.id] });
    expect(other.status).toBe(409);
    expect((await json<CareApiError>(other)).code).toBe('DUPLICATE_REQUEST_PAYLOAD_MISMATCH');
  });

  it('answers undecided unlink items as 409 UNDECIDED_ITEMS with IDs only, then unlinks once decided', async () => {
    const w = world();
    await w.a.send('POST', '/api/m/care/identities/link', {
      identityIds: [w.idB.id, w.idC.id],
      targetCustomerId: w.cA.id,
      expectedRevisions: w.revs(w.cA.id, w.cB.id, w.cC.id),
      keepTargetForUnresolved: true,
    });
    const note = w.stores.profiles.saveProfile(w.cA.id, { note: 'PRIVATE-NOTE-TEXT' });
    const task = w.stores.tasks.createTask({ customerId: w.cA.id, title: 'PRIVATE-TASK-TITLE', dueAtMs: 99_000 });
    const req = { identityIds: [w.idB.id, w.idC.id], expectedRevisions: w.revs(w.cA.id, w.cB.id, w.cC.id) };

    const refused = await w.a.send('POST', '/api/m/care/identities/unlink', req);
    expect(refused.status).toBe(409);
    const text = await refused.text();
    const body = JSON.parse(text) as CareApiError;
    expect(body.code).toBe('CONFIGURATION_CONFLICT');
    expect(body.details?.reason).toBe('UNDECIDED_ITEMS');
    const items = body.details!.items as Array<{ itemKey: string; candidateCustomerIds: string[] }>;
    expect(items.map((i) => i.itemKey).sort()).toEqual([`profile:${note.id}`, `task:${task.id}`].sort());
    expect(items[0].candidateCustomerIds).toContain(w.cA.id);
    expect(text).not.toContain('PRIVATE-NOTE-TEXT');
    expect(text).not.toContain('PRIVATE-TASK-TITLE');
    expect(w.stores.identities.getIdentity(w.idB.id)!.customerId).toBe(w.cA.id); // nothing written

    const done = await json<CareUnlinkResultDto>(
      await w.a.send('POST', '/api/m/care/identities/unlink', {
        ...req,
        decisions: { [`profile:${note.id}`]: w.cA.id, [`task:${task.id}`]: w.cB.id },
      }),
    );
    expect(done).toMatchObject({ applied: true, decided: 2 });
    expect(w.stores.identities.getIdentity(w.idB.id)!.customerId).toBe(w.cB.id);
    expect(w.stores.tasks.getTask(task.id)!.customerId).toBe(w.cB.id);
  });

  it('treats a closed source as not found and validates the bodies strictly', async () => {
    const closed = new Set<string>();
    const w = world({ canReadSource: (id) => !closed.has(id) });
    closed.add(w.zB.id);
    const hidden = await w.a.send('POST', '/api/m/care/identities/preview-link', { identityIds: [w.idB.id], targetCustomerId: w.cA.id });
    expect(hidden.status).toBe(404);
    const viaCustomer = await w.a.send('POST', '/api/m/care/identities/link', {
      customerIds: [w.cB.id],
      targetCustomerId: w.cA.id,
      expectedRevisions: w.revs(w.cA.id, w.cB.id),
    });
    expect(viaCustomer.status).toBe(404);
    closed.clear();

    const send = (p: string, b: unknown) => w.a.send('POST', `/api/m/care/identities/${p}`, b);
    expect((await send('link', { identityIds: [w.idB.id], expectedRevisions: {} })).status).toBe(400); // no target
    expect((await send('link', { identityIds: [w.idB.id], targetCustomerId: w.cA.id, expectedRevisions: { x: 0 } })).status).toBe(400);
    expect((await send('link', { identityIds: [w.idB.id], targetCustomerId: w.cA.id, expectedRevisions: {}, actor: 'evil' })).status).toBe(400);
    expect((await send('unlink', { identityIds: [], expectedRevisions: {} })).status).toBe(400);
    expect((await send('preview-link', { identityIds: [] })).status).toBe(400);
  });
});

describe('/conversations/:id/customer-care', () => {
  it('reads the form and writes with per-part revision checks, an event for other tabs, and no lost update', async () => {
    const w = world();
    const url = `/api/m/care/conversations/${w.convA.id}/customer-care`;
    const view = await json<CareCustomerCareDto>(await w.a.get(url));
    expect(view).toMatchObject({ conversationId: w.convA.id, writable: true, writeOwner: 'core', profile: null, otherProfiles: [] });
    expect(view.customer.id).toBe(w.cA.id);

    const saved = await json<CareCustomerCareDto>(
      await w.a.send('PUT', url, {
        expectedCustomerRevision: view.customer.revision,
        customer: { displayName: 'Chi Lan', phone: '0900111222', stage: 'quoted' },
        expectedProfileRevision: 0,
        profile: { need: { budget: '10tr' }, note: 'thich mau xanh' },
      }),
    );
    expect(saved.customer).toMatchObject({ displayName: 'Chi Lan', phone: '0900111222', stage: 'quoted', revision: view.customer.revision + 1 });
    expect(saved.profile).toMatchObject({ revision: 1, note: 'thich mau xanh', need: { budget: '10tr' }, provenance: 'care:customer_care' });

    // Second tab still holds the old revisions: both parts are refused with the current ones.
    const staleCustomer = await w.a.send('PUT', url, { expectedCustomerRevision: view.customer.revision, customer: { company: 'X' } });
    expect(staleCustomer.status).toBe(409);
    expect(await json<CareApiError>(staleCustomer)).toMatchObject({ code: 'STALE_REVISION', currentRevision: saved.customer.revision, details: { reason: 'CUSTOMER_REVISION' } });
    const staleProfile = await w.a.send('PUT', url, { expectedProfileRevision: 0, profile: { note: 'overwrite' } });
    expect(await json<CareApiError>(staleProfile)).toMatchObject({ code: 'STALE_REVISION', currentRevision: 1, details: { reason: 'PROFILE_REVISION' } });
    expect(w.stores.profiles.getProfile(saved.profile!.id)!.note).toBe('thich mau xanh');

    // Partial profile update keeps the other half; the revision moves once.
    const next = await json<CareCustomerCareDto>(await w.a.send('PUT', url, { expectedProfileRevision: 1, profile: { note: 'updated' } }));
    expect(next.profile).toMatchObject({ revision: 2, note: 'updated', need: { budget: '10tr' } });

    const events = w.a.fx.a.prepare(`SELECT event_type, conversation_id FROM care_events WHERE event_type = 'customer_care.updated'`).all();
    expect(events.length).toBe(2); // one per successful write

    expect((await w.a.send('PUT', url, {})).status).toBe(400);
    expect((await w.a.send('PUT', url, { customer: { company: 'X' } })).status).toBe(400); // revision missing
    expect((await w.a.send('PUT', url, { expectedProfileRevision: 2, profile: { need: { blob: 'x'.repeat(20_000) } } })).status).toBe(400);
    expect((await w.a.send('PUT', url, { expectedCustomerRevision: 1, customer: { stage: 'vip' } })).status).toBe(400);
  });

  it('scopes the participant to the conversation and honours the per-account read gate', async () => {
    const closed = new Set<string>();
    const w = world({ canReadSource: (id) => !closed.has(id) });
    const msg = (sender: string, id: string, at: number) =>
      w.a.put(chatMessage(w.zA, { senderIdentityKey: sender, externalConversationKey: 'group:1', nativeMessageId: id, sentAtMs: at, text: `from ${sender}`, metadata: { type: 'chat', conversationKind: 'group' } }));
    msg('u-5', 'g5', 6_000);
    const group = w.stores.conversations.getConversationByExternalKey(w.zA.id, 'group:1')!;
    expect(group.kind).toBe('group');
    const speaker = w.stores.identities.getIdentityByExternal(w.zA.id, 'user', 'u-5')!;
    const url = `/api/m/care/conversations/${group.id}/customer-care`;

    const ok = await json<CareCustomerCareDto>(await w.a.get(`${url}?participant=${speaker.id}`));
    expect(ok).toMatchObject({ participantIdentityId: speaker.id });
    expect(ok.customer.id).toBe(speaker.customerId);
    // u-1 never spoke in this group; an identity of another account is not a participant either
    expect((await w.a.get(`${url}?participant=${w.idA.id}`)).status).toBe(404);
    expect((await w.a.get(`${url}?participant=${w.idB.id}`)).status).toBe(404);
    expect((await w.a.get(`${url}?participant=nope`)).status).toBe(404);
    expect((await w.a.get(url)).status).toBe(404); // a group has no primary customer

    closed.add(w.zA.id);
    expect((await w.a.get(`${url}?participant=${speaker.id}`)).status).toBe(404);
  });
});

describe('identity unlink preview and revision-carrying errors', () => {
  async function linked() {
    const w = world();
    const link = await w.a.send('POST', '/api/m/care/identities/link', {
      identityIds: [w.idB.id, w.idC.id],
      targetCustomerId: w.cA.id,
      expectedRevisions: w.revs(w.cA.id, w.cB.id, w.cC.id),
      keepTargetForUnresolved: true,
    });
    expect(link.status).toBe(200);
    return w;
  }
  const preview = (w: ReturnType<typeof world>, body: Record<string, unknown>) => w.a.send('POST', '/api/m/care/identities/preview-unlink', body);

  it('reports where each identity goes, the current revision of every customer, and writes nothing', async () => {
    const w = await linked();
    const before = {
      events: w.a.fx.a.prepare('SELECT COUNT(*) AS n FROM care_events').get(),
      linkEvents: w.a.fx.a.prepare('SELECT COUNT(*) AS n FROM care_link_events').get(),
      seq: w.a.fx.a.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'care_events'`).get(),
      customers: [w.cA.id, w.cB.id, w.cC.id].map((id) => w.stores.customers.getCustomer(id)!.revision),
    };

    const p = await json<CareUnlinkPreviewDto>(await preview(w, { identityIds: [w.idB.id, w.idC.id] }));
    expect(p).toMatchObject({ noop: false, linkedCustomerId: w.cA.id, undecided: [], returned: { profiles: 0, tasks: 0, conversations: expect.any(Number) } });
    expect(p.restores.map((r) => [r.identityId, r.restoreToCustomerId, r.fromCustomerId]).sort()).toEqual(
      [[w.idB.id, w.cB.id, w.cA.id], [w.idC.id, w.cC.id, w.cA.id]].sort(),
    );
    expect(p.restores.find((r) => r.identityId === w.idC.id)).toMatchObject({ channel: 'email', accountId: w.mail.id });
    expect(p.customers.map((c) => [c.customerId, c.role]).sort()).toEqual([[w.cA.id, 'linked'], [w.cB.id, 'restored'], [w.cC.id, 'restored']].sort());
    expect(p.expectedRevisions).toEqual(w.revs(w.cA.id, w.cB.id, w.cC.id));

    // a rolled-back analysis: no unlink, no audit row, no event, no sequence number consumed
    expect(w.stores.identities.getIdentity(w.idB.id)!.customerId).toBe(w.cA.id);
    expect(w.a.fx.a.prepare('SELECT COUNT(*) AS n FROM care_events').get()).toEqual(before.events);
    expect(w.a.fx.a.prepare('SELECT COUNT(*) AS n FROM care_link_events').get()).toEqual(before.linkEvents);
    expect(w.a.fx.a.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'care_events'`).get()).toEqual(before.seq);
    expect([w.cA.id, w.cB.id, w.cC.id].map((id) => w.stores.customers.getCustomer(id)!.revision)).toEqual(before.customers);

    // the previewed revisions are exactly what unlink needs
    const done = await w.a.send('POST', '/api/m/care/identities/unlink', { identityIds: [w.idB.id, w.idC.id], expectedRevisions: p.expectedRevisions });
    expect(done.status).toBe(200);
    expect(w.stores.identities.getIdentity(w.idB.id)!.customerId).toBe(w.cB.id);
  });

  it('lists undecided items (IDs only) and shows the counts once they are decided', async () => {
    const w = await linked();
    const note = w.stores.profiles.saveProfile(w.cA.id, { note: 'PRIVATE-NOTE-TEXT' });
    const task = w.stores.tasks.createTask({ customerId: w.cA.id, title: 'PRIVATE-TASK-TITLE', dueAtMs: 99_000 });
    const res = await preview(w, { identityIds: [w.idB.id, w.idC.id] });
    const text = await res.text();
    expect(text).not.toContain('PRIVATE-');
    const p = JSON.parse(text) as CareUnlinkPreviewDto;
    expect(p.returned).toBeNull();
    expect(p.undecided.map((u) => u.itemKey).sort()).toEqual([`profile:${note.id}`, `task:${task.id}`].sort());
    expect(p.undecided[0].candidateCustomerIds.sort()).toEqual([w.cA.id, w.cB.id, w.cC.id].sort());
    expect(w.stores.tasks.getTask(task.id)!.customerId).toBe(w.cA.id);

    const decided = await json<CareUnlinkPreviewDto>(
      await preview(w, { identityIds: [w.idB.id, w.idC.id], decisions: { [`profile:${note.id}`]: w.cA.id, [`task:${task.id}`]: w.cB.id } }),
    );
    expect(decided.undecided).toEqual([]);
    expect(decided.returned).toMatchObject({ tasks: 1 });
    expect(w.stores.tasks.getTask(task.id)!.customerId).toBe(w.cA.id); // still nothing moved
    // a decision for an item that needs none is the real unlink's 400
    expect((await preview(w, { identityIds: [w.idB.id, w.idC.id], decisions: { 'task:nope': w.cA.id } })).status).toBe(400);
  });

  it('is a no-op for restored identities, a typed error for never-linked ones, and respects the read gate', async () => {
    const closed = new Set<string>();
    const w = world({ canReadSource: (id) => !closed.has(id) });
    expect((await preview(w, { identityIds: [w.idA.id] })).status).toBe(409); // never linked
    expect((await preview(w, { identityIds: ['nope'] })).status).toBe(404);
    expect((await preview(w, { identityIds: [] })).status).toBe(400);
    expect((await preview(w, { identityIds: [w.idA.id], extra: 1 })).status).toBe(400);

    await w.a.send('POST', '/api/m/care/identities/link', { identityIds: [w.idB.id], targetCustomerId: w.cA.id, expectedRevisions: w.revs(w.cA.id, w.cB.id), keepTargetForUnresolved: true });
    closed.add(w.zB.id);
    expect((await preview(w, { identityIds: [w.idB.id] })).status).toBe(404);
    closed.clear();
    await w.a.send('POST', '/api/m/care/identities/unlink', { identityIds: [w.idB.id], expectedRevisions: w.revs(w.cA.id, w.cB.id) });
    const again = await json<CareUnlinkPreviewDto>(await preview(w, { identityIds: [w.idB.id] }));
    expect(again).toMatchObject({ noop: true, linkedCustomerId: null, restores: [], customers: [], undecided: [] });
  });

  it('names every customer and its current revision when unlink gets stale or missing revisions', async () => {
    const w = await linked();
    const current = w.revs(w.cA.id, w.cB.id, w.cC.id);
    const unlink = (expectedRevisions: Record<string, number>) => w.a.send('POST', '/api/m/care/identities/unlink', { identityIds: [w.idB.id, w.idC.id], expectedRevisions });

    const stale = await unlink({ ...current, [w.cB.id]: current[w.cB.id] + 5 });
    expect(stale.status).toBe(409);
    expect(await json<CareApiError>(stale)).toMatchObject({
      code: 'STALE_REVISION',
      currentRevision: current[w.cB.id],
      details: { reason: 'STALE_REVISIONS', expectedRevisions: current },
    });
    const missing = await unlink({ [w.cA.id]: current[w.cA.id] });
    expect(missing.status).toBe(400);
    expect(await json<CareApiError>(missing)).toMatchObject({ code: 'INVALID_COMMAND', details: { reason: 'REVISIONS_REQUIRED', expectedRevisions: current } });
    expect(w.stores.identities.getIdentity(w.idB.id)!.customerId).toBe(w.cA.id);
  });
});
