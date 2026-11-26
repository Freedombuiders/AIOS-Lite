/**
 * A small typed client for agenticos-cloud (cloud/). One `request` does the
 * work: it adds the session token, applies a time limit so nothing spins for
 * ever, and turns every failure into a CloudError.
 *
 * A 401 on a call that carried a token means the session is gone (expired,
 * revoked, or the account was disabled: the cloud answers a disabled user's
 * session with 401 too), so `onUnauthorized` runs once with the token that was
 * rejected and the caller signs out. A 401 on sign-in itself is different (the
 * cloud rejected the Google ID token) and does not trigger it.
 *
 * Nothing here logs. The token never appears in an error.
 */
import type {
  AuthResponse, MeResponse, OkResponse, PackDetail, PackListResponse, PackModule, SessionKind,
} from '../../../packages/api-types/src/index';
import { CloudError } from './errors';

export interface PackQuery {
  module?: PackModule;
  q?: string;
}

/** What the screens and the auth store use. Tests supply a fake. */
export interface CloudApi {
  signInWithGoogle(idToken: string, label?: string): Promise<AuthResponse>;
  /** `POST /auth/dev`: only answers on a cloud run locally with DEV_MODE. */
  signInDev(email: string, label?: string): Promise<AuthResponse>;
  logout(): Promise<OkResponse>;
  me(signal?: AbortSignal): Promise<MeResponse>;
  revokeSession(id: string): Promise<OkResponse>;
  deleteAccount(): Promise<OkResponse>;
  listPacks(query?: PackQuery, signal?: AbortSignal): Promise<PackListResponse>;
  getPack(id: string, signal?: AbortSignal): Promise<PackDetail>;
}

export interface CloudClientOptions {
  baseUrl: string;
  getToken: () => string | null;
  /** Called with the rejected token when a call that carried one gets 401. */
  onUnauthorized: (rejectedToken: string) => void;
  fetch?: typeof fetch;
  /** Default 15 000 ms. */
  timeoutMs?: number;
  /** What the cloud sees as the session label. */
  sessionKind?: SessionKind;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  /** Send the session token. False for the sign-in calls. */
  auth: boolean;
  body?: unknown;
  query?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export function createCloudClient(opts: CloudClientOptions): CloudApi {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = opts.baseUrl.replace(/\/+$/, '');

  async function request<T>(path: string, o: RequestOptions): Promise<T> {
    if (!base) throw new CloudError('not_configured');
    let token: string | null = null;
    if (o.auth) {
      token = opts.getToken();
      if (!token) throw new CloudError('unauthorized', 401);
    }
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(o.query ?? {})) if (v) params.set(k, v);
    const qs = params.toString();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onCallerAbort = () => controller.abort();
    if (o.signal) {
      if (o.signal.aborted) controller.abort();
      else o.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    let res: Response;
    try {
      res = await doFetch(`${base}${path}${qs ? `?${qs}` : ''}`, {
        method: o.method ?? 'GET',
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: controller.signal,
      });
    } catch {
      throw new CloudError(timedOut ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onCallerAbort);
    }

    let json: unknown;
    try {
      const text = await res.text();
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
      if (res.ok) throw new CloudError('invalid_response', res.status);
    }

    if (!res.ok) throw classify(res.status, json, o.auth, token);
    if (json === undefined || json === null || typeof json !== 'object' || Array.isArray(json)) throw new CloudError('invalid_response', res.status);
    return json as T;
  }

  function classify(status: number, body: unknown, auth: boolean, token: string | null): CloudError {
    const err = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    const code = typeof err?.code === 'string' ? err.code : undefined;
    const message = typeof err?.message === 'string' ? err.message : undefined;
    const make = (kind: ConstructorParameters<typeof CloudError>[0]) => new CloudError(kind, status, code, message);
    if (status === 401) {
      if (auth && token) {
        opts.onUnauthorized(token);
        return make('unauthorized');
      }
      return make('credentials');
    }
    if (status === 403) return make(auth ? 'forbidden' : 'disabled');
    if (status === 404) return make('not_found');
    if (status === 429) return make('rate_limited');
    if (status >= 400 && status < 500) return make('bad_request');
    return make('server');
  }

  const kind: SessionKind = opts.sessionKind ?? 'mobile';
  return {
    signInWithGoogle: (idToken, label) =>
      request<AuthResponse>('/auth/google', { method: 'POST', auth: false, body: { idToken, kind, ...(label ? { label } : {}) } }),
    signInDev: (email, label) =>
      request<AuthResponse>('/auth/dev', { method: 'POST', auth: false, body: { email, kind, ...(label ? { label } : {}) } }),
    logout: () => request<OkResponse>('/auth/logout', { method: 'POST', auth: true }),
    me: (signal) => request<MeResponse>('/me', { auth: true, signal }),
    revokeSession: (id) => request<OkResponse>(`/me/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', auth: true }),
    deleteAccount: () => request<OkResponse>('/me', { method: 'DELETE', auth: true }),
    listPacks: (query = {}, signal) =>
      request<PackListResponse>('/packs', { auth: true, query: { module: query.module, q: query.q?.trim() || undefined }, signal }),
    getPack: (id, signal) => request<PackDetail>(`/packs/${encodeURIComponent(id)}`, { auth: true, signal }),
  };
}
