// The numbers of the formula loop, in code: thresholds, the baseline without the post itself, the fixed expectation.
import { describe, expect, it } from 'vitest';
import { comparePost, expectedRatioFor, formulaResult, latestComparison, linkSlug, stateOf, type PostNote } from './formula-stats.js';

const post = (relPath: string, er24: number | null, over: Record<string, unknown> = {}): PostNote => ({
  relPath,
  data: { loai: 'bai-dang', id: relPath, nen_tang: 'facebook', dang_luc: '2026-11-20T19:00:00+07:00', so_do: er24 === null ? [] : [{ moc: '24h', er: er24 }], ...over },
});
/** a post of the formula whose 24h comparison is already in its note */
const made = (relPath: string, vs: number, ratio = vs * 1.5): PostNote => post(relPath, 5, { doi_chieu: [{ moc: '24h', ti_le: ratio, so_voi_ky_vong: vs }] });

describe('comparePost', () => {
  it('leaves the post being scored out of its own baseline', () => {
    const self = post('noi-dung/bai/minh.md', 10);
    const all = [self, post('noi-dung/bai/a.md', 2), post('noi-dung/bai/b.md', 4)];
    const c = comparePost(self, all, '24h', 1.5)!;
    // with itself in the median it would be 4; without it, 3
    expect(c).toMatchObject({ er: 10, baselineEr: 3, baselineN: 2, ratio: 3.33, vsExpected: 2.22 });
  });

  it('compares only at the same milestone and platform, and only with posts published before, within 90 days', () => {
    const self = post('noi-dung/bai/minh.md', 6, { so_do: [{ moc: '24h', er: 6 }, { moc: '7d', er: 9 }] });
    const all = [
      self,
      post('noi-dung/bai/a.md', 4),
      post('noi-dung/bai/7d-only.md', null, { so_do: [{ moc: '7d', er: 100 }] }),
      post('noi-dung/bai/tiktok.md', 100, { nen_tang: 'tiktok' }),
      post('noi-dung/bai/later.md', 100, { dang_luc: '2026-11-25T19:00:00+07:00' }),
      post('noi-dung/bai/old.md', 100, { dang_luc: '2026-01-01T19:00:00+07:00' }),
    ];
    expect(comparePost(self, all, '24h', 1.5)).toMatchObject({ baselineEr: 4, baselineN: 1, ratio: 1.5, vsExpected: 1 });
    expect(comparePost(self, all, '7d', 1.5)).toMatchObject({ baselineEr: 100, baselineN: 1 });
  });

  it('keeps unknowns unknown: no ER at the milestone gives no comparison, no baseline gives no ratio', () => {
    expect(comparePost(post('x.md', null), [], '24h', 1.5)).toBeNull();
    expect(comparePost(post('x.md', 5), [post('x.md', 5)], '24h', 1.5)).toMatchObject({ baselineEr: null, baselineN: 0, ratio: null, vsExpected: null });
  });
});

describe('formula state', () => {
  it('2 posts with ket_qua 1.3 are co-ve-hop, 3 are hop, 3 at 0.8 are chua-hop, all exploratory', () => {
    const two = formulaResult([made('a.md', 1.3), made('b.md', 1.3)]);
    expect(two).toMatchObject({ da_lam: 2, ket_qua: 1.3, trang_thai: 'co-ve-hop', tham_do: true });
    expect(formulaResult([made('a.md', 1.3), made('b.md', 1.3), made('c.md', 1.3)])).toMatchObject({ da_lam: 3, ket_qua: 1.3, trang_thai: 'hop', tham_do: true });
    expect(formulaResult([made('a.md', 0.8), made('b.md', 0.8), made('c.md', 0.8)])).toMatchObject({ da_lam: 3, ket_qua: 0.8, trang_thai: 'chua-hop' });
  });

  it('thresholds in between, and no post at all', () => {
    expect(stateOf(0, null)).toBe('chua-thu');
    expect(stateOf(1, 0.95)).toBe('chua-hop');
    expect(stateOf(3, 1.0)).toBe('co-ve-hop');
    expect(stateOf(3, 0.9)).toBe('co-ve-hop');
    expect(stateOf(3, 1.2)).toBe('hop');
    expect(formulaResult([post('a.md', 5)])).toMatchObject({ da_lam: 0, ket_qua: null, trang_thai: 'chua-thu' });
    expect(formulaResult(Array.from({ length: 5 }, (_, i) => made(`${i}.md`, 1.3))).tham_do).toBe(false);
  });

  it('a post counts once, at its latest compared milestone', () => {
    const p = post('a.md', 5, { doi_chieu: [{ moc: '24h', ti_le: 1.5, so_voi_ky_vong: 1 }, { moc: '7d', ti_le: 3, so_voi_ky_vong: 2 }] });
    expect(latestComparison(p.data)).toEqual({ moc: '7d', ti_le: 3, so_voi_ky_vong: 2 });
    expect(formulaResult([p])).toMatchObject({ da_lam: 1, ket_qua: 2, ti_le_trung_vi: 3 });
  });
});

describe('expectation fixed on a new idea', () => {
  it('is ky_vong until the formula has 3 own posts, then their median ratio', () => {
    expect(expectedRatioFor([], undefined)).toBe(1.5);
    expect(expectedRatioFor([made('a.md', 1, 2), made('b.md', 1, 3)], 1.8)).toBe(1.8);
    expect(expectedRatioFor([made('a.md', 1, 2), made('b.md', 1, 3), made('c.md', 1, 1.2)], 1.8)).toBe(2);
  });

  it('reads wiki links', () => {
    expect(linkSlug('[[huong-dan-3-buoc]]')).toBe('huong-dan-3-buoc');
    expect(linkSlug('[[cong-thuc/huong-dan-3-buoc|Hướng dẫn]]')).toBe('huong-dan-3-buoc');
    expect(linkSlug('huong-dan')).toBe('');
  });
});
