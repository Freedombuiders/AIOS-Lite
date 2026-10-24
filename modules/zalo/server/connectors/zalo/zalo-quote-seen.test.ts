/**
 * Zalo quoted replies and the seen marker from the CANONICAL message's wire data (rawEnvelope.wire stored at ingest),
 * not from legacy columns. Every case is a fake: the field mapping follows the zca-js types and is NOT verified against
 * the native service. A message without ALL the required data is refused / not marked (review), never sent on a guess.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ThreadType } from 'zca-js';
import { normalizeZaloMessage, ZALO_NAMESPACE } from './normalize.js';
import { quoteTargetOf, seenTargetOf, type StoredZaloMessage } from './wire.js';
import { makeZaloRig, cmd, rawIn, expectCode, type ZaloRig } from './zalo-test-kit.js';
import { makeDaemonWorld } from './daemon-test-kit.js';
import { DaemonZaloTransport } from './daemon-transport.js';
import type { ZaloRawMessage } from './transport.js';

const MSG_ID = '7400000000000001234';
const CLI_ID = '1700000000123';
const wireData = (over: Partial<ZaloRawMessage['data']> = {}): ZaloRawMessage =>
  rawIn({ data: { msgId: MSG_ID, cliMsgId: CLI_ID, uidFrom: 'peer-1', idTo: 'own-uid-1', msgType: 'webchat', ts: '1700000001000', ttl: 0, st: 3, at: 0, cmd: 501, content: 'giá bao nhiêu?', ...over } });

function stored(raw: ZaloRawMessage = wireData()): StoredZaloMessage {
  const n = normalizeZaloMessage(raw, { accountId: 'a', ownUid: 'own-uid-1', origin: 'live', nowMs: 1_700_000_002_000 })!;
  return { nativeMessageId: n.message.nativeMessageId, text: n.message.text, direction: n.message.direction, metadata: n.message.metadata as unknown as StoredZaloMessage['metadata'] };
}

describe('wire data kept at ingest', () => {
  it('stores the scalars a quote / seen marker needs next to the canonical message, and nothing it does not have', () => {
    const wire = (stored().metadata.rawEnvelope as { wire: Record<string, unknown> }).wire;
    expect(wire).toEqual({ msgType: 'webchat', ts: '1700000001000', ttl: 0, st: 3, at: 0, cmd: 501, idTo: 'own-uid-1', uidFrom: 'peer-1' });
    const bare = (normalizeZaloMessage(rawIn({ data: { msgId: MSG_ID } }), { accountId: 'a', ownUid: null, origin: 'live', nowMs: 1 })!.message.metadata as { rawEnvelope: { wire?: Record<string, unknown> } }).rawEnvelope.wire;
    expect(Object.keys(bare ?? {}).sort()).toEqual(['idTo', 'msgType', 'ts', 'uidFrom']); // ttl/st/at/cmd are absent, never invented
  });

  it('drops a propertyExt that is not small JSON (the message then cannot be quoted faithfully)', () => {
    const huge = stored(wireData({ propertyExt: { blob: 'x'.repeat(5000) } as never }));
    expect((huge.metadata.rawEnvelope as { wire: Record<string, unknown> }).wire.propertyExt).toBeUndefined();
    const small = stored(wireData({ propertyExt: { color: 0, size: 0, type: 0 } as never }));
    expect((small.metadata.rawEnvelope as { wire: Record<string, unknown> }).wire.propertyExt).toEqual({ color: 0, size: 0, type: 0 });
  });
});

describe('quoteTargetOf / seenTargetOf are all-or-nothing', () => {
  it('a text message with full wire data yields both targets', () => {
    expect(quoteTargetOf(stored())).toEqual({ msgId: MSG_ID, cliMsgId: CLI_ID, uidFrom: 'peer-1', ts: '1700000001000', ttl: 0, msgType: 'webchat', content: 'giá bao nhiêu?' });
    expect(seenTargetOf(stored(), 'user')).toEqual({ threadKind: 'user', msgId: MSG_ID, cliMsgId: CLI_ID, uidFrom: 'peer-1', idTo: 'own-uid-1', msgType: 'webchat', st: 3, at: 0, cmd: 501, ts: '1700000001000' });
  });

  it.each(['ts', 'ttl', 'msgType', 'uidFrom'])('quote: a missing %s means no quote target', (field) => {
    const m = stored();
    delete ((m.metadata.rawEnvelope as { wire: Record<string, unknown> }).wire)[field];
    expect(quoteTargetOf(m)).toBeNull();
  });

  it.each(['idTo', 'st', 'at', 'cmd', 'ts', 'msgType', 'uidFrom'])('seen: a missing %s means no seen target', (field) => {
    const m = stored();
    delete ((m.metadata.rawEnvelope as { wire: Record<string, unknown> }).wire)[field];
    expect(seenTargetOf(m, 'user')).toBeNull();
  });

  it('refuses: no wire block (bridged legacy / older rows), no cliMsgId, a cli: fallback id, a non-text message, an outbound message for seen', () => {
    const noWire = stored();
    delete (noWire.metadata.rawEnvelope as Record<string, unknown>).wire;
    expect(quoteTargetOf(noWire)).toBeNull();
    expect(seenTargetOf(noWire, 'user')).toBeNull();
    expect(quoteTargetOf({ ...stored(), metadata: { type: 'chat' } })).toBeNull();
    expect(quoteTargetOf(stored(wireData({ cliMsgId: undefined })))).toBeNull();
    expect(quoteTargetOf(stored(wireData({ msgId: undefined })))).toBeNull(); // native id falls back to cli:<id>
    const image = stored(wireData({ msgType: 'chat.photo', content: { href: 'https://x.zdn.vn/a.jpg', title: 'a' } as never }));
    expect(quoteTargetOf(image)).toBeNull();
    expect(seenTargetOf({ ...stored(), direction: 'out' }, 'user')).toBeNull();
    expect(quoteTargetOf(null)).toBeNull();
    expect(seenTargetOf(undefined, 'user')).toBeNull();
  });
});

let rig: ZaloRig;
afterEach(() => rig?.close());

/** A rig whose connector reads quote / seen data from messages held in a plain map (the runtime reads care_messages). */
function rigWith(messages: Record<string, StoredZaloMessage>) {
  rig = makeZaloRig({ resolveMessage: (_a, _key, nativeId) => messages[nativeId] ?? null });
  return rig;
}

