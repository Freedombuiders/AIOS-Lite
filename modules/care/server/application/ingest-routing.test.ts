import { CareIngestPipeline } from './ingest.js';
import { describe, expect, it } from 'vitest';
import { chatMessage, memoryFixture } from '../test-fixtures.js';

const jobs = (f: ReturnType<typeof memoryFixture>) => (f.raw.prepare('SELECT COUNT(*) AS n FROM care_jobs').get() as { n: number }).n;
const group = { type: 'chat' as const, conversationKind: 'group' as const, mentions: [{ uid: 'shop-uid' }] };

describe('ingest uses the CC-10 resolver (kind-limited nick-wide defaults)', () => {
  it('a 1-1 default can be auto while the group default is observe-only', () => {
    const f = memoryFixture({ nativeAccountId: 'shop-uid' });
    f.stores.assignments.upsertAssignment({ scope: 'account', accountId: f.account.id, mode: 'auto', agentId: 'dm-agent', policyExt: { legacyScope: 'account_dms' } });
    f.stores.assignments.upsertAssignment({ scope: 'account', accountId: f.account.id, mode: 'observe', agentId: 'grp-agent', policyExt: { legacyScope: 'account_groups' } });

    const dm = f.ingest.ingestNormalizedMessage(chatMessage(f.account, { externalConversationKey: 'u1' }));
    expect(dm.jobId).toBeTruthy();
    expect(jobs(f)).toBe(1);

    const grp = f.ingest.ingestNormalizedMessage(chatMessage(f.account, { externalConversationKey: 'g1', metadata: group }));
    expect(grp.jobId).toBeUndefined();
    expect(jobs(f)).toBe(1);
    f.close();
  });

  it('a kind-limited rule does not apply to the other kind, and a conflict still skips the job', () => {
    const f = memoryFixture({ nativeAccountId: 'shop-uid' });
    f.stores.assignments.upsertAssignment({ scope: 'account', accountId: f.account.id, mode: 'auto', agentId: 'grp-agent', policyExt: { legacyScope: 'account_groups' } });
    expect(f.ingest.ingestNormalizedMessage(chatMessage(f.account, { externalConversationKey: 'u1' })).jobId).toBeUndefined();
    expect(f.ingest.ingestNormalizedMessage(chatMessage(f.account, { externalConversationKey: 'g1', metadata: group })).jobId).toBeTruthy();

    f.stores.assignments.upsertAssignment({ scope: 'account', accountId: f.account.id, mode: 'draft', agentId: 'other', policyExt: { legacyScope: 'account_groups' } });
    const conflicted = f.ingest.ingestNormalizedMessage(chatMessage(f.account, { externalConversationKey: 'g2', metadata: group }));
    expect(conflicted.jobId).toBeUndefined();
    f.close();
  });
});

describe('delivery.confirmed hands the receipt to the delivery layer after commit', () => {
  const confirm = (f: ReturnType<typeof memoryFixture>, over: Record<string, unknown> = {}) => ({
    type: 'delivery.confirmed' as const,
    eventId: 'ev-receipt-1',
    accountId: f.account.id,
    timestampMs: 1_700_000_000_000,
    clientRequestId: 'req-1',
    nativeMessageId: 'native-9',
    receiptLevel: 'delivered' as const,
    ...over,
  });

  it('is a no-op by default, so existing ingest behaviour is unchanged', () => {
    const f = memoryFixture();
    expect(f.ingest.ingestNormalizedEvent(confirm(f)).outcome).toBe('delivery_confirmed');
    f.close();
  });

  it('calls the callback once per event outside the transaction, and again on a replay (idempotent handler)', () => {
    const f = memoryFixture();
    const calls: unknown[] = [];
    let inTx: boolean | null = null;
    const ingest = new CareIngestPipeline(f.raw, f.stores, {
      onDeliveryConfirmed: (r) => { calls.push(r); inTx = f.raw.inTransaction; },
    });
    expect(ingest.ingestNormalizedEvent(confirm(f)).outcome).toBe('delivery_confirmed');
    expect(calls).toEqual([
      { accountId: f.account.id, clientRequestId: 'req-1', nativeMessageId: 'native-9', receiptLevel: 'delivered', remoteTimestampMs: 1_700_000_000_000 },
    ]);
    expect(inTx).toBe(false);
    expect(ingest.ingestNormalizedEvent(confirm(f)).outcome).toBe('duplicate_event');
    expect(calls).toHaveLength(2);
    f.close();
  });

  it('does not call it for an invalid, stale-epoch or non-receipt event, and lets a callback error reach the adapter', () => {
    const f = memoryFixture();
    const calls: unknown[] = [];
    const ingest = new CareIngestPipeline(f.raw, f.stores, { onDeliveryConfirmed: (r) => { calls.push(r); if (calls.length === 1) throw new Error('outbox busy'); } });
    expect(() => ingest.ingestNormalizedEvent(confirm(f, { nativeMessageId: '' }))).toThrow();
    expect(() => ingest.ingestNormalizedEvent(confirm(f, { eventId: 'ev-stale', epoch: 99 }))).toThrow(/epoch/i);
    ingest.ingestNormalizedMessage(chatMessage(f.account));
    expect(calls).toHaveLength(0);
    expect(() => ingest.ingestNormalizedEvent(confirm(f))).toThrow('outbox busy');
    expect(ingest.ingestNormalizedEvent(confirm(f)).outcome).toBe('duplicate_event');
    expect(calls).toHaveLength(2);
    f.close();
  });
})
