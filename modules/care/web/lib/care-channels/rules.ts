// "Ai trả lời ở đâu": the care rules (GET /api/m/care/assignments) as one table row model.
// Scopes: global | channel | account | customer | conversation | identity | domain.
// Pure functions only so vitest can run them without a browser.

import type { CareAssignmentDto } from '@modules/care/server/api/dto-ops';

/** Care channel id of a rule ('zalo', 'email', ...), or null for a rule that spans channels. */
export type RuleChannel = string | null;
/** What the rule is about, as the table words it. */
export type RuleTarget = 'channel' | 'account' | 'thread' | 'customer' | 'identity' | 'domain';
/** How specific it is: a conversation or customer beats an account, which beats a whole channel. */
export type RuleLevel = 'conversation' | 'customer' | 'account' | 'channel';
export type RuleAiMode = 'off' | 'draft' | 'auto';

export interface RuleRow {
  key: string;
  channel: RuleChannel;
  target: RuleTarget;
  level: RuleLevel;
  accountId: string | null;
  accountLabel: string;
  /** Conversation / customer / domain for the specific levels, else empty. */
  subject: string;
  /** The agent that answers; null for "Chưa giao". */
  agentId: string | null;
  /** `none`: the rule is switched off. `human`: AI only watches, a person answers. `agent`: an AI agent answers. */
  owner: 'agent' | 'human' | 'none';
  aiMode: RuleAiMode;
  enabled: boolean;
  /** Words that force a draft / hand-off to a person. */
  keywords: string[];
  keywordsKind: 'review' | 'handoff' | null;
  raw: CareAssignmentDto;
}

export interface RuleLabels {
  /** Care account id -> label */
  care: Record<string, string>;
}

const LEVEL_ORDER: Record<RuleLevel, number> = { conversation: 0, customer: 1, account: 2, channel: 3 };

export function aiModeOf(mode: 'observe' | 'draft' | 'auto'): RuleAiMode {
  return mode === 'observe' ? 'off' : mode;
}

function ownerOf(enabled: boolean, mode: 'observe' | 'draft' | 'auto', agentId: string): Pick<RuleRow, 'owner' | 'agentId' | 'aiMode'> {
  if (!enabled) return { owner: 'none', agentId: null, aiMode: 'off' };
  if (mode === 'observe') return { owner: 'human', agentId: agentId || null, aiMode: 'off' };
  return { owner: 'agent', agentId: agentId || null, aiMode: mode };
}

function words(list: unknown): string[] {
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [];
}

export function coreRuleRow(a: CareAssignmentDto, labels: RuleLabels): RuleRow {
  const ext = a.policyExt ?? {};
  const review = words(ext.reviewKeywords);
  const handoff = words(ext.handoffKeywords);
  const level: RuleLevel = a.scope === 'conversation' || a.scope === 'identity' ? 'conversation' : a.scope === 'customer' ? 'customer' : a.scope === 'global' || a.scope === 'channel' ? 'channel' : 'account';
  const target: RuleTarget = a.scope === 'conversation' ? 'thread' : a.scope === 'global' ? 'channel' : a.scope;
  return {
    key: `core:${a.id}`,
    channel: a.channel ?? null,
    target,
    level,
    accountId: a.accountId,
    accountLabel: a.accountId ? labels.care[a.accountId] ?? a.accountId.slice(-6) : '',
    subject: a.scopeTarget ?? (a.customerId ? `#${a.customerId.slice(-6)}` : ''),
    ...ownerOf(a.enabled, a.mode, a.agentId),
    enabled: a.enabled,
    keywords: review.length ? review : handoff,
    keywordsKind: review.length ? 'review' : handoff.length ? 'handoff' : null,
    raw: a,
  };
}

export function buildRuleRows(input: { core: CareAssignmentDto[]; labels: RuleLabels }): RuleRow[] {
  return input.core
    .map((a) => coreRuleRow(a, input.labels))
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || (a.channel ?? '').localeCompare(b.channel ?? '') || a.accountLabel.localeCompare(b.accountLabel) || a.subject.localeCompare(b.subject) || a.key.localeCompare(b.key));
}

/** "tiền, hoàn tiền, khiếu nại +2": the first few words, then how many more. */
export function keywordsSummary(keywords: string[], max = 4): string {
  if (keywords.length === 0) return '';
  const shown = keywords.slice(0, max).join(', ');
  return keywords.length > max ? `${shown} +${keywords.length - max}` : shown;
}

/** Narrows the table to one channel (`all` keeps everything; channel-less rules always stay). */
export function filterRuleRows(rows: RuleRow[], channel: string): RuleRow[] {
  return channel === 'all' ? rows : rows.filter((r) => r.channel === channel || r.channel === null);
}
