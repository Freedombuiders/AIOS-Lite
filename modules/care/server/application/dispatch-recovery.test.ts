import { afterEach, describe, expect, it } from 'vitest';
import { chat, count, makeRig, type Rig } from './dispatch-test-kit.js';

let rig: Rig;
afterEach(() => rig?.close());

const enqueue = (r: Rig, key: string, conversationId = r.conversation.id) =>
  r.serviceA.enqueue({ conversationId, clientRequestId: key, actor: 'manual', content: chat(`text ${key}`) }).intent;
const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

describe('crash after the provider accepted (AC-024)', () => {
  it('a dead worker leaves an open attempt; recovery makes it uncertain, reconcile confirms, the provider got ONE send', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'r-crash-00001');
    rig.connector.hangAfterAccept = true; // provider accepted, the worker never wrote anything back
    void rig.dispatcher('A', { rpcTimeoutMs: 600_000 }).dispatchDue();
    await tick();

    expect(rig.connector.providerSendCount).toBe(1);
    const inFlight = rig.serviceA.get(intent.id)!;
    expect(inFlight.status).toBe('sending');
    expect(rig.storesA.outbox.getOpenAttempt(intent.id)).not.toBeNull();

    // while the lease is valid nobody touches it
    expect(await rig.dispatcher('B').dispatchDue()).toEqual([]);
    expect(rig.serviceB.get(intent.id)!.status).toBe('sending');
    // a cancel now is honest: the request is underway
    expect(rig.serviceB.cancel(intent.id)).toMatchObject({ cancelled: false, hint: 'request_underway', status: 'sending' });

    // lease expiry is NOT proof the RPC did not happen: it is uncertain, never pending
    rig.clock.t += 31_000;
    rig.connector.hangAfterAccept = false;
    expect(await rig.dispatcher('B').dispatchDue()).toEqual([]);
    expect(rig.serviceB.get(intent.id)).toMatchObject({ status: 'uncertain', statusReason: 'LEASE_EXPIRED_IN_FLIGHT' });
    expect(rig.connector.dispatchCalls).toHaveLength(1);

    const { intent: reconciled, evidence } = await rig.dispatcher('B').reconcile(intent.id);
    expect(evidence).toBe('accepted');
    expect(reconciled.status).toBe('sent');
    expect(rig.connector.providerSendCount).toBe(1);
    expect(rig.connector.dispatchCalls).toHaveLength(1);
    expect(count(rig.fx.a, 'care_messages', "direction = 'out'")).toBe(1);
  });

  it('a restarted worker recovers its own previous leases immediately (no waiting for the clock)', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'r-restart-0001');
    rig.connector.hangAfterAccept = true;
    void rig.dispatcher('A', { rpcTimeoutMs: 600_000 }).dispatchDue();
    await tick();
    rig.connector.hangAfterAccept = false;

    const restarted = rig.dispatcher('A');
    expect(restarted.recover()).toEqual({ uncertain: 1, released: 0 });
    expect(rig.serviceA.get(intent.id)!.status).toBe('uncertain');
    const [report] = await restarted.reconcileAllUncertain();
    expect(report.intent.status).toBe('sent');
    expect(rig.connector.providerSendCount).toBe(1);
  });

  it('a claim that never reached an attempt (no RPC possible) returns to pending after lease expiry', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'r-noattempt-01');
    const [claim] = rig.storesA.outbox.claimDue({ workerId: 'dead-worker', leaseDurationMs: 1_000, nowMs: rig.clock.t });
    expect(claim.intentId).toBe(intent.id);
    expect(rig.serviceA.get(intent.id)!.status).toBe('sending');

    rig.clock.t += 5_000;
    const [report] = await rig.dispatcher('B').dispatchDue();
    expect(report.result).toBe('sent');
    expect(rig.connector.providerSendCount).toBe(1);
  });
});

