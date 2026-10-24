/**
 * Customer Care API DTOs (CC-07). Pure data: no Node, DB or provider imports, so the web bundle
 * can import this file directly. Timestamps are epoch milliseconds, IDs are opaque strings.
 */

import type { CareAccountDeliveryDto, CareConversationWorkflowDto, CareInboxCountsDto } from './dto-inbox.js';

export type CareApiChannel = 'zalo' | 'telegram' | 'email';
export type CareApiConversationKind = 'direct' | 'group' | 'topic' | 'email_thread';
export type CareApiStage = 'new' | 'consulting' | 'quoted' | 'deposit' | 'won' | 'lost';

/** Machine-readable codes the API can answer with. `CareErrorCode` values plus transport-level ones. */
export type CareApiErrorCode =
  | 'UNSUPPORTED_CAPABILITY'
  | 'STALE_REVISION'
  | 'DUPLICATE_REQUEST_PAYLOAD_MISMATCH'
  | 'ACCOUNT_FROZEN'
  | 'SEND_DISABLED'
  | 'SYNC_DISABLED'
  | 'UNRESOLVED_UNCERTAINTY'
  | 'CREDENTIAL_DECODE_FAILED'
  | 'RATE_LIMITED'
  | 'FENCING_REJECTED'
  | 'INVALID_TARGET'
  | 'INVALID_CURSOR'
  | 'INVALID_COMMAND'
  | 'CONFIGURATION_CONFLICT'
  | 'NOT_FOUND'
  | 'TERMINAL_REJECTION'
  | 'NETWORK_TIMEOUT'
  | 'READ_DISABLED'
  | 'READ_MODEL_UNAVAILABLE'
  | 'STORE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

/** Every non-2xx answer. Messages are fixed, scrubbed strings: never provider or database text. */
export interface CareApiError {
  code: CareApiErrorCode;
  message: string;
  retryAt?: number;
  currentRevision?: number;
  /**
   * Stable machine detail. `reason` is an UPPER_SNAKE code (UNDECIDED_ITEMS, PRIORITY_CONFLICT,
   * MODULE_DISABLED, ...); other keys are reason-specific IDs/codes, never free text.
   */
  details?: { reason?: string } & Record<string, unknown>;
}

export interface CareApiPage<T> {
  items: T[];
  /** Opaque cursor for the next page, or null when the scope is exhausted. */
  nextCursor: string | null;
}

// ── lifecycle / accounts ──────────────────────────────────────────────────────────────────────
export interface CareAccountDto {
  id: string;
  channel: CareApiChannel;
  connectorKind: string;
  nativeAccountId: string;
  label: string;
  desiredState: 'active' | 'paused' | 'draining' | 'disconnected';
  healthStatus: 'healthy' | 'degraded' | 'error';
  syncEnabled: boolean;
  sendEnabled: boolean;
  aiEnabled: boolean;
  writeOwner: 'legacy' | 'draining' | 'core';
  ownerEpoch: number;
  updatedAtMs: number;
  /** Email accounts: the signature appended to replies once (read-only). Null for chat or when none is configured. */
  signature: string | null;
  /** Inbox v2: how replies from the shared inbox are delivered for this account. */
  delivery?: CareAccountDeliveryDto;
}

export interface CareStatusDto {
  ok: true;
  /** Highest event sequence ever issued; SSE `after` cursors compare against it. */
  eventSeq: number;
  accounts: { total: number; byChannel: Partial<Record<CareApiChannel, number>> };
  conversations: { total: number; waiting: number; unread: number };
  /** False until CC-11 wires a reply port: reply/outbox routes answer 501. */
  replyEnabled: boolean;
  /**
   * Values the conversation `status` takes (the `?status=` filter of `GET /conversations`): the lifecycle labels the
   * projector write, plus any other value actually present in the data.
   */
  conversationStatuses: string[];
  /** Customer 360 stages (`?stage=` filter, customer-care form). */
  customerStages: CareApiStage[];
}

