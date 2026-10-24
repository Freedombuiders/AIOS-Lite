/** Independent causal/scope acceptance cases. API payloads may evolve; behavior assertions must remain. */
import { afterEach, describe, expect, it } from 'vitest';
import { CareIngestPipeline } from './application/ingest.js';
import { FakeCareConnector } from './connectors/fake-connector.js';
import type { CareChannel, NormalizedEvent, NormalizedMessage } from '../../_lib/care-kit/types.js';
import { createTestCareDatabase } from './persistence/index.js';
import { createCareSchema } from './persistence/schema.js';

const key = Buffer.alloc(32, 81);
const closes: Array<() => void> = [];
afterEach(() => closes.splice(0).forEach(close => close()));
function fixture(channel: CareChannel = 'zalo') {
  const db = createTestCareDatabase(':memory:', key);
  closes.push(db.close);
  const account = db.stores.accounts.createAccount({
    channel, connectorKind: 'fake', nativeAccountId: 'native-self', label: 'synthetic',
    desiredState: 'active', writeOwner: 'core', syncEnabled: true, aiEnabled: true, sendEnabled: true,
  });
  const pipeline = new CareIngestPipeline(db.rawDbForTestIsolationOnly, db.stores);
  const msg = (id: string, origin: NormalizedMessage['origin'] = 'live'): NormalizedMessage => ({
    accountId: account.id, externalConversationKey: 'peer:1',
    nativeMessageNamespace: channel === 'telegram' ? 'telegram_common_box' : 'zalo_chat',
    nativeMessageId: id, nativeVersion: '1', senderIdentityKey: 'customer:1',
    senderRole: 'customer', direction: 'in', origin, sentAtMs: 200, text: 'synthetic question',
    metadata: { type: 'chat' },
  });
  return { ...db, account, pipeline, msg };
}

