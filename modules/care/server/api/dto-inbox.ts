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

/**
 * T07: the one state label of a conversation row, computed on the server (never in the browser).
 *   review   Chờ bạn duyệt   a bot draft waits for the owner
 *   active   Bot đang chăm   an enabled draft/auto rule applies and nothing holds the bot back
 *   yielded  Bot nhường bạn  the bot holds back: pause window, owner took over, or the owner just wrote
 *   handoff  Chuyển cho bạn  the customer asked for a person (T06 handoff marker, owner only clears it)
 *   none     Chưa gán bot    no rule, observe-only, AI off here, a group, or a channel without AI
 */
export type CareBotLabel = 'review' | 'active' | 'yielded' | 'handoff' | 'none';
export type CareBotYieldReason = 'paused' | 'taken_over' | 'human_reply';
/** Assignment modes (`care_assignments.mode`); the per-conversation endpoint speaks `CareAiMode` instead. */
export type CareAssignmentMode = 'observe' | 'draft' | 'auto';

export interface CareBotStateDto {
  label: CareBotLabel;
  /** Agent of the effective rule, when one applies. */
  agentId: string | null;
  /** Mode of the effective rule, when one applies. */
  mode: CareAssignmentMode | null;
  /** Why the bot holds back (label `yielded`). */
  yieldReason: CareBotYieldReason | null;
  /** The timed pause is on and not over yet. `pausedUntilMs` null = until switched back on. */
  paused: boolean;
  pausedUntilMs: number | null;
  /** Minutes the bot steps back after the owner writes (the effective rule's `humanPauseMinutes`); null without a rule. */
  humanPauseMinutes: number | null;
  /** Open customer handoff (the owner holds the conversation because the customer asked for a person). */
  handoff: { atMs: number; keyword: string | null } | null;
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
  /** T07: the server-computed state label and what stands behind it. Present on every row the read model builds. */
  bot?: CareBotStateDto;
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
  /** The exact revision a reviewer approves / edits (`/drafts/:id/approve` and PATCH take it as `expectedRevision`). */
  payloadRevision?: number;
  /** T07: why the bot stopped at a draft instead of sending, as stable codes the UI translates. Null when unknown. */
  stop?: CareDraftStopDto | null;
  /** T07: brain notes the answer came from, when the run recorded them. The care runtime records none today: always []. */
  sources?: string[];
}

/** Stable codes behind "Bot dừng lại vì ...": see `draftStopOf` (api/draft-stop.ts). */
export interface CareDraftStopDto {
  /** First code is the main reason. `review_keyword` carries the keyword in `detail`, `needs_review` the agent's note. */
  codes: string[];
  detail: string | null;
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

// ── T07: the bot panel of one conversation ────────────────────────────────────────────────────
/** The module settings the bot panel lists as "luật đang áp dụng" (read from the real settings, never hard-coded). */
export interface CareBotSettingsDto {
  aiEnabled: boolean;
  autoSendEnabled: boolean;
  handoffKeywords: string[];
  handoffPauseMinutes: number;
  turnDebounceSeconds: number;
  quietHoursStart: string;
  quietHoursEnd: string;
}

export interface CareBotRuleSummaryDto {
  id: string;
  scope: 'account' | 'conversation';
  mode: CareAssignmentMode;
  agentId: string;
  enabled: boolean;
  configVersion: number;
  /** Carried so the panel can PUT the rule back with one field changed. */
  priority: number;
  instructionsRef: string | null;
  policyExt: Record<string, unknown> | null;
}

/** `GET /conversations/:id/bot`: everything the right column needs besides the row's own `workflow.bot`. */
export interface CareBotPanelDto {
  conversationId: string;
  accountId: string;
  kind: string;
  /** The conversation's external key: the `scopeTarget` of a `scope: conversation` rule. */
  conversationKey: string;
  state: CareBotStateDto;
  /** Per-conversation switch (`PUT /conversations/:id/ai`): off / draft (never sends by itself) / auto (follow the rule). Null = never set. */
  aiMode: CareAiMode | null;
  takenOver: boolean;
  /** The rule the agent turn would use now. */
  effective: { outcome: 'active' | 'denied' | 'none' | 'conflict'; tier: string | null; agentId: string | null; mode: CareAssignmentMode | null };
  /** The nick-wide rule (`scope: account`) and this conversation's own rule (`scope: conversation`), when they exist. */
  accountRule: CareBotRuleSummaryDto | null;
  conversationRule: CareBotRuleSummaryDto | null;
  rules: {
    settings: CareBotSettingsDto | null;
    /** From the effective rule's policy; null when no rule applies or it has no daily cap. */
    maxRepliesPerThreadDay: number | null;
    humanPauseMinutes: number | null;
  };
}
