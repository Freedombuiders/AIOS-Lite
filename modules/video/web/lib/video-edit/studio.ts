// Video Studio state (signals) + actions. Components read the signals and call the actions;
// nothing else talks to the API. SSE per selected project, selection persisted in localStorage.
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { pushToast } from '@/lib/toasts';
import {
  errorMessage, errorStatus, eventsUrl, uploadVideo, videoEditApi,
  type DoctorResponse, type ProfileInput, type ProjectPatch,
} from './api';
import type {
  EditPlan, VideoAspect, VideoEditAgent, VideoEditEvent, VideoJob, VideoMessage, VideoProfile, VideoProject,
  VideoProjectSummary, VideoStyle,
} from './types';
import { STYLE_GROUPS } from './types';

// ── Signals ───────────────────────────────────────────────────────────────────

export type RightTab = 'ticket' | 'assets' | 'preview';
export type ProfileTab = 'info' | 'brand' | 'audio' | 'taste' | 'questions' | 'channels';
export type ComposerAsset = { kind: 'asset'; ref: string; label: string };
export type PreviewKind = 'source' | 'final';

export const profiles = signal<VideoProfile[]>([]);
export const profilesLoaded = signal(false);
export const selectedProfileId = signal<string | null>(null);
export const selectedProjectId = signal<string | null>(null);
export const projectLists = signal<Record<string, VideoProjectSummary[]>>({});

export const project = signal<VideoProject | null>(null);
export const projectLoading = signal(false);
export const messages = signal<VideoMessage[]>([]);
/** messageId -> accumulated streaming text (null project means nothing live). */
export const streamText = signal<Record<string, string>>({});
export const liveActivity = signal<Record<string, { label: string; detail?: string }[]>>({});
export const sseConnected = signal(false);
/** Video Studio › Sản xuất: the latest production state pushed on the open host project's stream. */
export const productionEvent = signal<{ production: unknown; at: number } | null>(null);
/** Background jobs of the open project, from SSE `job` events (id -> latest state). */
export const projectJobs = signal<Record<string, VideoJob>>({});
/** Last SSE `plan` event; the editor reads it to swap in a new plan version. */
export const planEvent = signal<{ plan: EditPlan; planVersion: number } | null>(null);

export const styles = signal<VideoStyle[]>([]);
export const styleGroups = signal<{ id: string; label: string }[]>([...STYLE_GROUPS]);
export const agents = signal<VideoEditAgent[]>([]);
export const defaultAgentId = signal<string>('');
export const doctor = signal<DoctorResponse | null>(null);
export const doctorLoading = signal(false);

export const rightTab = signal<RightTab>('ticket');
export const rightOpen = signal<boolean>(true);
export const leftDrawerOpen = signal(false);
export const previewKind = signal<PreviewKind>('source');

export const draftText = signal('');
export const composerAssets = signal<ComposerAsset[]>([]);
export const pendingStyleId = signal<string | null>(null);
export const pendingAspect = signal<VideoAspect | null>(null);
export const pendingAgentId = signal<string | null>(null);
export const upload = signal<{ name: string; size: number; fraction: number } | null>(null);

export const profileModal = signal<{ mode: 'create' | 'edit'; tab?: ProfileTab } | null>(null);
export const styleModal = signal(false);
export const voiceModal = signal(false);
export const doctorModal = signal(false);
export const briefModal = signal(false);
export const libraryModal = signal(false);
/** Editor view of the open project (URL: ?project=<id>&view=editor). */
export const editorOpen = signal(false);
/** Seed the composer from outside (quick-action chips). Composer focuses on change. */
export const composerFocusNonce = signal(0);
export const openFilePickerNonce = signal(0);

// ── Selection persistence ─────────────────────────────────────────────────────

const SELECTION_KEY = 'freedomos.video-studio.selection';

