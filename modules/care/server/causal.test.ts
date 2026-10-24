import { afterEach, describe, expect, it } from 'vitest';
import { CareError } from '../../_lib/care-kit/errors.js';
import type { NormalizedEvent, NormalizedMessage } from '../../_lib/care-kit/types.js';
import { assignAuto, chatMessage, dumpCareTables, emailMessage, memoryFixture } from './test-fixtures.js';

const open: Array<() => void> = [];
afterEach(() => open.splice(0).forEach((close) => close()));

function fixture(over: Parameters<typeof memoryFixture>[0] = {}) {
  const f = memoryFixture(over);
  open.push(f.close);
  const ns = f.account.channel === 'telegram' ? 'telegram_common_box' : f.account.channel === 'email' ? 'gmail_mailbox' : 'zalo_chat';
  const msg = (id: string, sentAtMs: number, extra: Partial<NormalizedMessage> = {}) =>
    chatMessage(f.account, { nativeMessageId: id, nativeMessageNamespace: ns, sentAtMs, ...extra });
  const reply = (id: string, sentAtMs: number, extra: Partial<NormalizedMessage> = {}) =>
    msg(id, sentAtMs, { direction: 'out', senderRole: 'operator', senderIdentityKey: null, ...extra });
  const put = (m: NormalizedMessage, eventId?: string) => f.ingest.ingestNormalizedMessage(m, undefined, 1, eventId);
  const conv = (key = 'peer:1') => f.stores.conversations.getConversationByExternalKey(f.account.id, key)!;
  const count = (table: string) => (f.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  const event = (e: Record<string, unknown>) =>
    f.ingest.ingestNormalizedEvent({ accountId: f.account.id, timestampMs: 1, epoch: 1, ...e } as NormalizedEvent);
  const read = (id: string, eventId: string, extra: Record<string, unknown> = {}) =>
    event({ type: 'read.updated', eventId, externalConversationKey: 'peer:1', remoteReadMessageId: id, nativeMessageNamespace: ns, ...extra });
  return { ...f, ns, msg, reply, put, conv, count, event, read };
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

describe('Waiting uses native causal order / reply linkage, never the random local id (review 14)', () => {
  it('Telegram: same-timestamp question(10) then reply(20) resolves; reply(10) then question(20) stays waiting', () => {
    const a = fixture({ channel: 'telegram', connectorKind: 'telegram-user' });
    a.put(a.msg('10', 500));
    a.put(a.reply('20', 500));
    expect(a.conv().waitingSinceMs).toBeNull();

    const b = fixture({ channel: 'telegram', connectorKind: 'telegram-user' });
    b.put(b.reply('10', 500));
    b.put(b.msg('20', 500));
    expect(b.conv().waitingSinceMs).toBe(500);
  });

  it('is independent of ingest order and of which local id sorts first', () => {
    for (const order of [['q', 'r'], ['r', 'q']]) {
      const f = fixture({ channel: 'telegram', connectorKind: 'telegram-user' });
      const items: Record<string, NormalizedMessage> = { q: f.msg('10', 500), r: f.reply('20', 500) };
      for (const k of order) f.put(items[k]);
      expect(f.conv().waitingSinceMs, order.join('')).toBeNull();
    }
  });

  it('Zalo/Gmail have no derived order: equal timestamps stay waiting (conservative) unless the adapter supplies one', () => {
    const f = fixture();
    f.put(f.msg('q', 500));
    f.put(f.reply('r', 500));
    expect(f.conv().waitingSinceMs).toBe(500);

    const g = fixture();
    g.put(g.msg('q', 500, { nativeOrder: '7' }));
    g.put(g.reply('r', 500, { nativeOrder: '8' }));
    expect(g.conv().waitingSinceMs).toBeNull();

    const h = fixture();
    h.put(h.reply('r', 500, { nativeOrder: '7' }));
    h.put(h.msg('q', 500, { nativeOrder: '8' }));
    expect(h.conv().waitingSinceMs).toBe(500);
  });

  it('an explicit quote links a reply to its question even at the same timestamp, and only to that question', () => {
    const f = fixture({ nativeAccountId: 'self' });
    f.put(f.msg('q1', 500));
    f.put(f.msg('q2', 500));
    f.put(f.reply('r', 500, { metadata: { type: 'chat', quote: { messageId: 'q1' } } }));
    // q1 is answered by linkage; q2 (same ms, unlinked, unordered) is still waiting
    expect(f.conv().waitingSinceMs).toBe(500);
    f.raw.prepare(`UPDATE care_messages SET is_deleted = 1 WHERE native_message_id = 'q2'`).run();
    f.stores.conversations.recomputeProjection(f.conv().id);
    expect(f.conv().waitingSinceMs).toBeNull();
  });

  it('email In-Reply-To links a reply to the RFC Message-ID of the question', () => {
    const f = fixture({ channel: 'email', connectorKind: 'gmail-composio' });
    const mail = (id: string, over: Partial<NormalizedMessage>) => emailMessage(f.account, { nativeMessageId: id, sentAtMs: 900, ...over });
    f.ingest.ingestNormalizedMessage(
      mail('g1', { metadata: { type: 'email', subject: 'Q', from: 'a@b.co', to: ['me@x.co'], messageIdHeader: '<q@mail>' } }),
      undefined,
      1,
    );
    expect(f.stores.conversations.getConversationByExternalKey(f.account.id, 'thread:1')!.waitingSinceMs).toBe(900);
    f.ingest.ingestNormalizedMessage(
      mail('g2', {
        direction: 'out', senderRole: 'operator', senderIdentityKey: null,
        metadata: { type: 'email', subject: 'Re: Q', from: 'me@x.co', to: ['a@b.co'], inReplyToHeader: '<q@mail>' },
      }),
      undefined,
      1,
    );
    expect(f.stores.conversations.getConversationByExternalKey(f.account.id, 'thread:1')!.waitingSinceMs).toBeNull();
  });

  it('a linked reply that is later deleted stops answering the question', () => {
    const f = fixture();
    f.put(f.msg('q', 500));
    f.put(f.reply('r', 500, { metadata: { type: 'chat', quote: { messageId: 'q' } } }));
    expect(f.conv().waitingSinceMs).toBeNull();
    f.event({
      type: 'message.deleted', eventId: 'del-r', nativeMessageNamespace: 'zalo_chat', nativeMessageId: 'r',
      externalConversationKey: 'peer:1', nativeVersion: null,
    });
    expect(f.conv().waitingSinceMs).toBe(500);
  });

  it('different timestamps still order across unordered messages; order keys beat a skewed timestamp inside one namespace', () => {
    const f = fixture({ channel: 'telegram', connectorKind: 'telegram-user' });
    f.put(f.msg('10', 900));
    f.put(f.reply('20', 800)); // later native id, earlier clock: native order wins => answered
    expect(f.conv().waitingSinceMs).toBeNull();
  });
});

describe('Read coverage is expressed in native coordinates (review 11)', () => {
  it('same-time Telegram messages: read up to native 10 leaves 20 unread whatever the local ids', () => {
    for (const idOrder of [['z-first', 'a-second'], ['a-first', 'z-second']]) {
      const f = fixture({ channel: 'telegram', connectorKind: 'telegram-user' });
      const c = f.stores.conversations.upsertConversation({ accountId: f.account.id, externalKey: 'peer:1', kind: 'direct', title: 't' });
      f.stores.messages.insertMessage(f.msg('10', 200), c.id, null, idOrder[0]);
      f.stores.messages.insertMessage(f.msg('20', 200), c.id, null, idOrder[1]);
      f.stores.conversations.recomputeProjection(c.id);
      expect(f.conv().remoteUnreadCount).toBe(2);
      f.read('10', 'r10');
      expect(f.conv().remoteUnreadCount).toBe(1);
      f.read('20', 'r20');
      expect(f.conv().remoteUnreadCount).toBe(0);
    }
  });

  it('a Telegram receipt for a message not held yet covers it (and earlier ones) by native id once they arrive', () => {
    const f = fixture({ channel: 'telegram', connectorKind: 'telegram-user' });
    f.put(f.msg('5', 100));
    f.read('30', 'r30'); // max_id 30, message 30 not here yet
    expect(f.conv().remoteUnreadCount).toBe(0);
    expect(f.count('care_pending_receipts')).toBe(0); // ordered namespace: no need to wait
    f.put(f.msg('25', 120)); // late-arriving, covered by max_id 30
    expect(f.conv().remoteUnreadCount).toBe(0);
    f.put(f.msg('31', 130)); // beyond the watermark
    expect(f.conv().remoteUnreadCount).toBe(1);
    f.read('20', 'r20'); // older coverage: ignored
    expect(f.conv().remoteUnreadCount).toBe(1);
    expect(f.conv().localSeenMessageId).toBeNull();
  });

  it('forward-only by native key, not by timestamp or local id', () => {
    const f = fixture({ channel: 'telegram', connectorKind: 'telegram-user' });
    f.put(f.msg('10', 900));
    f.put(f.msg('20', 100)); // later native id, earlier clock
    f.read('20', 'r20');
    f.read('10', 'r10'); // must not regress even though 10 has the later timestamp
    expect(f.conv().remoteUnreadCount).toBe(0);
  });

  it('unordered namespaces: equal timestamps are never claimed covered; explicit nativeOrder fixes that', () => {
    const f = fixture();
    f.put(f.msg('a', 200));
    f.put(f.msg('b', 200));
    f.read('a', 'ra');
    expect(f.conv().remoteUnreadCount).toBe(1); // b shares a's timestamp with no order: stays unread

    const g = fixture();
    g.put(g.msg('a', 200, { nativeOrder: '1' }));
    g.put(g.msg('b', 200, { nativeOrder: '2' }));
    g.read('a', 'ra');
    expect(g.conv().remoteUnreadCount).toBe(1);
    g.read('b', 'rb');
    expect(g.conv().remoteUnreadCount).toBe(0);
  });

  it('outbound receipts keep their own native coverage and never move unread', () => {
    const f = fixture({ channel: 'telegram', connectorKind: 'telegram-user' });
    f.put(f.msg('1', 100));
    const out = f.put(f.reply('2', 110));
    f.read('2', 'rcpt', { direction: 'outbound' });
    expect(f.conv()).toMatchObject({ remoteReceiptMessageId: out.messageId, remoteUnreadCount: 1, localSeenMessageId: null });
  });
});

describe('Pending receipts and tombstones are durable, account-scoped effects (review 10, 13; read/delete atomicity)', () => {
  it('receipt-before-target survives a fault between the two events and resolves exactly once', () => {
    const f = fixture();
    f.event({ type: 'read.updated', eventId: 'rcpt', externalConversationKey: 'peer:1', remoteReadMessageId: 'm1', nativeMessageNamespace: 'zalo_chat' });
    expect(f.count('care_pending_receipts')).toBe(1);

    // a fault while the target is being ingested rolls the resolution back with it
    f.raw.exec(`CREATE TRIGGER boom BEFORE INSERT ON care_events BEGIN SELECT RAISE(FAIL, 'crash'); END;`);
    expect(() => f.put(f.msg('m1', 100))).toThrow('crash');
    f.raw.exec('DROP TRIGGER boom');
    expect(f.count('care_pending_receipts')).toBe(1);
    expect(f.count('care_messages')).toBe(0);

    const created = f.put(f.msg('m1', 100));
    expect(f.count('care_pending_receipts')).toBe(0);
    expect(f.conv()).toMatchObject({ remoteUnreadCount: 0, remoteReadMessageId: created.messageId, localSeenMessageId: null });
  });

  it('a receipt for a target that arrives deleted does not resurrect it or leak a pending row forever', () => {
    const f = fixture();
    f.event({ type: 'read.updated', eventId: 'rcpt', externalConversationKey: 'peer:1', remoteReadMessageId: 'gone', nativeMessageNamespace: 'zalo_chat' });
    f.event({ type: 'message.deleted', eventId: 'del', nativeMessageNamespace: 'zalo_chat', nativeMessageId: 'gone', externalConversationKey: 'peer:1', nativeVersion: null });
    const late = f.put(f.msg('gone', 100));
    expect(late.outcome).toBe('ignored_tombstone');
    expect(f.stores.messages.getMessage(late.messageId!)).toMatchObject({ isDeleted: true, text: '' });
    // the pending row stays until retention purges it, and it never touches the projection
    expect(f.conv()).toMatchObject({ remoteReadMessageId: null, remoteUnreadCount: 0 });
    expect(f.stores.conversations.purgePendingReceiptsBefore(Date.now() + 1000)).toBe(1);
  });

  it('peerless delete: no conversation invented, bound later, body never stored', () => {
    const f = fixture({ channel: 'telegram', connectorKind: 'telegram-user' });
    const del = f.event({ type: 'message.deleted', eventId: 'd', nativeMessageNamespace: 'telegram_common_box', nativeMessageId: '10', nativeVersion: null });
    expect(del.outcome).toBe('tombstone_created');
    expect(f.stores.conversations.listConversations()).toHaveLength(0);
    expect(f.count('care_messages')).toBe(0);
    expect(f.stores.messages.getTombstone(f.account.id, 'telegram_common_box', '10')).toMatchObject({ externalConversationKey: null });

    const late = f.put(f.msg('10', 100, { text: 'SECRET LATE BODY' }));
    expect(late.outcome).toBe('ignored_tombstone');
    expect(f.stores.messages.getMessage(late.messageId!)).toMatchObject({ isDeleted: true, tombstone: true, text: '' });
    expect(f.conv()).toMatchObject({ lastMessageId: null, waitingSinceMs: null, remoteUnreadCount: 0 });
    expect(f.stores.messages.getTombstone(f.account.id, 'telegram_common_box', '10')).toBeNull(); // consumed
    expect(dumpCareTables(f.raw)).not.toContain('SECRET LATE BODY');
    expect(f.count('care_jobs')).toBe(0);
  });

  it('a peerless delete of a HELD message resolves the peer from the message and deletes it', () => {
    const f = fixture({ channel: 'telegram', connectorKind: 'telegram-user' });
    f.put(f.msg('10', 100));
    f.put(f.msg('11', 110));
    const del = f.event({ type: 'message.deleted', eventId: 'd', nativeMessageNamespace: 'telegram_common_box', nativeMessageId: '10', nativeVersion: null });
    expect(del.outcome).toBe('deleted');
    expect(f.conv()).toMatchObject({ waitingSinceMs: 110, remoteUnreadCount: 1 });
    expect(f.event({ type: 'message.deleted', eventId: 'd2', nativeMessageNamespace: 'telegram_common_box', nativeMessageId: '10', nativeVersion: null }).outcome).toBe('ignored_tombstone');
  });

  it('a stated peer must agree with the held message and with a bound tombstone', () => {
    const f = fixture({ channel: 'telegram', connectorKind: 'telegram-user' });
    f.put(f.msg('10', 100));
    expect(codeOf(() => f.event({ type: 'message.deleted', eventId: 'bad', nativeMessageNamespace: 'telegram_common_box', nativeMessageId: '10', externalConversationKey: 'peer:2', nativeVersion: null }))).toBe('INVALID_TARGET');

    f.event({ type: 'message.deleted', eventId: 'bound', nativeMessageNamespace: 'telegram_common_box', nativeMessageId: '99', externalConversationKey: 'peer:7', nativeVersion: null });
    expect(codeOf(() => f.event({ type: 'message.deleted', eventId: 'conflict', nativeMessageNamespace: 'telegram_common_box', nativeMessageId: '99', externalConversationKey: 'peer:8', nativeVersion: null }))).toBe('INVALID_TARGET');
    // a late body claiming another peer than the bound tombstone is refused, not re-homed
    expect(codeOf(() => f.put(f.msg('99', 100, { externalConversationKey: 'peer:8' })))).toBe('INVALID_TARGET');
    expect(f.stores.conversations.getConversationByExternalKey(f.account.id, 'peer:8')).toBeNull();
    // the right peer binds it
    expect(f.put(f.msg('99', 100, { externalConversationKey: 'peer:7' })).outcome).toBe('ignored_tombstone');
  });

  it('tombstones and pending receipts never cross accounts, and an edit of a tombstoned unknown message is suppressed', () => {
    const f = fixture({ channel: 'telegram', connectorKind: 'telegram-user' });
    const other = f.stores.accounts.createAccount({ channel: 'telegram', connectorKind: 'telegram-user', nativeAccountId: 'tg-2', label: 'o', desiredState: 'active' });
    f.event({ type: 'message.deleted', eventId: 'd', nativeMessageNamespace: 'telegram_common_box', nativeMessageId: '10', nativeVersion: null });

    const otherMsg = f.ingest.ingestNormalizedMessage(chatMessage(other, { nativeMessageId: '10', sentAtMs: 5 }), undefined, 1);
    expect(otherMsg.outcome).toBe('created'); // account 2 never deleted '10'
    expect(f.stores.messages.getTombstone(f.account.id, 'telegram_common_box', '10')).not.toBeNull();

    const edit = f.event({ type: 'message.edited', eventId: 'e', message: { ...f.msg('10', 100), nativeVersion: '2' } });
    expect(edit.outcome).toBe('ignored_tombstone');
    expect(f.stores.messages.getMessageByNativeId(f.account.id, 'telegram_common_box', '10')!.isDeleted).toBe(true);
  });
});

describe('Genuine live observation after history/recovery/edit (review 12, 15; AC-008)', () => {
  it('history first creates no job; the eligible live sighting creates exactly one, repeats create none', () => {
    const f = fixture();
    assignAuto(f.stores, f.account);
    const first = f.put(f.msg('ov', 100, { origin: 'history' }), 'bf');
    expect(first.jobId).toBeUndefined();
    expect(f.conv()).toMatchObject({ waitingSinceMs: null, remoteUnreadCount: 0 }); // backlog is not a live wait

    const live = f.put(f.msg('ov', 100, { origin: 'live' }), 'live-1');
    expect(live).toMatchObject({ outcome: 'live_observed', messageId: first.messageId });
    expect(live.jobId).toBeDefined();
    expect(f.conv()).toMatchObject({ waitingSinceMs: 100, remoteUnreadCount: 1 });

    expect(f.put(f.msg('ov', 100, { origin: 'live' }), 'live-1').outcome).toBe('duplicate_event');
    expect(f.put(f.msg('ov', 100, { origin: 'live' }), 'live-2').outcome).toBe('duplicate_ignored');
    expect(f.count('care_jobs')).toBe(1);
    expect(f.count('care_messages')).toBe(1);
    // provenance of the first sighting is preserved
    expect(f.stores.messages.getMessage(first.messageId!)).toMatchObject({ origin: 'history', liveObserved: true });
    expect(f.stores.events.listEventsSince(0).map((e) => [e.eventId, e.payload.job])).toEqual([
      ['bf', 'none'],
      ['live-1', 'enqueued'],
      ['live-2', undefined],
    ]);
  });

  it('works from recovery too, and a later history/recovery replay never demotes or re-triggers', () => {
    const f = fixture();
    assignAuto(f.stores, f.account);
    f.put(f.msg('ov', 100, { origin: 'recovery' }));
    f.put(f.msg('ov', 100, { origin: 'live' }));
    f.put(f.msg('ov', 100, { origin: 'history' }));
    f.put(f.msg('ov', 100, { origin: 'recovery' }));
    expect(f.count('care_jobs')).toBe(1);
    expect(f.conv().remoteUnreadCount).toBe(1);
  });

  it('promotion still honours every job gate (no assignment, observe, AI off, legacy, Telegram) and tombstones', () => {
    const noRule = fixture();
    noRule.put(noRule.msg('a', 100, { origin: 'history' }));
    expect(noRule.put(noRule.msg('a', 100)).jobId).toBeUndefined();
    expect(noRule.conv().waitingSinceMs).toBe(100); // still a live, waiting customer — just no automation

    const aiOff = fixture({ aiEnabled: false });
    assignAuto(aiOff.stores, aiOff.account);
    aiOff.put(aiOff.msg('a', 100, { origin: 'history' }));
    expect(aiOff.put(aiOff.msg('a', 100)).jobId).toBeUndefined();

    const tg = fixture({ channel: 'telegram', connectorKind: 'telegram-user' });
    assignAuto(tg.stores, tg.account);
    tg.put(tg.msg('1', 100, { origin: 'history' }));
    expect(tg.put(tg.msg('1', 100)).jobId).toBeUndefined();

    const dead = fixture();
    assignAuto(dead.stores, dead.account);
    dead.put(dead.msg('x', 100, { origin: 'history' }));
    dead.event({ type: 'message.deleted', eventId: 'dx', nativeMessageNamespace: 'zalo_chat', nativeMessageId: 'x', externalConversationKey: 'peer:1', nativeVersion: null });
    expect(dead.put(dead.msg('x', 100)).outcome).toBe('ignored_tombstone');
    expect(dead.count('care_jobs')).toBe(0);
  });

  it('a live observation that contradicts the stored direction/sender is rejected, not promoted', () => {
    const f = fixture();
    f.put(f.msg('ov', 100, { origin: 'history' }));
    expect(codeOf(() => f.put(f.reply('ov', 100)))).toBe('INVALID_TARGET');
    expect(f.stores.messages.getMessageByNativeId(f.account.id, 'zalo_chat', 'ov')!.liveObserved).toBe(false);
  });

  it('first sight through an EDIT stores the latest body, never starts waiting or a turn, and can still be promoted', () => {
    const f = fixture();
    assignAuto(f.stores, f.account);
    const edited = f.event({ type: 'message.edited', eventId: 'fe', message: { ...f.msg('old', 100, { text: 'latest body' }), nativeVersion: '2' } });
    expect(f.stores.messages.getMessage(edited.messageId!)).toMatchObject({ text: 'latest body', origin: 'recovery', liveObserved: false });
    expect(f.count('care_jobs')).toBe(0);
    expect(f.conv()).toMatchObject({ waitingSinceMs: null, remoteUnreadCount: 0 });

    const live = f.put(f.msg('old', 100));
    expect(live.outcome).toBe('live_observed');
    expect(f.count('care_jobs')).toBe(1);
  });

  it('a live created/edited event is never turned into a second job by later edits', () => {
    const f = fixture();
    assignAuto(f.stores, f.account);
    f.put(f.msg('m', 100, { nativeVersion: '1' }));
    f.event({ type: 'message.edited', eventId: 'e1', message: { ...f.msg('m', 100), nativeVersion: '2', text: 'changed' } });
    expect(f.count('care_jobs')).toBe(1);
  });
});
