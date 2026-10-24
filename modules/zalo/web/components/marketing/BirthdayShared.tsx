// Shared types, labels and small helpers for the birthday greetings page.
// Shapes mirror the JSON from src/zalo/routes-birthday.ts.

export type BirthdayOccasion = 'before' | 'on_day' | 'after';
export type GreetingState = 'pending' | 'sent' | 'failed' | 'skipped';
export type UpcomingState = 'planned' | 'inactive' | 'missed' | GreetingState;

export interface BirthdayConfig {
  enabled: boolean;
  sendTime: string;
  timezone: string;
  lateToleranceMinutes: number;
  beforeEnabled: boolean;
  beforeDays: number;
  beforeTemplateId: number | null;
  onDayEnabled: boolean;
  onDayTemplateId: number | null;
  afterEnabled: boolean;
  afterDays: number;
  afterTemplateId: number | null;
  perNickDailyQuota: number;
  minDelaySec: number;
  maxDelaySec: number;
  accountIds: string[];
  updatedAt: number;
}

export interface BirthdayConfigResponse {
  config: BirthdayConfig;
  quietHours: { enabled: boolean; start: string; end: string };
  sendTimeInQuietHours: boolean;
}

export interface BirthdayStats {
  threads: number;
  withBirthDate: number;
  nicks: Array<{ accountId: string; label: string; threads: number; withBirthDate: number }>;
}

export interface UpcomingOccasion {
  occasion: BirthdayOccasion;
  sendOn: string;
  state: UpcomingState;
  greetingId: number | null;
  skipReason: string;
}

export interface UpcomingBirthday {
  threadId: number;
  name: string;
  accountId: string;
  accountLabel: string;
  birthdayOn: string;
  daysUntil: number;
  age: number | null;
  occasions: UpcomingOccasion[];
}

export interface BirthdayGreeting {
  id: number;
  threadId: number;
  name: string;
  accountId: string;
  accountLabel: string;
  occasion: BirthdayOccasion;
  birthdayOn: string;
  dueAt: number;
  state: GreetingState;
  skipReason: string;
  errorCode: string;
  sentSteps: number;
  sentAt: number | null;
}

export const INPUT = 'w-full px-3 py-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none text-[12.5px] text-[var(--color-text)] disabled:opacity-50';
export const BTN = 'toolbar-control control-button inline-flex items-center gap-1.5 px-3 rounded-md text-[12px] text-[var(--color-text)] hover:bg-[var(--color-control-hover)] disabled:opacity-40';
export const LABEL = 'block text-[12px] font-medium text-[var(--color-text-muted)] mb-1.5';

export const OCCASION_LABEL: Record<BirthdayOccasion, string> = {
  before: 'Trước sinh nhật',
  on_day: 'Đúng ngày sinh nhật',
  after: 'Sau sinh nhật',
};

export const STATE_LABEL: Record<UpcomingState, string> = {
  planned: 'Sẽ gửi',
  inactive: 'Chưa bật',
  missed: 'Đã lỡ',
  pending: 'Chờ gửi',
  sent: 'Đã gửi',
  failed: 'Lỗi',
  skipped: 'Bỏ qua',
};

export const STATE_TONE: Record<UpcomingState, 'queued' | 'neutral' | 'running' | 'done' | 'failed' | 'cancelled' | 'accent'> = {
  planned: 'accent',
  inactive: 'neutral',
  missed: 'cancelled',
  pending: 'running',
  sent: 'done',
  failed: 'failed',
  skipped: 'cancelled',
};

/** Why a greeting was skipped or is still waiting (skip_reason from the worker). */
export const REASON_LABEL: Record<string, string> = {
  TOO_LATE: 'Quá giờ cho phép',
  OPTED_OUT: 'Khách đã từ chối nhận tin',
  OCCASION_DISABLED: 'Dịp chúc đã tắt',
  NO_TEMPLATE: 'Thiếu mẫu tin',
  TEMPLATE_EMPTY: 'Mẫu tin rỗng',
  THREAD_GONE: 'Không còn hội thoại',
  NOT_PRIVATE: 'Không phải chat 1-1',
  NICK_GONE: 'Nick đã bị xoá',
  NICK_NOT_ALLOWED: 'Nick không nằm trong danh sách',
  UNKNOWN_OCCASION: 'Dịp chúc không hợp lệ',
  MANUAL: 'Bạn đã bỏ qua',
  WAIT_NICK: 'Đang chờ nick',
  WAIT_CHAT_DISABLED: 'Nick đang tắt gửi tin',
  WAIT_NOT_CONNECTED: 'Nick chưa kết nối',
  WAIT_QUOTA: 'Nick đã đủ hạn mức hôm nay',
  WAIT_BULK_BUDGET: 'Hết ngân sách tin marketing hôm nay',
  WAIT_QUIET_HOURS: 'Đang trong giờ yên tĩnh',
  WAIT_RATE_LIMITED: 'Nick đang chạm giới hạn gửi',
  WAIT_LOCKED: 'Nick đang bị khoá bảo vệ',
};

export const ERROR_LABEL: Record<string, string> = {
  RATE_LIMIT: 'Zalo giới hạn tốc độ',
  NICK_OFFLINE: 'Nick mất kết nối',
  NOT_IN_GROUP: 'Không còn trong hội thoại',
  NETWORK: 'Lỗi mạng',
  UNKNOWN: 'Lỗi không rõ',
};

export function reasonLabel(code: string): string {
  return REASON_LABEL[code] ?? code;
}

export function errMsg(err: unknown): string {
  const body = (err as { body?: { error?: string } })?.body;
  return body?.error || (err instanceof Error ? err.message : String(err));
}

/** '2026-03-10' → '10/03/2026'; '0000-03-10' → '10/03'. */
export function formatBirthDate(birth: string | null): string {
  if (!birth) return '';
  const [y, m, d] = birth.split('-');
  return y === '0000' ? `${d}/${m}` : `${d}/${m}/${y}`;
}

/** '2026-03-10' → '10/03'. */
export function shortDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

export function formatDateTime(sec: number, timezone: string): string {
  try {
    return new Date(sec * 1000).toLocaleString('vi-VN', {
      timeZone: timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
  } catch {
    return new Date(sec * 1000).toLocaleString('vi-VN');
  }
}

export function daysUntilLabel(days: number): string {
  if (days === 0) return 'Hôm nay';
  if (days === 1) return 'Ngày mai';
  if (days < 0) return `${-days} ngày trước`;
  return `${days} ngày nữa`;
}