// ── inbox ─────────────────────────────────────────────────────────────────────────────────────
export interface CareConversationDto {
  id: string;
  accountId: string;
  channel: CareApiChannel;
  kind: CareApiConversationKind;
  title: string;
  status: string;
  primaryCustomerId: string | null;
  isPaused: boolean;
  pausedUntilMs: number | null;
  isOptedOut: boolean;
  /** `remote_unread`, `local_seen` and `waiting_since` are separate facts; none implies another. */
  waitingSinceMs: number | null;
  remoteUnreadCount: number;
  localSeenMessageId: string | null;
  /** True when the newest message is a customer message the dashboard has not marked seen. */
  localUnread: boolean;
  lastMessageId: string | null;
  /** Bounded one-line preview of the newest message; null when there is none or the source is not readable. */
  lastMessagePreview: CareMessagePreviewDto | null;
  lastActivityMs: number;
  revision: number;
  /** Chat only: the picture the channel already stored for the person or group; absent when none is known. */
  avatarUrl?: string;
  /**
   * Single-conversation view only, email accounts only: the mailbox signature that is appended to a reply once
   * (read-only; the same source the agent turn uses). Null for chat or when none is configured.
   */
  signature?: string | null;
  /** Inbox v2: status, assignee, AI mode and pending drafts. Present on every list row and single view. */
  workflow?: CareConversationWorkflowDto;
}

export interface CareMessagePreviewDto {
  messageId: string;
  /** Whitespace-collapsed, at most 160 characters (+ an ellipsis when cut). */
  text: string;
  truncated: boolean;
  direction: 'in' | 'out';
  senderRole: 'customer' | 'self' | 'operator' | 'agent' | 'system';
  sentAtMs: number;
}

export interface CareConversationCounts {
  total: number;
  waiting: number;
  unread: number;
}

export interface CareConversationListDto extends CareApiPage<CareConversationDto> {
  /** Counters over the filter set BEFORE paging; null when a text filter makes them inexact. */
  counts: CareConversationCounts | null;
  /** True when a text filter stopped scanning at the candidate budget before the scope ended. */
  truncated: boolean;
  /** Inbox v2 tab counters; null when a text filter makes them inexact. */
  inboxCounts?: CareInboxCountsDto | null;
}

export interface CareMessageDto {
  id: string;
  conversationId: string;
  accountId: string;
  nativeMessageId: string;
  direction: 'in' | 'out';
  senderRole: 'customer' | 'self' | 'operator' | 'agent' | 'system';
  senderIdentityId: string | null;
  /**
   * Group / topic conversations: the sender's identity display name, else the display name the channel sent with the
   * message, else null (never a native ID or username as a stand-in).
   * Always null in direct chats and email threads, where the conversation itself names the other party.
   */
  senderName: string | null;
  text: string;
  metadata: Record<string, unknown>;
  origin: 'live' | 'history' | 'recovery';
  sentAtMs: number;
  nativeVersion: string | null;
  /** Tombstone: deleted at the source. Text and metadata are always empty then; the row keeps its place in the timeline. */
  deleted: boolean;
  deletedAtMs: number | null;
}

/** A person or group as the channel shows it; empty strings when unknown. */
export interface CarePersonDto {
  name: string;
  avatarUrl: string;
}

/** `GET /conversations/:id/profiles`: names and avatars from the channel, for chat conversations whose connector has them. */
export interface CareConversationProfilesDto {
  /** The conversation itself: the other person of a direct chat, or the group. */
  thread: CarePersonDto;
  /** By `senderIdentityId` of the conversation's recent customer messages; senders the channel could not resolve are absent. */
  senders: Record<string, CarePersonDto>;
}

export interface CareMessagePageDto {
  /** Newest first. */
  items: CareMessageDto[];
  /** Cursor for older messages (`before=`), or null when there are none. */
  olderCursor: string | null;
  /** Cursor for newer messages (`after=`), or null when the window reaches the newest message. */
  newerCursor: string | null;
  /** Echo of `around=` when the window was built around a message. */
  aroundId: string | null;
}

