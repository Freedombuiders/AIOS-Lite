/**
 * Test kit for the daemon-side Care routes and the main-process daemon client. A "world" is a fake zca-js API
 * behind the real ZcaZaloTransport, behind the real Care control routes; `loopbackCall` replaces the HTTP hop
 * (control.ts callZaloDaemon) so client and daemon talk without a socket. Synthetic only.
 */
import { EventEmitter } from 'node:events';
import { createCareControl, type CareControl } from '../../care-bridge.js';
import { ZaloDaemonUnavailableError, type ControlResponse } from '../../control.js';
import { ZcaZaloTransport, type ZcaApiLike, type ZcaLimiterLike, type ZcaPoolLike } from './zca-transport.js';

export const CONTROL_TOKEN = 'test-control-token';

export class FakeApi implements ZcaApiLike {
  listener = new EventEmitter() as unknown as ZcaApiLike['listener'] & EventEmitter;
  sent: Array<{ msg: string; threadId: string; type: number; quote?: Record<string, unknown> }> = [];
  seen: Array<{ params: Record<string, unknown> | Array<Record<string, unknown>>; type?: number }> = [];
  oldRequests: Array<[number, string | null]> = [];
  groupHistory: unknown[] = [];
  nextId = 7_400_000_000_000_000_000n;
  sendImpl: (() => Promise<{ message?: { msgId?: number | string } | null }>) | null = null;
  constructor() {
    (this.listener as unknown as { requestOldMessages: unknown }).requestOldMessages = (type: number, cursor: string | null) => {
      this.oldRequests.push([type, cursor]);
    };
  }
  async sendSeenEvent(params: Record<string, unknown> | Array<Record<string, unknown>>, type?: number) {
    this.seen.push({ params, type });
    return { status: 0 };
  }
  async sendMessage(content: { msg: string; quote?: Record<string, unknown> }, threadId: string, type: number) {
    this.sent.push({ msg: content.msg, threadId, type, ...(content.quote ? { quote: content.quote } : {}) });
    if (this.sendImpl) return this.sendImpl();
    this.nextId += 1n;
    return { message: { msgId: this.nextId.toString() } };
  }
  async getGroupChatHistory() {
    return { groupMsgs: this.groupHistory };
  }
  async getUserInfo(uid: string) {
    return { changed_profiles: { [uid]: { zaloName: 'Chị Hoa' } } };
  }
  async getGroupInfo(id: string) {
    return { gridInfoMap: { [id]: { name: 'Nhóm VIP' } } };
  }
}

export interface DaemonWorld {
  api: FakeApi;
  pool: { api: FakeApi | null; status: string };
  transport: ZcaZaloTransport;
  control: CareControl;
  limiter: { ok: boolean; reason?: 'daily' | 'burst'; retryAfterMs?: number; used: number; limit: number };
  /** Legacy account row switches + the Care ownership the send gate sees. */
  state: { locked: boolean; owner: 'legacy' | 'draining' | 'core'; epoch: number; bridged: Set<string>; gateCalls: Array<{ zid: string; epoch: number | null; actor: string }> };
  /** Fails the next loopback call the way the control channel can. */
  fault: { mode: 'none' | 'not-running' | 'refused' | 'abort-after-processing' | 'abort-before-processing' | 'status'; status?: number };
  call: <T = unknown>(method: 'GET' | 'POST', route: string, opts?: { body?: unknown; timeoutMs?: number }) => Promise<ControlResponse<T>>;
  zaloAccountIdOf: (careId: string) => string | null;
}

export function makeDaemonWorld(opts: { quoteReplies?: boolean; seenMarker?: boolean } = {}): DaemonWorld {
  const api = new FakeApi();
  const pool = { api: api as FakeApi | null, status: 'connected' };
  const poolLike: ZcaPoolLike = {
    getApi: () => pool.api,
    getContext: () => (pool.api ? { ownUid: 'own-uid-1' } : null),
    getLiveStatus: () => pool.status,
    getQrState: () => null,
    startQrLogin: () => {},
  };
  const lim: DaemonWorld['limiter'] = { ok: true, used: 0, limit: 1000 };
  const limiter: ZcaLimiterLike = {
    check: () => ({ ok: lim.ok, reason: lim.reason, used: lim.used, limit: lim.limit, retryAfterMs: lim.retryAfterMs }),
    consume: () => ({ ok: true }),
    record: () => {},
    limitFor: () => ({ daily: lim.limit }),
  };
  const state: DaemonWorld['state'] = { locked: false, owner: 'core', epoch: 1, bridged: new Set(['zalo-1']), gateCalls: [] };
  const transport = new ZcaZaloTransport({
    pool: poolLike,
    limiter,
    sendState: () => ({ chatEnabled: !state.locked, sendLockReason: state.locked ? 'auto-lock' : '' }),
    dayStartMs: (n) => n - (n % 86_400_000),
    ...(opts.quoteReplies !== undefined ? { quoteReplies: opts.quoteReplies } : {}),
    ...(opts.seenMarker !== undefined ? { seenMarker: opts.seenMarker } : {}),
  });
  const control = createCareControl({
    transport,
    token: CONTROL_TOKEN,
    bridged: (zid) => state.bridged.has(zid),
    sendGate: (zid, epoch, actor) => {
      state.gateCalls.push({ zid, epoch, actor });
      if (state.owner === 'legacy') return { allow: false, code: 'OWNER_LEGACY' };
      if (state.owner === 'draining') return { allow: false, code: 'ACCOUNT_DRAINING' };
      if (epoch !== state.epoch) return { allow: false, code: 'STALE_EPOCH' };
      return { allow: true, code: 'OK' };
    },
  });
  const world: DaemonWorld = {
    api,
    pool,
    transport,
    control,
    limiter: lim,
    state,
    fault: { mode: 'none' },
    zaloAccountIdOf: (careId) => (careId === 'care-1' ? 'zalo-1' : null),
    call: async <T>(method: 'GET' | 'POST', route: string, opts: { body?: unknown } = {}) => {
      const f = world.fault;
      if (f.mode === 'not-running') throw new ZaloDaemonUnavailableError();
      if (f.mode === 'refused') throw new ZaloDaemonUnavailableError('Không kết nối được dịch vụ Zalo: connect ECONNREFUSED 127.0.0.1:3142');
      if (f.mode === 'abort-before-processing') throw new ZaloDaemonUnavailableError('Dịch vụ Zalo không phản hồi');
      if (f.mode === 'status') return { status: f.status ?? 500, data: {} as T };
      const url = new URL(route, 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'care') return { status: 200, data: { live: pool.status, qr: null } as T };
      const res = await control.handle({
        method,
        parts,
        query: url.searchParams,
        body: (opts.body ?? {}) as Record<string, unknown>,
        token: CONTROL_TOKEN,
      });
      if (f.mode === 'abort-after-processing') throw new ZaloDaemonUnavailableError('Dịch vụ Zalo không phản hồi');
      // JSON round trip like the real channel
      return { status: res?.status ?? 404, data: JSON.parse(JSON.stringify(res?.data ?? {})) as T };
    },
  };
  return world;
}
