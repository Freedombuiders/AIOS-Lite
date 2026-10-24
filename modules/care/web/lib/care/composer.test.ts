import { describe, expect, it } from 'vitest';
import {
  classifyFailure, computeEmailPreview, emptyDraft, newRequestId, ownAddressesOf, prepareSubmit, richPayload, settleDraft, settleDraftAgainst,
  type ChatDraft, type EmailDraft,
} from './composer';
import { toCareFailure } from './failure';
import { conv, emailMsg, msg } from './fixtures.test-util';

const chat = (text: string, over: Partial<ChatDraft> = {}): ChatDraft => ({ ...(emptyDraft('chat') as ChatDraft), text, ...over });
const mail = (body: string, over: Partial<EmailDraft> = {}): EmailDraft => ({ ...(emptyDraft('email') as EmailDraft), body, ...over });
let n = 0;
const ids = () => `care-test-${++n}`;

describe('clientRequestId lifecycle', () => {
  it('matches the API pattern', () => {
    expect(newRequestId()).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
    expect(newRequestId()).not.toBe(newRequestId());
  });

  it('mints an id on first submit and REUSES it for an identical retry', () => {
    const c = conv();
    const first = prepareSubmit({ draft: chat('xin chào'), conversation: c, messages: [msg()], ownAddresses: [], genId: ids });
    if (!first.ok) throw new Error('expected ok');
    const retry = prepareSubmit({ draft: first.value.draft, conversation: c, messages: [msg()], ownAddresses: [], genId: ids });
    if (!retry.ok) throw new Error('expected ok');
    expect(retry.value.body.clientRequestId).toBe(first.value.body.clientRequestId);
  });

  it('editing the text mints a NEW id (the server rejects one id with two payloads)', () => {
    const c = conv();
    const first = prepareSubmit({ draft: chat('một'), conversation: c, messages: [], ownAddresses: [], genId: ids });
    if (!first.ok) throw new Error('expected ok');
    const edited = prepareSubmit({ draft: { ...first.value.draft, text: 'hai' } as ChatDraft, conversation: c, messages: [], ownAddresses: [], genId: ids });
    if (!edited.ok) throw new Error('expected ok');
    expect(edited.value.body.clientRequestId).not.toBe(first.value.body.clientRequestId);
  });

  it('an id minted for one conversation is never reused for another', () => {
    const first = prepareSubmit({ draft: chat('cùng nội dung'), conversation: conv({ id: 'c1' }), messages: [], ownAddresses: [], genId: ids });
    if (!first.ok) throw new Error('expected ok');
    const other = prepareSubmit({ draft: first.value.draft, conversation: conv({ id: 'c2' }), messages: [], ownAddresses: [], genId: ids });
    if (!other.ok) throw new Error('expected ok');
    expect(other.value.body.clientRequestId).not.toBe(first.value.body.clientRequestId);
  });

  it('refuses empty text and carries the account, channel and revision guard', () => {
    expect(prepareSubmit({ draft: chat('   '), conversation: conv(), messages: [], ownAddresses: [] })).toEqual({ ok: false, reason: 'empty' });
    const ok = prepareSubmit({ draft: chat('hi'), conversation: conv({ revision: 7, accountId: 'acc9', channel: 'telegram' }), messages: [], ownAddresses: [], genId: ids });
    if (!ok.ok) throw new Error('expected ok');
    expect(ok.value.body).toMatchObject({ accountId: 'acc9', channel: 'telegram', expectedConversationRevision: 7, text: 'hi' });
    expect(ok.value.body.target).toBeUndefined(); // chat replies carry no email fields
  });

  it('topic conversations keep the topic id from the thread', () => {
    const ok = prepareSubmit({
      draft: chat('hi'), conversation: conv({ kind: 'topic', channel: 'telegram' }),
      messages: [msg({ metadata: { type: 'chat', topicId: '42' } })], ownAddresses: [], genId: ids,
    });
    if (!ok.ok) throw new Error('expected ok');
    expect(ok.value.body.target).toEqual({ topicId: '42' });
  });
});

