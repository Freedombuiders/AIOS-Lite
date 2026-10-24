import { afterEach, describe, expect, it } from 'vitest';
import { CareOutboxService } from '../application/outbox-service.js';
import { chatMessage, createEligibleAccount } from '../test-fixtures.js';
import type { CareApiError } from './dto.js';
import type { CareDraftDto } from './dto-ops.js';
import { makeFileApi } from './test-helpers.js';

let api: ReturnType<typeof makeFileApi> | null = null;
afterEach(() => {
  api?.close();
  api = null;
});
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

function setup(deps: Parameters<typeof makeFileApi>[0] = (fx) => ({ outboxService: new CareOutboxService(fx.a, fx.storesA) })) {
  const a = makeFileApi(deps);
  api = a;
  const zalo = createEligibleAccount(a.stores, { channel: 'zalo', nativeAccountId: 'zalo-D' });
  const mail = createEligibleAccount(a.stores, { channel: 'email', connectorKind: 'gmail', nativeAccountId: 'shop@example.com' });
  const m1 = a.put(chatMessage(zalo, { senderIdentityKey: 'u-1', externalConversationKey: 'peer:1', nativeMessageId: 'm1', sentAtMs: 1_000, text: 'Giá?' })).messageId!;
  const other = a.put(chatMessage(zalo, { senderIdentityKey: 'u-2', externalConversationKey: 'peer:2', nativeMessageId: 'o1', sentAtMs: 2_000 })).messageId!;
  const conv = a.stores.conversations.getConversationByExternalKey(zalo.id, 'peer:1')!;
  const thread = a.stores.conversations.upsertConversation({ accountId: mail.id, externalKey: 'thread:1', kind: 'email_thread', title: 'Quote' });
  const service = new CareOutboxService(a.fx.a, a.stores);
  const chatDraft = service.createDraft({ accountId: zalo.id, conversationId: conv.id, clientRequestId: 'draft-chat-0001', actor: 'approved', content: { kind: 'chat', text: 'Dạ 100k ạ' } }).intent;
  const mailDraft = service.createDraft({
    accountId: mail.id,
    conversationId: thread.id,
    clientRequestId: 'draft-mail-0001',
    actor: 'approved',
    content: { kind: 'email', text: 'Body', to: ['buyer@example.com'], cc: ['boss@example.com'], bcc: ['audit-private@example.com'], subject: 'Re: Quote' },
  }).intent;
  return { a, service, zalo, mail, conv, m1, other, chatDraft, mailDraft };
}

const patch = (a: ReturnType<typeof makeFileApi>, id: string, body: Record<string, unknown>) => a.send('PATCH', `/api/m/care/drafts/${id}`, body);

