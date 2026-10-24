/**
 * Pancake HTTP clients: POS (orders, customers, stock) and Pages (chat).
 *
 * Both services put the credential in the URL query string (`?api_key=` /
 * `?page_access_token=`). That makes the URL itself a secret, so nothing here
 * ever puts a URL, a key or a token into an error message; messages come from
 * the response body and are scrubbed of the credential as a second line of
 * defence. No imports with side effects: only ../types.js and global fetch.
 */
import { IntegrationApiError, IntegrationUsageError } from '../types.js';

export const POS_BASE_URL = 'https://pos.pages.fm/api/v1';
export const PAGES_BASE_URL = 'https://pages.fm/api/public_api';

const DEFAULT_TIMEOUT_MS = 30_000;
/** Back-off before each retry on HTTP 429 (a Retry-After header wins). */
const RETRY_DELAYS_MS = [1_000, 3_000];
const MAX_RETRY_AFTER_MS = 10_000;

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface PancakeHttpOptions {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchImpl;
  /** The caller's cancellation, combined with the 30 s timeout. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injectable for tests so retries do not wait. */
  sleepImpl?: (ms: number) => Promise<void>;
}

type QueryValue = string | number | boolean | undefined | null | Array<string | number>;
export type Query = Record<string, QueryValue>;

interface RequestSpec {
  service: string;
  baseUrl: string;
  authParam: string;
  secret: string;
  method?: 'GET' | 'POST' | 'PUT';
  path: string;
  query?: Query;
  body?: unknown;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Array values use the `key[]` form Pancake expects (`filter_status[]=1&filter_status[]=2`). */
export function buildQueryString(query: Query | undefined, authParam: string, secret: string): string {
  const params = new URLSearchParams();
  params.set(authParam, secret);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      const name = key.endsWith('[]') ? key : `${key}[]`;
      for (const item of value) params.append(name, String(item));
    } else {
      params.set(key, String(value));
    }
  }
  return params.toString();
}

function scrub(text: string, secret: string): string {
  let out = text;
  if (secret) out = out.split(secret).join('***');
  // Strip full URLs so no endpoint path, query, or credential leaks into user-facing errors
  out = out.replace(/https?:\/\/[^\s"'<>]+/gi, '[url]');
  out = out.replace(/(api_key|page_access_token)=[^&\s"']+/gi, '$1=***');
  return out;
}

/** Pulls a short human message out of a Pancake error body. */
function errorMessageFromBody(body: unknown): string {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body.slice(0, 200) : '';
  const o = body as Record<string, unknown>;
  for (const key of ['message', 'error', 'message_code']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 300);
    if (v && typeof v === 'object') {
      const nested = (v as Record<string, unknown>).message;
      if (typeof nested === 'string' && nested.trim()) return nested.trim().slice(0, 300);
    }
  }
  return '';
}

function httpHint(status: number): string {
  if (status === 401 || status === 403) return 'credential rejected: ask the owner to re-enter it in Integrations';
  if (status === 404) return 'not found';
  if (status === 429) return 'rate limited, try again in a few seconds';
  if (status >= 500) return 'Pancake server error, try again later';
  return 'request failed';
}

async function pancakeRequest<T>(spec: RequestSpec, opts: PancakeHttpOptions): Promise<T> {
  const fetchImpl: FetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = opts.sleepImpl ?? defaultSleep;
  const method = spec.method ?? 'GET';
  const url = `${spec.baseUrl}${spec.path}?${buildQueryString(spec.query, spec.authParam, spec.secret)}`;

  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        signal,
        headers: spec.body !== undefined
          ? { 'Content-Type': 'application/json', Accept: 'application/json' }
          : { Accept: 'application/json' },
        body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
      });
    } catch {
      // The fetch error can embed the URL (and so the credential): drop it.
      if (opts.signal?.aborted) throw new IntegrationApiError(`${spec.service}: request cancelled`);
      if (timeout.aborted) throw new IntegrationApiError(`${spec.service}: timed out, try again`);
      throw new IntegrationApiError(`${spec.service}: could not reach the server (network error)`);
    }

    if (res.status === 429 && attempt < RETRY_DELAYS_MS.length) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
        : RETRY_DELAYS_MS[attempt];
      await sleep(wait);
      continue;
    }

    let text = '';
    try { text = await res.text(); } catch { /* treated as an empty body */ }
    let body: unknown = undefined;
    if (text) {
      try { body = JSON.parse(text); } catch { body = undefined; }
    }

    const failedFlag = !!body && typeof body === 'object' && (body as Record<string, unknown>).success === false;
    if (!res.ok || failedFlag) {
      const fromBody = scrub(errorMessageFromBody(body), spec.secret);
      const detail = fromBody || httpHint(res.status);
      const suffix = res.ok ? '' : ` (HTTP ${res.status})`;
      throw new IntegrationApiError(`${spec.service}: ${detail}${suffix}`, res.status);
    }
    if (body === undefined) {
      if (!text) return {} as T;
      throw new IntegrationApiError(`${spec.service}: unexpected non-JSON response`, res.status);
    }
    return body as T;
  }
}

