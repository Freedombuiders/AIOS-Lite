/**
 * Tiny Apify REST client (no SDK). The token only ever travels in the Authorization header.
 * The owner may store up to three tokens (several Apify accounts): runs take them in turn, and a token Apify
 * refuses (bad key, no credit, usage limit, rate limit) rests for a while so the next one is used.
 */

import { createHash } from 'crypto';

import { loadIntegrationValues } from '../integration-values.js';
import { getKv as getDashboardSetting, setKv as setDashboardSetting } from '../kv.js';
import type { CollectDeps } from './index.js';

/** Integration fields holding the tokens, in rotation order. */
export const APIFY_TOKEN_FIELDS = ['api_token', 'api_token_2', 'api_token_3'] as const;

const BASE = 'https://api.apify.com/v2';
const DONE = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

export class ApifyError extends Error {
  /** `type` is Apify's error type when the body had one; `atStart` marks a refusal before any run existed. */
  constructor(message: string, readonly status?: number, readonly type?: string, readonly atStart = false) { super(message); this.name = 'ApifyError'; }
}

const uniq = (list: (string | null | undefined)[]): string[] => [...new Set(list.map((t) => (t ?? '').trim()).filter(Boolean))];

/** Every stored token, in rotation order, without blanks or duplicates. */
export function getApifyTokens(deps?: CollectDeps): string[] {
  if (deps && 'apifyTokens' in deps) return uniq(deps.apifyTokens ?? []);
  if (deps && 'apifyToken' in deps) return uniq([deps.apifyToken]);
  try {
    const values = loadIntegrationValues('apify');
    return uniq(APIFY_TOKEN_FIELDS.map((k) => values?.[k]));
  } catch {
    return [];
  }
}

export function getApifyToken(deps?: CollectDeps): string | null {
  return getApifyTokens(deps)[0] ?? null;
}

// ── Rotation ────────────────────────────────────────────────────────────

/** Where the rotation cursor and resting tokens live (dashboard settings in the app, memory in tests). */
export interface RotationStore { get(key: string): string | null; set(key: string, value: string): void }

export const dbRotationStore: RotationStore = { get: getDashboardSetting, set: setDashboardSetting };

export function memoryRotationStore(): RotationStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v); } };
}

const CURSOR_KEY = 'radar.apify.cursor';
const REST_KEY = 'radar.apify.rest';

/** Tokens are never stored: rest marks use a short hash. */
export function tokenFingerprint(token: string): string {
  return createHash('sha1').update(token).digest('hex').slice(0, 12);
}

function readRest(store: RotationStore): Record<string, number> {
  try {
    const v = JSON.parse(store.get(REST_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** How long a refused token rests: a bad key a day, a rate limit two minutes, credit or usage limits six hours. */
export function restMsFor(e: ApifyError): number {
  if (e.status === 401) return 24 * 3_600_000;
  if (e.status === 429) return 2 * 60_000;
  return 6 * 3_600_000;
}

/** A refusal at run start that another token may not hit. */
export function isTokenRefusal(e: unknown): e is ApifyError {
  if (!(e instanceof ApifyError) || !e.atStart) return false;
  if (e.status === 401 || e.status === 402 || e.status === 403 || e.status === 429) return true;
  return /usage|limit|credit|not-enough|quota/i.test(e.type ?? '');
}

export function restToken(store: RotationStore, token: string, ms: number, now: number): void {
  const rest = readRest(store);
  for (const [k, until] of Object.entries(rest)) if (until <= now) delete rest[k];
  rest[tokenFingerprint(token)] = now + ms;
  store.set(REST_KEY, JSON.stringify(rest));
}

/**
 * The order to try tokens for one run: from the rotation cursor onwards, resting tokens left out (all of them
 * when every token rests, so a stale mark never blocks the scan). The cursor moves one step per run, so
 * parallel runs spread over the accounts.
 */
export function rotationOrder(tokens: string[], store: RotationStore, now: number): { token: string; index: number }[] {
  const n = tokens.length;
  if (n === 0) return [];
  const cursor = (Number(store.get(CURSOR_KEY)) || 0) % n;
  store.set(CURSOR_KEY, String((cursor + 1) % n));
  const order = Array.from({ length: n }, (_, i) => ({ token: tokens[(cursor + i) % n], index: (cursor + i) % n }));
  const rest = readRest(store);
  const ready = order.filter((o) => !((rest[tokenFingerprint(o.token)] ?? 0) > now));
  return ready.length ? ready : order;
}

export interface RotatingOptions extends Omit<RunOptions, 'token'> {
  tokens: string[];
  store?: RotationStore;
  now?: () => number;
  /** Vietnamese line when a token is refused and the next one is tried. */
  onSwitch?: (line: string) => void;
}

/** runActor with the next token in turn; a token refused at start rests and the next one is tried. */
export async function runActorRotating(actorId: string, input: Record<string, unknown>, o: RotatingOptions): Promise<RunResult & { keyIndex: number }> {
  const store = o.store ?? dbRotationStore;
  const now = o.now ?? Date.now;
  const order = rotationOrder(o.tokens, store, now());
  if (order.length === 0) throw new ApifyError('Chưa có Apify token.');
  let last: unknown;
  for (const [i, { token, index }] of order.entries()) {
    try {
      const r = await runActor(actorId, input, { ...o, token });
      return { ...r, keyIndex: index };
    } catch (e) {
      last = e;
      if (!isTokenRefusal(e)) throw e;
      restToken(store, token, restMsFor(e), now());
      const next = order[i + 1];
      o.onSwitch?.(`Apify key ${index + 1}: ${e.message}${next ? ` Chuyển sang key ${next.index + 1}.` : ''}`);
    }
  }
  throw last instanceof ApifyError && order.length > 1
    ? new ApifyError(`Cả ${order.length} Apify key đều bị từ chối (${last.message})`, last.status, last.type)
    : last;
}

export interface RunOptions {
  token: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Dataset item cap. */
  limit?: number;
  pollMs?: number;
  maxWaitMs?: number;
  timeoutSecs?: number;
  memoryMbytes?: number;
}

export interface RunResult { items: unknown[]; costUsd: number; status: string }

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(new ApifyError('Đã huỷ.'));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new ApifyError('Đã huỷ.')); }, { once: true });
});

