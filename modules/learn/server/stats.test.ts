// stats.ts over a fixture of 24 bai-dang notes whose medians are worked out by hand below.
import { describe, expect, it } from 'vitest';
import { comparePost, contentLabStats, median, type NoteInput } from './stats.js';

const NOW = Date.UTC(2026, 10, 26, 3, 0, 0) / 1000;
const DAY = 86400;

const CP = 'Cách pha, ướp';
const SP = 'Sản phẩm';
const CS = 'Chính sách đại lý';
const QT = 'Quà Tết';

interface Spec {
  format: string;
  pillar: string;
  /** ER at 24h; null = a 24h entry without ER; undefined = no 24h entry */
  er24?: number | null;
  er7?: number;
  mo_dau?: string;
  kieu_hook?: string;
  do_dai?: number;
  so_chu?: number;
  ageDays?: number;
  platform?: string;
}

const SPECS: Spec[] = [
  // video-ngan × Cách pha, ướp: 6.5 7 5 8 6 → median 6.5 (n 5); lengths 25 28 | 40 45 50
  { format: 'video-ngan', pillar: CP, er24: 6.5, mo_dau: 'cau-hoi', do_dai: 25 },
  { format: 'video-ngan', pillar: CP, er24: 7, mo_dau: 'cau-hoi', do_dai: 28 },
  { format: 'video-ngan', pillar: CP, er24: 5, mo_dau: 'cau-hoi', do_dai: 40 },
  { format: 'video-ngan', pillar: CP, er24: 8, mo_dau: 'cau-hoi', do_dai: 45 },
  { format: 'video-ngan', pillar: CP, er24: 6, mo_dau: 'cau-hoi', do_dai: 50, er7: 5.5 },
  // measured at 7 days only: counts as a post of the cell, not in the 24h median
  { format: 'video-ngan', pillar: CP, er7: 50 },
  // video-ngan × Sản phẩm: 3 4 5 → 4 (n 3); marketing hook type without a mo_dau equivalent
  { format: 'video-ngan', pillar: SP, er24: 3, kieu_hook: 'gây tranh cãi' },
  { format: 'video-ngan', pillar: SP, er24: 4, kieu_hook: 'gây tranh cãi' },
  { format: 'video-ngan', pillar: SP, er24: 5, kieu_hook: 'gây tranh cãi' },
  // video-ngan × Quà Tết: one post → low sample
  { format: 'video-ngan', pillar: QT, er24: 9 },
  // anh × Cách pha: 2 3 → 2.5, low sample
  { format: 'anh', pillar: CP, er24: 2 },
  { format: 'anh', pillar: CP, er24: 3 },
  // anh × Sản phẩm: 1 2 3 10 → 2.5 (n 4); words 40 45 | 100 120
  { format: 'anh', pillar: SP, er24: 1, mo_dau: 'con-so', so_chu: 40 },
  { format: 'anh', pillar: SP, er24: 2, mo_dau: 'con-so', so_chu: 45 },
  { format: 'anh', pillar: SP, er24: 3, mo_dau: 'con-so', so_chu: 100 },
  { format: 'anh', pillar: SP, er24: 10, mo_dau: 'con-so', so_chu: 120 },
  // anh × Chính sách: 1.2 1.8 2.4 → 1.8 (n 3)
  { format: 'anh', pillar: CS, er24: 1.2, mo_dau: 'cau-chuyen' },
  { format: 'anh', pillar: CS, er24: 1.8, mo_dau: 'cau-chuyen' },
  { format: 'anh', pillar: CS, er24: 2.4, mo_dau: 'cau-chuyen' },
  // chu × Quà Tết: one measured (4), one not measured at 24h → n 1 of 2 posts
  { format: 'chu', pillar: QT, er24: 4 },
  { format: 'chu', pillar: QT, er7: 3 },
  // chu × Sản phẩm: a 24h entry without ER (reach but no counts): unmeasured, never 0
  { format: 'chu', pillar: SP, er24: null },
  // outside the 90-day window, and another platform: both left out
  { format: 'video-ngan', pillar: CS, er24: 20, ageDays: 120 },
  { format: 'video-ngan', pillar: CS, er24: 30, platform: 'youtube' },
];

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

const NOTES: NoteInput[] = SPECS.map((s, i) => {
  const published = NOW - (s.ageDays ?? (i % 30) + 1) * DAY;
  const soDo: Array<Record<string, unknown>> = [];
  if (s.er24 !== undefined) soDo.push({ moc: '24h', luc_do: iso(published + DAY), reach: 1000, ...(s.er24 === null ? {} : { er: s.er24 }) });
  if (s.er7 !== undefined) soDo.push({ moc: '7d', luc_do: iso(published + 7 * DAY), reach: 2000, er: s.er7 });
  const data: Record<string, unknown> = {
    loai: 'bai-dang', id: i + 1, nen_tang: s.platform ?? 'facebook', tieu_de: `Bài ${i + 1}`, dinh_dang: s.format, tru_cot: s.pillar,
    dang_luc: iso(published), so_do: soDo,
  };
  for (const k of ['mo_dau', 'kieu_hook', 'do_dai', 'so_chu'] as const) if (s[k] !== undefined) data[k] = s[k];
  return { relPath: `noi-dung/bai/bai-${String(i + 1).padStart(2, '0')}.md`, data };
});

const stats = contentLabStats(NOTES, { now: NOW });

