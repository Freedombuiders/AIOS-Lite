// Typed wrappers for the Dựng nhanh endpoints (/api/m/video/edit/templates*, /projects/:id/ai-edit).
// Contract: docs/dung-nhanh-gd1-plan.md › Hợp đồng dữ liệu. TemplateSummary mirrors
// server/edit/templates/types.ts (the web types.ts copy only carries server/edit/types.ts).
import { apiGet, apiPost, tokenizedSseUrl } from '@/lib/api';
import type { QuickSettings, VideoAspect, VideoJob, VideoProject } from './types';

const BASE = '/api/m/video/edit';

export interface TemplateSummary {
  id: string; name: string; description: string; tags: string[]; tier: 'free' | 'pro';
  installed: boolean; legacy: boolean; posterUrl?: string; previewUrl?: string;
  /** Draws the card when there is no poster. */
  sample?: { kicker?: string; title: string; font: string; color: string; tone: string };
}

export interface TemplatesResponse {
  templates: TemplateSummary[];
  /** Broken packs found by the registry (shown to the owner, never fatal). */
  problems?: { id: string; error: string }[];
}

/** Body of POST /projects/:id/ai-edit: the project's `quick` settings without `startedAt`. */
export type AiEditBody = Omit<QuickSettings, 'startedAt'>;
export interface AiEditResponse { project: VideoProject; job?: VideoJob | null }

export interface QuickProjectInput {
  profileId: string;
  title?: string;
  styleId?: string;
  aspect?: VideoAspect;
  agentId?: string;
}

export const quickApi = {
  templates: () => apiGet<TemplatesResponse>(`${BASE}/templates`),
  installTemplate: (id: string) =>
    apiPost<{ template: TemplateSummary }>(`${BASE}/templates/${encodeURIComponent(id)}/install`),
  /** A project made from Trang đầu: `flow: 'quick'` keeps the chain from directing before AI edit. */
  createProject: (input: QuickProjectInput) =>
    apiPost<{ project: VideoProject }>(`${BASE}/projects`, { ...input, flow: 'quick' }),
  aiEdit: (projectId: string, body: AiEditBody) =>
    apiPost<AiEditResponse>(`${BASE}/projects/${encodeURIComponent(projectId)}/ai-edit`, body),
};

/** Authenticated poster URL for <img> (the registry returns a path under /api). */
export function templatePosterUrl(t: Pick<TemplateSummary, 'posterUrl'>): string | null {
  if (!t.posterUrl) return null;
  return t.posterUrl.startsWith('/api/') ? tokenizedSseUrl(t.posterUrl) : t.posterUrl;
}

/** What the Thiết lập form holds; `aiEditBody` turns it into the request body. */
export interface QuickForm {
  autoCut: boolean;
  cutLevel: QuickSettings['cutLevel'];
  templateId: string;
  assets: { assetId: string; hint: string }[];
  music: QuickSettings['music'];
  stock: boolean;
  note: string;
}

export function aiEditBody(form: QuickForm, mode: QuickSettings['mode']): AiEditBody {
  const note = form.note.trim();
  const { assetId, ...music } = form.music;
  return {
    mode,
    autoCut: form.autoCut,
    cutLevel: form.cutLevel,
    templateId: form.templateId,
    assets: form.assets.map((a) => (a.hint.trim() ? { assetId: a.assetId, hint: a.hint.trim() } : { assetId: a.assetId })),
    music: music.mode === 'pick' && assetId ? { ...music, assetId } : music,
    stock: form.stock,
    ...(note ? { note } : {}),
  };
}