describe('Coordinator causal and namespace acceptance', () => {
  it('an explicitly empty allowed account scope claims nothing', () => {
    const f = fixture();
    f.stores.jobs.enqueueJob({ accountId: f.account.id, jobType: 'inbound_turn', payload: {}, ownerEpoch: 1, dueAtMs: 0 });
    expect(f.stores.jobs.claimJobs({ workerId: 'scope', accountIds: [], currentEpoch: 1, nowMs: 100, leaseDurationMs: 1000 })).toEqual([]);
  });

  it('equal causal checkpoint position cannot overwrite a different opaque state without CAS', () => {
    const f = fixture();
    f.stores.checkpoints.advance(f.account.id, { namespace: 'zalo_chat', cursor: 'state-A', position: '100' });
    try { f.stores.checkpoints.advance(f.account.id, { namespace: 'zalo_chat', cursor: 'state-B', position: '100' }); } catch { /* rejection is valid */ }
    expect(f.stores.checkpoints.get(f.account.id, 'zalo_chat')?.cursor).toBe('state-A');
  });

  it('a receipt preceding its target message is durably resolved with the original provider event ID', () => {
    const f = fixture();
    f.stores.conversations.upsertConversation({ accountId: f.account.id, externalKey: 'peer:1', kind: 'direct', title: 'synthetic' });
    const read: NormalizedEvent = { type: 'read.updated', eventId: 'receipt-before-target', accountId: f.account.id, timestampMs: 300, epoch: 1, externalConversationKey: 'peer:1', remoteReadMessageId: '10', nativeMessageNamespace: 'zalo_chat' };
    f.pipeline.ingestNormalizedEvent(read);
    const created = f.pipeline.ingestNormalizedMessage(f.msg('10'), undefined, 1);
    f.pipeline.ingestNormalizedEvent(read);
    const conversation = f.stores.conversations.getConversation(created.conversationId!)!;
    expect(conversation.remoteUnreadCount).toBe(0);
    expect(conversation.localSeenMessageId).toBeNull();
    expect(f.rawDbForTestIsolationOnly.prepare('SELECT count(*) AS n FROM care_events WHERE account_id = ? AND event_id = ?').get(f.account.id, read.eventId)).toEqual({ n: 1 });
  });

  it('first sight of a message through an edit never creates a fresh automatic turn', () => {
    const f = fixture();
    f.stores.assignments.upsertAssignment({ accountId: f.account.id, scope: 'account', mode: 'auto', agentId: 'synthetic-agent' });
    const result = f.pipeline.ingestNormalizedEvent({ type: 'message.edited', accountId: f.account.id, eventId: 'first-edit', timestampMs: 300, epoch: 1, message: { ...f.msg('old-question'), nativeVersion: '2' } });
    expect(f.stores.messages.getMessage(result.messageId!)?.text).toBe('synthetic question');
    expect(f.rawDbForTestIsolationOnly.prepare('SELECT count(*) AS n FROM care_jobs').get()).toEqual({ n: 0 });
  });

  it('history/live overlap creates one job only for the eligible real live observation', () => {
    const f = fixture();
    f.stores.assignments.upsertAssignment({ accountId: f.account.id, scope: 'account', mode: 'auto', agentId: 'synthetic-agent' });
    f.pipeline.ingestNormalizedMessage(f.msg('overlap', 'history'), undefined, 1, 'backfill-observation');
    expect(f.rawDbForTestIsolationOnly.prepare('SELECT count(*) AS n FROM care_jobs').get()).toEqual({ n: 0 });
    f.pipeline.ingestNormalizedMessage(f.msg('overlap', 'live'), undefined, 1, 'provider-live-observation');
    f.pipeline.ingestNormalizedMessage(f.msg('overlap', 'live'), undefined, 1, 'provider-live-observation');
    expect(f.rawDbForTestIsolationOnly.prepare('SELECT count(*) AS n FROM care_messages').get()).toEqual({ n: 1 });
    expect(f.rawDbForTestIsolationOnly.prepare('SELECT count(*) AS n FROM care_jobs').get()).toEqual({ n: 1 });
  });

  it('opaque account/request tuples containing colons cannot collide in the fake delivery ledger', async () => {
    const connector = new FakeCareConnector();
    const shared = { kind: 'chat' as const, channel: 'zalo' as const, purpose: 'care' as const, actor: 'manual' as const, ownerEpoch: 1, text: 'synthetic', adapterRetryToken: 'same-token-1234', target: { externalConversationKey: 'peer' } };
    const first = await connector.dispatch({ ...shared, accountId: 'a:b', clientRequestId: 'c' });
    const second = await connector.dispatch({ ...shared, accountId: 'a', clientRequestId: 'b:c' });
    expect(connector.providerSendCount).toBe(2);
    expect(first.nativeMessageId).not.toBe(second.nativeMessageId);
  });

  it('a schema version with no implemented migration is refused instead of silently reusing old tables', () => {
    const f = fixture();
    f.rawDbForTestIsolationOnly.prepare("UPDATE care_schema_meta SET value = '1' WHERE key = 'schema_version'").run();
    expect(() => createCareSchema(f.rawDbForTestIsolationOnly)).toThrow();
  });

  it('native read coverage at equal timestamps is independent of random canonical UUID ordering', () => {
    const f = fixture('telegram');
    const conversation = f.stores.conversations.upsertConversation({ accountId: f.account.id, externalKey: 'peer:1', kind: 'direct', title: 'synthetic' });
    f.stores.messages.insertMessage(f.msg('10'), conversation.id, null, 'z-older-native10');
    f.stores.messages.insertMessage(f.msg('20'), conversation.id, null, 'a-newer-native20');
    f.stores.conversations.recomputeProjection(conversation.id);
    f.pipeline.ingestNormalizedEvent({ type: 'read.updated', eventId: 'native-read10', accountId: f.account.id, timestampMs: 300, epoch: 1, externalConversationKey: 'peer:1', nativeMessageNamespace: 'telegram_common_box', remoteReadMessageId: '10' });
    expect(f.stores.conversations.getConversation(conversation.id)!.remoteUnreadCount).toBe(1);
  });

  it('unknown Telegram common-box deletion persists without inventing a peer and suppresses late history', () => {
    const f = fixture('telegram');
    const deletion = { type: 'message.deleted', eventId: 'peerless-delete', accountId: f.account.id, timestampMs: 300, epoch: 1, nativeMessageNamespace: 'telegram_common_box', nativeMessageId: '10', nativeVersion: '2' } as NormalizedEvent;
    expect(() => f.pipeline.ingestNormalizedEvent(deletion)).not.toThrow();
    expect(f.stores.conversations.listConversations()).toHaveLength(0);
    f.pipeline.ingestNormalizedMessage(f.msg('10', 'history'), undefined, 1, 'late-history');
    const message = f.stores.messages.getMessageByNativeId(f.account.id, 'telegram_common_box', '10');
    expect(message?.isDeleted).toBe(true);
    expect(message?.text).not.toContain('synthetic question');
    expect(f.rawDbForTestIsolationOnly.prepare('SELECT count(*) AS n FROM care_jobs').get()).toEqual({ n: 0 });
  });
});