function cell(format: string, pillar: string, s = stats) {
  const r = s.matrix.rows.findIndex((x) => x.key === format);
  const c = s.matrix.cols.findIndex((x) => x.key === pillar);
  return s.matrix.cells[r]![c]!;
}
const group = (list: typeof stats.byHook, key: string) => list.find((g) => g.key === key)!;

describe('content lab stats (24 notes)', () => {
  it('has 24 notes, 22 in the window and on Facebook, 19 measured at 24h', () => {
    expect(NOTES).toHaveLength(24);
    expect(stats).toMatchObject({ moc: '24h', days: 90, platform: 'facebook', totals: { posts: 22, measured: 19 } });
    expect(stats.posts).toHaveLength(22);
  });

  it('median ER by format × pillar, with counts, low-sample and not-tried cells', () => {
    expect(stats.matrix.rows.map((r) => r.key)).toEqual(['video-ngan', 'anh', 'chu']);
    expect(stats.matrix.cols.map((c) => c.key)).toEqual([CP, SP, CS, QT]); // most posts first (8, 8, 3, 3), then by name
    expect(cell('video-ngan', CP)).toEqual({ n: 5, posts: 6, medianEr: 6.5, lowSample: false, notTried: false, unmeasured: false });
    expect(cell('video-ngan', SP)).toMatchObject({ n: 3, medianEr: 4, lowSample: false });
    expect(cell('video-ngan', QT)).toMatchObject({ n: 1, medianEr: 9, lowSample: true });
    expect(cell('video-ngan', CS)).toEqual({ n: 0, posts: 0, medianEr: null, lowSample: false, notTried: true, unmeasured: false });
    expect(cell('anh', CP)).toMatchObject({ n: 2, medianEr: 2.5, lowSample: true });
    expect(cell('anh', SP)).toMatchObject({ n: 4, medianEr: 2.5, lowSample: false });
    expect(cell('anh', CS)).toMatchObject({ n: 3, medianEr: 1.8, lowSample: false });
    expect(cell('anh', QT)).toMatchObject({ notTried: true });
    expect(cell('chu', QT)).toMatchObject({ n: 1, posts: 2, medianEr: 4, lowSample: true });
    expect(cell('chu', SP)).toEqual({ n: 0, posts: 1, medianEr: null, lowSample: false, notTried: false, unmeasured: true });
    expect(cell('chu', CP)).toMatchObject({ notTried: true });
  });

  it('median ER by hook: the owner’s mo_dau, else marketing’s hook type; untried hooks listed', () => {
    expect(group(stats.byHook, 'cau-hoi')).toMatchObject({ label: 'Câu hỏi', n: 5, medianEr: 6.5, lowSample: false });
    expect(group(stats.byHook, 'gay-tranh-cai')).toMatchObject({ label: 'gây tranh cãi', n: 3, medianEr: 4 });
    expect(group(stats.byHook, 'con-so')).toMatchObject({ n: 4, medianEr: 2.5 });
    expect(group(stats.byHook, 'cau-chuyen')).toMatchObject({ n: 3, medianEr: 1.8 });
    expect(group(stats.byHook, 'ten-san-pham')).toMatchObject({ notTried: true, n: 0, medianEr: null });
    expect(group(stats.byHook, 'chi-loi-sai')).toMatchObject({ notTried: true });
    // no hook: 6-th video, Quà Tết video, 2 photos, 3 text posts → 7 posts, 4 measured: 9 2 3 4 → 3.5
    expect(group(stats.byHook, '')).toMatchObject({ label: 'Chưa gắn', posts: 7, n: 4, medianEr: 3.5 });
    expect(stats.byHook.at(-1)!.notTried).toBe(true);
  });

  it('median ER by length bucket: seconds for videos, words for the rest', () => {
    expect(stats.byLength.map((g) => [g.key, g.n, g.medianEr, g.lowSample])).toEqual([
      ['video-30', 2, 6.75, true],
      ['video-60', 3, 6, false],
      ['chu-50', 2, 1.5, true],
      ['chu-150', 2, 6.5, true],
    ]);
  });

  it('compares within one milestone only', () => {
    const at7 = contentLabStats(NOTES, { now: NOW, moc: '7d' });
    expect(at7.totals.measured).toBe(3);
    expect(cell('video-ngan', CP, at7)).toMatchObject({ n: 2, posts: 6, medianEr: 27.75, lowSample: true }); // video × Cách pha at 7d: 5.5 and 50
    // an unknown milestone falls back to 24h
    expect(contentLabStats(NOTES, { now: NOW, moc: 'latest' }).moc).toBe('24h');
    // a shorter window drops older posts
    expect(contentLabStats(NOTES, { now: NOW, days: 7 }).totals.posts).toBe(7);
  });

  it('a post against the others at the same milestone, never including itself', () => {
    const c = comparePost(NOTES, 'noi-dung/bai/bai-10.md', { now: NOW })!; // video Quà Tết, 9% at 24h
    // the 18 other measured posts at 24h: 6.5 7 5 8 6 3 4 5 2 3 1 2 3 10 1.2 1.8 2.4 4 → median 3.5
    expect(c).toMatchObject({ moc: '24h', er: 9, others: { n: 18, medianEr: 3.5, lowSample: false }, diffPct: 157 });
    expect(c.sameFormat).toMatchObject({ n: 8, medianEr: 5.5, label: 'Video ngắn' });
    expect(comparePost(NOTES, 'noi-dung/bai/bai-06.md', { now: NOW })).toMatchObject({ moc: '7d', er: 50 });
    expect(comparePost(NOTES, 'noi-dung/bai/khong-co.md', { now: NOW })).toBeNull();
  });

  it('median of an even and an odd list', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