describe('provider accepted but the bookkeeping transaction fails (AC-024)', () => {
  it('parks the intent as uncertain with the evidence; it never becomes a second send; reconcile finishes it', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'r-dberror-0001');
    rig.fx.a.exec(`CREATE TRIGGER care_test_boom BEFORE INSERT ON care_messages BEGIN SELECT RAISE(ABORT, 'disk full'); END`);

    const [report] = await rig.dispatcher('A').dispatchDue();
    expect(report).toMatchObject({ result: 'parked_after_commit_failure', rpc: true });
    expect(rig.connector.providerSendCount).toBe(1);

    const parked = rig.serviceA.get(intent.id)!;
    expect(parked).toMatchObject({ status: 'uncertain', statusReason: 'COMMIT_FAILED', canonicalMessageId: null });
    const [attempt] = rig.storesA.outbox.listAttempts(intent.id);
    expect(attempt).toMatchObject({ outcome: 'uncertain', errorCode: 'COMMIT_FAILED' });
    // the evidence survived: the provider's own message ID is on the attempt
    expect(attempt.nativeMessageId).toBe(rig.connector.getDelivery(rig.account.id, 'r-dberror-0001')!.nativeMessageId);
    // the failed transaction left no half state: no message, no 'sent' event
    expect(count(rig.fx.a, 'care_messages', "direction = 'out'")).toBe(0);
    expect(rig.storesA.events.listEventsSince(0, 100).some((e) => e.eventType === 'outbox.sent')).toBe(false);

    // restart / ticks do not resend
    rig.clock.t += 3_600_000;
    expect(await rig.dispatcher('A').dispatchDue()).toEqual([]);
    expect(rig.connector.dispatchCalls).toHaveLength(1);

    rig.fx.a.exec('DROP TRIGGER care_test_boom');
    const { intent: done } = await rig.dispatcher('A').reconcile(intent.id);
    expect(done.status).toBe('sent');
    expect(count(rig.fx.a, 'care_messages', "direction = 'out'")).toBe(1);
    expect(rig.connector.providerSendCount).toBe(1);
    expect(rig.connector.reconciledCommands[0].nativeMessageId).toBe(attempt.nativeMessageId);
  });
});

describe('delayed acknowledgement', () => {
  it('times out to uncertain without blocking; the late answer is applied to the SAME attempt (one send)', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'r-delayed-0001');
    rig.connector.setBehavior('delayed-ack');
    const [report] = await rig.dispatcher('A', { rpcTimeoutMs: 20 }).dispatchDue();
    expect(report.result).toBe('uncertain');
    expect(rig.serviceA.get(intent.id)).toMatchObject({ status: 'uncertain', statusReason: 'RPC_TIMEOUT' });

    rig.connector.releaseDelayedAck('r-delayed-0001', rig.account.id);
    await tick();
    const done = rig.serviceA.get(intent.id)!;
    expect(done.status).toBe('sent');
    expect(rig.storesA.outbox.listAttempts(intent.id)).toHaveLength(1);
    expect(rig.connector.providerSendCount).toBe(1);
    expect(count(rig.fx.a, 'care_messages', "direction = 'out'")).toBe(1);
  });

  it('cancel while the request is awaiting its ack is refused honestly, and the ack still lands', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'r-cancelrace-01');
    rig.connector.setBehavior('delayed-ack');
    const running = rig.dispatcher('A', { rpcTimeoutMs: 600_000 }).dispatchDue();
    await tick();

    expect(rig.serviceB.cancel(intent.id)).toMatchObject({ cancelled: false, status: 'sending', hint: 'request_underway' });
    rig.connector.releaseDelayedAck('r-cancelrace-01', rig.account.id);
    const [report] = await running;
    expect(report.result).toBe('sent');
    expect(rig.serviceA.get(intent.id)!.status).toBe('sent');
    expect(rig.serviceB.cancel(intent.id)).toMatchObject({ cancelled: false, hint: 'sent' });
    expect(rig.connector.providerSendCount).toBe(1);
  });
});

