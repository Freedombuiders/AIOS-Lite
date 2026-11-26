// Pure numbers of the formula loop. Every value a note shows (ratio, so_voi_ky_vong, da_lam, ket_qua, trang_thai) is
// computed here, never by an agent. No I/O.
//
//   ratio          = ER of the post ÷ median ER of the channel's OTHER posts, same platform, same milestone
//   so_voi_ky_vong = ratio ÷ expected_ratio (the expectation fixed when the idea was suggested, carried by the post)
//   ket_qua        = median so_voi_ky_vong of the formula's posts (each post at its latest compared milestone)
//   trang_thai     = under 3 posts: co-ve-hop when ket_qua ≥ 1, else chua-hop;
//                    from 3 posts: hop when ≥ 1.2, chua-hop when < 0.9, co-ve-hop in between.
// Fewer than 5 posts is only "thăm dò" (exploratory): the UI never says a formula "works".

/** Milestones a post is compared at, oldest first. */
export const COMPARE_MILESTONES = ['24h', '7d'] as const;
export type CompareMilestone = (typeof COMPARE_MILESTONES)[number];
export const isCompareMilestone = (m: string): m is CompareMilestone => (COMPARE_MILESTONES as readonly string[]).includes(m);

/** Expectation of a new formula: one and a half times the channel median. */
export const DEFAULT_EXPECTATION = 1.5;
/** Own posts needed before the formula's own median ratio replaces ky_vong as the expectation. */
export const OWN_POSTS_FOR_EXPECTATION = 3;
/** Posts needed before hop / chua-hop can be decided. */
export const POSTS_FOR_VERDICT = 3;
export const HOP_AT = 1.2;
export const CHUA_HOP_BELOW = 0.9;
/** Below this many posts a verdict is labelled "thăm dò". */
export const EXPLORATORY_BELOW = 5;
/** Window of the channel's posts used as the baseline. */
export const BASELINE_DAYS = 90;

export type FormulaState = 'chua-thu' | 'co-ve-hop' | 'hop' | 'chua-hop';

export const STATE_LABELS: Record<FormulaState, string> = {
  'chua-thu': 'Chưa thử',
  'co-ve-hop': 'Có vẻ hợp, cần thêm bài',
  hop: 'Hợp với kênh mình',
  'chua-hop': 'Chưa hợp',
};

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** ER of a bai-dang note at a milestone, from its so_do list (null = not measured or unknown, never 0). */
export function erAt(data: Record<string, unknown>, moc: string): number | null {
  const list = data.so_do;
  if (!Array.isArray(list)) return null;
  const e = list.find((x) => x && typeof x === 'object' && (x as { moc?: unknown }).moc === moc) as Record<string, unknown> | undefined;
  return num(e?.er);
}

export function publishedSec(data: Record<string, unknown>): number | null {
  const t = Date.parse(str(data.dang_luc));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export interface PostNote {
  relPath: string;
  data: Record<string, unknown>;
}

export interface Comparison {
  moc: CompareMilestone;
  er: number;
  /** median ER of the other posts at the same milestone; null when there is none */
  baselineEr: number | null;
  /** how many other posts the median is over */
  baselineN: number;
  /** er ÷ baselineEr; null when the median is unknown or 0 */
  ratio: number | null;
  expectedRatio: number;
  /** ratio ÷ expectedRatio; null when ratio is null */
  vsExpected: number | null;
}

/**
 * One post against the channel at one milestone. The baseline is every OTHER post of the same platform published in
 * the BASELINE_DAYS before the post (and up to its own publish time), measured at the same milestone. The post itself
 * is never part of its baseline. null when the post has no ER at that milestone.
 */
export function comparePost(self: PostNote, all: readonly PostNote[], moc: CompareMilestone, expectedRatio: number): Comparison | null {
  const er = erAt(self.data, moc);
  if (er === null) return null;
  const platform = str(self.data.nen_tang);
  const at = publishedSec(self.data);
  const from = at === null ? null : at - BASELINE_DAYS * 86400;
  const values: number[] = [];
  for (const p of all) {
    if (p.relPath === self.relPath) continue;
    if (Number(p.data.id) === Number(self.data.id) && p.data.id !== undefined) continue;
    if (str(p.data.nen_tang) !== platform) continue;
    if (from !== null) {
      const t = publishedSec(p.data);
      if (t === null || t < from || t > at!) continue;
    }
    const v = erAt(p.data, moc);
    if (v !== null) values.push(v);
  }
  const m = median(values);
  const baselineEr = m === null ? null : round2(m);
  const raw = m !== null && m > 0 ? er / m : null;
  const ratio = raw === null ? null : round2(raw);
  const vsExpected = raw !== null && expectedRatio > 0 ? round2(raw / expectedRatio) : null;
  return { moc, er, baselineEr, baselineN: values.length, ratio, expectedRatio, vsExpected };
}

/** A post's comparison as kept in its note (`doi_chieu` entries). */
export interface StoredComparison {
  moc: string;
  ti_le: number | null;
  so_voi_ky_vong: number | null;
}

export function storedComparisons(data: Record<string, unknown>): StoredComparison[] {
  const list = data.doi_chieu;
  if (!Array.isArray(list)) return [];
  return list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as { moc?: unknown }).moc === 'string')
    .map((x) => ({ moc: String(x.moc), ti_le: num(x.ti_le), so_voi_ky_vong: num(x.so_voi_ky_vong) }));
}

