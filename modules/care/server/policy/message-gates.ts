/**
 * Message-level gates over the customer burst (the customer messages since our last outbound
 * one, oldest -> newest). Pure and deterministic. They port the intent of the legacy
 * `evaluateMessageGates` (Zalo) and `evaluateEmailGates` (Email); the connector-specific part
 * lives here as typed channel predicates, the shared lifecycle checks live in eligibility.ts.
 */

import type { CareChannel, CareConversationKind, CareMessageRecord, CareOrigin, CareSenderRole, CareMessageDirection } from '../../../_lib/care-kit/types.js';
import type { EffectivePolicy } from './policy-ext.js';
import {
  detectAutomatedMail,
  isChatNoise,
  isChatOptOut,
  isEmailNoise,
  isEmailOptOut,
  matchesAnyKeyword,
  stripQuotedReply,
} from './text-heuristics.js';

export type MessageGateReason =
  | 'not_inbound'
  | 'not_live_origin'
  | 'not_customer_message'
  | 'trigger_deleted'
  | 'unsupported_type'
  | 'not_directed'
  | 'opted_out'
  | 'noise'
  | 'empty_body'
  | 'internal_sender'
  | 'own_address'
  | 'automated'
  | 'category_not_primary'
  | 'before_care_since'
  | 'stale_trigger';

export type MessageGateResult = { ok: true } | { ok: false; reason: MessageGateReason; detail?: string };

export interface GateMessage {
  id: string;
  origin: CareOrigin;
  direction: CareMessageDirection;
  senderRole: CareSenderRole;
  /** Chat user id or email address of the sender. */
  senderKey: string | null;
  sentAtMs: number;
  /** Customer-provided text (email: the full body, quoted history is stripped by the gate). */
  text: string;
  isDeleted: boolean;
  contentKind: 'text' | 'image' | 'other';
  /** Chat group/topic: exact @mention of the account or quote of its message. */
  directedAtAccount: boolean;
  /** Chat: carries an @all mention. */
  mentionsAll: boolean;
  email?: {
    from: string;
    subject: string;
    headers?: Record<string, string>;
    isAutomated?: boolean;
    automatedReason?: string;
    category?: string;
  };
}

/**
 * Adapts a stored message to the gate view. `chatSenderKey` is the sender's external identity id
 * (resolved by the caller from `senderIdentityId`); email senders come from the envelope.
 */
export function toGateMessage(m: CareMessageRecord, chatSenderKey: string | null = null): GateMessage {
  const meta = m.metadata;
  let contentKind: GateMessage['contentKind'] = m.text.trim() !== '' ? 'text' : 'other';
  if (meta.type === 'chat' && m.text.trim() === '' && (meta.attachments ?? []).some((a) => a.mimeType.startsWith('image/'))) contentKind = 'image';
  return {
    id: m.id,
    origin: m.origin,
    direction: m.direction,
    senderRole: m.senderRole,
    senderKey: meta.type === 'email' ? meta.from.trim().toLowerCase() : chatSenderKey,
    sentAtMs: m.sentAtMs,
    text: m.text,
    isDeleted: m.isDeleted || m.tombstone,
    contentKind,
    directedAtAccount: m.directedAtAccount,
    mentionsAll: meta.type === 'chat' && (meta.mentions ?? []).some((x) => x.isAll),
    ...(meta.type === 'email'
      ? {
          email: {
            from: meta.from.trim().toLowerCase(),
            subject: meta.subject,
            headers: meta.headers,
            isAutomated: meta.isAutomated,
            automatedReason: meta.automatedReason,
            category: meta.category,
          },
        }
      : {}),
  };
}

export interface MessageGateInput {
  channel: CareChannel;
  conversationKind: CareConversationKind;
  policy: EffectivePolicy;
  burst: readonly GateMessage[];
  nowMs: number;
  /** Trigger older than this is stale. */
  staleAfterMs?: number | null;
  /** Mail/messages sent before this instant never trigger (care start / assignment start). */
  notBeforeMs?: number | null;
  /** The account's own address (email) and every other connected account's identity keys. */
  ownAddress?: string | null;
  internalIdentityKeys?: readonly string[];
  extraAutomatedPatterns?: readonly string[];
}

