import { afterEach, describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '../../../../_lib/care-kit/index.js';
import { cmd, expectCode, makeZaloRig, rawIn, resume, type ZaloRig } from './zalo-test-kit.js';

let rig: ZaloRig;
afterEach(() => rig?.close());

const types = (events: NormalizedEvent[]) => events.map((e) => e.type);

describe('live feed slices', () => {
  it('names the conversation first, carries the checkpoint on the last event, and does not consume until commit', async () => {
    rig = makeZaloRig();
    rig.transport.titles.set('peer-2', 'Chị Lan');
    rig.transport.pushLive(rawIn({ threadId: 'peer-2', data: { uidFrom: 'peer-2' } }));
    rig.transport.pushLive(rawIn({ threadId: 'peer-2', data: { uidFrom: 'peer-2' } }));

    const first = await rig.connector.sync({ accountId: rig.account.id });
    expect(types(first.events)).toEqual(['conversation.updated', 'message.created', 'message.created']);
    expect(first.events[0]).toMatchObject({ title: 'Chị Lan', kind: 'direct', externalConversationKey: 'peer-2' });
    expect(first.nextCheckpoint).toMatchObject({ namespace: 'zalo_chat', expectedCursor: null });
    expect(first.events.at(-1)!.checkpoint).toEqual(first.nextCheckpoint);
    expect(first.commits).toHaveLength(1);
    expect(rig.transport.titleLookups).toEqual(['peer-2']); // one lookup per thread, not per message

    // sync only READS: until commit() the same slice is offered again
    const again = await rig.connector.sync({ accountId: rig.account.id });
    expect(again.events.filter((e) => e.type === 'message.created').map((e) => e.eventId)).toEqual(
      first.events.filter((e) => e.type === 'message.created').map((e) => e.eventId),
    );
    rig.connector.commit(first.commits[0]);
    expect((await rig.connector.sync({ accountId: rig.account.id })).events).toEqual([]);
  });

  it('pages with a limit and reports hasMore; unusable payloads are counted, never ingested', async () => {
    rig = makeZaloRig();
    for (let i = 0; i < 3; i += 1) rig.transport.pushLive(rawIn());
    rig.transport.pushLive(rawIn({ data: { msgId: undefined, cliMsgId: undefined } }));
    const page = await rig.connector.sync({ accountId: rig.account.id, limit: 2 });
    expect(page.hasMore).toBe(true);
    expect(page.events.filter((e) => e.type === 'message.created')).toHaveLength(2);
    rig.connector.commit(page.commits[0]);
    const rest = await rig.connector.sync({ accountId: rig.account.id, limit: 10 });
    expect(rest.skipped).toBe(1);
    expect(rest.events.filter((e) => e.type === 'message.created')).toHaveLength(1);
  });

  it('recalls become deletions that Care resolves by native id', async () => {
    rig = makeZaloRig();
    const raw = rawIn();
    rig.transport.pushLive(raw);
    const s1 = await rig.connector.sync({ accountId: rig.account.id });
    rig.connector.commit(s1.commits[0]);
    rig.transport.pushUndo({ threadId: 'peer-1', data: { content: { globalMsgId: String(raw.data.msgId) }, ts: '1700000009999' } });
    const s2 = await rig.connector.sync({ accountId: rig.account.id, checkpoint: resume(s1.nextCheckpoint) });
    expect(types(s2.events)).toEqual(['message.deleted']);
    expect(s2.events[0]).toMatchObject({ type: 'message.deleted', nativeMessageId: String(raw.data.msgId) });
  });

  it('rejects checkpoint boxes that are not Zalo boxes', async () => {
    rig = makeZaloRig();
    await expectCode(() => rig.connector.sync({ accountId: rig.account.id, checkpoint: { namespace: 'telegram_common_box', cursor: 'x' } }), 'INVALID_CURSOR');
    await expectCode(() => rig.connector.sync({ accountId: rig.account.id, checkpoint: { namespace: 'zalo_thread:bad id', cursor: 'x' } }), 'INVALID_CURSOR');
  });
});

describe('slice contract (what care ingests)', () => {
  it('names the conversation, a replay before commit returns the same slice, commit moves the feed forward', async () => {
    rig = makeZaloRig();
    rig.transport.titles.set('peer-3', 'Anh Nam');
    const a = rawIn({ threadId: 'peer-3', data: { uidFrom: 'peer-3' } });
    const b = rawIn({ threadId: 'peer-3', data: { uidFrom: 'peer-3' } });
    rig.transport.pushLive(a);
    rig.transport.pushLive(b);

    const s1 = await rig.connector.sync({ accountId: rig.account.id });
    expect(types(s1.events)).toEqual(['conversation.updated', 'message.created', 'message.created']);
    expect(s1.events[0]).toMatchObject({ title: 'Anh Nam', kind: 'direct', externalConversationKey: 'peer-3' });
    expect(s1.nextCheckpoint).toMatchObject({ namespace: 'zalo_chat' });

    // crash between ingest and commit: the same slice comes back (care folds the duplicates by native id)
    const replay = await rig.connector.sync({ accountId: rig.account.id });
    const ids = (events: NormalizedEvent[]) => events.filter((e) => e.type === 'message.created').map((e) => (e as Extract<NormalizedEvent, { type: 'message.created' }>).message.nativeMessageId);
    expect(ids(replay.events)).toEqual(ids(s1.events));
    expect(ids(s1.events)).toEqual([String(a.data.msgId), String(b.data.msgId)]);

    rig.connector.commit(s1.commits[0]);
    const c = rawIn({ threadId: 'peer-3', data: { uidFrom: 'peer-3' } });
    rig.transport.pushLive(c);
    const s2 = await rig.connector.sync({ accountId: rig.account.id, checkpoint: resume(s1.nextCheckpoint) });
    expect(ids(s2.events)).toEqual([String(c.data.msgId)]);
    expect(s2.nextCheckpoint!.cursor).not.toBe(s1.nextCheckpoint!.cursor);
  });

  it('a stale commit of an old feed does not acknowledge anything of the new one', async () => {
    rig = makeZaloRig();
    rig.transport.pushLive(rawIn());
    const s1 = await rig.connector.sync({ accountId: rig.account.id });
    rig.connector.commit(s1.commits[0]);
    expect(rig.transport.pendingLive()).toBe(0);
    rig.transport.pushLive(rawIn());
    rig.connector.commit(s1.commits[0]);
    expect(rig.transport.pendingLive()).toBe(1);
  });

  it('group mention of the nick is carried in the message metadata, a mention of someone else is not about the nick', async () => {
    rig = makeZaloRig();
    rig.upsertConversation('g-1', 'group');
    const mine = rawIn({ threadKind: 'group', threadId: 'g-1', data: { uidFrom: 'member-7', mentions: [{ uid: 'own-uid-1', pos: 0, len: 5 }], content: '@shop giá?' } });
    const other = rawIn({ threadKind: 'group', threadId: 'g-1', data: { uidFrom: 'member-8', mentions: [{ uid: 'member-9', pos: 0, len: 5 }], content: '@bạn ơi' } });
    rig.transport.pushLive(mine);
    rig.transport.pushLive(other);
    const s = await rig.connector.sync({ accountId: rig.account.id });
    const get = (id: unknown) => (s.events.find((e) => e.type === 'message.created' && e.message.nativeMessageId === String(id)) as Extract<NormalizedEvent, { type: 'message.created' }>).message;
    expect(get(mine.data.msgId)).toMatchObject({ direction: 'in', senderRole: 'customer', metadata: { mentions: [{ uid: 'own-uid-1' }] } });
    expect(get(other.data.msgId).metadata).toMatchObject({ mentions: [{ uid: 'member-9' }] });
  });

  it('history first, then the same message live: same native id, origin history then live (care promotes it)', async () => {
    rig = makeZaloRig();
    const raw = rawIn();
    rig.transport.pushLive(raw, 'history');
    const h = await rig.connector.sync({ accountId: rig.account.id });
    rig.connector.commit(h.commits[0]);
    rig.transport.pushLive(raw, 'live');
    const l = await rig.connector.sync({ accountId: rig.account.id, checkpoint: resume(h.nextCheckpoint) });
    const created = (r: typeof h) => r.events.filter((e) => e.type === 'message.created') as Extract<NormalizedEvent, { type: 'message.created' }>[];
    expect(created(h).map((e) => [e.message.nativeMessageId, e.message.origin])).toEqual([[String(raw.data.msgId), 'history']]);
    expect(created(l).map((e) => [e.message.nativeMessageId, e.message.origin])).toEqual([[String(raw.data.msgId), 'live']]);
  });
});

describe('echo of our own send', () => {
  it('is the same canonical message as the ack and also confirms the request', async () => {
    rig = makeZaloRig();
    const c = cmd(rig);
    const ack = await rig.connector.dispatch(c);
    const s = await rig.connector.sync({ accountId: rig.account.id });
    const created = s.events.find((e) => e.type === 'message.created')!;
    expect(created).toMatchObject({ message: { direction: 'out', senderRole: 'self', nativeMessageId: ack.nativeMessageId, text: c.text } });
    expect(s.events.find((e) => e.type === 'delivery.confirmed')).toMatchObject({
      clientRequestId: c.clientRequestId,
      nativeMessageId: ack.nativeMessageId,
      receiptLevel: 'accepted',
    });
    rig.connector.commit(s.commits[0]);
    // typed on the phone (no matching request): just an own message, no confirmation
    rig.transport.pushLive(rawIn({ isSelf: true, data: { uidFrom: 'own-uid-1', idTo: 'peer-1', content: 'typed on phone' } }));
    const s2 = await rig.connector.sync({ accountId: rig.account.id, checkpoint: resume(s.nextCheckpoint) });
    expect(types(s2.events)).toEqual(['message.created']);
  });
});

describe('history gaps', () => {
  it('a message the websocket lost is recovered from group history and folded with what is already stored', async () => {
    rig = makeZaloRig();
    rig.upsertConversation('g-1', 'group');
    const mk = (n: number) => rawIn({ threadKind: 'group', threadId: 'g-1', data: { uidFrom: 'member-7', msgId: String(7_100_000_000_000_000_000n + BigInt(n)), ts: String(1_700_000_000_000 + n * 1000), content: `msg ${n}` } });
    const [m1, m2, m3] = [mk(1), mk(2), mk(3)];

    rig.transport.pushLive(m1);
    rig.transport.markGap(); // message 2 never reached the feed
    rig.transport.pushLive(m3);
    const live = await rig.connector.sync({ accountId: rig.account.id });
    expect(live.gap).toBe(true);
    rig.connector.commit(live.commits[0]);
    const liveTexts = live.events.filter((e) => e.type === 'message.created').map((e) => (e as Extract<NormalizedEvent, { type: 'message.created' }>).message.text);
    expect(liveTexts).toEqual(['msg 1', 'msg 3']);

    rig.transport.setGroupHistory('g-1', [m1, m2, m3]);
    const recovered = await rig.connector.sync({ accountId: rig.account.id, checkpoint: { namespace: 'zalo_thread:g-1' as never, cursor: '' } });
    const created = recovered.events.filter((e) => e.type === 'message.created') as Extract<NormalizedEvent, { type: 'message.created' }>[];
    expect(created.map((e) => e.message.origin)).toEqual(['recovery', 'recovery', 'recovery']);
    expect(recovered.nextCheckpoint).toMatchObject({ namespace: 'zalo_thread:g-1', cursor: `h:${m3.data.msgId}`, position: String(m3.data.msgId) });
    // care folds m1 and m3 into what it already has and books m2 as new
    expect(created.map((e) => e.message.text)).toEqual(['msg 1', 'msg 2', 'msg 3']);
    expect(new Set(created.map((e) => e.message.nativeOrder)).size).toBe(3);

    // reading the same history again resumes after the last id
    const again = await rig.connector.sync({ accountId: rig.account.id, checkpoint: resume(recovered.nextCheckpoint) });
    expect(again.nextCheckpoint).toMatchObject({ namespace: 'zalo_thread:g-1' });
  });

  it('a first-login backfill is labelled history and asks the server to push older 1-1 messages', async () => {
    rig = makeZaloRig();
    rig.transport.setGroupHistory('g-2', [rawIn({ threadKind: 'group', threadId: 'g-2', data: { uidFrom: 'member-1' } })]);
    const res = await rig.connector.sync({ accountId: rig.account.id, fullBackfill: true, checkpoint: { namespace: 'zalo_thread:g-2' as never, cursor: '' } });
    expect((res.events.find((e) => e.type === 'message.created') as Extract<NormalizedEvent, { type: 'message.created' }>).message.origin).toBe('history');
    await rig.connector.sync({ accountId: rig.account.id, fullBackfill: true });
    expect(rig.transport.directHistoryRequests).toEqual([null]);
  });

  it('an exhausted group-read budget is a RATE_LIMITED cooldown, not a failure of the account', async () => {
    rig = makeZaloRig();
    rig.transport.rate = { ok: false, reason: 'daily', retryAfterMs: 3600_000 };
    const err = await expectCode(
      () => rig.connector.sync({ accountId: rig.account.id, checkpoint: { namespace: 'zalo_thread:g-1', cursor: 'x' } }),
      'RATE_LIMITED',
    );
    expect(err.details).toMatchObject({ retryAtMs: rig.clock.t + 3600_000 });
  });
});
