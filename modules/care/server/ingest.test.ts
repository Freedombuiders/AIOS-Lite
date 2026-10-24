import { afterEach, describe, expect, it } from 'vitest';
import { CareError } from '../../_lib/care-kit/errors.js';
import type { NormalizedEvent } from '../../_lib/care-kit/types.js';
import { assignAuto, chatMessage, dumpCareTables, emailMessage, memoryFixture } from './test-fixtures.js';

const open: Array<() => void> = [];
afterEach(() => open.splice(0).forEach((close) => close()));

function fixture(accountOver: Parameters<typeof memoryFixture>[0] = {}) {
  const f = memoryFixture(accountOver);
  open.push(f.close);
  return f;
}

function count(f: ReturnType<typeof fixture>, table: string): number {
  return (f.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CareError);
    return (err as CareError).code;
  }
  throw new Error('expected a CareError');
}

const EFFECT_TABLES = [
  'care_messages',
  'care_conversations',
  'care_customers',
  'care_identities',
  'care_sync_state',
  'care_events',
  'care_jobs',
];

function expectNoEffects(f: ReturnType<typeof fixture>, tables = EFFECT_TABLES) {
  for (const t of tables) expect(count(f, t), `${t} must be empty after a rejected ingest`).toBe(0);
}

describe('Atomic ingest of a live inbound message (AC-006)', () => {
  it('applies message, projection, typed checkpoint, scrubbed ledger event and one policy job together', () => {
    const f = fixture();
    assignAuto(f.stores, f.account);
    const msg = chatMessage(f.account, { text: 'PRIVATE BODY', sentAtMs: 1774880000000 });

    const res = f.ingest.ingestNormalizedMessage(msg, { namespace: 'zalo_chat', cursor: 'cp_100', position: '100' }, 1, 'ev_1');

    expect(res).toMatchObject({ outcome: 'created', eventId: 'ev_1', checkpoint: 'inserted' });
    const conv = f.stores.conversations.getConversation(res.conversationId!)!;
    expect(conv.lastMessageId).toBe(res.messageId); // local canonical id, not the native id
    expect(conv.waitingSinceMs).toBe(1774880000000);
    expect(conv.remoteUnreadCount).toBe(1);
    expect(conv.localSeenMessageId).toBeNull();
    expect(conv.primaryCustomerId).toBeTruthy(); // DM links the identity's customer

    expect(f.stores.checkpoints.get(f.account.id, 'zalo_chat')).toMatchObject({ cursor: 'cp_100', position: '100', revision: 1 });

    const events = f.stores.events.listEventsSince(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'message.created', eventId: 'ev_1', checkpoint: { namespace: 'zalo_chat', cursor: 'cp_100' } });
    expect(events[0].payload).toMatchObject({ nativeMessageId: msg.nativeMessageId, outcome: 'created', job: 'enqueued' });
    expect(JSON.stringify(events[0])).not.toContain('PRIVATE BODY');

    const job = f.stores.jobs.getJob(res.jobId!)!;
    expect(job).toMatchObject({ jobType: 'inbound_turn', status: 'pending', ownerEpoch: 1 });
    expect(job.payload).toMatchObject({ messageId: res.messageId });
  });
});

describe('Job gating: no agent work unless every gate and an effective assignment allow it (Finding 7)', () => {
  const cases: Array<[string, Parameters<typeof memoryFixture>[0], (f: ReturnType<typeof fixture>) => void]> = [
    ['legacy write owner', { writeOwner: 'legacy' }, () => {}],
    ['AI disabled', { aiEnabled: false }, () => {}],
    ['sync disabled', { syncEnabled: false }, () => {}],
    ['paused account', { desiredState: 'paused' }, () => {}],
    ['draining account', { desiredState: 'draining' }, () => {}],
    ['Telegram (AI prohibited at V1)', { channel: 'telegram', connectorKind: 'telegram-user' }, () => {}],
  ];

  for (const [label, over, extra] of cases) {
    it(`does not enqueue for: ${label}`, () => {
      const f = fixture(over);
      assignAuto(f.stores, f.account);
      extra(f);
      const res = f.ingest.ingestNormalizedMessage(chatMessage(f.account), undefined, 1);
      expect(res.outcome).toBe('created');
      expect(res.jobId).toBeUndefined();
      expect(count(f, 'care_jobs')).toBe(0);
    });
  }

  it('does not enqueue without an effective assignment, for observe, or under an explicit disabled deny', () => {
    const f = fixture();
    const a = f.ingest.ingestNormalizedMessage(chatMessage(f.account, { externalConversationKey: 'peer:a' }), undefined, 1);
    expect(a.jobId).toBeUndefined(); // no assignment at all
    expect(f.stores.events.listEventsSince(0)[0].payload.job).toBe('skipped_no_assignment');

    f.stores.assignments.upsertAssignment({ scope: 'account', accountId: f.account.id, mode: 'observe', agentId: 'x', id: 'acct_rule' });
    const b = f.ingest.ingestNormalizedMessage(chatMessage(f.account, { externalConversationKey: 'peer:b' }), undefined, 1);
    expect(b.jobId).toBeUndefined();

    f.stores.assignments.upsertAssignment({ scope: 'account', accountId: f.account.id, mode: 'auto', agentId: 'x', id: 'acct_rule' });
    f.stores.assignments.upsertAssignment({
      scope: 'conversation',
      accountId: f.account.id,
      scopeTarget: 'peer:blocked',
      mode: 'auto',
      agentId: 'x',
      enabled: false,
    });
    const blocked = f.ingest.ingestNormalizedMessage(chatMessage(f.account, { externalConversationKey: 'peer:blocked' }), undefined, 1);
    expect(blocked.jobId).toBeUndefined(); // explicit deny never falls through to the account default
    const ok = f.ingest.ingestNormalizedMessage(chatMessage(f.account, { externalConversationKey: 'peer:ok' }), undefined, 1);
    expect(ok.jobId).toBeDefined();
    expect(count(f, 'care_jobs')).toBe(1);
  });

  it('enqueues for draft mode and survives an assignment configuration conflict without a job', () => {
    const f = fixture();
    f.stores.assignments.upsertAssignment({ scope: 'account', accountId: f.account.id, mode: 'draft', agentId: 'x', id: 'draft_rule' });
    expect(f.ingest.ingestNormalizedMessage(chatMessage(f.account), undefined, 1).jobId).toBeDefined();

    f.stores.assignments.upsertAssignment({ scope: 'account', accountId: f.account.id, mode: 'auto', agentId: 'y', id: 'twin_rule', priority: 100 });
    const conflict = f.ingest.ingestNormalizedMessage(chatMessage(f.account, { externalConversationKey: 'peer:c' }), undefined, 1);
    expect(conflict.outcome).toBe('created'); // the message is never lost to a bad config
    expect(conflict.jobId).toBeUndefined();
  });

  it('never enqueues for history, recovery, outbound, non-customer or system traffic', () => {
    const f = fixture();
    assignAuto(f.stores, f.account);
    for (const over of [
      { origin: 'history' as const },
      { origin: 'recovery' as const },
      { direction: 'out' as const, senderRole: 'operator' as const, senderIdentityKey: null },
      { senderRole: 'system' as const, senderIdentityKey: null },
      { senderRole: 'agent' as const, senderIdentityKey: null },
    ]) {
      expect(f.ingest.ingestNormalizedMessage(chatMessage(f.account, over), undefined, 1).jobId).toBeUndefined();
    }
    expect(count(f, 'care_jobs')).toBe(0);
  });

  it('group/topic messages only enqueue when they target THIS account', () => {
    const f = fixture({ nativeAccountId: 'self-uid' });
    assignAuto(f.stores, f.account);
    const group = (over: Record<string, unknown>) =>
      chatMessage(f.account, { externalConversationKey: 'group:1', metadata: { type: 'chat', conversationKind: 'group', ...over } as never });

    expect(f.ingest.ingestNormalizedMessage(group({}), undefined, 1).jobId).toBeUndefined();
    expect(f.ingest.ingestNormalizedMessage(group({ mentions: [{ uid: 'someone-else' }] }), undefined, 1).jobId).toBeUndefined();
    expect(f.ingest.ingestNormalizedMessage(group({ mentions: [{ uid: 'self-uid', isAll: true }] }), undefined, 1).jobId).toBeUndefined();
    expect(f.ingest.ingestNormalizedMessage(group({ mentions: [{ uid: 'self-uid' }] }), undefined, 1).jobId).toBeDefined();
    expect(f.ingest.ingestNormalizedMessage(group({ quote: { messageId: 'q', senderId: 'self-uid' } }), undefined, 1).jobId).toBeDefined();
    expect(count(f, 'care_jobs')).toBe(2);
  });

  it('email accounts enqueue through the same gate', () => {
    const f = fixture({ channel: 'email', connectorKind: 'gmail-composio' });
    assignAuto(f.stores, f.account);
    const res = f.ingest.ingestNormalizedMessage(emailMessage(f.account), undefined, 1);
    expect(res.jobId).toBeDefined();
    expect(f.stores.conversations.getConversation(res.conversationId!)!.kind).toBe('email_thread');
  });
});

