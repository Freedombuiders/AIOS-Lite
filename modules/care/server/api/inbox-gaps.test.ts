import { afterEach, describe, expect, it, vi } from 'vitest';
import { CareOutboxService } from '../application/outbox-service.js';
import { chatMessage, createEligibleAccount, emailMessage } from '../test-fixtures.js';
import type { CareAccountDto, CareApiError, CareConversationDto, CareConversationListDto, CareMessagePageDto } from './dto.js';
import type { CareConversationOutboxItemDto } from './dto-ops.js';
import { appendEvent, readStream, sseEvents } from './test-helpers.js';
import { makeFileApi } from './test-helpers.js';

let api: ReturnType<typeof makeFileApi> | null = null;
afterEach(() => {
  api?.close();
  api = null;
});
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const T0 = 1_700_000_000_000;

function setup(deps: Parameters<typeof makeFileApi>[0] = {}) {
  const a = makeFileApi(deps);
  api = a;
  const zalo = createEligibleAccount(a.stores, { channel: 'zalo', nativeAccountId: 'zalo-G' });
  const mail = createEligibleAccount(a.stores, { channel: 'email', connectorKind: 'gmail', nativeAccountId: 'shop@example.com' });
  const chat = (key: string, id: string, at: number, text: string, over: Record<string, unknown> = {}) =>
    a.put(chatMessage(zalo, { senderIdentityKey: key, externalConversationKey: `peer:${key}`, nativeMessageId: id, sentAtMs: at, text, ...over })).messageId!;
  const conv = (acct: typeof zalo, key: string) => a.stores.conversations.getConversationByExternalKey(acct.id, key)!;
  return { a, stores: a.stores, zalo, mail, chat, conv };
}

describe('conversation list: last message preview', () => {
  it('is bounded, one line, decrypted only for the rows of the page, and never for a deleted message', async () => {
    const w = setup();
    for (let i = 0; i < 5; i += 1) w.chat(`u${i}`, `m${i}`, T0 + i, i === 4 ? `  long   line\nwith\tgaps ${'x'.repeat(400)}` : `hello ${i}`);
    w.a.put(emailMessage(w.mail, { senderIdentityKey: 'b@example.com', externalConversationKey: 'thread:1', nativeMessageId: 'g1', sentAtMs: T0 + 10, text: '', metadata: { type: 'email', subject: 'Báo giá lô hàng', from: 'b@example.com', to: ['shop@example.com'] } }));

    const spy = vi.spyOn(w.stores.messages, 'getMessage');
    const page = await json<CareConversationListDto>(await w.a.get('/api/m/care/conversations?limit=2'));
    expect(page.items).toHaveLength(2);
    expect(spy.mock.calls.length).toBe(2); // one message per row of the page, not per conversation
    spy.mockRestore();

    const all = (await json<CareConversationListDto>(await w.a.get('/api/m/care/conversations?limit=50'))).items;
    const byTitle = (id: string) => all.find((c) => c.id === w.conv(id === 'mail' ? w.mail : w.zalo, id === 'mail' ? 'thread:1' : `peer:${id}`).id)!;
    const long = byTitle('u4').lastMessagePreview!;
    expect(long.text.startsWith('long line with gaps xxx')).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual(161);
    expect(long.text.endsWith('…')).toBe(true);
    expect(long).toMatchObject({ truncated: true, direction: 'in', senderRole: 'customer' });
    expect(byTitle('u0').lastMessagePreview).toMatchObject({ text: 'hello 0', truncated: false });
    expect(byTitle('mail').lastMessagePreview!.text).toBe('Báo giá lô hàng'); // empty body falls back to the subject

    // the newest message is deleted at the source: the preview moves to the previous one and never shows the purged text
    const c4 = w.conv(w.zalo, 'peer:u4');
    w.stores.messages.softDeleteMessage(w.stores.messages.listMessages(c4.id)[0].id);
    w.stores.conversations.recomputeProjection(c4.id);
    const after = await w.a.get(`/api/m/care/conversations/${c4.id}`);
    expect((await after.text())).not.toContain('long line');
    const emptied = w.chat('u4', 'm4b', T0 + 20, 'second');
    w.stores.messages.softDeleteMessage(emptied);
    w.stores.conversations.recomputeProjection(c4.id);
    expect((await json<CareConversationDto>(await w.a.get(`/api/m/care/conversations/${c4.id}`))).lastMessagePreview).toBeNull();
  });
});

