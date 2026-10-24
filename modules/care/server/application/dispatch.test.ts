import { afterEach, describe, expect, it } from 'vitest';
import { CareError } from '../../../_lib/care-kit/errors.js';
import { chatMessage, dumpCareTables } from '../test-fixtures.js';
import type { DispatchGuard, DispatchGuardContext } from './dispatch.js';
import { chat, count, mail, makeRig, ScriptedConnector, type Rig } from './dispatch-test-kit.js';

let rig: Rig;
afterEach(() => rig?.close());

const enqueue = (r: Rig, key: string, text = 'hello customer', actor: 'manual' | 'auto' | 'approved' = 'manual') =>
  r.serviceA.enqueue({ conversationId: r.conversation.id, clientRequestId: key, actor, content: chat(text) }).intent;

const statusOf = (r: Rig, id: string) => r.serviceA.get(id)!;

describe('success path (AC-018, AC-024)', () => {
  it('sends exactly once with the persisted token and books one canonical message + event in one go', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'req-ok-0001');
    const [report] = await rig.dispatcher('A').dispatchDue();

    expect(report).toMatchObject({ intentId: intent.id, result: 'sent', rpc: true });
    expect(rig.connector.providerSendCount).toBe(1);
    const sent = statusOf(rig, intent.id);
    expect(sent.status).toBe('sent');
    expect(sent.receiptLevel).toBe('accepted');

    // the connector saw the token that was persisted on the intent and on the attempt
    expect(rig.connector.dispatchedCommands[0]).toMatchObject({
      clientRequestId: 'req-ok-0001',
      adapterRetryToken: intent.adapterRetryToken,
      ownerEpoch: rig.account.ownerEpoch,
      actor: 'manual',
    });
    const attempts = rig.storesA.outbox.listAttempts(intent.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ requestToken: intent.adapterRetryToken, outcome: 'accepted', receiptLevel: 'accepted', attemptNo: 1 });

    // canonical outbound message, linked to the intent and the conversation projection
    const message = rig.storesA.messages.getMessage(sent.canonicalMessageId!)!;
    expect(message).toMatchObject({ direction: 'out', senderRole: 'operator', text: 'hello customer', liveObserved: true });
    expect(message.nativeMessageId).toBe(attempts[0].nativeMessageId);
    expect(rig.storesA.conversations.getConversation(rig.conversation.id)!.lastMessageId).toBe(message.id);

    // ledger event is ID-only
    const events = rig.storesA.events.listEventsSince(0, 100).filter((e) => e.eventType.startsWith('outbox.'));
    expect(events.map((e) => e.eventType)).toEqual(['outbox.enqueued', 'outbox.sent']);
    expect(JSON.stringify(events)).not.toContain('hello customer');

    // nothing more happens
    expect(await rig.dispatcher('A').dispatchDue()).toEqual([]);
    expect(rig.connector.providerSendCount).toBe(1);
  });

  it('a later provider echo of the same message is the same canonical message', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'req-ok-0002');
    await rig.dispatcher('A').dispatchDue();
    const sent = statusOf(rig, intent.id);
    const native = rig.storesA.messages.getMessage(sent.canonicalMessageId!)!.nativeMessageId;

    const echo = rig.fx.ingestA.ingestNormalizedMessage(
      chatMessage(rig.account, { direction: 'out', senderRole: 'self', nativeMessageId: native, text: 'hello customer', externalConversationKey: rig.conversation.externalKey }),
    );
    expect(echo.outcome).toBe('duplicate_ignored');
    expect(echo.messageId).toBe(sent.canonicalMessageId);
    expect(count(rig.fx.a, 'care_messages', "direction = 'out'")).toBe(1);
  });

  it('email path: one RPC, BCC reaches the connector but never the shared message or the DB in clear', async () => {
    rig = makeRig({ channel: 'email', capabilities: { bcc: true } });
    const intent = rig.serviceA.enqueue({
      conversationId: rig.conversation.id,
      clientRequestId: 'req-mail-0001',
      actor: 'manual',
      content: mail('mail body', ['buyer@example.com'], { bcc: ['audit-copy@example.com'] }),
    }).intent;
    const [report] = await rig.dispatcher('A').dispatchDue();
    expect(report.result).toBe('sent');
    expect(rig.connector.providerSendCount).toBe(1);
    expect(rig.connector.dispatchedCommands[0]).toMatchObject({ kind: 'email', bcc: ['audit-copy@example.com'] });
    const message = rig.storesA.messages.getMessage(statusOf(rig, intent.id).canonicalMessageId!)!;
    expect(JSON.stringify(message.metadata)).not.toContain('audit-copy');
    expect(message.metadata).toMatchObject({ type: 'email', to: ['buyer@example.com'], subject: 'Re: Hello' });
    expect(dumpCareTables(rig.fx.a)).not.toContain('audit-copy@example.com');
  });

  it('auto intents are sent as agent messages', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'req-auto-0001', 'auto text', 'auto');
    await rig.dispatcher('A').dispatchDue();
    expect(rig.storesA.messages.getMessage(statusOf(rig, intent.id).canonicalMessageId!)!.senderRole).toBe('agent');
  });
});