function readSelection(): { profileId: string | null; projectId: string | null } {
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    if (raw) {
      const v = JSON.parse(raw) as { profileId?: unknown; projectId?: unknown };
      return {
        profileId: typeof v.profileId === 'string' ? v.profileId : null,
        projectId: typeof v.projectId === 'string' ? v.projectId : null,
      };
    }
  } catch { /* storage unavailable or corrupt */ }
  return { profileId: null, projectId: null };
}

function persistSelection() {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify({
      profileId: selectedProfileId.value, projectId: selectedProjectId.value,
    }));
  } catch { /* in-memory only */ }
}

// ── Editor route state (URL query, so a reload keeps the view) ────────────────

/** The project id in the URL when the editor view is requested, else null. */
export function editorProjectFromUrl(): string | null {
  const q = new URLSearchParams(window.location.search);
  return q.get('view') === 'editor' ? q.get('project') : null;
}

function writeEditorUrl(projectId: string | null, mode: 'push' | 'replace' = 'push') {
  const url = new URL(window.location.href);
  if (projectId) { url.searchParams.set('project', projectId); url.searchParams.set('view', 'editor'); }
  else { url.searchParams.delete('project'); url.searchParams.delete('view'); }
  if (url.href === window.location.href) return;
  if (mode === 'push') window.history.pushState(window.history.state, '', url);
  else window.history.replaceState(window.history.state, '', url);
}

export function openEditor() {
  const p = project.value;
  if (!p?.plan) return;
  editorOpen.value = true;
  writeEditorUrl(p.id);
}

export function closeEditor(mode: 'push' | 'replace' = 'push') {
  if (!editorOpen.value && !editorProjectFromUrl()) return;
  editorOpen.value = false;
  writeEditorUrl(null, mode);
}

/** Called once the profiles are loaded (and on browser back/forward) to follow the URL. */
export async function restoreEditorFromUrl() {
  const wanted = editorProjectFromUrl();
  if (!wanted) { editorOpen.value = false; return; }
  if (selectedProjectId.value !== wanted) await selectProject(wanted);
  if (selectedProjectId.value === wanted && project.value?.plan) editorOpen.value = true;
  else closeEditor('replace');
}

// ── Derived helpers ───────────────────────────────────────────────────────────

export function currentProfile(): VideoProfile | null {
  return profiles.value.find((p) => p.id === selectedProfileId.value) ?? null;
}

export function styleById(id: string | undefined | null): VideoStyle | undefined {
  return id ? styles.value.find((s) => s.id === id) : undefined;
}

export function agentById(id: string | undefined | null): VideoEditAgent | undefined {
  return id ? agents.value.find((a) => a.id === id) : undefined;
}

export function activeStyleId(): string | null {
  return project.value ? project.value.styleId ?? null : pendingStyleId.value;
}

export function activeAgentId(): string {
  return project.value?.agentId ?? pendingAgentId.value ?? defaultAgentId.value;
}

export function activeAspect(): VideoAspect {
  return project.value?.aspect ?? pendingAspect.value ?? currentProfile()?.defaultAspect ?? '9:16';
}

function warn(title: string, e: unknown) {
  pushToast({ tone: errorStatus(e) === 501 ? 'warn' : 'error', title, description: errorMessage(e), ttlMs: 6000 });
}

// ── Catalog loading ───────────────────────────────────────────────────────────

let bootstrapped = false;

export async function bootstrap() {
  if (!bootstrapped) {
    bootstrapped = true;
    void videoEditApi.styles().then((r) => {
      styles.value = r.styles;
      if (r.groups?.length) styleGroups.value = r.groups;
    }).catch((e) => warn('Không tải được danh sách phong cách', e));
    void videoEditApi.agents().then((r) => { agents.value = r.agents; defaultAgentId.value = r.defaultAgentId; })
      .catch((e) => warn('Không tải được danh sách agent', e));
    void refreshDoctor();
  }
  await loadProfiles(true);
}

