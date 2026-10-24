// Types and Vietnamese labels for Marketing › Gửi nhóm theo lịch. Shapes
// mirror the JSON of src/zalo/routes-group-broadcast.ts.

export type ScheduleKind = 'now' | 'daily' | 'weekly' | 'monthly';
export type BroadcastState = 'draft' | 'active' | 'paused' | 'completed' | 'cancelled';
export type RunState = 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'skipped';
export type RunTrigger = 'schedule' | 'manual' | 'retry';
export type TargetState = 'pending' | 'sent' | 'failed' | 'skipped';

export type PillTone = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'high' | 'neutral' | 'accent';

export interface BroadcastRun {
  id: number;
  scheduledFor: number;
  triggeredBy: RunTrigger;
  state: RunState;
  skipReason: string;
  totalTargets: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface BroadcastTarget {
  id: number;
  threadId: number;
  groupName: string;
  state: TargetState;
  attempts: number;
  sentSteps: string[];
  errorCode: string;
  errorMessage: string;
  sentAt: number | null;
}

export interface Broadcast {
  id: number;
  name: string;
  accountId: string;
  accountName: string;
  templateId: number;
  templateName: string | null;
  targetThreadIds: number[];
  scheduleKind: ScheduleKind;
  timesOfDay: string[];
  daysOfWeek: number[];
  daysOfMonth: number[];
  timezone: string;
  startDate: string | null;
  endDate: string | null;
  minDelaySec: number;
  maxDelaySec: number;
  state: BroadcastState;
  pausedReason: string;
  consecutiveFailedRuns: number;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastRun: BroadcastRun | null;
}

export interface BroadcastDetail {
  broadcast: Broadcast;
  groups: Array<{ threadId: number; name: string }>;
  runs: Array<BroadcastRun & { targets?: BroadcastTarget[] }>;
}

export interface PlanIssue { code: string; message: string }

export interface CostPlan {
  cost: { opsPerGroup: number; opsPerRun: number; opsPerDay: number; runDurationSec: number };
  dailyCap: number;
  bulkSharePercent: number;
  budget: number;
  minGapMinutes: number | null;
  errors: PlanIssue[];
  warnings: PlanIssue[];
}

export interface ScheduleValue {
  scheduleKind: ScheduleKind;
  timesOfDay: string[];
  daysOfWeek: number[];
  daysOfMonth: number[];
  timezone: string;
  startDate: string;
  endDate: string;
}

export const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';
export const MAX_TIMES_PER_DAY = 12;
export const MAX_GROUPS = 50;
export const MIN_DELAY_FLOOR_SEC = 10;
export const MAX_DELAY_CAP_SEC = 600;

export const KIND_LABEL: Record<ScheduleKind, string> = {
  now: 'Gửi ngay một lần',
  daily: 'Hằng ngày',
  weekly: 'Hằng tuần',
  monthly: 'Hằng tháng',
};

export const BROADCAST_STATE_LABEL: Record<BroadcastState, string> = {
  draft: 'Nháp',
  active: 'Đang chạy',
  paused: 'Tạm dừng',
  completed: 'Đã xong',
  cancelled: 'Đã huỷ',
};

export const BROADCAST_STATE_TONE: Record<BroadcastState, PillTone> = {
  draft: 'neutral',
  active: 'done',
  paused: 'high',
  completed: 'accent',
  cancelled: 'cancelled',
};

export const RUN_STATE_LABEL: Record<RunState, string> = {
  pending: 'Chờ chạy',
  running: 'Đang gửi',
  completed: 'Hoàn tất',
  partial: 'Gửi một phần',
  failed: 'Lỗi',
  skipped: 'Bỏ qua',
};

export const RUN_STATE_TONE: Record<RunState, PillTone> = {
  pending: 'queued',
  running: 'running',
  completed: 'done',
  partial: 'high',
  failed: 'failed',
  skipped: 'neutral',
};

export const TRIGGER_LABEL: Record<RunTrigger, string> = {
  schedule: 'Theo lịch',
  manual: 'Gửi ngay',
  retry: 'Gửi lại nhóm lỗi',
};

export const TARGET_STATE_LABEL: Record<TargetState, string> = {
  pending: 'Chưa gửi',
  sent: 'Đã gửi',
  failed: 'Lỗi',
  skipped: 'Bỏ qua',
};

export const TARGET_STATE_TONE: Record<TargetState, PillTone> = {
  pending: 'queued',
  sent: 'done',
  failed: 'failed',
  skipped: 'neutral',
};

/** Why a run was skipped/stopped, or why a campaign was paused. */
const REASON_LABEL: Record<string, string> = {
  NICK_OFFLINE: 'Nick chưa kết nối Zalo',
  NICK_CHAT_DISABLED: 'Nick đang ở chế độ chỉ nhận tin',
  NICK_MISSING: 'Không còn nick Zalo này',
  QUIET_HOURS: 'Đang trong giờ yên tĩnh',
  BULK_BUDGET: 'Hết hạn mức gửi hàng loạt hôm nay',
  RATE_LIMITED: 'Nick chạm giới hạn gửi',
  LOCKED: 'Nick đang bị khoá gửi tin',
  BROADCAST_INACTIVE: 'Lịch đang tạm dừng hoặc đã huỷ',
  BROADCAST_MISSING: 'Lịch gửi đã bị xoá',
  PREVIOUS_RUN_ACTIVE: 'Lượt gửi trước vẫn đang chạy',
  RECENT_RUN: 'Vừa có một lượt gửi khác, bỏ lượt này để tránh gửi dồn',
  STALE: 'Chờ quá 30 phút không được xử lý nên bỏ qua',
  STUCK: 'Bị kẹt quá 2 giờ',
  INTERRUPTED: 'Bị gián đoạn do dịch vụ Zalo khởi động lại',
  WORKER_STOPPED: 'Dịch vụ Zalo dừng giữa chừng',
  TEMPLATE_MISSING: 'Mẫu tin đã bị xoá',
  TEMPLATE_EMPTY: 'Mẫu tin rỗng',
  NO_TARGETS: 'Không có nhóm nào gửi được',
  ERROR: 'Lỗi hệ thống khi xử lý lượt gửi',
  CONSECUTIVE_FAILURES: 'Tự tạm dừng sau 3 lượt liên tiếp không gửi được tin nào',
  MANUAL: 'Bạn đã tạm dừng',
};

export function reasonLabel(code: string): string {
  return REASON_LABEL[code] ?? code;
}

/** Per-group failure codes (classifyZaloError plus the worker's own). */
const ERROR_LABEL: Record<string, string> = {
  RATE_LIMIT: 'Chạm giới hạn gửi',
  NICK_OFFLINE: 'Nick mất kết nối',
  NOT_IN_GROUP: 'Nick không còn trong nhóm',
  NETWORK: 'Lỗi mạng',
  QUIET_HOURS: 'Giờ yên tĩnh',
  BULK_BUDGET: 'Hết hạn mức gửi hàng loạt',
  LOCKED: 'Nick bị khoá gửi',
  UNKNOWN: 'Lỗi không xác định',
  GROUP_REMOVED: 'Nhóm không còn thuộc nick này',
  EMPTY_MESSAGE: 'Tin trống sau khi áp biến',
};

export function errorLabel(code: string): string {
  if (!code) return '';
  if (code.startsWith('ZALO_')) return `Zalo từ chối (mã ${code.slice(5)})`;
  return ERROR_LABEL[code] ?? code;
}

export const WEEKDAYS: Array<{ value: number; label: string }> = [
  { value: 1, label: 'T2' },
  { value: 2, label: 'T3' },
  { value: 3, label: 'T4' },
  { value: 4, label: 'T5' },
  { value: 5, label: 'T6' },
  { value: 6, label: 'T7' },
  { value: 0, label: 'CN' },
];

export function describeSchedule(b: Pick<Broadcast, 'scheduleKind' | 'timesOfDay' | 'daysOfWeek' | 'daysOfMonth'>): string {
  if (b.scheduleKind === 'now') return KIND_LABEL.now;
  const times = b.timesOfDay.join(', ');
  if (b.scheduleKind === 'daily') return `Hằng ngày lúc ${times}`;
  if (b.scheduleKind === 'weekly') {
    const days = WEEKDAYS.filter((d) => b.daysOfWeek.includes(d.value)).map((d) => d.label).join(', ');
    return `Hằng tuần ${days} lúc ${times}`;
  }
  return `Hằng tháng ngày ${b.daysOfMonth.join(', ')} lúc ${times}`;
}

export function formatDurationSec(sec: number): string {
  if (sec < 60) return `${sec} giây`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} phút`;
  return `${Math.floor(m / 60)} giờ ${m % 60} phút`;
}

export function apiErrorMessage(err: unknown): string {
  const body = (err as { body?: { error?: string } })?.body;
  return body?.error || (err instanceof Error ? err.message : String(err));
}
