// EditPlan logic: derive the cut list from words, build the automatic first plan, apply the owner's
// manual edits as new versions, diff versions, and validate plans the agent submits.
//
// Source of truth for cuts is `cutWords` (+ `gapMs`). Everything else about the cut (`keep`,
// `removed`, durations, overlay times) is derived here and never trusted from outside.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  AnalysisResult, EditPlan, HookOption, RemovedKind, Transcript, VideoAspect, VideoProfile, VideoProject, VideoStyle,
} from '../types.js';
import { findFillers, findRetakes, isFillerWord, normWord } from './analyze.js';
import { fmtDur, r1, r3 } from './tools.js';

export const PACE_GAP_MS: Record<VideoStyle['cutPace'], number> = { calm: 400, normal: 250, fast: 150 };
const PAD_IN = 0.05;
const PAD_OUT = 0.08;
const MIN_REMOVED_SEC = 0.02;

export type Range = { start: number; end: number };

export interface Segment extends Range {
  /** Output time this segment starts at. */
  out: number;
}

export interface KeepResult {
  keep: Range[];
  removed: EditPlan['removed'];
  outputDurationSec: number;
  segments: Segment[];
}

export interface KeepOptions {
  /** Classify a removed word (retake/filler); default: lexicon check, else "offtopic". */
  kindOf?: (wordIndex: number) => RemovedKind;
}

// ── Cut list ──

function mergeTouching(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1e-6) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/**
 * Words → ranges to keep (source seconds). A run breaks at a removed word or a pause longer than
 * `gapMs`; each run gets a short pad, never reaching into a neighbouring word.
 */
