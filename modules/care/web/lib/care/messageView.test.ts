import { describe, expect, it } from 'vitest';
import { toCareFailure, isReplyUnavailable } from './failure';
import { conversationQuery, effectiveQuery, EMPTY_FILTERS, filterKey, hasActiveFilters, reconcileAccount, searchQuery } from './filters';
import { attachmentKind, bubbleSide, dayKey, describeMessage, readAttachments } from './messageView';
import { emailMsg, msg } from './fixtures.test-util';

describe('message presentation', () => {
  it('plain text renders as text', () => {
    expect(describeMessage(msg({ text: 'chào' }))).toMatchObject({ placeholder: null, text: 'chào', isEmail: false });
  });

  it('a tombstone never shows the stale body or its attachments', () => {
    const v = describeMessage(msg({ text: 'nội dung cũ', metadata: { type: 'chat', tombstone: true, attachments: [{ id: 'a', mimeType: 'image/png', fileName: 'x.png' }] } }));
    expect(v.placeholder).toBe('deleted');
    expect(v.text).toBe('');
    expect(v.attachments).toEqual([]);
  });

  it('a sticker without text is an explicit unsupported placeholder', () => {
    expect(describeMessage(msg({ text: '', metadata: { type: 'chat', stickerId: 's9' } }))).toMatchObject({ placeholder: 'unsupported', unsupportedLabel: 'sticker' });
  });

  it('an empty chat message with nothing renderable is a placeholder, not blank', () => {
    expect(describeMessage(msg({ text: '  ', metadata: { type: 'chat' } })).placeholder).toBe('unsupported');
  });

  it('attachments are read defensively and classified by mime', () => {
    const atts = readAttachments({ attachments: [{ id: 'a', mimeType: 'image/jpeg', fileName: 'a.jpg', sizeBytes: 2048 }, 'junk', { mimeType: 'audio/ogg', isVoice: true }, { id: 'p', mimeType: 'application/pdf' }] });
    expect(atts.map((a) => a.kind)).toEqual(['image', 'audio', 'document']);
    expect(atts[0].sizeBytes).toBe(2048);
    expect(atts[1].isVoice).toBe(true);
    expect(readAttachments({ attachments: 'nope' })).toEqual([]);
    expect(attachmentKind('')).toBe('other');
  });

  it('an attachment-only message is not a placeholder (the chips show it)', () => {
    const v = describeMessage(msg({ text: '', metadata: { type: 'chat', attachments: [{ id: 'a', mimeType: 'image/png', fileName: 'a.png' }] } }));
    expect(v.placeholder).toBeNull();
    expect(v.attachments).toHaveLength(1);
  });

  it('email with only html or snippet is renderable; a truly empty one is "empty"', () => {
    expect(describeMessage(emailMsg({ text: '', meta: { bodyHtml: '<p>x</p>' } })).placeholder).toBeNull();
    expect(describeMessage(emailMsg({ text: '', meta: { snippet: 'tóm tắt' } })).placeholder).toBeNull();
    expect(describeMessage(emailMsg({ text: '', meta: {} })).placeholder).toBe('empty');
  });

  it('sender roles map to bubble sides', () => {
    expect(bubbleSide({ senderRole: 'customer' })).toBe('incoming');
    for (const r of ['self', 'operator', 'agent'] as const) expect(bubbleSide({ senderRole: r })).toBe('outgoing');
    expect(bubbleSide({ senderRole: 'system' })).toBe('system');
  });

  it('day keys group by local calendar day', () => {
    expect(dayKey(new Date(2026, 9, 9, 23, 59).getTime())).toBe('2026-10-09');
    expect(dayKey(new Date(2026, 9, 10, 0, 1).getTime())).toBe('2026-10-10');
  });
});

describe('failure normalisation', () => {
  it('reads the server envelope', () => {
    expect(toCareFailure({ status: 409, body: { code: 'STALE_REVISION', message: 'm', currentRevision: 4 } })).toEqual({ status: 409, code: 'STALE_REVISION', message: 'm', retryAt: undefined, currentRevision: 4 });
    expect(toCareFailure({ status: 429, body: { code: 'RATE_LIMITED', message: 'm', retryAt: 99 } }).retryAt).toBe(99);
  });
  it('maps transport errors and unknown codes safely', () => {
    expect(toCareFailure(new TypeError('Failed to fetch'))).toMatchObject({ status: 0, code: 'NETWORK' });
    expect(toCareFailure({ status: 500, body: { code: 'WHATEVER' } }).code).toBe('UNKNOWN');
    expect(toCareFailure({ status: 500, body: null }).code).toBe('UNKNOWN');
  });
  it('tells a missing reply port from a per-account capability rejection', () => {
    expect(isReplyUnavailable(toCareFailure({ status: 501, body: { code: 'UNSUPPORTED_CAPABILITY' } }))).toBe(true);
    expect(isReplyUnavailable(toCareFailure({ status: 422, body: { code: 'UNSUPPORTED_CAPABILITY' } }))).toBe(false);
  });
});

