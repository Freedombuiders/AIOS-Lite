// Pure statistics over `bai-dang` notes. Every number is computed here from the notes' `so_do` entries (whose ER
// marketing computed); nothing is estimated. A comparison only uses one milestone and one platform at a time:
// a new post at 24h is never compared with an old post at 7d.
import { DINH_DANG_LABELS, MILESTONE_LABELS, MILESTONES, MO_DAU_LABELS, VIDEO_FORMATS, slugify } from './note-format.js';

/** Fewer measured posts than this in a cell: shown, but flagged "ít mẫu". */
export const LOW_SAMPLE = 3;
export const DEFAULT_MOC = '24h';
export const DEFAULT_DAYS = 90;
const DAY = 86400;

export interface NoteInput {
  relPath: string;
  data: Record<string, unknown>;
}

export interface Cell {
  /** posts with an ER at the milestone (the sample the median is taken over) */
  n: number;
  /** posts of this kind in the window, measured or not */
  posts: number;
  medianEr: number | null;
  /** 1 or 2 measured posts */
  lowSample: boolean;
  /** no post of this kind at all */
  notTried: boolean;
  /** posts exist but none has an ER at this milestone yet */
  unmeasured: boolean;
}

export interface Group extends Cell {
  key: string;
  label: string;
}

export interface Axis {
  key: string;
  label: string;
}

export interface PostRow {
  path: string;
  title: string;
  format: string;
  formatLabel: string;
  pillar: string;
  hook: string;
  hookLabel: string;
  /** "38 giây" or "120 chữ"; null when unknown */
  length: string | null;
  publishedAt: string | null;
  reach: number | null;
  er: number | null;
  /** milestones measured so far */
  measured: string[];
}

export interface ContentLabStats {
  moc: string;
  days: number;
  platform: string;
  totals: { posts: number; measured: number };
  matrix: { rows: Axis[]; cols: Axis[]; cells: Cell[][] };
  byHook: Group[];
  byLength: Group[];
  posts: PostRow[];
}

