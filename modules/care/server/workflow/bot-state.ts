/**
 * T07: the state label of a conversation row ("Chờ bạn duyệt" ... "Chưa gán bot"), computed here and nowhere else.
 *
 * `decideBotState` is pure (the unit tests drive it with plain facts); `buildBotStates` gathers those facts for a page
 * of rows with a fixed number of queries (assignments per account, the owner's last reply per conversation) and runs the
 * same rule walk the agent turn uses (`previewEffectiveRule`: it reports a tie instead of throwing).
 *
 * Precedence, first match wins:
 *   1. handoff  the T06 marker is set (the customer asked for a person; only the owner clears it)
 *   2. review   a bot draft waits (`status in draft | needs_review`)
 *   3. none     no way for the bot to speak here: Telegram, a group, no enabled rule, observe-only
 *   4. yielded  the bot holds back: timed pause still running, owner took over, or the owner wrote within the rule's
 *               `humanPauseMinutes` window (`human_active` in eligibility.ts)
 *   5. none     the owner switched the bot off for this conversation (`ai_mode = off`)
 *   6. active   an enabled draft/auto rule and nothing holds the bot back
 */

import type Database from 'better-sqlite3';
import type { CareAssignment, CareConversationRecord } from '../../../_lib/care-kit/types.js';
import type { CareAssignmentMode, CareBotLabel, CareBotStateDto, CareBotYieldReason } from '../api/dto-inbox.js';
import { previewEffectiveRule, type RuleResolveContext } from '../policy/assignment-resolver.js';

export interface BotFacts {
  channel: string;
  kind: string;
  nowMs: number;
  pendingDrafts: number;
  /** The effective rule when it is enabled (outcome `active`); null for no rule, a deny override or a tie. */
  rule: { agentId: string; mode: CareAssignmentMode; humanPauseMinutes: number } | null;
  aiModeOff: boolean;
  takenOver: boolean;
  handoff: { atMs: number; keyword: string | null } | null;
  isPaused: boolean;
  pausedUntilMs: number | null;
  lastHumanReplyAtMs: number | null;
}

/** The timed pause is on and not over yet (the same test as `evaluateEligibility`). */
export function pauseRunning(isPaused: boolean, pausedUntilMs: number | null, nowMs: number): boolean {
  return isPaused && (pausedUntilMs === null || pausedUntilMs > nowMs);
}

export function decideBotState(f: BotFacts): CareBotStateDto {
  const paused = pauseRunning(f.isPaused, f.pausedUntilMs, f.nowMs);
  const base = {
    agentId: f.rule?.agentId ?? null,
    mode: f.rule?.mode ?? null,
    paused,
    pausedUntilMs: paused ? f.pausedUntilMs : null,
    humanPauseMinutes: f.rule?.humanPauseMinutes ?? null,
    handoff: f.handoff,
  };
  const out = (label: CareBotLabel, yieldReason: CareBotYieldReason | null = null): CareBotStateDto => ({ label, yieldReason, ...base });

  if (f.handoff) return out('handoff');
  if (f.pendingDrafts > 0) return out('review');
  const canSpeak = f.channel !== 'telegram' && f.kind === 'direct' && f.rule !== null && f.rule.mode !== 'observe';
  if (!canSpeak) return out('none');
  if (paused) return out('yielded', 'paused');
  if (f.takenOver) return out('yielded', 'taken_over');
  const window = f.rule!.humanPauseMinutes;
  if (window > 0 && f.lastHumanReplyAtMs !== null && f.nowMs - f.lastHumanReplyAtMs < window * 60_000) return out('yielded', 'human_reply');
  if (f.aiModeOff) return out('none');
  return out('active');
}

const CHUNK = 400;

/** Newest reply a person sent (phone or dashboard) per conversation: the same facts as the agent turn's `lastHumanReplyAtMs`. */
function lastHumanReplies(db: Database.Database, ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const rows = db
      .prepare(
        `SELECT conversation_id AS id, MAX(sent_at) AS at FROM care_messages
         WHERE direction = 'out' AND sender_role IN ('self','operator') AND is_deleted = 0 AND tombstone = 0
           AND conversation_id IN (${part.map(() => '?').join(',')}) GROUP BY conversation_id`,
      )
      .all(...part) as Array<{ id: string; at: number | null }>;
    for (const r of rows) if (r.at !== null && r.at !== undefined) out.set(r.id, Number(r.at));
  }
  return out;
}

export interface BotStateRow {
  rec: CareConversationRecord;
  channel: string;
  pendingDrafts: number;
  aiMode: 'off' | 'draft' | 'auto' | null;
  takenOver: boolean;
  handoffAt: number | null | undefined;
  handoffKeyword: string | null | undefined;
}

export function ruleContextOf(rec: CareConversationRecord, channel: string): RuleResolveContext {
  return {
    accountId: rec.accountId,
    channel: channel as RuleResolveContext['channel'],
    conversationKey: rec.externalKey,
    conversationKind: rec.kind,
    customerId: rec.primaryCustomerId,
    identityKey: null,
    emailSender: null,
  };
}

/** The rule that applies to a conversation, `null` unless it is an enabled one. A tie or a deny override is no rule. */
export function activeRuleOf(assignments: readonly CareAssignment[], rec: CareConversationRecord, channel: string): { agentId: string; mode: CareAssignmentMode; humanPauseMinutes: number } | null {
  const preview = previewEffectiveRule(assignments, ruleContextOf(rec, channel));
  if (preview.outcome !== 'active' || !preview.rule) return null;
  return { agentId: preview.rule.agentId, mode: preview.rule.mode, humanPauseMinutes: preview.rule.policy.values.humanPauseMinutes };
}

export function buildBotStates(
  db: Database.Database,
  listAssignments: (accountId: string) => readonly CareAssignment[],
  nowMs: number,
  rows: readonly BotStateRow[],
): Map<string, CareBotStateDto> {
  const out = new Map<string, CareBotStateDto>();
  if (rows.length === 0) return out;
  const human = lastHumanReplies(db, rows.map((r) => r.rec.id));
  const byAccount = new Map<string, readonly CareAssignment[]>();
  const assignmentsOf = (accountId: string): readonly CareAssignment[] => {
    let a = byAccount.get(accountId);
    if (!a) {
      a = listAssignments(accountId);
      byAccount.set(accountId, a);
    }
    return a;
  };
  for (const r of rows) {
    out.set(
      r.rec.id,
      decideBotState({
        channel: r.channel,
        kind: r.rec.kind,
        nowMs,
        pendingDrafts: r.pendingDrafts,
        rule: activeRuleOf(assignmentsOf(r.rec.accountId), r.rec, r.channel),
        aiModeOff: r.aiMode === 'off',
        takenOver: r.takenOver,
        handoff: typeof r.handoffAt === 'number' ? { atMs: r.handoffAt, keyword: r.handoffKeyword ?? null } : null,
        isPaused: r.rec.isPaused,
        pausedUntilMs: r.rec.pausedUntilMs,
        lastHumanReplyAtMs: human.get(r.rec.id) ?? null,
      }),
    );
  }
  return out;
}
