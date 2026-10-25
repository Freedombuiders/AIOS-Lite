/**
 * Local validation of an agent-authored EditPlan (contract: src/video-edit/types.ts).
 *
 * Used by `video-cli plan validate|submit`. Two layers:
 *   1. Shape (zod): every decision field the agent owns. Derived fields (keep, removed,
 *      outputDurationSec, version, createdAt, author) are optional here: the server recomputes
 *      them from cutWords + gapMs.
 *   2. Cross-checks against the transcript: word indexes in range, anchors not on cut words,
 *      hook ranges valid, estimated output length vs the target.
 *
 * Plan v2 (Dựng nhanh) fields are known too: templateId, autoCut, beats/scenes/graphics (the element
 * schemas and checks of ../pipeline/plan.ts, so both validators agree), B-roll hint/query, zoom ids.
 */

import { z } from 'zod';

import {
  checkElement, ELEMENT_SCHEMAS, elementIdSchema, elementSoundSchema,
  type CheckedElement, type ElementCheckEnv, type TemplateLookup,
} from '../pipeline/plan.js';
import type { PlanElementKind, Transcript } from '../types.js';

export const BUILTIN_EFFECTS = ['two-tier-title', 'keyword-pop', 'big-number', 'stacked-list', 'compare-ab', 'cta-button'] as const;

const wordIndex = z.number().int().min(0);
const seconds = z.number().min(0).max(36_000);

const hookOption = z
  .object({
    id: z.string().min(1).max(40),
    kind: z.enum(['question', 'warning', 'number', 'story', 'other']),
    text: z.string().trim().min(1).max(120),
    subtext: z.string().max(160).optional(),
    mode: z.enum(['overlay', 'moved']),
    moveFromWord: wordIndex.optional(),
    moveToWord: wordIndex.optional(),
  })
  .superRefine((h, ctx) => {
    if (h.mode !== 'moved') return;
    if (h.moveFromWord === undefined || h.moveToWord === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Hook mode "moved" cần moveFromWord và moveToWord.' });
    } else if (h.moveFromWord > h.moveToWord) {
      ctx.addIssue({ code: 'custom', message: 'moveFromWord phải nhỏ hơn hoặc bằng moveToWord.' });
    }
  });

const broll = z.object({
  id: z.string().min(1).max(40),
  anchorWord: wordIndex,
  duration: z.number().min(0.5).max(12),
  title: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(240),
  source: z.enum(['product', 'library', 'ai', 'upload', 'pexels']),
  assetId: z.string().min(1).max(200).optional(),
  prompt: z.string().max(1000).optional(),
  layout: z.enum(['full', 'card', 'cutout', 'pip-circle']),
  box: z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100), w: z.number().positive().max(100), h: z.number().positive().max(100) }).refine((b) => b.x + b.w <= 100 && b.y + b.h <= 100, 'Vùng ảnh phải nằm trong khung hình.').optional(),
  enabled: z.boolean().default(true),
  // Plan v2
  hint: z.string().trim().max(500).optional(),
  query: z.object({ description: z.string().trim().min(1).max(300), keywords: z.array(z.string().trim().min(1).max(60)).min(1).max(8) }).optional(),
  animIn: z.string().trim().min(1).max(60).optional(),
  sound: elementSoundSchema.optional(),
  origin: z.enum(['ai', 'owner']).optional(),
});

const zoom = z.object({
  id: elementIdSchema.optional(),
  anchorWord: wordIndex.optional(),
  at: seconds.optional(),
  duration: z.number().min(0.2).max(10),
  scale: z.number().min(1).max(2),
  origin: z.enum(['ai', 'owner']).optional(),
}).refine((x) => x.at !== undefined || x.anchorWord !== undefined, 'Zoom cần at hoặc anchorWord.');

