/**
 * Stateless agent context, built only from eligible messages of the ONE allowed conversation.
 *
 *  - eligible = same conversation and account as the trigger, not deleted/tombstoned, not a
 *    system event, carries text or an attachment, and not newer than the trigger (so the context
 *    is a pure function of (conversation, trigger, revision));
 *  - bounded by message count, an approximate token budget and a per-message character cap; the
 *    trigger is always kept, older history is dropped first;
 *  - EVERY message body (and everything a customer controls: email subject, attachment names,
 *    the conversation title) sits inside an `<untrusted>` block with markup-neutralized text; the
 *    block attributes carry only system-controlled values (ref, role, origin, time);
 *  - nothing from any other conversation, customer profile or channel is added unless an
 *    expansion was explicitly requested AND its eligibility check passed.
 *
 * Messages are addressed by short refs (m1...) so the model never sees or invents real ids.
 */

import type Database from 'better-sqlite3';
import type { CareAccountRecord, CareChannel, CareConversationRecord, CareMessageRecord } from '../../../_lib/care-kit/types.js';
import { aiChannelGate, assertAiAllowedForChannel } from '../domain/ai-block.js';
import type { EligibilityResult } from '../policy/eligibility.js';
import { neutralizeUntrustedMarkup, stripQuotedReply } from '../policy/text-heuristics.js';
import type { CareStores } from '../persistence/index.js';

export interface ContextLimits {
  maxMessages: number;
  /** Approximate budget (chars / 3 is a conservative estimate for Vietnamese + English). */
  maxTokens: number;
  maxCharsPerMessage: number;
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = Object.freeze({
  maxMessages: 30,
  maxTokens: 6000,
  maxCharsPerMessage: 2000,
});

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export interface MessageAnchor {
  sentAtMs: number;
  id: string;
}

/** Read port over one conversation. The default implementation reads the Care tables. */
export interface ConversationReader {
  /** Newest-first messages with (sentAt, id) <= anchor, non-deleted, at most `limit`. */
  listUpTo(conversationId: string, anchor: MessageAnchor, limit: number): CareMessageRecord[];
  /** Newest self/operator message (person typing on the phone or in the dashboard). */
  lastHumanReplyAtMs(conversationId: string): number | null;
  /** Any non-deleted, non-system message strictly after the anchor. */
  hasNewerMessage(conversationId: string, anchor: MessageAnchor): boolean;
}

export function createSqliteConversationReader(db: Database.Database, stores: CareStores): ConversationReader {
  const human = db.prepare(
    `SELECT MAX(sent_at) AS at FROM care_messages
     WHERE conversation_id = ? AND is_deleted = 0 AND tombstone = 0 AND sender_role IN ('self','operator')`,
  );
  const newer = db.prepare(
    `SELECT 1 FROM care_messages
     WHERE conversation_id = ? AND is_deleted = 0 AND tombstone = 0 AND sender_role <> 'system'
       AND (sent_at > ? OR (sent_at = ? AND id > ?)) LIMIT 1`,
  );
  return {
    listUpTo(conversationId, anchor, limit) {
      return stores.messages.listByConversation(conversationId, { limit, upTo: anchor });
    },
    lastHumanReplyAtMs(conversationId) {
      const row = human.get(conversationId) as { at: number | null };
      return row.at === null || row.at === undefined ? null : Number(row.at);
    },
    hasNewerMessage(conversationId, anchor) {
      return Boolean(newer.get(conversationId, anchor.sentAtMs, anchor.sentAtMs, anchor.id));
    },
  };
}

export type ContextExclusionReason = 'other_conversation' | 'other_account' | 'deleted' | 'system' | 'empty' | 'after_trigger';

export interface ContextMessage {
  ref: string;
  messageId: string;
  role: CareMessageRecord['senderRole'];
  origin: CareMessageRecord['origin'];
  sentAtMs: number;
  /** Sanitized + capped text exactly as placed inside the untrusted block. */
  text: string;
}

export interface ContextExpansionRequest {
  /** Fixed, system-chosen label (never customer text). */
  source: 'customer_profile' | 'knowledge_note';
  text: string;
  /** Result of `evaluateEligibility({ step: 'context_expansion', ... })` for this source. */
  eligibility: EligibilityResult;
  /** Channel the text was read from. Telegram is refused here even if `eligibility` says yes. */
  sourceChannel?: CareChannel;
}

export interface AgentContext {
  conversationId: string;
  accountId: string;
  channel: CareAccountRecord['channel'];
  triggerMessageId: string;
  contextRevision: number;
  /** Oldest -> newest. */
  messages: ContextMessage[];
  /** ref -> real local message id; only messages of this conversation. */
  refs: ReadonlyMap<string, string>;
  /** Customer messages since the last outbound one (full, unbudgeted), oldest -> newest. */
  burst: CareMessageRecord[];
  transcript: string;
  tokenEstimate: number;
  truncated: boolean;
  excluded: Array<{ messageId: string; reason: ContextExclusionReason }>;
  expansions: Array<{ source: string; included: boolean; reason: string }>;
  expansionBlocks: string[];
}

const OUTBOUND_ROLES = new Set(['self', 'operator', 'agent']);

/** Customer messages after the last message from our side, oldest -> newest. */
export function customerBurst(newestFirst: readonly CareMessageRecord[]): CareMessageRecord[] {
  const burst: CareMessageRecord[] = [];
  for (const m of newestFirst) {
    if (m.senderRole === 'system') continue;
    if (m.isDeleted || m.tombstone) continue;
    if (OUTBOUND_ROLES.has(m.senderRole) || m.direction === 'out') break;
    burst.unshift(m);
  }
  return burst;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16) + 'Z';
}