describe('connector: quoted reply', () => {
  it('builds the quote from the stored message and sends it exactly once', async () => {
    const r = rigWith({ [MSG_ID]: stored() });
    r.transport.featureSet.quote = true;
    const res = await r.connector.dispatch(cmd(r, { target: { externalConversationKey: 'peer-1', replyToMessageId: MSG_ID } }));
    expect(res.outcome).toBe('accepted');
    expect(r.transport.sendCalls).toHaveLength(1);
    expect(r.transport.sendCalls[0].quote).toEqual(quoteTargetOf(stored()));
    expect(r.transport.sendCalls[0].replyToMessageId).toBe(MSG_ID);
  });

  it('refuses (UNSUPPORTED_CAPABILITY, no RPC) when the quoted message has no / incomplete wire data', async () => {
    const incomplete = stored();
    delete (incomplete.metadata.rawEnvelope as { wire: Record<string, unknown> }).wire.ttl;
    const r = rigWith({ [MSG_ID]: incomplete });
    r.transport.featureSet.quote = true;
    await expectCode(() => r.connector.dispatch(cmd(r, { target: { externalConversationKey: 'peer-1', replyToMessageId: MSG_ID } })), 'UNSUPPORTED_CAPABILITY');
    await expectCode(() => r.connector.dispatch(cmd(r, { target: { externalConversationKey: 'peer-1', replyToMessageId: 'unknown-native-id' } })), 'UNSUPPORTED_CAPABILITY');
    expect(r.transport.sendCalls).toHaveLength(0);
  });

  it('still refuses when the transport does not advertise quoting, whatever the data', async () => {
    const r = rigWith({ [MSG_ID]: stored() });
    r.transport.featureSet.quote = false;
    await expectCode(() => r.connector.dispatch(cmd(r, { target: { externalConversationKey: 'peer-1', replyToMessageId: MSG_ID } })), 'UNSUPPORTED_CAPABILITY');
    expect(r.transport.sendCalls).toHaveLength(0);
  });

  it('a plain reply (no quote) is unaffected', async () => {
    const r = rigWith({});
    expect((await r.connector.dispatch(cmd(r))).outcome).toBe('accepted');
    expect(r.transport.sendCalls[0].quote).toBeUndefined();
  });
});

