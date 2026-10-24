// Shared types and labels for the Zalo pages. Shapes mirror the JSON returned by
// modules/zalo/server/dashboard-routes.ts (mounted at /api/m/zalo).

export type ZaloAccountStatus = 'disconnected' | 'qr_pending' | 'connecting' | 'connected' | 'session_expired';

export interface ZaloQrState {
  image: string | null;
  phase: 'waiting' | 'scanned' | 'expired' | 'declined' | 'done' | 'error';
  scannedName?: string;
  error?: string;
}

export interface ZaloLiveState {
  live: 'disconnected' | 'qr_pending' | 'connecting' | 'connected';
  qr: ZaloQrState | null;
  backfilling: boolean;
}

/** SDK operation categories the limiter meters (src/zalo/limits.ts). */
export type ZaloOpCategory =
  | 'message' | 'chat_action' | 'reaction' | 'group_read' | 'query'
  | 'friend_lookup' | 'friend_action' | 'profile' | 'contact_sync';

export interface ZaloCategoryLimit { daily: number; burst: number; windowSec: number }
export type ZaloLimitOverride = Partial<ZaloCategoryLimit>;
export type ZaloLimitOverrides = Partial<Record<ZaloOpCategory, ZaloLimitOverride>>;

export interface ZaloProtectionSettings {
  timezone: string;
  quietHours: { enabled: boolean; start: string; end: string };
  agentDailyReplyCap: number;
  restrictionLockThreshold: number;
  warmupSchedule: number[];
  bulkSharePercent: number;
  limits: ZaloLimitOverrides;
}

export interface ZaloProtectionResponse {
  settings: ZaloProtectionSettings;
  /** Code-level defaults per category. */
  defaults: Record<ZaloOpCategory, ZaloCategoryLimit>;
  categories: ZaloOpCategory[];
  quietNow: boolean;
}

export const CATEGORY_LABEL: Record<ZaloOpCategory, string> = {
  message: 'Gửi tin nhắn',
  chat_action: 'Thao tác chat (đang soạn…)',
  reaction: 'Thả cảm xúc',
  group_read: 'Đọc thông tin / lịch sử nhóm',
  query: 'Tra cứu thông tin người dùng',
  friend_lookup: 'Tìm bạn theo SĐT',
  friend_action: 'Kết bạn / huỷ kết bạn',
  profile: 'Đổi hồ sơ nick',
  contact_sync: 'Đồng bộ danh bạ',
};

export interface ZaloAccount {
  id: string;
  label: string;
  zaloUid: string | null;
  displayName: string;
  avatarUrl: string;
  status: ZaloAccountStatus;
  chatEnabled: boolean;
  dailyMessageCap: number;
  manualDisconnect: boolean;
  hasSession: boolean;
  lastError: string;
  lastConnectedAt: number | null;
  threadCount: number;
  live: ZaloLiveState | null;
  /** Non-empty = sending was locked automatically after repeated Zalo rejections. */
  sendLockReason: string;
  effectiveMessageCap: number;
  warmup: { enabled: boolean; startedAt: number | null; week: number; cap: number | null };
  /** Per-nick overrides as saved. */
  limits: ZaloLimitOverrides;
  effectiveLimits: Record<ZaloOpCategory, ZaloCategoryLimit>;
  /** Today's usage per category (`limit` = daily limit). */
  usage: Record<ZaloOpCategory, { used: number; limit: number }>;
}

export interface ZaloServiceStatus {
  enabled: boolean;
  daemon: { running: boolean; pid: number | null };
}

export interface ZaloThreadSummary {
  id: number;
  accountId: string;
  accountLabel: string;
  threadType: 'user' | 'group';
  externalId: string;
  name: string;
  avatarUrl: string;
  membersCount: number | null;
  lastMessageAt: number;
  lastPreview: string;
  lastSenderType: string;
  unreadCount: number;
  paused: boolean;
  pauseReason: string;
  optedOut: boolean;
}

export interface ZaloMessage {
  id: number;
  senderUid?: string;
  senderType: 'customer' | 'self' | 'agent' | 'operator' | 'broadcast';
  senderName: string;
  contentType: string;
  text: string;
  mediaUrl: string | null;
  quote: { text: string; senderName: string } | null;
  origin: string;
  isDeleted: boolean;
  sentAt: number;
}

export const STATUS_LABEL: Record<ZaloAccountStatus, string> = {
  connected: 'Đang kết nối',
  connecting: 'Đang kết nối lại…',
  qr_pending: 'Chờ quét QR',
  disconnected: 'Mất kết nối',
  session_expired: 'Cần quét QR lại',
};

export const STATUS_TONE: Record<ZaloAccountStatus, 'done' | 'running' | 'queued' | 'failed' | 'cancelled'> = {
  connected: 'done',
  connecting: 'running',
  qr_pending: 'queued',
  disconnected: 'cancelled',
  session_expired: 'failed',
};

const TIME_FMT = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' });
const DATE_FMT = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit' });
const FULL_FMT = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Compact timestamp for lists: time today, date otherwise. */
export function formatMsgTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? TIME_FMT.format(d) : DATE_FMT.format(d);
}

export function formatFullTime(ms: number): string {
  return ms ? FULL_FMT.format(new Date(ms)) : '';
}

export function dayKey(ms: number): string {
  return new Date(ms).toDateString();
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