describe('submit outcomes', () => {
  const fail = (status: number, code?: string, extra: object = {}) => toCareFailure({ status, body: code ? { code, message: 'm', ...extra } : {} });

  it('501 is the "sending not available" state, not an error', () => {
    expect(classifyFailure(fail(501, 'UNSUPPORTED_CAPABILITY'))).toEqual({ kind: 'unavailable' });
    expect(classifyFailure(fail(501))).toEqual({ kind: 'unavailable' }); // envelope-less proxy answer
  });

  it('422 UNSUPPORTED_CAPABILITY is a per-account rejection, not the missing-port state', () => {
    expect(classifyFailure(fail(422, 'UNSUPPORTED_CAPABILITY'))).toEqual({ kind: 'rejected', code: 'UNSUPPORTED_CAPABILITY' });
  });

  it('409 stale revision keeps the draft and asks for a refresh; payload mismatch drops the id', () => {
    expect(classifyFailure(fail(409, 'STALE_REVISION', { currentRevision: 9 }))).toEqual({ kind: 'conflict', code: 'STALE_REVISION', mintNewId: false, refresh: true });
    expect(classifyFailure(fail(409, 'DUPLICATE_REQUEST_PAYLOAD_MISMATCH'))).toMatchObject({ kind: 'conflict', mintNewId: true });
    expect(classifyFailure(fail(409, 'ACCOUNT_FROZEN'))).toMatchObject({ kind: 'conflict', refresh: false });
  });

  it('no response or a 5xx is "unknown": the same id must be retried', () => {
    expect(classifyFailure(toCareFailure(new TypeError('Failed to fetch')))).toEqual({ kind: 'unknown' });
    expect(classifyFailure(fail(503, 'STORE_UNAVAILABLE'))).toEqual({ kind: 'unknown' });
  });

  it('settling: accepted clears only the text that was sent', () => {
    const sent = chat('đã gửi', { requestId: 'care-1', payloadKey: 'k' });
    expect(settleDraft(sent, { kind: 'accepted', duplicate: false })).toMatchObject({ text: '', requestId: null });
    const typedSince = chat('đã gửi và gõ thêm', { requestId: 'care-1', payloadKey: 'k' });
    const kept = settleDraftAgainst(typedSince, sent, { kind: 'accepted', duplicate: false }) as ChatDraft;
    expect(kept.text).toBe('đã gửi và gõ thêm');
    expect(kept.requestId).toBeNull();
  });

  it('settling: failures keep the text and (except mismatch) the id', () => {
    const d = chat('giữ', { requestId: 'care-1', payloadKey: 'k' });
    expect(settleDraft(d, { kind: 'unknown' })).toBe(d);
    expect(settleDraft(d, { kind: 'unavailable' })).toBe(d);
    expect(settleDraft(d, { kind: 'conflict', code: 'STALE_REVISION', mintNewId: false, refresh: true })).toBe(d);
    expect(settleDraft(d, { kind: 'conflict', code: 'DUPLICATE_REQUEST_PAYLOAD_MISMATCH', mintNewId: true, refresh: false })).toMatchObject({ text: 'giữ', requestId: null });
  });
});