describe('PATCH /drafts/:id', () => {
  it('edits text, returns the new revision, drops nothing but the old approval and lets the UI approve exactly that revision', async () => {
    const { a, chatDraft } = setup();
    const edited = await json<CareDraftDto>(await patch(a, chatDraft.id, { expectedRevision: 1, text: 'Dạ 90k ạ' }));
    expect(edited).toMatchObject({ id: chatDraft.id, text: 'Dạ 90k ạ', payloadRevision: 2, status: 'draft', approvedRevision: null });

    // the reviewer who still holds revision 1 is told so, with the current revision
    const stale = await patch(a, chatDraft.id, { expectedRevision: 1, text: 'lost' });
    expect(stale.status).toBe(409);
    expect(await json<CareApiError>(stale)).toMatchObject({ code: 'STALE_REVISION', currentRevision: 2 });
    const staleApprove = await a.send('POST', `/api/m/care/drafts/${chatDraft.id}/approve`, { expectedRevision: 1 });
    expect(staleApprove.status).toBe(409);
    expect((await json<CareDraftDto>(await a.get(`/api/m/care/drafts/${chatDraft.id}`))).text).toBe('Dạ 90k ạ');

    const ok = await json<CareDraftDto>(await a.send('POST', `/api/m/care/drafts/${chatDraft.id}/approve`, { expectedRevision: edited.payloadRevision }));
    expect(ok).toMatchObject({ status: 'pending', approvedRevision: 2, text: 'Dạ 90k ạ' });
  });

  it('is a no-op when nothing changes, records the context revision when given, and re-opens an unsent pending intent as a draft', async () => {
    const { a, chatDraft, conv } = setup();
    const same = await json<CareDraftDto>(await patch(a, chatDraft.id, { expectedRevision: 1, text: 'Dạ 100k ạ' }));
    expect(same.payloadRevision).toBe(1);
    const ctxRev = await json<CareDraftDto>(await patch(a, chatDraft.id, { expectedRevision: 1, text: 'Dạ 100k ạ', currentContextRevision: conv.revision + 1 }));
    expect(ctxRev).toMatchObject({ payloadRevision: 2, contextRevision: conv.revision + 1 });

    await a.send('POST', `/api/m/care/drafts/${chatDraft.id}/approve`, { expectedRevision: 2 });
    expect((await json<CareDraftDto>(await a.get(`/api/m/care/drafts/${chatDraft.id}`))).status).toBe('pending');
    const reopened = await json<CareDraftDto>(await patch(a, chatDraft.id, { expectedRevision: 2, text: 'Dạ 80k ạ' }));
    expect(reopened).toMatchObject({ status: 'draft', payloadRevision: 3, approvedRevision: null });

    a.fx.a.prepare(`UPDATE care_delivery_intents SET status = 'sent' WHERE id = ?`).run(chatDraft.id);
    expect((await patch(a, chatDraft.id, { expectedRevision: 3, text: 'too late' })).status).toBe(409);
  });

  it('edits email recipients and subject, keeps the BCC private and validates addresses', async () => {
    const { a, mailDraft } = setup();
    const res = await patch(a, mailDraft.id, { expectedRevision: 1, to: ['new@example.com'], cc: [], subject: 'Re: Quote v2', bcc: ['other-private@example.com'] });
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ payloadRevision: 2, email: { to: ['new@example.com'], cc: [], subject: 'Re: Quote v2', hasBcc: true } });
    expect(text).not.toContain('private@example.com');
    expect(a.stores.outbox.getIntent(mailDraft.id)!.payload).toMatchObject({ bcc: ['other-private@example.com'] });

    // untouched fields stay (cc/bcc survive a subject-only edit)
    const keep = await patch(a, mailDraft.id, { expectedRevision: 2, subject: 'Re: Quote v3' });
    expect(keep.status).toBe(200);
    expect(a.stores.outbox.getIntent(mailDraft.id)!.payload).toMatchObject({ bcc: ['other-private@example.com'], target: { to: ['new@example.com'], subject: 'Re: Quote v3' } });

    expect((await patch(a, mailDraft.id, { expectedRevision: 3, to: ['not-an-address'] })).status).toBe(400);
    expect((await patch(a, mailDraft.id, { expectedRevision: 3, to: [] })).status).toBe(400);
    expect((await patch(a, mailDraft.id, { expectedRevision: 3, topicId: '5' })).status).toBe(400);
    expect(a.stores.outbox.getIntent(mailDraft.id)!.payloadRevision).toBe(3);
  });

  it('only quotes a message of the draft conversation, cannot give a chat draft email fields, and never retargets', async () => {
    const { a, chatDraft, m1, other, conv, zalo } = setup();
    const quoted = await patch(a, chatDraft.id, { expectedRevision: 1, replyToMessageId: m1 });
    expect(quoted.status).toBe(200);
    const native = a.stores.messages.getMessage(m1)!.nativeMessageId;
    expect(a.stores.outbox.getIntent(chatDraft.id)!.payload).toMatchObject({ target: { replyToMessageId: native, externalConversationKey: 'peer:1' } });
    expect((await patch(a, chatDraft.id, { expectedRevision: 2, replyToMessageId: other })).status).toBe(404);
    const cleared = await json<CareDraftDto>(await patch(a, chatDraft.id, { expectedRevision: 2, replyToMessageId: null }));
    expect(cleared.payloadRevision).toBe(3);
    expect(a.stores.outbox.getIntent(chatDraft.id)!.payload.target.replyToMessageId).toBeUndefined();

    expect((await patch(a, chatDraft.id, { expectedRevision: 3, to: ['a@example.com'] })).status).toBe(400);
    expect((await patch(a, chatDraft.id, { expectedRevision: 3, bcc: ['a@example.com'] })).status).toBe(400);
    expect((await patch(a, chatDraft.id, { expectedRevision: 3, topicId: '5' })).status).toBe(400); // zalo has no topics
    expect((await patch(a, chatDraft.id, { expectedRevision: 3, conversationId: other })).status).toBe(400);
    expect((await patch(a, chatDraft.id, { expectedRevision: 3, accountId: 'x' })).status).toBe(400);
    expect((await patch(a, chatDraft.id, { expectedRevision: 3 })).status).toBe(400);
    expect(a.stores.outbox.getIntent(chatDraft.id)).toMatchObject({ accountId: zalo.id, conversationId: conv.id, channel: 'zalo' });
  });

  it('answers 501 without the outbox service, 404 for unknown or closed-source drafts', async () => {
    const closed = new Set<string>();
    const bare = setup({ canReadSource: (id) => !closed.has(id) });
    expect((await patch(bare.a, bare.chatDraft.id, { expectedRevision: 1, text: 'x' })).status).toBe(501);
    bare.a.close();
    api = null;

    const s = setup((fx) => ({ outboxService: new CareOutboxService(fx.a, fx.storesA), canReadSource: (id) => !closed.has(id) }));
    expect((await patch(s.a, 'nope', { expectedRevision: 1, text: 'x' })).status).toBe(404);
    closed.add(s.zalo.id);
    const res = await patch(s.a, s.chatDraft.id, { expectedRevision: 1, text: 'x' });
    expect(res.status).toBe(404);
    expect(s.a.stores.outbox.getIntent(s.chatDraft.id)!.payloadRevision).toBe(1);
  });
});