const overlay = z.object({
  id: z.string().min(1).max(40),
  effect: z.string().min(1).max(60),
  anchorWord: wordIndex.optional(),
  at: seconds,
  duration: z.number().min(0.3).max(15),
  props: z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())])).default({}),
});

export const planInputSchema = z.object({
  styleId: z.string().min(1).max(60),
  aspect: z.enum(['9:16', '16:9', '1:1', '4:5']),
  targetSeconds: z.number().positive().max(36_000).optional(),
  summary: z.string().trim().min(10).max(2000),
  cutWords: z.array(wordIndex).max(20_000),
  gapMs: z.number().int().min(0).max(5000),
  hook: z.object({ options: z.array(hookOption).min(1).max(5), chosen: z.string().min(1) }).optional(),
  brolls: z.array(broll).max(40).default([]),
  captions: z.object({
    styleId: z.string().min(1).max(60),
    position: z.enum(['bottom', 'middle', 'behind']),
    highlight: z.array(z.string().min(1).max(60)).max(60).default([]),
    maxWordsPerChunk: z.number().int().min(1).max(8),
  }),
  overlays: z.array(overlay).max(60).default([]),
  zooms: z.array(zoom).max(60).default([]),
  music: z.object({
    assetId: z.string().min(1).max(200),
    mood: z.string().max(60),
    gainDb: z.number().min(-60).max(6),
    duck: z.boolean(),
  }).optional(),
  sfx: z.array(z.object({ at: seconds, assetId: z.string().min(1).max(200), gainDb: z.number().min(-60).max(6).optional() })).max(200).default([]),
  covers: z.array(z.object({ frameAt: seconds, title: z.string().trim().min(1).max(80), subtitle: z.string().max(120).optional() })).max(3).default([]),
  meta: z.object({
    title: z.string().trim().min(1).max(150),
    caption: z.string().max(3000),
    hashtags: z.array(z.string().min(1).max(60)).max(30),
    hook: z.string().max(200).optional(),
  }),
  changes: z.array(z.string().max(300)).max(40).optional(),
  // Plan v2 (Dựng nhanh): all optional.
  planFormat: z.literal(2).optional(),
  templateId: z.string().trim().min(1).max(80).optional(),
  autoCut: z.boolean().optional(),
  beats: z.array(ELEMENT_SCHEMAS.beat).max(80).optional(),
  scenes: z.array(ELEMENT_SCHEMAS.scene).max(40).optional(),
  graphics: z.array(ELEMENT_SCHEMAS.graphic).max(20).optional(),
  // Derived or server-owned; accepted and ignored when present.
  version: z.number().int().optional(),
  createdAt: z.string().optional(),
  sourceDurationSec: z.number().optional(),
  outputDurationSec: z.number().optional(),
  keep: z.array(z.object({ start: z.number(), end: z.number() })).optional(),
  removed: z.array(z.object({ start: z.number(), end: z.number(), kind: z.string(), text: z.string().optional() })).optional(),
  author: z.string().optional(),
});

export type PlanInput = z.infer<typeof planInputSchema>;

export interface PlanValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Estimated output length from cutWords + gapMs (needs the transcript). */
  estimatedOutputSec?: number;
  plan?: PlanInput;
}

function issuePath(path: readonly PropertyKey[]): string {
  return path.map(String).join('.') || '(gốc)';
}

/** Rough length of the cut: kept words plus gaps capped at gapMs. The server computes the real keep list. */
export function estimateOutputSeconds(words: Transcript['words'], cutWords: ReadonlySet<number>, gapMs: number): number {
  let total = 0;
  let prev: Transcript['words'][number] | null = null;
  for (const w of words) {
    if (cutWords.has(w.i)) continue;
    total += Math.max(0, w.end - w.start);
    if (prev) total += Math.min(Math.max(0, w.start - prev.end), gapMs / 1000);
    prev = w;
  }
  return total;
}

