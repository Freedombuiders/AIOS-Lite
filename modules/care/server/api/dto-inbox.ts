/**
 * Shared inbox v2 DTOs: workflow status, assignee, per-conversation AI mode, inline drafts, internal notes,
 * and canned replies. Pure data like dto.ts: no Node, DB or provider imports.
 */

import type { CareApiChannel, CareDeliveryStatusDto } from './dto.js';

/** Effective workflow status. `pending` = we answered last and wait for the customer (derived, never stored). */
export type CareWorkflowStatus = 'open' | 'pending' | 'snoozed' | 'done';
/** Inbox tabs: needs the owner / handled by an AI agent / nobody handles it / everything. */
export type CareInboxView = 'me' | 'ai' | 'none' | 'all';
/** Per-conversation AI mode as the owner picks it. */
export type CareAiMode = 'off' | 'draft' | 'auto';

export interface CareAssigneeDto {
  kind: 'owner' | 'agent' | 'none';
  agentId: string | null;
  /** `conversation`: set on this conversation; `rule`: inherited from an account/channel rule; `none`: nothing applies. */
  source: 'conversation' | 'rule' | 'none';
}

export interface CareAiStateDto {
  agentId: string | null;
  mode: CareAiMode;
  source: 'conversation' | 'rule' | 'none';
  /** The owner took over: AI paused for this conversation until handed back. */
  takenOver: boolean;
  /** False when the channel/account cannot run AI from here (no AI runtime wired to the inbox state). */
  supported: boolean;
  /** UPPER_SNAKE reason when unsupported or paused for another reason (CORE_AI_UNAVAILABLE, PAUSED_UNTIL, OPTED_OUT...). */
  note: string | null;
}

export interface CareConversationWorkflowDto {
  status: CareWorkflowStatus;
  snoozedUntilMs: number | null;
  /** When a person last changed the status (done/snooze/reopen); null when never. */
  changedAtMs: number | null;
  /** Revision of the care-only state, independent of the conversation revision the projector bumps. */
  stateRevision: number;
  assignee: CareAssigneeDto;
  ai: CareAiStateDto;
  /** AI drafts waiting for review in this conversation. */
  pendingDrafts: number;
}

/** Counters for the inbox tabs. `byView` is scoped to the current status filter; `byStatus` to the current view. */
export interface CareInboxCountsDto {
  byStatus: Record<CareWorkflowStatus, number>;
  byView: Record<CareInboxView, number>;
}

export interface CareAccountDeliveryDto {
  /** How a reply typed in the shared inbox is delivered for this account. */
  replyVia: 'core' | 'none';
  /** Images/files can be attached to a reply. */
  attachments: boolean;
  /** Zalo: messages sent today vs the effective daily cap (anti-ban); null when not applicable. */
  sendQuota: { used: number; limit: number } | null;
}

/** An AI draft shown inline in the conversation (a core intent). */
export interface CareInlineDraftDto {
  /** Core intent id. Pass it back to /drafts/:id/approve|discard. */
  id: string;
  conversationId: string;
  accountId: string;
  channel: CareApiChannel;
  source: 'core';
  agentId: string | null;
  text: string;
  email: { to: string[]; cc: string[]; subject: string } | null;
  /** Why it waits for a person (short scrubbed text from the agent run / review keyword), or null. */
  reviewReason: string | null;
  status: CareDeliveryStatusDto;
  createdAtMs: number;
}

export interface CareNoteDto {
  id: string;
  conversationId: string;
  body: string;
  author: 'owner';
  createdAtMs: number;
}

export interface CareCannedReplyDto {
  id: string;
  /** Lowercase `[a-z0-9_-]{1,32}`, typed after `/` in the composer. */
  shortcut: string;
  title: string;
  body: string;
  /** Optional longer variant the email composer uses. */
  emailBody: string | null;
  sort: number;
  updatedAtMs: number;
}