export interface CareSearchHitDto {
  messageId: string;
  conversationId: string;
  accountId: string;
  sentAtMs: number;
  matchedIn: 'body' | 'metadata';
  snippet: string;
  /** Pass to `GET /conversations/:id/messages?around=` to open the exact message. */
  around: string;
}

export interface CareSearchResultDto {
  items: CareSearchHitDto[];
  scope: {
    query: string;
    field: 'body' | 'metadata' | 'all';
    accountId: string | null;
    conversationId: string | null;
    fromMs: number | null;
    toMs: number | null;
    candidateBudget: number;
    scannedCandidates: number;
  };
  /** True when the candidate budget ended the scan before the scope was exhausted. */
  truncated: boolean;
  nextCursor: string | null;
}

// ── customers / tasks ─────────────────────────────────────────────────────────────────────────
export interface CareCustomerDto {
  id: string;
  displayName: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  stage: CareApiStage;
  tags: string | null;
  owner: string | null;
  revision: number;
  updatedAtMs: number;
}

export interface CareIdentityDto {
  id: string;
  accountId: string;
  namespace: string;
  displayName: string | null;
  username: string | null;
  verified: boolean;
}

export interface CareCustomerDetailDto extends CareCustomerDto {
  identities: CareIdentityDto[];
  conversations: CareConversationDto[];
  tasks: CareTaskDto[];
}

export interface CareTaskDto {
  id: string;
  customerId: string;
  conversationId: string | null;
  title: string;
  dueAtMs: number;
  done: boolean;
  owner: string | null;
  revision: number;
  updatedAtMs: number;
  /** customer-wide, account or conversation. Present on every task served by the task routes. */
  scope?: 'customer' | 'account' | 'conversation';
  accountId?: string | null;
  /** The message this task came from, when it was created from one. */
  sourceMessageId?: string | null;
  /** Open and due strictly before now. */
  overdue?: boolean;
}

// ── replies / outbox (CC-11 implements the port behind these) ─────────────────────────────────
export type CareDeliveryStatusDto =
  | 'draft'
  | 'pending'
  | 'sending'
  | 'sent'
  | 'retry_wait'
  | 'uncertain'
  | 'needs_review'
  | 'failed'
  | 'cancelled'
  | 'discarded';

export interface CareOutboxIntentDto {
  id: string;
  clientRequestId: string;
  conversationId: string;
  accountId: string;
  status: CareDeliveryStatusDto;
  receiptLevel: 'accepted' | 'delivered' | 'read' | null;
  /** Canonical message once the provider evidence matched one. */
  messageId: string | null;
  retryAtMs: number | null;
  /** Scrubbed code only; never provider text. */
  errorCode: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CareReplyAcceptedDto {
  /** Canonical intent ID; a duplicate clientRequestId answers with the SAME ID. */
  intentId: string;
  duplicate: boolean;
  intent: CareOutboxIntentDto;
}

// ── SSE ───────────────────────────────────────────────────────────────────────────────────────
/** IDs and versions only: a client invalidates and refetches; no body, title or subject ever rides here. */
export interface CareWireEvent {
  seq: number;
  type: string;
  accountId: string;
  conversationId: string | null;
  conversationRevision: number | null;
  payload: Record<string, string | number | boolean | null>;
}

export interface CareSnapshotRow {
  id: string;
  accountId: string;
  revision: number;
  lastActivityMs: number;
  waiting: boolean;
  remoteUnreadCount: number;
}

export interface CareStreamSnapshot {
  /** Read in the same transaction as the rows below: replay from here loses nothing. */
  eventSeq: number;
  counts: CareConversationCounts;
  accounts: Array<{ id: string; channel: CareApiChannel; healthStatus: string; updatedAtMs: number }>;
  conversations: CareSnapshotRow[];
}

export type CareResyncReason = 'cursor_pruned' | 'cursor_ahead' | 'backlog_too_large';
