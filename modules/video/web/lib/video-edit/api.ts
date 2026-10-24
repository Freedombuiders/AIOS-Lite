// Typed wrappers for /api/m/video/edit/*. Contract: ./types.ts. Architecture: docs/plans/video-studio-edit.md §8.
import { ApiError, apiDelete, apiFetch, apiGet, apiPatch, apiPost, apiPut, tokenizedSseUrl } from '@/lib/api';
import type {
  AnalysisResult, DoctorCheck, EditPlan, MarkKind, QuickFeedback, Transcript, VideoAspect, VideoAsset,
  VideoEditAgent, VideoMark, VideoMessage, VideoPlatform, VideoProfile, VideoProject, VideoProjectSummary,
  VideoStyle, StepKey, AssetKind, StyleGroup,
} from './types';

const BASE = '/api/m/video/edit';

export interface DoctorResponse { checks: DoctorCheck[]; ok: number; total: number; requiredOk: boolean }
export interface VoiceResponse { configured: boolean; provider: string | null; voices: { id: string; name: string }[] }
export interface AssetsResponse { kinds: { kind: AssetKind; label: string; count: number }[]; assets: VideoAsset[] }
export interface BrainChoicesResponse { enabled: boolean; activeVaultId: string; vaults: { id: string; name: string }[] }
export type MediaKind =
  | 'source' | 'thumb' | 'final' | 'proxy' | 'master' | 'cover-1' | 'cover-2' | 'cover-3'
  | `final-v${number}` | `frame/${string}`;
export type PlanStatus = NonNullable<VideoProject['planStatus']>;
export interface PlanResponse { plan: EditPlan; planVersion: number; planStatus?: PlanStatus }
/** Body of PATCH /projects/:id/plan (docs/plans/video-studio-phase1.md, Agent A). */
export interface PlanPatch {
  toggleWords?: number[];
  cutWords?: number[];
  gapMs?: number;
  hookChosen?: string;
  brolls?: { id: string; enabled: boolean }[];
  captions?: Partial<EditPlan['captions']>;
  meta?: Partial<EditPlan['meta']>;
}
export interface MarkInput { start: number; end?: number; kind: MarkKind; note: string }
export type BriefValues = Record<string, string | string[]>;

export type ProfileInput = Partial<Omit<VideoProfile, 'id' | 'slug' | 'createdAt' | 'updatedAt' | 'projectCount' | 'defaultStyleId' | 'brainVaultId'>> & {
  defaultStyleId?: string | null;
  brainVaultId?: string | null;
};
export interface ProjectPatch {
  directorProvider?: VideoProject['directorProvider'] | null;
  title?: string;
  styleId?: string | null;
  aspect?: VideoAspect;
  agentId?: string;
  targetSeconds?: number | null;
  /** 1..3 after delivery. Needs the PATCH /projects/:id schema to accept it (contract change). */
  chosenCover?: number;
}

