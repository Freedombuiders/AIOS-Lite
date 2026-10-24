/**
 * Anti-ban protection for Zalo nicks: per-category SDK limits, quiet hours,
 * warm-up for new nicks, error classification and the text heuristics the
 * agent gates use.
 *
 * Ported from ZaloCRM's sdk-limit-service.ts (limit defaults and the
 * "nick override → default → code" precedence), zalo-rate-limiter.ts (burst
 * windows + daily counters) and ai-agent/trigger-gate.ts (noise / opt-out).
 * Differences: settings live in SQLite (zalo_settings), "today" is the local
 * day in the configured timezone (quota resets at local midnight, not UTC),
 * and message usage is counted from zalo_messages so a restart never resets it.
 *
 * Everything time-dependent takes `now` so the math is testable.
 */

import {
  addZaloUsage,
  countZaloOutboundSince,
  getZaloAccount,
  getZaloProtectionSettings,
  getZaloUsage,
  sanitizeZaloLimitOverrides,
  type ZaloAccountRow,
  type ZaloLimitOverride,
  type ZaloProtectionSettings,
} from './store.js';
import { foldVietnamese } from './content.js';

export {
  getZaloProtectionSettings,
  saveZaloProtectionSettings,
  type ZaloProtectionSettings,
} from './store.js';

export type ZaloOpCategory =
  | 'message' | 'chat_action' | 'reaction' | 'group_read' | 'query'
  | 'friend_lookup' | 'friend_action' | 'profile' | 'contact_sync';

export type ZaloErrorClass =
  | 'RATE_LIMIT' | 'NICK_OFFLINE' | 'NOT_IN_GROUP' | 'NETWORK'
  | 'QUIET_HOURS' | 'BULK_BUDGET' | 'LOCKED' | 'UNKNOWN' | `ZALO_${string}`;

export const ZALO_OP_CATEGORIES: readonly ZaloOpCategory[] = [
  'message', 'chat_action', 'reaction', 'group_read', 'query',
  'friend_lookup', 'friend_action', 'profile', 'contact_sync',
];

export interface CategoryLimit {
  daily: number;
  burst: number;
  windowSec: number;
}

/** Code-level defaults (ZaloCRM's DEFAULT_SDK_LIMITS). */
export const DEFAULT_LIMITS: Record<ZaloOpCategory, CategoryLimit> = {
  message:       { daily: 1000,  burst: 20, windowSec: 30 },
  chat_action:   { daily: 500,  burst: 15, windowSec: 30 },
  reaction:      { daily: 300,  burst: 10, windowSec: 30 },
  group_read:    { daily: 1000, burst: 20, windowSec: 30 },
  query:         { daily: 2000, burst: 30, windowSec: 30 },
  friend_lookup: { daily: 1000, burst: 15, windowSec: 30 },
  friend_action: { daily: 30,   burst: 8,  windowSec: 60 },
  profile:       { daily: 10,   burst: 3,  windowSec: 60 },
  contact_sync:  { daily: 100,  burst: 5,  windowSec: 60 },
};

// ── Time in the configured timezone ─────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    // hourCycle h23 avoids "24:00" at midnight that hour12:false yields on some engines.
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

export function localParts(now: Date, tz: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatterFor(tz).formatToParts(now)) {
    if (p.type !== 'literal') out[p.type] = parseInt(p.value, 10);
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour, minute: out.minute, second: out.second };
}

