import { afterEach, describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, type NormalizedMessage } from '../../_lib/care-kit/types.js';
import { isDirectedAtAccount } from './application/projector.js';
import { chatMessage, emailMessage, memoryFixture } from './test-fixtures.js';

const open: Array<() => void> = [];
afterEach(() => open.splice(0).forEach((close) => close()));

function fixture(over: Parameters<typeof memoryFixture>[0] = {}) {
  const f = memoryFixture(over);
  open.push(f.close);
  const msg = (id: string, sentAtMs: number, extra: Partial<NormalizedMessage> = {}) =>
    chatMessage(f.account, { nativeMessageId: id, sentAtMs, ...extra });
  const reply = (id: string, sentAtMs: number, extra: Partial<NormalizedMessage> = {}) =>
    msg(id, sentAtMs, { direction: 'out', senderRole: 'operator', senderIdentityKey: null, ...extra });
  const put = (m: NormalizedMessage) => f.ingest.ingestNormalizedMessage(m, undefined, 1);
  const conv = (key = 'peer:1') => f.stores.conversations.getConversationByExternalKey(f.account.id, key)!;
  const del = (id: string, key = 'peer:1') =>
    f.ingest.ingestNormalizedEvent({
      type: 'message.deleted', eventId: `del_${id}`, accountId: f.account.id, timestampMs: 9_999, epoch: 1,
      nativeMessageNamespace: 'zalo_chat', nativeMessageId: id, externalConversationKey: key, nativeVersion: null,
    });
  return { ...f, msg, reply, put, conv, del };
}

describe('Projection is derived causally, not accumulated by arrival order (AC-007, Findings 7, 11)', () => {
  it('live question@200, then history outbound@100 and history inbound@50: pointer, unread and waiting are untouched', () => {
    const f = fixture();
    const q = f.put(f.msg('q', 200));
    f.put(f.reply('old-out', 100, { origin: 'history' }));
    f.put(f.msg('old-in', 50, { origin: 'history' }));

    expect(f.conv()).toMatchObject({ lastMessageId: q.messageId, lastMessageAtMs: 200, waitingSinceMs: 200, remoteUnreadCount: 1 });
  });

  it('a late LIVE outbound at 100 does not resolve the newer inbound at 200 (coordinator probe)', () => {
    const f = fixture();
    const q = f.put(f.msg('q', 200));
    f.put(f.reply('late-reply', 100));
    expect(f.conv()).toMatchObject({ waitingSinceMs: 200, lastMessageId: q.messageId });
  });

  it('an out-of-order live burst resolves to the OLDEST unanswered inbound, with exact unread', () => {
    const f = fixture();
    const last = f.put(f.msg('c', 300));
    f.put(f.msg('a', 100));
    f.put(f.msg('b', 200));
    expect(f.conv()).toMatchObject({ waitingSinceMs: 100, remoteUnreadCount: 3, lastMessageId: last.messageId, lastMessageAtMs: 300 });
  });

  it('a later reply resolves everything before it; a newer inbound restarts the clock at its own time', () => {
    const f = fixture();
    f.put(f.msg('a', 100));
    f.put(f.msg('b', 200));
    f.put(f.reply('r', 250));
    expect(f.conv().waitingSinceMs).toBeNull();
    f.put(f.msg('c', 400));
    f.put(f.msg('d', 410));
    expect(f.conv().waitingSinceMs).toBe(400);
    // unread is a provider-side concept: a reply does not mark anything read
    expect(f.conv().remoteUnreadCount).toBe(4);
  });

  it('a later reply recovered from history/recovery resolves waiting causally (no false waiting after reconnect)', () => {
    const f = fixture();
    f.put(f.msg('q', 200));
    expect(f.conv().waitingSinceMs).toBe(200);
    f.put(f.reply('recovered', 300, { origin: 'recovery' }));
    expect(f.conv().waitingSinceMs).toBeNull();
  });

  it('history and recovery inbound never start waiting or add unread', () => {
    const f = fixture();
    f.put(f.msg('h', 100, { origin: 'history' }));
    f.put(f.msg('r', 110, { origin: 'recovery' }));
    expect(f.conv()).toMatchObject({ waitingSinceMs: null, remoteUnreadCount: 0, lastMessageAtMs: 110 });
  });

  it('system/echo-style outbound without an operator/agent/self role never resolves waiting', () => {
    const f = fixture();
    f.put(f.msg('q', 200));
    f.put(f.msg('sys', 300, { direction: 'out', senderRole: 'system', senderIdentityKey: null }));
    expect(f.conv().waitingSinceMs).toBe(200);
    f.put(f.msg('mobile', 310, { direction: 'out', senderRole: 'self', senderIdentityKey: null }));
    expect(f.conv().waitingSinceMs).toBeNull(); // the user answering from their phone resolves it
  });

  it('equal timestamps: pointer ties break deterministically by local id; an equal-ms reply does not resolve', () => {
    const f = fixture();
    const a = f.put(f.msg('a', 500));
    const b = f.put(f.msg('b', 500));
    const expected = [a.messageId!, b.messageId!].sort().at(-1);
    expect(f.conv().lastMessageId).toBe(expected);
    f.put(f.reply('same-ms', 500));
    expect(f.conv().waitingSinceMs).toBe(500);
  });

  it('ingest order does not matter: any permutation converges to the same projection', () => {
    const build = (order: number[]) => {
      const f = fixture();
      const messages = [f.msg('a', 100), f.reply('r', 150), f.msg('b', 200), f.msg('c', 300, { origin: 'history' }), f.msg('d', 250)];
      for (const i of order) f.put(messages[i]);
      const c = f.conv();
      return { waiting: c.waitingSinceMs, unread: c.remoteUnreadCount, lastAt: c.lastMessageAtMs };
    };
    const reference = build([0, 1, 2, 3, 4]);
    expect(reference).toEqual({ waiting: 200, unread: 3, lastAt: 300 });
    for (const order of [[4, 3, 2, 1, 0], [2, 0, 4, 1, 3], [1, 2, 3, 4, 0], [3, 4, 0, 2, 1]]) {
      expect(build(order)).toEqual(reference);
    }
  });
});

