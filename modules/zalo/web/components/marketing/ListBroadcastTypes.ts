// Shared types, labels and helpers for the 1-1 list broadcast pages.
// Shapes mirror src/zalo/routes-list-broadcast.ts.

export type ListBroadcastState = 'draft' | 'active' | 'paused' | 'completed' | 'cancelled';
export type ListRecipientState = 'pending' | 'sent' | 'failed' | 'skipped';

export interface ListFilter {
  activeWithinDays?: number | null;
  nameContains?: string;
  excludePaused?: boolean;
  excludeThreadIds?: number[];
  includeThreadIds?: number[];
}

export interface ListCounts {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
}

export interface ListEstimate {
  opsPerRecipient: number;
  effectiveDailyQuota: number;
  sendingDays: number;
  calendarDays: number;
  dailyDurationSec: number;
  windowMinutes: number;
  fitsPerDay: number;
  warnings: string[];
}

export interface ListBroadcast {
  id: number;
  name: string;
  templateId: number;
  templateName: string | null;
  accounts: Array<{ id: string; label: string; exists: boolean }>;
  accountIds: string[];
  filter: ListFilter;
  windowStart: string;
  windowEnd: string;
  daysOfWeek: number[];
  timezone: string;
  startDate: string | null;
  endDate: string | null;
  dailyQuota: number;
  perNickDailyQuota: number;
  minDelaySec: number;
  maxDelaySec: number;
  state: ListBroadcastState;
  pausedReason: string;
  consecutiveFailedBatches: number;
  recipientsSyncedAt: number | null;
  counts: ListCounts;
  sentToday: number;
  createdAt: number;
  updatedAt: number;
}

export interface ListBatch {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  sent: number;
  failed: number;
  skipped: number;
  stopReason: string;
}

export interface ListRecipient {
  id: number;
  threadId: number;
  accountId: string;
  name: string;
  state: ListRecipientState;
  sentSteps: number;
  attempts: number;
  errorCode: string;
  sentAt: number | null;
}

export interface ListDetail {
  broadcast: ListBroadcast;
  batches: ListBatch[];
  windowOpenNow: boolean;
  nextWindowOpenAt: number | null;
  estimate: ListEstimate;
}

export interface WindowValue {
  windowStart: string;
  windowEnd: string;
  daysOfWeek: number[];
  timezone: string;
  startDate: string | null;
  endDate: string | null;
}

export const STATE_LABEL: Record<ListBroadcastState, string> = {
  draft: 'Nháp',
  active: 'Đang chạy',
  paused: 'Tạm dừng',
  completed: 'Hoàn tất',
  cancelled: 'Đã huỷ',
};

export const STATE_TONE: Record<ListBroadcastState, 'neutral' | 'running' | 'high' | 'done' | 'cancelled'> = {
  draft: 'neutral',
  active: 'running',
  paused: 'high',
  completed: 'done',
  cancelled: 'cancelled',
};

export const RECIPIENT_LABEL: Record<ListRecipientState, string> = {
  pending: 'Chờ gửi',
  sent: 'Đã gửi',
  failed: 'Lỗi',
  skipped: 'Bỏ qua',
};

export const RECIPIENT_TONE: Record<ListRecipientState, 'queued' | 'done' | 'failed' | 'neutral'> = {
  pending: 'queued',
  sent: 'done',
  failed: 'failed',
  skipped: 'neutral',
};

const ERROR_LABEL: Record<string, string> = {
  OPTED_OUT: 'Khách đã từ chối nhận tin',
  THREAD_GONE: 'Không còn hội thoại 1-1',
  NICK_REMOVED: 'Nick đã bị bỏ khỏi chiến dịch',
  MANUAL: 'Bỏ qua thủ công',
  EMPTY_MESSAGE: 'Tin nhắn rỗng sau khi điền biến',
  RATE_LIMIT: 'Zalo giới hạn tốc độ',
  NICK_OFFLINE: 'Nick mất kết nối',
  NOT_IN_GROUP: 'Không còn trong hội thoại',
  NETWORK: 'Lỗi mạng',
  QUIET_HOURS: 'Đang trong giờ nghỉ',
  BULK_BUDGET: 'Hết ngân sách gửi hàng loạt hôm nay',
  LOCKED: 'Nick đang bị khoá gửi',
  UNKNOWN: 'Lỗi không xác định',
};

export function errorLabel(code: string): string {
  if (!code) return '';
  return ERROR_LABEL[code] ?? (code.startsWith('ZALO_') ? `Zalo từ chối (${code.slice(5)})` : code);
}

const PAUSE_LABEL: Record<string, string> = {
  MANUAL: 'Bạn đã tạm dừng',
  CONSECUTIVE_FAILURES: '3 lượt gửi liên tiếp không gửi được tin nào',
  TEMPLATE_MISSING: 'Mẫu tin đã bị xoá',
  TEMPLATE_EMPTY: 'Mẫu tin không có nội dung',
  ATTACHMENT_MISSING: 'Thiếu tệp đính kèm của mẫu tin',
};

export function pauseLabel(reason: string): string {
  return reason ? (PAUSE_LABEL[reason] ?? reason) : '';
}

const STOP_LABEL: Record<string, string> = {
  '': 'Gửi hết lượt',
  OUT_OF_WINDOW: 'Hết khung giờ',
  DAILY_QUOTA: 'Chạm hạn mức ngày',
  NOT_ACTIVE: 'Bị tạm dừng/huỷ giữa chừng',
  STOPPED: 'Dịch vụ Zalo dừng',
  RESTART: 'Dịch vụ Zalo khởi động lại',
  NICK_BLOCKED: 'Nick offline hoặc hết hạn mức',
  NICK_RATE_LIMITED: 'Nick chạm giới hạn tốc độ/ngày',
  NICK_QUIET_HOURS: 'Đang trong giờ nghỉ',
  NICK_BULK_BUDGET: 'Hết ngân sách gửi hàng loạt',
  NICK_NOT_CONNECTED: 'Nick mất kết nối',
  NICK_CHAT_DISABLED: 'Nick đang tắt gửi tin',
  NICK_LOCKED: 'Nick đang bị khoá gửi',
};

export function stopLabel(reason: string): string {
  return STOP_LABEL[reason] ?? reason;
}

const DATE_TIME = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function fmtDateTime(sec: number | null | undefined): string {
  return sec ? DATE_TIME.format(new Date(sec * 1000)) : '—';
}

export function fmtDuration(sec: number): string {
  if (sec < 90) return `${sec} giây`;
  if (sec < 5400) return `${Math.round(sec / 60)} phút`;
  return `${Math.round(sec / 360) / 10} giờ`;
}

export function errMsg(err: unknown): string {
  const body = (err as { body?: { error?: string } })?.body;
  return body?.error || (err instanceof Error ? err.message : String(err));
}

export const INPUT = 'w-full px-3 py-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none text-[12.5px] text-[var(--color-text)]';
export const BTN = 'toolbar-control control-button inline-flex items-center gap-1.5 px-3 rounded-md text-[12px] text-[var(--color-text)] hover:bg-[var(--color-control-hover)] disabled:opacity-40';
export const BTN_ACCENT = 'toolbar-control control-button control-accent inline-flex items-center gap-1.5 px-3 rounded-md text-[12px] font-medium disabled:opacity-40';
export const LABEL = 'block text-[12px] font-medium text-[var(--color-text-muted)] mb-1.5';
