import { describe, expect, it } from 'vitest';
import { computeEmailPreview, draftHasContent, emptyDraft, prepareSubmit, settleDraft, type ChatDraft, type EmailDraft } from './composer';
import { lastCustomerMessages } from './draftContext';
import { readAttachments } from './messageView';
import { pendingDrafts, validDraft, validNote } from './inlineDrafts';
import { conv, emailMsg, msg } from './fixtures.test-util';
import type { CareInlineDraftDto } from './dto';

const chat = (over: Partial<ChatDraft> = {}): ChatDraft => ({ ...(emptyDraft('chat') as ChatDraft), ...over });
const mail = (over: Partial<EmailDraft> = {}): EmailDraft => ({ ...(emptyDraft('email') as EmailDraft), ...over });
const gen = () => 'care-new-id-123';

describe('reply with attachments (Zalo)', () => {
  const att = { mediaId: 'media-1', name: 'a.jpg', kind: 'image', mime: 'image/jpeg', size: 10 };
  it('an attachment alone is content; the body carries only the media ids', () => {
    expect(draftHasContent(chat({ attachments: [att] }))).toBe(true);
    expect(draftHasContent(chat())).toBe(false);
    const p = prepareSubmit({ draft: chat({ text: '', attachments: [att] }), conversation: conv(), messages: [], ownAddresses: [], genId: gen });
    expect(p.ok && p.value.body.attachments).toEqual([{ mediaId: 'media-1' }]);
    expect(p.ok && p.value.body.text).toBe('');
  });
  it('a text-only reply has no attachments field at all', () => {
    const p = prepareSubmit({ draft: chat({ text: 'xin chào' }), conversation: conv(), messages: [], ownAddresses: [], genId: gen });
    expect(p.ok && 'attachments' in p.value.body).toBe(false);
  });
  it('adding a file changes the payload, so a new request id is minted (one id never covers two payloads)', () => {
    const first = prepareSubmit({ draft: chat({ text: 'a' }), conversation: conv(), messages: [], ownAddresses: [], genId: () => 'care-id-one-1' });
    if (!first.ok) throw new Error('prepare failed');
    const again = prepareSubmit({ draft: { ...first.value.draft, attachments: [att] } as ChatDraft, conversation: conv(), messages: [], ownAddresses: [], genId: () => 'care-id-two-2' });
    expect(again.ok && again.value.body.clientRequestId).toBe('care-id-two-2');
    const same = prepareSubmit({ draft: first.value.draft, conversation: conv(), messages: [], ownAddresses: [], genId: () => 'care-id-three' });
    expect(same.ok && same.value.body.clientRequestId).toBe('care-id-one-1'); // unchanged payload reuses the id
  });
  it('accepted clears text, files and the draft link', () => {
    const settled = settleDraft(chat({ text: 'x', attachments: [att], fromDraftId: 'lz:5' }), { kind: 'accepted', duplicate: false }) as ChatDraft;
    expect(settled).toMatchObject({ text: '', attachments: [], requestId: null });
    expect(settled.fromDraftId).toBeUndefined();
  });
});

describe('email draft loaded into the composer', () => {
  const thread = [emailMsg({ id: 'e1' })];
  it('uses the draft recipients (minus our own address) and lets Cc be trimmed', () => {
    const d = mail({ mode: 'reply', recipients: { to: ['lan@khach.test'], cc: ['sep@khach.test', 'sale@shop.test'] } });
    const p = computeEmailPreview(d, thread, ['sale@shop.test']);
    expect(p.to).toEqual(['lan@khach.test']);
    expect(p.cc).toEqual(['sep@khach.test']);
    const trimmed = computeEmailPreview({ ...d, removedCc: ['sep@khach.test'] }, thread, ['sale@shop.test']);
    expect(trimmed.cc).toEqual([]);
  });
  it('without recipients it still answers the thread as before', () => {
    expect(computeEmailPreview(mail(), thread, ['sale@shop.test']).to).toEqual(['khach@example.test']);
  });
  it('the subject of the draft is what is sent', () => {
    const p = prepareSubmit({ draft: mail({ body: 'Dạ em gửi', subject: 'Báo giá gói doanh nghiệp', recipients: { to: ['lan@khach.test'], cc: [] } }), conversation: conv({ channel: 'email' }), messages: thread, ownAddresses: [], genId: gen });
    expect(p.ok && p.value.body.target).toMatchObject({ to: ['lan@khach.test'], subject: 'Báo giá gói doanh nghiệp' });
  });
});

