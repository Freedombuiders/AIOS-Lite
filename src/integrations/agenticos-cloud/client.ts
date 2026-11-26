/**
 * HTTP client for the Open AgenticOS cloud (cloud/ in this repo). The machine's
 * session token goes in the Authorization header and never into an error
 * message; signed upload URLs are never echoed either.
 */
import { IntegrationApiError, IntegrationUsageError } from '../types.js';
import { errorMessageFromBody, httpHint, scrub, type FetchImpl } from '../media-http.js';

export interface CloudClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
}

/** https://…, or http:// on localhost for `wrangler dev`. No path, query or credentials. */
export function normaliseCloudUrl(raw: string | undefined): string {
  const text = raw?.trim() ?? '';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new IntegrationUsageError('Địa chỉ cloud không hợp lệ, ví dụ https://cloud.example.com.');
  }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new IntegrationUsageError('Địa chỉ cloud phải bắt đầu bằng https://.');
  if (url.username || url.password || url.search) throw new IntegrationUsageError('Địa chỉ cloud không được chứa tài khoản hay tham số.');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export function createCloudClient(opts: CloudClientOptions) {
  const fetchImpl: FetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeout = () => AbortSignal.timeout(60_000);
  const signal = () => (opts.signal ? AbortSignal.any([opts.signal, timeout()]) : timeout());

  async function call<T>(method: string, path: string, json?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${opts.baseUrl}${path}`, {
        method,
        signal: signal(),
        redirect: 'error',
        headers: { Authorization: `Bearer ${opts.token}`, Accept: 'application/json', ...(json === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: json === undefined ? undefined : JSON.stringify(json),
      });
    } catch {
      throw new IntegrationApiError('AgenticOS cloud: không kết nối được máy chủ');
    }
    const text = await res.text().catch(() => '');
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : {}; } catch { /* keep text */ }
    if (!res.ok) {
      const detail = scrub(errorMessageFromBody(body), opts.token) || httpHint('AgenticOS cloud', res.status);
      throw new IntegrationApiError(`AgenticOS cloud: ${detail} (HTTP ${res.status})`, res.status);
    }
    return body as T;
  }

  return {
    me: () => call<{ user: { email: string; name: string | null } }>('GET', '/me'),
    // ---- pack store (cloud/src/routes/packs.ts)
    listPacks: (module?: string) => call<{ items: CloudPack[] }>('GET', `/packs${module ? `?module=${encodeURIComponent(module)}` : ''}`),
    getPack: (id: string) => call<CloudPackDetail>('GET', `/packs/${encodeURIComponent(id)}`),
    packUpdates: (have: string[]) => call<{ items: CloudPackUpdate[] }>('GET', `/packs/updates?have=${encodeURIComponent(have.join(','))}`),
    /** Signed download link plus the release's hash and signature. A yanked release is HTTP 410 (PackYankedError). */
    async requestDownload(id: string, version: string): Promise<CloudDownload> {
      try {
        return await call<CloudDownload>('POST', `/packs/${encodeURIComponent(id)}/releases/${encodeURIComponent(version)}/download`);
      } catch (e) {
        if (e instanceof IntegrationApiError && e.status === 410) throw new PackYankedError(id, version);
        throw e;
      }
    },
    /**
     * GETs the zip from the signed link, without the session token, stopping as soon as more than `maxBytes`
     * arrive. The link must be https, or on the cloud's own origin (wrangler dev serves blobs itself).
     */
    async fetchPackZip(url: string, maxBytes: number): Promise<Uint8Array> {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        throw new IntegrationApiError('AgenticOS cloud: đường tải gói không hợp lệ');
      }
      if (target.protocol !== 'https:' && target.origin !== new URL(opts.baseUrl).origin) throw new IntegrationApiError('AgenticOS cloud: đường tải gói phải là https');
      let res: Response;
      try {
        res = await fetchImpl(target.toString(), { method: 'GET', signal: AbortSignal.timeout(5 * 60_000), redirect: 'error' });
      } catch {
        throw new IntegrationApiError('AgenticOS cloud: tải gói bị lỗi mạng');
      }
      if (res.status === 410) throw new IntegrationApiError('AgenticOS cloud: bản này đã bị thu hồi', 410);
      if (!res.ok) throw new IntegrationApiError(`AgenticOS cloud: kho từ chối tải gói (HTTP ${res.status})`, res.status);
      const declared = Number(res.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > maxBytes) throw new IntegrationApiError('AgenticOS cloud: gói quá lớn');
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new IntegrationApiError('AgenticOS cloud: gói quá lớn');
          }
          chunks.push(value);
        }
      }
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.byteLength;
      }
      return out;
    },
    startUpload: (b: { contentType: string; size: number; purpose: string }) =>
      call<{ id: string; uploadUrl: string; headers: Record<string, string> }>('POST', '/uploads', b),
    completeUpload: (id: string) => call<{ id: string; url: string; expiresAt: string }>('POST', `/uploads/${encodeURIComponent(id)}/complete`),
    listUploads: (purpose?: string) => call<{ items: unknown[] }>('GET', `/uploads${purpose ? `?purpose=${encodeURIComponent(purpose)}` : ''}`),
    deleteUpload: (id: string) => call<{ ok: true }>('DELETE', `/uploads/${encodeURIComponent(id)}`),
    /** PUTs the bytes straight to storage with the signed URL. */
    async putToStorage(url: string, headers: Record<string, string>, data: Uint8Array): Promise<void> {
      // fetch sets Content-Length from the body; it must equal the signed value, which it does.
      const { 'content-length': _len, ...rest } = headers;
      let res: Response;
      try {
        res = await fetchImpl(url, { method: 'PUT', headers: rest, body: data as Uint8Array<ArrayBuffer>, signal: AbortSignal.timeout(15 * 60_000), redirect: 'error' });
      } catch {
        throw new IntegrationApiError('AgenticOS cloud: tải tệp lên kho bị lỗi mạng');
      }
      if (!res.ok) throw new IntegrationApiError(`AgenticOS cloud: kho từ chối tệp (HTTP ${res.status})`, res.status);
    },
  };
}
export type CloudClient = ReturnType<typeof createCloudClient>;

export class PackYankedError extends IntegrationApiError {
  constructor(id: string, version: string) {
    super(`Bản ${version} của gói ${id} đã bị thu hồi. Hãy chọn bản mới hơn.`, 410);
    this.name = 'PackYankedError';
  }
}

export interface CloudRelease {
  id: string;
  version: string;
  status: string;
  size: number | null;
  sha256: string | null;
  notesCount: number | null;
  keyId: string | null;
  license: string | null;
  author: string | null;
  publishedAt: string | null;
  yankedAt: string | null;
}
export interface CloudPack {
  id: string;
  module: string;
  name: string;
  summary: string | null;
  industry: string | null;
  coverUrl: string | null;
  latest?: CloudRelease | null;
}
export interface CloudPackDetail extends CloudPack {
  license: string | null;
  author: string | null;
  releases: CloudRelease[];
  files: { path: string; loai: string | null; sha256: string }[];
}
export interface CloudPackUpdate {
  id: string;
  have: string;
  latest: string | null;
  update: boolean;
  yanked: boolean;
  warning?: string;
}
export interface CloudDownload {
  url: string;
  expiresAt: string;
  sha256: string | null;
  signature: string | null;
  keyId: string | null;
  size: number | null;
}

/**
 * POST /auth/exchange: trades the one-time code from the desktop sign-in for a machine session. No token
 * yet, so it is a plain call; the code and the returned token never go into an error message.
 */
export async function exchangeLoginCode(opts: { baseUrl: string; code: string; state: string; label: string; fetchImpl?: FetchImpl }): Promise<{ token: string; user: { email: string; name: string | null } }> {
  const fetchImpl: FetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  let res: Response;
  try {
    res = await fetchImpl(`${opts.baseUrl}/auth/exchange`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: opts.code, state: opts.state, kind: 'machine', label: opts.label }),
    });
  } catch {
    throw new IntegrationApiError('AgenticOS cloud: không kết nối được máy chủ');
  }
  const text = await res.text().catch(() => '');
  let body: unknown = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* not json */ }
  if (!res.ok) {
    const detail = scrub(scrub(errorMessageFromBody(body), opts.code), opts.state) || httpHint('AgenticOS cloud', res.status);
    throw new IntegrationApiError(`AgenticOS cloud: ${detail} (HTTP ${res.status})`, res.status);
  }
  const b = body as { token?: unknown; user?: { email?: unknown; name?: unknown } };
  if (typeof b.token !== 'string' || !b.token || typeof b.user?.email !== 'string') throw new IntegrationApiError('AgenticOS cloud: trả lời đăng nhập không hợp lệ');
  return { token: b.token, user: { email: b.user.email, name: typeof b.user.name === 'string' ? b.user.name : null } };
}