describe('Envelope validation and the owner-epoch fence on EVERY branch (Findings 5, 6, 12)', () => {
  it('rejects cross-account event/message mismatch and persists nothing for either account', () => {
    const f = fixture();
    const other = f.stores.accounts.createAccount({ channel: 'email', connectorKind: 'gmail-composio', nativeAccountId: 'o@x.co', label: 'o' });
    const event: NormalizedEvent = {
      type: 'message.created',
      eventId: 'ev_mismatch',
      accountId: f.account.id,
      timestampMs: 1,
      epoch: 1,
      message: emailMessage(other),
    };
    expect(codeOf(() => f.ingest.ingestNormalizedEvent(event))).toBe('INVALID_TARGET');
    expectNoEffects(f);
  });

  it('rejects a stale epoch on every event type without any write, and a future epoch too', () => {
    const f = fixture();
    const seed = f.ingest.ingestNormalizedMessage(chatMessage(f.account, { nativeMessageId: 'seed' }), { namespace: 'zalo_chat', cursor: 'c1', position: '1' }, 1);
    f.stores.accounts.updateAccountOwnerEpoch(f.account.id, 'core', 3);
    const before = {
      events: count(f, 'care_events'),
      messages: count(f, 'care_messages'),
      sync: f.stores.checkpoints.get(f.account.id, 'zalo_chat'),
      conv: f.stores.conversations.getConversation(seed.conversationId!),
    };

    const base = { accountId: f.account.id, timestampMs: 5 };
    const stale: NormalizedEvent[] = [
      { ...base, type: 'message.created', eventId: 's1', epoch: 1, message: chatMessage(f.account), checkpoint: { namespace: 'zalo_chat', cursor: 'c2', position: '2' } },
      { ...base, type: 'message.edited', eventId: 's2', epoch: 2, message: chatMessage(f.account, { nativeMessageId: 'seed', nativeVersion: '5' }) },
      { ...base, type: 'message.deleted', eventId: 's3', epoch: 1, nativeMessageNamespace: 'zalo_chat', nativeMessageId: 'seed', externalConversationKey: 'peer:1', nativeVersion: null },
      { ...base, type: 'conversation.updated', eventId: 's4', epoch: 1, externalConversationKey: 'peer:1', title: 'hijack' },
      { ...base, type: 'account.status', eventId: 's5', epoch: 1, healthStatus: 'error' },
      { ...base, type: 'read.updated', eventId: 's6', epoch: 1, externalConversationKey: 'peer:1', remoteReadMessageId: 'seed' },
      // A STALE receipt is the one deliberate exception (late remote fact, ledger-only; see ingest-receipt.test.ts);
      // a receipt from a FUTURE epoch is still fenced.
      { ...base, type: 'delivery.confirmed', eventId: 's7', epoch: 4, clientRequestId: 'r', nativeMessageId: 'n', receiptLevel: 'accepted' },
      { ...base, type: 'account.status', eventId: 's8', healthStatus: 'error' }, // missing epoch == epoch 1
      { ...base, type: 'account.status', eventId: 's9', epoch: 4, healthStatus: 'error' }, // desynced future writer
    ];
    for (const event of stale) {
      expect(codeOf(() => f.ingest.ingestNormalizedEvent(event)), event.eventId).toBe('FENCING_REJECTED');
    }

    expect(count(f, 'care_events')).toBe(before.events);
    expect(count(f, 'care_messages')).toBe(before.messages);
    expect(f.stores.checkpoints.get(f.account.id, 'zalo_chat')).toEqual(before.sync);
    expect(f.stores.conversations.getConversation(seed.conversationId!)).toEqual(before.conv);
    expect(f.stores.accounts.getAccount(f.account.id)!.healthStatus).toBe('healthy');

    // the current epoch is accepted
    expect(f.ingest.ingestNormalizedMessage(chatMessage(f.account), undefined, 3).outcome).toBe('created');
  });

  it('also fences the direct message helper and refuses unknown accounts', () => {
    const f = fixture();
    f.stores.accounts.updateAccountOwnerEpoch(f.account.id, 'core', 2);
    expect(codeOf(() => f.ingest.ingestNormalizedMessage(chatMessage(f.account), undefined, 1))).toBe('FENCING_REJECTED');
    expect(codeOf(() => f.ingest.ingestNormalizedMessage({ ...chatMessage(f.account), accountId: 'nope' }, undefined, 1))).toBe('INVALID_TARGET');
    expectNoEffects(f);
  });

  it('rejects channel-incongruent namespaces, metadata and conversation kinds in the same transaction', () => {
    const f = fixture(); // zalo
    expect(codeOf(() => f.ingest.ingestNormalizedMessage(chatMessage(f.account, { nativeMessageNamespace: 'telegram_common_box' }), undefined, 1))).toBe('INVALID_TARGET');
    expect(codeOf(() => f.ingest.ingestNormalizedMessage(chatMessage(f.account, { nativeMessageNamespace: 'tg_common' }), undefined, 1))).toBe('INVALID_TARGET');
    expect(codeOf(() => f.ingest.ingestNormalizedMessage(emailMessage(f.account, { nativeMessageNamespace: 'zalo_chat' }), undefined, 1))).toBe('INVALID_TARGET');
    expect(
      codeOf(() => f.ingest.ingestNormalizedMessage(chatMessage(f.account, { metadata: { type: 'chat', conversationKind: 'topic' } }), undefined, 1)),
    ).toBe('INVALID_TARGET'); // Zalo has no topics
    expect(codeOf(() => f.ingest.ingestNormalizedMessage(chatMessage(f.account, { sentAtMs: -5 }), undefined, 1))).toBe('INVALID_COMMAND');
    expect(codeOf(() => f.ingest.ingestNormalizedMessage(chatMessage(f.account, { sentAtMs: 1.5 }), undefined, 1))).toBe('INVALID_COMMAND');
    expect(codeOf(() => f.ingest.ingestNormalizedMessage(chatMessage(f.account, { nativeMessageId: '' }), undefined, 1))).toBe('INVALID_COMMAND');
    expectNoEffects(f);
  });

  it('keeps large 64-bit native IDs exact', () => {
    const f = fixture({ channel: 'telegram', connectorKind: 'telegram-user' });
    const big = '90071992547409951234';
    const res = f.ingest.ingestNormalizedMessage(
      chatMessage(f.account, { nativeMessageId: big, nativeMessageNamespace: 'telegram_channel_box:9999999999999' }),
      { namespace: 'telegram_channel_box:9999999999999', cursor: '18446744073709551615', position: '18446744073709551615' },
      1,
    );
    expect(f.stores.messages.getMessage(res.messageId!)!.nativeMessageId).toBe(big);
    expect(f.stores.checkpoints.get(f.account.id, 'telegram_channel_box:9999999999999')!.position).toBe('18446744073709551615');
  });
});

