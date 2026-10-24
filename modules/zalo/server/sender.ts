/**
 * Every outbound Zalo action goes through here: dashboard sends, agent
 * replies, marketing broadcasts and typing pings.
 *
 * Ported from ZaloCRM's shared/zalo-operations.ts, zalo-rate-limiter.ts
 * (in-memory path), sdk-limit-service.ts defaults and the agent typing
 * keepalive. Limits protect the nick from being flagged by Zalo:
 *   - every SDK call is counted by one ZaloLimiter (limits.ts): per-nick daily
 *     caps (messages counted from the DB, so a restart does not reset them;
 *     warm-up nicks get a lower cap) plus burst windows;
 *   - marketing sends (`bulk: true`) are refused in quiet hours and beyond
 *     the nick's bulk share of the daily cap;
 *   - repeated rejections from Zalo lock the nick's sending (auto-lock): a
 *     flagged nick that keeps sending only gets banned faster.
 */

import fs from 'fs';
import path from 'path';

import { ThreadType, type API } from 'zca-js';

import {
  countZaloBroadcastSince,
  claimNextZaloOutbox,
  countZaloOutboundSince,
  deleteZaloMessage,
  getZaloAccount,
  getZaloMedia,
  getZaloProtectionSettings,
  getZaloThread,
  insertZaloMessage,
  markZaloOutboxFailed,
  markZaloOutboxSent,
  recordZaloThreadActivity,
  setZaloMessageRemoteIds,
  updateZaloAccountSettings,
  type ZaloOutboxRow,
  type ZaloThreadRow,
} from './store.js';
import { logger } from './compat.js';
import { renderText, type ZaloMention } from './content.js';
import { classifyZaloError, effectiveMessageCap, isQuietHours, startOfLocalDayMs, ZaloLimiter, type ZaloOpCategory } from './limits.js';
import { getZaloMediaPath, type ZaloAttachment } from './media.js';
import { normalizeZaloStyles, type ZaloStyle } from './rich-text.js';
import { clearPendingEcho, registerPendingEcho } from './ingest.js';
import type { ZaloSessionPool } from './session.js';

type SendContent = Exclude<Parameters<API['sendMessage']>[0], string>;

const TYPING_INTERVAL_MS = 5_000;
const TYPING_MAX_PINGS = 5;
const TYPING_MAX_MS = 45_000;
const MAX_MESSAGE_CHARS = 2000;
const STEP_GAP_MIN_MS = 800;
const STEP_GAP_MAX_MS = 2_500;

export class ZaloSendError extends Error {
  /** Rows already stored by earlier steps of the same sendRich call. */
  messageIds: number[] = [];

  constructor(
    message: string,
    readonly code:
      | 'NOT_CONNECTED' | 'CHAT_DISABLED' | 'RATE_LIMITED' | 'API_ERROR' | 'INVALID'
      // Marketing sends (bulk: true) only:
      | 'QUIET_HOURS' | 'BULK_BUDGET'
      // Nick auto-locked after repeated Zalo rejections:
      | 'LOCKED',
  ) {
    super(message);
    this.name = 'ZaloSendError';
  }
}

const SESSION_EXPIRED_PATTERNS = [
  'session expired', 'session has expired', 'not logged in', 'login required',
  'cookie expired', 'cookie is invalid', 'invalid session', 'invalid token',
];

function isSessionExpired(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return SESSION_EXPIRED_PATTERNS.some((p) => msg.includes(p));
}

function isTransientNetwork(err: unknown): boolean {
  const e = err as { message?: string; cause?: { message?: string } };
  const msg = `${e?.message ?? ''} ${e?.cause?.message ?? ''}`.toLowerCase();
  return ['fetch failed', 'other side closed', 'socket', 'econnreset', 'etimedout', 'und_err'].some((p) => msg.includes(p));
}

function zaloThreadType(thread: ZaloThreadRow): ThreadType {
  return thread.thread_type === 'group' ? ThreadType.Group : ThreadType.User;
}

function stepGapMs(): number {
  return STEP_GAP_MIN_MS + Math.floor(Math.random() * (STEP_GAP_MAX_MS - STEP_GAP_MIN_MS));
}

/** The formatting ranges of an outbox row; unreadable JSON sends the text unformatted rather than failing the row. */
function outboxStyles(row: ZaloOutboxRow): ZaloStyle[] {
  if (!row.styles_json || row.styles_json === '[]') return [];
  try { return normalizeZaloStyles(JSON.parse(row.styles_json), row.body.length); } catch { return []; }
}

