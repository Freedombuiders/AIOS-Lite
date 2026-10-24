import { describe, expect, it } from 'vitest';

import {
  detectContentType,
  extractMentions,
  extractQuote,
  foldVietnamese,
  matchesAnyKeyword,
  mediaUrl,
  renderText,
  serializeContent,
} from './content.js';

describe('detectContentType', () => {
  it('classifies plain text and missing msgType as text', () => {
    expect(detectContentType('webchat', 'xin chào')).toBe('text');
    expect(detectContentType(undefined, 'xin chào')).toBe('text');
  });

  it('maps msgType keywords', () => {
    expect(detectContentType('chat.photo', { href: 'https://x' })).toBe('image');
    expect(detectContentType('chat.sticker', {})).toBe('sticker');
    expect(detectContentType('share.file', { title: 'a.pdf' })).toBe('file');
    expect(detectContentType('chat.voice', {})).toBe('voice');
  });

  it('checks call/bank/link actions before the "recommended" card keyword', () => {
    expect(detectContentType('chat.recommended', { action: 'recommened.calltime' })).toBe('call');
    expect(detectContentType('chat.recommended', { action: 'recommended.misscall' })).toBe('call');
    expect(detectContentType('chat.recommended', { action: 'zinstant.bankcard' })).toBe('bank_transfer');
    expect(detectContentType('chat.recommended', { action: 'recommened.link', href: 'https://fb.com/x' })).toBe('link');
    expect(detectContentType('chat.recommended', { action: 'recommened.user' })).toBe('contact_card');
  });

  it('falls back to rich for unknown object payloads', () => {
    expect(detectContentType('chat.unknown', { foo: 1 })).toBe('rich');
  });
});

describe('extractMentions', () => {
  it('reads direct group mentions', () => {
    expect(extractMentions({ mentions: [{ uid: '42', pos: 0, len: 5, type: 0 }] }))
      .toEqual([{ uid: '42', pos: 0, len: 5, type: 0 }]);
  });

  it('falls back to the JSON packed in propertyExt.ext', () => {
    const data = { propertyExt: { ext: JSON.stringify({ mentions: [{ uid: '7', pos: 2, len: 4, type: 1 }] }) } };
    expect(extractMentions(data)).toEqual([{ uid: '7', pos: 2, len: 4, type: 1 }]);
  });

  it('returns undefined when there are none or the ext is malformed', () => {
    expect(extractMentions({})).toBeUndefined();
    expect(extractMentions({ propertyExt: { ext: '{bad' } })).toBeUndefined();
    expect(extractMentions({ mentions: [{ uid: '', pos: 0, len: 0 }] })).toBeUndefined();
  });
});

describe('extractQuote', () => {
  it('keeps the quoted owner, text and sender name', () => {
    expect(extractQuote({ quote: { ownerId: 99, msg: 'giá bao nhiêu', fromD: 'An' } }))
      .toEqual({ ownerUid: '99', text: 'giá bao nhiêu', senderName: 'An' });
    expect(extractQuote({})).toBeUndefined();
  });
});

describe('Vietnamese folding', () => {
  it('strips diacritics and đ', () => {
    expect(foldVietnamese('Báo GIÁ Đặt Lịch')).toBe('bao gia dat lich');
  });

  it('matches keywords regardless of accents', () => {
    expect(matchesAnyKeyword('Cho em xin báo giá ạ', ['bao gia'])).toBe(true);
    expect(matchesAnyKeyword('Cho em xin báo giá ạ', ['học phí'])).toBe(false);
    expect(matchesAnyKeyword('anything', [])).toBe(false);
    expect(matchesAnyKeyword('anything', ['  '])).toBe(false);
  });
});

describe('renderText / mediaUrl', () => {
  it('renders text bodies as-is and labels the rest', () => {
    expect(renderText('text', 'hello')).toBe('hello');
    expect(renderText('sticker', '{}')).toBe('[Sticker]');
    expect(renderText('file', JSON.stringify({ title: 'baogia.pdf', href: 'https://f' }))).toBe('[File] baogia.pdf');
    expect(renderText('link', JSON.stringify({ title: 'Video', href: 'https://yt' }))).toBe('[Link] Video https://yt');
  });

  it('serializes object content and finds a media url', () => {
    const body = serializeContent({ href: 'https://cdn/img.jpg', thumb: 'https://cdn/t.jpg' });
    expect(mediaUrl(body)).toBe('https://cdn/img.jpg');
    expect(mediaUrl('plain')).toBeNull();
    expect(serializeContent(undefined)).toBe('');
  });
});
