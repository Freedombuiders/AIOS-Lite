// Dựng nhanh › Editor v2: the API client for overrides, plan ops, templates and the Asset Hub; the element
// model the inspector, layers and timeline draw from; title markup checks; and the override patches the
// inspector sends. Pure apart from editor2Api; signals and actions live in
// components/video-studio/editor2/state.ts. Contract: docs/dung-nhanh-gd1-plan.md › Hợp đồng dữ liệu.
import { apiGet, apiPost, apiPut } from '@/lib/api';
import { previewUrl } from './api';
import type { CaptionChunk, PlanModel } from './plan-geometry';
import type { TemplateSummary } from './quick-api';
import type {
  BrollItem, CaptionStyle, DroppedElement, EditPlan, ElementOverride, ElementProps, ElementSound, GraphicItem,
  MarkKind, MusicOverride, OverridesDoc, PlanElementKind, PlanOp, SceneItem, TextBeat, TranscriptWord, VideoAsset,
  VideoAspect, VideoProject, ZoomItem,
} from './types';

const BASE = '/api/m/video/edit';
const enc = encodeURIComponent;

// ── Template contract (mirror of server/edit/templates/types.ts; the web types.ts copy only carries server/edit/types.ts) ──

export interface PropDef {
  type: 'text' | 'markup' | 'list' | 'number' | 'color' | 'asset';
  label: string;
  required?: boolean;
  maxWords?: number; maxLines?: number; maxItems?: number;
}

export interface ComponentDef {
  kind: 'beat' | 'scene' | 'graphic' | 'broll-frame';
  label: string;
  file: string;
  runtime: string;
  props: Record<string, PropDef>;
  duration: { min: number; max: number; default: number };
  /** Entrance presets allowed; all of the template's when absent. */
  animations?: string[];
  safeZone?: { top: number; bottom: number };
  useWhen?: string; avoidWhen?: string;
}

export interface TemplateManifest {
  id: string; version: string; name: string; description: string;
  tags: string[]; tier: 'free' | 'pro'; aspects: VideoAspect[];
  poster?: string; preview?: string;
  styleId?: string;
  tokens: { fonts: { title: string; sub: string; caption: string }; colors: Record<string, string> };
  captions: CaptionStyle;
  components: Record<string, ComponentDef>;
  /** `sound`: the SFX asset id played when an element's sound is auto. */
  animations: { id: string; label: string; sound?: string }[];
  sounds: { density: 'none' | 'low' | 'medium' | 'high'; transition?: string; click?: string };
  rules: string;
  license?: { source: string; attribution?: string };
  legacy?: boolean;
}

// ── Asset Hub (mirror of server/edit/assets/types.ts) ──

export type AssetSource = 'project' | 'mine' | 'pexels' | 'pexels-photo';

export interface AssetLicense { name: string; creator?: string; sourceUrl?: string; attributionRequired: boolean }

export interface AssetCandidate {
  /** Library asset id, or 'pexels:video:<id>' / 'pexels:photo:<id>' before it is downloaded. */
  ref: string;
  source: AssetSource;
  kind: 'video' | 'image' | 'bgm' | 'sfx';
  caption: string;
  thumbUrl?: string; durationSec?: number; width?: number; height?: number;
  license: AssetLicense;
  /** 1..5 against the line being spoken (only when searched for a B-roll slot). */
  score?: number;
  reason?: string;
}

export interface AssetSearchParams {
  q?: string;
  kind?: AssetCandidate['kind'];
  source?: AssetSource;
  /** With brollId: the machine reads the slot's description and keywords and scores each candidate. */
  projectId?: string;
  brollId?: string;
  aspect?: VideoAspect;
  limit?: number;
}

export interface AssetSearchResponse {
  candidates: AssetCandidate[];
  /** Shown to the owner ("chưa có Pexels key"). */
  notes: string[];
}

// ── Overrides (PUT /overrides body; server/edit/overrides.ts) ──

/** One element's edit: keys not named are kept, `null` removes a key. */
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
  assetId?: string | null;
}

export type MusicOverridePatch = { [K in keyof MusicOverride]?: MusicOverride[K] | null };