/** Files of an outbox row (shared inbox replies); throws when an upload is gone so the row fails instead of sending a partial reply. */
function outboxAttachments(row: ZaloOutboxRow): ZaloAttachment[] {
  if (!row.attachments_json || row.attachments_json === '[]') return [];
  let list: unknown;
  try { list = JSON.parse(row.attachments_json); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const out: ZaloAttachment[] = [];
  for (const item of list) {
    const id = Number((item as { mediaId?: unknown } | null)?.mediaId);
    const media = Number.isInteger(id) ? getZaloMedia(id) : undefined;
    const full = media ? getZaloMediaPath(media) : null;
    if (!media || !full) throw new ZaloSendError('Tệp đính kèm không còn trên máy chủ', 'INVALID');
    out.push({ path: full, kind: media.kind, name: media.file_name });
  }
  return out;
}

export interface ZaloSenderOptions {
  /** Operator notice — used when a nick gets auto-locked. */
  notify?: (text: string) => Promise<void>;
  /** Pause between the steps of one message; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  limiter?: ZaloLimiter;
}

interface FailureState {
  count: number;
  threads: Set<number>;
  lastError: string;
}

export class ZaloSender {
  /** Shared with the session pool, so ingest/history reads draw on the same budgets. */
  readonly limiter: ZaloLimiter;
  private readonly notify?: (text: string) => Promise<void>;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Consecutive Zalo rejections per nick (cleared by any successful send). */
  private failures = new Map<string, FailureState>();
  private draining = false;

  constructor(private readonly pool: ZaloSessionPool, opts: ZaloSenderOptions = {}) {
    this.limiter = opts.limiter ?? pool.limiter ?? new ZaloLimiter();
    this.notify = opts.notify;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Same check the agent gate uses before spending a model call. */
  nickCapReached(accountId: string): boolean {
    const acc = getZaloAccount(accountId);
    if (!acc) return true;
    const now = new Date();
    const since = startOfLocalDayMs(now, getZaloProtectionSettings().timezone);
    return countZaloOutboundSince(accountId, since) >= effectiveMessageCap(acc, now);
  }

  /**
   * Marketing messages this nick may still send today: its bulk share of the
   * (warm-up aware) daily cap, never more than the cap left after everything
   * else it sent.
   */
  bulkBudgetRemaining(accountId: string): number {
    const acc = getZaloAccount(accountId);
    if (!acc) return 0;
    const now = new Date();
    const settings = getZaloProtectionSettings();
    const since = startOfLocalDayMs(now, settings.timezone);
    const cap = effectiveMessageCap(acc, now, settings);
    const share = Math.floor((settings.bulkSharePercent / 100) * cap) - countZaloBroadcastSince(accountId, since);
    const total = cap - countZaloOutboundSince(accountId, since);
    return Math.max(0, Math.min(share, total));
  }

  /** Check-and-record one operation against the nick's limit for a category. */
  tryConsume(accountId: string, category: ZaloOpCategory): boolean {
    return this.limiter.consume(accountId, category).ok;
  }

  /**
   * Everything that must hold before a message row is written: the nick
   * exists, sending is allowed (not locked / not chat-off), marketing sends
   * are inside active hours and budget, and the message limits have room for
   * `rows` more messages.
   */
  private guard(accountId: string, opts: { bulk: boolean; rows: number }): void {
    const acc = getZaloAccount(accountId);
    if (!acc) throw new ZaloSendError('Không tìm thấy tài khoản Zalo', 'INVALID');
    if (acc.send_lock_reason) {
      throw new ZaloSendError(`Nick đang bị khoá gửi tự động: ${acc.send_lock_reason}. Bật lại "Cho phép gửi tin" để mở khoá.`, 'LOCKED');
    }
    if (!acc.chat_enabled) throw new ZaloSendError('Nick đang ở chế độ chỉ nhận tin (đã tắt gửi)', 'CHAT_DISABLED');
    if (opts.bulk) {
      const settings = getZaloProtectionSettings();
      if (isQuietHours(new Date(), settings)) {
        throw new ZaloSendError(`Đang trong giờ nghỉ (${settings.quietHours.start}–${settings.quietHours.end}), tin marketing chờ đến giờ hoạt động`, 'QUIET_HOURS');
      }
      if (this.bulkBudgetRemaining(accountId) <= 0) {
        throw new ZaloSendError('Đã dùng hết hạn mức tin marketing trong ngày của nick', 'BULK_BUDGET');
      }
    }
    const check = this.limiter.check(accountId, 'message', opts.rows);
    if (!check.ok) {
      const limit = this.limiter.limitFor(accountId, 'message');
      throw new ZaloSendError(
        check.reason === 'daily'
          ? `Đã đạt giới hạn ${limit.daily} tin/ngày của nick`
          : `Gửi quá nhanh (>${limit.burst} tin/${Math.round(limit.windowMs / 1000)} giây)`,
        'RATE_LIMITED',
      );
    }
  }

  /**
   * Run an SDK call with the ZaloCRM safety layers: one reconnect+retry on
   * a session-expired error, and up to two backoff retries on network blips.
   * Rejections from Zalo itself feed the restriction auto-lock.
   */
  private async exec<T>(thread: ZaloThreadRow, fn: (api: API) => Promise<T>): Promise<T> {
    const accountId = thread.account_id;
    let api = this.pool.getApi(accountId);
    if (!api) throw new ZaloSendError('Nick Zalo chưa kết nối', 'NOT_CONNECTED');
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await fn(api);
        this.failures.delete(accountId);
        return result;
      } catch (err) {
        lastErr = err;
        if (attempt === 0 && isSessionExpired(err)) {
          await this.pool.reconnect(accountId);
          const fresh = this.pool.getApi(accountId);
          if (!fresh) throw new ZaloSendError('Phiên Zalo hết hạn, cần quét QR lại', 'NOT_CONNECTED');
          api = fresh;
          continue;
        }
        if (isTransientNetwork(err) && attempt < 2) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
        break;
      }
    }
    const code = (lastErr as { code?: unknown })?.code;
    const failure = new ZaloSendError(`${String((lastErr as Error)?.message ?? lastErr)}${code != null ? ` [zalo:${String(code)}]` : ''}`, 'API_ERROR');
    this.noteFailure(thread, failure);
    throw failure;
  }

  /**
   * Count a rejection from Zalo toward the auto-lock. Network blips, rate
   * limits, offline nicks and "not in group" say nothing about the nick's
   * health, so they do not count. The lock needs the failures to span two
   * threads (a single bad recipient must not lock the nick) unless there are
   * two more of them than the threshold.
   */
  private noteFailure(thread: ZaloThreadRow, err: ZaloSendError): void {
    const cls = classifyZaloError(err);
    if (!cls.startsWith('ZALO_') && cls !== 'UNKNOWN') return;
    const threshold = getZaloProtectionSettings().restrictionLockThreshold;
    if (threshold <= 0) return;
    const state = this.failures.get(thread.account_id) ?? { count: 0, threads: new Set<number>(), lastError: '' };
    state.count++;
    state.threads.add(thread.id);
    state.lastError = err.message;
    this.failures.set(thread.account_id, state);
    if (state.count >= threshold && (state.threads.size >= 2 || state.count >= threshold + 2)) {
      this.lockNick(thread.account_id, state);
    }
  }

  private lockNick(accountId: string, state: FailureState): void {
    const reason = `${state.count} lần gửi liên tiếp bị Zalo từ chối. Lỗi cuối: ${state.lastError}`.slice(0, 300);
    updateZaloAccountSettings(accountId, { chat_enabled: 0, send_lock_reason: reason });
    this.failures.delete(accountId);
    const acc = getZaloAccount(accountId);
    logger.warn({ accountId, reason }, 'zalo nick auto-locked after repeated send rejections');
    void this.notify?.(
      `🔒 Zalo: nick ${acc?.display_name || acc?.label || accountId} bị khoá gửi tin tự động.\n` +
      `${reason}\nTiếp tục gửi khi Zalo đang từ chối dễ khiến nick bị khoá thật. Kiểm tra nick trên điện thoại, rồi bật lại "Cho phép gửi tin" ở Zalo · Tài khoản.`,
    )?.catch(() => {});
  }

  /** One text message: row first (so Zalo's echo is recognised), then the API call. */
  private async sendTextStep(thread: ZaloThreadRow, input: {
    text: string;
    styles?: ZaloStyle[];
    mentions?: ZaloMention[];
    senderType: 'agent' | 'operator' | 'broadcast';
    senderName?: string;
    bulk: boolean;
  }): Promise<number> {
    this.guard(thread.account_id, { bulk: input.bulk, rows: 1 });

    const sentAtMs = Date.now();
    const mentions = thread.thread_type === 'group' && input.mentions?.length ? input.mentions : undefined;
    const messageId = insertZaloMessage({
      threadId: thread.id,
      zaloMsgId: null,
      senderType: input.senderType,
      senderName: input.senderName ?? '',
      body: input.text,
      contentType: 'text',
      mentions,
      origin: 'outbound',
      sentAtMs,
    });
    if (messageId === null) throw new ZaloSendError('Không ghi được tin vào lịch sử', 'API_ERROR');
    registerPendingEcho(thread.id, messageId, input.text);
    this.limiter.record(thread.account_id, 'message');

    try {
      const content: SendContent = { msg: input.text };
      // An empty styles array is rejected by Zalo, so only pass it when non-empty.
      if (input.styles?.length) content.styles = input.styles as SendContent['styles'];
      if (mentions) content.mentions = mentions.map((m) => ({ uid: m.uid, pos: m.pos, len: m.len }));
      const res = await this.exec(thread, (api) => api.sendMessage(content, thread.external_id, zaloThreadType(thread)));
      const msgId = res?.message?.msgId;
      if (msgId !== undefined && msgId !== null) setZaloMessageRemoteIds(messageId, String(msgId));
      clearPendingEcho(thread.id, messageId);
      recordZaloThreadActivity(thread.id, { sentAtMs, preview: input.text, senderType: input.senderType, live: true });
      return messageId;
    } catch (err) {
      clearPendingEcho(thread.id, messageId);
      deleteZaloMessage(messageId);
      throw err;
    }
  }

  /** Images (as an album) and files in one API call; one stored row per attachment. */
  private async sendAttachmentStep(thread: ZaloThreadRow, attachments: ZaloAttachment[], input: {
    senderType: 'agent' | 'operator' | 'broadcast';
    senderName?: string;
    bulk: boolean;
  }): Promise<number[]> {
    this.guard(thread.account_id, { bulk: input.bulk, rows: attachments.length });

    const sentAtMs = Date.now();
    const rows: Array<{ id: number; contentType: string; body: string }> = [];
    const discard = () => { for (const r of rows) deleteZaloMessage(r.id); };
    for (const a of attachments) {
      const contentType = a.kind === 'image' ? 'image' : a.kind === 'video' ? 'video' : 'file';
      // Same shape as Zalo's own attachment payloads so renderText labels it.
      const body = JSON.stringify({ title: a.name || path.basename(a.path), description: '' });
      const id = insertZaloMessage({
        threadId: thread.id,
        zaloMsgId: null,
        senderType: input.senderType,
        senderName: input.senderName ?? '',
        body,
        contentType,
        origin: 'outbound',
        sentAtMs,
      });
      if (id === null) { discard(); throw new ZaloSendError('Không ghi được tin vào lịch sử', 'API_ERROR'); }
      rows.push({ id, contentType, body });
    }
    this.limiter.record(thread.account_id, 'message', rows.length);

    try {
      const res = await this.exec(thread, (api) => api.sendMessage(
        { msg: '', attachments: attachments.map((a) => a.path) },
        thread.external_id,
        zaloThreadType(thread),
      ));
      const sent = res?.attachment ?? [];
      rows.forEach((r, i) => {
        const msgId = sent[i]?.msgId;
        if (msgId !== undefined && msgId !== null) setZaloMessageRemoteIds(r.id, String(msgId));
      });
      const last = rows[rows.length - 1];
      recordZaloThreadActivity(thread.id, {
        sentAtMs, preview: renderText(last.contentType, last.body), senderType: input.senderType, live: true,
      });
      return rows.map((r) => r.id);
    } catch (err) {
      discard();
      throw err;
    }
  }

  /**
   * Send a text message and record it in the thread. The row is written
   * before the API call and registered as a pending echo, so Zalo's echo of
   * this very message is matched to it instead of being stored again.
   */
  async sendText(input: {
    threadId: number;
    text: string;
    senderType: 'agent' | 'operator';
    senderName?: string;
    mentions?: ZaloMention[];
  }): Promise<number> {
    const thread = getZaloThread(input.threadId);
    if (!thread) throw new ZaloSendError('Không tìm thấy hội thoại', 'INVALID');
    const text = input.text.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!text) throw new ZaloSendError('Tin nhắn trống', 'INVALID');
    // A mention cut off by the length cap would point past the text.
    const mentions = input.mentions?.filter((m) => m.pos + m.len <= text.length);
    return this.sendTextStep(thread, { text, mentions, senderType: input.senderType, senderName: input.senderName, bulk: false });
  }

  /**
   * Send one message step: text (with optional rich styles and mentions)
   * and/or attachments (images go out as an album, files/videos as files).
   * When both are given, text goes first, then attachments, 0.8–2.5 s apart.
   * `bulk: true` marks a marketing send: refused with QUIET_HOURS inside
   * quiet hours and with BULK_BUDGET past the nick's bulk share of today's
   * cap. Throws ZaloSendError like sendText; on a failure after the text
   * went out, `err.messageIds` holds the rows already stored. Returns the
   * stored message ids.
   */
  async sendRich(input: {
    threadId: number;
    text?: string;
    styles?: ZaloStyle[];
    attachments?: ZaloAttachment[];
    senderType: 'agent' | 'operator' | 'broadcast';
    senderName?: string;
    mentions?: ZaloMention[];
    bulk?: boolean;
  }): Promise<{ messageIds: number[] }> {
    const thread = getZaloThread(input.threadId);
    if (!thread) throw new ZaloSendError('Không tìm thấy hội thoại', 'INVALID');
    // Only the end is trimmed: style and mention offsets count from the start.
    const text = (input.text ?? '').replace(/\s+$/, '').slice(0, MAX_MESSAGE_CHARS);
    const hasText = text.trim() !== '';
    // A mention cut off by the length cap would point past the text.
    const mentions = input.mentions?.filter((m) => m.pos + m.len <= text.length);
    const attachments = input.attachments ?? [];
    if (!hasText && attachments.length === 0) throw new ZaloSendError('Tin nhắn trống', 'INVALID');
    for (const a of attachments) {
      if (!fs.existsSync(a.path)) throw new ZaloSendError(`Không tìm thấy tệp đính kèm: ${a.name || path.basename(a.path)}`, 'INVALID');
    }
    const bulk = input.bulk === true;
    const messageIds: number[] = [];
    try {
      if (hasText) {
        messageIds.push(await this.sendTextStep(thread, {
          text,
          styles: normalizeZaloStyles(input.styles, text.length),
          mentions,
          senderType: input.senderType,
          senderName: input.senderName,
          bulk,
        }));
      }
      if (attachments.length > 0) {
        if (hasText) await this.sleep(stepGapMs());
        messageIds.push(...await this.sendAttachmentStep(thread, attachments, {
          senderType: input.senderType, senderName: input.senderName, bulk,
        }));
      }
    } catch (err) {
      if (err instanceof ZaloSendError) err.messageIds = messageIds;
      throw err;
    }
    return { messageIds };
  }

  /**
   * Keep the "đang soạn tin" bubble alive while an agent thinks. Never
   * throws; returns a stop function that is safe to call repeatedly. Pings
   * draw on the nick's chat_action budget, so a keepalive is also capped at
   * 5 pings / 45 s per reply.
   */
  startTyping(thread: ZaloThreadRow): () => void {
    const startedAt = Date.now();
    let pings = 0;
    let timer: NodeJS.Timeout | null = null;
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const ping = () => {
      if (stopped) return;
      if (pings >= TYPING_MAX_PINGS || Date.now() - startedAt >= TYPING_MAX_MS) { stop(); return; }
      pings++;
      const api = this.pool.getApi(thread.account_id);
      if (api && this.tryConsume(thread.account_id, 'chat_action')) {
        void api.sendTypingEvent(thread.external_id, zaloThreadType(thread)).catch(() => {});
      }
      timer = setTimeout(ping, TYPING_INTERVAL_MS);
      timer.unref?.();
    };
    ping();
    return stop;
  }

  /** Send every pending outbox row, oldest first, one at a time. */
  async drainOutbox(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let row: ZaloOutboxRow | null;
      while ((row = claimNextZaloOutbox()) !== null) {
        await this.sendOutboxRow(row);
      }
    } finally {
      this.draining = false;
    }
  }

  private async sendOutboxRow(row: ZaloOutboxRow): Promise<void> {
    let mentions: ZaloMention[] | undefined;
    try {
      mentions = row.mentions_json ? JSON.parse(row.mentions_json) as ZaloMention[] : undefined;
    } catch { mentions = undefined; }
    try {
      const attachments = outboxAttachments(row);
      const styles = outboxStyles(row);
      let messageId: number;
      if (attachments.length > 0 || styles.length > 0) {
        // Shared inbox reply with files or formatting: same guard, echo matching and message rows as a text send.
        const { messageIds } = await this.sendRich({
          threadId: row.thread_id,
          text: row.body,
          ...(styles.length ? { styles } : {}),
          attachments,
          senderType: row.origin === 'agent' ? 'agent' : 'operator',
          senderName: row.agent_id,
          mentions,
        });
        messageId = messageIds[0];
      } else {
        messageId = await this.sendText({
          threadId: row.thread_id,
          text: row.body,
          senderType: row.origin === 'agent' ? 'agent' : 'operator',
          senderName: row.agent_id,
          mentions,
        });
      }
      markZaloOutboxSent(row.id, messageId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      markZaloOutboxFailed(row.id, msg);
      logger.warn({ outboxId: row.id, threadId: row.thread_id, err: msg }, 'zalo outbox send failed');
    }
  }
}
