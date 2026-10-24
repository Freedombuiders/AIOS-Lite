import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../../../../_lib/care-kit/index.js';
import { nativeIdOf, normalizeZaloMessage, normalizeZaloUndo } from './normalize.js';
import { rawIn } from './zalo-test-kit.js';

/**
 * Test-local stand-in for care's "directed at this account" rule (evaluated by the care module, not by zalo):
 * a mention of the nick (not @all), or a quote of one of its messages.
 */
function isDirectedAtAccount(account: { nativeAccountId: string }, message: NormalizedMessage): boolean {
  const md = message.metadata as { mentions?: Array<{ uid: string; isAll?: boolean }> | null; quote?: { senderId?: string } | null };
  return Boolean(md.mentions?.some((m) => !m.isAll && m.uid === account.nativeAccountId) || md.quote?.senderId === account.nativeAccountId);
}

const ctx = { accountId: 'acc', ownUid: 'own-uid-1', origin: 'live' as const, nowMs: 1_800_000_000_000 };

describe('identity, order and echo', () => {
  it('keeps the remote id as a string beyond 2^53 and uses it as the native order', () => {
    const big = '7400000000000000123';
    const n = normalizeZaloMessage(rawIn({ data: { msgId: big } }), ctx)!;
    expect(Number.isSafeInteger(Number(big))).toBe(false);
    expect(n.message).toMatchObject({
      nativeMessageNamespace: 'zalo_chat',
      nativeMessageId: big,
      nativeOrder: big,
      nativeVersion: null,
      externalConversationKey: 'peer-1',
      direction: 'in',
      senderRole: 'customer',
      senderIdentityKey: 'peer-1',
      origin: 'live',
    });
    expect(n.message.metadata).toMatchObject({ type: 'chat', conversationKind: 'direct' });
  });

  it('an own message (echo of a send, or typed on the phone) is out/self with no identity', () => {
    const echo = normalizeZaloMessage(rawIn({ isSelf: true, data: { uidFrom: 'own-uid-1', idTo: 'peer-1' } }), ctx)!;
    expect(echo.message).toMatchObject({ direction: 'out', senderRole: 'self', senderIdentityKey: null });
    // isSelf missing but the sender is the nick itself
    const bySender = normalizeZaloMessage(rawIn({ isSelf: false, data: { uidFrom: 'own-uid-1' } }), ctx)!;
    expect(bySender.message.direction).toBe('out');
  });

  it('a self-sent DM batch item without threadId is filed under the peer (idTo)', () => {
    const n = normalizeZaloMessage(rawIn({ threadId: '', isSelf: true, data: { uidFrom: 'own-uid-1', idTo: 'peer-9' } }), ctx)!;
    expect(n.message.externalConversationKey).toBe('peer-9');
  });

  it('falls back to cli:<cliMsgId> without a msgId, and refuses a payload with neither', () => {
    expect(nativeIdOf({ cliMsgId: 55 })).toBe('cli:55');
    const n = normalizeZaloMessage(rawIn({ data: { msgId: undefined, cliMsgId: '55' } }), ctx)!;
    expect(n.message).toMatchObject({ nativeMessageId: 'cli:55', nativeOrder: null });
    expect(normalizeZaloMessage(rawIn({ data: { msgId: undefined, cliMsgId: undefined } }), ctx)).toBeNull();
  });

  it('uses Zalo ts for the time and the clock only when it is missing', () => {
    expect(normalizeZaloMessage(rawIn({ data: { ts: '1700000123456' } }), ctx)!.message.sentAtMs).toBe(1_700_000_123_456);
    expect(normalizeZaloMessage(rawIn({ data: { ts: undefined } }), ctx)!.message.sentAtMs).toBe(ctx.nowMs);
  });
});