/** Local calendar date in `tz` as YYYY-MM-DD (the key of zalo_usage.day). */
export function localDay(now: Date, tz: string): string {
  const p = localParts(now, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Epoch ms of the most recent local midnight in `tz`. */
export function startOfLocalDayMs(now: Date, tz: string): number {
  const p = localParts(now, tz);
  const midnightAsUtc = Date.UTC(p.year, p.month - 1, p.day);
  const offsetAt = (instant: number): number => {
    const q = localParts(new Date(instant), tz);
    return Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second) - Math.floor(instant / 1000) * 1000;
  };
  let start = midnightAsUtc - offsetAt(now.getTime());
  // Across a DST change the offset at midnight differs from the offset now.
  const corrected = midnightAsUtc - offsetAt(start);
  if (corrected !== start) start = corrected;
  return start;
}

function clockMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/**
 * True when the local time in `tz` falls in [start, end). A window with
 * start > end crosses midnight (22:00–07:00); start == end is empty.
 */
export function isWithinHours(now: Date, start: string, end: string, tz: string): boolean {
  const p = localParts(now, tz);
  const minutes = p.hour * 60 + p.minute;
  const s = clockMinutes(start);
  const e = clockMinutes(end);
  if (s === e) return false;
  return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}

/** True inside the configured quiet hours (default 22:00–07:00 Asia/Ho_Chi_Minh). */
export function isQuietHours(now: Date = new Date(), settings: ZaloProtectionSettings = getZaloProtectionSettings()): boolean {
  const q = settings.quietHours;
  return q.enabled && isWithinHours(now, q.start, q.end, settings.timezone);
}

// ── Warm-up and effective limits ────────────────────────────────────

type WarmupFields = Pick<ZaloAccountRow, 'warmup_enabled' | 'warmup_started_at'>;
type CapFields = WarmupFields & Pick<ZaloAccountRow, 'daily_message_cap' | 'limits_json'>;

/**
 * Warm-up week (1-based) of a nick being broken in, or 0 when warm-up is off,
 * has not started (the nick never connected) or the schedule is finished.
 */
export function warmupWeek(account: WarmupFields, now: Date = new Date(), schedule?: number[]): number {
  if (!account.warmup_enabled || !account.warmup_started_at) return 0;
  const weeks = schedule ?? getZaloProtectionSettings().warmupSchedule;
  const days = Math.max(0, Math.floor((now.getTime() / 1000 - account.warmup_started_at) / 86400));
  const week = Math.floor(days / 7) + 1;
  return week <= weeks.length ? week : 0;
}

export function parseNickOverrides(account: Pick<ZaloAccountRow, 'limits_json'> | undefined): Partial<Record<ZaloOpCategory, ZaloLimitOverride>> {
  if (!account?.limits_json) return {};
  try {
    return sanitizeZaloLimitOverrides(JSON.parse(account.limits_json));
  } catch {
    return {};
  }
}

/**
 * Messages this nick may send per day: the nick's own cap, lowered to the
 * warm-up cap of the current week and to any `message.daily` ceiling set in
 * the global or per-nick limits.
 */
export function effectiveMessageCap(
  account: CapFields,
  now: Date = new Date(),
  settings: ZaloProtectionSettings = getZaloProtectionSettings(),
): number {
  let cap = account.daily_message_cap;
  const week = warmupWeek(account, now, settings.warmupSchedule);
  if (week > 0) cap = Math.min(cap, settings.warmupSchedule[week - 1]);
  const ceilings = [settings.limits.message?.daily, parseNickOverrides(account).message?.daily];
  for (const c of ceilings) if (typeof c === 'number') cap = Math.min(cap, c);
  return cap;
}

export interface EffectiveLimit { daily: number; burst: number; windowMs: number }

/** code default → global settings override → per-nick override (field by field). */
export function effectiveLimit(
  account: CapFields | undefined,
  category: ZaloOpCategory,
  now: Date = new Date(),
  settings: ZaloProtectionSettings = getZaloProtectionSettings(),
): EffectiveLimit {
  const base = DEFAULT_LIMITS[category];
  const global = settings.limits[category] ?? {};
  const nick = account ? parseNickOverrides(account)[category] ?? {} : {};
  const burst = nick.burst ?? global.burst ?? base.burst;
  const windowSec = nick.windowSec ?? global.windowSec ?? base.windowSec;
  let daily = nick.daily ?? global.daily ?? base.daily;
  if (category === 'message' && account) daily = effectiveMessageCap(account, now, settings);
  return { daily, burst, windowMs: windowSec * 1000 };
}

// ── Limiter ─────────────────────────────────────────────────────────

export interface LimitCheck {
  ok: boolean;
  reason?: 'daily' | 'burst';
  used: number;
  limit: number;
  /** Rough wait before a burst slot frees up. */
  retryAfterMs?: number;
}

/**
 * Per-nick, per-category limiter shared by the sender, ingest, history and
 * session code of one daemon. Daily usage is persisted (messages are counted
 * from zalo_messages, everything else from zalo_usage); burst windows are
 * in memory.
 */
export class ZaloLimiter {
  private windows = new Map<string, number[]>();
  private readonly clock: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.clock = opts.now ?? (() => Date.now());
  }

  limitFor(accountId: string, category: ZaloOpCategory, nowMs: number = this.clock()): EffectiveLimit {
    return effectiveLimit(getZaloAccount(accountId), category, new Date(nowMs));
  }

  /** Operations of this category the nick has used so far today (local day). */
  used(accountId: string, category: ZaloOpCategory, nowMs: number = this.clock()): number {
    const settings = getZaloProtectionSettings();
    const now = new Date(nowMs);
    if (category === 'message') return countZaloOutboundSince(accountId, startOfLocalDayMs(now, settings.timezone));
    return getZaloUsage(accountId, localDay(now, settings.timezone))[category] ?? 0;
  }

  check(accountId: string, category: ZaloOpCategory, count = 1, nowMs: number = this.clock()): LimitCheck {
    const limit = this.limitFor(accountId, category, nowMs);
    const used = this.used(accountId, category, nowMs);
    if (used + count > limit.daily) return { ok: false, reason: 'daily', used, limit: limit.daily };
    const recent = this.recent(accountId, category, limit.windowMs, nowMs);
    if (recent.length + Math.min(count, limit.burst) > limit.burst) {
      return {
        ok: false, reason: 'burst', used, limit: limit.burst,
        retryAfterMs: Math.max(0, recent[0] + limit.windowMs - nowMs),
      };
    }
    return { ok: true, used, limit: limit.daily };
  }

  /** Count operations that already happened (or are about to, after a check). */
  record(accountId: string, category: ZaloOpCategory, count = 1, nowMs: number = this.clock()): void {
    const limit = this.limitFor(accountId, category, nowMs);
    const key = `${accountId}:${category}`;
    const list = this.recent(accountId, category, limit.windowMs, nowMs);
    for (let i = 0; i < count; i++) list.push(nowMs);
    this.windows.set(key, list);
    // Message rows in zalo_messages are the daily counter for that category.
    if (category !== 'message') {
      addZaloUsage(accountId, localDay(new Date(nowMs), getZaloProtectionSettings().timezone), category, count);
    }
  }

  /** check + record in one step. */
  consume(accountId: string, category: ZaloOpCategory, count = 1, nowMs: number = this.clock()): LimitCheck {
    const res = this.check(accountId, category, count, nowMs);
    if (res.ok) this.record(accountId, category, count, nowMs);
    return res;
  }

  /** Daily operations left for this category. */
  remaining(accountId: string, category: ZaloOpCategory, nowMs: number = this.clock()): number {
    return Math.max(0, this.limitFor(accountId, category, nowMs).daily - this.used(accountId, category, nowMs));
  }

  /** `{ used, limit }` per category for the dashboard. */
  usage(accountId: string, nowMs: number = this.clock()): Record<ZaloOpCategory, { used: number; limit: number }> {
    const out = {} as Record<ZaloOpCategory, { used: number; limit: number }>;
    for (const cat of ZALO_OP_CATEGORIES) {
      out[cat] = { used: this.used(accountId, cat, nowMs), limit: this.limitFor(accountId, cat, nowMs).daily };
    }
    return out;
  }

  private recent(accountId: string, category: ZaloOpCategory, windowMs: number, nowMs: number): number[] {
    const key = `${accountId}:${category}`;
    const list = (this.windows.get(key) ?? []).filter((t) => nowMs - t < windowMs);
    this.windows.set(key, list);
    return list;
  }
}

