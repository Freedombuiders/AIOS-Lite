/**
 * Thin adapter from the Care `ZaloTransport` port to the real legacy Zalo code (src/zalo/**).
 *
 * What it reuses, READ-ONLY: the session pool (`getApi`, live status, QR login, the nick's own uid),
 * the shared `ZaloLimiter` (daily / burst budgets), `classifyZaloError`, `startOfLocalDayMs`, and the
 * zca-js `API` object itself (`sendMessage`, `getGroupChatHistory`, `getUserInfo`, `getGroupInfo`, the
 * websocket `listener`).
 *
 * What it deliberately does NOT reuse, and why:
 *  - `ZaloSender.sendText/sendRich`: they insert a `zalo_messages` row before the call and delete or
 *    update it afterwards (and register a pending echo). The Care connector must not write `zalo_*`
 *    tables, so the send goes straight to `api.sendMessage`.
 *  - `ingestMessage` / `history.ts` paging: they upsert `zalo_threads`/`zalo_messages`. The adapter
 *    attaches its own listener to the same websocket and buffers raw payloads for `sync`.
 *  - The sender's automatic reconnect-and-retry and transient-network retry: a retry after the request
 *    may have left the process can double-send. Here a network failure is reported as such and the
 *    Care outbox decides (uncertain -> reconcile / manual review).
 *
 * Gaps versus what Care would like (reported, not papered over): no quoted replies, no seen marker, no
 * attachment sending through DeliveryCommand, the daily message count in `ZaloLimiter` is read from
 * `zalo_messages` (messages sent by Care are not in it, hence `coreSentToday`), the restriction
 * auto-lock lives inside `ZaloSender` and is therefore not applied to Care sends (the adapter only
 * HONOURS an existing lock via `sendState`).
 */

import { ThreadType } from 'zca-js';
import { getZaloAccount } from '../../store.js';
import { classifyZaloError, getZaloProtectionSettings, startOfLocalDayMs } from '../../limits.js';
import {
  ZaloTransportError,
  type ZaloAuthStart,
  type ZaloFeatures,
  type ZaloLiveItem,
  type ZaloLivePage,
  type ZaloRateStatus,
  type ZaloRawMessage,
  type ZaloRawUndo,
  type ZaloSeenTarget,
  type ZaloSendAck,
  type ZaloSendRequest,
  type ZaloThreadKind,
  type ZaloTransport,
} from './transport.js';

// ── structural views of the legacy objects (so tests can stand in without zca-js or a DB) ────

export interface ZcaListenerLike {
  on(event: string, handler: (...args: any[]) => void): unknown;
  off(event: string, handler: (...args: any[]) => void): unknown;
  requestOldMessages(type: number, cursor: string | null): unknown;
}

export interface ZcaApiLike {
  sendMessage(content: { msg: string; quote?: Record<string, unknown> }, threadId: string, type: number): Promise<{ message?: { msgId?: number | string } | null }>;
  /** zca-js `sendSeenEvent`; present on the real API object, optional here so older fakes keep compiling. */
  sendSeenEvent?(messages: Record<string, unknown> | Array<Record<string, unknown>>, type?: number): Promise<{ status?: number }>;
  getGroupChatHistory(groupId: string, count: number): Promise<{ groupMsgs?: unknown[] }>;
  getUserInfo(uid: string): Promise<{ changed_profiles?: Record<string, Record<string, unknown>> }>;
  getGroupInfo(groupId: string): Promise<{ gridInfoMap?: Record<string, Record<string, unknown>> }>;
  listener: ZcaListenerLike;
}

export interface ZcaQrStateLike {
  image: string | null;
  phase: string;
  error?: string;
}

/** The subset of `ZaloSessionPool` the adapter touches. */
export interface ZcaPoolLike {
  getApi(accountId: string): ZcaApiLike | null;
  getContext(accountId: string): { ownUid: string } | null;
  getLiveStatus(accountId: string): string;
  getQrState(accountId: string): ZcaQrStateLike | null;
  startQrLogin(accountId: string): void;
}

