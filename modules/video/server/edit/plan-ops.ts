// Structural owner edits of a plan by element id (POST /projects/:id/plan/ops): add an element, remove one
// the owner added, split a timed element, cut or keep words, restore an element from an earlier version.
// Pure: the route loads the plan and saves the result. Ops gather into one working draft: an owner draft is
// edited in place (`rev` bumped); any other plan gets a new owner version.
//
// Adapted from OpenFilm (https://github.com/openfilm/openfilm) studio/server/ops.mjs and
// studio/ui/src/editor/undo.ts, MIT License, Copyright (c) 2026 OpenFilm contributors (full notice:
// THIRD_PARTY_NOTICES.md): edits name elements by id, never by place; a missing element is a conflict and a
// malformed edit is invalid; putting back an element that is already there does nothing; the right half of
// a split is `<id>-b`.
import { mergeElementOverride } from './overrides.js';
import {
  ELEMENT_LISTS, ELEMENT_SCHEMAS, checkElement, derivePlan, elementLabel, findElement, listOf, mintId, planElements,
  planMapper, wordsText, zodIssues,
  type CheckedElement, type ElementListKey, type PlanContext, type PlanElement, type TemplateLookup,
} from './pipeline/plan.js';
import { r1, r3 } from './pipeline/tools.js';
import type { EditPlan, ElementOrigin, OverridesDoc, PlanElementKind, PlanOp, VideoProject } from './types.js';

export class PlanOpError extends Error {
  constructor(message: string, public kind: 'conflict' | 'invalid') {
    super(message);
  }
}

export interface PlanOpsOptions {
  /** The project's plan state: an owner draft is edited in place. */
  planStatus?: VideoProject['planStatus'];
  /** Version a new draft gets (pipeline.nextVersion). */
  nextVersion: number;
  /** Earlier versions, for `restore`. */
  loadPlan: (version: number) => EditPlan | null;
  /** The owner's overrides: a split uses the times the owner sees, and both halves keep the other edits. */
  overrides?: OverridesDoc | null;
  templates?: TemplateLookup;
  now?: string;
}

export interface PlanOpsResult {
  plan: EditPlan;
  /** False when the ops changed nothing: no version needs saving. */
  changed: boolean;
  inPlace: boolean;
  /** The overrides after the edit, when it touched them (an element removed or split). */
  overrides?: OverridesDoc;
}

/** Shortest piece a split leaves on either side (seconds). */
const MIN_PIECE = 0.1;
/** The right half of a split snaps to a word that starts this soon after the split point. */
const SNAP_SEC = 0.5;
const DURATION_LINE = /^Thời lượng ([\d.]+)s → [\d.]+s$/;
const V2_KINDS = new Set<PlanElementKind>(['beat', 'scene', 'graphic']);

type TimedElement = PlanElement & { at: number; duration: number; anchorWord?: number; origin?: ElementOrigin };

const listFor = (kind: PlanElementKind) => ELEMENT_LISTS.find((l) => l.kind === kind)!;

function setList(plan: EditPlan, key: ElementListKey, list: PlanElement[]) {
  (plan as unknown as Record<ElementListKey, PlanElement[]>)[key] = list;
}

const conflict = (message: string) => new PlanOpError(message, 'conflict');
const invalid = (message: string) => new PlanOpError(message, 'invalid');