describe('Event ledger: (account, eventId) suppresses duplicate effects (Finding 12)', () => {
  it('a repeated eventId changes nothing: no second unread, job, checkpoint move or ledger row', () => {
    const f = fixture();
    assignAuto(f.stores, f.account);
    const msg = chatMessage(f.account);
    const first = f.ingest.ingestNormalizedMessage(msg, { namespace: 'zalo_chat', cursor: 'a', position: '1' }, 1, 'ev_same');
    const replay = f.ingest.ingestNormalizedMessage(
      { ...msg, nativeMessageId: 'a-different-message', text: 'conflicting replay' },
      { namespace: 'zalo_chat', cursor: 'b', position: '2' },
      1,
      'ev_same',
    );

    expect(first.outcome).toBe('created');
    expect(replay).toMatchObject({ outcome: 'duplicate_event', eventId: 'ev_same' });
    expect(count(f, 'care_messages')).toBe(1);
    expect(count(f, 'care_events')).toBe(1);
    expect(count(f, 'care_jobs')).toBe(1);
    expect(f.stores.checkpoints.get(f.account.id, 'zalo_chat')).toMatchObject({ cursor: 'a', position: '1' });
    expect(f.stores.conversations.getConversation(first.conversationId!)!.remoteUnreadCount).toBe(1);
  });

  it('is suppressed for non-message events too (status/read/delivery are not re-applied)', () => {
    const f = fixture();
    const status: NormalizedEvent = { type: 'account.status', eventId: 'ev_status', accountId: f.account.id, timestampMs: 1, epoch: 1, healthStatus: 'error', errorNote: 'first' };
    expect(f.ingest.ingestNormalizedEvent(status).outcome).toBe('account_status_updated');
    f.stores.accounts.updateAccountFlags(f.account.id, { healthStatus: 'healthy' });
    expect(f.ingest.ingestNormalizedEvent({ ...status, errorNote: 'second' }).outcome).toBe('duplicate_event');
    expect(f.stores.accounts.getAccount(f.account.id)).toMatchObject({ healthStatus: 'healthy', healthNote: 'first' });
  });

  it('is scoped per account: the same eventId on another account is independent', () => {
    const f = fixture();
    const b = f.stores.accounts.createAccount({ channel: 'zalo', connectorKind: 'fake', nativeAccountId: 'second', label: 'b', desiredState: 'active' });
    const a1 = f.ingest.ingestNormalizedMessage(chatMessage(f.account), undefined, 1, 'ev_shared');
    const b1 = f.ingest.ingestNormalizedMessage(chatMessage(b), undefined, 1, 'ev_shared');
    expect(a1.outcome).toBe('created');
    expect(b1.outcome).toBe('created');
    expect(count(f, 'care_events')).toBe(2);
  });

  it('leaves a ledger row for deduped, tombstoned and stale outcomes, and still advances the checkpoint', () => {
    const f = fixture();
    const msg = chatMessage(f.account, { nativeMessageId: 'dup' });
    f.ingest.ingestNormalizedMessage(msg, { namespace: 'zalo_chat', cursor: 'c1', position: '1' }, 1, 'e1');

    const dup = f.ingest.ingestNormalizedMessage(msg, { namespace: 'zalo_chat', cursor: 'c2', position: '2' }, 1, 'e2');
    expect(dup).toMatchObject({ outcome: 'duplicate_ignored', checkpoint: 'advanced' });

    f.ingest.ingestNormalizedEvent({
      type: 'message.deleted', eventId: 'e3', accountId: f.account.id, timestampMs: 9, epoch: 1,
      nativeMessageNamespace: 'zalo_chat', nativeMessageId: 'dup', externalConversationKey: 'peer:1', nativeVersion: null,
      checkpoint: { namespace: 'zalo_chat', cursor: 'c3', position: '3' },
    });
    const late = f.ingest.ingestNormalizedMessage(msg, { namespace: 'zalo_chat', cursor: 'c4', position: '4' }, 1, 'e4');
    expect(late.outcome).toBe('ignored_tombstone');

    const ledger = f.stores.events.listEventsSince(0);
    expect(ledger.map((e) => [e.eventId, e.payload.outcome])).toEqual([
      ['e1', 'created'],
      ['e2', 'duplicate_ignored'],
      ['e3', 'deleted'],
      ['e4', 'ignored_tombstone'],
    ]);
    expect(f.stores.checkpoints.get(f.account.id, 'zalo_chat')).toMatchObject({ cursor: 'c4', position: '4', revision: 4 });
  });
});