describe('groups, mentions and quotes', () => {
  const group = (data: Record<string, unknown>) =>
    normalizeZaloMessage(rawIn({ threadKind: 'group', threadId: 'g-1', data: { uidFrom: 'member-7', ...data } }), ctx)!;

  it('keeps the member as the sender and the group as the conversation', () => {
    const n = group({});
    expect(n.message).toMatchObject({ externalConversationKey: 'g-1', senderIdentityKey: 'member-7', direction: 'in' });
    expect(n.message.metadata).toMatchObject({ conversationKind: 'group' });
  });

  it('maps mentions (including the propertyExt channel and @all) and evaluates "directed at this account"', () => {
    const account = { nativeAccountId: 'own-uid-1' };
    const mentioned = group({ mentions: [{ uid: 'own-uid-1', pos: 0, len: 6 }] });
    expect(mentioned.message.metadata).toMatchObject({ mentions: [{ uid: 'own-uid-1', offset: 0, length: 6, isAll: false }] });
    expect(isDirectedAtAccount(account, mentioned.message)).toBe(true);

    const viaExt = group({ propertyExt: { ext: JSON.stringify({ mentions: [{ uid: 'own-uid-1', pos: 2, len: 4, type: 0 }] }) } });
    expect(isDirectedAtAccount(account, viaExt.message)).toBe(true);

    const everyone = group({ mentions: [{ uid: '-1', pos: 0, len: 4, type: 1 }] });
    expect(everyone.message.metadata).toMatchObject({ mentions: [{ isAll: true }] });
    expect(isDirectedAtAccount(account, everyone.message)).toBe(false);

    const someoneElse = group({ mentions: [{ uid: 'member-9', pos: 0, len: 4 }] });
    expect(isDirectedAtAccount(account, someoneElse.message)).toBe(false);
  });

  it('carries quote linkage: quoted native id, owner uid and text; a quote of the nick makes it directed', () => {
    const n = group({ quote: { ownerId: 'own-uid-1', msg: 'báo giá nhé', fromD: 'Shop', globalMsgId: '7400000000000000042' } });
    expect(n.message.metadata).toMatchObject({ quote: { messageId: '7400000000000000042', senderId: 'own-uid-1', text: 'báo giá nhé' } });
    expect(isDirectedAtAccount({ nativeAccountId: 'own-uid-1' }, n.message)).toBe(true);
    // no quoted id from Zalo: kept empty, never guessed
    const noId = group({ quote: { ownerId: 'x', msg: 'q' } });
    expect(noId.message.metadata).toMatchObject({ quote: { messageId: '' } });
  });
});

describe('content types', () => {
  it('renders non-text content as a label and describes the attachment with its CDN url', () => {
    const n = normalizeZaloMessage(
      rawIn({ data: { msgType: 'chat.photo', content: { title: 'bill.jpg', href: 'https://f1.zdn.vn/abc.jpg' } } }),
      ctx,
    )!;
    expect(n.contentType).toBe('image');
    expect(n.message.text).toContain('[Ảnh]');
    expect(n.message.metadata).toMatchObject({
      attachments: [{ mimeType: 'image/*', fileName: 'bill.jpg', url: 'https://f1.zdn.vn/abc.jpg' }],
    });
    const sticker = normalizeZaloMessage(rawIn({ data: { msgType: 'chat.sticker', content: { id: 1 } } }), ctx)!;
    expect(sticker.message.metadata).not.toHaveProperty('attachments');
  });
});

describe('recall', () => {
  it('targets content.globalMsgId (not the undo packet itself), cli id as a fallback', () => {
    expect(normalizeZaloUndo({ threadId: 'peer-1', data: { content: { globalMsgId: '7400000000000000042', cliMsgId: '9' }, ts: '1700000000999' } }, 5)).toEqual({
      nativeMessageId: '7400000000000000042',
      externalConversationKey: 'peer-1',
      tsMs: 1_700_000_000_999,
    });
    expect(normalizeZaloUndo({ data: { content: { cliMsgId: '9' } } }, 5)).toEqual({ nativeMessageId: 'cli:9', tsMs: 5 });
    expect(normalizeZaloUndo({ data: { content: {} } }, 5)).toBeNull();
  });
});