/** Apply one batch of ops to the current plan (see the file header for the draft rule). Throws PlanOpError. */
export function applyPlanOps(current: EditPlan, ops: PlanOp[], ctx: PlanContext, opts: PlanOpsOptions): PlanOpsResult {
  if (!ops.length) throw invalid('Cần ít nhất một thao tác.');
  const words = ctx.transcript.words;
  const now = opts.now ?? new Date().toISOString();
  let plan = derivePlan(structuredClone(current), ctx);
  const overrides = opts.overrides ? structuredClone(opts.overrides) : null;
  let touched = false;
  const changes: string[] = [];

  // Ids already in use, including overrides left from dropped elements: a new element never inherits one.
  const taken = () => new Set([
    ...planElements(plan).map((e) => e.el.id!),
    ...plan.overlays.map((o) => o.id),
    ...Object.keys(overrides?.elements ?? {}),
  ]);
  const need = (id: string) => {
    const hit = findElement(plan, id);
    if (!hit) throw conflict(`Không còn phần tử "${id}" trong kế hoạch. Tải lại rồi thử lại.`);
    return hit;
  };

  for (const op of ops) {
    switch (op.op) {
      case 'add': {
        const { kind, key, prefix, label } = listFor(op.kind);
        const parsed = ELEMENT_SCHEMAS[op.kind].safeParse(op.element);
        if (!parsed.success) throw invalid(`Phần tử chưa hợp lệ: ${zodIssues(parsed.error).join('; ')}`);
        const el = { ...parsed.data } as CheckedElement & Record<string, unknown>;
        const errors: string[] = [];
        const template = plan.templateId && opts.templates ? opts.templates(plan.templateId) : null;
        checkElement(kind, `${key} mới`, el, { words: words.length, cut: new Set(plan.cutWords), template, strictBroll: true }, errors, []);
        if (errors.length) throw invalid(errors.join('; '));
        const element = { ...el, id: mintId(prefix, taken()), origin: 'owner', ...(kind === 'broll' ? {} : { at: el.at ?? 0 }) } as PlanElement;
        setList(plan, key, [...(listOf(plan, key) ?? []), element]);
        if (V2_KINDS.has(kind)) plan.planFormat = 2;
        changes.push(`Thêm ${label} «${elementLabel(kind, element)}»`);
        break;
      }
      case 'remove': {
        const hit = need(op.id);
        const name = `${listFor(hit.kind).label} «${elementLabel(hit.kind, hit.el)}»`;
        if (hit.el.origin !== 'owner') throw invalid(`${name} do AI dựng nên không xoá được, hãy ẩn nó.`);
        setList(plan, hit.key, (listOf(plan, hit.key) ?? []).filter((x) => x.id !== op.id));
        if (overrides?.elements[op.id]) { delete overrides.elements[op.id]; touched = true; }
        changes.push(`Xoá ${name}`);
        break;
      }
      case 'split': {
        const hit = need(op.id);
        if (hit.kind === 'broll') throw invalid('Chưa tách được B-roll: đoạn chèn luôn phát từ đầu tệp.');
        const el = hit.el as TimedElement;
        const name = `${listFor(hit.kind).label} «${elementLabel(hit.kind, el)}»`;
        const o = overrides?.elements[op.id];
        const movedByHand = o?.at !== undefined || o?.duration !== undefined;
        const start = o?.at ?? el.at;
        const end = start + (o?.duration ?? el.duration);
        if (!(op.at >= start + MIN_PIECE - 1e-6 && op.at <= end - MIN_PIECE + 1e-6)) {
          throw invalid(`Điểm tách ${r1(op.at)}s phải nằm trong ${name} (${r1(start)}s–${r1(end)}s), cách hai đầu ít nhất ${MIN_PIECE}s.`);
        }
        const left: TimedElement = { ...el, at: r3(start), duration: r3(op.at - start), origin: 'owner' };
        // Times the owner set by hand become the plan's own; the anchor would move them back.
        if (movedByHand) delete left.anchorWord;
        let rightAt = op.at;
        let rightAnchor: number | undefined;
        if (left.anchorWord !== undefined) {
          const { map } = planMapper(plan, ctx);
          const cut = new Set(plan.cutWords);
          for (const w of words) {
            if (cut.has(w.i) || w.i === left.anchorWord) continue;
            const t = map(w.start);
            if (t === null || t < op.at - 1e-3 || t > op.at + SNAP_SEC || t > end - MIN_PIECE) continue;
            if (rightAnchor === undefined || t < rightAt) { rightAnchor = w.i; rightAt = t; }
          }
          if (rightAnchor !== undefined) left.duration = r3(rightAt - start);
        }
        const used = taken();
        let rightId = `${op.id}-b`;
        for (let n = 2; used.has(rightId); n++) rightId = `${op.id}-b-${n}`;
        const right: TimedElement = { ...structuredClone(el), id: rightId, at: r3(rightAt), duration: r3(end - rightAt), origin: 'owner' };
        delete right.anchorWord;
        if (rightAnchor !== undefined) right.anchorWord = rightAnchor;
        const list = listOf(plan, hit.key)!;
        list.splice(list.findIndex((x) => x.id === op.id), 1, left, right);
        if (o && overrides) {
          // Both halves keep the owner's look; the times are in the plan now.
          const rest = mergeElementOverride(o, { at: null, duration: null }, now);
          if (rest) { overrides.elements[op.id] = rest; overrides.elements[rightId] = { ...structuredClone(rest), updatedAt: now }; }
          else delete overrides.elements[op.id];
          touched = true;
        }
        changes.push(`Tách ${name} tại ${r1(op.at)}s`);
        break;
      }
      case 'toggleWords': {
        const set = new Set(plan.cutWords);
        const added: number[] = [];
        const dropped: number[] = [];
        for (const i of [...new Set(op.words.filter((i) => Number.isInteger(i) && i >= 0 && i < words.length))].sort((a, b) => a - b)) {
          if (set.has(i)) { set.delete(i); dropped.push(i); } else { set.add(i); added.push(i); }
        }
        plan.cutWords = [...set].sort((a, b) => a - b);
        if (added.length) changes.push(`Bỏ ${added.length} từ: «${wordsText(words, added)}»`);
        if (dropped.length) changes.push(`Giữ lại ${dropped.length} từ: «${wordsText(words, dropped)}»`);
        break;
      }
      case 'restore': {
        if (findElement(plan, op.id)) break; // back already (the AI wrote it again): nothing to put back
        const old = opts.loadPlan(op.fromVersion);
        if (!old) throw conflict(`Không có kế hoạch phiên bản ${op.fromVersion}.`);
        const hit = findElement(old, op.id);
        if (!hit) throw conflict(`Kế hoạch phiên bản ${op.fromVersion} không có phần tử "${op.id}".`);
        // Put back by the owner: it is the owner's now, so the next AI revision keeps it.
        const el = { ...structuredClone(hit.el), origin: 'owner' } as PlanElement;
        if (hit.kind !== 'broll' && el.anchorWord !== undefined && !words[el.anchorWord]) delete el.anchorWord;
        setList(plan, hit.key, [...(listOf(plan, hit.key) ?? []), el]);
        if (V2_KINDS.has(hit.kind)) plan.planFormat = 2;
        changes.push(`Khôi phục ${listFor(hit.kind).label} «${elementLabel(hit.kind, el)}» từ bản ${op.fromVersion}`);
        break;
      }
      default:
        throw invalid(`Thao tác không rõ: ${(op as { op?: string }).op ?? ''}`);
    }
    // Re-time after every op, so a split after a cut in the same batch sees the new times.
    plan = derivePlan(plan, ctx);
  }

  const changed = changes.length > 0;
  const inPlace = current.author === 'owner' && opts.planStatus === 'draft';
  const durationLine = (from: number) => (Math.abs(plan.outputDurationSec - from) >= 0.05
    ? [`Thời lượng ${r1(from)}s → ${r1(plan.outputDurationSec)}s`] : []);
  if (inPlace) {
    // One draft, one list: earlier lines stay and the duration line spans the whole draft.
    const before = (current.changes ?? []).filter((c) => c !== 'Không có thay đổi');
    const first = before.map((c) => DURATION_LINE.exec(c)?.[1]).find(Boolean);
    plan.rev = (current.rev ?? 0) + 1;
    plan.changes = [...before.filter((c) => !DURATION_LINE.test(c)), ...changes, ...durationLine(first ? Number(first) : current.outputDurationSec)];
  } else {
    plan.version = opts.nextVersion;
    delete plan.rev;
    plan.createdAt = now;
    plan.author = 'owner';
    plan.changes = [...changes, ...durationLine(current.outputDurationSec)];
  }
  if (!plan.changes.length) plan.changes = ['Không có thay đổi'];
  return { plan, changed, inPlace, ...(touched && overrides ? { overrides: { ...overrides, updatedAt: now } } : {}) };
}