describe('message list: tombstones', () => {
  it('returns deleted messages as flagged, empty rows in place; search never returns purged text', async () => {
    const w = setup();
    const ids = ['first', 'SECRET-DELETED-BODY', 'third'].map((text, i) => w.chat('u1', `t${i}`, T0 + i * 10, text));
    const conv = w.conv(w.zalo, 'peer:u1');
    w.stores.messages.softDeleteMessage(ids[1]);
    w.stores.messages.insertTombstone(w.zalo.id, conv.id, 'zalo_chat', 'never-seen', T0 + 15); // a delete that arrived without the body

    const res = await w.a.get(`/api/m/care/conversations/${conv.id}/messages`);
    const text = await res.text();
    expect(text).not.toContain('SECRET-DELETED-BODY');
    const page = JSON.parse(text) as CareMessagePageDto;
    expect(page.items.map((m) => [m.deleted, m.text])).toEqual([[false, 'third'], [true, ''], [true, ''], [false, 'first']]);
    const gone = page.items.filter((m) => m.deleted);
    expect(gone.every((m) => m.metadata && Object.keys(m.metadata).length === 0 && typeof m.deletedAtMs === 'number')).toBe(true);
    expect(page.items.filter((m) => !m.deleted).every((m) => m.deletedAtMs === null)).toBe(true);

    // paging and the around window keep tombstones in place and without gaps
    const p1 = await json<CareMessagePageDto>(await w.a.get(`/api/m/care/conversations/${conv.id}/messages?limit=2`));
    const p2 = await json<CareMessagePageDto>(await w.a.get(`/api/m/care/conversations/${conv.id}/messages?limit=2&before=${p1.olderCursor}`));
    expect([...p1.items, ...p2.items].map((m) => m.id)).toEqual(page.items.map((m) => m.id));
    const around = await json<CareMessagePageDto>(await w.a.get(`/api/m/care/conversations/${conv.id}/messages?around=${ids[1]}&limit=4`));
    expect(around.items.map((m) => m.id)).toContain(ids[1]);
    expect(around.items.find((m) => m.id === ids[1])).toMatchObject({ deleted: true, text: '' });
    const afterFirst = Buffer.from(`${T0}:${ids[0]}`).toString('base64url');
    const newer = await json<CareMessagePageDto>(await w.a.get(`/api/m/care/conversations/${conv.id}/messages?after=${afterFirst}&limit=10`));
    expect(newer.items.some((m) => m.deleted)).toBe(true);

    // search never returns a purged body, nor the tombstone itself
    const hit = await json<{ items: unknown[] }>(await w.a.get('/api/m/care/search?q=SECRET-DELETED'));
    expect(hit.items).toEqual([]);
    expect((await json<{ items: unknown[] }>(await w.a.get('/api/m/care/search?q=third'))).items).toHaveLength(1);
  });
});

describe('GET /conversations/:id/outbox', () => {
  it('lists every delivery intent of the conversation, newest first, without text, filterable', async () => {
    const w = setup((fx) => ({ outboxService: new CareOutboxService(fx.a, fx.storesA) }));
    const mid = w.chat('u1', 'm1', T0, 'Giá?');
    w.chat('u2', 'o1', T0 + 1, 'other');
    const conv = w.conv(w.zalo, 'peer:u1');
    const other = w.conv(w.zalo, 'peer:u2');
    const service = new CareOutboxService(w.a.fx.a, w.stores);
    const mk = (id: string, over: Record<string, unknown> = {}) =>
      service.enqueue({ accountId: w.zalo.id, conversationId: conv.id, clientRequestId: id, actor: 'manual', content: { kind: 'chat', text: `PRIVATE BODY ${id}`, replyToMessageId: mid }, ...over } as never).intent;
    const sent = mk('req-sent-0001');
    w.a.fx.a.prepare(`UPDATE care_delivery_intents SET status = 'sent', sent_at = ?, receipt_level = 'delivered', created_at = ? WHERE id = ?`).run(T0 + 500, T0 + 100, sent.id);
    const pending = mk('req-pend-0001');
    w.a.fx.a.prepare(`UPDATE care_delivery_intents SET created_at = ? WHERE id = ?`).run(T0 + 200, pending.id);
    const draft = service.createDraft({ accountId: w.zalo.id, conversationId: conv.id, clientRequestId: 'draft-0000001', actor: 'approved', content: { kind: 'chat', text: 'PRIVATE DRAFT' } }).intent;
    w.a.fx.a.prepare(`UPDATE care_delivery_intents SET created_at = ? WHERE id = ?`).run(T0 + 300, draft.id);
    service.enqueue({ accountId: w.zalo.id, conversationId: other.id, clientRequestId: 'req-other-001', actor: 'manual', content: { kind: 'chat', text: 'elsewhere' } });

    const res = await w.a.get(`/api/m/care/conversations/${conv.id}/outbox`);
    const text = await res.text();
    expect(text).not.toContain('PRIVATE');
    const items = (JSON.parse(text) as { items: CareConversationOutboxItemDto[] }).items;
    expect(items.map((i) => [i.id, i.status])).toEqual([[draft.id, 'draft'], [pending.id, 'pending'], [sent.id, 'sent']]);
    expect(items[2]).toMatchObject({ actor: 'manual', channel: 'zalo', receiptLevel: 'delivered', replyToMessageId: mid, payloadRevision: 1, sentAtMs: T0 + 500, conversationId: conv.id });
    expect(items.every((i) => i.conversationId === conv.id)).toBe(true);

    const only = await json<{ items: CareConversationOutboxItemDto[] }>(await w.a.get(`/api/m/care/conversations/${conv.id}/outbox?status=sent,pending`));
    expect(only.items.map((i) => i.status).sort()).toEqual(['pending', 'sent']);
    expect((await json<{ items: unknown[] }>(await w.a.get(`/api/m/care/conversations/${conv.id}/outbox?limit=1`))).items).toHaveLength(1);
    expect((await w.a.get(`/api/m/care/conversations/${conv.id}/outbox?status=bogus`)).status).toBe(400);
    expect((await w.a.get('/api/m/care/conversations/nope/outbox')).status).toBe(404);
  });
});