describe('Edit and delete refresh pointer/waiting coherently, never double counting unread', () => {
  it('edit leaves unread and pointer alone and is idempotent', () => {
    const f = fixture();
    f.put(f.msg('q', 100, { nativeVersion: '1' }));
    const revision = f.conv().revision;
    f.ingest.ingestNormalizedEvent({
      type: 'message.edited', eventId: 'ed', accountId: f.account.id, timestampMs: 5, epoch: 1,
      message: f.msg('q', 100, { nativeVersion: '2', text: 'edited' }),
    });
    expect(f.conv()).toMatchObject({ remoteUnreadCount: 1, waitingSinceMs: 100 });
    expect(f.conv().revision).toBe(revision); // recompute found nothing to change
  });

  it('deleting the waiting message moves waiting to the next unanswered one; deleting the newest moves the pointer back', () => {
    const f = fixture();
    const a = f.put(f.msg('a', 100));
    f.put(f.msg('b', 200));
    const c = f.put(f.msg('c', 300));
    f.del('a');
    expect(f.conv()).toMatchObject({ waitingSinceMs: 200, remoteUnreadCount: 2 });
    f.del('c');
    expect(f.conv()).toMatchObject({ lastMessageAtMs: 200, remoteUnreadCount: 1 });
    expect(f.conv().lastMessageId).not.toBe(c.messageId);
    expect(f.conv().lastMessageId).not.toBe(a.messageId);
    f.del('b');
    expect(f.conv()).toMatchObject({ lastMessageId: null, waitingSinceMs: null, remoteUnreadCount: 0 });
  });

  it('deleting a reply re-opens waiting for what it had answered', () => {
    const f = fixture();
    f.put(f.msg('q', 100));
    f.put(f.reply('r', 200));
    expect(f.conv().waitingSinceMs).toBeNull();
    f.del('r');
    expect(f.conv().waitingSinceMs).toBe(100);
  });

  it('editing a group message so it now mentions the account starts waiting; removing the mention stops it', () => {
    const f = fixture({ nativeAccountId: 'self-uid' });
    const group = (version: string, mentions: Array<{ uid: string }>) =>
      f.msg('g1', 100, { externalConversationKey: 'g:1', nativeVersion: version, metadata: { type: 'chat', conversationKind: 'group', mentions } });
    f.put(group('1', []));
    expect(f.conv('g:1').waitingSinceMs).toBeNull();
    const edit = (version: string, mentions: Array<{ uid: string }>, id: string) =>
      f.ingest.ingestNormalizedEvent({ type: 'message.edited', eventId: id, accountId: f.account.id, timestampMs: 5, epoch: 1, message: group(version, mentions) });
    edit('2', [{ uid: 'self-uid' }], 'e1');
    expect(f.conv('g:1').waitingSinceMs).toBe(100);
    edit('3', [{ uid: 'other' }], 'e2');
    expect(f.conv('g:1').waitingSinceMs).toBeNull();
  });
});