/** The subset of `ZaloLimiter` the adapter touches. */
export interface ZcaLimiterLike {
  check(accountId: string, category: 'message', count?: number): { ok: boolean; reason?: 'daily' | 'burst'; used: number; limit: number; retryAfterMs?: number };
  consume(accountId: string, category: 'query' | 'group_read', count?: number): { ok: boolean };
  record(accountId: string, category: 'message', count?: number): void;
  limitFor(accountId: string, category: 'message'): { daily: number };
}

export interface ZcaTransportDeps {
  pool: ZcaPoolLike;
  limiter: ZcaLimiterLike;
  /** Operator switches on the legacy account row (chat_enabled, send_lock_reason); null when unknown. */
  sendState: (accountId: string) => { chatEnabled: boolean; sendLockReason: string } | null;
  /**
   * Messages Care itself sent today. The limiter's daily count comes from `zalo_messages`, which Care
   * sends are not written to, so without this the daily cap would be undercounted. Default: in-memory.
   */
  coreSentToday?: (accountId: string, nowMs: number) => number;
  now?: () => number;
  /** Start of the nick's local day; default reads the legacy protection settings (timezone). */
  dayStartMs?: (nowMs: number) => number;
  fetchImpl?: typeof fetch;
  bufferLimit?: number;
  /**
   * OPT-IN, default OFF, NOT verified against the native service. Quoted replies (zca-js `SendMessageQuote`) built from
   * the quoted message's stored wire data. When off, `features().quote` is false and a quoted reply goes to review.
   */
  quoteReplies?: boolean;
  /** OPT-IN, default OFF, NOT verified natively: the seen marker (`sendSeenEvent`). When off, `features().markRead` is false. */
  seenMarker?: boolean;
}

/** Read-only view of the operator switches on the legacy account row (the nick's lock is honoured, never set). */
export function legacySendState(accountId: string): { chatEnabled: boolean; sendLockReason: string } | null {
  const acc = getZaloAccount(accountId);
  return acc ? { chatEnabled: Boolean(acc.chat_enabled), sendLockReason: acc.send_lock_reason ?? '' } : null;
}

const SESSION_EXPIRED = [
  'session expired', 'session has expired', 'not logged in', 'login required',
  'cookie expired', 'cookie is invalid', 'invalid session', 'invalid token',
];
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

/** Downloads media bytes from a (pre-validated) CDN URL: https only is the caller's job; here size, redirects, status. */
export async function fetchMediaBytes(doFetch: typeof fetch, url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(url, { signal: ctrl.signal, redirect: 'error' });
    if (!res.ok) throw new ZaloTransportError('unknown', `Media fetch failed (${res.status})`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MEDIA_MAX_BYTES) throw new ZaloTransportError('unknown', 'Media is larger than the 25 MB limit');
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MEDIA_MAX_BYTES) throw new ZaloTransportError('unknown', 'Media is larger than the 25 MB limit');
    return { buffer, mimeType: (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim() };
  } finally {
    clearTimeout(timer);
  }
}

interface Feed {
  id: string;
  seq: number;
  items: ZaloLiveItem[];
  gap: boolean;
  attachedTo: ZcaApiLike | null;
  detach: (() => void) | null;
}

type Obj = Record<string, unknown>;
type DistributiveOmitSeq<T> = T extends unknown ? Omit<T, 'seq'> : never;

export class ZcaZaloTransport implements ZaloTransport {
  private readonly feeds = new Map<string, Feed>();
  private readonly coreCounts = new Map<string, { day: number; n: number }>();
  private feedCounter = 0;

