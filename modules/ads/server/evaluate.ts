/**
 * Runs the rules over an account's stored rows and keeps the recommendation
 * table in step: exactly one open recommendation per object, stale ones
 * expired, snoozes honoured. No Composio calls — safe to run on every
 * setting change.
 */

import {
  getFbAdAccount,
  insertFbAdsRecommendation,
  listFbAdsDaily,
  listFbAdsRecommendations,
  updateFbAdsRecommendation,
} from './store.js';
import { accountTimezone, evaluateAccountRows } from './model.js';
import { addDays, dayIn } from './metrics.js';
import { reconcile, type ExistingRec, type RecOp } from './rules.js';

/** Days of rows the rules need: the 14-day window the snapshot keeps. */
const RULE_HISTORY_DAYS = 14;

export interface EvaluationSummary {
  created: number;
  refreshed: number;
  reopened: number;
  expired: number;
}

export function runEvaluation(accountId: string, nowSec: number = Math.floor(Date.now() / 1000)): EvaluationSummary {
  const summary: EvaluationSummary = { created: 0, refreshed: 0, reopened: 0, expired: 0 };
  const account = getFbAdAccount(accountId);
  if (!account) return summary;

  const today = dayIn(accountTimezone(account), nowSec);
  const rows = listFbAdsDaily(accountId, addDays(today, -(RULE_HISTORY_DAYS - 1)));
  const recs = listFbAdsRecommendations(accountId, ['open', 'snoozed', 'done']);
  const { evaluations } = evaluateAccountRows(account, rows, recs, nowSec);

  const existing: ExistingRec[] = recs.map((r) => ({
    id: r.id,
    level: r.level,
    objectId: r.object_id,
    action: r.action,
    state: r.state,
    snoozedUntil: r.snoozed_until,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  const ops = reconcile(existing, evaluations.filter((e) => e.actionable), nowSec);
  for (const op of ops) apply(accountId, op, summary);
  return summary;
}

function apply(accountId: string, op: RecOp, summary: EvaluationSummary): void {
  switch (op.type) {
    case 'create':
      insertFbAdsRecommendation({
        accountId,
        level: op.ev.level,
        objectId: op.ev.objectId,
        objectName: op.ev.objectName,
        action: op.ev.action,
        rule: op.ev.rule,
        reason: op.ev.reason,
        metricsJson: JSON.stringify(op.ev.metrics),
      });
      summary.created++;
      return;
    case 'refresh':
      updateFbAdsRecommendation(op.id, {
        objectName: op.ev.objectName,
        action: op.ev.action,
        rule: op.ev.rule,
        reason: op.ev.reason,
        metricsJson: JSON.stringify(op.ev.metrics),
      });
      summary.refreshed++;
      return;
    case 'reopen':
      updateFbAdsRecommendation(op.id, {
        objectName: op.ev.objectName,
        action: op.ev.action,
        rule: op.ev.rule,
        reason: op.ev.reason,
        metricsJson: JSON.stringify(op.ev.metrics),
        state: 'open',
        snoozedUntil: null,
      });
      summary.reopened++;
      return;
    case 'expire':
      updateFbAdsRecommendation(op.id, { state: 'expired' });
      summary.expired++;
      return;
  }
}
