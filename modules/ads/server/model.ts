/**
 * Glue between stored rows (fb_ads_daily, fb_ads_recommendations) and the pure
 * rules: groups daily rows into objects and evaluates an account.
 */

import type { FbAdAccountRow, FbAdsDailyRow, FbAdsRecommendationRow } from './store.js';
import type { AdsResultType } from '../../_lib/fb-types.js';
import { addDays, dayIn, isResultType, type DayStats } from './metrics.js';
import {
  evaluateAccount,
  type Evaluation,
  type RuleContext,
  type RuleLevel,
  type RuleObject,
} from './rules.js';

export const RULE_WINDOW_DAYS = 14;

export const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';

export function accountTimezone(account: Pick<FbAdAccountRow, 'timezone'>): string {
  return account.timezone || DEFAULT_TIMEZONE;
}

export function accountResultType(account: Pick<FbAdAccountRow, 'result_type'>): AdsResultType {
  return isResultType(account.result_type) ? account.result_type : 'lead';
}

export function dayStatsOf(r: FbAdsDailyRow): DayStats {
  return {
    day: r.day,
    spend: r.spend,
    impressions: r.impressions,
    reach: r.reach,
    frequency: r.frequency,
    clicks: r.clicks,
    linkClicks: r.link_clicks,
    lpViews: r.lp_views,
    results: r.results,
    purchases: r.purchases,
    revenue: r.result_value,
    video3s: r.video_3s,
    thruplays: r.thruplays,
  };
}

/** Rows of the campaign / ad set / ad levels → one RuleObject per Meta object. */
export function buildRuleObjects(rows: readonly FbAdsDailyRow[]): RuleObject[] {
  const groups = new Map<string, FbAdsDailyRow[]>();
  for (const r of rows) {
    if (r.level !== 'campaign' && r.level !== 'adset' && r.level !== 'ad') continue;
    const key = `${r.level}:${r.object_id}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }

  const objects: RuleObject[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.day.localeCompare(b.day));
    const latest = group[group.length - 1]!;
    objects.push({
      level: latest.level as RuleLevel,
      id: latest.object_id,
      name: latest.name,
      parentId: latest.parent_id,
      status: latest.status,
      learning: latest.learning,
      dailyBudget: latest.daily_budget,
      days: group.map(dayStatsOf),
      windowFrequency: [...group].reverse().find((r) => r.freq_window !== null)?.freq_window ?? null,
    });
  }

  // Learning is reported per ad set; campaigns and ads inherit it.
  const adsets = new Map(objects.filter((o) => o.level === 'adset').map((o) => [o.id, o]));
  const campaignLearning = new Map<string, string>();
  for (const a of adsets.values()) {
    if (!a.learning) continue;
    const prev = campaignLearning.get(a.parentId);
    campaignLearning.set(a.parentId, prev === 'LEARNING' || a.learning === 'LEARNING' ? 'LEARNING' : 'SUCCESS');
  }
  for (const o of objects) {
    if (o.level === 'campaign' && !o.learning) o.learning = campaignLearning.get(o.id) ?? '';
    if (o.level === 'ad' && !o.learning) o.learning = adsets.get(o.parentId)?.learning ?? '';
  }
  return objects;
}

/** Key of the last time the owner marked an 'up' as done, per object. */
export function lastUpIndex(recs: readonly FbAdsRecommendationRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of recs) {
    if (r.action !== 'up' || r.state !== 'done') continue;
    const key = `${r.level}:${r.object_id}`;
    out.set(key, Math.max(out.get(key) ?? 0, r.updated_at));
  }
  return out;
}

export interface EvaluatedAccount {
  today: string;
  objects: RuleObject[];
  evaluations: Evaluation[];
  ctx: RuleContext;
}

export function evaluateAccountRows(
  account: FbAdAccountRow,
  rows: readonly FbAdsDailyRow[],
  recs: readonly FbAdsRecommendationRow[],
  nowSec: number,
): EvaluatedAccount {
  const today = dayIn(accountTimezone(account), nowSec);
  const lastUp = lastUpIndex(recs);
  const ctx: RuleContext = {
    today,
    targetCpa: account.target_cpa,
    resultType: accountResultType(account),
    currency: account.currency || 'VND',
    lastUpAt: (level, id) => lastUp.get(`${level}:${id}`) ?? null,
    nowSec,
  };
  const objects = buildRuleObjects(rows);
  // The rules look at a 14-day window ("first 3 days" of that window), however much history is stored.
  const from = addDays(today, -(RULE_WINDOW_DAYS - 1));
  const ruleObjects = objects.map((o) => ({ ...o, days: o.days.filter((d) => d.day >= from) }));
  return { today, objects, evaluations: evaluateAccount(ruleObjects, ctx), ctx };
}
