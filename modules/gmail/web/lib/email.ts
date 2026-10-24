// Shared types and labels for the Sale › Email pages. Shapes mirror
// src/email/dto.ts (the JSON of src/email/routes.ts) — change both together.

export type EmailAccountStatus = 'ACTIVE' | 'EXPIRED' | 'MISSING';
export type EmailDirection = 'in' | 'out';
export type EmailSenderType = 'customer' | 'self' | 'agent' | 'operator';
export type EmailCategory = 'primary' | 'promotions' | 'social' | 'updates' | 'forums' | '';
export type EmailScope = 'account' | 'domain' | 'sender';
export type EmailMode = 'observe' | 'draft' | 'auto';
export type EmailRunStatus = 'draft' | 'queued' | 'sent' | 'skipped' | 'failed';
export type EmailOutboxStatus = 'draft' | 'pending' | 'sending' | 'sent' | 'failed' | 'discarded';
export type EmailThreadView = 'all' | 'needs_reply' | 'drafts' | 'agent' | 'automated';

export interface EmailProtectionSettings {
  agentDailyReplyCap: number;
  apiBudgetPerHour: number;
  staleHours: number;
  quietHours: { enabled: boolean; start: string; end: string };
  timezone: string;
  extraAutomatedPatterns: string[];
}

export interface EmailServiceStatus {
  enabled: boolean;
  composioKey: boolean;
  autoreplyEnabled: boolean;
  llmEnabled: boolean;
  worker: { running: boolean; lastTickAt: number | null; lastError: string };
  budget: { usedThisHour: number; capPerHour: number };
  draftCount: number;
  pendingCount: number;
}

export interface EmailAccount {
  id: string;
  connectionId: string;
  emailAddress: string;
  displayName: string;
  status: EmailAccountStatus;
  syncEnabled: boolean;
  pollMinutes: number;
  backfillDays: number;
  signature: string;
  dailySendCap: number;
  sentToday: number;
  threadCount: number;
  draftCount: number;
  lastPollAt: number | null;
  careSince: number | null;
  lastError: string;
  createdAt: number;
}

export interface EmailThreadSummary {
  id: number;
  accountId: string;
  gmailThreadId: string;
  subject: string;
  customerEmail: string;
  customerName: string;
  /** ms */
  lastMessageAt: number;
  lastPreview: string;
  lastDirection: EmailDirection | '';
  messageCount: number;
  unreadCount: number;
  category: EmailCategory;
  automatedReason: string;
  pausedUntil: number | null;
  optedOut: boolean;
  draftCount: number;
  pendingCount: number;
  gmailUrl: string;
}

export interface EmailAttachment { filename: string; mimeType: string; size: number }

export interface EmailMessage {
  id: number;
  direction: EmailDirection;
  senderType: EmailSenderType;
  fromEmail: string;
  fromName: string;
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string;
  snippet: string;
  attachments: EmailAttachment[];
  origin: 'live' | 'backfill';
  /** ms */
  sentAt: number;
}

export interface EmailOutbox {
  id: number;
  threadId: number;
  body: string;
  toEmail: string;
  origin: 'operator' | 'agent';
  agentId: string;
  status: EmailOutboxStatus;
  /** seconds */
  sendAfter: number | null;
  reviewReason: string;
  error: string;
  createdAt: number;
  sentAt: number | null;
}

export interface EmailRun {
  id: number;
  threadId: number;
  threadSubject: string;
  customerEmail: string;
  accountId: string;
  agentId: string;
  status: EmailRunStatus;
  skipReason: string;
  skipLabel: string;
  replyText: string;
  note: string;
  latencyMs: number;
  costUsd: number;
  createdAt: number;
}

export interface EmailAssignment {
  id: number;
  accountId: string;
  scope: EmailScope;
  matchValue: string;
  agentId: string;
  mode: EmailMode;
  instructions: string;
  reviewKeywords: string[];
  primaryOnly: boolean;
  maxRepliesPerThreadDay: number;
  humanPauseMinutes: number;
  autoDelaySeconds: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface EmailThreadDetail {
  thread: EmailThreadSummary;
  messages: EmailMessage[];
  outbox: EmailOutbox[];
  runs: EmailRun[];
  assignment: EmailAssignment | null;
}

export interface EmailSettingsResponse {
  settings: EmailProtectionSettings;
  defaults: EmailProtectionSettings;
  quietNow: boolean;
}

export interface EmailTurnOutcome {
  status: 'draft' | 'queued' | 'skipped' | 'failed' | 'busy';
  note: string;
  outboxId?: number;
}

export interface EmailSyncResult { accountId: string; fetched: number; inserted: number; error?: string }

export const MODE_LABEL: Record<EmailMode, string> = {
  observe: 'Chỉ theo dõi — agent không soạn thư',
  draft: 'Soạn nháp — admin duyệt rồi mới gửi',
  auto: 'Tự động duyệt — agent tự gửi sau thời gian chờ',
};

export const MODE_SHORT: Record<EmailMode, string> = {
  observe: 'Theo dõi',
  draft: 'Soạn nháp',
  auto: 'Tự động',
};

export const SCOPE_LABEL: Record<EmailScope, string> = {
  account: 'Mọi thư của hộp thư',
  domain: 'Theo tên miền người gửi',
  sender: 'Theo địa chỉ người gửi',
};

export const RUN_STATUS_LABEL: Record<EmailRunStatus, string> = {
  draft: 'Nháp chờ duyệt',
  queued: 'Chờ tự gửi',
  sent: 'Đã gửi',
  skipped: 'Bỏ qua',
  failed: 'Lỗi',
};

export const RUN_STATUS_TONE: Record<EmailRunStatus, 'accent' | 'done' | 'neutral' | 'failed' | 'queued'> = {
  draft: 'accent',
  queued: 'queued',
  sent: 'done',
  skipped: 'neutral',
  failed: 'failed',
};

export const OUTBOX_STATUS_LABEL: Record<EmailOutboxStatus, string> = {
  draft: 'Nháp',
  pending: 'Chờ gửi',
  sending: 'Đang gửi',
  sent: 'Đã gửi',
  failed: 'Gửi lỗi',
  discarded: 'Đã bỏ',
};

export const ACCOUNT_STATUS_LABEL: Record<EmailAccountStatus, string> = {
  ACTIVE: 'Đang kết nối',
  EXPIRED: 'Hết hạn — cần kết nối lại',
  MISSING: 'Không còn trên Composio',
};

export const VIEW_LABEL: Record<EmailThreadView, string> = {
  all: 'Tất cả',
  needs_reply: 'Cần trả lời',
  drafts: 'Chờ duyệt',
  agent: 'Agent đã xử lý',
  automated: 'Thư tự động',
};

export const CATEGORY_LABEL: Record<EmailCategory, string> = {
  primary: 'Chính',
  promotions: 'Quảng cáo',
  social: 'Mạng xã hội',
  updates: 'Cập nhật',
  forums: 'Diễn đàn',
  '': '',
};

export const DEFAULT_REVIEW_KEYWORDS = 'hoàn tiền, khiếu nại, hợp đồng, báo giá, thanh toán, chuyển khoản, luật sư, refund, complaint, invoice';
