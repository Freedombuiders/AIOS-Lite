/**
 * Live zca-js sessions, one per Zalo account. Lives only in the zalo daemon.
 *
 * Ported from ZaloCRM's zalo-pool.ts + zalo-health-check.ts. The guards that
 * matter were all learned the hard way there and are kept:
 *   - epoch per connect: a `closed` event from a superseded listener is
 *     ignored, otherwise it marks the fresh session dead and loops;
 *   - teardown before every new login: two live websockets on one nick make
 *     Zalo kick one, which reconnects, which kicks the other…;
 *   - one in-flight reconnect per account;
 *   - circuit breaker: 5 disconnects in 5 minutes stops auto-reconnect until
 *     the operator scans a QR again;
 *   - a uid check on reconnect so a stale cookie can never relabel a nick;
 *   - a manual disconnect stays disconnected (no background revival).
 */

import { readFile } from 'fs/promises';

import { imageSize } from 'image-size';
import { LoginQRCallbackEventType, ThreadType, Zalo, type API } from 'zca-js';

import {
  countZaloThreads,
  findZaloAccountIdByUid,
  getZaloAccount,
  getZaloAccountSession,
  listZaloAccounts,
  saveZaloAccountSession,
  updateZaloAccountSettings,
  updateZaloAccountState,
  type ZaloAccountStatus,
} from './store.js';
import { logger } from './compat.js';
import { forgetGroupInfo, ingestMessage, ingestUndo, type IngestContext, type IngestResult } from './ingest.js';
import { ZaloLimiter } from './limits.js';

export type LiveStatus = 'disconnected' | 'qr_pending' | 'connecting' | 'connected';

export interface QrState {
  /** base64 PNG (no data: prefix) while waiting for a scan. */
  image: string | null;
  phase: 'waiting' | 'scanned' | 'expired' | 'declined' | 'done' | 'error';
  scannedName?: string;
  error?: string;
  updatedAt: number;
}

interface Instance {
  zalo: Zalo;
  api: API | null;
  status: LiveStatus;
  epoch: number;
  ownUid: string;
  qr?: QrState;
  /** Cancels a QR login still waiting for a scan (zca-js keeps polling otherwise). */
  abortQr?: () => unknown;
}

export interface SessionHooks {
  /** A live (not backfilled) message was stored. */
  onMessage(accountId: string, result: IngestResult): void;
  /** Session is up. `firstLogin` = this account has no threads yet. */
  onConnected(accountId: string, ctx: IngestContext, firstLogin: boolean): void;
  onDisconnected(accountId: string): void;
}

interface StoredCredentials {
  cookie: unknown;
  imei: string;
  userAgent: string;
}

const RECONNECT_DELAY_MS = 30_000;
const RECONNECT_RETRY_MS = 120_000;
const BREAKER_WINDOW_MS = 5 * 60_000;
const BREAKER_LIMIT = 5;
const MAX_QR_EXPIRIES = 3;
const HEALTH_INTERVAL_MS = 5 * 60_000;

/** zca-js needs this to upload images (and send several as an album). */
async function imageMetadataGetter(filePath: string): Promise<{ width: number; height: number; size: number }> {
  const data = await readFile(filePath);
  const info = imageSize(data);
  if (!info.width || !info.height) throw new Error(`Không đọc được kích thước ảnh: ${filePath}`);
  return { width: info.width, height: info.height, size: data.length };
}

function newZalo(): Zalo {
  return new Zalo({ logging: false, selfListen: true, checkUpdate: false, imageMetadataGetter });
}

function profileOf(res: unknown, uid: string): Record<string, unknown> | undefined {
  const profiles = ((res as { changed_profiles?: Record<string, Record<string, unknown>> })?.changed_profiles) ?? {};
  return profiles[uid] ?? profiles[`${uid}_0`];
}

export class ZaloSessionPool {
  private instances = new Map<string, Instance>();
  private epochCounter = 0;
  private reconnecting = new Set<string>();
  /** Consecutive failed cookie logins; after a few the session is treated as expired. */
  private reconnectFailures = new Map<string, number>();
  private disconnectHistory = new Map<string, number[]>();
  private healthTimer: NodeJS.Timeout | null = null;
  private lastDailyRefresh = '';
  /** One limiter per daemon: the sender and every SDK read share the nick budgets. */
  readonly limiter = new ZaloLimiter();

  constructor(private readonly hooks: SessionHooks) {}

