/**
 * The one exit to Facebook / Meta for Content Studio. Every Composio call —
 * tool execution, Graph API proxy calls, connection listing — goes through
 * this file, never through a raw `new Composio()` elsewhere.
 *
 * Rules:
 *  - The API key lives in the shared encrypted Integrations store. Never log it, never
 *    return it to a caller, never put it in an error message.
 *  - Never log tool `arguments` or responses: they carry captions, comments,
 *    customer names and, for LIST_MANAGED_PAGES, Page access tokens. Log the
 *    slug, area and duration only.
 *  - Every call is counted in fb_api_usage BEFORE it runs (a failed call
 *    still cost a request) and refused once the hourly budget is spent.
 *  - Local media: file_uploadable params (FACEBOOK_CREATE_VIDEO_POST.video,
 *    FACEBOOK_CREATE_PHOTO_POST.photo) accept a local path; the SDK uploads it
 *    to Composio at call time. Only files under FB_MEDIA_DIR are allowed.
 *
 * Adapted from the Marketing Hub client (raw REST for connection listing,
 * because the typed SDK response drops `user_id`, which execute() needs).
 */

import os from 'os';
import path from 'path';

import { Composio } from '@composio/core';
import { z } from 'zod';

export type FbApiArea = 'publish' | 'comments' | 'analytics' | 'ads' | 'pages' | 'gmail';

// AIOS-Lite: shared by the marketing, ads and gmail modules (modules/_lib is not a module).
// Each module calls configureComposio() in start(); the first call sets the key source and media dir,
// marketing adds the hourly API budget (its fb_api_usage table). Without a budget, calls are not capped.
export interface ComposioLibOptions {
  /** reads the Composio API key (ctx.connections.secret('COMPOSIO_API_KEY')) */
  getApiKey?: () => string | undefined;
  /** absolute media dir Composio may upload from (data/modules/marketing/media) */
  mediaDir?: string;
  log?: { info(obj: object, msg?: string): void };
  budget?: {
    /** setting api_budget_per_hour, or undefined for the default */
    perHour(): number | undefined;
    countSince(epochSec: number): number;
    record(area: FbApiArea, ok: boolean): void;
  };
}

const lib: Required<Pick<ComposioLibOptions, 'getApiKey'>> & ComposioLibOptions = {
  getApiKey: () => process.env.COMPOSIO_API_KEY?.trim() || undefined,
};

export function configureComposio(opts: ComposioLibOptions): void {
  if (opts.getApiKey) lib.getApiKey = opts.getApiKey;
  if (opts.log) lib.log = opts.log;
  if (opts.budget) lib.budget = opts.budget;
  if (opts.mediaDir && opts.mediaDir !== FB_MEDIA_DIR) {
    FB_MEDIA_DIR = opts.mediaDir;
    resetComposio();
  }
}

function readComposioKey(): string | undefined {
  return lib.getApiKey();
}

const logger = {
  info(obj: object, msg?: string): void {
    lib.log?.info(obj, msg);
  },
};

function getFbSetting(key: string): string | undefined {
  return key === 'api_budget_per_hour' ? String(lib.budget?.perHour() ?? '') : undefined;
}

function countFbApiCallsSince(epochSec: number): number {
  return lib.budget ? lib.budget.countSince(epochSec) : 0;
}

function recordFbApiCall(area: FbApiArea, ok: boolean): void {
  lib.budget?.record(area, ok);
}

/** Where studio media lives; Composio may upload from here only. Set by configureComposio(). */
export let FB_MEDIA_DIR = path.join(os.tmpdir(), 'aios-composio-media');

const COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3';
const DEFAULT_BUDGET_PER_HOUR = 600;
const GRAPH_BASE = 'https://graph.facebook.com/v23.0';

// ── Errors ────────────────────────────────────────────────────────────

