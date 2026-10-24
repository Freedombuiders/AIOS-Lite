// Typed wrappers for the asset library endpoints (/api/m/video/edit/assets*). Server: src/video-edit/library/routes.ts.
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, tokenizedSseUrl } from '@/lib/api';
import type { AssetKind, VideoAsset } from './types';

const BASE = '/api/m/video/edit/assets';

export interface LibraryFace { file: string; weight: number; style: 'normal' | 'italic'; variable?: boolean; weightMin?: number; weightMax?: number }
/** VideoAsset plus the library-only details the server adds. */
export interface LibraryAsset extends VideoAsset { family?: string; faces?: LibraryFace[]; aliasOf?: string }
export interface LibraryResponse { kinds: { kind: AssetKind; label: string; count: number }[]; assets: LibraryAsset[] }

export interface AssetPatch {
  name?: string;
  description?: string | null;
  tags?: string[];
  mood?: string | null;
  bpm?: number | null;
  license?: string | null;
  attribution?: string | null;
  sourceUrl?: string | null;
  enabled?: boolean;
}

export type SeedGroup = 'fonts' | 'sfx' | 'music' | 'luts' | 'stickers';
export interface SeedGroupProgress { total: number; done: number; skipped: number; failed: number }
export interface SeedStatus {
  state: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  groups: SeedGroup[];
  startedAt?: string;
  finishedAt?: string;
  progress: { done: number; total: number };
  current?: string;
  byGroup: Record<SeedGroup, SeedGroupProgress>;
  counts: Record<string, number>;
  bytes: number;
  downloadedBytes: number;
  skipped: { item: string; reason: string }[];
  log: string[];
  error?: string;
}

/** File extensions the server accepts per kind (mirrors catalog/assets.ts KIND_EXTENSIONS). */
export const UPLOAD_ACCEPT: Partial<Record<AssetKind, string>> = {
  bgm: '.mp3,.wav,.m4a,.ogg,.aac', sfx: '.mp3,.wav,.m4a,.ogg,.aac', font: '.ttf,.otf', lut: '.cube',
  video: '.mp4,.mov,.webm', image: '.png,.jpg,.jpeg,.webp,.svg,.gif', background: '.png,.jpg,.jpeg,.webp,.svg,.gif',
  icon: '.png,.jpg,.jpeg,.webp,.svg,.gif', overlay: '.png,.jpg,.jpeg,.webp,.svg,.gif,.mov',
};

export const libraryApi = {
  list: (params: { kind?: AssetKind | ''; q?: string; source?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.kind) qs.set('kind', params.kind);
    if (params.q?.trim()) qs.set('q', params.q.trim());
    if (params.source) qs.set('source', params.source);
    const s = qs.toString();
    return apiGet<LibraryResponse>(`${BASE}${s ? `?${s}` : ''}`);
  },
  update: (id: string, patch: AssetPatch) => apiPatch<{ asset: LibraryAsset }>(`${BASE}/${encodeURIComponent(id)}`, patch),
  remove: (id: string) => apiDelete<{ ok: boolean; deleted: boolean; asset: LibraryAsset }>(`${BASE}/${encodeURIComponent(id)}`),
  rescan: () => apiPost<{ added: number; removed: number; total: number }>(`${BASE}/rescan`),
  seedStatus: () => apiGet<SeedStatus>(`${BASE}/seed`),
  startSeed: (groups?: SeedGroup[]) => apiPost<SeedStatus>(`${BASE}/seed`, groups?.length ? { groups } : undefined),
  cancelSeed: () => apiPost<SeedStatus>(`${BASE}/seed/cancel`),
};

/** Authenticated URL of an asset's file, for <audio>, <img>, <video> and @font-face. */
export function assetFileUrl(id: string, version?: string | number): string {
  const v = version !== undefined ? `?v=${encodeURIComponent(String(version))}` : '';
  return tokenizedSseUrl(`${BASE}/${encodeURIComponent(id)}/file${v}`);
}

/** Raw-file upload with progress (fetch has no upload progress). Token handling matches lib/api.ts. */
export function uploadAsset(kind: AssetKind, file: File, onProgress?: (fraction: number) => void): Promise<LibraryAsset> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', tokenizedSseUrl(`${BASE}/upload?kind=${encodeURIComponent(kind)}`));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total); };
    xhr.onerror = () => reject(new Error('Không tải được file lên (lỗi mạng).'));
    xhr.onabort = () => reject(new Error('Đã huỷ tải lên.'));
    xhr.onload = () => {
      let body: unknown = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* non-JSON error page */ }
      if (xhr.status >= 200 && xhr.status < 300 && body && typeof body === 'object' && 'asset' in body) {
        onProgress?.(1);
        resolve((body as { asset: LibraryAsset }).asset);
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

export function libraryErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { error?: unknown } | null;
    if (body && typeof body === 'object' && typeof body.error === 'string' && body.error) return body.error;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export function formatBytes(n: number | undefined): string {
  if (!n) return '';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function formatDuration(sec: number | undefined): string {
  if (!sec) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
