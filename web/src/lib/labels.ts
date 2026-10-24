import type { RuntimeId, TaskStatus } from '@core/types';

export const RUNTIME_LABEL: Record<RuntimeId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  hermes: 'Hermes',
  mock: 'Mock',
};

export type Tone = 'neutral' | 'accent' | 'success' | 'error' | 'warn' | 'info' | 'running' | 'queued' | 'done' | 'failed' | 'cancelled' | 'waiting' | 'review' | 'good' | 'bad' | 'high' | 'medium' | 'low';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: 'Chờ',
  running: 'Đang chạy',
  waiting: 'Chờ việc con',
  review: 'Chờ duyệt',
  done: 'Xong',
  failed: 'Lỗi',
  cancelled: 'Đã huỷ',
};

export const STATUS_TONE: Record<TaskStatus, Tone> = {
  queued: 'queued',
  running: 'running',
  waiting: 'waiting',
  review: 'warn',
  done: 'success',
  failed: 'error',
  cancelled: 'cancelled',
};

export const SOURCE_LABEL = (source: string): string => {
  if (source === 'user') return 'Bạn';
  if (source === 'api') return 'API';
  if (source === 'chat') return 'Trò chuyện';
  if (source.startsWith('schedule:')) return 'Lịch định kỳ';
  if (source.startsWith('agent:')) return `Agent ${source.slice(6)}`;
  if (source.startsWith('module:')) return `Module ${source.slice(7)}`;
  return source;
};

export const TRIGGER_LABEL: Record<string, string> = {
  assigned: 'Được giao',
  chat: 'Trò chuyện',
  schedule: 'Lịch định kỳ',
  children_done: 'Việc con xong',
  commented: 'Có bình luận',
  retry: 'Thử lại',
  module: 'Module',
};

export const ERROR_FAMILY_LABEL: Record<string, string> = {
  auth: 'Chưa đăng nhập CLI',
  quota: 'Hết hạn mức',
  transient: 'Lỗi tạm thời',
  config: 'Sai cấu hình',
  refusal: 'Bị từ chối',
  timeout: 'Quá thời gian',
  budget: 'Vượt ngân sách',
  access: 'Bị chặn quyền',
  cancelled: 'Đã huỷ',
  unknown: 'Không rõ',
};

export const CATEGORY_LABEL: Record<string, string> = {
  sales: 'Sales',
  marketing: 'Marketing',
  ops: 'Vận hành',
  other: 'Khác',
};
