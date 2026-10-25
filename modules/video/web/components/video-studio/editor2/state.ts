// Editor v2 state (signals) and actions. The transcript, plan, marks and player live in lib/video-edit/editor.ts
// (shared with the old editor); this adds the template, the owner's overrides with their debounced save, the
// AI-dropped elements, the selection and the library panel.
import { signal } from '@preact/signals';
import { ApiError } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import { errorMessage, errorStatus, videoEditApi } from '@modules/video/web/lib/video-edit/api';
import {
  acceptPlan, approveAndExport, editPlan, loadEditor, marks, playerControls, playerTime, resetEditor,
} from '@modules/video/web/lib/video-edit/editor';
import {
  applyOverridesPatch, askMark, editor2Api, emptyOverrides, mergeMusicPatches, mergePatches, needsFetch,
  type AssetCandidate, type EditorElement, type ElementOverridePatch, type MusicOverridePatch, type OverridesPatch,
  type TemplateManifest,
} from '@modules/video/web/lib/video-edit/editor2';
import { assetFileUrl } from '@modules/video/web/lib/video-edit/library-api';
import { applyProject, project } from '@modules/video/web/lib/video-edit/studio';
import type { DroppedElement, OverridesDoc, PlanElementKind, VideoAsset } from '@modules/video/web/lib/video-edit/types';

/** Left tool rail. The element tools open the inspector on an element of that kind. */
export type ToolId = 'text' | 'caption' | 'scene' | 'broll' | 'graphic' | 'sound' | 'zoom' | 'template';
export const TOOL_KIND: Partial<Record<ToolId, PlanElementKind>> = { text: 'beat', scene: 'scene', broll: 'broll', graphic: 'graphic', zoom: 'zoom' };
export const KIND_TOOL: Record<PlanElementKind, ToolId> = { beat: 'text', scene: 'scene', broll: 'broll', graphic: 'graphic', zoom: 'zoom' };

/** Debounce of inspector edits before PUT /overrides. */
export const SAVE_DELAY_MS = 400;

export const template = signal<TemplateManifest | null>(null);
export const overridesDoc = signal<OverridesDoc>(emptyOverrides());
export const dropped = signal<DroppedElement[]>([]);
export const selectedId = signal<string | null>(null);
export const tool = signal<ToolId>('text');
export const saveState = signal<'idle' | 'saving' | 'saved' | 'error'>('idle');
/** overrides.updatedAt the player was built with; it moves after each save so the preview reloads. */
export const previewStamp = signal('');
/** Thư viện: B-roll swap (for one slot) or background music. */
export const libraryPanel = signal<{ tab: 'broll' | 'music'; brollId?: string } | null>(null);
export const bgmAssets = signal<VideoAsset[]>([]);
export const sfxAssets = signal<VideoAsset[]>([]);
/** Names of assets swapped in this session (the plan only holds their id). */
export const assetNames = signal<Record<string, string>>({});
/** "Nhờ AI sửa": element = about the selected element, time = a pin at the playhead. */
export const askScope = signal<'element' | 'time'>('element');
export const askFocus = signal(0);
export const restoring = signal<string | null>(null);

function toast(title: string, e: unknown) {
  pushToast({ tone: 'error', title, description: errorMessage(e), ttlMs: 6000 });
}

const hasContent = (d: OverridesDoc) => Object.keys(d.elements).length > 0 || !!d.music || !!d.captions;

// ── Loading ──

let loadedFor: string | null = null;

export async function loadQuickEditor(projectId: string) {
  if (loadedFor === projectId) return;
  loadedFor = projectId;
  clearQueue();
  template.value = null;
  overridesDoc.value = emptyOverrides();
  dropped.value = [];
  selectedId.value = null;
  tool.value = 'text';
  saveState.value = 'idle';
  previewStamp.value = '';
  libraryPanel.value = null;
  askScope.value = 'element';
  const p = project.value;
  const templateId = p?.plan?.templateId ?? p?.quick?.templateId;
  await Promise.all([
    loadEditor(projectId),
    reloadOverrides(projectId, true),
    templateId ? loadTemplate(templateId) : Promise.resolve(),
    loadSounds(),
  ]);
}

async function loadTemplate(id: string) {
  const forProject = loadedFor;
  try {
    const r = await editor2Api.template(id);
    if (loadedFor === forProject) template.value = r.template;
  } catch { /* the inspector falls back to the default beat fields */ }
}