export interface StatsOptions {
  days?: number;
  moc?: string;
  platform?: string;
  /** unix seconds */
  now: number;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The so_do entry of `moc`, if any. */
export function entryAt(data: Record<string, unknown>, moc: string): Record<string, unknown> | undefined {
  const list = data.so_do;
  if (!Array.isArray(list)) return undefined;
  return list.find((e) => e && typeof e === 'object' && (e as { moc?: unknown }).moc === moc) as Record<string, unknown> | undefined;
}

/** ER at the milestone, or null when not measured or unknown (never 0 for unknown). */
export function erAt(data: Record<string, unknown>, moc: string): number | null {
  return num(entryAt(data, moc)?.er);
}

export function measured(data: Record<string, unknown>): string[] {
  return MILESTONES.filter((m) => entryAt(data, m) !== undefined);
}

function publishedSec(data: Record<string, unknown>): number | null {
  const t = Date.parse(str(data.dang_luc));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export function formatOf(data: Record<string, unknown>): Axis {
  const k = str(data.dinh_dang);
  return { key: k, label: k ? (DINH_DANG_LABELS[k] ?? k) : 'Chưa rõ' };
}

export function pillarOf(data: Record<string, unknown>): Axis {
  const k = str(data.tru_cot);
  return { key: k, label: k || 'Chưa gắn' };
}

/** `mo_dau` when set (the owner may have corrected it), else marketing's own hook type. */
export function hookOf(data: Record<string, unknown>): Axis {
  const mo = str(data.mo_dau);
  if (mo) return { key: mo, label: MO_DAU_LABELS[mo] ?? mo };
  const raw = str(data.kieu_hook);
  if (raw) {
    const slug = slugify(raw);
    return { key: slug, label: MO_DAU_LABELS[slug] ?? raw };
  }
  return { key: '', label: 'Chưa gắn' };
}

const VIDEO_BUCKETS: Array<{ key: string; label: string; max: number }> = [
  { key: 'video-30', label: 'Video dưới 30 giây', max: 30 },
  { key: 'video-60', label: 'Video 30–60 giây', max: 60 },
  { key: 'video-180', label: 'Video 1–3 phút', max: 180 },
  { key: 'video-dai', label: 'Video trên 3 phút', max: Infinity },
];
const TEXT_BUCKETS: Array<{ key: string; label: string; max: number }> = [
  { key: 'chu-50', label: 'Dưới 50 chữ', max: 50 },
  { key: 'chu-150', label: '50–150 chữ', max: 150 },
  { key: 'chu-400', label: '150–400 chữ', max: 400 },
  { key: 'chu-dai', label: 'Trên 400 chữ', max: Infinity },
];
const BUCKET_ORDER = [...VIDEO_BUCKETS, ...TEXT_BUCKETS].map((b) => b.key);

/** Videos by length in seconds (do_dai), other posts by caption words (so_chu); null when unknown. */
export function lengthBucketOf(data: Record<string, unknown>): Axis | null {
  if (VIDEO_FORMATS.has(str(data.dinh_dang))) {
    const s = num(data.do_dai);
    if (s === null) return null;
    const b = VIDEO_BUCKETS.find((x) => s < x.max)!;
    return { key: b.key, label: b.label };
  }
  const w = num(data.so_chu);
  if (w === null) return null;
  const b = TEXT_BUCKETS.find((x) => w < x.max)!;
  return { key: b.key, label: b.label };
}

function lengthText(data: Record<string, unknown>): string | null {
  if (VIDEO_FORMATS.has(str(data.dinh_dang))) {
    const s = num(data.do_dai);
    return s === null ? null : `${s} giây`;
  }
  const w = num(data.so_chu);
  return w === null ? null : `${w} chữ`;
}

function cellOf(ers: Array<number | null>): Cell {
  const vals = ers.filter((v): v is number => v !== null);
  const m = median(vals);
  return {
    n: vals.length,
    posts: ers.length,
    medianEr: m === null ? null : round2(m),
    lowSample: vals.length > 0 && vals.length < LOW_SAMPLE,
    notTried: ers.length === 0,
    unmeasured: ers.length > 0 && vals.length === 0,
  };
}

/** bai-dang notes of the platform published in the last `days` days (by `dang_luc`). */
export function inWindow(notes: readonly NoteInput[], opts: StatsOptions): NoteInput[] {
  const days = opts.days ?? DEFAULT_DAYS;
  const platform = opts.platform ?? 'facebook';
  const from = opts.now - days * DAY;
  return notes.filter((n) => {
    if (n.data.loai !== 'bai-dang' || str(n.data.nen_tang) !== platform) return false;
    const t = publishedSec(n.data);
    return t !== null && t >= from && t <= opts.now + DAY;
  });
}

function groupBy(notes: readonly NoteInput[], axis: (d: Record<string, unknown>) => Axis | null, moc: string): Map<string, { axis: Axis; ers: Array<number | null> }> {
  const out = new Map<string, { axis: Axis; ers: Array<number | null> }>();
  for (const n of notes) {
    const a = axis(n.data);
    if (!a) continue;
    const g = out.get(a.key) ?? { axis: a, ers: [] };
    g.ers.push(erAt(n.data, moc));
    out.set(a.key, g);
  }
  return out;
}

export function isMilestone(moc: string): boolean {
  return (MILESTONES as readonly string[]).includes(moc);
}

/** Medians of ER by format × pillar, by hook and by length, at one milestone, with sample counts. */
export function contentLabStats(all: readonly NoteInput[], opts: StatsOptions): ContentLabStats {
  const moc = opts.moc && isMilestone(opts.moc) ? opts.moc : DEFAULT_MOC;
  const days = opts.days ?? DEFAULT_DAYS;
  const platform = opts.platform ?? 'facebook';
  const notes = inWindow(all, { ...opts, days, platform });

  // matrix: formats (schema order) × pillars (most posts first)
  const formatOrder = Object.keys(DINH_DANG_LABELS);
  const rows = [...groupBy(notes, formatOf, moc).values()].map((g) => g.axis)
    .sort((a, b) => (formatOrder.indexOf(a.key) === -1 ? 99 : formatOrder.indexOf(a.key)) - (formatOrder.indexOf(b.key) === -1 ? 99 : formatOrder.indexOf(b.key)));
  const pillarGroups = [...groupBy(notes, pillarOf, moc).values()];
  const cols = pillarGroups.sort((a, b) => b.ers.length - a.ers.length || a.axis.label.localeCompare(b.axis.label, 'vi')).map((g) => g.axis);
  const cells = rows.map((r) => cols.map((c) => cellOf(
    notes.filter((n) => formatOf(n.data).key === r.key && pillarOf(n.data).key === c.key).map((n) => erAt(n.data, moc)),
  )));

  // hooks: every schema value is listed (an untried one shows as "chưa thử"), plus marketing hook types present
  const hookGroups = groupBy(notes, hookOf, moc);
  for (const [key, label] of Object.entries(MO_DAU_LABELS)) if (!hookGroups.has(key)) hookGroups.set(key, { axis: { key, label }, ers: [] });
  const byHook = [...hookGroups.values()].map((g) => ({ ...g.axis, ...cellOf(g.ers) }))
    .sort((a, b) => Number(a.notTried) - Number(b.notTried) || (b.medianEr ?? -1) - (a.medianEr ?? -1) || b.posts - a.posts);

  const byLength = [...groupBy(notes, lengthBucketOf, moc).values()].map((g) => ({ ...g.axis, ...cellOf(g.ers) }))
    .sort((a, b) => BUCKET_ORDER.indexOf(a.key) - BUCKET_ORDER.indexOf(b.key));

  const posts: PostRow[] = notes.map((n) => {
    const f = formatOf(n.data);
    const h = hookOf(n.data);
    const e = entryAt(n.data, moc);
    return {
      path: n.relPath,
      title: str(n.data.tieu_de) || n.relPath.split('/').pop()!.replace(/\.md$/, ''),
      format: f.key,
      formatLabel: f.label,
      pillar: str(n.data.tru_cot),
      hook: h.key,
      hookLabel: h.key ? h.label : '',
      length: lengthText(n.data),
      publishedAt: str(n.data.dang_luc) || null,
      reach: num(e?.reach),
      er: num(e?.er),
      measured: measured(n.data),
    };
  }).sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));

