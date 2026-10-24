// Pure presentation logic of the shared inbox v2: tab lists, wait/owner/AI chips, avatar, status chip and the
// browser title. No DOM, no fetch: everything here is covered by inboxView.test.ts.

import type { CareConversationDto, CareConversationWorkflowDto, CareInboxView, CareWorkflowStatus } from './dto';

export const INBOX_VIEWS: readonly CareInboxView[] = ['me', 'ai', 'none', 'all'];
export const INBOX_STATUSES: readonly CareWorkflowStatus[] = ['open', 'pending', 'snoozed', 'done'];
export const DEFAULT_VIEW: CareInboxView = 'all';
export const DEFAULT_STATUS: CareWorkflowStatus = 'open';
/** Same default as the server (`waitMinutes`): used until /prefs answers or when it fails. */
export const DEFAULT_WAIT_MINUTES = 10;
/** A wait this many times the threshold is "overdue" (red). */
export const LATE_FACTOR = 3;

export const VN_TZ = 'Asia/Ho_Chi_Minh';
/** Vietnam has no daylight saving: a fixed UTC+7 offset is exact. */
const VN_OFFSET_MS = 7 * 3_600_000;

// ── wait chip ─────────────────────────────────────────────────────────────────────────────────
export type WaitTone = 'ok' | 'warn' | 'late';

export function waitMinutes(waitingSinceMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - waitingSinceMs) / 60_000));
}

/** neutral until the owner's threshold, amber after it, red from 3x the threshold. */
export function waitTone(waitingSinceMs: number | null, nowMs: number, thresholdMin: number): WaitTone | null {
  if (waitingSinceMs === null) return null;
  const threshold = thresholdMin > 0 ? thresholdMin : DEFAULT_WAIT_MINUTES;
  const mins = waitMinutes(waitingSinceMs, nowMs);
  if (mins >= threshold * LATE_FACTOR) return 'late';
  if (mins >= threshold) return 'warn';
  return 'ok';
}

export interface WaitLabel { unit: 'min' | 'hour' | 'day'; n: number }

export function waitLabel(mins: number): WaitLabel {
  if (mins < 1) return { unit: 'min', n: 0 };
  if (mins < 60) return { unit: 'min', n: mins };
  if (mins < 24 * 60) return { unit: 'hour', n: Math.floor(mins / 60) };
  return { unit: 'day', n: Math.floor(mins / (24 * 60)) };
}

// ── snooze label ──────────────────────────────────────────────────────────────────────────────
function vnDate(ms: number): Date {
  return new Date(ms + VN_OFFSET_MS);
}

export interface SnoozeUntilLabel {
  /** HH:mm in Asia/Ho_Chi_Minh. */
  time: string;
  /** today / tomorrow / another day (weekday 0 = Sunday .. 6 = Saturday). */
  day: 'today' | 'tomorrow' | 'weekday';
  weekday: number;
}

export function snoozeUntilLabel(untilMs: number, nowMs: number): SnoozeUntilLabel {
  const u = vnDate(untilMs);
  const n = vnDate(nowMs);
  const dayIndex = (d: Date) => Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86_400_000);
  const diff = dayIndex(u) - dayIndex(n);
  const time = `${String(u.getUTCHours()).padStart(2, '0')}:${String(u.getUTCMinutes()).padStart(2, '0')}`;
  return { time, day: diff <= 0 ? 'today' : diff === 1 ? 'tomorrow' : 'weekday', weekday: u.getUTCDay() };
}

// ── owner / AI chips ──────────────────────────────────────────────────────────────────────────
export type OwnerChip = { kind: 'ai'; agentId: string | null } | { kind: 'me' } | { kind: 'none' };
export type AiChip = 'draft' | 'auto' | 'off' | 'paused';

export function ownerChip(w: CareConversationWorkflowDto): OwnerChip {
  if (w.assignee.kind === 'owner') return { kind: 'me' };
  if (w.assignee.kind === 'agent') return { kind: 'ai', agentId: w.assignee.agentId ?? w.ai.agentId };
  return { kind: 'none' };
}

/** takeover > AI off > draft waiting > auto-send. Channels without AI (Telegram) never show an AI chip. */
export function aiChip(w: CareConversationWorkflowDto): AiChip | null {
  if (!w.ai.supported) return null;
  if (w.ai.takenOver) return 'paused';
  if (w.ai.agentId && w.ai.mode === 'off') return 'off';
  if (w.pendingDrafts > 0) return 'draft';
  if (w.ai.agentId && w.ai.mode === 'auto') return 'auto';
  return null;
}

/** AI is working this conversation (same definition as the server's "AI đang lo" tab). */
export function aiIsActive(w: CareConversationWorkflowDto): boolean {
  return Boolean(w.ai.agentId) && w.ai.mode !== 'off' && !w.ai.takenOver && w.ai.supported;
}

// ── avatar ────────────────────────────────────────────────────────────────────────────────────
/** Initials of the last two words ("Nguyễn Minh Thư" -> "MT"); one word -> its first two letters. */
export function initialsOf(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = (w: string) => Array.from(w)[0] ?? '';
  if (words.length === 1) return Array.from(words[0]).slice(0, 2).join('').toUpperCase();
  return (first(words[words.length - 2]) + first(words[words.length - 1])).toUpperCase();
}

/** Stable 0..359 hue per conversation id: the avatar tint never changes between visits. */
export function avatarHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

// ── row / header view model ───────────────────────────────────────────────────────────────────
export function unreadCount(c: Pick<CareConversationDto, 'remoteUnreadCount' | 'localUnread'>): number {
  return Math.max(c.remoteUnreadCount, c.localUnread ? 1 : 0);
}

export interface StatusChip {
  status: CareWorkflowStatus;
  /** Only for open: minutes the customer waits. */
  waitMin: number | null;
  snoozedUntilMs: number | null;
}

export function statusChipOf(c: CareConversationDto, nowMs: number): StatusChip | null {
  const w = c.workflow;
  if (!w) return null;
  return {
    status: w.status,
    waitMin: w.status === 'open' && c.waitingSinceMs !== null ? waitMinutes(c.waitingSinceMs, nowMs) : null,
    snoozedUntilMs: w.status === 'snoozed' ? w.snoozedUntilMs : null,
  };
}

/** Number shown in the page title and the tab: how many conversations need the owner. */
export function titleCount(counts: { byView: Record<CareInboxView, number> } | null | undefined): number | null {
  const n = counts?.byView?.me;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function documentTitle(base: string, n: number | null): string {
  if (!n || n <= 0) return base;
  return `(${n > 99 ? '99+' : n}) ${base}`;
}

/** i18n key (under care.) of the one-line explanation shown next to the AI mode switch. */
export function aiHintKey(w: CareConversationWorkflowDto): string {
  if (!w.ai.supported) return 'inbox2.ai.hint.unsupported';
  if (w.ai.takenOver) return 'inbox2.ai.hint.takenOver';
  if (!w.ai.agentId) return 'inbox2.ai.hint.noAgent';
  return `inbox2.ai.hint.${w.ai.mode}`;
}
