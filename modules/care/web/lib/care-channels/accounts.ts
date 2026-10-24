// View logic of the account cards on /m/care/channels: a usage bar and the default agent of an account. Pure
// (no browser APIs) so vitest can run it.

import type { CareAssignmentDto } from '@modules/care/server/api/dto-ops';

export interface UsageView {
  used: number;
  limit: number;
  /** 0..100 */
  percent: number;
  /** Close to the cap: the bar turns red from 90 %. */
  hot: boolean;
}

export function usageView(used: number, limit: number): UsageView {
  const safeLimit = Math.max(0, limit);
  const percent = safeLimit > 0 ? Math.min(100, Math.round((Math.max(0, used) / safeLimit) * 100)) : 0;
  return { used: Math.max(0, used), limit: safeLimit, percent, hot: percent >= 90 };
}

export interface DefaultAgentView {
  agentId: string;
  mode: 'observe' | 'draft' | 'auto';
  enabled: boolean;
}

/** The account-wide rule of an account (scope `account`, the highest priority one wins), or null. */
export function defaultAgentOf(rules: readonly CareAssignmentDto[], accountId: string): DefaultAgentView | null {
  const mine = rules.filter((r) => r.scope === 'account' && r.accountId === accountId);
  if (mine.length === 0) return null;
  const best = mine.slice().sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))[0]!;
  return { agentId: best.agentId, mode: best.mode, enabled: best.enabled };
}

/** Quiet hours as a card prints them (`22:00–07:00`), or null when they are off. */
export function quietHoursText(q: { enabled: boolean; start: string; end: string } | null | undefined): string | null {
  return q && q.enabled ? `${q.start}–${q.end}` : null;
}
