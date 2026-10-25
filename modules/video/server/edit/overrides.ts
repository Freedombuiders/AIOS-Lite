// Owner overrides (overrides.json next to project.json): the owner's hand edits by element id, which the
// composition applies over the plan. The AI never writes this file. PUT /overrides merges one element at a
// time; GET /overrides also lists the AI elements with an override that the current plan dropped.
//
// The merge rules and the dropped-edit check are adapted from OpenFilm
// (https://github.com/openfilm/openfilm) studio/ui/src/lib/film-overrides.ts and dropped-overrides.ts,
// MIT License, Copyright (c) 2026 OpenFilm contributors (full notice: THIRD_PARTY_NOTICES.md).
import { elementLabel, findElement, planElements } from './pipeline/plan.js';
import type { CaptionStyle, DroppedElement, EditPlan, ElementOverride, ElementProps, ElementSound, OverridesDoc } from './types.js';

/** What PUT /overrides sends for one element: keys not named are kept, `null` removes a key. */
export interface ElementOverridePatch {
  t?: [number, number] | null;
  s?: number | null;
  text?: { kicker?: string | null; title?: string | null; sub?: string | null } | null;
  props?: Record<string, ElementProps[string] | null> | null;
  animIn?: string | null;
  sound?: ElementSound | null;
  at?: number | null;
  duration?: number | null;
  hidden?: boolean | null;
}

export interface OverridesPatch {
  /** `null` for an element = back to what the AI made ("Trả về như AI dựng"). */
  elements?: Record<string, ElementOverridePatch | null>;
  /** `null` = back to the template's caption style. */
  captions?: { [K in keyof CaptionStyle]?: CaptionStyle[K] | null } | null;
}

export function emptyOverrides(now = new Date().toISOString()): OverridesDoc {
  return { version: 1, elements: {}, updatedAt: now };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Nested values merge key by key; `null` deletes a key ('' is a value: the owner blanked a line). Empty → undefined. */
function mergeKeys<V>(prev: Record<string, V> | undefined, patch: Record<string, V | null | undefined> | null | undefined): Record<string, V> | undefined {
  if (patch === null) return undefined;
  if (patch === undefined) return prev;
  const out: Record<string, V> = { ...(prev ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

type OverrideBody = Omit<ElementOverride, 'updatedAt'>;

/**
 * An override with its no-op values left out (offset 0, size 1, not hidden), or null when nothing is left:
 * an override that does nothing would tell the director the owner changed this element.
 */
function tidy(o: OverrideBody): OverrideBody | null {
  const t = o.t && (round2(o.t[0]) !== 0 || round2(o.t[1]) !== 0) ? [round2(o.t[0]), round2(o.t[1])] as [number, number] : undefined;
  const s = o.s != null && Math.abs(o.s - 1) > 0.0005 ? round4(o.s) : undefined;
  const text = o.text && Object.keys(o.text).length ? o.text : undefined;
  const props = o.props && Object.keys(o.props).length ? o.props : undefined;
  const out: OverrideBody = {
    ...(t ? { t } : {}),
    ...(s !== undefined ? { s } : {}),
    ...(text ? { text } : {}),
    ...(props ? { props } : {}),
    ...(o.animIn ? { animIn: o.animIn } : {}),
    ...(o.sound ? { sound: o.sound } : {}),
    ...(o.at != null ? { at: round3(o.at) } : {}),
    ...(o.duration != null ? { duration: round3(o.duration) } : {}),
    ...(o.hidden ? { hidden: true } : {}),
  };
  return Object.keys(out).length ? out : null;
}

const pick = <T>(prev: T | undefined, patch: T | null | undefined): T | undefined => (patch === undefined ? prev : patch ?? undefined);

/** One element's override after a patch (null = it has none left). `updatedAt` moves only when it changed. */
export function mergeElementOverride(prev: ElementOverride | undefined, patch: ElementOverridePatch | null, now: string): ElementOverride | null {
  if (patch === null) return null;
  const { updatedAt: _was, ...before } = prev ?? { updatedAt: '' };
  const merged = tidy({
    t: pick(before.t, patch.t),
    s: pick(before.s, patch.s),
    text: mergeKeys(before.text, patch.text),
    props: mergeKeys(before.props, patch.props),
    animIn: pick(before.animIn, patch.animIn),
    sound: pick(before.sound, patch.sound),
    at: pick(before.at, patch.at),
    duration: pick(before.duration, patch.duration),
    hidden: pick(before.hidden, patch.hidden),
  });
  if (!merged) return null;
  if (prev && JSON.stringify(tidy(before)) === JSON.stringify(merged)) return prev;
  return { ...merged, updatedAt: now };
}

/** The next overrides document: each element named in the patch merged on its own, the others untouched. */
export function mergeOverrides(doc: OverridesDoc, patch: OverridesPatch, now = new Date().toISOString()): OverridesDoc {
  const elements = { ...doc.elements };
  for (const [id, p] of Object.entries(patch.elements ?? {})) {
    const next = mergeElementOverride(elements[id], p, now);
    if (next) elements[id] = next;
    else delete elements[id];
  }
  const captions = patch.captions === undefined
    ? doc.captions
    : mergeKeys(doc.captions as Record<string, unknown> | undefined, patch.captions as Record<string, unknown> | null) as Partial<CaptionStyle> | undefined;
  return { version: 1, elements, ...(captions ? { captions } : {}), updatedAt: now };
}

/**
 * Overrides whose element the current plan no longer has: an AI revision left it out. Each is found in the
 * latest earlier version that still had it, so the editor can offer `restore`. Elements the owner hid are not
 * listed (dropping them is what the owner asked for), nor overrides of an element no version has.
 */
export function droppedElements(
  doc: OverridesDoc,
  current: EditPlan | null | undefined,
  versions: number[],
  loadPlan: (version: number) => EditPlan | null,
): DroppedElement[] {
  if (!current) return [];
  const present = new Set(planElements(current).map((e) => e.el.id));
  const wanted = Object.entries(doc.elements).filter(([id, o]) => !present.has(id) && !o.hidden).map(([id]) => id);
  if (!wanted.length) return [];
  const found = new Map<string, DroppedElement>();
  for (const version of [...versions].filter((v) => v !== current.version).sort((a, b) => b - a)) {
    if (found.size === wanted.length) break;
    const plan = loadPlan(version);
    if (!plan) continue;
    for (const id of wanted) {
      if (found.has(id)) continue;
      const hit = findElement(plan, id);
      if (hit) found.set(id, { id, kind: hit.kind, label: elementLabel(hit.kind, hit.el), fromVersion: version });
    }
  }
  return wanted.flatMap((id) => (found.has(id) ? [found.get(id)!] : []));
}