/** The server's `error` text when there is one, else the thrown message. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { error?: unknown } | null;
    if (body && typeof body === 'object' && typeof body.error === 'string' && body.error) return body.error;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export function errorStatus(e: unknown): number | null {
  return e instanceof ApiError ? e.status : null;
}

export const videoEditApi = {
  doctor: () => apiGet<DoctorResponse>(`${BASE}/doctor`),
  agents: () => apiGet<{ agents: VideoEditAgent[]; defaultAgentId: string }>(`${BASE}/agents`),
  styles: () => apiGet<{ groups: { id: StyleGroup; label: string }[]; styles: VideoStyle[] }>(`${BASE}/styles`),
  brains: () => apiGet<BrainChoicesResponse>(`${BASE}/brains`),
  assets: (params: { kind?: AssetKind | ''; q?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.kind) qs.set('kind', params.kind);
    if (params.q?.trim()) qs.set('q', params.q.trim());
    const s = qs.toString();
    return apiGet<AssetsResponse>(`${BASE}/assets${s ? `?${s}` : ''}`);
  },

  profiles: () => apiGet<{ profiles: VideoProfile[] }>(`${BASE}/profiles`),
  createProfile: (input: { name: string; handle?: string; platform?: VideoPlatform; defaultAspect?: VideoAspect; defaultStyleId?: string; color?: string; starter?: VideoProfile['starter'] }) =>
    apiPost<{ profile: VideoProfile }>(`${BASE}/profiles`, input),
  updateProfile: (id: string, patch: ProfileInput) =>
    apiPatch<{ profile: VideoProfile }>(`${BASE}/profiles/${encodeURIComponent(id)}`, patch),
  deleteProfile: (id: string) => apiDelete<{ ok: boolean }>(`${BASE}/profiles/${encodeURIComponent(id)}`),

  projects: (profileId: string) =>
    apiGet<{ projects: VideoProjectSummary[] }>(`${BASE}/projects?profileId=${encodeURIComponent(profileId)}`),
  createProject: (input: { profileId: string; title?: string; styleId?: string; aspect?: VideoAspect; agentId?: string }) =>
    apiPost<{ project: VideoProject }>(`${BASE}/projects`, input),
  project: (id: string) =>
    apiGet<{ project: VideoProject; messages: VideoMessage[] }>(`${BASE}/projects/${encodeURIComponent(id)}`),
  updateProject: (id: string, patch: ProjectPatch) =>
    apiPatch<{ project: VideoProject }>(`${BASE}/projects/${encodeURIComponent(id)}`, patch),
  deleteProject: (id: string) => apiDelete<{ ok: boolean }>(`${BASE}/projects/${encodeURIComponent(id)}`),

  sendMessage: (id: string, body: { text: string; styleId?: string; attachments?: { kind: 'video' | 'asset'; ref: string; label: string }[] }) =>
    apiPost<{ message: VideoMessage; agentMessageId: string }>(`${BASE}/projects/${encodeURIComponent(id)}/messages`, body),
  abort: (id: string) => apiPost<{ ok: boolean }>(`${BASE}/projects/${encodeURIComponent(id)}/abort`),
  runStep: (id: string, step: StepKey) =>
    apiPost<{ ok: boolean }>(`${BASE}/projects/${encodeURIComponent(id)}/run`, { step }),
  decidePlan: (id: string, action: 'approve' | 'revise' | 'reject', note?: string) =>
    apiPost<{ project?: VideoProject; ok?: boolean }>(`${BASE}/projects/${encodeURIComponent(id)}/plan/decide`, { action, ...(note ? { note } : {}) }),

  // ── Phase 1: editor ──
  // Response shapes beyond the documented ones are read tolerantly (see unwrap) so a small
  // difference in the backend (`{marks}` vs bare array, `{brief}` vs bare object) does not break the UI.
  transcript: async (id: string): Promise<Transcript> =>
    unwrap<Transcript>(await apiGet<unknown>(`${BASE}/projects/${encodeURIComponent(id)}/transcript`), 'transcript'),
  analysis: async (id: string): Promise<AnalysisResult> =>
    unwrap<AnalysisResult>(await apiGet<unknown>(`${BASE}/projects/${encodeURIComponent(id)}/analysis`), 'analysis'),
  plan: (id: string, version?: number) =>
    apiGet<PlanResponse>(`${BASE}/projects/${encodeURIComponent(id)}/plan${version ? `?version=${version}` : ''}`),
  patchPlan: (id: string, body: PlanPatch) =>
    apiPatch<{ plan: EditPlan; project: VideoProject }>(`${BASE}/projects/${encodeURIComponent(id)}/plan`, body),
  planDiff: (id: string, from: number, to: number) =>
    apiGet<{ changes: string[] }>(`${BASE}/projects/${encodeURIComponent(id)}/plan/diff?from=${from}&to=${to}`),
  render: (id: string) => apiPost<{ ok?: boolean; job?: unknown }>(`${BASE}/projects/${encodeURIComponent(id)}/render`),

  marks: async (id: string): Promise<VideoMark[]> => {
    const r = await apiGet<unknown>(`${BASE}/projects/${encodeURIComponent(id)}/marks`);
    return Array.isArray(r) ? (r as VideoMark[]) : ((r as { marks?: VideoMark[] }).marks ?? []);
  },
  createMark: async (id: string, body: MarkInput): Promise<VideoMark | null> =>
    markOf(await apiPost<unknown>(`${BASE}/projects/${encodeURIComponent(id)}/marks`, body)),
  updateMark: async (id: string, markId: string, body: Partial<MarkInput>): Promise<VideoMark | null> =>
    markOf(await apiPatch<unknown>(`${BASE}/projects/${encodeURIComponent(id)}/marks/${encodeURIComponent(markId)}`, body)),
  deleteMark: (id: string, markId: string) =>
    apiDelete<{ ok?: boolean }>(`${BASE}/projects/${encodeURIComponent(id)}/marks/${encodeURIComponent(markId)}`),
  sendMarks: (id: string) =>
    apiPost<{ ok?: boolean; project?: VideoProject }>(`${BASE}/projects/${encodeURIComponent(id)}/marks/send`),

  brief: async (id: string): Promise<BriefValues> => {
    const r = await apiGet<unknown>(`${BASE}/projects/${encodeURIComponent(id)}/brief`);
    return unwrap<BriefValues>(r, 'brief') ?? {};
  },
  saveBrief: (id: string, brief: BriefValues) =>
    apiPut<unknown>(`${BASE}/projects/${encodeURIComponent(id)}/brief`, { brief }),
  feedback: (id: string, quick: QuickFeedback, note?: string) =>
    apiPost<{ ok?: boolean }>(`${BASE}/projects/${encodeURIComponent(id)}/feedback`, { quick, ...(note ? { note } : {}) }),

  voice: () => apiGet<VoiceResponse>(`${BASE}/voice`),
  tts: (body: { text: string; voiceId?: string }) => apiPost<{ url?: string }>(`${BASE}/voice/tts`, body),
};

function unwrap<T>(r: unknown, key: string): T {
  if (r && typeof r === 'object' && key in (r as Record<string, unknown>)) return (r as Record<string, T>)[key];
  return r as T;
}

function markOf(r: unknown): VideoMark | null {
  if (r && typeof r === 'object' && 'mark' in r) return (r as { mark: VideoMark }).mark;
  return r && typeof r === 'object' && 'id' in r ? (r as VideoMark) : null;
}

/** Raw-file upload into the asset library (POST /assets/upload?kind=, header x-file-name). */
export async function uploadLibraryAsset(file: File, kind: AssetKind): Promise<VideoAsset | null> {
  const res = await apiFetch(`${BASE}/assets/upload?kind=${encodeURIComponent(kind)}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
    body: file,
  });
  const body = (await res.json().catch(() => null)) as { asset?: VideoAsset } | VideoAsset | null;
  if (body && 'asset' in body) return body.asset ?? null;
  return body && 'id' in body ? body : null;
}

/** Composition for <hyperframes-player>; `v` = plan version (cache key and the version to build). */
export function previewUrl(projectId: string, planVersion: number, nonce = 0): string {
  const n = nonce ? `&r=${nonce}` : '';
  return tokenizedSseUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/composition/preview.html?v=${planVersion}${n}`);
}