async function call(f: typeof fetch, url: string, token: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) } });
  } catch (e) {
    if (signal?.aborted) throw new ApifyError('Đã huỷ.');
    throw new ApifyError(`Không gọi được Apify (${e instanceof Error ? e.name : 'lỗi mạng'}).`);
  }
  if (!res.ok) {
    let type: string | undefined;
    try { type = String(obj(obj(await res.json()).error).type ?? '') || undefined; } catch { /* no JSON body */ }
    const limit = /usage|limit|credit|not-enough|quota/i.test(type ?? '');
    const hint = res.status === 401 ? 'token không đúng' : res.status === 402 || limit ? 'hết hạn mức hoặc tiền trong tài khoản' : res.status === 403 ? 'không có quyền' : res.status === 429 ? 'quá giới hạn gọi' : `HTTP ${res.status}`;
    throw new ApifyError(`Apify từ chối: ${hint}.`, res.status, type);
  }
  try { return await res.json(); } catch { throw new ApifyError('Apify trả dữ liệu không đọc được.'); }
}

/** Runs one actor to completion and returns its dataset items. */
export async function runActor(actorId: string, input: Record<string, unknown>, o: RunOptions): Promise<RunResult> {
  const f = o.fetchImpl ?? fetch;
  const qs = new URLSearchParams();
  if (o.timeoutSecs) qs.set('timeout', String(o.timeoutSecs));
  if (o.memoryMbytes) qs.set('memory', String(o.memoryMbytes));
  const q = qs.toString() ? `?${qs}` : '';
  let startedRaw: unknown;
  try {
    startedRaw = await call(f, `${BASE}/acts/${actorId.replace('/', '~')}/runs${q}`, o.token, { method: 'POST', body: JSON.stringify(input) }, o.signal);
  } catch (e) {
    // Mark refusals before any run exists: only those may be retried with another token.
    if (e instanceof ApifyError) throw new ApifyError(e.message, e.status, e.type, true);
    throw e;
  }
  const started = obj(startedRaw);
  let run = obj(started.data);
  const id = String(run.id ?? '');
  if (!id) throw new ApifyError('Apify không trả mã lần chạy.');
  const deadline = Date.now() + (o.maxWaitMs ?? 10 * 60_000);
  const pollMs = o.pollMs ?? 5000;
  while (!DONE.has(String(run.status))) {
    if (Date.now() > deadline) throw new ApifyError('Apify chạy quá lâu, bỏ qua.');
    await sleep(pollMs, o.signal);
    run = obj(obj(await call(f, `${BASE}/actor-runs/${id}`, o.token, { method: 'GET' }, o.signal)).data);
  }
  const status = String(run.status);
  const costUsd = typeof run.usageTotalUsd === 'number' ? run.usageTotalUsd : 0;
  if (status !== 'SUCCEEDED') throw new ApifyError(`Lần chạy Apify kết thúc ở trạng thái ${status}.`);
  const ds = String(run.defaultDatasetId ?? '');
  if (!ds) return { items: [], costUsd, status };
  const items = await call(f, `${BASE}/datasets/${ds}/items?clean=true&format=json&limit=${o.limit ?? 200}`, o.token, { method: 'GET' }, o.signal);
  return { items: Array.isArray(items) ? items : [], costUsd, status };
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