describe('guards run before the RPC for every actor (AC-021)', () => {
  it('manual, approved and auto all go through the guard; a denial leaves the intent unsent with a reason', async () => {
    rig = makeRig();
    const seen: string[] = [];
    const guard: DispatchGuard = {
      evaluate: (ctx: DispatchGuardContext) => {
        seen.push(ctx.intent.actor);
        expect(ctx.command.adapterRetryToken).toBe(ctx.intent.adapterRetryToken);
        return { allow: false, action: 'review', reason: 'ELIGIBILITY_REVOKED' };
      },
    };
    const ids = [enqueue(rig, 'g-manual-0001', 'a', 'manual').id];
    const d = rig.dispatcher('A', { guard });
    await d.dispatchDue();
    ids.push(enqueue(rig, 'g-approved-01', 'b', 'approved').id);
    await d.dispatchDue();
    ids.push(enqueue(rig, 'g-auto-000001', 'c', 'auto').id);
    await d.dispatchDue();

    expect(seen).toEqual(['manual', 'approved', 'auto']);
    expect(rig.connector.providerSendCount).toBe(0);
    expect(rig.connector.dispatchedCommands).toHaveLength(0);
    for (const id of ids) {
      const intent = statusOf(rig, id);
      expect(intent).toMatchObject({ status: 'needs_review', statusReason: 'ELIGIBILITY_REVOKED', attemptCount: 0 });
      expect(rig.storesA.outbox.listAttempts(id)).toHaveLength(0);
      expect(intent.canonicalMessageId).toBeNull();
    }
    // nothing is silently retried
    expect(await d.dispatchDue()).toEqual([]);
  });

  it('a stale auto intent is cancelled by the guard and never sent', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'g-stale-00001', 'x', 'auto');
    const guard: DispatchGuard = { evaluate: () => ({ allow: false, action: 'cancel', reason: 'HUMAN_REPLIED' }) };
    const [report] = await rig.dispatcher('A', { guard }).dispatchDue();
    expect(report).toMatchObject({ result: 'cancelled', rpc: false, reason: 'HUMAN_REPLIED' });
    expect(statusOf(rig, intent.id)).toMatchObject({ status: 'cancelled', statusReason: 'HUMAN_REPLIED' });
    expect(rig.connector.providerSendCount).toBe(0);
  });

  it('cooldown/quota deferral is persisted in next_attempt_at and survives a new worker handle', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'g-cooldown-01');
    const dueAt = rig.clock.t + 120_000;
    let cooling = true;
    const guard: DispatchGuard = { evaluate: () => (cooling ? { allow: false, action: 'defer', reason: 'COOLDOWN', retryAtMs: dueAt } : { allow: true }) };

    const [report] = await rig.dispatcher('A', { guard }).dispatchDue();
    expect(report).toMatchObject({ result: 'deferred', reason: 'COOLDOWN', rpc: false });
    expect(statusOf(rig, intent.id)).toMatchObject({ status: 'pending', statusReason: 'COOLDOWN', nextAttemptAtMs: dueAt });

    // a different process handle sees the persisted cooldown and does nothing before it is due
    rig.clock.t += 60_000;
    expect(await rig.dispatcher('B', { guard }).dispatchDue()).toEqual([]);
    expect(rig.connector.providerSendCount).toBe(0);

    cooling = false;
    rig.clock.t = dueAt;
    const [after] = await rig.dispatcher('B', { guard }).dispatchDue();
    expect(after.result).toBe('sent');
    expect(rig.connector.providerSendCount).toBe(1);
  });

  it('a guard that throws fails closed (deferred, nothing sent)', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'g-throws-0001');
    const guard: DispatchGuard = {
      evaluate: () => {
        throw new Error('policy store unavailable');
      },
    };
    const [report] = await rig.dispatcher('A', { guard }).dispatchDue();
    expect(report).toMatchObject({ result: 'deferred', reason: 'GUARD_ERROR' });
    expect(statusOf(rig, intent.id).status).toBe('pending');
    expect(rig.connector.providerSendCount).toBe(0);
  });

  it('revoked capability or a target that no longer matches the conversation is refused before the RPC', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'g-caps-000001');
    rig.connector.setCapabilities({ text: false });
    const [report] = await rig.dispatcher('A').dispatchDue();
    expect(report).toMatchObject({ result: 'needs_review', reason: 'UNSUPPORTED_CAPABILITY' });
    expect(statusOf(rig, intent.id).status).toBe('needs_review');
    expect(rig.connector.dispatchedCommands).toHaveLength(0);

    // tamper with the stored conversation key: the fixed target no longer matches
    rig.connector.setCapabilities({ text: true });
    const second = enqueue(rig, 'g-target-00001');
    rig.fx.a.prepare('UPDATE care_conversations SET external_key = ? WHERE id = ?').run('peer:moved', rig.conversation.id);
    const [moved] = await rig.dispatcher('A').dispatchDue();
    expect(moved).toMatchObject({ result: 'needs_review', reason: 'TARGET_MISMATCH' });
    expect(statusOf(rig, second.id).status).toBe('needs_review');
    expect(rig.connector.dispatchedCommands).toHaveLength(0);
  });

  it('a closed send gate means nothing is claimed; a gate closing between claim and attempt means no RPC', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'g-gate-000001');
    rig.storesA.accounts.updateAccountFlags(rig.account.id, { sendEnabled: false });
    expect(await rig.dispatcher('A').dispatchDue()).toEqual([]);
    expect(rig.connector.providerSendCount).toBe(0);

    rig.storesA.accounts.updateAccountFlags(rig.account.id, { sendEnabled: true });
    const guard: DispatchGuard = {
      evaluate: () => {
        rig.storesB.accounts.updateAccountFlags(rig.account.id, { sendEnabled: false }); // operator flips the switch mid-flight
        return { allow: true };
      },
    };
    const [report] = await rig.dispatcher('A', { guard }).dispatchDue();
    expect(report).toMatchObject({ result: 'deferred', reason: 'ATTEMPT_FENCED', rpc: false });
    expect(rig.connector.dispatchedCommands).toHaveLength(0);
    expect(rig.storesA.outbox.listAttempts(intent.id)).toHaveLength(0);
    expect(statusOf(rig, intent.id).status).toBe('pending');
  });
});