/** Authenticated URL for <video>/<img>; `version` busts the cache when a render changes. */
export function mediaUrl(projectId: string, kind: MediaKind, version?: string | number): string {
  const v = version !== undefined ? `?v=${encodeURIComponent(String(version))}` : '';
  return tokenizedSseUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/media/${kind}${v}`);
}

export function eventsUrl(projectId: string): string {
  return tokenizedSseUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/events`);
}

/** Raw-file upload with progress (fetch has no upload progress). Token handling matches lib/api.ts. */
export function uploadVideo(projectId: string, file: File, onProgress?: (fraction: number) => void): Promise<VideoProject> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', tokenizedSseUrl(`${BASE}/projects/${encodeURIComponent(projectId)}/upload`));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total); };
    xhr.onerror = () => reject(new Error('Không tải được video lên (lỗi mạng).'));
    xhr.onabort = () => reject(new Error('Đã huỷ tải lên.'));
    xhr.onload = () => {
      let body: unknown = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* non-JSON error page */ }
      if (xhr.status >= 200 && xhr.status < 300 && body && typeof body === 'object' && 'project' in body) {
        onProgress?.(1);
        resolve((body as { project: VideoProject }).project);
        return;
      }
      const text = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `Tải lên thất bại (${xhr.status}).`;
      reject(new ApiError(xhr.status, body ?? {}, text));
    };
    xhr.send(file);
  });
}