describe('Typed adapter checkpoints: CAS, causal position, boxes (Finding 12 + review)', () => {
  it('never regresses on an older position but still applies the event effects', () => {
    const f = fixture();
    f.ingest.ingestNormalizedMessage(chatMessage(f.account), { namespace: 'zalo_chat', cursor: 'new', position: '50' }, 1);
    const late = f.ingest.ingestNormalizedMessage(chatMessage(f.account), { namespace: 'zalo_chat', cursor: 'old', position: '7' }, 1);
    expect(late).toMatchObject({ outcome: 'created', checkpoint: 'regression_ignored' });
    expect(f.stores.checkpoints.get(f.account.id, 'zalo_chat')).toMatchObject({ cursor: 'new', position: '50', revision: 1 });
    expect(count(f, 'care_messages')).toBe(2);

    const same = f.ingest.ingestNormalizedMessage(chatMessage(f.account), { namespace: 'zalo_chat', cursor: 'new', position: '50' }, 1);
    expect(same.checkpoint).toBe('unchanged');
    // 10 > 9 numerically, not lexically
    f.ingest.ingestNormalizedMessage(chatMessage(f.account), { namespace: 'zalo_chat', cursor: 'p10', position: '10' }, 1);
    expect(f.stores.checkpoints.get(f.account.id, 'zalo_chat')!.cursor).toBe('new'); // 10 < 50
  });

  it('compare-and-set: a stale expectedCursor aborts the WHOLE ingest (effects, ledger, jobs)', () => {
    const f = fixture();
    assignAuto(f.stores, f.account);
    f.ingest.ingestNormalizedMessage(chatMessage(f.account), { namespace: 'zalo_chat', cursor: 'c1' }, 1);
    const messages = count(f, 'care_messages');
    const jobs = count(f, 'care_jobs');
    const events = count(f, 'care_events');

    const stale = f.ingest.ingestNormalizedMessage.bind(f.ingest);
    expect(codeOf(() => stale(chatMessage(f.account), { namespace: 'zalo_chat', cursor: 'c2', expectedCursor: 'not-c1' }, 1))).toBe('STALE_REVISION');
    expect(count(f, 'care_messages')).toBe(messages);
    expect(count(f, 'care_jobs')).toBe(jobs);
    expect(count(f, 'care_events')).toBe(events);
    expect(f.stores.checkpoints.get(f.account.id, 'zalo_chat')!.cursor).toBe('c1');

    const ok = f.ingest.ingestNormalizedMessage(chatMessage(f.account), { namespace: 'zalo_chat', cursor: 'c2', expectedCursor: 'c1' }, 1);
    expect(ok.checkpoint).toBe('advanced');
    // a brand-new box must be declared as such
    expect(
      codeOf(() => f.ingest.ingestNormalizedMessage(chatMessage(f.account), { namespace: 'zalo_thread:abc', cursor: 'x', expectedCursor: 'something' }, 1)),
    ).toBe('STALE_REVISION');
    expect(
      f.ingest.ingestNormalizedMessage(chatMessage(f.account), { namespace: 'zalo_thread:abc', cursor: 'x', expectedCursor: null }, 1).checkpoint,
    ).toBe('inserted');
  });

  it('expectedRevision is a compare-and-set on the stored revision (0 = new box)', () => {
    const f = fixture();
    const put = (cp: object) => f.ingest.ingestNormalizedMessage(chatMessage(f.account), cp as never, 1);
    expect(put({ namespace: 'zalo_chat', cursor: 'r1', expectedRevision: 0 }).checkpoint).toBe('inserted');
    expect(codeOf(() => put({ namespace: 'zalo_chat', cursor: 'r2', expectedRevision: 0 }))).toBe('STALE_REVISION');
    expect(codeOf(() => put({ namespace: 'zalo_chat', cursor: 'r2', expectedRevision: 7 }))).toBe('STALE_REVISION');
    expect(put({ namespace: 'zalo_chat', cursor: 'r2', expectedRevision: 1 }).checkpoint).toBe('advanced');
    expect(f.stores.checkpoints.get(f.account.id, 'zalo_chat')).toMatchObject({ cursor: 'r2', revision: 2 });
    expect(count(f, 'care_messages')).toBe(2); // the two rejected attempts left nothing behind
  });

  it('refuses to replace an existing cursor without CAS or a causal position (no guessing opaque order)', () => {
    const f = fixture();
    f.ingest.ingestNormalizedMessage(chatMessage(f.account), { namespace: 'zalo_chat', cursor: 'opaque-1' }, 1);
    const before = count(f, 'care_messages');
    expect(codeOf(() => f.ingest.ingestNormalizedMessage(chatMessage(f.account), { namespace: 'zalo_chat', cursor: 'opaque-2' }, 1))).toBe('INVALID_CURSOR');
    expect(count(f, 'care_messages')).toBe(before);
    expect(codeOf(() => f.ingest.ingestNormalizedMessage(chatMessage(f.account), { namespace: 'zalo_chat', cursor: 'opaque-3', position: '5' }, 1))).toBe('INVALID_CURSOR');
    expect(f.stores.checkpoints.get(f.account.id, 'zalo_chat')!.cursor).toBe('opaque-1');
  });

  it('rejects malformed checkpoints: bad box, message-namespace-as-box, bad position, bare string', () => {
    const f = fixture();
    const attempt = (cp: unknown) => codeOf(() => f.ingest.ingestNormalizedMessage(chatMessage(f.account), cp as never, 1));
    expect(attempt({ namespace: 'default', cursor: 'x' })).toBe('INVALID_CURSOR');
    expect(attempt({ namespace: 'gmail_mailbox', cursor: 'x' })).toBe('INVALID_CURSOR'); // other channel's box
    expect(attempt({ namespace: 'zalo_chat', cursor: '' })).toBe('INVALID_COMMAND');
    expect(attempt({ namespace: 'zalo_chat', cursor: 'x', position: 'abc' })).toBe('INVALID_CURSOR');
    expect(attempt('bare-string-checkpoint')).toBe('INVALID_CURSOR');
    expectNoEffects(f);
  });

  it('keeps Telegram common and channel boxes independent from each other and from message namespaces', () => {
    const f = fixture({ channel: 'telegram', connectorKind: 'telegram-user' });
    const tg = (id: string, ns: string) => chatMessage(f.account, { nativeMessageId: id, nativeMessageNamespace: ns });

    // a message living in channel box 77, advanced through the COMMON box checkpoint: different things
    f.ingest.ingestNormalizedMessage(tg('1', 'telegram_channel_box:77'), { namespace: 'telegram_common_box', cursor: 'pts100', position: '100' }, 1);
    f.ingest.ingestNormalizedMessage(tg('1', 'telegram_common_box'), { namespace: 'telegram_channel_box:77', cursor: 'cpts5', position: '5' }, 1);

    // same native id 1 in two boxes is two distinct messages
    expect(count(f, 'care_messages')).toBe(2);
    expect(f.stores.checkpoints.get(f.account.id, 'telegram_common_box')).toMatchObject({ cursor: 'pts100', position: '100' });
    expect(f.stores.checkpoints.get(f.account.id, 'telegram_channel_box:77')).toMatchObject({ cursor: 'cpts5', position: '5' });

    // advancing one box does not move the other
    f.ingest.ingestNormalizedMessage(tg('2', 'telegram_common_box'), { namespace: 'telegram_common_box', cursor: 'pts101', position: '101' }, 1);
    expect(f.stores.checkpoints.get(f.account.id, 'telegram_channel_box:77')!.cursor).toBe('cpts5');
    // a telegram account cannot use a gmail box
    expect(codeOf(() => f.ingest.ingestNormalizedMessage(tg('3', 'telegram_common_box'), { namespace: 'gmail_mailbox', cursor: 'x' }, 1))).toBe('INVALID_CURSOR');
  });

  it('advances the checkpoint on edit, delete, conversation and read events too', () => {
    const f = fixture();
    f.ingest.ingestNormalizedMessage(chatMessage(f.account, { nativeMessageId: 'x' }), { namespace: 'zalo_chat', cursor: 'c1', position: '1' }, 1);
    const cp = (n: number) => ({ namespace: 'zalo_chat', cursor: `c${n}`, position: String(n) });
    const base = { accountId: f.account.id, timestampMs: 10, epoch: 1 };

    f.ingest.ingestNormalizedEvent({ ...base, type: 'message.edited', eventId: 'ed', message: chatMessage(f.account, { nativeMessageId: 'x', nativeVersion: '2' }), checkpoint: cp(2) });
    f.ingest.ingestNormalizedEvent({ ...base, type: 'conversation.updated', eventId: 'cu', externalConversationKey: 'peer:1', title: 'T', checkpoint: cp(3) });
    f.ingest.ingestNormalizedEvent({ ...base, type: 'read.updated', eventId: 'rd', externalConversationKey: 'peer:1', remoteReadMessageId: 'x', checkpoint: cp(4) });
    f.ingest.ingestNormalizedEvent({ ...base, type: 'message.deleted', eventId: 'dl', nativeMessageNamespace: 'zalo_chat', nativeMessageId: 'x', externalConversationKey: 'peer:1', nativeVersion: null, checkpoint: cp(5) });
    expect(f.stores.checkpoints.get(f.account.id, 'zalo_chat')).toMatchObject({ cursor: 'c5', position: '5', revision: 5 });
  });

  it.each([
    ['care_sync_state', 'checkpoint write'],
    ['care_events', 'ledger append'],
    ['care_jobs', 'job enqueue'],
    ['care_messages', 'message insert'],
    ['care_conversations', 'conversation create'],
  ])('fault injected on %s (%s) rolls back every other effect', (table) => {
    const f = fixture();
    assignAuto(f.stores, f.account);
    f.raw.exec(`CREATE TRIGGER inject_fault BEFORE INSERT ON ${table} BEGIN SELECT RAISE(FAIL, 'Simulated crash before commit'); END;`);

    expect(() =>
      f.ingest.ingestNormalizedMessage(chatMessage(f.account), { namespace: 'zalo_chat', cursor: 'c', position: '1' }, 1, 'ev_fault'),
    ).toThrow('Simulated crash before commit');
    // only the seeded assignment may remain
    expectNoEffects(f);

    // after the fault clears the same event is applied exactly once (not suppressed by a phantom ledger row)
    f.raw.exec('DROP TRIGGER inject_fault');
    expect(f.ingest.ingestNormalizedMessage(chatMessage(f.account), { namespace: 'zalo_chat', cursor: 'c', position: '1' }, 1, 'ev_fault').outcome).toBe('created');
    expect(count(f, 'care_events')).toBe(1);
  });
});

