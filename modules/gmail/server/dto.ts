/**
 * JSON shapes returned by /api/email/* (src/email/routes.ts). Mirrored by
 * web/src/lib/email.ts — change both together. Times: *At fields ending in
 * "Ms" or documented as ms are milliseconds, everything else is seconds.
 */

import type {
  EmailAccountStatus, EmailAssignmentMode, EmailAssignmentScope, EmailCategory, EmailDirection,
  EmailOutboxStatus, EmailProtectionSettings, EmailRunStatus, EmailSenderType, EmailThreadView,
} from './store.js';

export type {
  EmailAccountStatus, EmailAssignmentMode, EmailAssignmentScope, EmailCategory, EmailDirection,
  EmailOutboxStatus, EmailProtectionSettings, EmailRunStatus, EmailSenderType, EmailThreadView,
};

export interface EmailServiceStatusDto {
  /** Master switch (email_settings 'enabled'). */
  enabled: boolean;
  composioKey: boolean;
  /** EMAIL_AUTOREPLY_ENABLED kill switch. */
  autoreplyEnabled: boolean;
  /** LLM_SPAWN_ENABLED kill switch. */
  llmEnabled: boolean;
  worker: { running: boolean; lastTickAt: number | null; lastError: string };
  budget: { usedThisHour: number; capPerHour: number };
  draftCount: number;
  pendingCount: number;
}

export interface EmailAccountDto {
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

export interface EmailThreadSummaryDto {
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
  /** Opens the thread in Gmail web. */
  gmailUrl: string;
}

export interface EmailAttachmentDto {
  filename: string;
  mimeType: string;
  size: number;
}

export interface EmailMessageDto {
  id: number;
  direction: EmailDirection;
  senderType: EmailSenderType;
  fromEmail: string;
  fromName: string;
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  /** Raw HTML; the page sanitizes it and renders it in a sandboxed iframe. */
  bodyHtml: string;
  snippet: string;
  attachments: EmailAttachmentDto[];
  origin: 'live' | 'backfill';
  /** ms */
  sentAt: number;
}

export interface EmailOutboxDto {
  id: number;
  threadId: number;
  body: string;
  toEmail: string;
  origin: 'operator' | 'agent';
  agentId: string;
  status: EmailOutboxStatus;
  sendAfter: number | null;
  reviewReason: string;
  error: string;
  createdAt: number;
  sentAt: number | null;
}

export interface EmailRunDto {
  id: number;
  threadId: number;
  threadSubject: string;
  customerEmail: string;
  accountId: string;
  agentId: string;
  status: EmailRunStatus;
  skipReason: string;
  /** Vietnamese label for skipReason ('' when none). */
  skipLabel: string;
  replyText: string;
  note: string;
  latencyMs: number;
  costUsd: number;
  createdAt: number;
}

export interface EmailAssignmentDto {
  id: number;
  accountId: string;
  scope: EmailAssignmentScope;
  matchValue: string;
  agentId: string;
  mode: EmailAssignmentMode;
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

export interface EmailThreadDetailDto {
  thread: EmailThreadSummaryDto;
  messages: EmailMessageDto[];
  /** Rows in draft / pending / sending / failed, newest first. */
  outbox: EmailOutboxDto[];
  runs: EmailRunDto[];
  /** The assignment that currently applies to this thread, if any. */
  assignment: EmailAssignmentDto | null;
}

export interface EmailSettingsResponseDto {
  settings: EmailProtectionSettings;
  defaults: EmailProtectionSettings;
  quietNow: boolean;
}

/** Result of "Nhờ agent soạn" (POST /api/email/threads/:id/draft). */
export interface EmailTurnOutcomeDto {
  status: 'draft' | 'queued' | 'skipped' | 'failed' | 'busy';
  note: string;
  outboxId?: number;
}

export interface EmailSyncResultDto {
  accountId: string;
  fetched: number;
  inserted: number;
  error?: string;
  /** The mailbox is owned by Customer Care core: legacy wrote nothing. */
  skipped?: 'care_owned';
}
