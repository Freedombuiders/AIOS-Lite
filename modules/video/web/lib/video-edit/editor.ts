// Editor view state (signals) + actions: transcript, plan versions, optimistic word toggles,
// marks, diff. Reads the open project from studio.ts; talks to the API only through videoEditApi.
import { signal } from '@preact/signals';
import { pushToast } from '@/lib/toasts';
import { errorMessage, videoEditApi, type MarkInput, type PlanPatch } from './api';
import { applyProject, decidePlan, project } from './studio';
import type { EditPlan, MarkKind, Transcript, VideoMark } from './types';

export type EditorTab = 'marks' | 'hook' | 'broll' | 'fx';

export interface MarkDraft {
  start: number;
  end?: number;
  kind: MarkKind;
  note: string;
  /** Set while editing an existing mark. */
  editingId?: string;
}

export const transcript = signal<Transcript | null>(null);
/** The plan being shown (latest, or an older version when `viewVersion` is set). */
export const editPlan = signal<EditPlan | null>(null);
/** null = latest version. */
export const viewVersion = signal<number | null>(null);
export const editorLoading = signal(false);
export const marks = signal<VideoMark[]>([]);
/** Optimistic word toggles not yet confirmed by the server: word index -> desired "cut" state. */
export const cutOverrides = signal<Record<number, boolean>>({});
export const savingPlan = signal(0);
export const editorTab = signal<EditorTab>('marks');
export const markDraft = signal<MarkDraft | null>(null);
export const diffPanel = signal<{ from: number; to: number; changes: string[] | null; error?: string } | null>(null);
/** Playhead in OUTPUT seconds, fed by the player's timeupdate. */
export const playerTime = signal(0);
export const playerPlaying = signal(false);

/** Imperative hooks the player registers so the timeline and transcript can drive it. */
export const playerControls: { seek: (t: number) => void; toggle: () => void } = {
  seek: () => {}, toggle: () => {},
};

export function isReadOnly(): boolean {
  const p = project.value;
  return !!p && viewVersion.value !== null && viewVersion.value !== p.planVersion;
}

function toast(title: string, e: unknown) {
  pushToast({ tone: 'error', title, description: errorMessage(e), ttlMs: 6000 });
}

// ── Loading ──────────────────────────────────────────────────────────────────

let loadedFor: string | null = null;

export async function loadEditor(projectId: string) {
  if (loadedFor === projectId) return;
  loadedFor = projectId;
  transcript.value = null;
  editPlan.value = null;
  viewVersion.value = null;
  marks.value = [];
  cutOverrides.value = {};
  markDraft.value = null;
  diffPanel.value = null;
  pending.clear();
  editorLoading.value = true;
  const guard = <T,>(p: Promise<T>, title: string): Promise<T | null> =>
    p.catch((e) => { if (loadedFor === projectId) toast(title, e); return null; });
  const [t, plan, ms] = await Promise.all([
    guard(videoEditApi.transcript(projectId), 'Không tải được lời thoại'),
    guard(videoEditApi.plan(projectId), 'Không tải được kế hoạch'),
    guard(videoEditApi.marks(projectId), 'Không tải được góp ý'),
  ]);
  if (loadedFor !== projectId) return;
  if (t) transcript.value = t;
  if (plan) editPlan.value = plan.plan;
  if (ms) marks.value = ms;
  editorLoading.value = false;
}

/** Forget the cached project so the next open reloads everything. */
export function resetEditor() {
  loadedFor = null;
  if (toggleTimer) clearTimeout(toggleTimer);
  toggleTimer = null;
  pending.clear();
}

/** Show a plan version; null = latest. */
export async function showVersion(version: number | null) {
  const p = project.value;
  if (!p) return;
  const target = version === null || version === p.planVersion ? null : version;
  viewVersion.value = target;
  diffPanel.value = null;
  try {
    const r = await videoEditApi.plan(p.id, target ?? undefined);
    if (project.value?.id !== p.id) return;
    editPlan.value = r.plan;
  } catch (e) { toast('Không mở được bản này', e); viewVersion.value = null; }
}

/** A plan arrived (SSE or after our own PATCH): swap it in unless the owner is looking at an old version. */
export function acceptPlan(plan: EditPlan) {
  if (viewVersion.value !== null && viewVersion.value !== plan.version) return;
  if (diffPanel.value && diffPanel.value.to !== plan.version) diffPanel.value = null;
  viewVersion.value = null;
  editPlan.value = plan;
  // Drop optimistic toggles the server has now confirmed.
  const o = { ...cutOverrides.value };
  const cut = new Set(plan.cutWords);
  for (const k of Object.keys(o)) if (cut.has(Number(k)) === o[Number(k)] && !pending.has(Number(k))) delete o[Number(k)];
  if (Object.keys(o).length !== Object.keys(cutOverrides.value).length) cutOverrides.value = o;
}

// ── Plan edits ───────────────────────────────────────────────────────────────

let chain: Promise<unknown> = Promise.resolve();