export class ComposioAuthError extends Error {
  constructor(message = 'Composio API key missing or rejected') { super(message); this.name = 'ComposioAuthError'; }
}
export class ComposioConnectionExpiredError extends Error {
  constructor(message = 'Connection expired') { super(message); this.name = 'ComposioConnectionExpiredError'; }
}
export class ComposioRateLimitError extends Error {
  constructor(message = 'Rate limited') { super(message); this.name = 'ComposioRateLimitError'; }
}
export class FbBudgetExceeded extends Error {
  constructor(public readonly cap: number, public readonly used: number) {
    super(`Composio budget exhausted for this hour (${used}/${cap})`);
    this.name = 'FbBudgetExceeded';
  }
}

function statusCodeOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number; status?: number; cause?: { status?: number } } | null;
  return e?.statusCode ?? e?.status ?? e?.cause?.status;
}

const META_RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/** Maps a thrown error or a `{successful:false, error}` response to one of the typed errors above. */
export function classifyComposioError(err: unknown): Error {
  const status = statusCodeOf(err);
  const message = err instanceof Error ? err.message : String(err);
  const haystack = message.toLowerCase();
  if (status === 401 || haystack.includes('unauthorized') || haystack.includes('invalid api key')) {
    return new ComposioAuthError(message);
  }
  if ((haystack.includes('oauthexception') && haystack.includes('"code":190')) || haystack.includes('expired') || haystack.includes('reauthorize')) {
    return new ComposioConnectionExpiredError(message);
  }
  if (status === 429 || haystack.includes('rate limit')) {
    return new ComposioRateLimitError(message);
  }
  const metaCode = message.match(/"code"\s*:\s*(\d+)/);
  if (metaCode && META_RATE_LIMIT_CODES.has(Number(metaCode[1]))) {
    return new ComposioRateLimitError(message);
  }
  return err instanceof Error ? err : new Error(message);
}

// ── Client ────────────────────────────────────────────────────────────

let _composio: Composio | null = null;
let _apiKey: string | null = null;

/** True when a Composio API key is configured (does not validate it). */
export function hasComposioKey(): boolean {
  try { resolveApiKey(); return true; } catch { return false; }
}

function resolveApiKey(): string {
  const apiKey = readComposioKey();
  if (!apiKey) throw new ComposioAuthError('Thêm Composio API key ở Kết nối → Composio.');
  return apiKey;
}

export function getComposio(): Composio {
  const apiKey = resolveApiKey();
  if (_composio && _apiKey === apiKey) return _composio;
  resetComposio();
  _apiKey = apiKey;
  _composio = new Composio({
    apiKey,
    allowTracking: false,
    // Local media upload for file_uploadable params, restricted to FB_MEDIA_DIR.
    dangerouslyAllowAutoUploadDownloadFiles: true,
    fileUploadDirs: [FB_MEDIA_DIR, path.join(os.homedir(), '.composio', 'temp')],
  });
  return _composio;
}

/** Drop the cached client so the next call picks up a newly written key. */
export function resetComposio(): void {
  _composio = null;
  _apiKey = null;
  _clearPageTokens();
}

function budgetPerHour(): number {
  const raw = Number(getFbSetting('api_budget_per_hour'));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BUDGET_PER_HOUR;
}

function nowSec(): number { return Math.floor(Date.now() / 1000); }

/** Refuses the call when this hour's budget (all areas together) is spent. */
function chargeBudget(): void {
  if (!lib.budget) return;
  const now = nowSec();
  const cap = budgetPerHour();
  const used = countFbApiCallsSince(now - (now % 3600));
  if (used >= cap) throw new FbBudgetExceeded(cap, used);
}

// ── Connections ───────────────────────────────────────────────────────

const RawConnectedAccountSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  word_id: z.string().nullable().optional(),
  alias: z.string().nullable().optional(),
  status: z.string(),
  toolkit: z.object({ slug: z.string() }),
  auth_config: z.object({ id: z.string() }).optional(),
});
const RawConnectedAccountsListSchema = z.object({
  items: z.array(RawConnectedAccountSchema),
  next_cursor: z.string().nullable().optional(),
});

export interface ComposioConnection {
  id: string;
  toolkit: string;
  status: string;
  alias: string | null;
  /** Composio user_id owning the connection; execute() must target it. */
  entityId: string;
  authConfigId: string;
}

