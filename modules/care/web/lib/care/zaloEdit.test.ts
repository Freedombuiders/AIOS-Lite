import { describe, expect, it } from 'vitest';
import type { ChatMention } from './composer';
import { msg } from './fixtures.test-util';
import {
  adjustMentionsForEdit, detectMention, editText, filterMentions, insertMention, insertText, mentionCandidates, patchChatFields, type RichFields,
} from './zaloEdit';

const fields = (text: string, over: Partial<RichFields> = {}): RichFields => ({ text, styles: [], mentions: [], ...over });
const mention = (pos: number, len: number, uid = 'u1'): ChatMention => ({ uid, pos, len });

describe('mentions follow the text', () => {
  const text = 'Chào @An và @Bình nhé';
  const mentions = [mention(5, 3, 'a'), mention(11, 6, 'b')];

  it('text typed before them shifts them', () => {
    expect(adjustMentionsForEdit(mentions, text, `Xin ${text}`)).toEqual([mention(9, 3, 'a'), mention(15, 6, 'b')]);
  });

  it('deleting before them shifts them back; typing after them leaves them alone', () => {
    expect(adjustMentionsForEdit(mentions, text, text.slice(5))).toEqual([mention(0, 3, 'a'), mention(6, 6, 'b')]);
    expect(adjustMentionsForEdit(mentions, text, `${text}!!`)).toEqual(mentions);
  });

  it('editing inside a mention drops only that mention', () => {
    expect(adjustMentionsForEdit(mentions, text, text.replace('@An', '@Ân'))).toEqual([mention(11, 6, 'b')]);
    expect(adjustMentionsForEdit(mentions, text, text.replace('@Bình', '@Bìn'))).toEqual([mention(5, 3, 'a')]);
  });

  it('deleting a whole mention removes it; typing right after it does not extend it', () => {
    expect(adjustMentionsForEdit([mention(5, 3, 'a')], 'Chào @An', 'Chào ')).toEqual([]);
    expect(adjustMentionsForEdit([mention(5, 3, 'a')], 'Chào @An', 'Chào @An,')).toEqual([mention(5, 3, 'a')]);
  });

  it('editText moves styles and mentions together', () => {
    const f = fields('Chào @An', { styles: [{ st: 'b', start: 0, len: 4 }], mentions: [mention(5, 3, 'a')] });
    const next = editText(f, '>> Chào @An');
    expect(next.styles).toEqual([{ st: 'b', start: 3, len: 4 }]);
    expect(next.mentions).toEqual([mention(8, 3, 'a')]);
    expect(editText(f, f.text)).toBe(f);
  });
});

describe('insert at the caret', () => {
  it('shifts styles and mentions that sit after the insertion', () => {
    const f = fields('ab cd', { styles: [{ st: 'b', start: 3, len: 2 }], mentions: [mention(3, 2)] });
    const r = insertText(f, 2, 2, '😀', 100)!;
    expect(r.fields.text).toBe('ab😀 cd');
    expect(r.caret).toBe(4);
    expect(r.fields.styles).toEqual([{ st: 'b', start: 5, len: 2 }]);
    expect(r.fields.mentions).toEqual([mention(5, 2)]);
  });

  it('replaces the selection and keeps ranges before it', () => {
    const f = fields('xin chào bạn', { styles: [{ st: 'i', start: 0, len: 3 }] });
    const r = insertText(f, 4, 8, 'bạn', 100)!;
    expect(r.fields.text).toBe('xin bạn bạn');
    expect(r.fields.styles).toEqual([{ st: 'i', start: 0, len: 3 }]);
  });

  it('refuses to pass the max length', () => {
    expect(insertText(fields('abcd'), 4, 4, 'ef', 5)).toBeNull();
    expect(insertText(fields('abcd'), 4, 4, 'e', 5)?.fields.text).toBe('abcde');
  });

  it('clamps an out-of-range caret', () => {
    expect(insertText(fields('ab'), 99, 120, '!')?.fields.text).toBe('ab!');
  });
});