export interface OverridesPatch {
  /** `null` for an element = back to what the AI made ("Trả về như AI dựng"). */
  elements?: Record<string, ElementOverridePatch | null>;
  /** `null` = back to the music the AI chose. */
  music?: MusicOverridePatch | null;
}

export interface OverridesResponse { overrides: OverridesDoc; dropped: DroppedElement[] }

export const editor2Api = {
  overrides: (projectId: string) => apiGet<OverridesResponse>(`${BASE}/projects/${enc(projectId)}/overrides`),
  putOverrides: (projectId: string, body: OverridesPatch) =>
    apiPut<OverridesResponse>(`${BASE}/projects/${enc(projectId)}/overrides`, body),
  /** 409 when baseVersion is stale or the agent is busy. */
  planOps: (projectId: string, body: { baseVersion: number; ops: PlanOp[] }) =>
    apiPost<{ plan: EditPlan; project: VideoProject }>(`${BASE}/projects/${enc(projectId)}/plan/ops`, body),
  template: (id: string) => apiGet<{ template: TemplateManifest; summary?: TemplateSummary }>(`${BASE}/templates/${enc(id)}`),
  searchAssets: async (params: AssetSearchParams): Promise<AssetSearchResponse> => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
    const r = await apiGet<unknown>(`${BASE}/assets/search?${qs}`);
    if (Array.isArray(r)) return { candidates: r as AssetCandidate[], notes: [] };
    const body = (r ?? {}) as Partial<AssetSearchResponse>;
    return { candidates: body.candidates ?? [], notes: body.notes ?? [] };
  },
  /** Brings a candidate into the library (downloads a Pexels one); 404 `stale_ref` = search again. */
  fetchAsset: (ref: string) => apiPost<{ asset: VideoAsset; downloaded?: boolean }>(`${BASE}/assets/fetch`, { ref }),
};

/**
 * The composition for the editor's player: the plan version plus the overrides it was built with, so the
 * player reloads after each save. The one place that names the cache parameter (`o`).
 */
export function quickPreviewUrl(projectId: string, version: number, overridesUpdatedAt?: string | null): string {
  const base = previewUrl(projectId, version);
  return overridesUpdatedAt ? `${base}&o=${enc(overridesUpdatedAt)}` : base;
}

/** Dựng nhanh projects open Editor v2; the others keep the existing editor. */
export function isQuickProject(p: VideoProject | null | undefined): boolean {
  return !!p && (!!p.quick || p.flow === 'quick');
}

export function emptyOverrides(): OverridesDoc {
  return { version: 1, elements: {}, updatedAt: '' };
}

// ── Display ──

/** 9.74 → "00:09,7" (the editor writes times the Vietnamese way); `short` drops the minute padding. */
export function clockVi(sec: number, short = false): string {
  const t = Math.max(0, Math.round(sec * 10) / 10);
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(1).padStart(4, '0').replace('.', ',');
  return `${short ? m : String(m).padStart(2, '0')}:${s}`;
}

/** 2.43 → "2,4 giây" */
export function secondsVi(sec: number): string {
  return `${(Math.round(sec * 10) / 10).toFixed(1).replace('.', ',')} giây`;
}

// ── Title markup: *từ* = highlighted, | = line break ──

/** Words and lines of title markup (`*` is not a word, `|` breaks a line). Same count as the server. */
export function markupStats(text: string): { words: number; lines: number } {
  const lines = text.split('|');
  return { words: lines.flatMap((l) => l.replace(/\*/g, ' ').split(/\s+/)).filter(Boolean).length, lines: lines.length };
}

/** Markup as plain words. */
export function markupPlain(text: string): string {
  return text.replace(/\*/g, '').split('|').map((l) => l.trim()).filter(Boolean).join(' ');
}

export interface MarkupCheck { words: number; lines: number; ok: boolean; label: string }