describe('Ingest composes with a caller transaction (bridge/backfill callers, CC-05)', () => {
  it('rolls back with the surrounding transaction and commits with it', () => {
    const f = fixture();
    const outer = f.raw.transaction((fail: boolean) => {
      f.ingest.ingestNormalizedMessage(chatMessage(f.account, { nativeMessageId: 'nested' }), { namespace: 'zalo_chat', cursor: 'n1', position: '1' }, 1, 'nested_ev');
      if (fail) throw new Error('caller aborts after ingest');
    });
    expect(() => outer(true)).toThrow('caller aborts after ingest');
    expectNoEffects(f);

    outer(false);
    expect(count(f, 'care_messages')).toBe(1);
    expect(f.stores.checkpoints.get(f.account.id, 'zalo_chat')!.cursor).toBe('n1');
    expect(f.stores.events.hasEvent(f.account.id, 'nested_ev')).toBe(true);
  });
});

describe('Native message identity is bound to one conversation (Finding 6)', () => {
  it('rejects the same native ID under a different conversation on create, edit, delete and tombstoned replay', () => {
    const f = fixture();
    f.ingest.ingestNormalizedMessage(chatMessage(f.account, { nativeMessageId: 'same' }), undefined, 1);
    const eventsBefore = count(f, 'care_events');
    const wrong = chatMessage(f.account, { nativeMessageId: 'same', externalConversationKey: 'peer:2' });

    expect(codeOf(() => f.ingest.ingestNormalizedMessage(wrong, undefined, 1))).toBe('INVALID_TARGET');
    expect(
      codeOf(() => f.ingest.ingestNormalizedEvent({ type: 'message.edited', eventId: 'w1', accountId: f.account.id, timestampMs: 1, epoch: 1, message: { ...wrong, nativeVersion: '9' } })),
    ).toBe('INVALID_TARGET');
    expect(
      codeOf(() =>
        f.ingest.ingestNormalizedEvent({
          type: 'message.deleted', eventId: 'w2', accountId: f.account.id, timestampMs: 1, epoch: 1,
          nativeMessageNamespace: 'zalo_chat', nativeMessageId: 'same', externalConversationKey: 'peer:2', nativeVersion: null,
        }),
      ),
    ).toBe('INVALID_TARGET');

    expect(f.stores.conversations.listConversations()).toHaveLength(1); // peer:2 was never created
    expect(count(f, 'care_events')).toBe(eventsBefore);

    // a tombstoned message cannot be replayed into another conversation either
    f.ingest.ingestNormalizedEvent({
      type: 'message.deleted', eventId: 'gone', accountId: f.account.id, timestampMs: 2, epoch: 1,
      nativeMessageNamespace: 'zalo_chat', nativeMessageId: 'same', externalConversationKey: 'peer:1', nativeVersion: null,
    });
    expect(codeOf(() => f.ingest.ingestNormalizedMessage(wrong, undefined, 1))).toBe('INVALID_TARGET');
    expect(f.stores.conversations.listConversations()).toHaveLength(1);
  });

  it('allows the same native ID in different namespaces and different accounts', () => {
    const f = fixture({ channel: 'telegram', connectorKind: 'telegram-user' });
    const other = f.stores.accounts.createAccount({ channel: 'telegram', connectorKind: 'telegram-user', nativeAccountId: 'tg2', label: 'tg2' });
    const mk = (account: typeof f.account, ns: string) => chatMessage(account, { nativeMessageId: '42', nativeMessageNamespace: ns });
    f.ingest.ingestNormalizedMessage(mk(f.account, 'telegram_common_box'), undefined, 1);
    f.ingest.ingestNormalizedMessage(mk(f.account, 'telegram_channel_box:1'), undefined, 1);
    f.ingest.ingestNormalizedMessage(mk(other, 'telegram_common_box'), undefined, 1);
    expect(count(f, 'care_messages')).toBe(3);
  });
});