describe('mailbox signature (read-only)', () => {
  it('shows the one signature source on email accounts and the single conversation, trimmed, null for chat', async () => {
    const calls: string[] = [];
    const w = setup({ signatureFor: (account) => { calls.push(account.id); return account.channel === 'email' ? '  Trân trọng,\nShop A  ' : 'must be ignored for chat'; } });
    w.chat('u1', 'm1', T0, 'hi');
    w.a.put(emailMessage(w.mail, { senderIdentityKey: 'b@example.com', externalConversationKey: 'thread:1', nativeMessageId: 'g1', sentAtMs: T0 }));

    const accounts = (await json<{ items: CareAccountDto[] }>(await w.a.get('/api/m/care/accounts'))).items;
    expect(accounts.find((a) => a.id === w.mail.id)!.signature).toBe('Trân trọng,\nShop A');
    expect(accounts.find((a) => a.id === w.zalo.id)!.signature).toBeNull();
    expect(calls).not.toContain(w.zalo.id); // chat accounts never ask the source

    const mailConv = w.conv(w.mail, 'thread:1');
    expect((await json<CareConversationDto>(await w.a.get(`/api/m/care/conversations/${mailConv.id}`))).signature).toBe('Trân trọng,\nShop A');
    expect((await json<CareConversationDto>(await w.a.get(`/api/m/care/conversations/${w.conv(w.zalo, 'peer:u1').id}`))).signature).toBeNull();
    // list rows stay cheap: no signature lookups there
    const list = await json<CareConversationListDto>(await w.a.get('/api/m/care/conversations'));
    expect(list.items.every((c) => c.signature === undefined)).toBe(true);
  });

  it('survives a throwing source, and by default shows no signature', async () => {
    const boom = setup({ signatureFor: () => { throw new Error('boom /secret'); } });
    expect((await json<{ items: CareAccountDto[] }>(await boom.a.get('/api/m/care/accounts'))).items.find((a) => a.id === boom.mail.id)!.signature).toBeNull();
    boom.a.close();
    api = null;

    const w = setup();
    const accounts = async () => (await json<{ items: CareAccountDto[] }>(await w.a.get('/api/m/care/accounts'))).items.find((a) => a.id === w.mail.id)!.signature;
    expect(await accounts()).toBeNull(); // no source given: nothing to show
  });
});

