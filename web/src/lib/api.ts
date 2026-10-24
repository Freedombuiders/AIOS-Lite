// Typed fetch wrapper. Token from localStorage 'aios.token'; errors follow docs/dev/API.md.
import { ApiError } from './errors';
import { mockEnabled, mockRequest } from './mock';

export { ApiError };

/** Scope id used by the copied chat components. */
export const chatId = 'aios';

export function getToken(): string {
  try {
    return localStorage.getItem('aios.token') ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem('aios.token', token);
    else localStorage.removeItem('aios.token');
  } catch {
    /* storage blocked */
  }
}

export function tokenizedSseUrl(path: string): string {
  const token = getToken();
  if (!token) return path;
  return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  return fetch(path.startsWith('/api') ? path : `/api${path}`, { ...options, headers });
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (mockEnabled()) return mockRequest<T>(method, path, body);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await apiFetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, null, 'Không kết nối được máy chủ AIOS-Lite', 'network');
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, data, err?.message ?? `Lỗi ${res.status}`, err?.code ?? 'internal');
  }
  return data as T;
}

export const apiGet = <T = unknown>(path: string) => request<T>('GET', path);
export const apiPost = <T = unknown>(path: string, body?: unknown) => request<T>('POST', path, body ?? {});
export const apiPut = <T = unknown>(path: string, body: unknown) => request<T>('PUT', path, body);
export const apiPatch = <T = unknown>(path: string, body: unknown) => request<T>('PATCH', path, body);
export const apiDelete = <T = unknown>(path: string, body?: unknown) => request<T>('DELETE', path, body);

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}