describe('Tombstones win; delete-before-create persists (AC-006, AC-008)', () => {
  it('records a tombstone for a delete that arrives first, and a late create/history cannot resurrect it', () => {
    const f = fixture();
    const del = f.ingest.ingestNormalizedEvent({
      type: 'message.deleted', eventId: 'd1', accountId: f.account.id, timestampMs: 1774880020000, epoch: 1,
      nativeMessageNamespace: 'zalo_chat', nativeMessageId: 'late', externalConversationKey: 'user:late', nativeVersion: '1',
    });
    expect(del.outcome).toBe('tombstone_created');

    const late = f.ingest.ingestNormalizedMessage(
      chatMessage(f.account, { nativeMessageId: 'late', externalConversationKey: 'user:late', origin: 'history', text: 'must not come back' }),
      undefined,
      1,
    );
    expect(late.outcome).toBe('ignored_tombstone');
    const stored = f.stores.messages.getMessageByNativeId(f.account.id, 'zalo_chat', 'late')!;
    expect(stored).toMatchObject({ isDeleted: true, tombstone: true, text: '' });
    expect(dumpCareTables(f.raw)).not.toContain('must not come back');
  });

  it('purges body and metadata of an existing message on delete and refreshes the projection', () => {
    const f = fixture();
    const m = f.ingest.ingestNormalizedMessage(chatMessage(f.account, { nativeMessageId: 'doomed', text: 'SECRET TO PURGE', sentAtMs: 500 }), undefined, 1);
    expect(dumpCareTables(f.raw)).not.toContain('SECRET TO PURGE');

    const del = f.ingest.ingestNormalizedEvent({
      type: 'message.deleted', eventId: 'd2', accountId: f.account.id, timestampMs: 600, epoch: 1,
      nativeMessageNamespace: 'zalo_chat', nativeMessageId: 'doomed', externalConversationKey: 'peer:1', nativeVersion: null,
    });
    expect(del.outcome).toBe('deleted');
    const row = f.raw.prepare('SELECT body_enc, metadata_enc, is_deleted, tombstone FROM care_messages WHERE id = ?').get(m.messageId) as any;
    expect(row).toMatchObject({ body_enc: '', metadata_enc: '', is_deleted: 1, tombstone: 1 });

    const conv = f.stores.conversations.getConversation(m.conversationId!)!;
    expect(conv).toMatchObject({ lastMessageId: null, lastMessageAtMs: 0, waitingSinceMs: null, remoteUnreadCount: 0 });

    // a second delete and a late edit are ignored
    expect(f.ingest.ingestNormalizedEvent({
      type: 'message.deleted', eventId: 'd3', accountId: f.account.id, timestampMs: 700, epoch: 1,
      nativeMessageNamespace: 'zalo_chat', nativeMessageId: 'doomed', externalConversationKey: 'peer:1', nativeVersion: null,
    }).outcome).toBe('ignored_tombstone');
    expect(f.ingest.ingestNormalizedEvent({
      type: 'message.edited', eventId: 'e9', accountId: f.account.id, timestampMs: 800, epoch: 1,
      message: chatMessage(f.account, { nativeMessageId: 'doomed', nativeVersion: '9', text: 'resurrect' }),
    }).outcome).toBe('ignored_tombstone');
  });

  it('a created/edited payload flagged deleted deletes the message we already hold', () => {
    const f = fixture();
    const held = f.ingest.ingestNormalizedMessage(chatMessage(f.account, { nativeMessageId: 'flag', text: 'FLAGGED BODY', nativeVersion: '1' }), undefined, 1);
    const again = f.ingest.ingestNormalizedMessage(chatMessage(f.account, { nativeMessageId: 'flag', isDeleted: true }), undefined, 1);
    expect(again).toMatchObject({ outcome: 'deleted', messageId: held.messageId });
    expect(f.stores.messages.getMessage(held.messageId!)).toMatchObject({ isDeleted: true, text: '' });
    expect(f.stores.conversations.getConversation(held.conversationId!)).toMatchObject({ waitingSinceMs: null, remoteUnreadCount: 0 });

    const held2 = f.ingest.ingestNormalizedMessage(chatMessage(f.account, { nativeMessageId: 'flag2', nativeVersion: '1' }), undefined, 1);
    const viaEdit = f.ingest.ingestNormalizedEvent({
      type: 'message.edited', eventId: 'flag_edit', accountId: f.account.id, timestampMs: 1, epoch: 1,
      message: chatMessage(f.account, { nativeMessageId: 'flag2', nativeVersion: '2', isDeleted: true }),
    });
    expect(viaEdit).toMatchObject({ outcome: 'deleted', messageId: held2.messageId });
  });

  it('a message already flagged deleted on arrival only stores the tombstone', () => {
    const f = fixture();
    const res = f.ingest.ingestNormalizedMessage(chatMessage(f.account, { isDeleted: true, text: 'dead on arrival' }), undefined, 1);
    expect(res.outcome).toBe('tombstone_created');
    expect(f.stores.conversations.getConversation(res.conversationId!)).toMatchObject({ lastMessageId: null, remoteUnreadCount: 0, waitingSinceMs: null });
    expect(dumpCareTables(f.raw)).not.toContain('dead on arrival');
  });
});

describe('Edit version ordering is adapter-owned and never guessed (Finding 9)', () => {
  const edit = (f: ReturnType<typeof fixture>, version: string | null, text: string, id = 'v') =>
    f.ingest.ingestNormalizedEvent({
      type: 'message.edited', eventId: `ed_${Math.random()}`, accountId: f.account.id, timestampMs: 1, epoch: 1,
      message: chatMessage(f.account, { nativeMessageId: id, nativeVersion: version, text }),
    });

  it('orders numerically ("10" > "9"), ignores older/equal versions and keeps the newest text', () => {
    const f = fixture({ channel: 'telegram', connectorKind: 'telegram-user' });
    f.ingest.ingestNormalizedMessage(chatMessage(f.account, { nativeMessageId: 'v', nativeVersion: '9', text: 'v9' }), undefined, 1);

    expect(edit(f, '10', 'v10').outcome).toBe('edited');
    expect(edit(f, '8', 'v8').outcome).toBe('ignored_stale_version');
    expect(edit(f, '10', 'v10 again').outcome).toBe('ignored_stale_version');
    expect(edit(f, '9007199254740993', 'big').outcome).toBe('edited');
    expect(edit(f, '9007199254740992', 'big-1').outcome).toBe('ignored_stale_version');
    const msg = f.stores.messages.getMessageByNativeId(f.account.id, 'telegram_common_box', 'v')!;
    expect(msg).toMatchObject({ text: 'big', nativeVersion: '9007199254740993' });
  });

  it('does not overwrite on unordered versions and never falls back to arrival time', () => {
    const f = fixture();
    f.ingest.ingestNormalizedMessage(chatMessage(f.account, { nativeMessageId: 'v', nativeVersion: '5', text: 'original' }), undefined, 1);
    for (const version of [null, 'v6', 'abc', '', '5.x', '1e9']) {
      expect(edit(f, version, 'should not apply').outcome).toBe('ignored_unordered_version');
    }
    const msg = f.stores.messages.getMessageByNativeId(f.account.id, 'zalo_chat', 'v')!;
    expect(msg).toMatchObject({ text: 'original', nativeVersion: '5' });

    // an unversioned original can't be ordered against anything either
    f.ingest.ingestNormalizedMessage(chatMessage(f.account, { nativeMessageId: 'u', nativeVersion: null, text: 'unversioned' }), undefined, 1);
    expect(edit(f, '2', 'edit of unversioned', 'u').outcome).toBe('ignored_unordered_version');
    expect(f.stores.messages.getMessageByNativeId(f.account.id, 'zalo_chat', 'u')!.text).toBe('unversioned');
  });

  it('an edit of a never-seen message is its first sight; direction is immutable', () => {
    const f = fixture();
    const first = edit(f, '3', 'first sight', 'fresh');
    expect(first.outcome).toBe('created');
    expect(
      codeOf(() =>
        f.ingest.ingestNormalizedEvent({
          type: 'message.edited', eventId: 'dir', accountId: f.account.id, timestampMs: 1, epoch: 1,
          message: chatMessage(f.account, { nativeMessageId: 'fresh', nativeVersion: '4', direction: 'out', senderRole: 'operator', senderIdentityKey: null }),
        }),
      ),
    ).toBe('INVALID_TARGET');
  });
});

