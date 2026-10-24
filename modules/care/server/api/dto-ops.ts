/**
 * Wave 2 DTOs (customer ops, rules, drafts, runs, runtime). Pure data like dto.ts: no Node, DB or provider imports.
 */

import type { CareApiChannel, CareOutboxIntentDto } from './dto.js';

// ── customer ops ──────────────────────────────────────────────────────────────────────────────
export interface CareTimelineItemDto {
  messageId: string;
  conversationId: string;
  accountId: string;
  channel: CareApiChannel;
  direction: 'in' | 'out';
  senderRole: 'customer' | 'self' | 'operator' | 'agent' | 'system';
  senderIdentityId: string | null;
  text: string;
  origin: 'live' | 'history' | 'recovery';
  sentAtMs: number;
  /** A reply started from this item opens exactly this conversation. */
  replyTarget: { conversationId: string; accountId: string };
}

export interface CareTimelinePageDto {
  items: CareTimelineItemDto[];
  nextCursor: string | null;
}

export interface CareLinkPreviewDto {
  targetCustomerId: string;
  suggestedTarget: boolean;
  noop: boolean;
  people: Array<{ customerId: string; role: 'target' | 'source'; displayName: string; revision: number; movingIdentityIds: string[] }>;
  identities: Array<{
    identityId: string;
    customerId: string;
    accountId: string;
    channel: CareApiChannel;
    namespace: string;
    displayName: string | null;
    moving: boolean;
  }>;
  accounts: Array<{ accountId: string; channel: CareApiChannel; label: string }>;
  channels: CareApiChannel[];
  conflicts: Array<{ field: string; values: Array<{ customerId: string; value: string }> }>;
  profileConflicts: Array<{ scope: string | null; kind: 'note' | 'need'; key?: string; profileIds: string[]; resolution: 'kept_separate' }>;
  moves: { profiles: number; tasks: number; conversations: number };
  /** Send these back as `expectedRevisions` to link. */
  expectedRevisions: Record<string, number>;
}

export interface CareLinkResultDto {
  applied: boolean;
  linkEventId: string | null;
  targetCustomerId: string;
  movedIdentityIds: string[];
  moved: { profiles: number; tasks: number; conversations: number };
  replayed?: boolean;
}

export interface CareUnlinkResultDto {
  applied: boolean;
  linkEventId: string | null;
  fromCustomerId: string | null;
  restored: Array<{ identityId: string; customerId: string }>;
  returned: { profiles: number; tasks: number; conversations: number };
  decided: number;
  replayed?: boolean;
}

export interface CareUnlinkPreviewDto {
  /** Nothing would change (every identity is already back where it came from). */
  noop: boolean;
  /** The linked customer the identities sit on now; null for a no-op. */
  linkedCustomerId: string | null;
  /** Each identity and the customer it would go back to. */
  restores: Array<{
    identityId: string;
    accountId: string;
    channel: CareApiChannel;
    namespace: string;
    displayName: string | null;
    fromCustomerId: string;
    restoreToCustomerId: string;
    restoreToDisplayName: string;
  }>;
  /** Every customer an unlink touches, with its CURRENT revision. */
  customers: Array<{ customerId: string; displayName: string; role: 'linked' | 'restored'; revision: number }>;
  /** Send exactly this as `expectedRevisions` to `unlink`. */
  expectedRevisions: Record<string, number>;
  /** Customer-wide items with no recorded source: the client must choose a customer for each (`decisions`). IDs only. */
  undecided: Array<{ itemKey: string; type: string; id: string; accountId: string | null; candidateCustomerIds: string[] }>;
  /** What the unlink would give back; null until every undecided item has a decision. */
  returned: { profiles: number; tasks: number; conversations: number } | null;
}

export interface CareCustomerCareProfileDto {
  id: string;
  accountId: string | null;
  provenance: string;
  need: Record<string, unknown> | null;
  note: string | null;
  revision: number;
  updatedAtMs: number;
}

export interface CareCustomerCareDto {
  conversationId: string;
  accountId: string;
  /** Who the form is about: the chosen participant's customer, else the conversation's primary customer. */
  participantIdentityId: string | null;
  customer: {
    id: string;
    displayName: string;
    company: string | null;
    phone: string | null;
    email: string | null;
    stage: string;
    tags: string | null;
    owner: string | null;
    revision: number;
  };
  /** Editable canonical profile of this account; null until the first save. */
  profile: CareCustomerCareProfileDto | null;
  /** Other profiles that follow the customer (e.g. a profile from another channel): read-only here. */
  otherProfiles: CareCustomerCareProfileDto[];
  tasks: Array<{ id: string; title: string; dueAtMs: number; done: boolean; owner: string | null; revision: number; conversationId: string | null }>;
  /** Who owns writes for this account right now. */
  writeOwner: 'legacy' | 'draining' | 'core';
  writable: boolean;
}