describe('@mention picker logic', () => {
  it('opens on an @ at the start or after a space, never inside a word', () => {
    expect(detectMention('@', 1)).toEqual({ start: 0, query: '' });
    expect(detectMention('Chào @Bi', 8)).toEqual({ start: 5, query: 'Bi' });
    expect(detectMention('a@b', 3)).toBeNull();
    expect(detectMention('Chào @Bình nhé', 14)).toBeNull();
    expect(detectMention('line\n@x', 7)).toEqual({ start: 5, query: 'x' });
  });

  it('builds candidates from inbound senders, newest name wins, no duplicates, no unnamed or own', () => {
    const m = (id: string, uid: string, name: string, over: object = {}) => msg({ id, direction: 'in', metadata: { type: 'chat', rawEnvelope: { senderUid: uid, senderName: name } }, ...over });
    const out = mentionCandidates([
      m('3', 'u2', 'Bình'), m('2', 'u1', 'An Nguyễn'), m('1', 'u1', 'An cũ'),
      m('4', 'u3', ''), msg({ id: '5', direction: 'out', metadata: { type: 'chat', rawEnvelope: { senderUid: 'me', senderName: 'Shop' } } }),
      msg({ id: '6', direction: 'in', senderName: 'Chi', metadata: { type: 'chat', rawEnvelope: { senderUid: 'u4', senderName: '' } } }),
    ]);
    expect(out.map((c) => [c.uid, c.name])).toEqual([['u1', 'An Nguyễn'], ['u2', 'Bình'], ['u4', 'Chi']]);
  });

  it('filters without accents and offers @all first', () => {
    const c = [{ uid: 'u1', name: 'Bình', type: 0 as const }, { uid: 'u2', name: 'An', type: 0 as const }];
    expect(filterMentions(c, '', 'Tất cả').map((x) => x.uid)).toEqual(['all', 'u1', 'u2']);
    expect(filterMentions(c, 'bi', 'Tất cả').map((x) => x.uid)).toEqual(['u1']);
    expect(filterMentions(c, 'tat', 'Tất cả').map((x) => x.uid)).toEqual(['all']);
  });

  it('picking replaces the typed @query, adds a trailing space and records the range', () => {
    const f = fields('Chào @Bi nhé', { styles: [{ st: 'b', start: 9, len: 3 }] });
    const trig = detectMention(f.text, 8)!;
    const r = insertMention(f, trig, 8, { uid: 'u1', name: 'Bình', type: 0 }, 100)!;
    expect(r.fields.text).toBe('Chào @Bình  nhé');
    expect(r.fields.mentions).toEqual([{ uid: 'u1', pos: 5, len: 5 }]);
    expect(r.caret).toBe(11);
    expect(r.fields.styles).toEqual([{ st: 'b', start: 12, len: 3 }]);
  });

  it('@all records type 1 and mentions stay sorted by position', () => {
    let f = fields('@x');
    f = insertMention(f, { start: 0 }, 2, { uid: 'all', name: 'Tất cả', type: 1 }, 100)!.fields;
    expect(f.mentions).toEqual([{ uid: 'all', pos: 0, len: 7, type: 1 }]);
    f = insertMention({ ...f, text: `${f.text}@y` }, { start: f.text.length }, f.text.length + 2, { uid: 'u1', name: 'An', type: 0 }, 100)!.fields;
    expect(f.mentions.map((m) => m.uid)).toEqual(['all', 'u1']);
  });

  it('refuses a mention that would pass the max length', () => {
    expect(insertMention(fields('@a'), { start: 0 }, 2, { uid: 'u', name: 'Rất dài', type: 0 }, 5)).toBeNull();
  });
});

describe('patchChatFields', () => {
  it('only touches chat drafts and removes empty ranges', () => {
    const chat = { kind: 'chat' as const, text: 'ab', styles: [{ st: 'b', start: 0, len: 2 }], requestId: null, payloadKey: null };
    const out = patchChatFields(chat, (f) => editText(f, ''));
    expect(out.text).toBe('');
    expect(out.styles).toBeUndefined();
    const email = { kind: 'email' as const, body: 'x' };
    expect(patchChatFields(email, (f) => f)).toBe(email);
  });
});