describe('owner epoch (AC-020/024)', () => {
  it('a late receipt from an old epoch resolves the original attempt but grants no permission to send more', async () => {
    rig = makeRig();
    const second = rig.storesA.conversations.upsertConversation({ accountId: rig.account.id, externalKey: 'peer:2', kind: 'direct', title: 'Other' });
    const first = enqueue(rig, 'r-epoch-000001');
    const backlog = enqueue(rig, 'r-epoch-backlog', second.id);

    rig.connector.setBehavior('accepted-lost-ack');
    await rig.dispatcher('A').dispatchDue();
    rig.connector.setBehavior('normal');
    expect(rig.serviceA.get(first.id)!.status).toBe('uncertain');
    expect(rig.storesA.outbox.listAttempts(first.id)[0].ownerEpoch).toBe(1);

    // ownership moves on: epoch 2, the connector now serves epoch 2
    expect(rig.storesA.accounts.updateAccountOwnerEpoch(rig.account.id, 'core', 2)).toBe(true);
    rig.connector.activeEpoch = 2;

    // the backlog created under epoch 1 cannot be claimed by the new owner
    expect(await rig.dispatcher('B').dispatchDue()).toEqual([]);
    expect(rig.connector.dispatchCalls).toHaveLength(1);

    // the old attempt's late receipt still maps onto it
    const native = rig.connector.getDelivery(rig.account.id, 'r-epoch-000001')!.nativeMessageId;
    const applied = rig.serviceB.recordReceipt({ accountId: rig.account.id, clientRequestId: 'r-epoch-000001', nativeMessageId: native, receiptLevel: 'delivered' });
    expect(applied!.intent).toMatchObject({ status: 'sent', receiptLevel: 'delivered' });
    expect(applied!.attempt).toMatchObject({ ownerEpoch: 1, attemptNo: 1, outcome: 'accepted' });
    expect(rig.storesA.outbox.listAttempts(first.id)).toHaveLength(1);

    // ... and the receipt did not unlock the stale backlog
    expect(await rig.dispatcher('B').dispatchDue()).toEqual([]);
    expect(rig.serviceA.get(backlog.id)).toMatchObject({ status: 'pending', ownerEpoch: 1 });
    expect(rig.storesA.outbox.supersedeStaleEpochIntents(rig.account.id)).toBe(1);
    expect(rig.serviceA.get(backlog.id)).toMatchObject({ status: 'needs_review', statusReason: 'SUPERSEDED_BY_EPOCH' });

    // a request made under the new epoch goes out with the new epoch
    const fresh = enqueue(rig, 'r-epoch-fresh-01', second.id);
    expect(fresh.ownerEpoch).toBe(2);
    const [report] = await rig.dispatcher('B').dispatchDue();
    expect(report.result).toBe('sent');
    expect(rig.connector.dispatchCalls[1].ownerEpoch).toBe(2);
    expect(rig.connector.providerSendCount).toBe(2);
  });

  it('the epoch moving between claim and attempt fences the RPC: no attempt, nothing sent', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'r-fence-000001');
    const guard = {
      evaluate: () => {
        rig.storesB.accounts.updateAccountOwnerEpoch(rig.account.id, 'core', 2);
        return { allow: true as const };
      },
    };
    const [report] = await rig.dispatcher('A', { guard }).dispatchDue();
    expect(report).toMatchObject({ rpc: false, reason: 'ATTEMPT_FENCED' });
    expect(rig.connector.dispatchCalls).toHaveLength(0);
    expect(rig.storesA.outbox.listAttempts(intent.id)).toHaveLength(0);
  });
});

describe('receipts', () => {
  it('levels only go up; a receipt for nothing we sent is ignored', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'r-levels-00001');
    await rig.dispatcher('A').dispatchDue();
    const native = rig.connector.getDelivery(rig.account.id, 'r-levels-00001')!.nativeMessageId;
    const ref = { accountId: rig.account.id, clientRequestId: 'r-levels-00001', nativeMessageId: native };

    expect(rig.serviceA.recordReceipt({ ...ref, receiptLevel: 'read' })!.intent.receiptLevel).toBe('read');
    const late = rig.serviceA.recordReceipt({ ...ref, receiptLevel: 'delivered' })!;
    expect(late.intent.receiptLevel).toBe('read');
    expect(late.note).toBe('RECEIPT_ALREADY_RECORDED');
    expect(rig.storesA.outbox.listAttempts(intent.id)[0].receiptLevel).toBe('read');
    expect(count(rig.fx.a, 'care_messages', "direction = 'out'")).toBe(1);
    expect(rig.serviceA.recordReceipt({ accountId: rig.account.id, clientRequestId: 'never-sent', receiptLevel: 'read' })).toBeNull();
    // a receipt for an intent that was never attempted is not evidence of anything
    const idle = enqueue(rig, 'r-levels-idle01');
    expect(rig.serviceA.recordReceipt({ accountId: rig.account.id, clientRequestId: 'r-levels-idle01', receiptLevel: 'accepted' })).toBeNull();
    expect(rig.serviceA.get(idle.id)!.status).toBe('pending');
  });

  it('an acceptance without a provider message ID is booked under a provisional key, then moved to the real one', async () => {
    rig = makeRig();
    const intent = enqueue(rig, 'r-provis-00001');
    rig.connector.dispatch = async () => ({ outcome: 'accepted' });
    await rig.dispatcher('A').dispatchDue();
    const sent = rig.serviceA.get(intent.id)!;
    expect(sent.status).toBe('sent');
    const provisional = rig.storesA.messages.getMessage(sent.canonicalMessageId!)!;
    expect(provisional.nativeMessageId).toBe(`local-out:${intent.id}`);

    rig.serviceA.recordReceipt({ accountId: rig.account.id, clientRequestId: 'r-provis-00001', nativeMessageId: 'real-remote-9', receiptLevel: 'delivered' });
    expect(rig.storesA.messages.getMessage(provisional.id)!.nativeMessageId).toBe('real-remote-9');
    expect(count(rig.fx.a, 'care_messages', "direction = 'out'")).toBe(1);
  });
});