describe('definite failures (AC-018)', () => {
  it('retryable failure -> retry_wait -> same token on the next attempt -> one provider send', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'f-retry-00001');
    const retryAt = rig.clock.t + 10_000;
    rig.connector.failures.push(new CareError('RATE_LIMITED', 'slow down', 429, { retryAtMs: retryAt }));

    const [first] = await rig.dispatcher('A').dispatchDue();
    expect(first.result).toBe('retry_wait');
    expect(statusOf(rig, intent.id)).toMatchObject({ status: 'retry_wait', nextAttemptAtMs: retryAt, attemptCount: 1 });
    expect(rig.connector.providerSendCount).toBe(0);

    expect(await rig.dispatcher('B').dispatchDue()).toEqual([]); // not due yet

    rig.clock.t = retryAt;
    const [second] = await rig.dispatcher('B').dispatchDue();
    expect(second.result).toBe('sent');
    expect(rig.connector.providerSendCount).toBe(1);

    const attempts = rig.storesA.outbox.listAttempts(intent.id);
    expect(attempts.map((a) => [a.attemptNo, a.outcome])).toEqual([
      [1, 'retryable'],
      [2, 'accepted'],
    ]);
    expect(attempts[0].requestToken).toBe(intent.adapterRetryToken);
    expect(attempts[1].requestToken).toBe(intent.adapterRetryToken);
    expect(rig.connector.dispatchedCommands[0].adapterRetryToken).toBe(intent.adapterRetryToken);
  });

  it('exhausting the attempts ends as failed with a reason, not an endless retry', async () => {
    rig = makeRig();
    const intent = rig.serviceA.enqueue({ conversationId: rig.conversation.id, clientRequestId: 'f-exhaust-001', actor: 'manual', content: chat('x'), maxAttempts: 2 }).intent;
    for (let i = 0; i < 2; i += 1) {
      rig.connector.failures.push(new CareError('RATE_LIMITED', 'slow down', 429));
      await rig.dispatcher('A').dispatchDue();
      rig.clock.t += 10 * 60_000;
    }
    expect(statusOf(rig, intent.id)).toMatchObject({ status: 'failed', statusReason: 'RETRIES_EXHAUSTED', attemptCount: 2 });
    expect(await rig.dispatcher('A').dispatchDue()).toEqual([]);
    expect(rig.connector.providerSendCount).toBe(0);
  });

  it('terminal rejection fails the intent for good', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'f-terminal-001');
    rig.connector.setBehavior('terminal-rejection');
    const [report] = await rig.dispatcher('A').dispatchDue();
    expect(report.result).toBe('failed');
    expect(statusOf(rig, intent.id)).toMatchObject({ status: 'failed', statusReason: 'TERMINAL_REJECTION' });
    rig.clock.t += 3_600_000;
    expect(await rig.dispatcher('A').dispatchDue()).toEqual([]);
    expect(rig.connector.dispatchedCommands).toHaveLength(1);
  });
});