describe('inline drafts', () => {
  const d = (id: string, status: CareInlineDraftDto['status'], createdAtMs: number): CareInlineDraftDto => ({
    id, conversationId: 'c1', accountId: 'a1', channel: 'zalo', source: 'core', agentId: 'review-care', text: 't', email: null, reviewReason: null, status, createdAtMs,
  });
  it('only drafts still waiting for a person, newest first', () => {
    expect(pendingDrafts([d('lz:1', 'draft', 1), d('lz:2', 'sent', 5), d('lz:3', 'draft', 3), d('lz:4', 'discarded', 9)]).map((x) => x.id)).toEqual(['lz:3', 'lz:1']);
  });
});

describe('draft review context', () => {
  it('the customer\'s last three messages, oldest first, skipping our replies and deleted ones', () => {
    const items = [
      msg({ id: 'm6', senderRole: 'operator', direction: 'out', text: 'dạ', sentAtMs: 6 }),
      msg({ id: 'm5', text: 'năm', sentAtMs: 5 }),
      msg({ id: 'm4', text: 'bốn', sentAtMs: 4, deleted: true }),
      msg({ id: 'm3', text: 'ba', sentAtMs: 3 }),
      msg({ id: 'm2', text: 'hai', sentAtMs: 2 }),
      msg({ id: 'm1', text: 'một', sentAtMs: 1 }),
    ];
    expect(lastCustomerMessages(items).map((x) => x.text)).toEqual(['hai', 'ba', 'năm']);
    expect(lastCustomerMessages(items, 1).map((x) => x.text)).toEqual(['năm']);
    expect(lastCustomerMessages([])).toEqual([]);
  });
  it('an email without text falls back to its snippet', () => {
    const e = emailMsg({ id: 'e9', text: '  ', meta: { snippet: 'Mình cần báo giá' } });
    expect(lastCustomerMessages([e])[0].text).toBe('Mình cần báo giá');
  });
  it('a picture or sticker is listed as such; a message with nothing to show is skipped', () => {
    const pic = msg({ id: 'p', text: '', sentAtMs: 3, metadata: { type: 'chat', attachments: [{ id: 'a', mimeType: 'image/jpeg', fileName: 'chuyen-khoan.jpg' }] } });
    const sticker = msg({ id: 's', text: '', sentAtMs: 2, metadata: { type: 'chat', stickerId: 'st1' } });
    const blank = msg({ id: 'b', text: '  ', sentAtMs: 1, metadata: { type: 'chat' } });
    const got = lastCustomerMessages([pic, sticker, blank]);
    expect(got.map((x) => x.id)).toEqual(['s', 'p']);
    expect(got[1]).toMatchObject({ text: '', attachments: ['chuyen-khoan.jpg'], sticker: false });
    expect(got[0]).toMatchObject({ sticker: true, attachments: [] });
  });
});

describe('attachment index (media route)', () => {
  it('keeps the position in the raw array, even when a junk entry was skipped', () => {
    const atts = readAttachments({ attachments: [{ id: 'a', mimeType: 'image/jpeg' }, 'junk', { id: 'b', mimeType: 'image/png' }] });
    expect(atts.map((a) => a.index)).toEqual([0, 2]);
  });
});

describe('malformed side data never reaches the pane', () => {
  it('drops notes and drafts without the fields the UI renders', () => {
    expect(validNote({ id: 'n', body: 'x', createdAtMs: 5 })).toBe(true);
    expect(validNote({ id: 'c1', title: 'a conversation row' })).toBe(false);
    expect(validNote(null)).toBe(false);
    expect(validDraft({ id: 'lz:1', text: 't', createdAtMs: 1 })).toBe(true);
    expect(validDraft({ id: 'c1', createdAtMs: NaN, text: 't' })).toBe(false);
  });
});
