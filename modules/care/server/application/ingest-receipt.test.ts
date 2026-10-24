import { afterEach, describe, expect, it } from 'vitest';
import { chat, makeRig, type Rig } from './dispatch-test-kit.js';
import { CareIngestPipeline } from './ingest.js';

let rig: Rig;
afterEach(() => rig?.close());

describe('provider receipts move delivery intents through ingest', () => {
  it('a delivery.confirmed event resolves an uncertain intent via recordReceipt; an unrelated one is ignored', async () => {
    rig = makeRig();
    const intent = rig.serviceA.enqueue({ conversationId: rig.conversation.id, clientRequestId: 'r-ingest-0001', actor: 'manual', content: chat('xin chào') }).intent;
    rig.connector.setBehavior('accepted-lost-ack');
    await rig.dispatcher('A').dispatchDue();
    rig.connector.setBehavior('normal');
    expect(rig.serviceA.get(intent.id)!.status).toBe('uncertain');

    const applied: unknown[] = [];
    const ingest = new CareIngestPipeline(rig.fx.a, rig.storesA, {
      onDeliveryConfirmed: (r) => applied.push(rig.serviceA.recordReceipt(r)),
    });
    const native = rig.connector.getDelivery(rig.account.id, 'r-ingest-0001')!.nativeMessageId;
    const event = (eventId: string, clientRequestId: string, level: 'accepted' | 'delivered' | 'read') => ({
      type: 'delivery.confirmed' as const, eventId, accountId: rig.account.id, timestampMs: Date.now(), clientRequestId, nativeMessageId: native, receiptLevel: level,
    });

    ingest.ingestNormalizedEvent(event('ev-1', 'never-sent', 'read'));
    expect(applied).toEqual([null]);
    expect(rig.serviceA.get(intent.id)!.status).toBe('uncertain');

    ingest.ingestNormalizedEvent(event('ev-2', 'r-ingest-0001', 'delivered'));
    expect(rig.serviceA.get(intent.id)).toMatchObject({ status: 'sent', receiptLevel: 'delivered' });

    // a replay (adapter retry) is harmless and levels never go down
    ingest.ingestNormalizedEvent(event('ev-2', 'r-ingest-0001', 'delivered'));
    ingest.ingestNormalizedEvent(event('ev-3', 'r-ingest-0001', 'accepted'));
    expect(rig.serviceA.get(intent.id)).toMatchObject({ status: 'sent', receiptLevel: 'delivered' });
    expect(rig.connector.providerSendCount).toBe(1);
  });
});

