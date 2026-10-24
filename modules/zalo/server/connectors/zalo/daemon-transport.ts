/**
 * `ZaloTransport` for the MAIN process: the zca-js sessions live in the detached Zalo daemon, so every
 * provider-facing call goes over its token-authenticated loopback control channel (control.ts,
 * routes in care-bridge.ts). Nothing here opens a Zalo session or touches a `zalo_*` table.
 *
 * Failure honesty on the wire: a request that was never accepted by the daemon (no daemon, no token,
 * connection refused, 401/404/409) is DEFINITE not-sent; a request whose HTTP exchange may have been cut
 * after the daemon started working (timeout, reset) is UNCERTAIN, never retried here.
 */

import { callZaloDaemon, ZaloDaemonUnavailableError, type ControlResponse } from '../../control.js';
import { fetchMediaBytes } from './zca-transport.js';
import {
  ZaloTransportError,
  type ZaloAuthStart,
  type ZaloFeatures,
  type ZaloLivePage,
  type ZaloRateStatus,
  type ZaloRawMessage,
  type ZaloSendAck,
  type ZaloSendLookup,
  type ZaloSeenTarget,
  type ZaloSendRequest,
  type ZaloThreadKind,
  type ZaloTransport,
  type ZaloTransportErrorKind,
} from './transport.js';

type Call = <T = unknown>(method: 'GET' | 'POST', route: string, opts?: { body?: unknown; timeoutMs?: number }) => Promise<ControlResponse<T>>;

export interface DaemonTransportDeps {
  call?: Call;
  /** Care account id -> the `zalo_accounts.id` the daemon knows. */
  zaloAccountIdOf: (careAccountId: string) => string | null;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** How long a status snapshot is reused (ms). Default 1000. */
  statusTtlMs?: number;
}

interface StatusSnapshot {
  connected: boolean;
  ownUid: string | null;
  features: ZaloFeatures;
  rate: ZaloRateStatus;
}

/** What Care can say about a nick whose daemon cannot be reached: sending stays "possible", it fails at send time. */
const UNREACHABLE_FEATURES: ZaloFeatures = {
  text: true,
  quote: false,
  typing: false,
  markRead: false,
  sendMedia: [],
  fetchMedia: true,
  history: { group: true, directPush: true },
};

const DEFINITE_KINDS: ReadonlySet<string> = new Set(['not_connected', 'session_expired', 'send_locked', 'fenced', 'rate_limited', 'rejected']);
const ALL_KINDS: ReadonlySet<string> = new Set([...DEFINITE_KINDS, 'unresolved', 'network', 'timeout', 'unknown']);

/** The daemon was never reached (no token = not running, connection refused): nothing can have been sent. */
function neverReached(e: unknown): boolean {
  if (!(e instanceof ZaloDaemonUnavailableError)) return false;
  return e.message === new ZaloDaemonUnavailableError().message || /ECONNREFUSED/i.test(e.message);
}

export class DaemonZaloTransport implements ZaloTransport {
  private readonly call: Call;
  private readonly snapshots = new Map<string, { at: number; value: StatusSnapshot }>();

  constructor(private readonly deps: DaemonTransportDeps) {
    this.call = deps.call ?? (callZaloDaemon as Call);
  }