describe('Group/topic relevance needs EXACT account targeting (AC-007)', () => {
  it('casual banter, other mentions and @all do not start waiting; exact mention / quote of the account does', () => {
    const f = fixture({ nativeAccountId: 'self-uid' });
    const grp = (id: string, at: number, metadata: Record<string, unknown>, key = 'g:1') =>
      f.put(f.msg(id, at, { externalConversationKey: key, metadata: { type: 'chat', conversationKind: 'group', ...metadata } as never }));

    grp('casual', 100, {});
    expect(f.conv('g:1')).toMatchObject({ waitingSinceMs: null, remoteUnreadCount: 1 });
    grp('other', 110, { mentions: [{ uid: 'someone-else' }] });
    grp('all', 120, { mentions: [{ uid: 'self-uid', isAll: true }] });
    expect(f.conv('g:1').waitingSinceMs).toBeNull();
    grp('mine', 130, { mentions: [{ uid: 'x' }, { uid: 'self-uid' }] });
    expect(f.conv('g:1').waitingSinceMs).toBe(130);
    grp('quote', 90, { quote: { messageId: 'q', senderId: 'self-uid' } });
    expect(f.conv('g:1').waitingSinceMs).toBe(90);
    expect(f.conv('g:1').remoteUnreadCount).toBe(5);
  });

  it('topics behave like groups; email threads and DMs are always relevant', () => {
    const f = fixture({ channel: 'telegram', connectorKind: 'telegram-user', nativeAccountId: 'self-tg' });
    f.put(f.msg('t1', 100, { externalConversationKey: 't:1', metadata: { type: 'chat', conversationKind: 'topic', topicId: '5' } }));
    expect(f.conv('t:1').waitingSinceMs).toBeNull();
    f.put(f.msg('t2', 110, { externalConversationKey: 't:1', metadata: { type: 'chat', conversationKind: 'topic', topicId: '5', mentions: [{ uid: 'self-tg' }] } }));
    expect(f.conv('t:1').waitingSinceMs).toBe(110);
    f.put(f.msg('dm', 120, { externalConversationKey: 'dm:1' }));
    expect(f.conv('dm:1').waitingSinceMs).toBe(120);

    const mail = fixture({ channel: 'email', connectorKind: 'gmail-composio' });
    mail.ingest.ingestNormalizedMessage(emailMessage(mail.account, { sentAtMs: 700 }), undefined, 1);
    expect(mail.conv('thread:1').waitingSinceMs).toBe(700);
  });

  it('isDirectedAtAccount is exact and email is always directed', () => {
    const self = { nativeAccountId: 'me' };
    expect(isDirectedAtAccount(self, { metadata: { type: 'chat', mentions: [{ uid: 'me' }] } })).toBe(true);
    expect(isDirectedAtAccount(self, { metadata: { type: 'chat', mentions: [{ uid: 'me', isAll: true }] } })).toBe(false);
    expect(isDirectedAtAccount(self, { metadata: { type: 'chat', mentions: [{ uid: 'ME' }] } })).toBe(false);
    expect(isDirectedAtAccount(self, { metadata: { type: 'chat', quote: { messageId: '1', senderId: 'me' } } })).toBe(true);
    expect(isDirectedAtAccount(self, { metadata: { type: 'chat', quote: { messageId: '1' } } })).toBe(false);
    expect(isDirectedAtAccount(self, { metadata: { type: 'email', subject: 's', from: 'a@b.co', to: [] } })).toBe(true);
  });
});