describe('filters', () => {
  it('builds the server query: tabs without a search, no tabs while searching, too-short text ignored', () => {
    const tabs = new URLSearchParams(conversationQuery({ ...EMPTY_FILTERS, channel: 'email', accountId: 'a1', unread: true, wf: 'pending', view: 'me' }, 'CUR'));
    expect(Object.fromEntries(tabs)).toEqual({ wf: 'pending', view: 'me', channel: 'email', account: 'a1', unread: '1', cursor: 'CUR', limit: '40' });
    // a search looks through every status and view (and its counters are not exact anyway)
    const searching = new URLSearchParams(conversationQuery({ ...EMPTY_FILTERS, channel: 'email', wf: 'done', view: 'ai', q: 'báo giá' }, 'CUR'));
    expect(Object.fromEntries(searching)).toEqual({ channel: 'email', q: 'báo giá', cursor: 'CUR', limit: '40' });
    expect(Object.fromEntries(new URLSearchParams(conversationQuery({ ...EMPTY_FILTERS, q: 'a' })))).toEqual({ wf: 'open', view: 'all', limit: '40' });
    expect(effectiveQuery(' ab ')).toBe('ab');
  });
  it('search keeps the account scope and the cursor', () => {
    expect(Object.fromEntries(new URLSearchParams(searchQuery({ ...EMPTY_FILTERS, q: 'hợp đồng', accountId: 'a2' }, 'NXT')))).toEqual({ q: 'hợp đồng', account: 'a2', cursor: 'NXT', limit: '20' });
  });
  it('a filter change changes the key (cursors reset); same filters keep it', () => {
    expect(filterKey({ ...EMPTY_FILTERS, q: 'a' })).toBe(filterKey(EMPTY_FILTERS)); // 1 char = no filter
    expect(filterKey({ ...EMPTY_FILTERS, unread: true })).not.toBe(filterKey(EMPTY_FILTERS));
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(filterKey({ ...EMPTY_FILTERS, wf: 'done' })).not.toBe(filterKey(EMPTY_FILTERS));
    expect(filterKey({ ...EMPTY_FILTERS, view: 'me' })).not.toBe(filterKey(EMPTY_FILTERS));
    // tabs are not part of a search: flipping one while searching must not refetch
    expect(filterKey({ ...EMPTY_FILTERS, q: 'khách', wf: 'done' })).toBe(filterKey({ ...EMPTY_FILTERS, q: 'khách', wf: 'open' }));
  });
  it('switching channel drops an account of another channel', () => {
    const accounts = [{ id: 'z', channel: 'zalo' as const }, { id: 'e', channel: 'email' as const }];
    expect(reconcileAccount({ ...EMPTY_FILTERS, channel: 'email', accountId: 'z' }, accounts).accountId).toBe('');
    expect(reconcileAccount({ ...EMPTY_FILTERS, channel: 'email', accountId: 'e' }, accounts).accountId).toBe('e');
  });
});

describe('Telegram media that is not exported', () => {
  it('a photo without text is a labelled note, not an empty/unsupported bubble', () => {
    const v = describeMessage(msg({ text: '', metadata: { type: 'chat', unexportedMedia: { kind: 'photo', mimeType: 'image/webp', reason: 'unsupported' } } }));
    expect(v).toMatchObject({ placeholder: null, attachments: [], unexportedMedia: { kind: 'photo', reason: 'unsupported' } });
  });
  it('protected content keeps its reason; unknown shapes fall back safely; text is kept next to the note', () => {
    expect(describeMessage(msg({ text: 'xem anh', metadata: { type: 'chat', unexportedMedia: { kind: 'document', reason: 'restricted' } } }))).toMatchObject({ text: 'xem anh', unexportedMedia: { kind: 'document', reason: 'restricted' } });
    expect(describeMessage(msg({ text: '', metadata: { type: 'chat', unexportedMedia: { kind: 'weird', reason: 'x' } } })).unexportedMedia).toEqual({ kind: 'document', reason: 'unsupported' });
    expect(describeMessage(msg({ text: 'hi', metadata: { type: 'chat', unexportedMedia: 'junk' } })).unexportedMedia).toBeNull();
  });
  it('a tombstone never shows the media note', () => {
    expect(describeMessage(msg({ text: '', deleted: true, metadata: { type: 'chat', unexportedMedia: { kind: 'photo', reason: 'restricted' } } }))).toMatchObject({ placeholder: 'deleted', unexportedMedia: null });
  });
});
