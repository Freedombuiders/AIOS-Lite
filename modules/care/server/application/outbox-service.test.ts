import { afterEach, describe, expect, it } from 'vitest';
import { CareError } from '../../../_lib/care-kit/errors.js';
import { chatMessage, dumpCareTables, emailMessage } from '../test-fixtures.js';
import { CareOutboxService, createCareDraftSink, createCareReplyPort, toCareOutboxDto } from './outbox-service.js';
import type { DraftProposal, DraftSink } from './agent-ports.js';
import { chat, count, expectCareError, mail, makeRig, type Rig } from './dispatch-test-kit.js';

let rig: Rig;
afterEach(() => rig?.close());

describe('idempotent creation (AC-018)', () => {
  it('same clientRequestId + same payload returns the same intent, one row, one token', () => {
    rig = makeRig();
    const input = { conversationId: rig.conversation.id, clientRequestId: 'req-0001', actor: 'manual' as const, content: chat('hi') };
    const first = rig.serviceA.enqueue(input);
    // a second process handle repeats the request
    const second = rig.serviceB.enqueue(input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.intent.id).toBe(first.intent.id);
    expect(second.intent.adapterRetryToken).toBe(first.intent.adapterRetryToken);
    expect(count(rig.fx.a, 'care_delivery_intents')).toBe(1);
    expect(first.intent.status).toBe('pending');
  });

  it('same clientRequestId with a different payload is a 409 and leaves the original untouched', async () => {
    rig = makeRig();
    const base = { conversationId: rig.conversation.id, clientRequestId: 'req-0002', actor: 'manual' as const };
    const first = rig.serviceA.enqueue({ ...base, content: chat('original') });
    await expectCareError(() => rig.serviceA.enqueue({ ...base, content: chat('changed') }), 'DUPLICATE_REQUEST_PAYLOAD_MISMATCH', 409);
    expect(rig.serviceA.get(first.intent.id)!.payload.text).toBe('original');
    expect(count(rig.fx.a, 'care_delivery_intents')).toBe(1);
  });

  it('the same key on another account is an independent request', () => {
    rig = makeRig();
    const other = rig.addAccount();
    const a = rig.serviceA.enqueue({ conversationId: rig.conversation.id, clientRequestId: 'shared-key', actor: 'manual', content: chat('x') });
    const b = rig.serviceA.enqueue({ conversationId: other.conversation.id, clientRequestId: 'shared-key', actor: 'manual', content: chat('x') });
    expect(b.created).toBe(true);
    expect(b.intent.id).not.toBe(a.intent.id);
  });

  it('the target is derived from the stored conversation; a caller cannot redirect it', async () => {
    rig = makeRig();
    const other = rig.addAccount();
    const { intent } = rig.serviceA.enqueue({ conversationId: rig.conversation.id, clientRequestId: 'req-0003', actor: 'manual', content: chat('x') });
    expect(intent.accountId).toBe(rig.account.id);
    expect(intent.payload.target.externalConversationKey).toBe(rig.conversation.externalKey);
    // a conversation of account B named together with account A is refused
    await expectCareError(
      () => rig.serviceA.enqueue({ accountId: rig.account.id, conversationId: other.conversation.id, clientRequestId: 'req-0004', actor: 'manual', content: chat('x') }),
      'INVALID_TARGET',
    );
    // chat content cannot go out of an email account, email content not out of a chat account
    const mailbox = rig.addAccount('email');
    await expectCareError(
      () => rig.serviceA.enqueue({ conversationId: mailbox.conversation.id, clientRequestId: 'req-0005', actor: 'manual', content: chat('x') }),
      'INVALID_TARGET',
    );
    await expectCareError(
      () => rig.serviceA.enqueue({ conversationId: rig.conversation.id, clientRequestId: 'req-0006', actor: 'manual', content: mail() }),
      'INVALID_TARGET',
    );
    await expectCareError(
      () =>
        rig.serviceA.enqueue({
          conversationId: mailbox.conversation.id,
          clientRequestId: 'req-0007',
          actor: 'manual',
          content: mail('x', ['not-an-address']),
        }),
      'INVALID_TARGET',
    );
  });

  it('a reply must answer a message of the same conversation; the native ID is baked into the target', async () => {
    rig = makeRig();
    const inbound = rig.fx.ingestA.ingestNormalizedMessage(chatMessage(rig.account, { nativeMessageId: 'native-in-1' }));
    const ok = rig.serviceA.enqueue({
      conversationId: rig.conversation.id,
      clientRequestId: 'req-0008',
      actor: 'manual',
      content: { kind: 'chat', text: 'answer', replyToMessageId: inbound.messageId },
    });
    expect(ok.intent.payload.target.replyToMessageId).toBe('native-in-1');
    expect(ok.intent.replyMessageId).toBe(inbound.messageId);

    const other = rig.addAccount();
    const foreign = rig.fx.ingestA.ingestNormalizedMessage(chatMessage(other.account, { nativeMessageId: 'native-in-2' }));
    await expectCareError(
      () =>
        rig.serviceA.enqueue({
          conversationId: rig.conversation.id,
          clientRequestId: 'req-0009',
          actor: 'manual',
          content: { kind: 'chat', text: 'answer', replyToMessageId: foreign.messageId },
        }),
      'INVALID_TARGET',
    );
  });

  it('text, recipients and BCC are encrypted at rest and BCC never reaches shared message metadata', () => {
    rig = makeRig({ channel: 'email', capabilities: { bcc: true } });
    const { intent } = rig.serviceA.enqueue({
      conversationId: rig.conversation.id,
      clientRequestId: 'req-0010',
      actor: 'manual',
      content: mail('SECRET-BODY-xyz', ['buyer-visible@example.com'], { bcc: ['hidden-bcc@example.com'] }),
    });
    const dump = dumpCareTables(rig.fx.a);
    expect(dump).not.toContain('SECRET-BODY-xyz');
    expect(dump).not.toContain('buyer-visible@example.com');
    expect(dump).not.toContain('hidden-bcc@example.com');
    expect(rig.serviceA.get(intent.id)!.payload).toMatchObject({ bcc: ['hidden-bcc@example.com'] });
    // the client-facing DTO never carries text, recipients, token or BCC
    expect(JSON.stringify(toCareOutboxDto(intent))).not.toMatch(/SECRET-BODY|hidden-bcc|care-/);
  });
});