describe('Senders and identities (Finding 6)', () => {
  it('auto-creates a customer only for customer-role senders and keeps identities account-scoped', () => {
    const f = fixture();
    const other = f.stores.accounts.createAccount({ channel: 'zalo', connectorKind: 'fake', nativeAccountId: 'second', label: 'b' });

    f.ingest.ingestNormalizedMessage(chatMessage(f.account, { senderIdentityKey: 'staff:9', senderRole: 'operator', direction: 'out' }), undefined, 1);
    expect(count(f, 'care_customers')).toBe(0); // an operator is never turned into a customer
    expect(count(f, 'care_identities')).toBe(0);

    f.ingest.ingestNormalizedMessage(chatMessage(f.account, { senderIdentityKey: 'cust:1' }), undefined, 1);
    f.ingest.ingestNormalizedMessage(chatMessage(f.account, { senderIdentityKey: 'cust:1', externalConversationKey: 'peer:9' }), undefined, 1);
    f.ingest.ingestNormalizedMessage(chatMessage(other, { senderIdentityKey: 'cust:1' }), undefined, 1);
    expect(count(f, 'care_identities')).toBe(2); // one per account, reused within an account
    expect(count(f, 'care_customers')).toBe(2);
    const identities = f.raw.prepare('SELECT DISTINCT account_id FROM care_identities').all();
    expect(identities).toHaveLength(2);
  });

  it('stores email senders in the email identity namespace with a temporary customer email', () => {
    const f = fixture({ channel: 'email', connectorKind: 'gmail-composio' });
    f.ingest.ingestNormalizedMessage(emailMessage(f.account, { senderIdentityKey: 'Buyer@Example.com' }), undefined, 1);
    const id = f.stores.identities.getIdentityByExternal(f.account.id, 'email', 'Buyer@Example.com')!;
    expect(id.namespace).toBe('email');
    expect(f.stores.customers.getCustomer(id.customerId)!.email).toBe('Buyer@Example.com');
  });
});