/** "4 từ · 2 dòng · đạt" or "7 từ · 2 dòng · nên 2–6 từ, tối đa 2 dòng". */
export function markupCheck(text: string, limits: { minWords?: number; maxWords?: number; maxLines?: number }): MarkupCheck {
  const { words, lines } = markupStats(text);
  const min = limits.minWords ?? 1;
  const ok = words >= min && (limits.maxWords === undefined || words <= limits.maxWords)
    && (limits.maxLines === undefined || lines <= limits.maxLines);
  const range = limits.maxWords !== undefined ? `${min}–${limits.maxWords} từ` : `ít nhất ${min} từ`;
  const lineRule = limits.maxLines !== undefined ? `, tối đa ${limits.maxLines} dòng` : '';
  return { words, lines, ok, label: `${words} từ · ${lines} dòng · ${ok ? 'đạt' : `nên ${range}${lineRule}`}` };
}

/** Plain words of a text field ("tối đa 3 từ"). */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// ── Plan elements as the editor sees them (override over plan) ──

export type PlanElement = TextBeat | SceneItem | GraphicItem | BrollItem | ZoomItem;
export type PropValue = string | number | string[];

export type TrackId = 'text' | 'caption' | 'scene' | 'broll' | 'graphic' | 'zoom' | 'music' | 'sfx' | 'video' | 'mark';

/** Timeline tracks, top to bottom (mockup Editor). */
export const TRACKS: readonly { id: TrackId; label: string }[] = [
  { id: 'text', label: 'Chữ' },
  { id: 'caption', label: 'Phụ đề' },
  { id: 'scene', label: 'Minh hoạ' },
  { id: 'broll', label: 'Cảnh trám' },
  { id: 'graphic', label: 'Đồ hoạ' },
  { id: 'zoom', label: 'Zoom' },
  { id: 'music', label: 'Nhạc' },
  { id: 'sfx', label: 'Tiếng động' },
  { id: 'video', label: 'Video' },
  { id: 'mark', label: 'Góp ý' },
];

export const KIND_TRACK: Record<PlanElementKind, TrackId> = { beat: 'text', scene: 'scene', broll: 'broll', graphic: 'graphic', zoom: 'zoom' };
export const KIND_LABEL: Record<PlanElementKind, string> = { beat: 'Chữ', scene: 'Minh hoạ', broll: 'Cảnh trám', graphic: 'Đồ hoạ', zoom: 'Zoom' };
/** "Nhịp 3/6" in the inspector heading. */
export const KIND_COUNT: Record<PlanElementKind, string> = { beat: 'Nhịp', scene: 'Cảnh', broll: 'Cảnh', graphic: 'Đồ hoạ', zoom: 'Zoom' };
const KIND_ORDER: PlanElementKind[] = ['beat', 'scene', 'broll', 'graphic', 'zoom'];

const BROLL_SOURCE: Record<BrollItem['source'], string> = {
  product: 'của bạn', library: 'của bạn', upload: 'của bạn', ai: 'AI tạo', pexels: 'Pexels',
};

export interface EditorElement {
  id: string;
  kind: PlanElementKind;
  /** Output seconds, the owner's override over the plan. */
  at: number;
  end: number;
  label: string;
  /** Component id in the template (B-roll uses the template's broll-frame). */
  component?: string;
  el: PlanElement;
  override?: ElementOverride;
  /** The owner hid it (override hidden): kept on the timeline, gone from the video. */
  hidden: boolean;
  /** 1-based place among the elements of its kind, and how many there are. */
  n: number;
  count: number;
}

export interface ElementContext {
  words: TranscriptWord[];
  model: PlanModel;
  overrides: OverridesDoc;
  /** Template component label ("Logo cuối"). */
  componentLabel?: (component: string) => string | undefined;
  /** Library name or caption of an asset the owner swapped in. */
  assetName?: (assetId: string) => string | undefined;
}

const clip = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function firstText(props: ElementProps | undefined, skip: string[] = []): string {
  for (const [k, v] of Object.entries(props ?? {})) {
    if (skip.includes(k)) continue;
    if (typeof v === 'string' && markupPlain(v)) return markupPlain(v);
  }
  return '';
}

function sceneLabel(component: string, props: ElementProps, ctx: ElementContext): string {
  const step = typeof props.step === 'number' && props.step > 0 ? `Bước ${props.step} · ` : '';
  const text = firstText(props, ['step']);
  return clip(step + (text || ctx.componentLabel?.(component) || component));
}