// ── Error classification ────────────────────────────────────────────

/** Map a send error (ZaloSendError or raw zca-js error) to a stable class. */
export function classifyZaloError(err: unknown): ZaloErrorClass {
  const code = (err as { code?: unknown })?.code;
  switch (code) {
    case 'RATE_LIMITED': return 'RATE_LIMIT';
    case 'NOT_CONNECTED': case 'SESSION_EXPIRED': return 'NICK_OFFLINE';
    case 'QUIET_HOURS': return 'QUIET_HOURS';
    case 'BULK_BUDGET': return 'BULK_BUDGET';
    case 'LOCKED': case 'CHAT_DISABLED': return 'LOCKED';
  }
  const message = String((err as { message?: unknown })?.message ?? err);
  const zaloCode = /\[zalo:([^\]]+)\]/.exec(message)?.[1];
  if (zaloCode) return `ZALO_${zaloCode}`;
  if (/not.*member|left|kick/i.test(message)) return 'NOT_IN_GROUP';
  if (/fetch failed|econnreset|etimedout|socket|und_err|other side closed/i.test(message)) return 'NETWORK';
  if (/rate.?limit/i.test(message)) return 'RATE_LIMIT';
  return 'UNKNOWN';
}

// ── Customer-message heuristics (agent gates) ───────────────────────

// Compared after diacritic folding: ừ→u, ờ→o, à/ạ→a, vâng→vang, dạ→da.
const NOISE_RE = /^(ok|oke|okie|okay|uhm|u|um|o|a|vang|da|tks|thanks|👍[\u{1F3FB}-\u{1F3FF}]?|❤️?)[\s!.]*$/u;

/** A bare acknowledgement ("ok", "dạ", "👍") that needs no reply. */
export function isNoise(text: string): boolean {
  const t = foldVietnamese(text.normalize('NFC')).trim();
  return t !== '' && NOISE_RE.test(t);
}

const OPT_OUT_ACCENTED = [
  'đừng nhắn', 'không nhắn nữa', 'không muốn nhận', 'hủy đăng ký', 'huỷ đăng ký', 'đừng làm phiền',
];
const OPT_OUT_FOLDED = [
  'dung nhan', 'khong nhan nua', 'khong muon nhan', 'huy dang ky', 'dung lam phien', 'unsubscribe',
];

/**
 * The customer asks to stop receiving messages. Accented text is matched
 * against accented phrases so "đúng, nhận được rồi" never counts as "đừng
 * nhắn"; only text typed without any diacritics falls back to folded matching.
 */
export function matchesOptOut(text: string): boolean {
  const nfc = text.normalize('NFC').toLowerCase();
  const folded = foldVietnamese(nfc);
  if (/\bstop\b/.test(folded) || folded.includes('unsubscribe')) return true;
  if (OPT_OUT_ACCENTED.some((p) => nfc.includes(p))) return true;
  return folded === nfc && OPT_OUT_FOLDED.some((p) => folded.includes(p));
}