describe('Remote read coverage vs dashboard local-seen (Finding 8)', () => {
  it('the dashboard marker only accepts messages of the same conversation and is independent of provider receipts', () => {
    const f = fixture();
    const q = f.put(f.msg('q', 100));
    const other = f.put(f.msg('o', 110, { externalConversationKey: 'peer:2' }));
    expect(() => f.stores.conversations.markLocalSeen(q.conversationId!, other.messageId!)).toThrow();
    expect(() => f.stores.conversations.markLocalSeen(q.conversationId!, 'no-such-message')).toThrow();

    f.stores.conversations.markLocalSeen(q.conversationId!, q.messageId!);
    expect(f.conv()).toMatchObject({ localSeenMessageId: q.messageId, remoteUnreadCount: 1, waitingSinceMs: 100 });

    f.ingest.ingestNormalizedEvent({
      type: 'read.updated', eventId: 'rd', accountId: f.account.id, timestampMs: 1, epoch: 1,
      externalConversationKey: 'peer:1', remoteReadMessageId: 'q', nativeMessageNamespace: 'zalo_chat',
    });
    // provider receipt cleared remote unread but neither waiting nor the dashboard marker
    expect(f.conv()).toMatchObject({ remoteUnreadCount: 0, waitingSinceMs: 100, localSeenMessageId: q.messageId });
  });

  it('inbound after the remote read watermark counts as unread again; the watermark is forward-only', () => {
    const f = fixture();
    f.put(f.msg('a', 100));
    f.put(f.msg('b', 200));
    const read = (id: string, eventId: string) =>
      f.ingest.ingestNormalizedEvent({
        type: 'read.updated', eventId, accountId: f.account.id, timestampMs: 1, epoch: 1,
        externalConversationKey: 'peer:1', remoteReadMessageId: id, nativeMessageNamespace: 'zalo_chat',
      });
    read('b', 'r1');
    expect(f.conv().remoteUnreadCount).toBe(0);
    f.put(f.msg('c', 300));
    expect(f.conv().remoteUnreadCount).toBe(1);
    read('a', 'r2'); // older coverage must not re-inflate unread
    expect(f.conv().remoteUnreadCount).toBe(1);
    // a late-arriving OLDER message is already covered by the watermark
    f.put(f.msg('late', 150));
    expect(f.conv().remoteUnreadCount).toBe(1);
  });
});

describe('Keyset pagination with equal timestamps (AC-014)', () => {
  it('messages: pages never skip or repeat rows that share a timestamp', () => {
    const f = fixture();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(f.put(f.msg(`m${i}`, i < 5 ? 1_000 : 2_000 + i)).messageId!);
    const convId = f.conv().id;

    const seen: string[] = [];
    let before: { sentAtMs: number; id: string } | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = f.stores.messages.listMessages(convId, { limit: 2, before });
      if (page.length === 0) break;
      seen.push(...page.map((m) => m.id));
      const last = page[page.length - 1];
      // the cursor survives an encode/decode roundtrip
      const cursor = decodeCursor(encodeCursor({ timestampMs: last.sentAtMs, id: last.id }))!;
      before = { sentAtMs: cursor.timestampMs, id: cursor.id };
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('conversations: equal last-activity timestamps page without skips or repeats', () => {
    const f = fixture();
    for (let i = 0; i < 6; i++) f.put(f.msg(`c${i}`, 1_000, { externalConversationKey: `peer:${i}` }));
    const all = f.stores.conversations.listConversations({ limit: 100 });
    expect(all).toHaveLength(6);

    const seen: string[] = [];
    let cursor: { lastActivityAtMs: number; id: string } | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = f.stores.conversations.listConversations({ limit: 4, cursor });
      if (page.length === 0) break;
      seen.push(...page.map((c) => c.id));
      const last = page[page.length - 1];
      cursor = { lastActivityAtMs: last.lastMessageAtMs, id: last.id };
    }
    expect(seen).toEqual(all.map((c) => c.id));
  });
});