// ── Pancake POS ─────────────────────────────────────────────────────────

export interface PosShop {
  id: number;
  name: string;
  avatar_url?: string;
  preferred_shop?: boolean;
  pages?: Array<{ id: string; name?: string; platform?: string }>;
}

export interface ListOrdersParams {
  pageSize?: number;
  pageNumber?: number;
  search?: string;
  filterStatus?: number[];
  /** Unix seconds. */
  startDateTime?: number;
  endDateTime?: number;
  /** Which time field the range applies to: inserted_at (default) or updated_at. */
  updateStatus?: string;
  optionSort?: string;
  customerId?: string;
}

export interface ListParams {
  pageSize?: number;
  pageNumber?: number;
  search?: string;
}

export interface ListVariationsParams extends ListParams {
  /** Only variations whose sellable quantity is <= this (all warehouses). */
  remainAtMost?: number;
}

export interface PancakePosClientOptions extends PancakeHttpOptions {
  apiKey: string;
  shopId?: string | number;
}

/** Unwraps `{data: x}` when the response is wrapped, returns the bare object otherwise. */
export function unwrapEntity(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const o = body as Record<string, unknown>;
  const inner = o.data;
  if (inner && typeof inner === 'object' && !Array.isArray(inner) && o.id === undefined) {
    return inner as Record<string, unknown>;
  }
  return o;
}

export function createPancakePosClient(options: PancakePosClientOptions) {
  const { apiKey } = options;
  const shopId = options.shopId === undefined || options.shopId === '' ? undefined : String(options.shopId);

  const call = <T = any>(
    path: string,
    extra: { method?: 'GET' | 'POST' | 'PUT'; query?: Query; body?: unknown } = {},
  ) => pancakeRequest<T>({
    service: 'Pancake POS',
    baseUrl: POS_BASE_URL,
    authParam: 'api_key',
    secret: apiKey,
    path,
    ...extra,
  }, options);

  const shopPath = (suffix: string): string => {
    if (!shopId) {
      throw new IntegrationUsageError(
        'Chưa có shop id. Chạy `shops` để xem danh sách shop rồi truyền --shop <id>, hoặc nhập Shop ID ở trang Integrations.',
      );
    }
    return `/shops/${encodeURIComponent(shopId)}${suffix}`;
  };

  const listQuery = (p: ListParams): Query => ({
    page_size: p.pageSize,
    page_number: p.pageNumber,
    search: p.search,
  });

  return {
    shopId,

    async listShops(): Promise<PosShop[]> {
      const body = await call<{ shops?: PosShop[] }>('/shops');
      return Array.isArray(body.shops) ? body.shops : [];
    },

    listOrders(p: ListOrdersParams = {}) {
      return call(shopPath('/orders'), {
        query: {
          ...listQuery(p),
          'filter_status[]': p.filterStatus,
          startDateTime: p.startDateTime,
          endDateTime: p.endDateTime,
          updateStatus: p.startDateTime !== undefined || p.endDateTime !== undefined ? p.updateStatus : undefined,
          option_sort: p.optionSort,
          customer_id: p.customerId,
        },
      });
    },

    async getOrder(orderId: string | number): Promise<Record<string, unknown>> {
      return unwrapEntity(await call(shopPath(`/orders/${encodeURIComponent(String(orderId))}`)));
    },

    createOrder(body: Record<string, unknown>) {
      return call(shopPath('/orders'), { method: 'POST', body });
    },

    updateOrder(orderId: string | number, patch: Record<string, unknown>) {
      return call(shopPath(`/orders/${encodeURIComponent(String(orderId))}`), { method: 'PUT', body: patch });
    },

    listCustomers(p: ListParams & { customerIds?: string } = {}) {
      return call(shopPath('/customers'), { query: { ...listQuery(p), customer_ids: p.customerIds } });
    },

    async getCustomer(customerId: string): Promise<Record<string, unknown>> {
      return unwrapEntity(await call(shopPath(`/customers/${encodeURIComponent(customerId)}`)));
    },

    listVariations(p: ListVariationsParams = {}) {
      return call(shopPath('/products/variations'), {
        query: {
          ...listQuery(p),
          remainQuantity: p.remainAtMost !== undefined
            ? JSON.stringify({ type: 'smallerOrEqual', value: p.remainAtMost, warehouseId: 'all' })
            : undefined,
        },
      });
    },

    async listWarehouses(): Promise<Array<Record<string, unknown>>> {
      const body = await call<{ data?: Array<Record<string, unknown>>; warehouses?: Array<Record<string, unknown>> }>(
        shopPath('/warehouses'),
      );
      return Array.isArray(body.data) ? body.data : Array.isArray(body.warehouses) ? body.warehouses : [];
    },
  };
}

