/**
 * Shared HTTP plumbing for the media integrations. The credential travels in a
 * header (or, for nothing here, the query), and no URL, key or token ever goes
 * into an error message: messages come from the response body, scrubbed of the
 * credential, or from a fixed hint. No side-effect imports.
 */
import { IntegrationApiError } from '../../../src/integrations/types.js';

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injectable for tests so retries do not wait. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [1_000, 3_000];
const MAX_RETRY_AFTER_MS = 10_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function scrub(text: string, secret: string): string {
  let out = text;
  if (secret) out = out.split(secret).join('***');
  return out.replace(/https?:\/\/[^\s"'<>]+/gi, '[url]');
}

export function httpHint(service: string, status: number): string {
  if (status === 401 || status === 403) return 'credential rejected: ask the owner to re-enter it in Integrations';
  if (status === 404) return 'not found';
  if (status === 402) return 'quota or plan limit reached';
  if (status === 429) return 'rate limited, try again in a few seconds';
  if (status >= 500) return `${service} server error, try again later`;
  return 'request failed';
}

/** A short human message out of a JSON error body (several services' shapes). */
export function errorMessageFromBody(body: unknown): string {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body.slice(0, 200) : '';
  const o = body as Record<string, unknown>;
  for (const key of ['message', 'error', 'detail', 'status']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 300);
    if (v && typeof v === 'object') {
      const nested = (v as Record<string, unknown>).message;
      if (typeof nested === 'string' && nested.trim()) return nested.trim().slice(0, 300);
    }
  }
  return '';
}

export interface RequestSpec {
  service: string;
  secret: string;
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** JSON body, or a raw string/body. */
  json?: unknown;
  body?: string;
}

/** Performs the request, retrying 429 twice, and returns the OK response. Throws IntegrationApiError otherwise. */
export async function send(spec: RequestSpec, opts: HttpOptions): Promise<Response> {
  const fetchImpl: FetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = opts.sleepImpl ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetchImpl(spec.url, {
        method: spec.method ?? 'GET',
        signal,
        headers: { Accept: 'application/json', ...(spec.json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...spec.headers },
        body: spec.json !== undefined ? JSON.stringify(spec.json) : spec.body,
      });
    } catch {
      if (opts.signal?.aborted) throw new IntegrationApiError(`${spec.service}: request cancelled`);
      if (timeout.aborted) throw new IntegrationApiError(`${spec.service}: timed out, try again`);
      throw new IntegrationApiError(`${spec.service}: could not reach the server (network error)`);
    }
    if (res.status === 429 && attempt < RETRY_DELAYS_MS.length) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : RETRY_DELAYS_MS[attempt];
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      let text = '';
      try { text = await res.text(); } catch { /* empty */ }
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* keep text */ }
      const detail = scrub(errorMessageFromBody(body), spec.secret) || httpHint(spec.service, res.status);
      throw new IntegrationApiError(`${spec.service}: ${detail} (HTTP ${res.status})`, res.status);
    }
    return res;
  }
}

export async function sendJson<T>(spec: RequestSpec, opts: HttpOptions): Promise<T> {
  const res = await send(spec, opts);
  const text = await res.text().catch(() => '');
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; } catch { throw new IntegrationApiError(`${spec.service}: unexpected non-JSON response`, res.status); }
}

/** Reads a response body with a hard cap, so a rogue server cannot fill the disk. */
export async function readBytes(res: Response, maxBytes: number, service: string): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new IntegrationApiError(`${service}: file too large (${Math.round(declared / 1048576)} MB)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new IntegrationApiError(`${service}: file too large (${Math.round(buf.length / 1048576)} MB)`);
  return buf;
}