describe('per-source read gate on the inbox surface', () => {
  it('hides a closed source from list, counts, previews, search, messages, accounts, status and the event stream', async () => {
    const closed = new Set<string>();
    const w = setup({ canReadSource: (id) => !closed.has(id) });
    w.chat('u1', 'm1', T0, 'zalo secret body');
    w.a.put(emailMessage(w.mail, { senderIdentityKey: 'b@example.com', externalConversationKey: 'thread:1', nativeMessageId: 'g1', sentAtMs: T0 + 1, text: 'mail body' }));
    const zConv = w.conv(w.zalo, 'peer:u1');
    const mConv = w.conv(w.mail, 'thread:1');
    appendEvent(w.stores, w.zalo.id, zConv.id, 1);
    appendEvent(w.stores, w.mail.id, mConv.id, 2);
    const stream = await w.a.get('/api/m/care/events?after=0');
    const reader = stream.body!.getReader();
    await readStream(reader, (t) => t.includes('"seq":4')); // replayed while everything was still open

    closed.add(w.zalo.id);
    const list = await json<CareConversationListDto>(await w.a.get('/api/m/care/conversations'));
    expect(list.items.map((c) => c.id)).toEqual([mConv.id]);
    expect(list.counts?.total).toBe(1);
    expect(JSON.stringify(list)).not.toContain('zalo secret');
    expect((await w.a.get(`/api/m/care/conversations/${zConv.id}`)).status).toBe(404);
    expect((await w.a.get(`/api/m/care/conversations/${zConv.id}/messages`)).status).toBe(404);
    expect((await w.a.get(`/api/m/care/conversations/${zConv.id}/outbox`)).status).toBe(404);
    expect((await w.a.get(`/api/m/care/conversations?account=${w.zalo.id}`)).status).toBe(404);
    expect((await json<{ items: unknown[] }>(await w.a.get('/api/m/care/search?q=secret'))).items).toEqual([]);
    expect((await json<{ items: CareAccountDto[] }>(await w.a.get('/api/m/care/accounts'))).items.map((a) => a.id)).toEqual([w.mail.id]);
    expect(await json<{ accounts: { total: number }; conversations: { total: number } }>(await w.a.get('/api/m/care/status'))).toMatchObject({ accounts: { total: 1 }, conversations: { total: 1 } });
    expect((await w.a.send('POST', `/api/m/care/conversations/${zConv.id}/read`, {})).status).toBe(404);

    // events of the closed source are skipped (cursor still advances); the open source still streams
    const closedEvent = appendEvent(w.stores, w.zalo.id, zConv.id, 3, { messageId: 'closed-one' });
    const openEvent = appendEvent(w.stores, w.mail.id, mConv.id, 4, { messageId: 'open-one' });
    w.a.handle.hub()!.tick();
    const live = await readStream(reader, (t) => t.includes('open-one'));
    expect(live.text).not.toContain('closed-one');
    expect(sseEvents(live.text).map((e) => e.data.seq)).toEqual([openEvent.seq]);
    expect(closedEvent.seq).toBeLessThan(openEvent.seq);
    const snap = sseEvents((await readStream((await w.a.get('/api/m/care/events')).body!.getReader(), (t) => t.includes('snapshot'))).text)[0];
    expect(snap.data.conversations.map((r: { id: string }) => r.id)).toEqual([mConv.id]);
    expect(snap.data.accounts.map((r: { id: string }) => r.id)).toEqual([w.mail.id]);
    await reader.cancel();

    closed.clear();
    expect((await json<CareConversationListDto>(await w.a.get('/api/m/care/conversations'))).items).toHaveLength(2);
  });
});

describe('message DTO: senderName in groups', () => {
  it('shows the identity display name in groups/topics only, null when unknown, never a native id', async () => {
    const w = setup();
    const named = w.stores.customers.createCustomer({ displayName: 'Customer Lan' });
    w.stores.identities.createIdentity({ customerId: named.id, accountId: w.zalo.id, namespace: 'user', externalIdentityId: 'native-lan-777', displayName: '  Chị Lan ', username: 'lan_handle' });
    const group = { metadata: { type: 'chat', conversationKind: 'group' } };
    w.chat('native-lan-777', 'g1', T0, 'hello group', { externalConversationKey: 'group:1', ...group });
    w.chat('native-bob-888', 'g2', T0 + 1, 'from an unnamed member', { externalConversationKey: 'group:1', ...group });
    w.chat('native-lan-777', 'g3', T0 + 2, 'operator in group', { externalConversationKey: 'group:1', direction: 'out', senderRole: 'operator', senderIdentityKey: null, ...group });
    w.chat('native-lan-777', 'd1', T0 + 3, 'direct message', { externalConversationKey: 'peer:direct' });

    const group1 = w.conv(w.zalo, 'group:1');
    expect(group1.kind).toBe('group');
    const text = await (await w.a.get(`/api/m/care/conversations/${group1.id}/messages`)).text();
    const items = (JSON.parse(text) as CareMessagePageDto).items;
    expect(items.map((m) => [m.text, m.senderName])).toEqual([
      ['operator in group', null],
      ['from an unnamed member', null],
      ['hello group', 'Chị Lan'],
    ]);
    expect(text).not.toContain('lan_handle'); // username is not a display name
    expect(text).not.toContain('native-bob-888');

    const direct = (await json<CareMessagePageDto>(await w.a.get(`/api/m/care/conversations/${w.conv(w.zalo, 'peer:direct').id}/messages`))).items;
    expect(direct.every((m) => m.senderName === null)).toBe(true);

    // around / after windows carry names too
    const around = await json<CareMessagePageDto>(await w.a.get(`/api/m/care/conversations/${group1.id}/messages?around=${items[2].id}&limit=4`));
    expect(around.items.find((m) => m.id === items[2].id)!.senderName).toBe('Chị Lan');

    // a tombstone keeps no name; a closed source has no messages at all
    w.stores.messages.softDeleteMessage(items[2].id);
    expect((await json<CareMessagePageDto>(await w.a.get(`/api/m/care/conversations/${group1.id}/messages`))).items.find((m) => m.id === items[2].id)).toMatchObject({ deleted: true, senderName: null });
  });
});