export function computeKeep(
  transcript: Pick<Transcript, 'words' | 'durationSec'>,
  cutWords: number[],
  gapMs: number,
  hook?: HookOption,
  options: KeepOptions = {},
): KeepResult {
  const words = transcript.words;
  const total = Math.max(transcript.durationSec, words.length ? words[words.length - 1].end : 0);
  const cut = new Set(cutWords);
  const gap = Math.max(0, gapMs) / 1000;

  const runs: { first: number; last: number }[] = [];
  let prevKept = -1;
  let cutBetween = false;
  for (let i = 0; i < words.length; i++) {
    if (cut.has(i)) { cutBetween = true; continue; }
    const cur = runs[runs.length - 1];
    if (cur && !cutBetween && words[i].start - words[prevKept].end <= gap) cur.last = i;
    else runs.push({ first: i, last: i });
    prevKept = i;
    cutBetween = false;
  }

  const ranges: Range[] = runs.map(({ first, last }) => {
    const before = first > 0 ? words[first - 1] : null;
    const after = last < words.length - 1 ? words[last + 1] : null;
    const left = before ? (before.end + words[first].start) / 2 : 0;
    const right = after ? (words[last].end + after.start) / 2 : total;
    return {
      start: r3(Math.max(left, words[first].start - PAD_IN, 0)),
      end: r3(Math.min(right, words[last].end + PAD_OUT, total)),
    };
  });
  let keep = mergeTouching(ranges).filter((r) => r.end - r.start > 0.01);

  // "Moved" hook: play words moveFrom..moveTo first (honouring cuts inside), then the rest without them.
  if (hook?.mode === 'moved' && hook.moveFromWord !== undefined && hook.moveToWord !== undefined
    && hook.moveFromWord >= 0 && hook.moveToWord < words.length && hook.moveFromWord <= hook.moveToWord) {
    const a = words[hook.moveFromWord].start;
    const b = words[hook.moveToWord].end;
    const head: Range[] = [];
    const rest: Range[] = [];
    for (const r of keep) {
      const s = Math.max(r.start, a);
      const e = Math.min(r.end, b);
      if (e > s) head.push({ start: r3(s), end: r3(e) });
      if (r.start < a) rest.push({ start: r.start, end: r3(Math.min(r.end, a)) });
      if (r.end > b) rest.push({ start: r3(Math.max(r.start, b)), end: r.end });
    }
    if (head.length) keep = [...head, ...rest.filter((r) => r.end - r.start > 0.01)];
  }

  const timeSorted = mergeTouching(keep);
  const removed: EditPlan['removed'] = [];
  const kindOf = options.kindOf ?? ((i: number) => (isFillerWord(words[i].text) ? 'filler' : 'offtopic'));
  let cursor = 0;
  const pushGap = (s: number, e: number) => {
    if (e - s < MIN_REMOVED_SEC) return;
    const inside = words.filter((w) => cut.has(w.i) && (w.start + w.end) / 2 >= s && (w.start + w.end) / 2 <= e);
    if (inside.length === 0) { removed.push({ start: r3(s), end: r3(e), kind: 'silence' }); return; }
    const counts = new Map<RemovedKind, number>();
    for (const w of inside) counts.set(kindOf(w.i), (counts.get(kindOf(w.i)) ?? 0) + 1);
    const kind = [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
    removed.push({ start: r3(s), end: r3(e), kind, text: inside.map((w) => w.text).join(' ') });
  };
  for (const r of timeSorted) { pushGap(cursor, r.start); cursor = r.end; }
  pushGap(cursor, total);

  const segments: Segment[] = [];
  let acc = 0;
  for (const r of keep) { segments.push({ ...r, out: r3(acc) }); acc += r.end - r.start; }
  return { keep, removed, outputDurationSec: r3(acc), segments };
}

/** Source seconds → output seconds along the kept segments (null when that moment is cut). */
export function makeMapper(segments: Segment[]) {
  return (t: number): number | null => {
    for (const s of segments) if (t >= s.start - 1e-6 && t <= s.end + 1e-6) return r3(s.out + (t - s.start));
    return null;
  };
}

// ── Derived fields ──

export interface PlanContext {
  transcript: Transcript;
  analysis?: AnalysisResult | null;
}

function kindResolver(ctx: PlanContext): KeepOptions['kindOf'] {
  const retake = new Set<number>();
  for (const r of ctx.analysis?.retakes ?? []) for (let i = r.fromWord; i <= r.toWord; i++) retake.add(i);
  const words = ctx.transcript.words;
  return (i) => (retake.has(i) ? 'retake' : isFillerWord(words[i]?.text ?? '') ? 'filler' : 'offtopic');
}

function chosenHook(plan: Pick<EditPlan, 'hook'>): HookOption | undefined {
  return plan.hook?.options.find((o) => o.id === plan.hook?.chosen);
}

/** Recompute keep/removed/durations and re-time anchored overlays from the plan's source of truth. */
export function derivePlan(plan: EditPlan, ctx: PlanContext): EditPlan {
  const words = ctx.transcript.words;
  const cutWords = [...new Set(plan.cutWords.filter((i) => Number.isInteger(i) && i >= 0 && i < words.length))].sort((a, b) => a - b);
  const res = computeKeep(ctx.transcript, cutWords, plan.gapMs, chosenHook(plan), { kindOf: kindResolver(ctx) });
  const map = makeMapper(res.segments);
  const total = res.outputDurationSec;
  const overlays = plan.overlays.map((o) => {
    if (o.anchorWord === undefined || !words[o.anchorWord]) return o;
    const at = map(words[o.anchorWord].start);
    return at === null ? o : { ...o, at: r3(Math.min(at, Math.max(0, total - 0.1))) };
  });
  return {
    ...plan,
    cutWords,
    keep: res.keep,
    removed: res.removed,
    sourceDurationSec: r3(ctx.transcript.durationSec),
    outputDurationSec: total,
    overlays,
  };
}

// ── Automatic plan (v1) ──

function pickCovers(plan: Pick<EditPlan, 'keep'>, analysis: AnalysisResult | null | undefined, title: string, sourceDuration: number): EditPlan['covers'] {
  const inKeep = (t: number) => plan.keep.some((r) => t >= r.start && t <= r.end);
  const times = (analysis?.frames ?? []).map((f) => f.at).filter(inKeep);
  const fallback = [0.2, 0.5, 0.8].map((p) => r1(sourceDuration * p));
  const pool = times.length >= 3 ? times : [...times, ...fallback.filter((t) => !times.includes(t))];
  const pick = (p: number) => pool[Math.min(pool.length - 1, Math.floor(pool.length * p))];
  const chosen = [pick(0.15), pick(0.5), pick(0.8)];
  return chosen.map((frameAt) => ({ frameAt: r3(frameAt), title }));
}

function titleFromTranscript(transcript: Transcript): string {
  const text = transcript.words.slice(0, 9).map((w) => w.text).join(' ').replace(/[,.;:!?…]+$/u, '');
  return text || 'Video mới';
}

export function highlightTerms(transcript: Transcript, keepWords: string[], cutWords: number[] = []): string[] {
  const out = new Set<string>();
  for (const k of keepWords) for (const part of k.split(/\s+/)) { const n = normWord(part); if (n) out.add(n); }
  const cut = new Set(cutWords);
  for (const w of transcript.words) {
    if (out.size >= 14) break;
    if (!cut.has(w.i) && /\d/.test(w.text)) out.add(normWord(w.text));
  }
  return [...out];
}

export interface AutoPlanInput {
  transcript: Transcript;
  analysis?: AnalysisResult | null;
  project: Pick<VideoProject, 'title' | 'aspect' | 'targetSeconds' | 'styleId'>;
  profile: Pick<VideoProfile, 'keepWords'>;
  style?: VideoStyle | null;
  version?: number;
}

export function autoPlan(input: AutoPlanInput): EditPlan {
  const { transcript, analysis, project, profile, style } = input;
  const cutSet = new Set<number>();
  for (const f of analysis?.fillers ?? findFillers(transcript.words)) cutSet.add(f.wordIndex);
  for (const r of analysis?.retakes ?? findRetakes(transcript.words)) for (let i = r.fromWord; i <= r.toWord; i++) cutSet.add(i);
  const cutWords = [...cutSet].sort((a, b) => a - b);
  const gapMs = PACE_GAP_MS[style?.cutPace ?? 'normal'];
  const title = project.title && project.title !== 'Việc mới' ? project.title : titleFromTranscript(transcript);

  const base: EditPlan = {
    version: input.version ?? 1,
    createdAt: new Date().toISOString(),
    styleId: project.styleId ?? '',
    aspect: project.aspect,
    ...(project.targetSeconds ? { targetSeconds: project.targetSeconds } : {}),
    summary: '',
    sourceDurationSec: r3(transcript.durationSec),
    outputDurationSec: r3(transcript.durationSec),
    cutWords,
    gapMs,
    keep: [],
    removed: [],
    brolls: [],
    captions: {
      styleId: (style?.captionStyle ?? 'caption:bottom-clean').replace(/^caption:/, ''),
      position: 'bottom',
      highlight: highlightTerms(transcript, profile.keepWords, cutWords),
      maxWordsPerChunk: 3,
    },
    overlays: [],
    zooms: [],
    sfx: [],
    covers: [],
    meta: { title, caption: '', hashtags: [] },
    author: 'auto',
  };
  const plan = derivePlan(base, { transcript, analysis });
  plan.covers = pickCovers(plan, analysis, title, transcript.durationSec);

  const fillerCount = analysis?.fillers.length ?? 0;
  const retakeCount = analysis?.retakes.length ?? 0;
  const silenceSec = plan.removed.filter((r) => r.kind === 'silence').reduce((a, r) => a + (r.end - r.start), 0);
  plan.summary = `Bản tự động: bỏ ${fillerCount} từ đệm, ${retakeCount} câu nói lại và ${r1(silenceSec)}s chỗ lặng dài hơn ${gapMs}ms. `
    + `Video ${fmtDur(plan.sourceDurationSec)} → ${fmtDur(plan.outputDurationSec)}. Chờ agent thêm hook, chữ nhấn và hiệu ứng.`;
  plan.changes = [
    `Bỏ ${fillerCount} từ đệm và ${retakeCount} câu nói lại`,
    `Cắt chỗ lặng dài hơn ${gapMs}ms (${r1(silenceSec)}s)`,
    `${r1(plan.sourceDurationSec)}s → ${r1(plan.outputDurationSec)}s`,
  ];
  return plan;
}

// ── Manual edits ──

export interface PlanPatch {
  toggleWords?: number[];
  cutWords?: number[];
  gapMs?: number;
  hookChosen?: string;
  brolls?: { id: string; enabled: boolean }[];
  captions?: Partial<EditPlan['captions']>;
  meta?: Partial<EditPlan['meta']>;
}

function wordsText(words: Transcript['words'], idx: number[], max = 6): string {
  const shown = idx.slice(0, max).map((i) => words[i]?.text ?? '').filter(Boolean).join(' ');
  return idx.length > max ? `${shown} …` : shown;
}

/** Owner edits → a new draft version (author owner) with `changes` in Vietnamese. */
export function applyPatch(plan: EditPlan, patch: PlanPatch, ctx: PlanContext): EditPlan {
  const words = ctx.transcript.words;
  const valid = (i: number) => Number.isInteger(i) && i >= 0 && i < words.length;
  const next: EditPlan = {
    ...structuredClone(plan),
    version: plan.version + 1,
    createdAt: new Date().toISOString(),
    author: 'owner',
  };
  const changes: string[] = [];

  if (patch.cutWords) {
    const set = new Set(patch.cutWords.filter(valid));
    const now = new Set(plan.cutWords);
    const added = [...set].filter((i) => !now.has(i)).sort((a, b) => a - b);
    const dropped = [...now].filter((i) => !set.has(i)).sort((a, b) => a - b);
    next.cutWords = [...set].sort((a, b) => a - b);
    if (added.length) changes.push(`Bỏ ${added.length} từ: «${wordsText(words, added)}»`);
    if (dropped.length) changes.push(`Giữ lại ${dropped.length} từ: «${wordsText(words, dropped)}»`);
  }
  if (patch.toggleWords?.length) {
    const set = new Set(next.cutWords);
    const added: number[] = [];
    const dropped: number[] = [];
    for (const i of [...new Set(patch.toggleWords.filter(valid))].sort((a, b) => a - b)) {
      if (set.has(i)) { set.delete(i); dropped.push(i); } else { set.add(i); added.push(i); }
    }
    next.cutWords = [...set].sort((a, b) => a - b);
    if (added.length) changes.push(`Bỏ ${added.length} từ: «${wordsText(words, added)}»`);
    if (dropped.length) changes.push(`Giữ lại ${dropped.length} từ: «${wordsText(words, dropped)}»`);
  }
  if (patch.gapMs !== undefined && patch.gapMs !== plan.gapMs) {
    next.gapMs = patch.gapMs;
    changes.push(`Chỗ lặng giữ tối đa ${plan.gapMs}ms → ${patch.gapMs}ms`);
  }
  if (patch.hookChosen !== undefined && plan.hook) {
    const opt = plan.hook.options.find((o) => o.id === patch.hookChosen);
    if (opt && patch.hookChosen !== plan.hook.chosen) {
      next.hook = { ...plan.hook, chosen: opt.id };
      changes.push(`Đổi hook: «${opt.text}»${opt.mode === 'moved' ? ' (đưa đoạn hay lên đầu)' : ''}`);
    }
  }
  for (const b of patch.brolls ?? []) {
    const item = next.brolls.find((x) => x.id === b.id);
    if (item && item.enabled !== b.enabled) {
      item.enabled = b.enabled;
      changes.push(`${b.enabled ? 'Bật' : 'Tắt'} B-roll «${item.title}»`);
    }
  }
  if (patch.captions) {
    const c = patch.captions;
    const before = plan.captions;
    next.captions = { ...before, ...c };
    if (c.position && c.position !== before.position) changes.push(`Phụ đề: vị trí ${before.position} → ${c.position}`);
    if (c.maxWordsPerChunk && c.maxWordsPerChunk !== before.maxWordsPerChunk) changes.push(`Phụ đề: ${before.maxWordsPerChunk} → ${c.maxWordsPerChunk} từ mỗi lần`);
    if (c.styleId && c.styleId !== before.styleId) changes.push(`Phụ đề: kiểu ${c.styleId}`);
    if (c.highlight && c.highlight.join('|') !== before.highlight.join('|')) changes.push(`Phụ đề: từ tô màu ${c.highlight.length ? c.highlight.join(', ') : '(bỏ hết)'}`);
  }
  if (patch.meta) {
    next.meta = { ...plan.meta, ...patch.meta };
    if (patch.meta.title !== undefined && patch.meta.title !== plan.meta.title) changes.push(`Đổi tiêu đề: «${patch.meta.title}»`);
    if (patch.meta.caption !== undefined && patch.meta.caption !== plan.meta.caption) changes.push('Sửa caption đăng bài');
    if (patch.meta.hashtags && patch.meta.hashtags.join(' ') !== plan.meta.hashtags.join(' ')) changes.push('Sửa hashtag');
    if (patch.meta.hook !== undefined && patch.meta.hook !== plan.meta.hook) changes.push('Sửa câu hook đăng bài');
  }

  const derived = derivePlan(next, ctx);
  const delta = derived.outputDurationSec - plan.outputDurationSec;
  if (Math.abs(delta) >= 0.05) changes.push(`Thời lượng ${r1(plan.outputDurationSec)}s → ${r1(derived.outputDurationSec)}s`);
  derived.changes = changes.length ? changes : ['Không có thay đổi'];
  return derived;
}

// ── Diff ──

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function diffPlans(from: EditPlan, to: EditPlan, transcript?: Pick<Transcript, 'words'>): string[] {
  const out: string[] = [];
  const words = transcript?.words ?? [];
  const label = (idx: number[]) => (words.length ? `: «${wordsText(words as Transcript['words'], idx)}»` : '');
  const a = new Set(from.cutWords);
  const b = new Set(to.cutWords);
  const added = [...b].filter((i) => !a.has(i)).sort((x, y) => x - y);
  const dropped = [...a].filter((i) => !b.has(i)).sort((x, y) => x - y);
  if (added.length) out.push(`Bỏ thêm ${added.length} từ${label(added)}`);
  if (dropped.length) out.push(`Giữ lại ${dropped.length} từ${label(dropped)}`);
  if (from.gapMs !== to.gapMs) out.push(`Chỗ lặng giữ tối đa ${from.gapMs}ms → ${to.gapMs}ms`);

  const fh = from.hook?.options.find((o) => o.id === from.hook?.chosen);
  const th = to.hook?.options.find((o) => o.id === to.hook?.chosen);
  if (!sameJson(fh, th)) out.push(th ? `Hook: «${th.text}»${fh ? ` (trước: «${fh.text}»)` : ' (mới)'}` : 'Bỏ hook');

  const fb = new Map(from.brolls.map((x) => [x.id, x]));
  for (const x of to.brolls) {
    const old = fb.get(x.id);
    if (!old) out.push(`Thêm B-roll «${x.title}»`);
    else if (old.enabled !== x.enabled) out.push(`${x.enabled ? 'Bật' : 'Tắt'} B-roll «${x.title}»`);
  }
  for (const x of from.brolls) if (!to.brolls.some((y) => y.id === x.id)) out.push(`Bỏ B-roll «${x.title}»`);

  if (from.overlays.length !== to.overlays.length || !sameJson(from.overlays.map((o) => [o.effect, o.props]), to.overlays.map((o) => [o.effect, o.props]))) {
    out.push(`Hiệu ứng chữ: ${from.overlays.length} → ${to.overlays.length}`);
  }
  if (!sameJson(from.zooms, to.zooms)) out.push(`Zoom: ${from.zooms.length} → ${to.zooms.length}`);
  if (!sameJson(from.captions, to.captions)) out.push('Đổi cách hiện phụ đề');
  if (!sameJson(from.music, to.music)) out.push(to.music ? `Nhạc nền: ${to.music.mood || to.music.assetId}` : 'Bỏ nhạc nền');
  if (from.sfx.length !== to.sfx.length) out.push(`Tiếng động: ${from.sfx.length} → ${to.sfx.length}`);
  if (!sameJson(from.covers, to.covers)) out.push('Đổi ảnh bìa');
  if (from.meta.title !== to.meta.title) out.push(`Tiêu đề: «${to.meta.title}»`);
  if (from.meta.caption !== to.meta.caption || !sameJson(from.meta.hashtags, to.meta.hashtags)) out.push('Đổi caption / hashtag');
  if (Math.abs(from.outputDurationSec - to.outputDurationSec) >= 0.05) {
    out.push(`Thời lượng ${r1(from.outputDurationSec)}s → ${r1(to.outputDurationSec)}s`);
  }
  return out.length ? out : ['Không có thay đổi'];
}

// ── Validation of agent plans ──

const aspectEnum = z.enum(['9:16', '16:9', '1:1', '4:5']);
const id = () => z.string().trim().min(1).max(60).default(() => randomUUID().slice(0, 8));
const propValue = z.union([z.string().max(500), z.number(), z.array(z.string().max(300)).max(20)]);
const nonNeg = z.number().finite().min(0);

const hookOptionSchema = z.object({
  id: id(),
  kind: z.enum(['question', 'warning', 'number', 'story', 'other']).default('other'),
  text: z.string().trim().min(1).max(200),
  subtext: z.string().trim().max(200).optional(),
  mode: z.enum(['overlay', 'moved']).default('overlay'),
  moveFromWord: z.number().int().min(0).optional(),
  moveToWord: z.number().int().min(0).optional(),
});

export const planInputSchema = z.object({
  styleId: z.string().max(40).default(''),
  aspect: aspectEnum.optional(),
  targetSeconds: z.number().positive().optional(),
  summary: z.string().max(4000).default(''),
  cutWords: z.array(z.number().int().min(0)).max(20000).default([]),
  gapMs: z.number().int().min(0).max(5000).default(250),
  hook: z.object({ options: z.array(hookOptionSchema).min(1).max(8), chosen: z.string().min(1) }).optional(),
  brolls: z.array(z.object({
    id: id(),
    anchorWord: z.number().int().min(0),
    duration: z.number().positive().max(30),
    title: z.string().trim().min(1).max(160),
    reason: z.string().max(300).default(''),
    source: z.enum(['product', 'library', 'ai', 'upload', 'pexels']).default('library'),
    assetId: z.string().max(200).optional(),
    prompt: z.string().max(1000).optional(),
    layout: z.enum(['full', 'card', 'cutout']).default('card'),
    box: z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100), w: z.number().positive().max(100), h: z.number().positive().max(100) }).optional(),
    enabled: z.boolean().default(true),
  })).max(40).default([]),
  captions: z.object({
    styleId: z.string().max(60).default('bottom-clean'),
    position: z.enum(['bottom', 'middle', 'behind']).default('bottom'),
    highlight: z.array(z.string().max(80)).max(60).default([]),
    maxWordsPerChunk: z.number().int().min(1).max(8).default(3),
  }).default({ styleId: 'bottom-clean', position: 'bottom', highlight: [], maxWordsPerChunk: 3 }),
  overlays: z.array(z.object({
    id: id(),
    effect: z.string().trim().min(1).max(60),
    anchorWord: z.number().int().min(0).optional(),
    at: nonNeg.default(0),
    duration: z.number().positive().max(30),
    props: z.record(z.string(), propValue).default({}),
  })).max(80).default([]),
  zooms: z.array(z.object({ at: nonNeg, duration: z.number().positive().max(10), scale: z.number().min(1).max(2) })).max(60).default([]),
  music: z.object({ assetId: z.string().min(1).max(200), mood: z.string().max(60).default(''), gainDb: z.number().min(-60).max(12), duck: z.boolean().default(true) }).optional(),
  sfx: z.array(z.object({ at: nonNeg, assetId: z.string().min(1).max(200), gainDb: z.number().min(-60).max(12).optional() })).max(120).default([]),
  covers: z.array(z.object({ frameAt: nonNeg, title: z.string().trim().max(120), subtitle: z.string().trim().max(160).optional() })).max(6).default([]),
  meta: z.object({
    title: z.string().trim().max(200).default(''),
    caption: z.string().max(4000).default(''),
    hashtags: z.array(z.string().max(80)).max(40).default([]),
    hook: z.string().max(300).optional(),
  }).default({ title: '', caption: '', hashtags: [] }),
});