describe('draft -> approve (AC-019)', () => {
  it('approves exactly the reviewed revision; a stale approval is a 409 and never sends the older text', async () => {
    rig = makeRig();
    const { intent: draft } = rig.serviceA.createDraft({ conversationId: rig.conversation.id, actor: 'approved', content: chat('v1'), contextRevision: 3 });
    expect(draft.status).toBe('draft');
    expect(draft.payloadRevision).toBe(1);

    const edited = rig.serviceA.editDraft(draft.id, { expectedRevision: 1, content: chat('v2') });
    expect(edited.payloadRevision).toBe(2);

    // the reviewer looked at revision 1
    const err = await expectCareError(() => rig.serviceB.approveDraft(draft.id, { expectedRevision: 1 }), 'STALE_REVISION', 409);
    expect(err.details).toMatchObject({ currentRevision: 2 });
    expect(rig.serviceA.get(draft.id)!.status).toBe('draft');

    const approved = rig.serviceA.approveDraft(draft.id, { expectedRevision: 2, approvedBy: 'alice' });
    expect(approved.status).toBe('pending');
    expect(approved.approvedRevision).toBe(2);
    expect(approved.payload.text).toBe('v2');
    expect(approved.actor).toBe('approved');
    expect(approved.approvedBy).toBe('alice');

    // repeating the approval of the same revision is idempotent
    const again = rig.serviceB.approveDraft(draft.id, { expectedRevision: 2 });
    expect(again.id).toBe(approved.id);
    expect(count(rig.fx.a, 'care_delivery_intents')).toBe(1);
  });

  it('a stale edit is a 409; an edit after approval returns the intent to draft and needs a fresh approval', async () => {
    rig = makeRig();
    const { intent: draft } = rig.serviceA.createDraft({ conversationId: rig.conversation.id, actor: 'approved', content: chat('v1') });
    await expectCareError(() => rig.serviceA.editDraft(draft.id, { expectedRevision: 5, content: chat('x') }), 'STALE_REVISION', 409);

    rig.serviceA.approveDraft(draft.id, { expectedRevision: 1 });
    const edited = rig.serviceA.editDraft(draft.id, { expectedRevision: 1, content: chat('v2 after approval') });
    expect(edited.status).toBe('draft');
    expect(edited.approvedRevision).toBeNull();
    expect(edited.payloadRevision).toBe(2);
    await expectCareError(() => rig.serviceA.approveDraft(draft.id, { expectedRevision: 1 }), 'STALE_REVISION', 409);
    expect(rig.serviceA.approveDraft(draft.id, { expectedRevision: 2 }).status).toBe('pending');
  });

  it('a changed conversation context makes the approval stale (re-review)', async () => {
    rig = makeRig();
    const { intent: draft } = rig.serviceA.createDraft({ conversationId: rig.conversation.id, actor: 'approved', content: chat('x'), contextRevision: 4 });
    await expectCareError(() => rig.serviceA.approveDraft(draft.id, { expectedRevision: 1, currentContextRevision: 5 }), 'STALE_REVISION', 409);
    expect(rig.serviceA.approveDraft(draft.id, { expectedRevision: 1, currentContextRevision: 4 }).status).toBe('pending');
  });

  it('discard ends a draft; it cannot be approved afterwards', async () => {
    rig = makeRig();
    const { intent: draft } = rig.serviceA.createDraft({ conversationId: rig.conversation.id, actor: 'approved', content: chat('x') });
    expect(rig.serviceA.discardDraft(draft.id).status).toBe('discarded');
    expect(rig.serviceA.discardDraft(draft.id).status).toBe('discarded');
    await expectCareError(() => rig.serviceA.approveDraft(draft.id, { expectedRevision: 1 }), 'CONFIGURATION_CONFLICT', 409);
  });

  it('cancel is idempotent and refuses to claim a recall for something that is not pending', () => {
    rig = makeRig();
    const { intent } = rig.serviceA.enqueue({ conversationId: rig.conversation.id, clientRequestId: 'req-0011', actor: 'manual', content: chat('x') });
    const cancelled = rig.serviceA.cancel(intent.id);
    expect(cancelled).toMatchObject({ cancelled: true, status: 'cancelled', hint: 'cancelled' });
    expect(rig.serviceB.cancel(intent.id).cancelled).toBe(true);
    // a draft is discarded, not cancelled
    const { intent: draft } = rig.serviceA.createDraft({ conversationId: rig.conversation.id, actor: 'approved', content: chat('d') });
    expect(rig.serviceA.cancel(draft.id)).toMatchObject({ cancelled: false, hint: 'not_cancellable' });
  });
});