/** Serialised PATCH /plan: each call is a new draft version, so order matters. */
export function patchPlan(body: PlanPatch): Promise<boolean> {
  const p = project.value;
  if (!p || isReadOnly()) return Promise.resolve(false);
  const run = async (): Promise<boolean> => {
    savingPlan.value++;
    try {
      const r = await videoEditApi.patchPlan(p.id, body);
      if (project.value?.id === p.id) {
        acceptPlan(r.plan);
        if (r.project) applyProject(r.project);
      }
      return true;
    } catch (e) {
      toast('Chưa lưu được chỉnh sửa', e);
      return false;
    } finally { savingPlan.value--; }
  };
  const next = chain.then(run, run);
  chain = next.then(() => {}, () => {});
  return next;
}

const pending = new Set<number>();
let toggleTimer: ReturnType<typeof setTimeout> | null = null;

export function isCutWord(plan: EditPlan, i: number): boolean {
  const o = cutOverrides.value[i];
  return o !== undefined ? o : plan.cutWords.includes(i);
}

/** Click on a transcript word: strike/restore it now, send the batch 400 ms after the last click. */
export function toggleWord(i: number) {
  const plan = editPlan.value;
  if (!plan || isReadOnly()) return;
  cutOverrides.value = { ...cutOverrides.value, [i]: !isCutWord(plan, i) };
  if (pending.has(i)) pending.delete(i); else pending.add(i);
  if (toggleTimer) clearTimeout(toggleTimer);
  toggleTimer = setTimeout(() => { void flushToggles(); }, 400);
}

export async function flushToggles() {
  toggleTimer = null;
  const ids = [...pending];
  pending.clear();
  if (ids.length === 0) return;
  const ok = await patchPlan({ toggleWords: ids });
  if (!ok) {
    const o = { ...cutOverrides.value };
    for (const i of ids) delete o[i];
    cutOverrides.value = o;
  } else {
    // anything still unconfirmed after the response (no matching cutWords) is dropped
    const o = { ...cutOverrides.value };
    const cut = new Set(editPlan.value?.cutWords ?? []);
    for (const i of ids) if (!pending.has(i) && cut.has(i) === o[i]) delete o[i];
    cutOverrides.value = o;
  }
}

export const chooseHook = (id: string) => patchPlan({ hookChosen: id });
export const setBroll = (id: string, enabled: boolean) => patchPlan({ brolls: [{ id, enabled }] });
export const setCaption = (caption: string) => patchPlan({ meta: { caption } });

// ── Diff ─────────────────────────────────────────────────────────────────────

export async function showDiff() {
  const p = project.value;
  const plan = editPlan.value;
  if (!p || !plan || plan.version < 2) return;
  const from = plan.version - 1;
  const to = plan.version;
  if (diffPanel.value && diffPanel.value.to === to) { diffPanel.value = null; return; }
  diffPanel.value = { from, to, changes: null };
  try {
    const r = await videoEditApi.planDiff(p.id, from, to);
    if (diffPanel.value?.to === to) diffPanel.value = { from, to, changes: r.changes?.length ? r.changes : (plan.changes ?? []) };
  } catch (e) {
    if (diffPanel.value?.to === to) diffPanel.value = { from, to, changes: plan.changes ?? [], error: errorMessage(e) };
  }
}

// ── Marks ────────────────────────────────────────────────────────────────────

export function startMark(partial: Partial<MarkDraft> = {}) {
  const d = markDraft.value;
  markDraft.value = {
    start: partial.start ?? playerTime.value,
    end: partial.end,
    kind: partial.kind ?? d?.kind ?? 'remove',
    note: partial.note ?? d?.note ?? '',
    editingId: partial.editingId,
  };
  editorTab.value = 'marks';
}

export async function saveMark(): Promise<boolean> {
  const p = project.value;
  const d = markDraft.value;
  if (!p || !d) return false;
  const body: MarkInput = { start: round1(d.start), kind: d.kind, note: d.note.trim(), ...(d.end !== undefined && d.end > d.start ? { end: round1(d.end) } : {}) };
  try {
    if (d.editingId) {
      const m = await videoEditApi.updateMark(p.id, d.editingId, body);
      marks.value = m ? marks.value.map((x) => (x.id === m.id ? m : x)) : await videoEditApi.marks(p.id);
    } else {
      const m = await videoEditApi.createMark(p.id, body);
      marks.value = m ? [...marks.value, m] : await videoEditApi.marks(p.id);
    }
    markDraft.value = null;
    return true;
  } catch (e) { toast('Chưa lưu được góp ý', e); return false; }
}

export async function deleteMark(id: string) {
  const p = project.value;
  if (!p) return;
  const before = marks.value;
  marks.value = before.filter((m) => m.id !== id);
  if (markDraft.value?.editingId === id) markDraft.value = null;
  try { await videoEditApi.deleteMark(p.id, id); }
  catch (e) { marks.value = before; toast('Chưa xoá được góp ý', e); }
}

export async function sendMarks() {
  const p = project.value;
  if (!p) return;
  try {
    const r = await videoEditApi.sendMarks(p.id);
    if (r.project) applyProject(r.project);
    marks.value = await videoEditApi.marks(p.id);
    pushToast({ tone: 'success', title: 'Đã gửi góp ý cho agent', description: 'Agent đang sửa kế hoạch thành bản mới.', ttlMs: 5000 });
  } catch (e) { toast('Chưa gửi được góp ý', e); }
}

export async function approveAndExport() {
  await flushToggles();
  await decidePlan('approve');
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
