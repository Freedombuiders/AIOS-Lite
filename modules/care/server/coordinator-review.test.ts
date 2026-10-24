/**
 * Independent acceptance probes authored by the coordinator, not the implementer.
 * Review evidence: docs/plans/customer-care/evidence/batch-01-foundation-repair.md.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CareIngestPipeline } from './application/ingest.js';
import type { NormalizedMessage } from '../../_lib/care-kit/types.js';
import { decryptCareFieldStrict, encryptCareField } from './persistence/crypto.js';
import { createTestCareDatabase } from './persistence/index.js';

const key = Buffer.alloc(32, 71);
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(close => close()); });

function fixture() {
  const db = createTestCareDatabase(':memory:', key);
  cleanup.push(db.close);
  const account = db.stores.accounts.createAccount({
    channel: 'zalo', connectorKind: 'fake', nativeAccountId: 'coordinator', label: 'fixture',
    desiredState: 'active', writeOwner: 'core', ownerEpoch: 1,
    aiEnabled: true, syncEnabled: true, sendEnabled: true,
  });
  const ingest = new CareIngestPipeline(db.rawDbForTestIsolationOnly, db.stores);
  const message = (id: string, sentAtMs = 200): NormalizedMessage => ({
    accountId: account.id, externalConversationKey: 'peer:1', nativeMessageNamespace: 'zalo_chat',
    nativeMessageId: id, nativeVersion: '1', direction: 'in', senderRole: 'customer',
    senderIdentityKey: 'customer:1', origin: 'live', sentAtMs, text: 'fixture question',
    metadata: { type: 'chat' },
  });
  return { ...db, account, ingest, message };
}

describe('Coordinator independent foundation acceptance', () => {
  it('rejects odd-length ciphertext instead of accepting an unauthenticated trailing nibble', () => {
    const encrypted = encryptCareField('secret', key);
    expect(() => decryptCareFieldStrict(encrypted + 'f', key)).toThrow();
  });

  it('does not claim inbound turns for a paused account', () => {
    const f = fixture();
    f.stores.jobs.enqueueJob({ accountId: f.account.id, jobType: 'inbound_turn', payload: {}, ownerEpoch: 1, dueAtMs: 0 });
    f.stores.accounts.updateAccountFlags(f.account.id, { desiredState: 'paused' });
    expect(f.stores.jobs.claimJobs({ workerId: 'A', currentEpoch: 1, leaseDurationMs: 1000, nowMs: 100 })).toEqual([]);
  });

  it('does not claim inbound turns after the AI gate was disabled', () => {
    const f = fixture();
    f.stores.jobs.enqueueJob({ accountId: f.account.id, jobType: 'inbound_turn', payload: {}, ownerEpoch: 1, dueAtMs: 0 });
    f.stores.accounts.updateAccountFlags(f.account.id, { aiEnabled: false });
    expect(f.stores.jobs.claimJobs({ workerId: 'A', currentEpoch: 1, leaseDurationMs: 1000, nowMs: 100 })).toEqual([]);
  });

  it('fences completion when the account epoch changes during an otherwise valid lease', () => {
    const f = fixture();
    f.stores.jobs.enqueueJob({ accountId: f.account.id, jobType: 'inbound_turn', payload: {}, ownerEpoch: 1, dueAtMs: 0 });
    const [claim] = f.stores.jobs.claimJobs({ workerId: 'A', currentEpoch: 1, leaseDurationMs: 1000, nowMs: 100 });
    f.stores.accounts.updateAccountOwnerEpoch(f.account.id, 'core', 2);
    expect(f.stores.jobs.completeJob(claim.id, 'A', claim.claimToken!, 200)).toBe(false);
  });

  it('rejects an ingest writer from a stale epoch without creating messages or checkpoints', () => {
    const f = fixture();
    f.stores.accounts.updateAccountOwnerEpoch(f.account.id, 'core', 2);
    expect(() => f.ingest.ingestNormalizedMessage(f.message('stale'), { namespace: 'zalo_chat', cursor: 'checkpoint' }, 1)).toThrow();
    expect(f.rawDbForTestIsolationOnly.prepare('SELECT count(*) AS n FROM care_messages').get()).toEqual({ n: 0 });
    expect(f.rawDbForTestIsolationOnly.prepare('SELECT count(*) AS n FROM care_sync_state').get()).toEqual({ n: 0 });
  });

  it('rejects a duplicate native message ID attached to a different conversation', () => {
    const f = fixture();
    f.ingest.ingestNormalizedMessage(f.message('same'), undefined, 1);
    expect(() => f.ingest.ingestNormalizedMessage({ ...f.message('same'), externalConversationKey: 'peer:2' }, undefined, 1)).toThrow();
    expect(f.stores.conversations.listConversations()).toHaveLength(1);
  });

  it('does not resolve a newer unanswered inbound when an older live outbound arrives late', () => {
    const f = fixture();
    const question = f.ingest.ingestNormalizedMessage(f.message('question', 200), undefined, 1);
    f.ingest.ingestNormalizedMessage({ ...f.message('old-reply', 100), senderRole: 'operator', direction: 'out', senderIdentityKey: null }, undefined, 1);
    const conversation = f.stores.conversations.getConversation(question.conversationId!)!;
    expect(conversation.waitingSinceMs).toBe(200);
    expect(conversation.lastMessageId).toBe(question.messageId);
  });

  it('keeps remote read receipts separate from dashboard local-seen state', () => {
    const f = fixture();
    const result = f.ingest.ingestNormalizedMessage(f.message('question'), undefined, 1);
    f.ingest.ingestNormalizedEvent({ type: 'read.updated', accountId: f.account.id, eventId: 'remote-read', timestampMs: 300, externalConversationKey: 'peer:1', remoteReadMessageId: 'native-message-123' });
    expect(f.stores.conversations.getConversation(result.conversationId!)!.localSeenMessageId).toBeNull();
  });

  it('encrypts customer profile attributes at rest, in addition to notes and tasks', () => {
    const f = fixture();
    const marker = 'PRIVATE_CUSTOMER_ATTRIBUTE_482197';
    const customer = f.stores.customers.createCustomer({ displayName: marker, company: marker, phone: marker, email: marker, tags: marker });
    expect(JSON.stringify(f.rawDbForTestIsolationOnly.prepare('SELECT * FROM care_customers WHERE id = ?').get(customer.id))).not.toContain(marker);
    expect(f.stores.customers.getCustomer(customer.id)!.displayName).toBe(marker);
  });
});