describe('email reply preview', () => {
  const own = ['sale@shop.test'];
  const inbound = emailMsg();

  it('Reply goes to the sender only, with Re: subject and threading headers', () => {
    const p = computeEmailPreview({ mode: 'reply', subject: null, removedCc: [] }, [inbound], own);
    expect(p.to).toEqual(['khach@example.test']);
    expect(p.cc).toEqual([]);
    expect(p.subject).toBe('Re: Báo giá lô hàng');
    expect(p.inReplyToHeader).toBe('<abc@mail.example.test>');
    expect(p.replyToMessageId).toBe('e1');
  });

  it('Reply-all adds the other To/Cc recipients, never our own mailbox or the sender twice', () => {
    const p = computeEmailPreview({ mode: 'reply_all', subject: null, removedCc: [] }, [inbound], own);
    expect(p.to).toEqual(['khach@example.test']);
    expect(p.cc).toEqual(['ketoan@shop.test', 'sep@khach.test']);
  });

  it('Reply-To wins over From, and removed Cc addresses stay out', () => {
    const m = emailMsg({ meta: { replyTo: 'support@khach.test', cc: ['sep@khach.test'] } });
    const p = computeEmailPreview({ mode: 'reply_all', subject: null, removedCc: ['SEP@khach.test'] }, [m], own);
    expect(p.to).toEqual(['support@khach.test']);
    expect(p.cc).toEqual(['ketoan@shop.test']);
    expect(p.ccCandidates).toContain('sep@khach.test');
  });

  it('does not stack Re: prefixes and honours a subject the operator typed', () => {
    const m = emailMsg({ meta: { subject: 'Re: RE: Hợp đồng' } });
    expect(computeEmailPreview({ mode: 'reply', subject: null, removedCc: [] }, [m], own).subject).toBe('Re: Hợp đồng');
    expect(computeEmailPreview({ mode: 'reply', subject: 'Tiêu đề khác', removedCc: [] }, [m], own).subject).toBe('Tiêu đề khác');
  });

  it('answers the last INBOUND email even when our own reply is newer', () => {
    const ours = emailMsg({ id: 'e2', direction: 'out', senderRole: 'operator', sentAtMs: 2000, meta: { from: 'sale@shop.test', to: ['khach@example.test'] } });
    const p = computeEmailPreview({ mode: 'reply', subject: null, removedCc: [] }, [ours, inbound], own);
    expect(p.replyToMessageId).toBe('e1');
    expect(p.to).toEqual(['khach@example.test']);
  });

  it('flags no-reply recipients and empty threads', () => {
    const auto = emailMsg({ meta: { from: 'no-reply@brand.test' } });
    expect(computeEmailPreview({ mode: 'reply', subject: null, removedCc: [] }, [auto], own).warnings).toContain('automated_recipient');
    expect(computeEmailPreview({ mode: 'reply', subject: null, removedCc: [] }, [msg()], own).warnings).toContain('no_message');
  });

  it('submit uses exactly the previewed recipients and carries NO bcc', () => {
    const d = mail('Cảm ơn anh', { mode: 'reply_all' });
    const ok = prepareSubmit({ draft: d, conversation: conv({ channel: 'email', kind: 'email_thread', accountId: 'mail1' }), messages: [inbound], ownAddresses: own, genId: ids });
    if (!ok.ok) throw new Error('expected ok');
    expect(ok.value.body.target).toEqual({
      to: ['khach@example.test'], cc: ['ketoan@shop.test', 'sep@khach.test'], subject: 'Re: Báo giá lô hàng',
      inReplyToHeader: '<abc@mail.example.test>', replyToMessageId: 'e1',
    });
    expect(JSON.stringify(ok.value.body)).not.toMatch(/bcc/i);
  });

  it('refuses to send with no recipient', () => {
    const noFrom = emailMsg({ meta: { from: '' } });
    expect(prepareSubmit({ draft: mail('x'), conversation: conv({ channel: 'email' }), messages: [noFrom], ownAddresses: own })).toEqual({ ok: false, reason: 'no_recipient' });
  });

  it('sends the body exactly as typed: the mailbox signature is appended by the server, once', () => {
    const a = prepareSubmit({ draft: mail('Chào anh'), conversation: conv({ channel: 'email', signature: 'Minh - Sale' }), messages: [inbound], ownAddresses: own, genId: ids });
    if (!a.ok) throw new Error('expected ok');
    expect(a.value.body.text).toBe('Chào anh');
    expect(JSON.stringify(a.value.body)).not.toContain('Minh - Sale');
  });

  it('knows which addresses are ours', () => {
    expect(ownAddressesOf({ nativeAccountId: 'Sale@Shop.test', label: 'Hộp thư bán hàng' })).toEqual(['Sale@Shop.test']);
    expect(ownAddressesOf(undefined)).toEqual([]);
  });
});

