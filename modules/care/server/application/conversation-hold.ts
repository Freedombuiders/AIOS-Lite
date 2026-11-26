/**
 * T06: putting a conversation "on hold" for the bot, shared by the ingest pipeline (customer handoff) and the workflow
 * service (owner pause / take-over / AI off). Everything here runs INSIDE the caller's transaction.
 *
 * How the states relate (no third state system):
 *   - take-over (care_conversation_state.taken_over_at + assignee owner): a person holds the conversation; automatic
 *     turns stop until the owner hands it back. Persistent, only the owner clears it.
 *   - AI off (care_conversation_state.ai_mode = 'off'): the owner's per-conversation switch. Persistent.
 *   - timed pause (care_conversations.is_paused + paused_until): what the pure eligibility check reads before the model,
 *     after the model and at send time. Ends by itself at paused_until (null = until resumed).
 *   - customer handoff = take-over + timed pause + a marker (handoff_at/keyword/message) + the bot's queued replies
 *     withdrawn + owner attention. Cleared only by the owner handing the conversation back (take-over off / assignee
 *     change), which also lifts the pause the handoff set.
 * Whenever the bot must stop speaking, its queued automatic replies are cancelled (not deferred), so nothing stale goes
 * out when the pause ends.
 */

import type Database from 'better-sqlite3';
import type { CareStores } from '../persistence/index.js';
import { CareWorkflowStore, type StatePatch, type StateRow } from '../workflow/store.js';

export interface WithdrawnIntents {
  cancelled: string[];
  discarded: string[];
  review: string[];
  underway: string[];
}

export interface CustomerHandoff {
  conversationId: string;
  accountId: string;
  /** The configured keyword that matched (never customer text). */
  keyword: string;
  messageId: string;
  atMs: number;
  /** null = paused until the owner resumes (an earlier open-ended pause is never shortened). */
  pausedUntilMs: number | null;
  withdrawn: WithdrawnIntents;
}

/**
 * Per-conversation owner controls as the agent turn reads them (take-over, AI mode), straight from
 * care_conversation_state. The default of the runtime, so a take-over (and a customer handoff, which is one) is honoured
 * whoever composes it.
 */
export function createConversationControlReader(
  db: Database.Database,
): (conversationId: string) => { takenOver: boolean; aiMode: 'off' | 'draft' | 'auto' | null } | null {
  const stmt = db.prepare('SELECT ai_mode AS aiMode, taken_over_at AS takenOverAt FROM care_conversation_state WHERE conversation_id = ?');
  return (conversationId) => {
    const row = stmt.get(conversationId) as { aiMode: 'off' | 'draft' | 'auto' | null; takenOverAt: number | null } | undefined;
    return row ? { takenOver: row.takenOverAt !== null, aiMode: row.aiMode } : null;
  };
}

export const HANDOFF_CLEARED: StatePatch = Object.freeze({ handoffAt: null, handoffKeyword: null, handoffMessageId: null });

/** Same event the workflow service appends for every state write (drives the inbox SSE refresh). No text. */
export function emitStateEvent(stores: CareStores, conv: { id: string; accountId: string }, row: StateRow, kind: string): void {
  const eventId = `conv-state:${conv.id}:${row.stateRevision}`;
  if (stores.events.hasEvent(conv.accountId, eventId)) return;
  stores.events.appendEvent({
    eventId,
    accountId: conv.accountId,
    conversationId: conv.id,
    eventType: 'conversation.updated',
    payload: { conversationId: conv.id, kind },
  });
}

/** Cancels the bot's queued automatic replies in the conversation (pause, take-over, AI off). */
export function withdrawAutoReplies(stores: CareStores, conversationId: string, reason: string, nowMs: number): WithdrawnIntents {
  return stores.outbox.withdrawBotIntents(conversationId, { reason, nowMs });
}

/**
 * Records a customer handoff atomically with the caller's write: pause (both columns), take-over + marker, the bot's
 * pending replies withdrawn (auto cancelled, unapproved drafts discarded, approved-but-unsent drafts back to review).
 */
export function applyCustomerHandoff(
  db: Database.Database,
  stores: CareStores,
  input: { conversationId: string; accountId: string; keyword: string; messageId: string; nowMs: number; pauseMinutes: number },
): CustomerHandoff {
  const { conversationId, nowMs } = input;
  const conv = stores.conversations.getConversation(conversationId);
  let until: number | null = nowMs + input.pauseMinutes * 60_000;
  if (conv?.isPaused) {
    if (conv.pausedUntilMs === null) until = null;
    else if (conv.pausedUntilMs > until) until = conv.pausedUntilMs;
  }
  stores.conversations.setCareFlags(conversationId, { isPaused: true, pausedUntilMs: until });

  const wf = new CareWorkflowStore(db);
  const cur = wf.getState(conversationId);
  const row = wf.writeState(
    conversationId,
    {
      assigneeKind: 'owner',
      assigneeAgentId: null,
      takenOverAt: cur?.takenOverAt ?? nowMs,
      handoffAt: nowMs,
      handoffKeyword: input.keyword,
      handoffMessageId: input.messageId,
    },
    nowMs,
  );
  emitStateEvent(stores, { id: conversationId, accountId: input.accountId }, row, 'handoff');

  const withdrawn = stores.outbox.withdrawBotIntents(conversationId, { reason: 'HANDOFF', drafts: true, approved: true, nowMs });
  return { conversationId, accountId: input.accountId, keyword: input.keyword, messageId: input.messageId, atMs: nowMs, pausedUntilMs: until, withdrawn };
}
