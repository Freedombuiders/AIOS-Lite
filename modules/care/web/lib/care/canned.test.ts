import { describe, expect, it } from 'vitest';
import { applyCanned, cannedBody, detectSlash, filterCanned, normalizeText } from './canned';
import { countPlaceholders, findPlaceholders, nextPlaceholder, splitByPlaceholders } from './placeholders';
import type { CareCannedReplyDto } from './dto';

const item = (over: Partial<CareCannedReplyDto>): CareCannedReplyDto => ({ id: 'c', shortcut: 'x', title: 'X', body: 'body', emailBody: null, sort: 0, updatedAtMs: 1, ...over });
const CANNED = [
  item({ id: '1', shortcut: 'nhantien', title: 'Xác nhận đã nhận tiền', body: 'Dạ em đã nhận được thanh toán.', sort: 1 }),
  item({ id: '2', shortcut: 'stk', title: 'Thông tin chuyển khoản', body: 'STK: [SỐ TÀI KHOẢN]', emailBody: 'Dạ chị chuyển khoản giúp em: [SỐ TÀI KHOẢN]', sort: 2 }),
  item({ id: '3', shortcut: 'lichhoc', title: 'Lịch học', body: 'Lớp học vào [LỊCH HỌC]', sort: 3 }),
  item({ id: '4', shortcut: 'camon', title: 'Cảm ơn', body: 'Em cảm ơn chị ạ.', sort: 4 }),
];

describe('slash trigger', () => {
  it('opens on a / at the start of the text or of a line', () => {
    expect(detectSlash('/', 1)).toEqual({ start: 0, query: '' });
    expect(detectSlash('/stk', 4)).toEqual({ start: 0, query: 'stk' });
    expect(detectSlash('Dạ chị\n/cam', 11)).toEqual({ start: 7, query: 'cam' });
  });
  it('does not open for a / inside a line, a URL, or after the caret moved past a space', () => {
    expect(detectSlash('xin chào /stk', 13)).toBeNull();
    expect(detectSlash('https://x.test/a', 16)).toBeNull();
    expect(detectSlash('/stk ', 5)).toBeNull();
    expect(detectSlash('hello', 5)).toBeNull();
  });
  it('only looks at what is before the caret', () => {
    expect(detectSlash('/stk gửi chị', 4)).toEqual({ start: 0, query: 'stk' });
    expect(detectSlash('/stk', 0)).toBeNull();
  });
});

describe('filtering', () => {
  it('no query lists everything in the saved order', () => {
    expect(filterCanned(CANNED, '').map((c) => c.shortcut)).toEqual(['nhantien', 'stk', 'lichhoc', 'camon']);
  });
  it('shortcut prefix first, then shortcut/title contains; accents are ignored', () => {
    expect(filterCanned(CANNED, 'st').map((c) => c.shortcut)).toEqual(['stk']);
    expect(filterCanned(CANNED, 'cam').map((c) => c.shortcut)).toEqual(['camon']);
    expect(filterCanned(CANNED, 'tien').map((c) => c.shortcut)).toEqual(['nhantien']); // inside the shortcut
    expect(filterCanned(CANNED, 'lich hoc').map((c) => c.shortcut)).toEqual(['lichhoc']); // title match, accents ignored
    expect(filterCanned(CANNED, 'chuyen khoan').map((c) => c.shortcut)).toEqual(['stk']); // title, no accents
    expect(filterCanned(CANNED, 'zzz')).toEqual([]);
  });
  it('a typed leading slash is ignored', () => {
    expect(filterCanned(CANNED, '/stk').map((c) => c.shortcut)).toEqual(['stk']);
  });
  it('normalizes đ and accents', () => {
    expect(normalizeText('Đã gửi Cảm ơn')).toBe('da gui cam on');
  });
});

describe('insertion', () => {
  it('email uses the longer variant when there is one', () => {
    expect(cannedBody(CANNED[1], 'email')).toContain('chị chuyển khoản');
    expect(cannedBody(CANNED[1], 'zalo')).toBe('STK: [SỐ TÀI KHOẢN]');
    expect(cannedBody(CANNED[3], 'email')).toBe('Em cảm ơn chị ạ.'); // no email variant
    expect(cannedBody(item({ body: 'a', emailBody: '  ' }), 'email')).toBe('a');
  });
  it('replaces the typed /query with the body', () => {
    const r = applyCanned('/stk', 4, detectSlash('/stk', 4), 'STK: 123');
    expect(r).toEqual({ text: 'STK: 123', caret: 8 });
  });
  it('keeps the text before and after, on a later line', () => {
    const text = 'Dạ chị\n/ca và cảm ơn';
    const caret = 'Dạ chị\n/ca'.length;
    const r = applyCanned(text, caret, detectSlash(text, caret), 'Cảm ơn chị');
    expect(r.text).toBe('Dạ chị\nCảm ơn chị và cảm ơn');
    expect(r.caret).toBe('Dạ chị\nCảm ơn chị'.length);
  });
  it('the / button inserts at the caret, on its own line after typed text', () => {
    expect(applyCanned('', 0, null, 'Xin chào')).toEqual({ text: 'Xin chào', caret: 8 });
    expect(applyCanned('Dạ chị', 6, null, 'Cảm ơn')).toEqual({ text: 'Dạ chị\nCảm ơn', caret: 13 });
    expect(applyCanned('Dạ chị\n', 7, null, 'Cảm ơn')).toEqual({ text: 'Dạ chị\nCảm ơn', caret: 13 });
  });
});

describe('placeholders', () => {
  it('finds [BLANKS] and ignores empty or nested brackets', () => {
    expect(findPlaceholders('Học phí: [GIÁ GÓI]. Ưu đãi: [ƯU ĐÃI]').map((p) => p.text)).toEqual(['[GIÁ GÓI]', '[ƯU ĐÃI]']);
    expect(countPlaceholders('không có')).toBe(0);
    expect(countPlaceholders('[]')).toBe(0);
    expect(countPlaceholders('[a [b] c]')).toBe(1);
    expect(countPlaceholders('dòng [một\nhai]')).toBe(0); // never spans lines
  });
  it('cuts text into plain and placeholder parts', () => {
    expect(splitByPlaceholders('A [x] B [y]')).toEqual([
      { text: 'A ', placeholder: false }, { text: '[x]', placeholder: true }, { text: ' B ', placeholder: false }, { text: '[y]', placeholder: true },
    ]);
    expect(splitByPlaceholders('')).toEqual([]);
  });
  it('jumps to the next blank and wraps around', () => {
    const t = 'a [x] b [y]';
    expect(nextPlaceholder(t, 0)).toMatchObject({ text: '[x]', start: 2 });
    expect(nextPlaceholder(t, 5)).toMatchObject({ text: '[y]' });
    expect(nextPlaceholder(t, 11)).toMatchObject({ text: '[x]' });
    expect(nextPlaceholder('none', 0)).toBeNull();
  });
});
