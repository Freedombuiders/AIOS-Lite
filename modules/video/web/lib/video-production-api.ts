/** Video Studio › Sản xuất: API calls (types and pure helpers live in video-production.ts). */

import { apiDelete, apiGet, apiPatch, apiPost, apiPut, ApiError, tokenizedSseUrl } from '@/lib/api';

export interface ApprovalDto { id: string; kind: string; status: string; title: string; summary: string; createdAt: number | string; decidedAt?: number | string | null; error?: string | null; result?: unknown }
import type { CastMember, CostEstimate, EngineStatus, HeygenVoice, KolBrand, KolVoice, Production, ProductionScene, ProductionSummary, SceneKind, VideoAspect } from './video-production';

const BASE = '/api/m/video/edit';
const enc = encodeURIComponent;

export const productionApi = {
  engines: () => apiGet<{ engines: EngineStatus[] }>(`${BASE}/production/engines`),
  cast: () => apiGet<{ cast: CastMember[] }>(`${BASE}/production/cast`),
  setVoice: (kolId: string, voice: { voiceId: string; name: string } | null) =>
    apiPut<{ voice: KolVoice | null }>(`${BASE}/production/cast/${enc(kolId)}/voice`, voice ?? { voiceId: null }),
  /** scope 'all': the workspace's own voices plus HeyGen's voices in the language. */
  heygenVoices: (opts: { language?: string; scope?: 'all' } = {}) => {
    const q = new URLSearchParams();
    if (opts.language) q.set('language', opts.language);
    if (opts.scope) q.set('scope', opts.scope);
    return apiGet<{ configured: boolean; voices: HeygenVoice[] }>(`${BASE}/production/heygen/voices${q.size ? `?${q}` : ''}`);
  },
  list: () => apiGet<{ productions: ProductionSummary[] }>(`${BASE}/productions`),
  get: (id: string) => apiGet<{ production: Production }>(`${BASE}/productions/${enc(id)}`),
  create: (body: { brief: string; cast: string[]; aspect: VideoAspect; targetSec: number; agent?: boolean }) =>
    apiPost<{ production: Production; warning?: string; agent?: boolean }>(`${BASE}/productions`, body),
  series: (body: { brief: string; cast: string[]; count: number; aspect: VideoAspect; targetSec: number }) =>
    apiPost<{ series: { id: string; title: string }; productions: Production[] }>(`${BASE}/productions/series`, body),
  setBrand: (kolId: string, brand: Partial<KolBrand>) => apiPut<{ brand: KolBrand }>(`${BASE}/production/cast/${enc(kolId)}/brand`, brand),
  estimate: (id: string, sceneIds?: string[]) =>
    apiGet<{ estimate: CostEstimate }>(`${BASE}/productions/${enc(id)}/estimate${sceneIds?.length ? `?sceneIds=${sceneIds.map(enc).join(',')}` : ''}`),
  footage: () => apiGet<{ projects: { id: string; title: string; updatedAt: string; status: string; hasSource: boolean; mode?: string }[] }>(`${BASE}/projects`),
  publish: (projectId: string, body: { personaId?: string; version?: number } = {}) =>
    apiPost<{ postId: string; assetId: string; personaId: string; version: number; link: string; reused: boolean }>(`${BASE}/projects/${enc(projectId)}/publish`, body),
  approval: (approvalId: string) => apiGet<{ approval: ApprovalDto }>(`/api/m/video/approvals/${enc(approvalId)}`),
  decide: (approvalId: string, actionId: 'approve' | 'reject') => apiPost<{ approval: ApprovalDto }>(`/api/m/video/approvals/${enc(approvalId)}/decide`, { actionId }),
  patch: (id: string, body: Partial<Pick<Production, 'title' | 'brief' | 'cast' | 'aspect' | 'targetSec'>>) =>
    apiPatch<{ production: Production }>(`${BASE}/productions/${enc(id)}`, body),
  remove: (id: string) => apiDelete<{ ok: true }>(`${BASE}/productions/${enc(id)}`),
  write: (id: string) => apiPost<{ production: Production }>(`${BASE}/productions/${enc(id)}/write`),
  addScene: (id: string, scene: Partial<Omit<ProductionScene, 'id' | 'status' | 'job' | 'output' | 'error' | 'updatedAt' | 'problem'>> & { kind: SceneKind; at?: number }) =>
    apiPost<{ production: Production }>(`${BASE}/productions/${enc(id)}/scenes`, scene),
  patchScene: (id: string, sceneId: string, patch: Partial<Pick<ProductionScene, 'kind' | 'kolId' | 'text' | 'visual' | 'engine' | 'model' | 'sourceAssetId' | 'clipAssetId' | 'durationSec'>>) =>
    apiPatch<{ production: Production }>(`${BASE}/productions/${enc(id)}/scenes/${enc(sceneId)}`, patch),
  /** Re-trims a finished take (free, never regenerates). */
  trimScene: (id: string, sceneId: string, body: { start?: number; durationSec?: number }) =>
    apiPost<{ production: Production }>(`${BASE}/productions/${enc(id)}/scenes/${enc(sceneId)}/trim`, body),
  moveScene: (id: string, sceneId: string, to: number) => apiPost<{ production: Production }>(`${BASE}/productions/${enc(id)}/scenes/${enc(sceneId)}/move`, { to }),
  removeScene: (id: string, sceneId: string) => apiDelete<{ production: Production }>(`${BASE}/productions/${enc(id)}/scenes/${enc(sceneId)}`),
  /** Raises the owner's spend-approval card; never generates by itself. */
  generate: (id: string, sceneIds?: string[]) =>
    apiPost<{ production: Production; approvalId: string; estimate: CostEstimate }>(`${BASE}/productions/${enc(id)}/generate`, sceneIds ? { sceneIds } : {}),
  /** Stops automatic retries after a provider overload (waiting scenes become failed). */
  stopRetries: (id: string) => apiPost<{ production: Production }>(`${BASE}/productions/${enc(id)}/stop-retries`),
  finish: (id: string) => apiPost<{ production: Production }>(`${BASE}/productions/${enc(id)}/finish`),
  eventsUrl: (id: string) => tokenizedSseUrl(`${BASE}/productions/${enc(id)}/events`),
  sceneMedia: (id: string, sceneId: string, kind: 'video' | 'thumb', stamp = '') =>
    tokenizedSseUrl(`${BASE}/productions/${enc(id)}/scenes/${enc(sceneId)}/${kind}${stamp ? `?v=${enc(stamp)}` : ''}`),
};

export function errorText(e: unknown): string {
  if (e instanceof ApiError && e.body && typeof e.body === 'object' && 'error' in e.body) return String((e.body as { error: unknown }).error);
  return e instanceof Error ? e.message : String(e);
}