/** With `templates` (registry getTemplate), components, props and animIn are checked against the plan's template. */
export function validatePlan(raw: unknown, transcript?: Pick<Transcript, 'words' | 'durationSec'> | null, templates?: TemplateLookup): PlanValidation {
  const parsed = planInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${issuePath(i.path)}: ${i.message}`),
      warnings: [],
    };
  }
  const plan = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];

  const dup = (label: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) errors.push(`${label}: id "${id}" bị trùng.`);
      seen.add(id);
    }
  };
  dup('hook.options', plan.hook?.options.map((o) => o.id) ?? []);
  dup('brolls', plan.brolls.map((b) => b.id));
  dup('overlays', plan.overlays.map((o) => o.id));
  // Element ids key overrides.json, so they are unique across beats, scenes, graphics, B-roll and zooms.
  const elementIds = [...(plan.beats ?? []), ...(plan.scenes ?? []), ...(plan.graphics ?? []), ...plan.zooms].flatMap((x) => (x.id ? [x.id] : []));
  const brollIds = new Set(plan.brolls.map((b) => b.id));
  dup('phần tử', elementIds);
  for (const id of new Set(elementIds)) if (brollIds.has(id)) errors.push(`phần tử: id "${id}" trùng với một B-roll.`);
  if (plan.autoCut === false && plan.cutWords.length) errors.push('autoCut false (tắt tự cắt) thì cutWords phải rỗng.');

  if (plan.hook && !plan.hook.options.some((o) => o.id === plan.hook!.chosen)) {
    errors.push(`hook.chosen "${plan.hook.chosen}" không nằm trong hook.options.`);
  }
  if (new Set(plan.cutWords).size !== plan.cutWords.length) warnings.push('cutWords có chỉ số lặp; server sẽ gộp lại.');
  for (const b of plan.brolls) {
    if (b.source === 'ai' && !b.prompt) warnings.push(`brolls[${b.id}]: nguồn "ai" nên có prompt.`);
    // A slot with a query is filled by the machine (Asset Hub) after the plan is in.
    if ((b.source === 'library' || b.source === 'product' || b.source === 'upload' || b.source === 'pexels') && !b.assetId && !b.query) {
      warnings.push(`brolls[${b.id}]: nguồn "${b.source}" nên có assetId (hoặc query để máy tìm); không có thì chỉ hiện thẻ giữ chỗ.`);
    }
  }
  // Plan v2 elements: anchors, title length, components of the template (pipeline/plan.ts checkElement).
  const template = plan.templateId && templates ? templates(plan.templateId) : null;
  if (plan.templateId && templates && !template) warnings.push(`Mẫu "${plan.templateId}" chưa có trên máy: chưa kiểm tra component và hiệu ứng.`);
  const env: ElementCheckEnv = { words: transcript ? transcript.words.length : Number.POSITIVE_INFINITY, cut: new Set(plan.cutWords), template, strictBroll: true };
  const lists: [PlanElementKind, string, CheckedElement[]][] = [
    ['beat', 'beats', plan.beats ?? []], ['scene', 'scenes', plan.scenes ?? []], ['graphic', 'graphics', plan.graphics ?? []], ['zoom', 'zooms', plan.zooms],
  ];
  for (const [kind, key, list] of lists) list.forEach((el, k) => checkElement(kind, el.id ? `${key}[${el.id}]` : `${key}[${k}]`, el, env, errors, warnings));
  for (const b of plan.brolls) if (b.query || b.animIn) checkElement('broll', `brolls[${b.id}]`, { ...b, anchorWord: undefined }, env, errors, warnings);
  for (const o of plan.overlays) {
    if (!(BUILTIN_EFFECTS as readonly string[]).includes(o.effect)) {
      warnings.push(`overlays[${o.id}]: hiệu ứng "${o.effect}" chưa có trong 6 hiệu ứng dựng sẵn (${BUILTIN_EFFECTS.join(', ')}); renderer có thể bỏ qua.`);
    }
  }
  if (plan.captions.highlight.length > 12) warnings.push('captions.highlight dài hơn 12 từ: nhấn quá nhiều thì không còn là nhấn.');
  if (plan.music && plan.sfx.length > 0 && !plan.music.duck) warnings.push('Có SFX và nhạc nhưng music.duck=false: nhạc có thể át giọng.');

  let estimated: number | undefined;
  if (transcript) {
    const n = transcript.words.length;
    const inRange = (idx: number) => idx >= 0 && idx < n;
    const cut = new Set(plan.cutWords);
    for (const i of cut) {
      if (!inRange(i)) errors.push(`cutWords: từ số ${i} không tồn tại (lời có ${n} từ, từ 0 đến ${n - 1}).`);
    }
    for (const o of plan.hook?.options ?? []) {
      if (o.mode !== 'moved') continue;
      for (const idx of [o.moveFromWord, o.moveToWord]) {
        if (idx !== undefined && !inRange(idx)) errors.push(`hook[${o.id}]: từ số ${idx} không tồn tại.`);
      }
      if (o.moveFromWord !== undefined && o.moveToWord !== undefined && inRange(o.moveFromWord) && inRange(o.moveToWord)) {
        let allCut = true;
        for (let i = o.moveFromWord; i <= o.moveToWord; i++) if (!cut.has(i)) { allCut = false; break; }
        if (allCut) warnings.push(`hook[${o.id}]: đoạn đưa lên đầu nằm hoàn toàn trong cutWords; bỏ các từ đó khỏi cutWords nếu muốn nó phát.`);
        const span = transcript.words[o.moveToWord].end - transcript.words[o.moveFromWord].start;
        if (span > 8) warnings.push(`hook[${o.id}]: đoạn đưa lên đầu dài ${span.toFixed(1)}s; hook nên 3–6s.`);
      }
    }
    for (const b of plan.brolls) {
      if (!inRange(b.anchorWord)) errors.push(`brolls[${b.id}]: anchorWord ${b.anchorWord} không tồn tại.`);
      else if (cut.has(b.anchorWord)) errors.push(`brolls[${b.id}]: anchorWord ${b.anchorWord} nằm trong cutWords, cảnh chèn sẽ mất mốc.`);
    }
    for (const o of plan.overlays) {
      if (o.anchorWord === undefined) continue;
      if (!inRange(o.anchorWord)) errors.push(`overlays[${o.id}]: anchorWord ${o.anchorWord} không tồn tại.`);
      else if (cut.has(o.anchorWord)) errors.push(`overlays[${o.id}]: anchorWord ${o.anchorWord} nằm trong cutWords.`);
    }
    for (const c of plan.covers) {
      if (c.frameAt > transcript.durationSec + 0.5) errors.push(`covers: frameAt ${c.frameAt}s vượt độ dài video gốc (${transcript.durationSec.toFixed(1)}s).`);
    }
    if (n > 0 && cut.size >= n) errors.push('cutWords cắt hết mọi từ.');
    estimated = estimateOutputSeconds(transcript.words, cut, plan.gapMs);
    if (plan.targetSeconds) {
      const ratio = estimated / plan.targetSeconds;
      if (ratio > 1.25 || ratio < 0.7) {
        warnings.push(`Ước tính video dài ${estimated.toFixed(0)}s, lệch nhiều so với mục tiêu ${plan.targetSeconds}s (chưa tính hook/B-roll).`);
      }
    }
    if (cut.size === 0) warnings.push('cutWords rỗng: chưa cắt từ đệm hay câu nói lại nào. Chắc chưa?');
  } else {
    warnings.push('Chưa đối chiếu được với lời chép (không lấy được transcript): chỉ kiểm tra cấu trúc.');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    ...(estimated !== undefined ? { estimatedOutputSec: Math.round(estimated * 10) / 10 } : {}),
    plan,
  };
}