function messageBody(m: CareMessageRecord, maxChars: number): string {
  const lines: string[] = [];
  if (m.metadata.type === 'email') {
    if (m.metadata.subject) lines.push(`Subject: ${m.metadata.subject}`);
    lines.push(stripQuotedReply(m.text));
  } else {
    lines.push(m.text);
  }
  for (const a of m.metadata.attachments ?? []) {
    lines.push(`[attachment: ${a.fileName || 'file'} (${a.mimeType || 'unknown'}) - content not available to you]`);
  }
  const joined = neutralizeUntrustedMarkup(lines.join('\n').replace(/\r\n?/g, '\n').trim());
  return joined.length > maxChars ? `${joined.slice(0, maxChars).trimEnd()} ...[truncated]` : joined;
}

function block(attrs: string, body: string): string {
  return `<untrusted ${attrs}>\n${body}\n</untrusted>`;
}

export interface BuildContextInput {
  conversation: CareConversationRecord;
  account: CareAccountRecord;
  trigger: CareMessageRecord;
  reader: ConversationReader;
  limits?: Partial<ContextLimits>;
  expansions?: ContextExpansionRequest[];
  /**
   * Telegram only: true when the owner switched THIS bot group on (the per-group gate, default off, evaluated by the
   * caller). Without it a Telegram conversation is never read for a model; every other source channel is unaffected.
   */
  telegramBotGroupOpen?: boolean;
}