describe('connector: seen marker', () => {
  it('marks a stored inbound message with its own wire data', async () => {
    const r = rigWith({ [MSG_ID]: stored() });
    r.transport.featureSet.markRead = true;
    const res = await r.connector.markRead({ accountId: r.account.id, externalConversationKey: 'peer-1', nativeMessageId: MSG_ID } as never);
    expect(res).toEqual({ ok: true });
    expect(r.transport.readMarks).toEqual([{ threadId: 'peer-1', nativeMessageId: MSG_ID, seen: expect.objectContaining({ msgId: MSG_ID, cliMsgId: CLI_ID, cmd: 501, threadKind: 'user' }) }]);
  });

  it('does NOT mark a message without enough data (reported, not guessed)', async () => {
    const m = stored();
    delete (m.metadata.rawEnvelope as { wire: Record<string, unknown> }).wire.cmd;
    const r = rigWith({ [MSG_ID]: m });
    r.transport.featureSet.markRead = true;
    const res = await r.connector.markRead({ accountId: r.account.id, externalConversationKey: 'peer-1', nativeMessageId: MSG_ID } as never);
    expect(res.ok).toBe(false);
    expect(r.transport.readMarks).toHaveLength(0);
  });

  it('capability off: refused before any lookup', async () => {
    const r = rigWith({ [MSG_ID]: stored() });
    r.transport.featureSet.markRead = false;
    await expectCode(() => r.connector.markRead({ accountId: r.account.id, externalConversationKey: 'peer-1', nativeMessageId: MSG_ID } as never), 'UNSUPPORTED_CAPABILITY');
  });
});

describe('real transport chain (fake zca-js API): off by default, opt-in per capability', () => {
  it('default: features say no, a quote / seen request is not sent', async () => {
    const w = makeDaemonWorld();
    expect(w.transport.features('zalo-1')).toMatchObject({ quote: false, markRead: false });
    const target = quoteTargetOf(stored())!;
    // quoting is off: the request is refused, never downgraded to a plain (unquoted) message
    await expect(w.transport.send('zalo-1', { threadId: 'peer-1', threadKind: 'user', text: 'x', quote: target })).rejects.toThrow(/not enabled/);
    expect(w.api.sent).toHaveLength(0);
    await expect(w.transport.markRead('zalo-1', 'peer-1', MSG_ID, seenTargetOf(stored(), 'user')!)).rejects.toThrow(/not enabled/);
    expect(w.api.seen).toHaveLength(0);
  });

  it('opt-in: zca-js gets the quote payload and the seen event with the right thread type', async () => {
    const w = makeDaemonWorld({ quoteReplies: true, seenMarker: true });
    expect(w.transport.features('zalo-1')).toMatchObject({ quote: true, markRead: true });
    await w.transport.send('zalo-1', { threadId: 'g-1', threadKind: 'group', text: 'Dạ 100k', quote: quoteTargetOf(stored())! });
    expect(w.api.sent[0]).toMatchObject({ threadId: 'g-1', type: ThreadType.Group, quote: { msgId: MSG_ID, cliMsgId: CLI_ID, uidFrom: 'peer-1', ts: '1700000001000', ttl: 0, msgType: 'webchat', content: 'giá bao nhiêu?' } });
    await w.transport.markRead('zalo-1', 'peer-1', MSG_ID, seenTargetOf(stored(), 'user')!);
    expect(w.api.seen).toEqual([{ params: { msgId: MSG_ID, cliMsgId: CLI_ID, uidFrom: 'peer-1', idTo: 'own-uid-1', msgType: 'webchat', st: 3, at: 0, cmd: 501, ts: '1700000001000' }, type: ThreadType.User }]);
  });

  it('through the daemon control routes: quote and seen travel over the loopback, a malformed quote is a 400, a seen request needs full data', async () => {
    const w = makeDaemonWorld({ quoteReplies: true, seenMarker: true });
    const client = new DaemonZaloTransport({ call: w.call, zaloAccountIdOf: () => 'zalo-1' });
    await client.send('care-1', { threadId: 'peer-1', threadKind: 'user', text: 'Dạ', requestId: 'req-q-1', ownerEpoch: 1, actor: 'manual', quote: quoteTargetOf(stored())!, replyToMessageId: MSG_ID });
    expect(w.api.sent[0].quote).toMatchObject({ msgId: MSG_ID, content: 'giá bao nhiêu?' });

    await expect(client.send('care-1', { threadId: 'peer-1', threadKind: 'user', text: 'Dạ', requestId: 'req-q-2', ownerEpoch: 1, actor: 'manual', quote: { ...quoteTargetOf(stored())!, ttl: -1 } })).rejects.toThrow();
    expect(w.api.sent).toHaveLength(1); // the malformed quote was refused, not sent unquoted

    await client.markRead('care-1', 'peer-1', MSG_ID, seenTargetOf(stored(), 'user')!);
    expect(w.api.seen).toHaveLength(1);
    await expect(client.markRead('care-1', 'peer-1', MSG_ID)).rejects.toThrow();
    expect(w.api.seen).toHaveLength(1);
  });
});

void ZALO_NAMESPACE;