describe('reply port (api/ports.ts CareReplyPort)', () => {
  it('202-style acceptance: duplicate request returns the same intent; stale revision only blocks NEW requests', async () => {
    rig = makeRig();
    const port = createCareReplyPort({ service: rig.serviceA, stores: rig.storesA });
    const request = {
      clientRequestId: 'port-req-0001',
      conversationId: rig.conversation.id,
      accountId: rig.account.id,
      channel: 'zalo' as const,
      purpose: 'care' as const,
      actor: 'manual' as const,
      text: 'hello',
      target: { kind: 'chat' as const, externalConversationKey: rig.conversation.externalKey },
      expectedConversationRevision: rig.conversation.revision,
    };
    const first = await port.submitReply(request);
    expect(first.duplicate).toBe(false);
    expect(first.intent.status).toBe('pending');
    // the conversation moves on (new inbound), then the client retries the SAME request
    rig.fx.ingestA.ingestNormalizedMessage(chatMessage(rig.account));
    const retry = await port.submitReply(request);
    expect(retry.duplicate).toBe(true);
    expect(retry.intent.id).toBe(first.intent.id);
    // a NEW request based on the old view is stale
    await expectCareError(() => port.submitReply({ ...request, clientRequestId: 'port-req-0002' }), 'STALE_REVISION', 409);
    // a different payload under the old key is a 409 mismatch
    await expectCareError(() => port.submitReply({ ...request, text: 'other' }), 'DUPLICATE_REQUEST_PAYLOAD_MISMATCH', 409);
    // a target that is not the stored conversation is refused
    await expectCareError(
      () => port.submitReply({ ...request, clientRequestId: 'port-req-0003', expectedConversationRevision: undefined, target: { kind: 'chat', externalConversationKey: 'peer:other' } }),
      'INVALID_TARGET',
    );
    expect(await port.getOutbox('unknown')).toBeNull();
    expect(await port.cancel('unknown')).toBeNull();
    expect((await port.cancel(first.intent.id))!.status).toBe('cancelled');
    await expectCareError(() => port.reconcile(first.intent.id), 'UNSUPPORTED_CAPABILITY');
  });
});