describe('a late receipt from an OLDER owner epoch (guide section 5)', () => {
  const count = (r: Rig, table: string): number => (r.fx.a.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  async function cutover() {
    rig = makeRig();
    const second = rig.storesA.conversations.upsertConversation({ accountId: rig.account.id, externalKey: 'peer:2', kind: 'direct', title: 'Other' });
    const sent = rig.serviceA.enqueue({ conversationId: rig.conversation.id, clientRequestId: 'r-late-000001', actor: 'manual', content: chat('một') }).intent;
    const backlog = rig.serviceA.enqueue({ conversationId: second.id, clientRequestId: 'r-late-backlog', actor: 'manual', content: chat('hai') }).intent;
    rig.connector.setBehavior('accepted-lost-ack');
    await rig.dispatcher('A').dispatchDue();
    rig.connector.setBehavior('normal');
    rig.storesA.accounts.updateAccountOwnerEpoch(rig.account.id, 'core', 2);
    rig.connector.activeEpoch = 2;
    const calls: unknown[] = [];
    const ingest = new CareIngestPipeline(rig.fx.a, rig.storesA, {
      onDeliveryConfirmed: (r) => calls.push(rig.serviceA.recordReceipt(r)),
    });
    const native = rig.connector.getDelivery(rig.account.id, 'r-late-000001')!.nativeMessageId;
    const receipt = (over: Record<string, unknown> = {}) => ({
      type: 'delivery.confirmed' as const, eventId: 'ev-late-1', accountId: rig.account.id, timestampMs: Date.now(), epoch: 1,
      clientRequestId: 'r-late-000001', nativeMessageId: native, receiptLevel: 'delivered' as const, ...over,
    });
    return { second, sent, backlog, ingest, calls, receipt };
  }

  it('moves the original attempt uncertain -> sent, is idempotent, and grants that epoch nothing', async () => {
    const { sent, backlog, ingest, receipt, calls } = await cutover();
    expect(rig.serviceA.get(sent.id)!.status).toBe('uncertain');
    const before = { messages: count(rig, 'care_messages'), jobs: count(rig, 'care_jobs'), conversations: count(rig, 'care_conversations') };

    const res = ingest.ingestNormalizedEvent(receipt({ checkpoint: { namespace: 'zalo_chat', cursor: 'c-1', position: '1' } }));
    expect(res).toMatchObject({ outcome: 'delivery_confirmed' });
    expect(res.checkpoint).toBeUndefined();
    expect(rig.serviceA.get(sent.id)).toMatchObject({ status: 'sent', receiptLevel: 'delivered' });
    expect(rig.storesA.outbox.listAttempts(sent.id)[0].ownerEpoch).toBe(1);
    // nothing beyond the ledger row and the matching canonical message
    expect(count(rig, 'care_jobs')).toBe(before.jobs);
    expect(count(rig, 'care_conversations')).toBe(before.conversations);
    expect(count(rig, 'care_messages')).toBeLessThanOrEqual(before.messages + 1);
    expect(rig.storesA.checkpoints.get(rig.account.id, 'zalo_chat')).toBeNull();

    // replay is harmless
    expect(ingest.ingestNormalizedEvent(receipt()).outcome).toBe('duplicate_event');
    expect(calls).toHaveLength(2);
    expect(rig.serviceA.get(sent.id)).toMatchObject({ status: 'sent', receiptLevel: 'delivered' });

    // the receipt did not unlock the stale backlog; the old-epoch worker cannot send it either
    expect(await rig.dispatcher('A').dispatchDue()).toEqual([]);
    expect(await rig.dispatcher('B').dispatchDue()).toEqual([]);
    expect(rig.serviceA.get(backlog.id)).toMatchObject({ status: 'pending', ownerEpoch: 1 });
    expect(rig.connector.providerSendCount).toBe(1);
  });

  it('every OTHER stale-epoch event stays fenced; a newer epoch or another account is rejected for receipts too', async () => {
    const { ingest, receipt, calls } = await cutover();
    const messagesBefore = count(rig, 'care_messages');
    const inbound = {
      accountId: rig.account.id, externalConversationKey: 'peer:1', nativeMessageNamespace: 'zalo_chat', nativeMessageId: 'late-in-1', nativeVersion: '1',
      direction: 'in' as const, senderRole: 'customer' as const, senderIdentityKey: 'c1', origin: 'live' as const, sentAtMs: Date.now(), text: 'tin muộn',
      metadata: { type: 'chat' as const },
    };
    expect(() => ingest.ingestNormalizedMessage(inbound, undefined, 1)).toThrow(/Stale ingest epoch/);
    expect(() => ingest.ingestNormalizedEvent({ type: 'read.updated', eventId: 'ev-r', accountId: rig.account.id, timestampMs: 1, epoch: 1, externalConversationKey: 'peer:1', remoteReadMessageId: 'x' })).toThrow(/Stale ingest epoch/);
    expect(() => ingest.ingestNormalizedEvent({ type: 'conversation.updated', eventId: 'ev-c', accountId: rig.account.id, timestampMs: 1, epoch: 1, externalConversationKey: 'peer:1', title: 'x' })).toThrow(/Stale ingest epoch/);
    expect(count(rig, 'care_messages')).toBe(messagesBefore);
    expect(count(rig, 'care_jobs')).toBe(0);

    expect(() => ingest.ingestNormalizedEvent(receipt({ epoch: 3, eventId: 'ev-future' }))).toThrow(/Stale ingest epoch/);
    expect(() => ingest.ingestNormalizedEvent(receipt({ accountId: 'no-such-account', eventId: 'ev-other' }))).toThrow(/Account not found/);
    expect(calls).toHaveLength(0);
  });
});