  return {
    moc,
    days,
    platform,
    totals: { posts: notes.length, measured: notes.filter((n) => erAt(n.data, moc) !== null).length },
    matrix: { rows, cols, cells },
    byHook,
    byLength,
    posts,
  };
}

export interface PostComparison {
  moc: string;
  mocLabel: string;
  er: number | null;
  reach: number | null;
  /** the other posts of the platform in the window, measured at the same milestone */
  others: { n: number; medianEr: number | null; lowSample: boolean };
  /** the other posts of the same format */
  sameFormat: { n: number; medianEr: number | null; lowSample: boolean; label: string };
  /** (er ÷ others' median − 1) × 100, rounded; null when either is unknown or the median is 0 */
  diffPct: number | null;
}

/**
 * One post against the others at one milestone (default: the latest fixed milestone it has). The post itself is
 * never part of the median it is compared with.
 */
export function comparePost(all: readonly NoteInput[], path: string, opts: StatsOptions): PostComparison | null {
  const self = all.find((n) => n.relPath === path);
  if (!self) return null;
  const own = measured(self.data);
  const moc = opts.moc && isMilestone(opts.moc) ? opts.moc : (own.at(-1) ?? DEFAULT_MOC);
  const peers = inWindow(all, opts).filter((n) => n.relPath !== path);
  const sample = (list: NoteInput[]) => {
    const vals = list.map((n) => erAt(n.data, moc)).filter((v): v is number => v !== null);
    const m = median(vals);
    return { n: vals.length, medianEr: m === null ? null : round2(m), lowSample: vals.length > 0 && vals.length < LOW_SAMPLE };
  };
  const others = sample(peers);
  const fmt = formatOf(self.data);
  const sameFormat = { ...sample(peers.filter((n) => formatOf(n.data).key === fmt.key)), label: fmt.label };
  const er = erAt(self.data, moc);
  const diffPct = er !== null && others.medianEr !== null && others.medianEr > 0 ? Math.round((er / others.medianEr - 1) * 100) : null;
  return { moc, mocLabel: MILESTONE_LABELS[moc] ?? moc, er, reach: num(entryAt(self.data, moc)?.reach), others, sameFormat, diffPct };
}