export async function refreshDoctor() {
  doctorLoading.value = true;
  try { doctor.value = await videoEditApi.doctor(); }
  catch (e) { warn('Không kiểm tra được máy', e); }
  finally { doctorLoading.value = false; }
}

export async function loadProfiles(restore = false) {
  try {
    const { profiles: list } = await videoEditApi.profiles();
    profiles.value = list;
    if (restore) {
      const saved = readSelection();
      const profile = list.find((p) => p.id === saved.profileId) ?? list[0] ?? null;
      selectedProfileId.value = profile?.id ?? null;
      if (profile) {
        await refreshProjects(profile.id);
        const wanted = saved.profileId === profile.id ? saved.projectId : null;
        if (wanted && projectLists.value[profile.id]?.some((p) => p.id === wanted)) await selectProject(wanted);
      }
    } else if (selectedProfileId.value && !list.some((p) => p.id === selectedProfileId.value)) {
      selectedProfileId.value = list[0]?.id ?? null;
      selectedProjectId.value = null;
      resetProject();
    }
  } catch (e) {
    warn('Không tải được hồ sơ kênh', e);
  } finally {
    profilesLoaded.value = true;
  }
}

export async function refreshProjects(profileId: string) {
  try {
    const { projects } = await videoEditApi.projects(profileId);
    projectLists.value = { ...projectLists.value, [profileId]: projects };
  } catch (e) { warn('Không tải được danh sách việc', e); }
}

// ── Selection ─────────────────────────────────────────────────────────────────

function resetProject() {
  project.value = null;
  messages.value = [];
  streamText.value = {};
  liveActivity.value = {};
  projectJobs.value = {};
  planEvent.value = null;
  previewKind.value = 'source';
}

export async function selectProfile(id: string) {
  if (selectedProfileId.value !== id) {
    selectedProfileId.value = id;
    selectedProjectId.value = null;
    resetProject();
    pendingAspect.value = null;
    persistSelection();
  }
  await refreshProjects(id);
}

export function newJob() {
  closeEditor();
  selectedProjectId.value = null;
  resetProject();
  draftText.value = '';
  composerAssets.value = [];
  persistSelection();
  composerFocusNonce.value++;
}

export async function selectProject(id: string) {
  if (selectedProjectId.value !== id) editorOpen.value = false;
  selectedProjectId.value = id;
  resetProject();
  persistSelection();
  projectLoading.value = true;
  try {
    const r = await videoEditApi.project(id);
    if (selectedProjectId.value !== id) return;
    project.value = r.project;
    messages.value = r.messages;
    if (selectedProfileId.value !== r.project.profileId) {
      selectedProfileId.value = r.project.profileId;
      void refreshProjects(r.project.profileId);
    }
    persistSelection();
  } catch (e) {
    if (selectedProjectId.value === id) {
      selectedProjectId.value = null;
      persistSelection();
      warn('Không mở được việc này', e);
    }
  } finally {
    if (selectedProjectId.value === id) projectLoading.value = false;
  }
}

// ── Project mutations ─────────────────────────────────────────────────────────

function toSummary(p: VideoProject): VideoProjectSummary {
  return {
    id: p.id, code: p.code, profileId: p.profileId, title: p.title, status: p.status, styleId: p.styleId,
    aspect: p.aspect, busy: p.busy, createdAt: p.createdAt, updatedAt: p.updatedAt,
    hasSource: !!p.source, durationSec: p.source?.durationSec,
  };
}

function syncSummary(p: VideoProject) {
  const list = projectLists.value[p.profileId];
  if (!list) return;
  const next = toSummary(p);
  const exists = list.some((x) => x.id === p.id);
  projectLists.value = {
    ...projectLists.value,
    [p.profileId]: exists ? list.map((x) => (x.id === p.id ? next : x)) : [next, ...list],
  };
}

