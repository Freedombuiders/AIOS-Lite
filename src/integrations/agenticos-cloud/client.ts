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
