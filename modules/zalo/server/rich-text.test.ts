import { describe, expect, it } from 'vitest';

import { markdownToRich, normalizeZaloStyles, remapStyles, shiftStyles, trimRich, trimRichMentions } from './rich-text.js';

describe('normalizeZaloStyles', () => {
  it('drops unknown codes, bad shapes and empty ranges', () => {
    const out = normalizeZaloStyles([
      { st: 'b', start: 0, len: 3 },
      { st: 'rainbow', start: 0, len: 3 },
      { st: 'c_zzzzzz', start: 0, len: 3 },
      { st: 'i', start: 1.5, len: 2 },
      { st: 'u', start: -1, len: 2 },
      { st: 's', start: 2, len: 0 },
      { st: 'b', start: 50, len: 2 },
      null,
      'x',
    ], 10);
    expect(out).toEqual([{ st: 'b', start: 0, len: 3 }]);
  });

  it('clamps an overflowing tail instead of discarding the range', () => {
    expect(normalizeZaloStyles([{ st: 'b', start: 4, len: 100 }], 10)).toEqual([{ st: 'b', start: 4, len: 6 }]);
  });

  it('accepts the zca-js colours and sizes, lowercases hex, rejects non-hex', () => {
    const out = normalizeZaloStyles([
      { st: 'c_DB342E', start: 0, len: 2 },
      { st: 'f_18', start: 2, len: 2 },
      { st: 'c_12345', start: 4, len: 2 },
    ], 10);
    expect(out.map((s) => s.st)).toEqual(['c_db342e', 'f_18']);
  });

  it('merges overlapping and touching inline ranges but keeps list lines apart', () => {
    expect(normalizeZaloStyles([{ st: 'b', start: 0, len: 3 }, { st: 'b', start: 3, len: 2 }, { st: 'b', start: 1, len: 1 }], 10))
      .toEqual([{ st: 'b', start: 0, len: 5 }]);
    expect(normalizeZaloStyles([{ st: 'lst_1', start: 0, len: 3 }, { st: 'lst_1', start: 3, len: 3 }], 10))
      .toHaveLength(2);
  });

  it('clamps indentSize and returns [] for non-arrays', () => {
    expect(normalizeZaloStyles([{ st: 'ind_$', start: 0, len: 2, indentSize: 99 }], 5)[0].indentSize).toBe(16);
    expect(normalizeZaloStyles(undefined, 5)).toEqual([]);
    expect(normalizeZaloStyles({}, 5)).toEqual([]);
  });
});

describe('trimRich', () => {
  it('shifts and clamps ranges when whitespace is cut', () => {
    const r = trimRich('  hello  ', [{ st: 'b', start: 0, len: 4 }, { st: 'i', start: 2, len: 5 }]);
    expect(r.text).toBe('hello');
    expect(r.styles).toEqual([{ st: 'b', start: 0, len: 2 }, { st: 'i', start: 0, len: 5 }]);
  });

  it('returns nothing for blank text', () => {
    expect(trimRich('   ', [{ st: 'b', start: 0, len: 3 }])).toEqual({ text: '', styles: [] });
  });
});

describe('shiftStyles', () => {
  it('moves later ranges, grows a range that contains the edit, covers a replacement', () => {
    // "ab[CD]ef" -> replace [2,4) with 3 chars
    const out = shiftStyles([
      { st: 'b', start: 0, len: 2 },
      { st: 'i', start: 1, len: 5 },
      { st: 'u', start: 2, len: 2 },
      { st: 's', start: 4, len: 2 },
    ], 2, 4, 3);
    expect(out).toEqual([
      { st: 'b', start: 0, len: 2 },
      { st: 'i', start: 1, len: 6 },
      { st: 'u', start: 2, len: 3 },
      { st: 's', start: 5, len: 2 },
    ]);
  });
});