describe('lost acknowledgement (AC-024)', () => {
  it('accepted-without-ack -> uncertain; the worker never resends; reconcile maps the ORIGINAL attempt to sent', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'u-lost-000001');
    rig.connector.setBehavior('accepted-lost-ack');
    const [report] = await rig.dispatcher('A').dispatchDue();
    expect(report.result).toBe('uncertain');
    expect(rig.connector.providerSendCount).toBe(1);
    expect(statusOf(rig, intent.id)).toMatchObject({ status: 'uncertain', canonicalMessageId: null });

    // ticking, a restart, a second worker: nothing is sent again, nothing is invented
    rig.clock.t += 3_600_000;
    rig.connector.setBehavior('normal');
    expect(await rig.dispatcher('A').dispatchDue()).toEqual([]);
    expect(await rig.dispatcher('B').dispatchDue()).toEqual([]);
    expect(rig.connector.providerSendCount).toBe(1);

    const { intent: reconciled, evidence } = await rig.dispatcher('B').reconcile(intent.id);
    expect(evidence).toBe('accepted');
    expect(reconciled.status).toBe('sent');
    expect(rig.connector.reconciledCommands[0]).toMatchObject({ adapterRetryToken: intent.adapterRetryToken, clientRequestId: 'u-lost-000001' });
    expect(rig.connector.providerSendCount).toBe(1);
    const attempts = rig.storesA.outbox.listAttempts(intent.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: 'accepted', nativeMessageId: rig.connector.getDelivery(rig.account.id, 'u-lost-000001')!.nativeMessageId });
    expect(rig.storesA.messages.getMessage(reconciled.canonicalMessageId!)!.nativeMessageId).toBe(attempts[0].nativeMessageId);
    expect(count(rig.fx.a, 'care_messages', "direction = 'out'")).toBe(1);
  });

  it('no verified dedupe (Zalo-like) and no provider evidence -> manual review, never an automatic resend', async () => {
    const zalo = new ScriptedConnector('zalo-like', 'zalo', { sendDedupe: false });
    rig = makeRig();
    rig.connector.reconcileEvidence = false;
    // swap in the no-dedupe connector for this account
    const dispatcher = rig.dispatcher('A', { resolveConnector: () => zalo });
    const intent = enqueue(rig, 'u-zalo-000001');
    zalo.setBehavior('accepted-lost-ack');
    expect((await dispatcher.dispatchDue())[0].result).toBe('uncertain');
    zalo.setBehavior('normal');
    zalo.reconcileEvidence = false;

    const { intent: after, evidence } = await dispatcher.reconcile(intent.id);
    expect(evidence).toBe('none');
    expect(after).toMatchObject({ status: 'needs_review', statusReason: 'RECONCILE_NO_EVIDENCE' });
    rig.clock.t += 3_600_000;
    expect(await dispatcher.dispatchDue()).toEqual([]);
    expect(zalo.providerSendCount).toBe(1);
    expect(rig.serviceA.resolveReview(intent.id, 'abandon')).toMatchObject({ status: 'failed', statusReason: 'REVIEW_ABANDONED' });
  });

  it('a dedupe connector with no evidence may retry with the SAME token and the provider does not double-send', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'u-dedupe-0001');
    rig.connector.setBehavior('accepted-lost-ack');
    await rig.dispatcher('A').dispatchDue();
    rig.connector.setBehavior('normal');
    rig.connector.reconcileEvidence = false; // the provider cannot tell us, but its token ledger still dedupes

    const { intent: waiting, evidence } = await rig.dispatcher('A').reconcile(intent.id);
    expect(evidence).toBe('none');
    expect(waiting).toMatchObject({ status: 'retry_wait', statusReason: 'RECONCILE_NO_EVIDENCE_SAME_TOKEN' });

    const [retry] = await rig.dispatcher('A').dispatchDue();
    expect(retry.result).toBe('sent');
    expect(rig.connector.providerSendCount).toBe(1); // the provider returned its first acceptance
    const attempts = rig.storesA.outbox.listAttempts(intent.id);
    expect(attempts.map((a) => a.requestToken)).toEqual([intent.adapterRetryToken, intent.adapterRetryToken]);
    expect(rig.connector.dispatchCalls.map((c) => c.adapterRetryToken)).toEqual([intent.adapterRetryToken, intent.adapterRetryToken]);
    expect(rig.connector.dispatchedCommands).toHaveLength(1);
  });

  it('a reconcile that cannot reach the provider leaves the intent uncertain', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'u-unreach-001');
    rig.connector.setBehavior('accepted-lost-ack');
    await rig.dispatcher('A').dispatchDue();
    rig.connector.reconcile = async () => {
      throw new Error('network down');
    };
    const { intent: after, evidence } = await rig.dispatcher('A').reconcile(intent.id);
    expect(evidence).toBe('unavailable');
    expect(after.status).toBe('uncertain');
    // reconcile of an intent that is not uncertain is a no-op
    const draft = rig.serviceA.createDraft({ conversationId: rig.conversation.id, actor: 'approved', content: chat('y') }).intent;
    expect((await rig.dispatcher('A').reconcile(draft.id)).evidence).toBe('not_applicable');
  });
});
