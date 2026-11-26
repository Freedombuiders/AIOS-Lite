/**
 * T07: why a bot draft waits for the owner ("Bot dừng lại vì ..."), read from the agent run that made it.
 *
 * The run stores `{ delivery: { reasonCodes }, needsReview, reviewReason }` (agent-turn.ts, buildProposal). This turns
 * that into stable codes the UI translates; free text from the model is only passed through as `detail`, capped.
 * Pure: no DB, no Node.
 */

import type { CareDraftStopDto } from './dto-inbox.js';

/** Every code `stop.codes` can hold (the web dictionary must translate each one). */
export const DRAFT_STOP_CODES = [
  'needs_review', // the agent (or a rule) asked for a person to look first
  'review_keyword', // a configured review keyword matched; the keyword is `detail`
  'quiet_hours', // auto reply turned into a draft in quiet hours
  'kill_switch_auto_send', // automatic sending is switched off in settings
  'conversation_ai_draft', // this conversation is set to "Soạn nháp"
  'agent_scope_missing_send', // the agent lacks reply.send
  'draft_mode', // the rule is "Soạn nháp": every reply waits
  'manual_request', // the owner asked "Nhờ bot soạn"
  'quiet_hours_defer', // queued until quiet hours end (still reported if it shows up on a draft)
] as const;
export type DraftStopCode = (typeof DRAFT_STOP_CODES)[number];

const KNOWN = new Set<string>(DRAFT_STOP_CODES);
const MAX_DETAIL = 200;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** `decision` is the decrypted `care_agent_runs.decision` of the run that proposed the draft, or null. */
export function draftStopOf(decision: Record<string, unknown> | null | undefined): CareDraftStopDto | null {
  const d = asRecord(decision);
  if (!d) return null;
  const delivery = asRecord(d.delivery);
  const raw = Array.isArray(delivery?.reasonCodes) ? (delivery!.reasonCodes as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const codes = raw.filter((c) => KNOWN.has(c));
  let detail: string | null = null;
  const review = typeof d.reviewReason === 'string' ? d.reviewReason : null;
  if (review) {
    if (review.startsWith('review_keyword:')) {
      detail = review.slice('review_keyword:'.length).slice(0, MAX_DETAIL);
      if (!codes.includes('review_keyword')) codes.unshift('review_keyword');
    } else {
      // The agent's own note (or the fixed `agent_requested_review`): shown to the owner as a quote.
      detail = review === 'agent_requested_review' ? null : review.slice(0, MAX_DETAIL);
      if (!codes.includes('needs_review')) codes.unshift('needs_review');
    }
  }
  // The main reason first: a review reason outranks the mode that would have drafted anyway.
  codes.sort((a, b) => rank(a) - rank(b));
  if (codes.length === 0) return null;
  return { codes: [...new Set(codes)], detail };
}

const ORDER: readonly string[] = ['review_keyword', 'needs_review', 'kill_switch_auto_send', 'quiet_hours', 'agent_scope_missing_send', 'conversation_ai_draft', 'manual_request', 'draft_mode', 'quiet_hours_defer'];
const rank = (c: string): number => {
  const i = ORDER.indexOf(c);
  return i === -1 ? ORDER.length : i;
};

/** Brain notes the run recorded as sources (`decision.decision.sources`), most 5, strings only. The runtime records none today. */
export function draftSourcesOf(decision: Record<string, unknown> | null | undefined): string[] {
  const inner = asRecord(asRecord(decision)?.decision);
  const raw = inner?.sources;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 300).slice(0, 5);
}