  /** Process shutdown: forgets the cached status snapshots (the daemon owns the sessions and keeps running). */
  close(): void {
    this.snapshots.clear();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private zid(careAccountId: string): string {
    const id = this.deps.zaloAccountIdOf(careAccountId);
    if (!id) throw new ZaloTransportError('not_connected', 'Care account is not bridged to a Zalo nick');
    return id;
  }

  private route(careAccountId: string, tail: string): string {
    return `/care/accounts/${encodeURIComponent(this.zid(careAccountId))}/${tail}`;
  }

  /** Non-send calls: any failure to reach the daemon is "not connected" (nothing at stake). */
  private async get<T>(careAccountId: string, tail: string, timeoutMs = 10_000): Promise<T> {
    return this.exchange<T>('GET', careAccountId, tail, undefined, timeoutMs);
  }

  private async post<T>(careAccountId: string, tail: string, body: unknown, timeoutMs = 15_000): Promise<T> {
    return this.exchange<T>('POST', careAccountId, tail, body, timeoutMs);
  }

  private async exchange<T>(method: 'GET' | 'POST', careAccountId: string, tail: string, body: unknown, timeoutMs: number): Promise<T> {
    let res: ControlResponse<T>;
    try {
      res = await this.call<T>(method, this.route(careAccountId, tail), { body, timeoutMs });
    } catch (e) {
      if (e instanceof ZaloTransportError) throw e;
      throw new ZaloTransportError('not_connected', e instanceof Error ? e.message : 'Zalo daemon unreachable');
    }
    if (res.status === 401 || res.status === 404) throw new ZaloTransportError('not_connected', `Zalo daemon refused the request (${res.status})`);
    if (res.status >= 500) throw new ZaloTransportError('unknown', `Zalo daemon error (${res.status})`);
    return res.data;
  }

  private async snapshot(careAccountId: string): Promise<StatusSnapshot> {
    const now = this.now();
    const cached = this.snapshots.get(careAccountId);
    if (cached && now - cached.at < (this.deps.statusTtlMs ?? 1000)) return cached.value;
    let value: StatusSnapshot;
    try {
      value = await this.get<StatusSnapshot>(careAccountId, 'status', 5_000);
      if (typeof value?.connected !== 'boolean') throw new Error('bad status');
    } catch {
      value = { connected: false, ownUid: null, features: UNREACHABLE_FEATURES, rate: { ok: true } };
    }
    this.snapshots.set(careAccountId, { at: now, value });
    return value;
  }

  async ownUid(careAccountId: string): Promise<string | null> {
    return (await this.snapshot(careAccountId)).ownUid;
  }
  async isConnected(careAccountId: string): Promise<boolean> {
    return (await this.snapshot(careAccountId)).connected;
  }
  async features(careAccountId: string): Promise<ZaloFeatures> {
    return (await this.snapshot(careAccountId)).features;
  }
  async rateStatus(careAccountId: string): Promise<ZaloRateStatus> {
    return (await this.snapshot(careAccountId)).rate;
  }

  async send(careAccountId: string, request: ZaloSendRequest): Promise<ZaloSendAck> {
    let res: ControlResponse<{
      ok?: boolean;
      msgId?: string;
      tsMs?: number;
      kind?: string;
      message?: string;
      retryAfterMs?: number;
    }>;
    try {
      res = await this.call('POST', this.route(careAccountId, 'send'), { body: request, timeoutMs: 30_000 });
    } catch (e) {
      if (e instanceof ZaloTransportError) throw e;
      if (neverReached(e)) throw new ZaloTransportError('not_connected', 'Zalo daemon is not running');
      // The request may have reached the daemon before the exchange broke: the outcome is unknown.
      throw new ZaloTransportError('timeout', 'The Zalo daemon did not answer the send in time');
    }
    this.snapshots.delete(careAccountId);
    if (res.status === 401 || res.status === 404) throw new ZaloTransportError('not_connected', `Zalo daemon refused the send (${res.status})`);
    const data = res.data ?? {};
    if (res.status === 400) throw new ZaloTransportError('rejected', data.message ?? 'Zalo daemon refused the request');
    if (data.ok === true) {
      return { ...(typeof data.msgId === 'string' && data.msgId ? { msgId: data.msgId } : {}), ...(typeof data.tsMs === 'number' ? { tsMs: data.tsMs } : {}) };
    }
    if (res.status >= 500) throw new ZaloTransportError('timeout', `Zalo daemon error (${res.status}) during send`);
    const kind = (typeof data.kind === 'string' && ALL_KINDS.has(data.kind) ? data.kind : 'unknown') as ZaloTransportErrorKind;
    throw new ZaloTransportError(kind, data.message ?? 'Zalo send failed', data.retryAfterMs);
  }

  async lookupSend(careAccountId: string, requestId: string): Promise<ZaloSendLookup | null> {
    const data = await this.get<{ state?: ZaloSendLookup['state'] | null; msgId?: string; tsMs?: number }>(
      careAccountId,
      `send-status?requestId=${encodeURIComponent(requestId)}`,
    );
    return data?.state ? { state: data.state, ...(data.msgId ? { msgId: data.msgId } : {}), ...(data.tsMs ? { tsMs: data.tsMs } : {}) } : null;
  }

  async peekLive(careAccountId: string, limit: number): Promise<ZaloLivePage> {
    const data = await this.get<ZaloLivePage & { ok?: boolean; kind?: string; message?: string }>(careAccountId, `feed?limit=${Math.trunc(limit)}`);
    if (!Array.isArray(data?.items)) throw new ZaloTransportError((data?.kind as ZaloTransportErrorKind) ?? 'unknown', data?.message ?? 'bad feed response');
    return { feedId: data.feedId, items: data.items, hasMore: Boolean(data.hasMore), gap: Boolean(data.gap) };
  }

  async ackLive(careAccountId: string, feedId: string, upToSeq: number): Promise<void> {
    await this.post(careAccountId, 'feed/ack', { feedId, upToSeq });
  }

  async requestDirectHistory(careAccountId: string, cursor: string | null): Promise<void> {
    await this.post(careAccountId, 'history/direct', { cursor });
  }

  async readGroupHistory(careAccountId: string, groupId: string, count: number): Promise<ZaloRawMessage[]> {
    const data = await this.post<{ ok?: boolean; messages?: ZaloRawMessage[]; kind?: string; message?: string; retryAfterMs?: number }>(
      careAccountId,
      'history/group',
      { groupId, count },
    );
    if (!Array.isArray(data?.messages)) {
      const kind = (typeof data?.kind === 'string' && ALL_KINDS.has(data.kind) ? data.kind : 'unknown') as ZaloTransportErrorKind;
      throw new ZaloTransportError(kind, data?.message ?? 'bad history response', data?.retryAfterMs);
    }
    return data.messages;
  }

  async resolveTitle(careAccountId: string, threadId: string, kind: ZaloThreadKind): Promise<string | null> {
    try {
      const data = await this.post<{ title?: string | null }>(careAccountId, 'title', { threadId, kind });
      return typeof data?.title === 'string' && data.title ? data.title : null;
    } catch {
      return null;
    }
  }

  async markRead(careAccountId: string, threadId: string, nativeMessageId: string, seen?: ZaloSeenTarget): Promise<void> {
    if (!seen) throw new ZaloTransportError('unknown', 'The seen marker needs the message wire data');
    const data = await this.post<{ ok?: boolean; kind?: string; message?: string }>(careAccountId, 'seen', { threadId, nativeMessageId, seen });
    if (data?.ok !== true) {
      const kind = (typeof data?.kind === 'string' && ALL_KINDS.has(data.kind) ? data.kind : 'unknown') as ZaloTransportErrorKind;
      throw new ZaloTransportError(kind, data?.message ?? 'Zalo daemon did not accept the seen marker');
    }
  }

  async fetchMedia(_careAccountId: string, url: string): Promise<{ buffer: Buffer; mimeType: string }> {
    return fetchMediaBytes(this.deps.fetchImpl ?? fetch, url); // public CDN: no session needed
  }

  async startQrLogin(careAccountId: string): Promise<ZaloAuthStart> {
    const zid = this.zid(careAccountId);
    try {
      const state = await this.call<{ live?: string; qr?: { image: string | null; phase: string; error?: string } | null }>('GET', `/accounts/${encodeURIComponent(zid)}/state`);
      if (state.data?.live === 'connected') {
        return { step: 'authorized', nativeAccountId: (await this.ownUid(careAccountId)) ?? undefined };
      }
      await this.call('POST', `/accounts/${encodeURIComponent(zid)}/login-qr`, { body: {} });
      const after = await this.call<{ qr?: { image: string | null; phase: string; error?: string } | null }>('GET', `/accounts/${encodeURIComponent(zid)}/state`);
      const qr = after.data?.qr;
      if (qr?.phase === 'error' || qr?.phase === 'declined' || qr?.phase === 'expired') return { step: 'failed', error: qr.error ?? qr.phase };
      return { step: 'qr_pending', ...(qr?.image ? { qr: `data:image/png;base64,${qr.image}` } : {}) };
    } catch (e) {
      return { step: 'failed', error: e instanceof Error ? e.message : 'Zalo daemon unreachable' };
    }
  }
}

/** In AIOS-Lite the care account id IS the zalo_accounts.id (no bridge table). */
export const identityZaloAccountId = (careAccountId: string): string | null => careAccountId || null;

/** The transport the zalo module registers with care (via ZaloCareConnector): every call goes to the daemon. */
export function createDaemonZaloTransport(): ZaloTransport {
  return new DaemonZaloTransport({ zaloAccountIdOf: identityZaloAccountId });
}