describe('draft sink (agent-ports.ts DraftSink)', () => {
  const proposal = (rigRef: Rig, over: Partial<DraftProposal> = {}, delivery: Partial<DraftProposal['delivery']> = {}): DraftProposal => ({
    idempotencyKey: 'run-1',
    runId: 'run-1',
    target: { accountId: rigRef.account.id, conversationId: rigRef.conversation.id, channel: rigRef.account.channel },
    triggerMessageId: 'unused',
    contextRevision: 2,
    policyRevision: 'policy-v7',
    agentId: 'agent-main',
    origin: 'agent',
    text: 'Dạ em chào anh',
    replies: [{ replyToMessageId: null, text: 'Dạ em chào anh' }],
    signature: '-- Shop',
    needsReview: false,
    reviewReason: null,
    delivery: { requested: 'draft', effective: 'draft', adjustment: null, autoDelay: null, reasonCodes: [], ...delivery },
    ...over,
  });

  it('a draft proposal is stored once per run, signed once, and waits for approval', () => {
    rig = makeRig();
    const sink = createCareDraftSink(rig.serviceA, rig.storesA);
    const asContract: DraftSink = sink; // the Agent Care turn consumes the agent-ports contract
    expect(asContract).toBe(sink);
    const first = sink.propose(proposal(rig));
    const again = sink.propose(proposal(rig)); // a crashed turn proposing twice
    expect(again.draftRef).toBe(first.draftRef);
    expect(count(rig.fx.a, 'care_delivery_intents')).toBe(1);
    const intent = rig.serviceA.get(first.draftRef)!;
    expect(intent).toMatchObject({ status: 'draft', actor: 'approved', policyRevision: 'policy-v7', contextRevision: 2, sourceRunId: 'run-1' });
    expect(intent.payload.text).toBe('Dạ em chào anh\n\n--\n-- Shop');
    // a text that already ends with the signature is not signed twice
    const signed = sink.propose(proposal(rig, { idempotencyKey: 'run-2', runId: 'run-2', text: 'Hi\n\n-- Shop' }));
    expect(rig.serviceA.get(signed.draftRef)!.payload.text).toBe('Hi\n\n-- Shop');
  });

  it('effective auto becomes a pending auto intent after its delay; needsReview always stays a draft', () => {
    rig = makeRig();
    const sink = createCareDraftSink(rig.serviceA, rig.storesA, { now: () => 1_000_000, random: () => 0.5 });
    const auto = sink.propose(
      proposal(rig, { idempotencyKey: 'run-3', runId: 'run-3' }, { requested: 'auto', effective: 'auto', autoDelay: { minSeconds: 10, maxSeconds: 30 } }),
    );
    const intent = rig.serviceA.get(auto.draftRef)!;
    expect(intent).toMatchObject({ status: 'pending', actor: 'auto' });
    expect(intent.nextAttemptAtMs).toBe(1_000_000 + 20_000);

    const review = sink.propose(
      proposal(rig, { idempotencyKey: 'run-4', runId: 'run-4', needsReview: true, reviewReason: 'keyword' }, { requested: 'auto', effective: 'auto' }),
    );
    expect(rig.serviceA.get(review.draftRef)!.status).toBe('draft');
  });

  it('the model cannot name another conversation/account/channel', () => {
    rig = makeRig();
    const other = rig.addAccount();
    const sink = createCareDraftSink(rig.serviceA, rig.storesA);
    expect(() => sink.propose(proposal(rig, { target: { accountId: other.account.id, conversationId: rig.conversation.id, channel: 'zalo' } }))).toThrow(CareError);
    expect(() => sink.propose(proposal(rig, { target: { accountId: rig.account.id, conversationId: rig.conversation.id, channel: 'telegram' } }))).toThrow(CareError);
  });

  it('an email draft replies to the triggering mail with Re: subject and the sender as the only recipient', () => {
    rig = makeRig({ channel: 'email' });
    const trigger = rig.fx.ingestA.ingestNormalizedMessage(
      emailMessage(rig.account, { externalConversationKey: rig.conversation.externalKey, nativeMessageId: 'g-trigger' }),
    );
    const sink = createCareDraftSink(rig.serviceA, rig.storesA);
    const { draftRef } = sink.propose(proposal(rig, { triggerMessageId: trigger.messageId! }));
    const intent = rig.serviceA.get(draftRef)!;
    expect(intent.payload).toMatchObject({ kind: 'email', target: { to: ['buyer@example.com'], subject: 'Re: Hello', replyToMessageId: 'g-trigger' } });
  });
});