describe('remapStyles', () => {
  it('follows copied text, covers replacements and drops deleted spans', () => {
    // old: "AAxxBB" with xx replaced by "yyyy" and "BB" deleted
    const out = remapStyles(
      [{ st: 'b', start: 0, len: 4 }, { st: 'i', start: 4, len: 2 }],
      [
        { kind: 'copy', oldStart: 0, oldEnd: 2, newStart: 0, newLen: 2 },
        { kind: 'replace', oldStart: 2, oldEnd: 4, newStart: 2, newLen: 4 },
      ],
      6,
    );
    expect(out).toEqual([{ st: 'b', start: 0, len: 6 }]);
  });
});

describe('markdownToRich', () => {
  it('converts bold, italic, underline and strike into ranges', () => {
    const r = markdownToRich('**Giá** hôm nay *rất* __tốt__ ~~cũ~~');
    expect(r.text).toBe('Giá hôm nay rất tốt cũ');
    expect(r.styles).toEqual([
      { st: 'b', start: 0, len: 3 },
      { st: 'i', start: 12, len: 3 },
      { st: 'u', start: 16, len: 3 },
      { st: 's', start: 20, len: 2 },
    ]);
  });

  it('handles nesting and leaves stray markers, bullets and braces alone', () => {
    const r = markdownToRich('**a *b* c**\n* mục\n2 * 3 = 6 {name} {x|y}');
    expect(r.text).toBe('a b c\n* mục\n2 * 3 = 6 {name} {x|y}');
    expect(r.styles).toContainEqual({ st: 'b', start: 0, len: 5 });
    expect(r.styles).toContainEqual({ st: 'i', start: 2, len: 1 });
  });

  it('turns a heading into a bold line and trims with aligned ranges', () => {
    const r = markdownToRich('\n# Tiêu đề\nnội dung\n');
    expect(r.text).toBe('Tiêu đề\nnội dung');
    expect(r.styles).toEqual([{ st: 'b', start: 0, len: 7 }]);
  });
});

describe('trimRichMentions', () => {
  it('shifts styles and mentions by the leading whitespace and drops what no longer fits', () => {
    const text = '  \nHi @An, xem bảng giá  ';
    const at = text.indexOf('@An');
    const r = trimRichMentions(
      text,
      [{ st: 'b', start: text.indexOf('bảng'), len: 8 }, { st: 'i', start: 0, len: 4 }],
      [
        { uid: 'u1', pos: at, len: 3, type: 0 },
        { uid: 'u2', pos: 0, len: 4, type: 0 }, // sat inside the trimmed whitespace
        { uid: 'u3', pos: text.length - 1, len: 5, type: 0 }, // runs past the end
      ],
    );
    expect(r.text).toBe('Hi @An, xem bảng giá');
    // the italic range covered 3 trimmed whitespace chars and 1 real one
    expect(r.styles).toEqual([{ st: 'i', start: 0, len: 1 }, { st: 'b', start: r.text.indexOf('bảng'), len: 8 }]);
    expect(r.mentions).toEqual([{ uid: 'u1', pos: 3, len: 3, type: 0 }]);
    expect(r.text.slice(r.mentions[0].pos, r.mentions[0].pos + r.mentions[0].len)).toBe('@An');
  });

  it('is the identity for already-trimmed text', () => {
    const r = trimRichMentions('abc def', [{ st: 'u', start: 4, len: 3 }], [{ uid: 'u', pos: 0, len: 3, type: 1 }]);
    expect(r).toEqual({ text: 'abc def', styles: [{ st: 'u', start: 4, len: 3 }], mentions: [{ uid: 'u', pos: 0, len: 3, type: 1 }] });
  });

  it('returns nothing for blank text', () => {
    expect(trimRichMentions('   ', [{ st: 'b', start: 0, len: 2 }], [{ uid: 'u', pos: 0, len: 1, type: 0 }])).toEqual({ text: '', styles: [], mentions: [] });
  });
});