async function loadSounds() {
  const forProject = loadedFor;
  const [bgm, sfx] = await Promise.all([
    videoEditApi.assets({ kind: 'bgm' }).catch(() => null),
    videoEditApi.assets({ kind: 'sfx' }).catch(() => null),
  ]);
  if (loadedFor !== forProject) return;
  const usable = (a: VideoAsset) => a.available !== false && a.enabled !== false;
  if (bgm) bgmAssets.value = bgm.assets.filter(usable);
  if (sfx) sfxAssets.value = sfx.assets.filter(usable);
}

/** GET /overrides; `initial` keeps the preview URL as is unless the owner already has edits. */
export async function reloadOverrides(projectId: string, initial = false) {
  try {
    const r = await editor2Api.overrides(projectId);
    if (loadedFor !== projectId) return;
    overridesDoc.value = queued() ? applyOverridesPatch(r.overrides, queuedBody(), r.overrides.updatedAt) : r.overrides;
    dropped.value = r.dropped ?? [];
    if (!initial || hasContent(r.overrides)) previewStamp.value = r.overrides.updatedAt;
  } catch (e) {
    if (loadedFor === projectId && !initial) toast('Không tải được phần bạn đã sửa', e);
  }
}

/** A new plan version (AI revise, restore): show it and re-read overrides, whose `dropped` depends on it. */
export async function reloadPlan(projectId: string) {
  try {
    const r = await videoEditApi.plan(projectId);
    if (loadedFor !== projectId) return;
    acceptPlan(r.plan);
  } catch (e) { toast('Không tải được kế hoạch', e); }
  await reloadOverrides(projectId);
}

export function resetQuickEditor() {
  void flushOverrides();
  loadedFor = null;
  stopSound();
  resetEditor();
}

// ── Selection ──

/** Where the player goes for an element: a little into it, so its entrance has played. */
export function seekTimeFor(e: Pick<EditorElement, 'at' | 'end'>): number {
  return e.at + Math.min(0.6, (e.end - e.at) / 2);
}

export function selectElement(e: EditorElement, seek = true) {
  selectedId.value = e.id;
  tool.value = KIND_TOOL[e.kind];
  askScope.value = 'element';
  if (seek) playerControls.seek(seekTimeFor(e));
}

// ── Saving overrides: edits are applied at once, sent 400 ms after the last one ──

const queue = { elements: new Map<string, ElementOverridePatch>(), music: undefined as MusicOverridePatch | undefined };
let timer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<void> = Promise.resolve();

function clearQueue() {
  if (timer) clearTimeout(timer);
  timer = null;
  queue.elements.clear();
  queue.music = undefined;
}

const queued = () => queue.elements.size > 0 || queue.music !== undefined;

function queuedBody(): OverridesPatch {
  return {
    ...(queue.elements.size ? { elements: Object.fromEntries(queue.elements) } : {}),
    ...(queue.music !== undefined ? { music: queue.music } : {}),
  };
}

const now = () => new Date().toISOString();

/** An inspector edit: shown now, saved with the next ones in one PUT /overrides. */
export function editElement(id: string, patch: ElementOverridePatch) {
  overridesDoc.value = applyOverridesPatch(overridesDoc.value, { elements: { [id]: patch } }, now());
  queue.elements.set(id, mergePatches(queue.elements.get(id), patch));
  schedule();
}

export function editMusic(patch: MusicOverridePatch) {
  overridesDoc.value = applyOverridesPatch(overridesDoc.value, { music: patch }, now());
  queue.music = mergeMusicPatches(queue.music, patch);
  schedule();
}

function schedule() {
  saveState.value = 'saving';
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void flushOverrides(); }, SAVE_DELAY_MS);
}

/** Send what is queued now (before export, AI revise, restore, leaving the editor). */
export function flushOverrides(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!queued()) return chain;
  const body = queuedBody();
  queue.elements.clear();
  queue.music = undefined;
  return send(body);
}

function send(body: OverridesPatch): Promise<void> {
  const projectId = loadedFor;
  if (!projectId) return chain;
  const run = async () => {
    saveState.value = 'saving';
    try {
      const r = await editor2Api.putOverrides(projectId, body);
      if (loadedFor !== projectId) return;
      // Edits made while this request was out stay on top of what the server answered.
      overridesDoc.value = queued() ? applyOverridesPatch(r.overrides, queuedBody(), now()) : r.overrides;
      dropped.value = r.dropped ?? [];
      previewStamp.value = r.overrides.updatedAt;
      if (!queued()) saveState.value = 'saved';
    } catch (e) {
      if (loadedFor !== projectId) return;
      saveState.value = 'error';
      toast('Chưa lưu được chỉnh sửa', e);
      // 409 no_element: the AI revised the plan meanwhile. Either way show what the server has.
      if (errorStatus(e) === 409) await reloadPlan(projectId);
      else await reloadOverrides(projectId);
    }
  };
  chain = chain.then(run, run);
  return chain;
}