/** Every plan v2 element with an id, sorted by time within its kind; B-roll that is off or cut out is left out. */
export function buildElements(plan: EditPlan, ctx: ElementContext): EditorElement[] {
  const out: EditorElement[] = [];
  const o = (id: string) => ctx.overrides.elements[id];
  const push = (kind: PlanElementKind, el: PlanElement, baseAt: number, baseDur: number, label: string, component?: string) => {
    const ov = o(el.id as string);
    const at = ov?.at ?? baseAt;
    const dur = Math.max(0.1, ov?.duration ?? baseDur);
    out.push({
      id: el.id as string, kind, at, end: at + dur, label, ...(component ? { component } : {}), el,
      ...(ov ? { override: ov } : {}), hidden: !!ov?.hidden, n: 0, count: 0,
    });
  };
  for (const b of plan.beats ?? []) {
    if (!b.id) continue;
    push('beat', b, b.at, b.duration, clip(markupPlain(o(b.id)?.text?.title ?? b.title)) || 'Chữ trống', b.component || 'text-beat');
  }
  for (const s of plan.scenes ?? []) {
    if (!s.id) continue;
    push('scene', s, s.at, s.duration, sceneLabel(s.component, { ...s.props, ...(o(s.id)?.props ?? {}) }, ctx), s.component);
  }
  for (const b of plan.brolls) {
    if (!b.id || !b.enabled) continue;
    const w = ctx.words[b.anchorWord];
    const at = w ? ctx.model.toOut(w.start) : null;
    if (at === null && o(b.id)?.at === undefined) continue;
    const swapped = o(b.id)?.assetId;
    const label = swapped ? `${ctx.assetName?.(swapped) ?? 'Cảnh bạn chọn'} · bạn chọn` : `${b.title} · ${BROLL_SOURCE[b.source] ?? b.source}`;
    push('broll', b, at ?? 0, b.duration, clip(label, 48));
  }
  for (const g of plan.graphics ?? []) {
    if (!g.id) continue;
    push('graphic', g, g.at, g.duration, clip(ctx.componentLabel?.(g.component) || firstText(g.props) || g.component), g.component);
  }
  for (const z of plan.zooms) {
    if (!z.id) continue;
    push('zoom', z, z.at, z.duration, `Zoom ${Math.round((z.scale - 1) * 100)}%`);
  }
  for (const kind of KIND_ORDER) {
    const list = out.filter((e) => e.kind === kind).sort((a, b) => a.at - b.at);
    list.forEach((e, i) => { e.n = i + 1; e.count = list.length; });
  }
  return out.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.at - b.at);
}

const covers = (e: { at: number; end: number }, t: number) => t >= e.at - 0.001 && t < e.end;

/** The element of `kind` the tool rail opens: the one playing, else the next one, else the first. */
export function elementForTool(elements: EditorElement[], kind: PlanElementKind, t: number): EditorElement | null {
  const list = elements.filter((e) => e.kind === kind);
  return list.find((e) => covers(e, t)) ?? list.find((e) => e.at >= t) ?? list[0] ?? null;
}

export interface Layer {
  key: string;
  label: string;
  /** "Chữ", "Phụ đề", "Video"… */
  kindLabel: string;
  track: TrackId;
  /** Selectable plan element. */
  id?: string;
}

/** What is on screen at `t`, top layer first (mockup "LỚP TẠI 00:09,7"). Hidden elements are not on screen. */
export function layersAt(t: number, elements: EditorElement[], captions: CaptionChunk[], model: PlanModel): Layer[] {
  const out: Layer[] = elements.filter((e) => !e.hidden && covers(e, t)).map((e) => ({
    key: e.id, id: e.id, label: e.label, kindLabel: KIND_LABEL[e.kind], track: KIND_TRACK[e.kind],
  }));
  const cap = captions.find((c) => t >= c.s - 0.001 && t < c.e);
  if (cap) out.push({ key: `cap-${cap.s}`, label: cap.text, kindLabel: 'Phụ đề', track: 'caption' });
  const seg = model.segs.find((s) => t >= s.out - 0.001 && t < s.out + (s.end - s.start));
  if (seg) out.push({ key: `seg-${seg.out}`, label: `Đoạn nguồn ${clockVi(seg.start + (t - seg.out), true)}`, kindLabel: 'Video', track: 'video' });
  return out;
}