// ── assignments / rules ───────────────────────────────────────────────────────────────────────
export interface CareAssignmentDto {
  id: string;
  scope: 'global' | 'channel' | 'account' | 'customer' | 'conversation' | 'identity' | 'domain';
  accountId: string | null;
  customerId: string | null;
  channel: CareApiChannel | null;
  scopeTarget: string | null;
  priority: number;
  enabled: boolean;
  mode: 'observe' | 'draft' | 'auto';
  agentId: string;
  instructionsRef: string | null;
  policyExt: Record<string, unknown> | null;
  configVersion: number;
}

export interface CareEffectiveRuleDto {
  outcome: 'active' | 'denied' | 'none' | 'conflict';
  rule?: {
    assignmentId: string;
    tier: string;
    viaKindPredicate: boolean;
    enabled: boolean;
    mode: 'observe' | 'draft' | 'auto';
    agentId: string;
    priority: number;
    configVersion: number;
    policyRevision: string;
    policy: Record<string, unknown>;
  };
  conflict?: { tier: string; priority: number; assignmentIds: string[] };
  trace: Array<{
    tier: string;
    candidates: Array<{ assignmentId: string; priority: number; enabled: boolean; viaKindPredicate: boolean }>;
    selectedId?: string;
    conflict?: { priority: number; assignmentIds: string[] };
  }>;
  warnings: string[];
}

// ── drafts / runs / activity ──────────────────────────────────────────────────────────────────
export interface CareDraftDto extends CareOutboxIntentDto {
  /** The exact revision a reviewer approves; send it back as `expectedRevision`. */
  payloadRevision: number;
  approvedRevision: number | null;
  contextRevision: number | null;
  policyRevision: string | null;
  actor: 'manual' | 'approved' | 'auto';
  channel: CareApiChannel;
  text: string;
  /** Email only. BCC is a private envelope: only its presence is shown. */
  email: { to: string[]; cc: string[]; subject: string; hasBcc: boolean } | null;
}

/** One delivery intent of a conversation, without its text or recipients. */
export interface CareConversationOutboxItemDto extends CareOutboxIntentDto {
  actor: 'manual' | 'approved' | 'auto';
  purpose: 'care' | 'campaign';
  channel: CareApiChannel;
  payloadRevision: number;
  /** Canonical message this delivery answers. */
  replyToMessageId: string | null;
  attemptCount: number;
  sentAtMs: number | null;
}

export interface CareDraftRequestDto {
  jobId: string;
  conversationId: string;
  triggerMessageId: string;
  /** True when the same request already had a job. */
  duplicate: boolean;
}

export interface CareRunDto {
  id: string;
  accountId: string;
  conversationId: string;
  triggerMessageId: string;
  status: 'running' | 'skipped' | 'failed' | 'drafted';
  /** Stable reason code for skipped/failed runs. */
  skipReason: string | null;
  mode: 'observe' | 'draft' | 'auto' | null;
  agentId: string;
  triggerKind: 'inbound' | 'manual';
  policyRevision: string;
  draftRef: string | null;
  modelCalled: boolean;
  latencyMs: number | null;
  costUsd: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export type CareActivityItemDto =
  | ({ kind: 'run'; atMs: number } & Pick<CareRunDto, 'id' | 'accountId' | 'conversationId' | 'status' | 'skipReason' | 'mode' | 'triggerKind' | 'draftRef'>)
  | {
      kind: 'delivery';
      atMs: number;
      id: string;
      accountId: string;
      conversationId: string | null;
      status: string;
      statusReason: string | null;
      actor: 'manual' | 'approved' | 'auto';
      receiptLevel: 'accepted' | 'delivered' | 'read' | null;
    };

// ── runtime ───────────────────────────────────────────────────────────────────────────────────
export interface CareSwitchDto {
  key: string;
  /** Effective state: the stored row, else the documented default (module OFF, everything else ON). */
  enabled: boolean;
  explicit: boolean;
  changedAtMs: number | null;
  changedBy: string | null;
  reason: string | null;
}

export interface CareHoldDto {
  itemKind: string;
  itemId: string;
  accountId: string;
  status: 'held' | 'released' | 'discarded';
  heldAtMs: number;
  reason: string;
  resolvedAtMs: number | null;
}
