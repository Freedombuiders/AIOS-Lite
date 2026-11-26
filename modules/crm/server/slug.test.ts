import { describe, expect, it } from 'vitest';
import { freeNotePath, slugify } from './slug.js';

describe('slug', () => {
  it('strips Vietnamese diacritics, lower-cases and joins with hyphens', () => {
    expect(slugify('Chị Lan')).toBe('chi-lan');
    expect(slugify('  Đặng Thị Ánh Nguyệt (Hà Nội) ')).toBe('dang-thi-anh-nguyet-ha-noi');
    expect(slugify('Trà sen — Tây Hồ!!')).toBe('tra-sen-tay-ho');
    expect(slugify('🙂')).toBe('khach');
    expect(slugify('a'.repeat(200)).length).toBe(80);
  });

  it('appends -2, -3 on collision', () => {
    const taken = new Set(['khach-hang/chi-lan.md', 'khach-hang/chi-lan-2.md']);
    expect(freeNotePath('khach-hang', 'Chị Lan', (p) => taken.has(p))).toBe('khach-hang/chi-lan-3.md');
    expect(freeNotePath('khach-hang', 'Anh Nam', (p) => taken.has(p))).toBe('khach-hang/anh-nam.md');
  });
});