/** Header line: "0:24,3 sau khi cắt · 6 nhịp chữ · 1 cảnh minh hoạ · 2 cảnh trám". */
export function planSummary(total: number, elements: EditorElement[]): string {
  const n = (k: PlanElementKind) => elements.filter((e) => e.kind === k && !e.hidden).length;
  const parts = [`${clockVi(total, true)} sau khi cắt`];
  if (n('beat')) parts.push(`${n('beat')} nhịp chữ`);
  if (n('scene')) parts.push(`${n('scene')} cảnh minh hoạ`);
  if (n('broll')) parts.push(`${n('broll')} cảnh trám`);
  if (n('graphic')) parts.push(`${n('graphic')} đồ hoạ`);
  return parts.join(' · ');
}

// ── Inspector: a form generated from the component's props schema ──

/** Beat fields when the template is not loaded (same as th-vang's text-beat). */
export const DEFAULT_BEAT_PROPS: Record<string, PropDef> = {
  kicker: { type: 'text', label: 'Nhãn nhỏ', maxWords: 3 },
  title: { type: 'markup', label: 'Tiêu đề', required: true, maxWords: 6, maxLines: 2 },
  sub: { type: 'text', label: 'Chữ phụ', maxWords: 8 },
};
const BEAT_TEXT_KEYS = new Set(['kicker', 'title', 'sub']);

export function componentDef(template: TemplateManifest | null, item: EditorElement): ComponentDef | null {
  if (!template || item.kind === 'zoom') return null;
  if (item.kind === 'broll') return Object.values(template.components).find((c) => c.kind === 'broll-frame') ?? null;
  return item.component ? template.components[item.component] ?? null : null;
}

export interface FieldSpec {
  key: string;
  def: PropDef;
  /** A beat's kicker/title/sub go to override.text; every other prop to override.props. */
  target: 'text' | 'props';
  /** What the AI made. */
  original: PropValue | undefined;
  /** What the owner sees now. */
  value: PropValue | undefined;
}

function originalProp(el: PlanElement, key: string): PropValue | undefined {
  const props = (el as { props?: ElementProps }).props;
  if (props && key in props) return props[key];
  // B-roll keeps frame settings (layout) on the item itself.
  const v = (el as unknown as Record<string, unknown>)[key];
  return typeof v === 'string' || typeof v === 'number' ? v : undefined;
}

export function inspectorFields(item: EditorElement, def: ComponentDef | null): FieldSpec[] {
  if (item.kind === 'zoom') return [];
  const props = def?.props ?? (item.kind === 'beat' ? DEFAULT_BEAT_PROPS : {});
  return Object.entries(props).map(([key, d]) => {
    const target: FieldSpec['target'] = item.kind === 'beat' && BEAT_TEXT_KEYS.has(key) ? 'text' : 'props';
    const original = target === 'text'
      ? (item.el as TextBeat)[key as 'kicker' | 'title' | 'sub']
      : originalProp(item.el, key);
    const over = target === 'text'
      ? item.override?.text?.[key as 'kicker' | 'title' | 'sub']
      : item.override?.props?.[key];
    return { key, def: d, target, original, value: over !== undefined ? over : original };
  });
}