/** Lists connected accounts (optionally for one toolkit), via raw REST because the SDK drops user_id. */
export async function listConnections(toolkit?: string): Promise<ComposioConnection[]> {
  const apiKey = resolveApiKey();
  const out: ComposioConnection[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${COMPOSIO_API_BASE}/connected_accounts`);
    url.searchParams.set('limit', '50');
    if (toolkit) url.searchParams.set('toolkit_slugs', toolkit);
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw classifyComposioError(Object.assign(new Error(`listConnections failed: ${res.status} ${body.slice(0, 200)}`), { statusCode: res.status }));
    }
    const parsed = RawConnectedAccountsListSchema.parse(await res.json());
    for (const item of parsed.items) {
      if (toolkit && item.toolkit.slug !== toolkit) continue;
      out.push({
        id: item.id,
        toolkit: item.toolkit.slug,
        status: item.status,
        alias: item.alias ?? null,
        entityId: item.user_id,
        authConfigId: item.auth_config?.id ?? '',
      });
    }
    if (!parsed.next_cursor) break;
    cursor = parsed.next_cursor;
  }
  return out;
}

/** The first ACTIVE connection for a toolkit, or null. */
export async function activeConnection(toolkit: 'facebook' | 'metaads' | 'instagram'): Promise<ComposioConnection | null> {
  const all = await listConnections(toolkit);
  return all.find((c) => c.status === 'ACTIVE') ?? null;
}

// ── Execute ───────────────────────────────────────────────────────────

export interface FbCallTarget {
  area: FbApiArea;
  /** Composio connected account id (fb_pages.connection_id / fb_ad_accounts.connection_id). */
  connectionId: string;
  /** Composio user_id owning that connection (fb_pages.entity_id). */
  entityId: string;
}

/**
 * Runs one Composio tool. Returns the tool's `data`. Throws a typed error
 * (see above) on failure. Pass local media paths (inside FB_MEDIA_DIR) for
 * file_uploadable params.
 */
export async function execute<T = Record<string, unknown>>(
  slug: string,
  args: Record<string, unknown>,
  target: FbCallTarget,
): Promise<T> {
  chargeBudget();
  const start = Date.now();
  let ok = false;
  try {
    const result = await getComposio().tools.execute(slug, {
      userId: target.entityId,
      connectedAccountId: target.connectionId,
      arguments: args,
      dangerouslySkipVersionCheck: true,
    });
    if (!result.successful) {
      throw classifyComposioError(new Error(result.error ?? `${slug} failed`));
    }
    ok = true;
    return result.data as T;
  } catch (err) {
    throw classifyComposioError(err);
  } finally {
    recordFbApiCall(target.area, ok);
    logger.info({ slug, area: target.area, ok, durationMs: Date.now() - start }, 'fbstudio composio call');
  }
}

// ── Acting as the Page ────────────────────────────────────────────────
// Composio's facebook connection holds a USER token. Page-scoped writes
// (hide a comment, like as the Page, private reply, multi-photo feed post)
// need a PAGE token. We fetch it through Composio when needed and keep it
// only in memory: never stored, never logged, never returned to a caller.

const PAGE_TOKEN_TTL_MS = 50 * 60 * 1000;
const pageTokens = new Map<string, { token: string; at: number }>();

function collectPageTokens(node: unknown, out: Map<string, string>): void {
  if (Array.isArray(node)) { for (const n of node) collectPageTokens(n, out); return; }
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if (typeof o.id === 'string' && typeof o.access_token === 'string' && o.access_token) out.set(o.id, o.access_token);
  for (const v of Object.values(o)) if (v && typeof v === 'object') collectPageTokens(v, out);
}

async function pageAccessToken(pageId: string, target: FbCallTarget): Promise<string> {
  getComposio(); // Recheck the shared key before using a cached Page token.
  const hit = pageTokens.get(pageId);
  if (hit && Date.now() - hit.at < PAGE_TOKEN_TTL_MS) return hit.token;
  const data = await execute<unknown>('FACEBOOK_LIST_MANAGED_PAGES', { fields: 'id,access_token', limit: 100 }, { ...target, area: 'pages' });
  const found = new Map<string, string>();
  collectPageTokens(data, found);
  const now = Date.now();
  for (const [id, token] of found) pageTokens.set(id, { token, at: now });
  const token = found.get(pageId);
  if (!token) throw new Error(`No Page token for page ${pageId} on this connection`);
  return token;
}

/** Test hook: forget cached Page tokens. */
export function _clearPageTokens(): void {
  pageTokens.clear();
}

/**
 * Calls the Graph API directly as the Page, with a Page token obtained
 * through Composio. Use for Page-scoped writes the user token cannot do.
 * JSON bodies only. Non-2xx responses throw a typed error (token-free message).
 */
export async function graphAsPage<T = unknown>(pageId: string, req: GraphProxyRequest, target: FbCallTarget): Promise<GraphProxyResponse<T>> {
  const token = await pageAccessToken(pageId, target);
  chargeBudget();
  const start = Date.now();
  let ok = false;
  const safePath = req.path.replace(/\d{6,}/g, ':id');
  try {
    const url = new URL(req.path.startsWith('http') ? req.path : `${GRAPH_BASE}${req.path.startsWith('/') ? '' : '/'}${req.path}`);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, String(v));
    url.searchParams.set('access_token', token);
    const res = await fetch(url, {
      method: req.method,
      headers: req.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
    });
    const text = await res.text();
    let data: unknown = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (!res.ok) {
      const errObj = (data as { error?: { message?: string; code?: number; type?: string } } | null)?.error;
      if (errObj?.code === 190) pageTokens.delete(pageId);
      const detail = errObj ? JSON.stringify({ message: errObj.message, code: errObj.code, type: errObj.type }) : String(text).slice(0, 200);
      throw classifyComposioError(Object.assign(new Error(`graph-as-page ${req.method} ${safePath} → ${res.status}: ${detail}`), { statusCode: res.status }));
    }
    ok = true;
    return { status: res.status, data: data as T };
  } catch (err) {
    throw classifyComposioError(err);
  } finally {
    recordFbApiCall(target.area, ok);
    logger.info({ path: safePath, method: req.method, area: target.area, ok, durationMs: Date.now() - start }, 'fbstudio graph-as-page call');
  }
}

export interface GraphProxyRequest {
  /** Graph path such as `/{page-id}/video_reels` or an absolute https URL. */
  path: string;
  method: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, string | number | boolean>;
  body?: unknown;
}

export interface GraphProxyResponse<T = unknown> {
  status: number;
  data: T;
}

/**
 * Calls the Graph API through Composio's proxy with the connection's token,
 * for operations that have no Composio tool (Reels, private replies, hiding
 * comments). JSON bodies only. Non-2xx responses throw a typed error.
 */
export async function graphProxy<T = unknown>(req: GraphProxyRequest, target: FbCallTarget): Promise<GraphProxyResponse<T>> {
  chargeBudget();
  const start = Date.now();
  let ok = false;
  try {
    const endpoint = req.path.startsWith('http') ? req.path : `${GRAPH_BASE}${req.path.startsWith('/') ? '' : '/'}${req.path}`;
    const parameters = Object.entries(req.query ?? {}).map(([name, value]) => ({
      in: 'query' as const,
      name,
      value: typeof value === 'boolean' ? String(value) : value,
    }));
    const res = await getComposio().tools.proxyExecute({
      endpoint,
      method: req.method,
      connectedAccountId: target.connectionId,
      ...(req.body !== undefined ? { body: req.body } : {}),
      ...(parameters.length ? { parameters } : {}),
    });
    const status = (res as { status?: number }).status ?? 0;
    const data = (res as { data?: unknown }).data as T;
    if (status < 200 || status >= 300) {
      throw classifyComposioError(Object.assign(new Error(`graph ${req.method} ${req.path} → ${status}: ${JSON.stringify(data).slice(0, 300)}`), { statusCode: status }));
    }
    ok = true;
    return { status, data };
  } catch (err) {
    throw classifyComposioError(err);
  } finally {
    recordFbApiCall(target.area, ok);
    logger.info({ path: req.path.replace(/\d{6,}/g, ':id'), method: req.method, area: target.area, ok, durationMs: Date.now() - start }, 'fbstudio graph proxy call');
  }
}