export interface ValidatedPlan {
  plan?: EditPlan;
  errors: string[];
}

function zodIssues(err: z.ZodError): string[] {
  return err.issues.slice(0, 12).map((i) => `${i.path.join('.') || 'plan'}: ${i.message}`);
}

/**
 * Check a plan an agent wrote and turn it into the next version: derived fields recomputed,
 * overlay times re-anchored, author "agent", `changes` from the diff when the agent gave none.
 */
export function validateAgentPlan(
  input: unknown,
  ctx: PlanContext,
  base: { previous?: EditPlan | null; version: number; aspect: VideoAspect; styleId?: string; note?: string },
): ValidatedPlan {
  const parsed = planInputSchema.safeParse(input);
  if (!parsed.success) return { errors: zodIssues(parsed.error) };
  const p = parsed.data;
  const words = ctx.transcript.words;
  const n = words.length;
  const errors: string[] = [];

  const badCut = p.cutWords.filter((i) => i >= n);
  if (badCut.length) errors.push(`cutWords: chỉ số từ vượt quá ${n - 1} (${badCut.slice(0, 5).join(', ')})`);
  if (p.hook) {
    if (!p.hook.options.some((o) => o.id === p.hook!.chosen)) errors.push(`hook.chosen "${p.hook.chosen}" không có trong hook.options`);
    for (const o of p.hook.options) {
      if (o.mode === 'moved') {
        if (o.moveFromWord === undefined || o.moveToWord === undefined) errors.push(`hook "${o.id}": mode moved cần moveFromWord và moveToWord`);
        else if (o.moveFromWord > o.moveToWord || o.moveToWord >= n) errors.push(`hook "${o.id}": khoảng từ moveFromWord..moveToWord không hợp lệ`);
      }
    }
    const ids = p.hook.options.map((o) => o.id);
    if (new Set(ids).size !== ids.length) errors.push('hook.options có id trùng');
  }
  for (const b of p.brolls) if (b.anchorWord >= n) errors.push(`brolls "${b.id}": anchorWord vượt quá ${n - 1}`);
  for (const o of p.overlays) if (o.anchorWord !== undefined && o.anchorWord >= n) errors.push(`overlays "${o.id}": anchorWord vượt quá ${n - 1}`);
  const dupe = (list: { id: string }[], what: string) => {
    if (new Set(list.map((x) => x.id)).size !== list.length) errors.push(`${what} có id trùng`);
  };
  dupe(p.brolls, 'brolls');
  dupe(p.overlays, 'overlays');
  const sourceDur = ctx.transcript.durationSec;
  for (const c of p.covers) if (c.frameAt > sourceDur + 0.5) errors.push(`covers: frameAt ${c.frameAt}s vượt thời lượng gốc ${r1(sourceDur)}s`);
  if (errors.length) return { errors };

  const prev = base.previous ?? null;
  const draft: EditPlan = {
    version: base.version,
    createdAt: new Date().toISOString(),
    styleId: p.styleId || base.styleId || prev?.styleId || '',
    aspect: p.aspect ?? base.aspect,
    ...(p.targetSeconds ? { targetSeconds: p.targetSeconds } : {}),
    summary: p.summary,
    sourceDurationSec: 0,
    outputDurationSec: 0,
    cutWords: p.cutWords,
    gapMs: p.gapMs,
    keep: [],
    removed: [],
    ...(p.hook ? { hook: p.hook } : {}),
    brolls: p.brolls,
    captions: p.captions,
    overlays: p.overlays,
    zooms: p.zooms,
    ...(p.music ? { music: p.music } : {}),
    sfx: p.sfx,
    covers: p.covers.length ? p.covers : (prev?.covers ?? []),
    meta: { ...p.meta, title: p.meta.title || prev?.meta.title || '' },
    author: 'agent',
  };
  const plan = derivePlan(draft, ctx);
  const note = base.note?.trim();
  const diff = prev ? diffPlans(prev, plan, ctx.transcript) : [];
  plan.changes = note ? [note, ...diff.filter((d) => d !== 'Không có thay đổi')] : diff.length ? diff : ['Kế hoạch đầu tiên của agent'];
  return { plan, errors: [] };
}