describe('Non-message events share the same validated boundary (Finding 12)', () => {
  it('conversation.updated: encrypted title, channel-valid kind, kind change recomputes waiting, title not journaled', () => {
    const f = fixture({ nativeAccountId: 'self-uid' });
    const group = chatMessage(f.account, { externalConversationKey: 'g:1', metadata: { type: 'chat', conversationKind: 'group' } });
    const created = f.ingest.ingestNormalizedMessage(group, undefined, 1);
    expect(f.stores.conversations.getConversation(created.conversationId!)!.waitingSinceMs).toBeNull(); // group banter

    const res = f.ingest.ingestNormalizedEvent({
      type: 'conversation.updated', eventId: 'cu1', accountId: f.account.id, timestampMs: 2, epoch: 1,
      externalConversationKey: 'g:1', title: 'SECRET GROUP TITLE', kind: 'direct',
    });
    expect(res.outcome).toBe('conversation_updated');
    const conv = f.stores.conversations.getConversation(created.conversationId!)!;
    expect(conv).toMatchObject({ title: 'SECRET GROUP TITLE', kind: 'direct' });
    expect(conv.waitingSinceMs).toBe(group.sentAtMs); // now a DM: the unanswered message counts
    expect(dumpCareTables(f.raw)).not.toContain('SECRET GROUP TITLE');
    expect(JSON.stringify(f.stores.events.listEventsSince(0))).not.toContain('SECRET GROUP TITLE');

    expect(codeOf(() => f.ingest.ingestNormalizedEvent({
      type: 'conversation.updated', eventId: 'cu2', accountId: f.account.id, timestampMs: 3, epoch: 1, externalConversationKey: 'g:1', kind: 'email_thread',
    }))).toBe('INVALID_TARGET');

    // unknown conversations are created with the channel default kind when none is given
    const created2 = f.ingest.ingestNormalizedEvent({
      type: 'conversation.updated', eventId: 'cu3', accountId: f.account.id, timestampMs: 3, epoch: 1, externalConversationKey: 'brand:new', title: 'N',
    });
    expect(f.stores.conversations.getConversation(created2.conversationId!)!.kind).toBe('direct');
  });

  it('account.status: note encrypted on the account, journal carries only status + a valid error code', () => {
    const f = fixture();
    f.ingest.ingestNormalizedEvent({
      type: 'account.status', eventId: 'st1', accountId: f.account.id, timestampMs: 1, epoch: 1,
      healthStatus: 'error', errorNote: 'Token expired for +84901234567', errorCode: 'AUTH_EXPIRED',
    });
    f.ingest.ingestNormalizedEvent({
      type: 'account.status', eventId: 'st2', accountId: f.account.id, timestampMs: 2, epoch: 1,
      healthStatus: 'degraded', errorCode: 'free text with spaces',
    });
    const account = f.stores.accounts.getAccount(f.account.id)!;
    expect(account).toMatchObject({ healthStatus: 'degraded', healthNote: 'Token expired for +84901234567' });
    const events = f.stores.events.listEventsSince(0);
    expect(events[0].payload).toMatchObject({ healthStatus: 'error', errorCode: 'AUTH_EXPIRED' });
    expect(events[1].payload.errorCode).toBeNull();
    expect(JSON.stringify(events)).not.toContain('84901234567');
    expect(dumpCareTables(f.raw)).not.toContain('84901234567');

    f.ingest.ingestNormalizedEvent({ type: 'account.status', eventId: 'st3', accountId: f.account.id, timestampMs: 3, epoch: 1, healthStatus: 'healthy' });
    expect(f.stores.accounts.getAccount(f.account.id)).toMatchObject({ healthStatus: 'healthy', healthNote: null });
    expect(codeOf(() => f.ingest.ingestNormalizedEvent({ type: 'account.status', eventId: 'st4', accountId: f.account.id, timestampMs: 4, epoch: 1, healthStatus: 'bogus' as never }))).toBe('INVALID_COMMAND');
  });

  it('read.updated never touches the dashboard local-seen marker; inbound and outbound coverage are separate', () => {
    const f = fixture();
    const q1 = f.ingest.ingestNormalizedMessage(chatMessage(f.account, { nativeMessageId: 'q1', sentAtMs: 100 }), undefined, 1);
    f.ingest.ingestNormalizedMessage(chatMessage(f.account, { nativeMessageId: 'q2', sentAtMs: 200 }), undefined, 1);
    const reply = f.ingest.ingestNormalizedMessage(
      chatMessage(f.account, { nativeMessageId: 'r1', sentAtMs: 300, direction: 'out', senderRole: 'operator', senderIdentityKey: null }),
      undefined,
      1,
    );
    const conv = () => f.stores.conversations.getConversation(q1.conversationId!)!;
    expect(conv().remoteUnreadCount).toBe(2);

    const read = (id: string, direction?: 'inbound' | 'outbound', ns?: string) =>
      f.ingest.ingestNormalizedEvent({
        type: 'read.updated', eventId: `rd_${id}_${direction}`, accountId: f.account.id, timestampMs: 400, epoch: 1,
        externalConversationKey: 'peer:1', remoteReadMessageId: id, direction, nativeMessageNamespace: ns,
      });

    expect(read('q1').outcome).toBe('read_updated'); // default direction: inbound
    expect(conv()).toMatchObject({ remoteUnreadCount: 1, localSeenMessageId: null, remoteReceiptMessageId: null });
    expect(conv().remoteReadMessageId).toBe(q1.messageId);

    expect(read('r1', 'outbound', 'zalo_chat').outcome).toBe('read_updated');
    expect(conv()).toMatchObject({ remoteReceiptMessageId: reply.messageId, localSeenMessageId: null, remoteUnreadCount: 1 });

    // older coverage never regresses the watermark
    read('q2', 'inbound');
    expect(conv().remoteUnreadCount).toBe(0);
    read('q1', 'inbound'); // distinct eventId from the first (direction was undefined before)
    expect(conv().remoteReadMessageId).not.toBe(q1.messageId);
    expect(conv().localSeenMessageId).toBeNull();
  });

  it('read.updated for an unknown conversation or message becomes a durable pending receipt, resolved when the target lands', () => {
    const f = fixture();
    const read = (key: string, id: string, eventId: string): NormalizedEvent => ({
      type: 'read.updated', eventId, accountId: f.account.id, timestampMs: 1, epoch: 1,
      externalConversationKey: key, remoteReadMessageId: id, nativeMessageNamespace: 'zalo_chat',
    });
    expect(f.ingest.ingestNormalizedEvent(read('nope', 'x', 'rd1')).outcome).toBe('read_pending'); // conversation unknown too
    const seed = f.ingest.ingestNormalizedMessage(chatMessage(f.account, { nativeMessageId: 'known', sentAtMs: 50 }), undefined, 1);
    expect(f.ingest.ingestNormalizedEvent(read('peer:1', 'later-id', 'rd2')).outcome).toBe('read_pending');
    expect(count(f, 'care_pending_receipts')).toBe(2);
    expect(f.stores.conversations.getConversation(seed.conversationId!)).toMatchObject({ remoteReadMessageId: null, localSeenMessageId: null, remoteUnreadCount: 1 });

    // the target of rd2 lands: the ORIGINAL receipt applies, exactly once, and the pending row is consumed
    f.ingest.ingestNormalizedMessage(chatMessage(f.account, { nativeMessageId: 'later-id', sentAtMs: 60 }), undefined, 1);
    const conv = f.stores.conversations.getConversation(seed.conversationId!)!;
    expect(conv.remoteReadMessageId).toBeTruthy();
    expect(conv.remoteUnreadCount).toBe(0);
    expect(conv.localSeenMessageId).toBeNull();
    expect(count(f, 'care_pending_receipts')).toBe(1); // only the receipt for the still-unknown conversation 'nope'
    // replaying the same provider event is suppressed by the ledger, no second effect
    expect(f.ingest.ingestNormalizedEvent(read('peer:1', 'later-id', 'rd2')).outcome).toBe('duplicate_event');
    expect(f.stores.events.listEventsSince(0).filter((e) => e.eventId === 'rd2')).toHaveLength(1);
  });

  it('pending receipts are account-scoped, match the stated namespace and drop on retention purge', () => {
    const f = fixture({ channel: 'telegram', connectorKind: 'telegram-user' });
    const other = f.stores.accounts.createAccount({ channel: 'telegram', connectorKind: 'telegram-user', nativeAccountId: 'tg-other', label: 'o' });
    // an account-scoped receipt for a non-monotonic reference (no namespace => cannot derive an order)
    f.ingest.ingestNormalizedEvent({ type: 'read.updated', eventId: 'p1', accountId: f.account.id, timestampMs: 1, epoch: 1, externalConversationKey: 'peer:1', remoteReadMessageId: '77' });
    // the other account receives the same native id: must not consume this account's receipt
    const wrongAccount = f.ingest.ingestNormalizedMessage(chatMessage(other, { nativeMessageId: '77', sentAtMs: 5 }), undefined, 1);
    expect(f.stores.conversations.getConversation(wrongAccount.conversationId!)!.remoteReadMessageId).toBeNull();
    expect(count(f, 'care_pending_receipts')).toBe(1);

    f.ingest.ingestNormalizedMessage(chatMessage(f.account, { nativeMessageId: '77', sentAtMs: 5 }), undefined, 1);
    expect(count(f, 'care_pending_receipts')).toBe(0);

    f.ingest.ingestNormalizedEvent({ type: 'read.updated', eventId: 'p2', accountId: f.account.id, timestampMs: 1, epoch: 1, externalConversationKey: 'peer:1', remoteReadMessageId: '999' });
    expect(count(f, 'care_pending_receipts')).toBe(1);
    expect(f.stores.conversations.purgePendingReceiptsBefore(Date.now() + 1000)).toBe(1);
  });

  it('read.updated without a namespace refuses an ambiguous native ID and rejects another conversation\'s message', () => {
    const f = fixture({ channel: 'telegram', connectorKind: 'telegram-user' });
    const mk = (ns: string, key = 'peer:1') => chatMessage(f.account, { nativeMessageId: '7', nativeMessageNamespace: ns, externalConversationKey: key });
    const a = f.ingest.ingestNormalizedMessage(mk('telegram_common_box'), undefined, 1);
    f.ingest.ingestNormalizedMessage(mk('telegram_channel_box:5', 'peer:2'), undefined, 1);
    const read = (key: string, ns?: string) =>
      f.ingest.ingestNormalizedEvent({ type: 'read.updated', eventId: `r_${key}_${ns}`, accountId: f.account.id, timestampMs: 1, epoch: 1, externalConversationKey: key, remoteReadMessageId: '7', nativeMessageNamespace: ns });

    expect(read('peer:1').outcome).toBe('read_unresolved'); // two messages with native id 7: ambiguous
    expect(read('peer:1', 'telegram_common_box').outcome).toBe('read_updated');
    expect(f.stores.conversations.getConversation(a.conversationId!)!.remoteReadMessageId).toBe(a.messageId);
    expect(codeOf(() => read('peer:2', 'telegram_common_box'))).toBe('INVALID_TARGET');
  });

  it('delivery.confirmed is validated and journaled with ID-only fields', () => {
    const f = fixture();
    const res = f.ingest.ingestNormalizedEvent({ type: 'delivery.confirmed', eventId: 'dc1', accountId: f.account.id, timestampMs: 1, epoch: 1, clientRequestId: 'req-9', nativeMessageId: 'n-9', receiptLevel: 'delivered' });
    expect(res.outcome).toBe('delivery_confirmed');
    expect(f.stores.events.listEventsSince(0)[0].payload).toMatchObject({ clientRequestId: 'req-9', nativeMessageId: 'n-9', receiptLevel: 'delivered' });
    expect(codeOf(() => f.ingest.ingestNormalizedEvent({ type: 'delivery.confirmed', eventId: 'dc2', accountId: f.account.id, timestampMs: 1, epoch: 1, clientRequestId: 'r', nativeMessageId: 'n', receiptLevel: 'seen' as never }))).toBe('INVALID_COMMAND');
  });

  it('rejects unsupported event types', () => {
    const f = fixture();
    expect(codeOf(() => f.ingest.ingestNormalizedEvent({ type: 'mystery', eventId: 'x', accountId: f.account.id, timestampMs: 1 } as never))).toBe('INVALID_COMMAND');
  });
});