/** "Trả về như AI dựng": the element's override goes away (sent at once, not debounced). */
export function resetElement(id: string) {
  queue.elements.delete(id);
  overridesDoc.value = applyOverridesPatch(overridesDoc.value, { elements: { [id]: null } }, now());
  return send({ elements: { [id]: null } });
}

export function resetMusic() {
  queue.music = undefined;
  overridesDoc.value = applyOverridesPatch(overridesDoc.value, { music: null }, now());
  return send({ music: null });
}

// ── Dropped by the AI: put back with POST /plan/ops restore ──

export async function restoreDropped(d: DroppedElement): Promise<boolean> {
  const p = project.value;
  if (!p) return false;
  await flushOverrides();
  restoring.value = d.id;
  try {
    const r = await editor2Api.planOps(p.id, { baseVersion: p.planVersion, ops: [{ op: 'restore', id: d.id, fromVersion: d.fromVersion }] });
    if (project.value?.id !== p.id) return false;
    applyProject(r.project);
    acceptPlan(r.plan);
    await reloadOverrides(p.id);
    pushToast({ tone: 'success', title: `Đã khôi phục “${d.label}”`, description: 'Phần này giờ là của bạn, AI sửa lại cũng giữ nguyên.', ttlMs: 5000 });
    return true;
  } catch (e) {
    toast('Chưa khôi phục được', e);
    if (errorStatus(e) === 409) await reloadPlan(p.id);
    return false;
  } finally {
    restoring.value = null;
  }
}

// ── "Nhờ AI sửa": a mark with the element as context, sent to the agent at once ──

export async function askAi(text: string, item: EditorElement | null): Promise<boolean> {
  const p = project.value;
  if (!p || !text.trim()) return false;
  await flushOverrides();
  try {
    await videoEditApi.createMark(p.id, askMark(text, item, playerTime.value));
    const r = await videoEditApi.sendMarks(p.id);
    if (r.project) applyProject(r.project);
    marks.value = await videoEditApi.marks(p.id).catch(() => marks.value);
    pushToast({ tone: 'success', title: 'Đã nhờ AI sửa', description: 'AI đang làm bản mới. Phần bạn đã sửa tay được giữ nguyên.', ttlMs: 5000 });
    return true;
  } catch (e) {
    toast('Chưa gửi được cho AI', e);
    return false;
  }
}

export async function exportVideo() {
  await flushOverrides();
  await approveAndExport();
}

// ── Thư viện ──

/** The server's error code (`stale_ref`, `no_element`…) when there is one. */
function errorCode(e: unknown): string | null {
  const body = e instanceof ApiError ? e.body as { code?: unknown } | null : null;
  return body && typeof body.code === 'string' ? body.code : null;
}

/**
 * "Dùng" on a candidate: bring it into the library if needed (POST /assets/fetch), then swap the B-roll's file
 * with an owner override (assetId). `stale`: the server forgot that Pexels result, search again.
 */
export async function useCandidate(brollId: string, c: AssetCandidate): Promise<'ok' | 'stale' | 'error'> {
  let assetId = c.ref;
  try {
    if (needsFetch(c)) assetId = (await editor2Api.fetchAsset(c.ref)).asset.id;
  } catch (e) {
    toast('Chưa lấy được cảnh này', e);
    return errorCode(e) === 'stale_ref' ? 'stale' : 'error';
  }
  assetNames.value = { ...assetNames.value, [assetId]: c.caption };
  const original = editPlan.value?.brolls.find((b) => b.id === brollId)?.assetId;
  editElement(brollId, { assetId: assetId === original ? null : assetId });
  await flushOverrides();
  return saveState.value === 'error' ? 'error' : 'ok';
}

// ── Nghe thử ──

let audio: HTMLAudioElement | null = null;

export function stopSound() {
  try { audio?.pause(); } catch { /* not playing */ }
  audio = null;
}

/** Plays a library sound; volume 0..2 (1 = the template's level). */
export function playSound(assetId: string, volume = 1) {
  stopSound();
  try {
    const a = new Audio(assetFileUrl(assetId));
    a.volume = Math.max(0, Math.min(1, volume * 0.5));
    audio = a;
    const played = a.play() as Promise<void> | undefined;
    played?.catch?.((e: unknown) => toast('Chưa nghe thử được', e));
  } catch (e) { toast('Chưa nghe thử được', e); }
}