  /** Reconnect every account with a saved session (daemon boot). */
  async startAll(): Promise<void> {
    for (const acc of listZaloAccounts()) {
      // Live state is owned by this process; whatever the DB says from a
      // previous run is stale.
      if (acc.status !== 'disconnected' && acc.status !== 'session_expired') {
        updateZaloAccountState(acc.id, { status: 'disconnected' });
      }
      if (acc.has_session && !acc.manual_disconnect && acc.zalo_uid) {
        await this.reconnect(acc.id).catch((err) => logger.warn({ accountId: acc.id, err: String(err) }, 'zalo boot reconnect failed'));
        // Stagger boots so several nicks don't all hit Zalo in the same second.
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
    this.healthTimer = setInterval(() => void this.healthTick(), HEALTH_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  stopAll(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    for (const id of [...this.instances.keys()]) this.teardown(id);
    this.instances.clear();
  }

  getApi(accountId: string): API | null {
    const inst = this.instances.get(accountId);
    return inst?.status === 'connected' ? inst.api : null;
  }

  getContext(accountId: string): IngestContext | null {
    const inst = this.instances.get(accountId);
    return inst?.status === 'connected' && inst.api ? { accountId, api: inst.api, ownUid: inst.ownUid, limiter: this.limiter } : null;
  }

  getLiveStatus(accountId: string): LiveStatus {
    return this.instances.get(accountId)?.status ?? 'disconnected';
  }

  getQrState(accountId: string): QrState | null {
    return this.instances.get(accountId)?.qr ?? null;
  }

  private setStatus(accountId: string, status: ZaloAccountStatus, extra: Parameters<typeof updateZaloAccountState>[1] = {}): void {
    updateZaloAccountState(accountId, { status, ...extra });
  }

  private teardown(accountId: string): void {
    const prev = this.instances.get(accountId);
    if (prev?.abortQr) {
      try { prev.abortQr(); } catch { /* already finished */ }
      prev.abortQr = undefined;
    }
    if (prev?.api?.listener) {
      try { prev.api.listener.stop(); } catch (err) {
        logger.warn({ accountId, err: String(err) }, 'zalo teardown: stopping old listener failed');
      }
    }
  }

  /**
   * Start a QR login. Resolves once the QR flow has begun; the image is
   * exposed through getQrState() and the session comes up in the background.
   */
  startQrLogin(accountId: string): void {
    if (!getZaloAccount(accountId)) throw new Error('unknown account');
    // A manual QR scan always starts clean: old socket, in-flight reconnect,
    // and breaker history all go.
    this.teardown(accountId);
    this.reconnecting.delete(accountId);
    this.disconnectHistory.delete(accountId);
    this.reconnectFailures.delete(accountId);

    const epoch = ++this.epochCounter;
    const zalo = newZalo();
    const qr: QrState = { image: null, phase: 'waiting', updatedAt: Date.now() };
    this.instances.set(accountId, { zalo, api: null, status: 'qr_pending', epoch, ownUid: '', qr });
    updateZaloAccountState(accountId, { status: 'qr_pending', manual_disconnect: 0, last_error: '' });

    const isCurrent = () => this.instances.get(accountId)?.epoch === epoch;
    const touch = (patch: Partial<QrState>) => {
      if (!isCurrent()) return;
      Object.assign(qr, patch, { updatedAt: Date.now() });
    };
    let expiries = 0;

    void (async () => {
      try {
        const api = await zalo.loginQR({}, (event) => {
          if (!isCurrent()) return;
          const inst = this.instances.get(accountId);
          if (inst && event.actions && 'abort' in event.actions) inst.abortQr = event.actions.abort;
          switch (event.type) {
            case LoginQRCallbackEventType.QRCodeGenerated:
              touch({ image: event.data.image, phase: 'waiting' });
              break;
            case LoginQRCallbackEventType.QRCodeExpired:
              expiries++;
              if (expiries >= MAX_QR_EXPIRIES) {
                // Endless retry() on the same SDK session produced QRs that
                // never scanned; stop and let the operator start fresh.
                touch({ image: null, phase: 'expired' });
                event.actions.abort();
                return;
              }
              event.actions.retry();
              break;
            case LoginQRCallbackEventType.QRCodeScanned:
              touch({ phase: 'scanned', scannedName: event.data.display_name });
              break;
            case LoginQRCallbackEventType.QRCodeDeclined:
              touch({ image: null, phase: 'declined' });
              break;
            case LoginQRCallbackEventType.GotLoginInfo:
              saveZaloAccountSession(accountId, JSON.stringify({
                cookie: event.data.cookie, imei: event.data.imei, userAgent: event.data.userAgent,
              } satisfies StoredCredentials));
              break;
          }
        });
        if (!isCurrent()) {
          // A newer login replaced this one while we waited: never let the
          // stale session attach a second listener.
          try { api.listener.stop(); } catch { /* ignore */ }
          return;
        }
        const loggedIn = this.instances.get(accountId);
        if (loggedIn) loggedIn.abortQr = undefined;
        if (await this.onLoggedIn(accountId, api, epoch, { fromQr: true })) touch({ image: null, phase: 'done' });
      } catch (err) {
        if (!isCurrent()) return;
        const inst = this.instances.get(accountId);
        if (inst) {
          inst.status = 'disconnected';
          inst.abortQr = undefined;
        }
        // An expired/declined QR ends the flow on purpose (we abort it); only
        // a real failure is an error worth showing.
        const ended = qr.phase === 'expired' || qr.phase === 'declined';
        if (!ended) touch({ image: null, phase: 'error', error: String(err) });
        this.setStatus(accountId, 'disconnected', {
          last_error: ended ? '' : `Đăng nhập QR thất bại: ${String(err)}`.slice(0, 300),
        });
        if (!ended) logger.warn({ accountId, err: String(err) }, 'zalo QR login failed');
      }
    })();
  }

  /** Reconnect from the saved cookie session. */
  async reconnect(accountId: string): Promise<void> {
    const acc = getZaloAccount(accountId);
    if (!acc || !acc.zalo_uid || acc.manual_disconnect) return;
    if (this.reconnecting.has(accountId)) return;
    const raw = getZaloAccountSession(accountId);
    if (!raw) {
      this.setStatus(accountId, 'session_expired', { last_error: 'Chưa có phiên đăng nhập, cần quét QR' });
      return;
    }
    let creds: StoredCredentials;
    try {
      creds = JSON.parse(raw) as StoredCredentials;
    } catch {
      this.setStatus(accountId, 'session_expired', { last_error: 'Phiên đăng nhập hỏng, cần quét QR' });
      return;
    }

    this.reconnecting.add(accountId);
    this.teardown(accountId);
    const epoch = ++this.epochCounter;
    const zalo = newZalo();
    this.instances.set(accountId, { zalo, api: null, status: 'connecting', epoch, ownUid: acc.zalo_uid });
    this.setStatus(accountId, 'connecting');
    try {
      const api = await zalo.login({
        cookie: creds.cookie as Parameters<Zalo['login']>[0]['cookie'],
        imei: creds.imei,
        userAgent: creds.userAgent,
      });
      if (this.instances.get(accountId)?.epoch !== epoch) {
        try { api.listener.stop(); } catch { /* ignore */ }
        return;
      }
      await this.onLoggedIn(accountId, api, epoch, { fromQr: false, expectedUid: acc.zalo_uid });
    } catch (err) {
      const inst = this.instances.get(accountId);
      if (inst?.epoch === epoch) inst.status = 'disconnected';
      // A network blip and a dead cookie look the same here. Keep retrying
      // (health tick, every 5 min) a few times before asking for a QR.
      const failures = (this.reconnectFailures.get(accountId) ?? 0) + 1;
      this.reconnectFailures.set(accountId, failures);
      const expired = failures >= 3;
      this.setStatus(accountId, expired ? 'session_expired' : 'disconnected', {
        last_error: (expired
          ? `Phiên đăng nhập hết hạn, cần quét QR lại (${String(err)})`
          : `Kết nối lại thất bại, sẽ thử lại: ${String(err)}`).slice(0, 300),
      });
      logger.warn({ accountId, failures, err: String(err) }, 'zalo reconnect failed');
    } finally {
      this.reconnecting.delete(accountId);
    }
  }

  private async onLoggedIn(
    accountId: string,
    api: API,
    epoch: number,
    opts: { fromQr: boolean; expectedUid?: string },
  ): Promise<boolean> {
    const inst = this.instances.get(accountId)!;
    const ownUid = String(await api.getOwnId());

    if (opts.expectedUid && ownUid !== opts.expectedUid) {
      // The stored cookie logged in as a different person — refuse to
      // relabel this nick silently.
      try { api.listener.stop(); } catch { /* ignore */ }
      inst.status = 'disconnected';
      this.setStatus(accountId, 'session_expired', { last_error: 'Phiên đăng nhập không khớp nick này, cần quét QR lại' });
      return false;
    }
    const owner = findZaloAccountIdByUid(ownUid, accountId);
    if (owner) {
      try { api.listener.stop(); } catch { /* ignore */ }
      inst.status = 'disconnected';
      if (inst.qr) Object.assign(inst.qr, { phase: 'error', error: 'Nick Zalo này đã được thêm ở một tài khoản khác' });
      this.setStatus(accountId, 'disconnected', { last_error: 'Nick Zalo này đã được thêm ở một tài khoản khác' });
      saveZaloAccountSession(accountId, null);
      return false;
    }

    let displayName = '';
    let avatar = '';
    try {
      // Cosmetic, so it is the first thing to skip when the query budget is out.
      if (!this.limiter.consume(accountId, 'query').ok) throw new Error('query budget exhausted');
      const p = profileOf(await api.getUserInfo(ownUid), ownUid);
      displayName = String(p?.zaloName || p?.displayName || '');
      avatar = String(p?.avatar || '');
    } catch { /* profile is cosmetic */ }

    inst.api = api;
    inst.ownUid = ownUid;
    inst.status = 'connected';
    this.reconnectFailures.delete(accountId);
    const firstLogin = countZaloThreads(accountId) === 0;
    // Warm-up counts from the first successful connect of a nick flagged as new.
    const acc = getZaloAccount(accountId);
    if (acc?.warmup_enabled && !acc.warmup_started_at) {
      updateZaloAccountSettings(accountId, { warmup_started_at: Math.floor(Date.now() / 1000) });
    }
    this.setStatus(accountId, 'connected', {
      zalo_uid: ownUid,
      ...(displayName ? { display_name: displayName } : {}),
      ...(avatar ? { avatar_url: avatar } : {}),
      last_error: '',
      last_connected_at: Math.floor(Date.now() / 1000),
      manual_disconnect: 0,
    });
    const ctx: IngestContext = { accountId, api, ownUid, limiter: this.limiter };
    this.attachListener(ctx, epoch);
    logger.info({ accountId, ownUid, fromQr: opts.fromQr }, 'zalo account connected');
    this.hooks.onConnected(accountId, ctx, firstLogin);
    return true;
  }

  private attachListener(ctx: IngestContext, epoch: number): void {
    const { accountId, api } = ctx;
    const listener = api.listener;
    const current = () => this.instances.get(accountId)?.epoch === epoch;

    listener.on('message', (message) => {
      if (!current()) return;
      void ingestMessage(ctx, message as never, 'live')
        .then((res) => { if (res) this.hooks.onMessage(accountId, res); })
        .catch((err) => logger.error({ accountId, err: String(err) }, 'zalo message ingest failed'));
    });

    // Messages missed while disconnected, pushed by Zalo after reconnect
    // (and pages requested by the history backfill).
    listener.on('old_messages', (messages, type) => {
      if (!current()) return;
      void (async () => {
        for (const m of messages) {
          try { await ingestMessage(ctx, m as never, 'backfill', type); } catch (err) {
            logger.warn({ accountId, err: String(err) }, 'zalo old_messages ingest failed');
          }
        }
      })();
    });

    listener.on('undo', (undo) => {
      if (!current()) return;
      try { ingestUndo(accountId, undo as never); } catch (err) {
        logger.warn({ accountId, err: String(err) }, 'zalo undo failed');
      }
    });

    listener.on('group_event', (event) => {
      const groupId = (event as { threadId?: string }).threadId;
      if (groupId) forgetGroupInfo(accountId, String(groupId));
    });

    listener.on('error', (err) => logger.warn({ accountId, err: String(err) }, 'zalo listener error'));

    listener.on('closed', (code, reason) => {
      if (!current()) {
        logger.info({ accountId, code }, 'zalo: ignoring closed event from superseded listener');
        return;
      }
      logger.warn({ accountId, code, reason }, 'zalo listener closed');
      this.onClosed(accountId, epoch);
    });

    listener.start({ retryOnClose: true });
  }

  private onClosed(accountId: string, epoch: number): void {
    const inst = this.instances.get(accountId);
    if (inst) inst.status = 'disconnected';
    this.hooks.onDisconnected(accountId);
    const acc = getZaloAccount(accountId);
    if (!acc || acc.manual_disconnect) {
      this.setStatus(accountId, 'disconnected');
      return;
    }

    const now = Date.now();
    const history = (this.disconnectHistory.get(accountId) ?? []).filter((t) => now - t < BREAKER_WINDOW_MS);
    history.push(now);
    this.disconnectHistory.set(accountId, history);
    if (history.length >= BREAKER_LIMIT) {
      this.disconnectHistory.delete(accountId);
      this.setStatus(accountId, 'session_expired', {
        last_error: 'Kết nối không ổn định (rớt liên tục), cần quét QR lại. Kiểm tra xem nick có đang mở Zalo Web/PC ở nơi khác không.',
      });
      logger.error({ accountId }, 'zalo circuit breaker tripped — auto-reconnect stopped');
      return;
    }
    this.setStatus(accountId, 'disconnected', { last_error: 'Mất kết nối, đang tự kết nối lại…' });
    const timer = setTimeout(() => void this.autoReconnect(accountId, epoch), RECONNECT_DELAY_MS);
    timer.unref?.();
  }

  private async autoReconnect(accountId: string, expectedEpoch: number): Promise<void> {
    const inst = this.instances.get(accountId);
    if (inst && (inst.epoch !== expectedEpoch || inst.status === 'connected' || inst.status === 'qr_pending')) return;
    try {
      await this.reconnect(accountId);
    } catch (err) {
      logger.warn({ accountId, err: String(err) }, 'zalo auto-reconnect failed; retrying later');
      const timer = setTimeout(() => void this.autoReconnect(accountId, this.instances.get(accountId)?.epoch ?? expectedEpoch), RECONNECT_RETRY_MS);
      timer.unref?.();
    }
  }

  /** Operator pressed "Ngắt kết nối": stays down until a manual reconnect/QR. */
  disconnect(accountId: string, opts: { manual: boolean; forgetSession?: boolean } = { manual: true }): void {
    this.teardown(accountId);
    this.instances.delete(accountId);
    this.reconnecting.delete(accountId);
    if (opts.forgetSession) saveZaloAccountSession(accountId, null);
    if (getZaloAccount(accountId)) {
      updateZaloAccountState(accountId, {
        status: 'disconnected',
        ...(opts.manual ? { manual_disconnect: 1, last_error: '' } : {}),
      });
    }
    this.hooks.onDisconnected(accountId);
  }

  /**
   * The operator closed the QR dialog without scanning. Stop the pending QR
   * flow; if the nick still has a saved session, fall back to it.
   */
  cancelQrLogin(accountId: string): void {
    const inst = this.instances.get(accountId);
    if (!inst || inst.status !== 'qr_pending') return;
    this.teardown(accountId);
    this.instances.delete(accountId);
    updateZaloAccountState(accountId, { status: 'disconnected' });
    const acc = getZaloAccount(accountId);
    if (acc?.has_session && acc.zalo_uid && !acc.manual_disconnect) {
      void this.reconnect(accountId).catch(() => {});
    }
  }

  /** Clear a manual disconnect and reconnect from the saved session. */
  async resume(accountId: string): Promise<void> {
    updateZaloAccountState(accountId, { manual_disconnect: 0 });
    this.disconnectHistory.delete(accountId);
    this.reconnectFailures.delete(accountId);
    await this.reconnect(accountId);
  }

  /**
   * Every 5 minutes: bring back nicks that dropped (but not manual
   * disconnects or tripped breakers). Once a day around 04:00 UTC, cycle
   * each session to refresh cookies, staggered.
   */
  private async healthTick(): Promise<void> {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const dailyRefresh = now.getUTCHours() === 4 && this.lastDailyRefresh !== today;
    if (dailyRefresh) this.lastDailyRefresh = today;

    for (const acc of listZaloAccounts()) {
      if (!acc.has_session || acc.manual_disconnect || !acc.zalo_uid) continue;
      const live = this.getLiveStatus(acc.id);
      if (dailyRefresh && live === 'connected') {
        this.teardown(acc.id);
        this.instances.delete(acc.id);
        await new Promise((r) => setTimeout(r, 5_000));
        await this.reconnect(acc.id).catch(() => {});
        await new Promise((r) => setTimeout(r, 10_000));
        continue;
      }
      if (live === 'disconnected' && acc.status !== 'session_expired') {
        await this.reconnect(acc.id).catch(() => {});
      }
    }
  }
}

export { ThreadType };