export function applyProject(p: VideoProject) {
  if (selectedProjectId.value === p.id) {
    const wasBusy = project.value?.busy ?? false;
    project.value = p;
    if (wasBusy && !p.busy) void refetchProject(p.id);
  }
  syncSummary(p);
}

/** After a turn ends the transcript on disk is the truth: drop live state and reload it. */
async function refetchProject(id: string) {
  try {
    const r = await videoEditApi.project(id);
    if (selectedProjectId.value !== id) return;
    project.value = r.project;
    messages.value = r.messages;
    streamText.value = {};
    liveActivity.value = {};
    syncSummary(r.project);
  } catch { /* the SSE stream keeps state usable */ }
}

export async function createProject(opts: { title?: string } = {}): Promise<VideoProject | null> {
  const profile = currentProfile();
  if (!profile) { profileModal.value = { mode: 'create' }; return null; }
  try {
    const { project: p } = await videoEditApi.createProject({
      profileId: profile.id,
      ...(opts.title ? { title: opts.title } : {}),
      ...(pendingStyleId.value ? { styleId: pendingStyleId.value } : profile.defaultStyleId ? { styleId: profile.defaultStyleId } : {}),
      aspect: pendingAspect.value ?? profile.defaultAspect,
      ...((pendingAgentId.value ?? defaultAgentId.value) ? { agentId: pendingAgentId.value ?? defaultAgentId.value } : {}),
    });
    selectedProjectId.value = p.id;
    resetProject();
    project.value = p;
    pendingStyleId.value = null;
    syncSummary(p);
    if (!projectLists.value[p.profileId]) await refreshProjects(p.profileId);
    persistSelection();
    return p;
  } catch (e) {
    warn('Không tạo được việc mới', e);
    return null;
  }
}

export async function patchProject(patch: ProjectPatch) {
  const p = project.value;
  if (!p) return;
  try {
    const r = await videoEditApi.updateProject(p.id, patch);
    applyProject(r.project);
  } catch (e) { warn('Không lưu được thay đổi', e); }
}

export async function renameProject(id: string, title: string) {
  const clean = title.trim();
  if (!clean) return;
  try {
    const r = await videoEditApi.updateProject(id, { title: clean });
    applyProject(r.project);
  } catch (e) { warn('Không đổi được tên', e); }
}

export async function deleteProject(id: string) {
  try {
    await videoEditApi.deleteProject(id);
    const profileId = Object.keys(projectLists.value).find((k) => projectLists.value[k]?.some((p) => p.id === id));
    if (profileId) {
      projectLists.value = { ...projectLists.value, [profileId]: projectLists.value[profileId].filter((p) => p.id !== id) };
    }
    if (selectedProjectId.value === id) newJob();
    void loadProfiles(false);
  } catch (e) { warn('Không xoá được việc', e); }
}

// ── Style picking ─────────────────────────────────────────────────────────────

export async function chooseStyle(styleId: string | null) {
  if (project.value) {
    await patchProject({ styleId });
    // A style with an information form asks for it right away (dismissible).
    if (styleId && styleById(styleId)?.brief?.length) briefModal.value = true;
  } else pendingStyleId.value = styleId;
}

// ── Messages ──────────────────────────────────────────────────────────────────

export function addAsset(a: ComposerAsset) {
  if (composerAssets.value.some((x) => x.ref === a.ref)) return;
  composerAssets.value = [...composerAssets.value, a];
  composerFocusNonce.value++;
}

export function removeAsset(ref: string) {
  composerAssets.value = composerAssets.value.filter((x) => x.ref !== ref);
}

function upsertMessage(m: VideoMessage) {
  const list = messages.value;
  messages.value = list.some((x) => x.id === m.id)
    ? list.map((x) => (x.id === m.id ? { ...x, ...m } : x))
    : [...list, m];
}

