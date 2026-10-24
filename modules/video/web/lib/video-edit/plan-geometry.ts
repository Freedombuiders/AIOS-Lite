// Pure helpers that mirror the backend's computeKeep for DRAWING ONLY (timeline lanes, transcript
// highlights, optimistic word toggles). The server's plan stays the source of truth: whenever the
// owner has no pending local toggles we draw plan.keep as-is.
import type { BrollItem, EditPlan, RemovedKind, TranscriptWord, VideoMark } from './types';

export interface Seg { start: number; end: number; out: number }

export interface PlanModel {
  segs: Seg[];
  /** Output duration in seconds. */
  total: number;
  /** Source seconds -> output seconds (null when that moment is cut). */
  toOut: (t: number) => number | null;
  /** Output seconds -> source seconds. */
  toSrc: (t: number) => number | null;
}

export interface CaptionChunk { s: number; e: number; text: string; words: number[] }
export interface BlockItem { id: string; s: number; e: number; label: string; muted?: boolean }

export function keepFromWords(words: TranscriptWord[], cut: ReadonlySet<number>, gapMs: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const w of words) {
    if (cut.has(w.i)) continue;
    const last = out[out.length - 1];
    if (last && (w.start - last.end) * 1000 <= gapMs) last.end = Math.max(last.end, w.end);
    else out.push({ start: w.start, end: w.end });
  }
  return out;
}

/** "moved" hook: the moveFrom..moveTo words play first, the rest follows without that stretch. */
export function applyMovedHook(
  ranges: { start: number; end: number }[], words: TranscriptWord[], plan: EditPlan,
): { start: number; end: number }[] {
  const h = plan.hook?.options.find((o) => o.id === plan.hook?.chosen);
  if (!h || h.mode !== 'moved' || h.moveFromWord === undefined || h.moveToWord === undefined) return ranges;
  const a = words[h.moveFromWord]?.start;
  const b = words[h.moveToWord]?.end;
  if (a === undefined || b === undefined || b <= a) return ranges;
  const out = [{ start: a, end: b }];
  for (const r of ranges) {
    if (r.end <= a || r.start >= b) out.push(r);
    else {
      if (r.start < a) out.push({ start: r.start, end: a });
      if (r.end > b) out.push({ start: b, end: r.end });
    }
  }
  return out;
}

export function buildModel(plan: EditPlan, words: TranscriptWord[], overrides: Record<number, boolean>): PlanModel {
  const dirty = Object.keys(overrides).length > 0;
  let ranges = plan.keep;
  if (dirty || ranges.length === 0) {
    const cut = new Set(plan.cutWords);
    for (const [k, v] of Object.entries(overrides)) { if (v) cut.add(Number(k)); else cut.delete(Number(k)); }
    ranges = keepFromWords(words, cut, plan.gapMs);
  }
  ranges = applyMovedHook(ranges, words, plan);
  let acc = 0;
  const segs: Seg[] = ranges.map((r) => { const s = { start: r.start, end: r.end, out: acc }; acc += Math.max(0, r.end - r.start); return s; });
  return {
    segs,
    total: acc,
    toOut: (t) => { for (const s of segs) if (t >= s.start - 0.001 && t <= s.end + 0.001) return s.out + (t - s.start); return null; },
    toSrc: (t) => { for (const s of segs) if (t >= s.out - 0.001 && t <= s.out + (s.end - s.start) + 0.001) return s.start + (t - s.out); return null; },
  };
}

export function captionChunks(plan: EditPlan, words: TranscriptWord[], model: PlanModel, cut: ReadonlySet<number>): CaptionChunk[] {
  const per = Math.max(1, plan.captions.maxWordsPerChunk || 3);
  const chunks: CaptionChunk[] = [];
  for (const seg of model.segs) {
    const inSeg = words.filter((w) => !cut.has(w.i) && w.start >= seg.start - 0.05 && w.start < seg.end);
    for (let i = 0; i < inSeg.length; i += per) {
      const group = inSeg.slice(i, i + per);
      const s = seg.out + Math.max(0, group[0].start - seg.start);
      const e = seg.out + Math.min(seg.end - seg.start, group[group.length - 1].end - seg.start);
      chunks.push({ s, e: Math.max(e, s + 0.25), text: group.map((w) => w.text).join(' '), words: group.map((w) => w.i) });
    }
  }
  return chunks;
}