export function buildAgentContext(input: BuildContextInput): AgentContext {
  const { conversation, account, trigger, reader } = input;
  // Telegram AI is off by design: no message of a Telegram conversation is read for a model, whatever the caller checked,
  // except a Telegram BOT group the owner explicitly enabled (the caller proves it with telegramBotGroupOpen).
  if (account.channel === 'telegram') {
    if (input.telegramBotGroupOpen !== true) assertAiAllowedForChannel('telegram');
  } else {
    assertAiAllowedForChannel(account.channel);
  }
  const limits: ContextLimits = { ...DEFAULT_CONTEXT_LIMITS, ...input.limits };
  const excluded: AgentContext['excluded'] = [];

  const fetched = reader.listUpTo(conversation.id, { sentAtMs: trigger.sentAtMs, id: trigger.id }, limits.maxMessages + 20);

  // Defense in depth: the reader is a port. Never trust it to have stayed inside the conversation.
  const eligible: CareMessageRecord[] = [];
  for (const m of fetched) {
    if (m.conversationId !== conversation.id) excluded.push({ messageId: m.id, reason: 'other_conversation' });
    else if (m.accountId !== account.id) excluded.push({ messageId: m.id, reason: 'other_account' });
    else if (m.isDeleted || m.tombstone) excluded.push({ messageId: m.id, reason: 'deleted' });
    else if (m.senderRole === 'system') excluded.push({ messageId: m.id, reason: 'system' });
    else if (m.sentAtMs > trigger.sentAtMs || (m.sentAtMs === trigger.sentAtMs && m.id > trigger.id)) excluded.push({ messageId: m.id, reason: 'after_trigger' });
    else if (m.text.trim() === '' && (m.metadata.attachments ?? []).length === 0) excluded.push({ messageId: m.id, reason: 'empty' });
    else eligible.push(m);
  }
  // `eligible` is newest-first. The trigger must be part of it.
  if (!eligible.some((m) => m.id === trigger.id)) {
    const t: CareMessageRecord = trigger;
    if (t.conversationId === conversation.id && t.accountId === account.id && !t.isDeleted && !t.tombstone && t.senderRole !== 'system') {
      eligible.unshift(t);
    }
  }

  const kept: Array<{ m: CareMessageRecord; body: string; tokens: number }> = [];
  let tokens = 0;
  let truncated = fetched.length >= limits.maxMessages + 20;
  for (const m of eligible) {
    const isTrigger = m.id === trigger.id;
    if (!isTrigger && kept.length >= limits.maxMessages) {
      truncated = true;
      break;
    }
    // The trigger is always kept; if it alone is over budget its text is shortened.
    const cap = isTrigger ? Math.min(limits.maxCharsPerMessage, Math.max(200, limits.maxTokens * 3 - 400)) : limits.maxCharsPerMessage;
    const body = messageBody(m, cap);
    const cost = estimateTokens(body) + 20;
    if (!isTrigger && tokens + cost > limits.maxTokens) {
      truncated = true;
      break;
    }
    kept.push({ m, body, tokens: cost });
    tokens += cost;
  }
  kept.reverse(); // oldest -> newest

  const refs = new Map<string, string>();
  const messages: ContextMessage[] = [];
  const parts: string[] = [];
  kept.forEach(({ m, body }, idx) => {
    const ref = `m${idx + 1}`;
    refs.set(ref, m.id);
    messages.push({ ref, messageId: m.id, role: m.senderRole, origin: m.origin, sentAtMs: m.sentAtMs, text: body });
    parts.push(`[${ref}] ${iso(m.sentAtMs)} role=${m.senderRole}\n${block(`source="care_message" ref="${ref}"`, body)}`);
  });

  const expansions: AgentContext['expansions'] = [];
  const expansionBlocks: string[] = [];
  for (const e of input.expansions ?? []) {
    if (e.sourceChannel && !aiChannelGate(e.sourceChannel).allowed) {
      expansions.push({ source: e.source, included: false, reason: 'telegram_ai_blocked' });
      continue;
    }
    if (!e.eligibility.eligible) {
      expansions.push({ source: e.source, included: false, reason: e.eligibility.reason });
      continue;
    }
    const body = neutralizeUntrustedMarkup(e.text).slice(0, limits.maxCharsPerMessage);
    expansions.push({ source: e.source, included: true, reason: 'eligible' });
    expansionBlocks.push(block(`source="${e.source}"`, body));
    tokens += estimateTokens(body) + 20;
  }

  return {
    conversationId: conversation.id,
    accountId: account.id,
    channel: account.channel,
    triggerMessageId: trigger.id,
    contextRevision: conversation.revision,
    messages,
    refs,
    burst: customerBurst(fetched.filter((m) => m.conversationId === conversation.id && m.accountId === account.id)),
    transcript: parts.join('\n\n'),
    tokenEstimate: tokens,
    truncated,
    excluded,
    expansions,
    expansionBlocks,
  };
}
