/**
 * Provider adapter contract for KOL Studio. One adapter per provider (Gemini,
 * fal.ai, Higgsfield). Inputs are LOCAL file paths; each adapter turns them into
 * what its API wants (inline base64, an uploaded CDN url…). Outputs are bytes or
 * a url the generation worker downloads right away with a size cap.
 *
 * Video is split into submit + poll so a job survives a restart: the worker
 * stores the opaque `handle` as kol_generations.provider_request_id and polls it
 * again after a restart. Nothing here ever resubmits a paid request.
 */

import type { Aspect, ModelInfo, ProviderId, Quality, RefRoleDto } from '../types.js';

export interface InputFile {
  /** Absolute path of a local file (inside KOL_DIR). */
  path: string;
  mime: string;
  role: RefRoleDto['role'] | 'audio';
  /** Short English label used next to the image in multi-part requests ("Image 2: Mia, identity"). */
  label: string;
}

export interface ImageRequest {
  model: ModelInfo;
  prompt: string;
  /** In prompt order: refs[0] is "Image 1". */
  refs: InputFile[];
  aspect: Aspect;
  quality: Quality;
  count: number;
  seed?: number;
  /** Stable per generation; providers that support idempotency get it so a retry never charges twice. */
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface MediaOut {
  bytes?: Buffer;
  url?: string;
  mime?: string;
}

export interface ImageResponse {
  outputs: MediaOut[];
  /** USD the provider reported for this call, when it reports one. */
  reportedCostUsd?: number | null;
}

export interface VideoRequest {
  model: ModelInfo;
  prompt: string;
  /** Start frame (animate) or the face image (talking). */
  startFrame: InputFile | null;
  /** Extra subject references, for models that take them. */
  refs: InputFile[];
  /** Driving audio for lipsync models. */
  audioFile: InputFile | null;
  aspect: Aspect;
  quality: Quality;
  durationSec: number;
  audio: boolean;
  seed?: number;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export type VideoPoll =
  | { state: 'pending' }
  | { state: 'done'; outputs: MediaOut[]; reportedCostUsd?: number | null }
  | { state: 'failed'; error: string };

export interface ProviderAdapter {
  id: ProviderId;
  label: string;
  /** Vietnamese: where to put the key when not configured. */
  hint: string;
  configured(): boolean;
  models(): ModelInfo[];
  generateImage(req: ImageRequest): Promise<ImageResponse>;
  /** Returns an opaque handle (stored as provider_request_id). */
  submitVideo(req: VideoRequest): Promise<{ handle: string }>;
  pollVideo(handle: string, model: ModelInfo, signal?: AbortSignal): Promise<VideoPoll>;
}

// ── Errors ───────────────────────────────────────────────────────────

export type ProviderErrorKind = 'auth' | 'quota' | 'rate' | 'rejected' | 'safety' | 'timeout' | 'network' | 'server' | 'unsupported' | 'unknown';

/** A provider failure. `message` is English and safe (no keys, no urls); `vi()` gives the owner-facing text. */
export class ProviderError extends Error {
  constructor(readonly kind: ProviderErrorKind, message: string, readonly status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

const VI: Record<ProviderErrorKind, string> = {
  auth: 'Nhà cung cấp từ chối khóa API. Kiểm tra lại khóa ở Kết nối › Integrations (hoặc khóa GOOGLE_API_KEY).',
  quota: 'Tài khoản nhà cung cấp hết tiền hoặc chạm hạn mức gói.',
  rate: 'Nhà cung cấp đang giới hạn tốc độ. Thử lại sau ít phút.',
  rejected: 'Nhà cung cấp từ chối yêu cầu.',
  safety: 'Bộ lọc an toàn của nhà cung cấp đã chặn kết quả. Đổi mô tả, trang phục hoặc ảnh mẫu rồi thử lại.',
  timeout: 'Quá thời gian chờ nhà cung cấp.',
  network: 'Không kết nối được tới nhà cung cấp.',
  server: 'Máy chủ nhà cung cấp đang lỗi. Thử lại sau.',
  unsupported: 'Model này không hỗ trợ yêu cầu đó.',
  unknown: 'Lỗi không xác định từ nhà cung cấp.',
};

/** Classifies an HTTP status into a ProviderErrorKind. */
export function kindForStatus(status: number | undefined): ProviderErrorKind {
  if (!status) return 'unknown';
  if (status === 401) return 'auth';
  if (status === 402 || status === 403) return 'quota';
  if (status === 429) return 'rate';
  if (status === 400 || status === 404 || status === 409 || status === 413 || status === 415 || status === 422 || status === 423) return 'rejected';
  if (status >= 500) return 'server';
  return 'unknown';
}

// ── Shared HTTP helpers (fal, Higgsfield) ────────────────────────────

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const defaultFetch: FetchLike = (input, init) => fetch(input, init);
export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** IntegrationApiError / network error from media-http → ProviderError. */
export function wrapHttpError(err: unknown, service: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : undefined;
  const msg = (err instanceof Error ? err.message : String(err)).replace(/https?:\/\/[^\s"'<>]+/gi, '[url]').slice(0, 300);
  if (!status) {
    if (/timed out/i.test(msg)) return new ProviderError('timeout', msg);
    if (/network|could not reach/i.test(msg)) return new ProviderError('network', msg);
    return new ProviderError('unknown', msg.startsWith(service) ? msg : `${service}: ${msg}`);
  }
  if (/nsfw|safety|moderation|content policy/i.test(msg)) return new ProviderError('safety', msg, status);
  if (status === 400 && /concurrent/i.test(msg)) return new ProviderError('rate', msg, status);
  return new ProviderError(kindForStatus(status), msg, status);
}

/** PUT raw bytes to a presigned upload url (no credentials are sent there). */
export async function putBytes(fetchImpl: FetchLike, url: string, bytes: Buffer, headers: Record<string, string>, service: string, timeoutMs = 180_000): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'PUT', headers, body: new Uint8Array(bytes), signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ProviderError('network', `${service}: upload failed (network error)`);
  }
  if (!res.ok) throw new ProviderError(kindForStatus(res.status), `${service}: upload rejected (HTTP ${res.status})`, res.status);
}

/** Remembers uploaded file urls so the same identity refs are not re-uploaded for every job. */
export class UploadCache {
  private readonly map = new Map<string, { url: string; until: number }>();
  constructor(private readonly ttlMs: number) {}
  get(key: string): string | null {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.until < Date.now()) { this.map.delete(key); return null; }
    return hit.url;
  }
  set(key: string, url: string): void {
    if (this.map.size > 500) this.map.clear();
    this.map.set(key, { url, until: Date.now() + this.ttlMs });
  }
}

/** Cache key of a local file: path + size + mtime, so an edited file is uploaded again. */
export function fileCacheKey(file: string, stat: { size: number; mtimeMs: number }): string {
  return `${file}|${stat.size}|${Math.round(stat.mtimeMs)}`;
}

/** True when `url` is https on one of the allowed hosts (or a subdomain of one). Never send credentials elsewhere. */
export function isAllowedHost(url: string, hosts: string[]): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** Vietnamese text for the owner, with the short English detail for diagnosis. Never contains secrets. */
export function providerErrorVi(err: unknown): string {
  if (err instanceof ProviderError) {
    const detail = err.message.replace(/\s+/g, ' ').trim().slice(0, 240);
    return detail ? `${VI[err.kind]} (${detail})` : VI[err.kind];
  }
  const status = (err as { status?: number } | null)?.status;
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const detail = raw.replace(/https?:\/\/[^\s"'<>]+/gi, '[url]').replace(/\s+/g, ' ').trim().slice(0, 240);
  const kind = /timed out|timeout/i.test(raw) ? 'timeout' : /network|ECONN|ENOTFOUND|fetch failed/i.test(raw) ? 'network' : kindForStatus(status);
  return detail ? `${VI[kind]} (${detail})` : VI[kind];
}