describe('Zalo formatting + mentions in the reply payload', () => {
  const bold = { st: 'b', start: 0, len: 3 };
  const prep = (draft: ChatDraft, c = conv()) => {
    const r = prepareSubmit({ draft, conversation: c, messages: [], ownAddresses: [], genId: ids });
    if (!r.ok) throw new Error('expected ok');
    return r.value;
  };

  it('a plain message produces exactly the request it always did', () => {
    const { body } = prep(chat('xin chào', { styles: [], mentions: [] }));
    expect(Object.keys(body).sort()).toEqual(['accountId', 'channel', 'clientRequestId', 'expectedConversationRevision', 'text']);
  });

  it('sends styles over the exact text for Zalo, and mentions only in groups', () => {
    const d = chat('Chào @An bạn', { styles: [bold], mentions: [{ uid: 'u1', pos: 5, len: 3 }, { uid: 'all', pos: 0, len: 1, type: 1 }] });
    const direct = prep(d, conv({ kind: 'direct' })).body;
    expect(direct.styles).toEqual([bold]);
    expect(direct.mentions).toBeUndefined();
    const group = prep(d, conv({ kind: 'group' })).body;
    expect(group.styles).toEqual([bold]);
    // the second mention does not start on an "@": dropped rather than sent misaligned
    expect(group.mentions).toEqual([{ uid: 'u1', pos: 5, len: 3 }]);
  });

  it('Telegram never carries formatting', () => {
    const { body } = prep(chat('hi there', { styles: [bold], mentions: [{ uid: 'u', pos: 0, len: 1 }] }), conv({ channel: 'telegram', kind: 'group' }));
    expect(body.styles).toBeUndefined();
    expect(body.mentions).toBeUndefined();
  });

  it('clamps ranges to the text and caps the counts', () => {
    const p = richPayload(chat('abc', { styles: [{ st: 'b', start: 1, len: 50 }, { st: 'i', start: 9, len: 2 }, { st: 'u', start: 0, len: 0 }] }), conv());
    expect(p.styles).toEqual([{ st: 'b', start: 1, len: 2 }]);
    const many = Array.from({ length: 300 }, (_, i) => ({ st: 'b', start: 0, len: 1 + (i % 2) }));
    expect(richPayload(chat('abcd', { styles: many }), conv()).styles).toHaveLength(200);
    const text = '@'.repeat(80);
    const ments = Array.from({ length: 80 }, (_, i) => ({ uid: `u${i}`, pos: i, len: 1 }));
    expect(richPayload(chat(text, { mentions: ments }), conv({ kind: 'group' })).mentions).toHaveLength(50);
  });

  it('a retry with changed formatting is a changed payload (new id); identical formatting reuses the id', () => {
    const first = prep(chat('Chào bạn', { styles: [bold] }));
    const same = prep(first.draft as ChatDraft);
    expect(same.body.clientRequestId).toBe(first.body.clientRequestId);
    const changed = prep({ ...(first.draft as ChatDraft), styles: [{ st: 'i', start: 0, len: 3 }] });
    expect(changed.body.clientRequestId).not.toBe(first.body.clientRequestId);
    const dropped = prep({ ...(first.draft as ChatDraft), styles: undefined });
    expect(dropped.body.clientRequestId).not.toBe(first.body.clientRequestId);
  });

  it('settling clears the formatting with the text; formatting edited mid-flight keeps the draft', () => {
    const sent = chat('Chào', { styles: [bold], mentions: [{ uid: 'u', pos: 0, len: 1 }], requestId: 'care-1', payloadKey: 'k' });
    const done = settleDraft(sent, { kind: 'accepted', duplicate: false }) as ChatDraft;
    expect(done.text).toBe('');
    expect(done.styles).toBeUndefined();
    expect(done.mentions).toBeUndefined();
    const reformatted = { ...sent, styles: [{ st: 'i', start: 0, len: 2 }] };
    const kept = settleDraftAgainst(reformatted, sent, { kind: 'accepted', duplicate: false }) as ChatDraft;
    expect(kept.text).toBe('Chào');
    expect(kept.requestId).toBeNull();
  });
});