export async function sendMessage(text: string): Promise<boolean> {
  const clean = text.trim();
  if (!clean) return false;
  if (!currentProfile()) { profileModal.value = { mode: 'create' }; return false; }
  let p = project.value;
  if (!p) p = await createProject({ title: clean.replace(/\s+/g, ' ').slice(0, 60) });
  if (!p) return false;
  const command = clean.startsWith('/') ? clean.split(/\s/)[0].toLowerCase() : '';
  const fromCommand = command ? styles.value.find((s) => s.command.toLowerCase() === command) : undefined;
  try {
    const r = await videoEditApi.sendMessage(p.id, {
      text: clean,
      ...(fromCommand ? { styleId: fromCommand.id } : {}),
      ...(composerAssets.value.length ? { attachments: composerAssets.value } : {}),
    });
    if (selectedProjectId.value === p.id) {
      upsertMessage(r.message);
      streamText.value = { ...streamText.value, [r.agentMessageId]: '' };
      if (project.value) project.value = { ...project.value, busy: true };
    }
    composerAssets.value = [];
    draftText.value = '';
    // Choosing a style by slash command also offers its information form (once, dismissible).
    if (fromCommand?.brief?.length && !p.brief) briefModal.value = true;
    return true;
  } catch (e) {
    warn(errorStatus(e) === 409 ? 'Agent đang bận' : 'Không gửi được tin nhắn', e);
    return false;
  }
}

export async function abortTurn() {
  const p = project.value;
  if (!p) return;
  try { await videoEditApi.abort(p.id); } catch (e) { warn('Không dừng được lượt này', e); }
}

export async function decidePlan(action: 'approve' | 'revise' | 'reject', note?: string) {
  const p = project.value;
  if (!p) return;
  try {
    const r = await videoEditApi.decidePlan(p.id, action, note);
    if (r.project) applyProject(r.project);
  } catch (e) { warn('Chưa xử lý được kế hoạch', e); }
}

// ── Upload ────────────────────────────────────────────────────────────────────

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mpg|mpeg|3gp)$/i;
let pendingFile: File | null = null;

/** Called after a profile is created from the empty state so the dropped file isn't lost. */
export function resumePendingUpload() {
  const f = pendingFile;
  pendingFile = null;
  if (f) void uploadFile(f);
}

export function dropPendingUpload() { pendingFile = null; }