  constructor(private readonly deps: ZcaTransportDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private dayStart(nowMs: number): number {
    return this.deps.dayStartMs
      ? this.deps.dayStartMs(nowMs)
      : startOfLocalDayMs(new Date(nowMs), getZaloProtectionSettings().timezone);
  }

  ownUid(accountId: string): string | null {
    return this.deps.pool.getContext(accountId)?.ownUid ?? null;
  }

  isConnected(accountId: string): boolean {
    return this.deps.pool.getLiveStatus(accountId) === 'connected' && this.deps.pool.getApi(accountId) !== null;
  }

  private locked(accountId: string): boolean {
    const s = this.deps.sendState(accountId);
    return s !== null && (!s.chatEnabled || s.sendLockReason !== '');
  }

  features(accountId: string): ZaloFeatures {
    return {
      text: !this.locked(accountId),
      // The legacy sender never builds zca-js's SendMessageQuote (it needs content/ts/ttl of the quoted
      // message, which zalo_messages does not keep) and nothing in it calls sendSeenEvent. Care keeps that wire data in
      // the canonical message (rawEnvelope.wire), so both are possible, but only behind an explicit opt-in: not native-verified.
      quote: this.deps.quoteReplies === true,
      typing: true,
      markRead: this.deps.seenMarker === true,
      sendMedia: [],
      fetchMedia: true,
      history: { group: true, directPush: true },
    };
  }

  // ── budgets ──────────────────────────────────────────────────────────────────────────────
  private coreSent(accountId: string, nowMs: number): number {
    if (this.deps.coreSentToday) return this.deps.coreSentToday(accountId, nowMs);
    const day = this.dayStart(nowMs);
    const c = this.coreCounts.get(accountId);
    return c && c.day === day ? c.n : 0;
  }

  private noteCoreSend(accountId: string, nowMs: number): void {
    const day = this.dayStart(nowMs);
    const c = this.coreCounts.get(accountId);
    this.coreCounts.set(accountId, c && c.day === day ? { day, n: c.n + 1 } : { day, n: 1 });
  }

  rateStatus(accountId: string): ZaloRateStatus {
    if (this.locked(accountId)) return { ok: false, reason: 'locked' };
    const now = this.now();
    const check = this.deps.limiter.check(accountId, 'message', 1);
    if (!check.ok) {
      return { ok: false, reason: check.reason, retryAfterMs: check.retryAfterMs ?? (check.reason === 'daily' ? this.untilNextDay(now) : 60_000) };
    }
    const dailyLimit = this.deps.limiter.limitFor(accountId, 'message').daily;
    if (check.used + this.coreSent(accountId, now) + 1 > dailyLimit) {
      return { ok: false, reason: 'daily', retryAfterMs: this.untilNextDay(now) };
    }
    return { ok: true };
  }

  private untilNextDay(nowMs: number): number {
    return Math.max(60_000, this.dayStart(nowMs) + 24 * 3600_000 - nowMs);
  }

  // ── send ─────────────────────────────────────────────────────────────────────────────────
  async send(accountId: string, request: ZaloSendRequest): Promise<ZaloSendAck> {
    const api = this.deps.pool.getApi(accountId);
    if (!api) throw new ZaloTransportError('not_connected', 'Nick Zalo chưa kết nối');
    if (this.locked(accountId)) throw new ZaloTransportError('send_locked', 'Nick đang bị khoá gửi hoặc đã tắt gửi tin');
    // never downgrade a quoted reply to a plain message: with quoting off the request is refused before anything is spent or sent
    if (request.quote && this.deps.quoteReplies !== true) throw new ZaloTransportError('rejected', 'Quoted replies are not enabled for this transport');
    const status = this.rateStatus(accountId);
    if (!status.ok) {
      throw new ZaloTransportError(status.reason === 'locked' ? 'send_locked' : 'rate_limited', `Zalo budget: ${status.reason ?? 'limit'}`, status.retryAfterMs);
    }
    const now = this.now();
    // Counted before the call, like the legacy sender: a lost ack still spent the budget.
    this.deps.limiter.record(accountId, 'message', 1);
    this.noteCoreSend(accountId, now);
    try {
      const res = await api.sendMessage(
        { msg: request.text, ...(request.quote ? { quote: { ...request.quote } } : {}) },
        request.threadId,
        request.threadKind === 'group' ? ThreadType.Group : ThreadType.User,
      );
      const msgId = res?.message?.msgId;
      return { ...(msgId !== undefined && msgId !== null && String(msgId) !== '' ? { msgId: String(msgId) } : {}), tsMs: this.now() };
    } catch (err) {
      throw this.classify(err);
    }
  }

  private classify(err: unknown): ZaloTransportError {
    if (err instanceof ZaloTransportError) return err;
    const message = String((err as Error)?.message ?? err);
    const lower = message.toLowerCase();
    if (SESSION_EXPIRED.some((p) => lower.includes(p))) return new ZaloTransportError('session_expired', message);
    const cls = classifyZaloError(err);
    if (cls === 'RATE_LIMIT') return new ZaloTransportError('rate_limited', message, 60_000);
    if (cls === 'NICK_OFFLINE') return new ZaloTransportError('not_connected', message);
    if (cls === 'LOCKED') return new ZaloTransportError('send_locked', message);
    if (cls === 'NOT_IN_GROUP' || cls.startsWith('ZALO_')) return new ZaloTransportError('rejected', message);
    if (cls === 'NETWORK') return new ZaloTransportError('network', message);
    return new ZaloTransportError('unknown', message);
  }

  // ── live feed ────────────────────────────────────────────────────────────────────────────
  private feed(accountId: string): Feed {
    let feed = this.feeds.get(accountId);
    if (!feed) {
      this.feedCounter += 1;
      // A fresh feed = a fresh process or first attach: whatever happened before is not in the buffer.
      feed = { id: `zca-${this.now().toString(36)}-${this.feedCounter}`, seq: 0, items: [], gap: true, attachedTo: null, detach: null };
      this.feeds.set(accountId, feed);
    }
    const api = this.deps.pool.getApi(accountId);
    if (api && feed.attachedTo !== api) {
      if (feed.attachedTo) feed.gap = true; // reconnected: the websocket was down for an unknown time
      feed.detach?.();
      feed.attachedTo = api;
      feed.detach = this.attach(accountId, feed, api);
    }
    return feed;
  }

  private attach(accountId: string, feed: Feed, api: ZcaApiLike): () => void {
    const limit = this.deps.bufferLimit ?? 5000;
    const push = (item: DistributiveOmitSeq<ZaloLiveItem>) => {
      feed.items.push({ ...item, seq: ++feed.seq } as ZaloLiveItem);
      if (feed.items.length > limit) {
        feed.items.splice(0, feed.items.length - limit);
        feed.gap = true; // overflow: the oldest unacknowledged items are gone
      }
    };
    const toRaw = (m: Obj, fallbackType?: number): ZaloRawMessage => ({
      threadKind: ((m.type as number | undefined) ?? fallbackType) === ThreadType.Group ? 'group' : 'user',
      threadId: String(m.threadId ?? ''),
      isSelf: Boolean(m.isSelf),
      data: (m.data ?? {}) as ZaloRawMessage['data'],
    });
    const onMessage = (m: Obj) => push({ kind: 'message', origin: 'live', message: toRaw(m) });
    const onOld = (batch: Obj[], type: number) => {
      if (!Array.isArray(batch)) return;
      for (const m of batch) push({ kind: 'message', origin: 'history', message: toRaw(m, type) });
    };
    const onUndo = (u: ZaloRawUndo) => push({ kind: 'undo', undo: u });
    api.listener.on('message', onMessage);
    api.listener.on('old_messages', onOld);
    api.listener.on('undo', onUndo);
    return () => {
      api.listener.off('message', onMessage);
      api.listener.off('old_messages', onOld);
      api.listener.off('undo', onUndo);
    };
  }

  /** Starts buffering the websocket of a connected nick (the daemon calls this when a core nick comes up). */
  startListening(accountId: string): void {
    this.feed(accountId);
  }

  peekLive(accountId: string, limit: number): ZaloLivePage {
    const feed = this.feed(accountId);
    const items = feed.items.slice(0, limit);
    const gap = feed.gap;
    feed.gap = false; // reported once, to exactly one sync result
    return { feedId: feed.id, items, hasMore: feed.items.length > items.length, gap };
  }

  ackLive(accountId: string, feedId: string, upToSeq: number): void {
    const feed = this.feeds.get(accountId);
    if (!feed || feed.id !== feedId) return;
    feed.items = feed.items.filter((i) => i.seq > upToSeq);
  }

  // ── history ──────────────────────────────────────────────────────────────────────────────
  async readGroupHistory(accountId: string, groupId: string, count: number): Promise<ZaloRawMessage[]> {
    const api = this.deps.pool.getApi(accountId);
    if (!api) throw new ZaloTransportError('not_connected', 'Nick Zalo chưa kết nối');
    if (!this.deps.limiter.consume(accountId, 'group_read').ok) {
      throw new ZaloTransportError('rate_limited', 'Đã dùng hết hạn mức đọc nhóm trong ngày của nick', 60 * 60_000);
    }
    try {
      const res = await api.getGroupChatHistory(groupId, count);
      return (res?.groupMsgs ?? []).map((m) => {
        const o = m as Obj;
        return { threadKind: 'group' as const, threadId: groupId, isSelf: Boolean(o.isSelf), data: (o.data ?? {}) as ZaloRawMessage['data'] };
      });
    } catch (err) {
      throw this.classify(err);
    }
  }

  requestDirectHistory(accountId: string, cursor: string | null): void {
    const api = this.deps.pool.getApi(accountId);
    if (!api) throw new ZaloTransportError('not_connected', 'Nick Zalo chưa kết nối');
    this.feed(accountId); // make sure the listener is attached before the batches arrive
    api.listener.requestOldMessages(ThreadType.User, cursor && cursor.trim() ? cursor : null);
  }

  async resolveTitle(accountId: string, threadId: string, kind: ZaloThreadKind): Promise<string | null> {
    const api = this.deps.pool.getApi(accountId);
    if (!api) return null;
    try {
      if (kind === 'group') {
        if (!this.deps.limiter.consume(accountId, 'group_read').ok) return null;
        const res = await api.getGroupInfo(threadId);
        const name = (res?.gridInfoMap?.[threadId] as Obj | undefined)?.name;
        return typeof name === 'string' && name ? name : null;
      }
      if (!this.deps.limiter.consume(accountId, 'query').ok) return null;
      const res = await api.getUserInfo(threadId);
      const profiles = res?.changed_profiles ?? {};
      const p = profiles[threadId] ?? profiles[`${threadId}_0`];
      const name = String(p?.zaloName || p?.zalo_name || p?.displayName || p?.display_name || '');
      return name || null;
    } catch {
      return null; // a name is never worth failing ingestion for
    }
  }

  // ── unsupported / auxiliary ──────────────────────────────────────────────────────────────
  async markRead(accountId: string, _threadId: string, _nativeMessageId: string, seen?: ZaloSeenTarget): Promise<void> {
    if (this.deps.seenMarker !== true || !seen) throw new ZaloTransportError('unknown', 'The seen marker is not enabled for this transport (or the message has no stored wire data)');
    const api = this.deps.pool.getApi(accountId);
    if (!api?.sendSeenEvent) throw new ZaloTransportError('not_connected', 'Nick Zalo chưa kết nối');
    try {
      const { threadKind, ...params } = seen;
      await api.sendSeenEvent(params, threadKind === 'group' ? ThreadType.Group : ThreadType.User);
    } catch (err) {
      throw this.classify(err);
    }
  }

  async fetchMedia(_accountId: string, url: string): Promise<{ buffer: Buffer; mimeType: string }> {
    return fetchMediaBytes(this.deps.fetchImpl ?? fetch, url);
  }

  async startQrLogin(accountId: string): Promise<ZaloAuthStart> {
    const { pool } = this.deps;
    if (pool.getLiveStatus(accountId) === 'connected') {
      return { step: 'authorized', nativeAccountId: this.ownUid(accountId) ?? undefined };
    }
    pool.startQrLogin(accountId);
    const qr = pool.getQrState(accountId);
    if (qr?.phase === 'error' || qr?.phase === 'declined' || qr?.phase === 'expired') {
      return { step: 'failed', error: qr.error ?? qr.phase };
    }
    return { step: 'qr_pending', ...(qr?.image ? { qr: `data:image/png;base64,${qr.image}` } : {}) };
  }

  /** Stops listening (process shutdown / account pause). The buffered items are dropped with it. */
  close(): void {
    for (const f of this.feeds.values()) f.detach?.();
    this.feeds.clear();
  }
}