/** The comparison a post counts with for its formula: the latest compared milestone that has a number. */
export function latestComparison(data: Record<string, unknown>): StoredComparison | null {
  const list = storedComparisons(data);
  for (const moc of [...COMPARE_MILESTONES].reverse()) {
    const c = list.find((x) => x.moc === moc && x.so_voi_ky_vong !== null);
    if (c) return c;
  }
  return null;
}

export function stateOf(made: number, result: number | null): FormulaState {
  if (made === 0 || result === null) return 'chua-thu';
  if (made < POSTS_FOR_VERDICT) return result >= 1 ? 'co-ve-hop' : 'chua-hop';
  if (result >= HOP_AT) return 'hop';
  if (result < CHUA_HOP_BELOW) return 'chua-hop';
  return 'co-ve-hop';
}

export interface FormulaResult {
  /** posts made with the formula that have a comparison */
  da_lam: number;
  /** median so_voi_ky_vong, 2 decimals; null with no post */
  ket_qua: number | null;
  /** median ratio to the channel, 2 decimals; null with no post */
  ti_le_trung_vi: number | null;
  trang_thai: FormulaState;
  /** under EXPLORATORY_BELOW posts */
  tham_do: boolean;
  /** the posts counted, by path */
  posts: string[];
}

/** Recompute a formula from the post notes that name it (`cong_thuc: [[slug]]`). */
export function formulaResult(posts: readonly PostNote[]): FormulaResult {
  const counted: Array<{ path: string; c: StoredComparison }> = [];
  for (const p of posts) {
    const c = latestComparison(p.data);
    if (c) counted.push({ path: p.relPath, c });
  }
  const vs = counted.map((x) => x.c.so_voi_ky_vong!).filter((v) => v !== null);
  const ratios = counted.map((x) => x.c.ti_le).filter((v): v is number => v !== null);
  const k = median(vs);
  const r = median(ratios);
  const ket_qua = k === null ? null : round2(k);
  return {
    da_lam: counted.length,
    ket_qua,
    ti_le_trung_vi: r === null ? null : round2(r),
    trang_thai: stateOf(counted.length, ket_qua),
    tham_do: counted.length < EXPLORATORY_BELOW,
    posts: counted.map((x) => x.path),
  };
}

/**
 * The expectation fixed on a new idea: the formula's own median ratio to the channel once it has
 * OWN_POSTS_FOR_EXPECTATION posts, else its ky_vong (default 1.5).
 */
export function expectedRatioFor(posts: readonly PostNote[], kyVong: unknown): number {
  const ratios = posts.map((p) => latestComparison(p.data)?.ti_le ?? null).filter((v): v is number => v !== null && v > 0);
  if (ratios.length >= OWN_POSTS_FOR_EXPECTATION) return round2(median(ratios)!);
  const k = num(kyVong);
  return k !== null && k > 0 ? k : DEFAULT_EXPECTATION;
}

/** `[[slug]]` / `[[slug|label]]` → slug; anything else → ''. */
export function linkSlug(v: unknown): string {
  const m = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(str(v));
  if (!m) return '';
  const target = m[1]!.trim();
  return target.split('/').pop()!.replace(/\.md$/i, '');
}