export async function uploadFile(file: File) {
  if (!file.type.startsWith('video/') && !VIDEO_EXT.test(file.name)) {
    pushToast({ tone: 'error', title: 'Chỉ nhận file video', description: file.name });
    return false;
  }
  if (upload.value) { pushToast({ tone: 'warn', title: 'Đang tải một video lên, đợi xong nhé.' }); return false; }
  if (!currentProfile()) {
    pendingFile = file;
    profileModal.value = { mode: 'create' };
    return false;
  }
  let p = project.value;
  if (!p) p = await createProject({ title: file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Video mới' });
  if (!p) return false;
  const id = p.id;
  upload.value = { name: file.name, size: file.size, fraction: 0 };
  try {
    const updated = await uploadVideo(id, file, (fraction) => {
      if (upload.value) upload.value = { ...upload.value, fraction };
    });
    applyProject(updated);
    if (selectedProjectId.value === id) rightTab.value = 'ticket';
    return true;
  } catch (e) {
    pushToast({ tone: 'error', title: 'Tải video lên thất bại', description: errorMessage(e), ttlMs: 7000 });
    return false;
  } finally {
    upload.value = null;
  }
}

// ── Profiles ──────────────────────────────────────────────────────────────────

export async function createProfile(input: Parameters<typeof videoEditApi.createProfile>[0], extra?: ProfileInput): Promise<VideoProfile | null> {
  try {
    let { profile } = await videoEditApi.createProfile(input);
    if (extra && Object.keys(extra).length) ({ profile } = await videoEditApi.updateProfile(profile.id, extra));
    profiles.value = [...profiles.value, profile];
    await selectProfile(profile.id);
    return profile;
  } catch (e) {
    warn('Không tạo được hồ sơ kênh', e);
    return null;
  }
}

export async function saveProfile(id: string, patch: ProfileInput): Promise<boolean> {
  try {
    const { profile } = await videoEditApi.updateProfile(id, patch);
    profiles.value = profiles.value.map((p) => (p.id === id ? { ...p, ...profile } : p));
    return true;
  } catch (e) { warn('Không lưu được hồ sơ', e); return false; }
}

export async function deleteProfile(id: string): Promise<string | null> {
  try {
    await videoEditApi.deleteProfile(id);
    profiles.value = profiles.value.filter((p) => p.id !== id);
    if (selectedProfileId.value === id) {
      selectedProfileId.value = profiles.value[0]?.id ?? null;
      selectedProjectId.value = null;
      resetProject();
      persistSelection();
      if (selectedProfileId.value) void refreshProjects(selectedProfileId.value);
    }
    return null;
  } catch (e) { return errorMessage(e); }
}

// ── SSE ───────────────────────────────────────────────────────────────────────

function handleEvent(projectId: string, ev: VideoEditEvent) {
  if (selectedProjectId.value !== projectId) return;
  switch (ev.type) {
    case 'project': applyProject(ev.project); break;
    case 'message':
      upsertMessage(ev.message);
      if (ev.message.role === 'agent' && (ev.message.text || ev.message.durationMs !== undefined)) {
        const { [ev.message.id]: _drop, ...rest } = streamText.value;
        streamText.value = rest;
      }
      break;
    case 'message_delta': streamText.value = { ...streamText.value, [ev.messageId]: ev.text }; break;
    case 'activity':
      liveActivity.value = {
        ...liveActivity.value,
        [ev.messageId]: [...(liveActivity.value[ev.messageId] ?? []), { label: ev.label, detail: ev.detail }],
      };
      break;
    case 'step':
      if (project.value) {
        project.value = { ...project.value, steps: project.value.steps.map((s) => (s.key === ev.step.key ? ev.step : s)) };
      }
      break;
    case 'plan':
      planEvent.value = { plan: ev.plan, planVersion: ev.planVersion };
      if (project.value) project.value = { ...project.value, plan: ev.plan, planVersion: ev.planVersion };
      break;
    case 'job':
      if (ev.job.projectId === projectId) projectJobs.value = { ...projectJobs.value, [ev.job.id]: ev.job };
      break;
    case 'production':
      productionEvent.value = { production: ev.production, at: Date.now() };
      break;
  }
}

/** Opens the project event stream; returns a closer. Reconnects after 5s on error. */
export function openProjectStream(projectId: string): () => void {
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const connect = () => {
    if (closed) return;
    es = new EventSource(eventsUrl(projectId));
    es.onopen = () => { sseConnected.value = true; };
    es.onmessage = (m) => {
      try {
        const data = JSON.parse(m.data) as VideoEditEvent;
        if ((data as { type: string }).type === 'ping') return;
        handleEvent(projectId, data);
      } catch { /* ignore malformed frame */ }
    };
    es.onerror = () => {
      sseConnected.value = false;
      es?.close();
      es = null;
      if (!closed) timer = setTimeout(connect, 5000);
    };
  };
  connect();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    es?.close();
    sseConnected.value = false;
  };
}

// ── Layout hook ───────────────────────────────────────────────────────────────
// Breakpoints follow the studio's own width (the app sidebar and chat dock take space from
// the viewport): wide = 3 columns, mid = right panel becomes a sheet, narrow = left column is a drawer.

export type StudioLayout = 'wide' | 'mid' | 'narrow';

function layoutFor(width: number): StudioLayout {
  return width >= 1040 ? 'wide' : width >= 720 ? 'mid' : 'narrow';
}

export function useStudioLayout(ref: { current: HTMLElement | null }): StudioLayout {
  const [layout, setLayout] = useState<StudioLayout>(() => layoutFor(typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setLayout(layoutFor(el.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return layout;
}
