import { describe, expect, it } from 'vitest';
import { composeNote, parseFrontmatter, writeFrontmatter } from './frontmatter.js';

const BODY = '# Chị Lan\n\nKhách hỏi sỉ: "giá: bao nhiêu?"\n\n- [ ] gọi lại\n';

describe('parseFrontmatter', () => {
  it('reads a file without a block as body only', () => {
    expect(parseFrontmatter(BODY)).toEqual({ data: {}, body: BODY, has: false });
    expect(parseFrontmatter('')).toEqual({ data: {}, body: '', has: false });
    // a horizontal rule later in the file is not a block
    expect(parseFrontmatter('text\n---\nx: 1\n---\n').has).toBe(false);
  });

  it('reads comments, arrays, strings with colons and Vietnamese text', () => {
    const text = [
      '---',
      '# do máy ghi',
      'loai: khach-hang',
      'ten: Chị Lan   # tên gọi',
      'nguon: "Bài đăng: Trà sen Tây Hồ"',
      'the: [hoi-si, o-long-sen]',
      'moc:',
      '  - 1h',
      '  - 6h',
      'sdt:',
      'han: 2026-11-28',
      '---',
      BODY,
    ].join('\n');
    const fm = parseFrontmatter(text);
    expect(fm.has).toBe(true);
    expect(fm.data).toEqual({ loai: 'khach-hang', ten: 'Chị Lan', nguon: 'Bài đăng: Trà sen Tây Hồ', the: ['hoi-si', 'o-long-sen'], moc: ['1h', '6h'], sdt: null, han: '2026-11-28' });
    expect(fm.body).toBe(BODY);
  });

  it('handles BOM, CRLF and an empty block', () => {
    expect(parseFrontmatter('﻿---\r\na: 1\r\n---\r\nthân\r\n')).toEqual({ data: { a: 1 }, body: 'thân\r\n', has: true });
    expect(parseFrontmatter('---\n---\nthân')).toEqual({ data: {}, body: 'thân', has: true });
    expect(parseFrontmatter('---\na: 1\n---')).toEqual({ data: { a: 1 }, body: '', has: true });
  });

  it('throws on broken YAML', () => {
    expect(() => parseFrontmatter('---\na: [1, 2\n---\n')).toThrow();
  });
});

describe('writeFrontmatter', () => {
  const text = ['---', '# do máy ghi', 'loai: khach-hang', 'ten: Chị Lan', 'zalo: chua-ket-ban   # ban-be | chua-ket-ban', 'the: [hoi-si]', 'sdt:', '---', BODY].join('\n');

  it('keeps key order and comments, appends new keys, never touches the body', () => {
    const out = writeFrontmatter(text, { zalo: 'ban-be', gia_tri: 14352000, sdt: '0901234567' });
    const fm = parseFrontmatter(out);
    expect(Object.keys(fm.data)).toEqual(['loai', 'ten', 'zalo', 'the', 'sdt', 'gia_tri']);
    expect(fm.data).toMatchObject({ zalo: 'ban-be', gia_tri: 14352000, sdt: '0901234567' });
    expect(out).toContain('# do máy ghi');
    expect(out).toContain('# ban-be | chua-ket-ban');
    expect(out.endsWith(BODY)).toBe(true);
    expect(fm.body).toBe(BODY);
  });

  it('round-trips arrays, colons, links and Vietnamese', () => {
    const patch = { the: ['hoi-si', 'co-cua-hang'], nguon: 'Bài đăng: "Trà sen"', cong_thuc: '[[huong-dan-3-buoc]]', viec_tiep: 'Hỏi lại sau khi gửi báo giá', moc_da_do: [] };
    const fm = parseFrontmatter(writeFrontmatter(text, patch));
    expect(fm.data).toMatchObject(patch);
    expect(fm.body).toBe(BODY);
  });

  it('removes a key given undefined', () => {
    const fm = parseFrontmatter(writeFrontmatter(text, { sdt: undefined }));
    expect('sdt' in fm.data).toBe(false);
  });

  it('adds a block to a file without one, body byte for byte', () => {
    const out = writeFrontmatter(BODY, { loai: 'bai-hoc', mang: 'noi-dung' });
    expect(out).toBe(`---\nloai: bai-hoc\nmang: noi-dung\n---\n${BODY}`);
    expect(writeFrontmatter(BODY, {})).toBe(BODY);
  });

  it('keeps CRLF line endings and the BOM', () => {
    const crlf = '﻿---\r\nloai: bai-hoc\r\n---\r\nDòng 1\r\nDòng 2\r\n';
    const out = writeFrontmatter(crlf, { mang: 'noi-dung' });
    expect(out).toBe('﻿---\r\nloai: bai-hoc\r\nmang: noi-dung\r\n---\r\nDòng 1\r\nDòng 2\r\n');
    expect(writeFrontmatter('a\r\nb\r\n', { x: 1 })).toBe('---\r\nx: 1\r\n---\r\na\r\nb\r\n');
  });

  it('fills an empty block and handles a body with "---" lines', () => {
    const body = 'trên\n---\ndưới\n';
    expect(writeFrontmatter(`---\n---\n${body}`, { a: 1 })).toBe(`---\na: 1\n---\n${body}`);
  });

  it('refuses a block that is not a mapping', () => {
    expect(() => writeFrontmatter('---\n- a\n---\n', { x: 1 })).toThrow();
  });
});

describe('composeNote', () => {
  it('writes data in order then the body', () => {
    const out = composeNote({ loai: 'bai-hoc', mang: 'noi-dung', bo_qua: undefined }, BODY);
    expect(out).toBe(`---\nloai: bai-hoc\nmang: noi-dung\n---\n${BODY}`);
    expect(parseFrontmatter(out).body).toBe(BODY);
  });
});