export type PancakePosClient = ReturnType<typeof createPancakePosClient>;

// ── Pancake Pages (chat) ────────────────────────────────────────────────

export interface ListConversationsParams {
  /** Cursor: id of the last conversation of the previous page. */
  lastConversationId?: string;
  /** INBOX and/or COMMENT. */
  types?: Array<'INBOX' | 'COMMENT'>;
  /** Tag ids, comma separated. */
  tags?: string;
  since?: number;
  until?: number;
  unreadFirst?: boolean;
  orderBy?: string;
}

export interface PancakePagesClientOptions extends PancakeHttpOptions {
  pageId: string;
  pageAccessToken: string;
}

export function createPancakePagesClient(options: PancakePagesClientOptions) {
  const { pageId, pageAccessToken } = options;
  const page = `/pages/${encodeURIComponent(pageId)}`;

  const call = <T = any>(
    path: string,
    extra: { method?: 'GET' | 'POST' | 'PUT'; query?: Query; body?: unknown } = {},
  ) => pancakeRequest<T>({
    service: `Pancake chat (page ${pageId})`,
    baseUrl: PAGES_BASE_URL,
    authParam: 'page_access_token',
    secret: pageAccessToken,
    path,
    ...extra,
  }, options);

  return {
    pageId,

    listConversations(p: ListConversationsParams = {}) {
      return call(`/v2${page}/conversations`, {
        query: {
          last_conversation_id: p.lastConversationId,
          'type[]': p.types,
          tags: p.tags,
          since: p.since,
          until: p.until,
          unread_first: p.unreadFirst ? 'true' : undefined,
          order_by: p.orderBy,
        },
      });
    },

    getMessages(conversationId: string, offset?: number) {
      return call(`/v1${page}/conversations/${encodeURIComponent(conversationId)}/messages`, {
        query: { current_count: offset },
      });
    },

    replyInbox(conversationId: string, text: string) {
      return call(`/v1${page}/conversations/${encodeURIComponent(conversationId)}/messages`, {
        method: 'POST',
        body: { action: 'reply_inbox', message: text },
      });
    },

    async listTags(): Promise<Array<{ id: string | number; text?: string; color?: string }>> {
      const body = await call<{ tags?: Array<{ id: string | number; text?: string; color?: string }> }>(
        `/v1${page}/tags`,
      );
      return Array.isArray(body.tags) ? body.tags : [];
    },

    setConversationTag(conversationId: string, tagId: string, action: 'add' | 'remove') {
      return call(`/v1${page}/conversations/${encodeURIComponent(conversationId)}/tags`, {
        method: 'POST',
        body: { action, tag_id: tagId },
      });
    },
  };
}

export type PancakePagesClient = ReturnType<typeof createPancakePagesClient>;

// ── Helpers shared with commands ────────────────────────────────────────

/**
 * Parses the stored `page_tokens` field: one `page_id:token` per entry,
 * separated by commas, spaces or newlines. Splits at the first colon only.
 * Malformed entries are skipped; a repeated page id keeps the last token.
 */
export function parsePageTokens(raw: string | undefined): Array<{ pageId: string; token: string }> {
  const byPage = new Map<string, string>();
  for (const part of (raw ?? '').split(/[\s,;]+/)) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const pageId = part.slice(0, idx).trim();
    const token = part.slice(idx + 1).trim();
    if (pageId && token) byPage.set(pageId, token);
  }
  return [...byPage].map(([pageId, token]) => ({ pageId, token }));
}