describe('signature is appended exactly once', () => {
  let erig: ReturnType<typeof makeZaloLikeEmailRig>;
  afterEach(() => erig?.close());
  const sig = 'Trân trọng, Shop A';

  it('reply port: a text that already carries the signature is not doubled; the hook applies to email only', async () => {
    erig = makeZaloLikeEmailRig(sig);
    const port = createCareReplyPort({ service: erig.service, stores: erig.storesA });
    const base = {
      conversationId: erig.conversation.id,
      accountId: erig.account.id,
      channel: 'email' as const,
      purpose: 'care' as const,
      actor: 'manual' as const,
      target: { kind: 'email' as const, externalConversationKey: erig.conversation.externalKey, to: ['buyer@example.com'], subject: 'Re: Hello' },
    };
    const plain = await port.submitReply({ ...base, clientRequestId: 'sig-req-0001', text: 'Dạ vâng ạ' });
    expect(erig.service.get(plain.intent.id)!.payload.text).toBe(`Dạ vâng ạ\n\n--\n${sig}`);
    const signed = await port.submitReply({ ...base, clientRequestId: 'sig-req-0002', text: `Dạ vâng ạ\n\n--\n${sig}` });
    expect(erig.service.get(signed.intent.id)!.payload.text).toBe(`Dạ vâng ạ\n\n--\n${sig}`);
    // an idempotent replay of the first request stays the same intent (the hash covers the final text)
    expect((await port.submitReply({ ...base, clientRequestId: 'sig-req-0001', text: 'Dạ vâng ạ' })).duplicate).toBe(true);
  });

  it('draft sink -> edit -> approve never doubles the signature', () => {
    erig = makeZaloLikeEmailRig(sig);
    const trigger = erig.fx.ingestA.ingestNormalizedMessage(
      emailMessage(erig.account, { externalConversationKey: erig.conversation.externalKey, nativeMessageId: 'g-sig' }),
    );
    const sink = createCareDraftSink(erig.service, erig.storesA);
    const { draftRef } = sink.propose({
      idempotencyKey: 'run-sig',
      runId: 'run-sig',
      target: { accountId: erig.account.id, conversationId: erig.conversation.id, channel: 'email' },
      triggerMessageId: trigger.messageId!,
      contextRevision: 1,
      policyRevision: 'p1',
      agentId: 'agent-main',
      origin: 'agent',
      text: 'Dạ em gửi báo giá',
      replies: [{ replyToMessageId: null, text: 'Dạ em gửi báo giá' }],
      signature: sig,
      needsReview: false,
      reviewReason: null,
      delivery: { requested: 'draft', effective: 'draft', adjustment: null, autoDelay: null, reasonCodes: [] },
    });
    const once = `Dạ em gửi báo giá\n\n--\n${sig}`;
    expect(erig.service.get(draftRef)!.payload.text).toBe(once);
    // the operator edits the body but keeps the signature in the box; and a variant without it
    const edited = erig.service.editDraft(draftRef, { expectedRevision: 1, content: { kind: 'email', text: `Dạ em gửi báo giá (đã sửa)\n\n--\n${sig}`, to: ['buyer@example.com'], subject: 'Re: Hello' } });
    expect(edited.payload.text.split(sig).length - 1).toBe(1);
    const plain = erig.service.editDraft(draftRef, { expectedRevision: 2, content: { kind: 'email', text: 'Dạ bản mới', to: ['buyer@example.com'], subject: 'Re: Hello' } });
    expect(plain.payload.text).toBe(`Dạ bản mới\n\n--\n${sig}`);
    const approved = erig.service.approveDraft(draftRef, { expectedRevision: 3 });
    expect(approved.payload.text.split(sig).length - 1).toBe(1);
  });

  it('chat accounts never get a mail signature from the hook', () => {
    const chatRig = makeRig({});
    try {
      const svc = new CareOutboxService(chatRig.fx.a, chatRig.storesA, { signatureFor: () => sig });
      const { intent } = svc.enqueue({ conversationId: chatRig.conversation.id, clientRequestId: 'sig-chat-0001', actor: 'manual', content: chat('hi') });
      expect(intent.payload.text).toBe('hi');
    } finally {
      chatRig.close();
    }
  });
});

function makeZaloLikeEmailRig(signature: string) {
  const base = makeRig({ channel: 'email' });
  const service = new CareOutboxService(base.fx.a, base.storesA, { signatureFor: () => signature });
  return Object.assign(base, { service });
}