function sameValue(a: PropValue | undefined, b: PropValue | undefined): boolean {
  const blank = (v: PropValue | undefined) => v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
  if (blank(a) && blank(b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The patch for one field: back to the AI's value removes the key, so no empty override is left behind. */
export function fieldPatch(field: FieldSpec, value: PropValue): ElementOverridePatch {
  const v = sameValue(value, field.original) ? null : value;
  return field.target === 'text'
    ? { text: { [field.key]: v as string | null } }
    : { props: { [field.key]: v } };
}

/** Entrance presets the component allows, with the template's labels. */
export function animationOptions(template: TemplateManifest | null, def: ComponentDef | null): { id: string; label: string }[] {
  if (!template) return [];
  const allowed = def?.animations;
  return template.animations.filter((a) => !allowed || allowed.includes(a.id)).map(({ id, label }) => ({ id, label }));
}

export function effectiveAnim(item: EditorElement): string | undefined {
  return item.override?.animIn ?? (item.el as { animIn?: string }).animIn;
}

export function animPatch(item: EditorElement, animIn: string): ElementOverridePatch {
  return { animIn: animIn === (item.el as { animIn?: string }).animIn ? null : animIn };
}

export const DEFAULT_SOUND: ElementSound = { mode: 'auto', volume: 1 };

export function effectiveSound(item: EditorElement): ElementSound {
  return item.override?.sound ?? (item.el as { sound?: ElementSound }).sound ?? DEFAULT_SOUND;
}

export function soundPatch(item: EditorElement, next: ElementSound): ElementOverridePatch {
  const base = (item.el as { sound?: ElementSound }).sound ?? DEFAULT_SOUND;
  const same = next.mode === base.mode && (next.assetId ?? '') === (base.assetId ?? '') && Math.abs(next.volume - base.volume) < 0.005;
  return { sound: same ? null : next };
}

/** The template's SFX for an entrance preset: what sound mode auto plays. */
export function presetSoundId(template: TemplateManifest | null, animIn: string | undefined): string | null {
  return (animIn && template?.animations.find((a) => a.id === animIn)?.sound) || null;
}

/** The SFX "Nghe thử" plays: the chosen file, or the template's sound for the entrance preset. */
export function soundAssetId(item: EditorElement, template: TemplateManifest | null): string | null {
  const s = effectiveSound(item);
  if (s.mode === 'none') return null;
  if (s.mode === 'asset') return s.assetId ?? null;
  return presetSoundId(template, effectiveAnim(item));
}

export function scalePatch(percent: number): ElementOverridePatch {
  const s = Math.round(percent) / 100;
  return { s: Math.abs(s - 1) < 0.005 ? null : s };
}

// ── Patches: merged while debounced, applied locally until the server answers ──

const mergeKeyed = <V>(a: Record<string, V> | null | undefined, b: Record<string, V> | null | undefined) =>
  (b === null || b === undefined || a === null || a === undefined ? b : { ...a, ...b });

/** Two edits of one element in a row → one patch (later keys win; text and props merge key by key). */
export function mergePatches(a: ElementOverridePatch | undefined, b: ElementOverridePatch): ElementOverridePatch {
  const out: ElementOverridePatch = { ...a, ...b };
  if (b.text !== undefined) out.text = mergeKeyed(a?.text, b.text);
  if (b.props !== undefined) out.props = mergeKeyed(a?.props, b.props);
  return out;
}

export function mergeMusicPatches(a: MusicOverridePatch | undefined, b: MusicOverridePatch): MusicOverridePatch {
  return { ...a, ...b };
}

function applyKeys<V>(prev: Record<string, V> | undefined, patch: Record<string, V | null | undefined>): Record<string, V> | undefined {
  const out: Record<string, V> = { ...(prev ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** One element's override after a patch, the way the server merges it (undefined = none left). */
export function applyElementPatch(prev: ElementOverride | undefined, patch: ElementOverridePatch | null, now: string): ElementOverride | undefined {
  if (patch === null) return undefined;
  const { updatedAt: _was, ...next } = (prev ?? { updatedAt: '' }) as ElementOverride & Record<string, unknown>;
  const rec = next as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === 'text' || k === 'props') {
      const merged = v === null ? undefined : applyKeys(rec[k] as Record<string, unknown> | undefined, v as Record<string, unknown>);
      if (merged) rec[k] = merged; else delete rec[k];
    } else if (v === null || (k === 'hidden' && v === false) || (k === 's' && Math.abs((v as number) - 1) < 0.0005)) {
      delete rec[k];
    } else {
      rec[k] = v;
    }
  }
  return Object.keys(rec).length ? { ...(rec as Omit<ElementOverride, 'updatedAt'>), updatedAt: now } : undefined;
}

export function applyOverridesPatch(doc: OverridesDoc, patch: OverridesPatch, now: string): OverridesDoc {
  const elements = { ...doc.elements };
  for (const [id, p] of Object.entries(patch.elements ?? {})) {
    const next = applyElementPatch(elements[id], p, now);
    if (next) elements[id] = next; else delete elements[id];
  }
  const music = patch.music === undefined
    ? doc.music
    : patch.music === null ? undefined : applyKeys(doc.music as Record<string, unknown> | undefined, patch.music) as MusicOverride | undefined;
  const { music: _m, ...rest } = doc;
  return { ...rest, elements, ...(music ? { music } : {}), updatedAt: now };
}

// ── Background music: the owner's choice over plan.music ──

export interface MusicState {
  assetId?: string;
  mood?: string;
  duck: boolean;
  off: boolean;
  /** The owner changed the music (override present). */
  edited: boolean;
}

export function musicState(plan: EditPlan, doc: OverridesDoc): MusicState {
  const o = doc.music;
  const assetId = o?.assetId ?? plan.music?.assetId;
  return {
    ...(assetId ? { assetId } : {}),
    ...(plan.music?.mood ? { mood: plan.music.mood } : {}),
    duck: o?.duck ?? plan.music?.duck ?? true,
    off: !!o?.off || !assetId,
    edited: !!o,
  };
}

/** Pick a track (its own choice again = back to the AI's); `null` = no music. */
export function musicPickPatch(plan: EditPlan, assetId: string | null): MusicOverridePatch {
  if (assetId === null) return { off: true };
  return { assetId: assetId === plan.music?.assetId ? null : assetId, off: null };
}

export function musicDuckPatch(plan: EditPlan, duck: boolean): MusicOverridePatch {
  return { duck: duck === (plan.music?.duck ?? true) ? null : duck };
}

// ── Sounds on the "Tiếng động" track ──

/** Plan SFX plus the entrance sounds of the elements (auto = the template's sound for the preset). */
export function soundTicks(plan: EditPlan, elements: EditorElement[], template: TemplateManifest | null): { at: number; key: string }[] {
  const out = plan.sfx.map((s, i) => ({ at: s.at, key: `sfx-${i}` }));
  for (const e of elements) {
    if (e.hidden || e.kind === 'zoom') continue;
    if (soundAssetId(e, template)) out.push({ at: e.at, key: `el-${e.id}` });
  }
  return out.sort((a, b) => a.at - b.at);
}

// ── "Nhờ AI sửa": a review mark with the element as context, sent through the marks flow ──

const ASK_KIND: Record<PlanElementKind, MarkKind> = { beat: 'text', broll: 'broll', scene: 'effect', graphic: 'effect', zoom: 'effect' };

export function askMark(text: string, item: EditorElement | null, t: number): { start: number; end?: number; kind: MarkKind; note: string } {
  const note = text.trim();
  if (!item) return { start: Math.round(t * 10) / 10, kind: 'other', note };
  return {
    start: Math.round(item.at * 10) / 10,
    end: Math.round(item.end * 10) / 10,
    kind: ASK_KIND[item.kind],
    note: `${KIND_LABEL[item.kind]} “${item.label}” (${item.id}, ${clockVi(item.at)}–${clockVi(item.end)}): ${note}`,
  };
}

// ── Library cards ──

export const SOURCE_LABEL: Record<AssetSource, string> = {
  project: 'Tư liệu dự án', mine: 'Kho của tôi', pexels: 'Pexels', 'pexels-photo': 'Pexels ảnh',
};

/** Pexels candidates are not in the library yet: POST /assets/fetch first. */
export function needsFetch(c: AssetCandidate): boolean {
  return c.source === 'pexels' || c.source === 'pexels-photo' || c.ref.startsWith('pexels:');
}

export function licenseLine(c: AssetCandidate): string {
  if (c.source === 'mine') return 'Kho của tôi';
  if (c.source === 'project') return 'Tư liệu bạn gửi cho video này';
  const by = c.license.creator ? ` · tác giả ${c.license.creator}` : '';
  return `${c.license.name || 'Pexels'}${by} · lưu link gốc`;
}

export function candidateMeta(c: AssetCandidate): string {
  const size = c.width && c.height ? `${c.width}×${c.height} · ` : '';
  return `${size}${c.kind === 'image' ? 'ảnh' : 'video'}`;
}

export function candidateLength(c: AssetCandidate): string {
  if (c.kind === 'image') return 'ảnh';
  if (!c.durationSec) return '';
  const s = Math.round(c.durationSec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