export function hookBlock(plan: EditPlan, model: PlanModel): BlockItem | null {
  const h = plan.hook?.options.find((o) => o.id === plan.hook?.chosen);
  if (!h) return null;
  const end = h.mode === 'moved' && model.segs[0] ? model.segs[0].end - model.segs[0].start : 2;
  return { id: h.id, s: 0, e: Math.min(Math.max(end, 0.5), Math.max(model.total, 0.5)), label: `HOOK · ${h.text}` };
}

export function brollBlocks(plan: EditPlan, words: TranscriptWord[], model: PlanModel): (BlockItem & { item: BrollItem })[] {
  const out: (BlockItem & { item: BrollItem })[] = [];
  for (const b of plan.brolls) {
    if (!b.enabled) continue;
    const w = words[b.anchorWord];
    const at = w ? model.toOut(w.start) : null;
    if (at === null) continue;
    out.push({ id: b.id, s: at, e: at + Math.max(0.3, b.duration), label: b.title, item: b });
  }
  return out;
}

export const EFFECT_LABEL: Record<string, string> = {
  'two-tier-title': 'Tiêu đề 2 tầng',
  'keyword-pop': 'Từ khoá nảy',
  'big-number': 'Con số lớn',
  'stacked-list': 'Danh sách cộng dồn',
  'compare-ab': 'So sánh A | B',
  'cta-button': 'Nút kêu gọi',
};

export function effectLabel(effect: string): string {
  return EFFECT_LABEL[effect] ?? effect;
}

export function overlayBlocks(plan: EditPlan): BlockItem[] {
  return plan.overlays.map((o) => ({ id: o.id, s: o.at, e: o.at + Math.max(0.3, o.duration), label: effectLabel(o.effect) }));
}

const WORD_CLEAN = /[.,!?…:;"'“”‘’()\[\]]/g;
export function cleanWord(t: string): string {
  return t.replace(WORD_CLEAN, '').trim().toLocaleLowerCase('vi-VN');
}

/** Which removed kind (filler / retake / offtopic) each cut word belongs to, for the italic/tint styling. */
export function removedKindByWord(plan: EditPlan, words: TranscriptWord[]): Map<number, RemovedKind> {
  const m = new Map<number, RemovedKind>();
  for (const r of plan.removed) {
    if (r.kind === 'silence') continue;
    for (const w of words) if (w.start >= r.start - 0.02 && w.end <= r.end + 0.02) m.set(w.i, r.kind);
  }
  return m;
}

export function highlightSet(plan: EditPlan): Set<string> {
  const s = new Set<string>();
  for (const h of plan.captions.highlight) for (const part of h.split(/\s+/)) { const c = cleanWord(part); if (c) s.add(c); }
  return s;
}

/** Index of the word playing at output time `t` (kept words only), or -1. */
export function wordAtOutput(words: TranscriptWord[], model: PlanModel, cut: ReadonlySet<number>, t: number): number {
  const src = model.toSrc(t);
  if (src === null) return -1;
  for (const w of words) if (!cut.has(w.i) && src >= w.start - 0.02 && src < w.end + 0.02) return w.i;
  return -1;
}

/** Word index (kept) at/just before output time `t`, to hang a mark pin in the transcript. */
export function wordNearOutput(words: TranscriptWord[], model: PlanModel, cut: ReadonlySet<number>, t: number): number {
  let best = -1;
  for (const w of words) {
    if (cut.has(w.i)) continue;
    const o = model.toOut(w.start);
    if (o === null) continue;
    if (o <= t + 0.05) best = w.i; 
  }
  return best;
}

export function markPins(marks: VideoMark[]): { mark: VideoMark; n: number }[] {
  return marks.map((m, i) => ({ mark: m, n: i + 1 }));
}

/** Words that overlap a source range [start, end] (used by "Giữ lại" on removed segments). */
export function wordsInRange(words: TranscriptWord[], start: number, end: number): TranscriptWord[] {
  return words.filter((w) => w.start >= start - 0.02 && w.end <= end + 0.02);
}