export interface OrderStatusInfo {
  code: number;
  name: string;
  aliases: string[];
}

export const ORDER_STATUSES: OrderStatusInfo[] = [
  { code: 0, name: 'New', aliases: ['moi', 'don-moi'] },
  { code: 17, name: 'Waiting for confirmation', aliases: ['cho-xac-nhan'] },
  { code: 11, name: 'Restocking', aliases: ['cho-hang'] },
  { code: 12, name: 'Wait for printing', aliases: ['waiting-for-printing', 'cho-in'] },
  { code: 13, name: 'Printed', aliases: ['da-in'] },
  { code: 20, name: 'Purchased', aliases: ['da-dat-hang', 'da-mua-hang'] },
  { code: 1, name: 'Confirmed', aliases: ['da-xac-nhan'] },
  { code: 8, name: 'Packaging', aliases: ['dang-dong-hang', 'dang-dong-goi'] },
  { code: 9, name: 'Waiting for pick up', aliases: ['waiting-for-pickup', 'cho-chuyen-hang', 'cho-lay-hang'] },
  { code: 2, name: 'Shipped', aliases: ['da-gui-hang', 'dang-giao'] },
  { code: 3, name: 'Received', aliases: ['da-nhan', 'da-nhan-hang'] },
  { code: 16, name: 'Collected money', aliases: ['da-thu-tien'] },
  { code: 4, name: 'Returning', aliases: ['dang-hoan'] },
  { code: 15, name: 'Partial return', aliases: ['hoan-mot-phan'] },
  { code: 5, name: 'Returned', aliases: ['da-hoan'] },
  { code: 6, name: 'Canceled', aliases: ['cancelled', 'huy', 'da-huy'] },
  { code: 7, name: 'Deleted recently', aliases: ['deleted', 'da-xoa', 'xoa'] },
];

/** Lowercase, no diacritics, no separators: "Đã xác nhận" and "da-xac-nhan" compare equal. */
function statusKey(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const STATUS_BY_KEY: Map<string, OrderStatusInfo> = (() => {
  const map = new Map<string, OrderStatusInfo>();
  for (const s of ORDER_STATUSES) {
    map.set(statusKey(s.name), s);
    for (const alias of s.aliases) map.set(statusKey(alias), s);
  }
  return map;
})();

export function orderStatusName(code: unknown): string {
  const hit = ORDER_STATUSES.find((s) => s.code === Number(code));
  return hit ? hit.name : 'Unknown';
}

/** A status code or an English/Vietnamese name → the numeric code, or null when unknown. */
export function parseOrderStatus(input: string | number): number | null {
  const text = String(input).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const code = Number(text);
    return ORDER_STATUSES.some((s) => s.code === code) ? code : null;
  }
  return STATUS_BY_KEY.get(statusKey(text))?.code ?? null;
}

const DURATION_UNIT_SECONDS: Record<string, number> = {
  m: 60,
  h: 3600,
  d: 86_400,
  w: 7 * 86_400,
};

/**
 * A relative duration ("24h", "7d", "30m", "2w" → that long ago), a date
 * ("2026-10-01", read as Vietnam time; with `endOfDay` the last second of
 * that day), an ISO datetime, or a unix timestamp (seconds or milliseconds)
 * → unix seconds. Throws IntegrationUsageError on anything else.
 */
export function parseTimeArg(input: string, opts: { now?: number; endOfDay?: boolean } = {}): number {
  const text = String(input).trim();
  const nowMs = opts.now ?? Date.now();

  const rel = /^(\d+)\s*([mhdw])$/i.exec(text);
  if (rel) return Math.floor(nowMs / 1000) - Number(rel[1]) * DURATION_UNIT_SECONDS[rel[2].toLowerCase()];

  if (/^\d{9,}$/.test(text)) {
    const n = Number(text);
    return n > 1e11 ? Math.floor(n / 1000) : n;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const start = Date.parse(`${text}T00:00:00+07:00`);
    if (!Number.isNaN(start)) return Math.floor(start / 1000) + (opts.endOfDay ? 86_399 : 0);
  } else if (/^\d{4}-\d{2}-\d{2}[T ]/.test(text)) {
    const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text.replace(' ', 'T')}+07:00`);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }

  throw new IntegrationUsageError(
    `Không hiểu mốc thời gian "${text}". Dùng 24h, 7d, 2w, ngày dạng 2026-10-01 hoặc unix timestamp.`,
  );
}