const ok: MessageGateResult = { ok: true };
const fail = (reason: MessageGateReason, detail?: string): MessageGateResult => ({ ok: false, reason, ...(detail ? { detail } : {}) });

/** Chat group trigger: is this message addressed to the account under the rule's trigger kind? */
export function isDirectedByTrigger(policy: EffectivePolicy, m: GateMessage): boolean {
  switch (policy.groupTrigger) {
    case 'all':
      return true;
    case 'smart':
      return true; // smart hands the burst to the model to judge; cheap gates still apply
    default:
      break;
  }
  const allowMention = policy.groupTrigger === 'mention' || policy.groupTrigger === 'mention_or_keyword';
  const allowKeyword = policy.groupTrigger === 'keyword' || policy.groupTrigger === 'mention_or_keyword';
  if (allowMention && (m.directedAtAccount || (policy.replyToAllMention && m.mentionsAll))) return true;
  return allowKeyword && matchesAnyKeyword(m.text, policy.triggerKeywords);
}

function evaluateChat(input: MessageGateInput): MessageGateResult {
  const { policy, burst, conversationKind } = input;
  const texts = burst.filter((m) => m.contentKind === 'text' && m.text.trim() !== '');
  const hasImage = burst.some((m) => m.contentKind === 'image');
  if (texts.length === 0 && !hasImage) return fail('unsupported_type');
  const isGroup = conversationKind !== 'direct';
  if (isGroup && policy.groupTrigger !== 'smart' && !burst.some((m) => isDirectedByTrigger(policy, m))) return fail('not_directed');
  if (texts.some((m) => isChatOptOut(m.text))) return fail('opted_out', 'message');
  if (!hasImage && texts.every((m) => isChatNoise(m.text))) return fail('noise');
  return ok;
}

function evaluateEmail(input: MessageGateInput): MessageGateResult {
  const { policy, burst } = input;
  const newest = burst[burst.length - 1];
  const from = newest.email?.from ?? newest.senderKey ?? '';
  if (input.ownAddress && from === input.ownAddress.trim().toLowerCase()) return fail('own_address');
  if (from && (input.internalIdentityKeys ?? []).some((k) => k.trim().toLowerCase() === from)) return fail('internal_sender');
  const reason =
    newest.email?.isAutomated
      ? newest.email.automatedReason?.trim() || 'flagged_automated'
      : detectAutomatedMail({ from, subject: newest.email?.subject ?? '', headers: newest.email?.headers }, input.extraAutomatedPatterns);
  if (reason) return fail('automated', reason);
  const category = (newest.email?.category ?? '').trim().toLowerCase();
  if (policy.primaryOnly && category !== '' && category !== 'primary') return fail('category_not_primary', category);
  const texts = burst.map((m) => stripQuotedReply(m.text).trim());
  if (texts.some((t) => isEmailOptOut(t))) return fail('opted_out', 'message');
  if (texts.every((t) => isEmailNoise(t))) return fail('noise');
  if (texts.every((t) => t === '')) return fail('empty_body');
  return ok;
}

/** Cheapest first. The result names the first gate that rejects the burst. */
export function evaluateMessageGates(input: MessageGateInput): MessageGateResult {
  const { burst } = input;
  if (burst.length === 0) return fail('not_inbound');
  const newest = burst[burst.length - 1];
  if (newest.isDeleted) return fail('trigger_deleted');
  if (newest.direction !== 'in') return fail('not_inbound');
  if (newest.senderRole !== 'customer') return fail('not_customer_message');
  if (newest.origin !== 'live') return fail('not_live_origin', newest.origin);
  if (input.notBeforeMs !== undefined && input.notBeforeMs !== null && newest.sentAtMs < input.notBeforeMs) return fail('before_care_since');
  if (input.staleAfterMs !== undefined && input.staleAfterMs !== null && input.nowMs - newest.sentAtMs > input.staleAfterMs) return fail('stale_trigger');
  if (input.channel === 'zalo' || input.channel === 'telegram') {
    const sender = newest.senderKey;
    if (sender && (input.internalIdentityKeys ?? []).includes(sender)) return fail('internal_sender');
    return evaluateChat(input);
  }
  return evaluateEmail(input);
}
