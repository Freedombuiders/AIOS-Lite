import { getDb } from '../../../src/modules/compat/db.js';
import { currentContext } from './context.js';
const nowSec = () => Math.floor(Date.now() / 1000);
const db = new Proxy({} as ReturnType<typeof getDb>, { get(_target, key) {
 const real = currentContext()?.db ?? getDb();
 const value = Reflect.get(real, key);
 return typeof value === 'function' ? value.bind(real) : value;
}});
function noticeSettings(): Record<string, string> {
  try { return JSON.parse(currentContext()?.settings.get<string>('connection_notices', '{}') ?? '{}'); }
  catch { return {}; }
}
export function getFbSetting(key: string): string | undefined { return noticeSettings()[key]; }
export function setFbSetting(key: string, value: string): void {
  currentContext()?.settings.set('connection_notices', JSON.stringify({ ...noticeSettings(), [key]: value }));
}


export interface FbAdAccountRow {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  connection_id: string;
  entity_id: string;
  enabled: number;
  result_type: string;
  target_cpa: number | null;
  monthly_budget: number | null;
  status: string;
  synced_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Inserts or refreshes an ad account; the owner's settings (enabled, result type, targets) are never overwritten. */
export function upsertFbAdAccount(a: {
  id: string; name: string; currency: string; timezone: string;
  connectionId: string; entityId: string; status: string;
}): void {
  const now = nowSec();
  db.prepare(
    `INSERT INTO fb_ad_accounts (id, name, currency, timezone, connection_id, entity_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, currency = excluded.currency,
       timezone = excluded.timezone, connection_id = excluded.connection_id,
       entity_id = excluded.entity_id, status = excluded.status, updated_at = excluded.updated_at`,
  ).run(a.id, a.name, a.currency, a.timezone, a.connectionId, a.entityId, a.status, now, now);
}

export function listFbAdAccounts(): FbAdAccountRow[] {
  return db.prepare(`SELECT * FROM fb_ad_accounts ORDER BY enabled DESC, name COLLATE NOCASE, id`).all() as FbAdAccountRow[];
}

export function getFbAdAccount(id: string): FbAdAccountRow | undefined {
  return db.prepare(`SELECT * FROM fb_ad_accounts WHERE id = ?`).get(id) as FbAdAccountRow | undefined;
}

export function updateFbAdAccountSettings(
  id: string,
  patch: { enabled?: boolean; resultType?: string; targetCpa?: number | null; monthlyBudget?: number | null },
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); params.push(patch.enabled ? 1 : 0); }
  if (patch.resultType !== undefined) { sets.push('result_type = ?'); params.push(patch.resultType); }
  if (patch.targetCpa !== undefined) { sets.push('target_cpa = ?'); params.push(patch.targetCpa); }
  if (patch.monthlyBudget !== undefined) { sets.push('monthly_budget = ?'); params.push(patch.monthlyBudget); }
  if (!sets.length) return;
  sets.push('updated_at = ?');
  params.push(nowSec(), id);
  db.prepare(`UPDATE fb_ad_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function setFbAdAccountStatus(id: string, status: string): void {
  db.prepare(`UPDATE fb_ad_accounts SET status = ?, updated_at = ? WHERE id = ? AND status != ?`).run(status, nowSec(), id, status);
}

export function markFbAdAccountSynced(id: string, atSec: number = nowSec()): void {
  db.prepare(`UPDATE fb_ad_accounts SET synced_at = ?, status = 'ACTIVE', updated_at = ? WHERE id = ?`).run(atSec, atSec, id);
}

/** level: account|campaign|adset|ad. freq_window is the 7-day frequency, kept on the object's latest day only. */
export interface FbAdsDailyRow {
  account_id: string;
  level: string;
  object_id: string;
  parent_id: string;
  day: string;
  name: string;
  status: string;
  daily_budget: number | null;
  spend: number;
  impressions: number;
  reach: number | null;
  frequency: number | null;
  clicks: number;
  link_clicks: number;
  lp_views: number;
  results: number;
  /** Purchase revenue (action_values), for ROAS. */
  result_value: number;
  purchases: number;
  video_3s: number;
  thruplays: number;
  creative_json: string;
  learning: string;
  raw_json: string;
  captured_at: number;
  freq_window: number | null;
}

export type FbAdsDailyInput = Omit<FbAdsDailyRow, 'freq_window'>;

export function upsertFbAdsDaily(rows: FbAdsDailyInput[]): void {
  if (!rows.length) return;
  const stmt = db.prepare(
    `INSERT INTO fb_ads_daily (account_id, level, object_id, parent_id, day, name, status, daily_budget, spend,
       impressions, reach, frequency, clicks, link_clicks, lp_views, results, result_value, purchases, video_3s,
       thruplays, creative_json, learning, raw_json, captured_at)
     VALUES (@account_id, @level, @object_id, @parent_id, @day, @name, @status, @daily_budget, @spend,
       @impressions, @reach, @frequency, @clicks, @link_clicks, @lp_views, @results, @result_value, @purchases, @video_3s,
       @thruplays, @creative_json, @learning, @raw_json, @captured_at)
     ON CONFLICT(account_id, level, object_id, day) DO UPDATE SET
       parent_id = excluded.parent_id, name = excluded.name, status = excluded.status,
       daily_budget = excluded.daily_budget, spend = excluded.spend, impressions = excluded.impressions,
       reach = excluded.reach, frequency = excluded.frequency, clicks = excluded.clicks,
       link_clicks = excluded.link_clicks, lp_views = excluded.lp_views, results = excluded.results,
       result_value = excluded.result_value, purchases = excluded.purchases, video_3s = excluded.video_3s,
       thruplays = excluded.thruplays, creative_json = excluded.creative_json, learning = excluded.learning,
       raw_json = excluded.raw_json, captured_at = excluded.captured_at`,
  );
  db.transaction(() => { for (const r of rows) stmt.run(r); })();
}

/** Moves the 7-day frequency of an object onto its latest stored day (and clears it elsewhere). */
export function setFbAdsWindowFrequency(accountId: string, level: string, objectId: string, freq: number | null): void {
  db.transaction(() => {
    db.prepare(`UPDATE fb_ads_daily SET freq_window = NULL WHERE account_id = ? AND level = ? AND object_id = ? AND freq_window IS NOT NULL`)
      .run(accountId, level, objectId);
    if (freq === null) return;
    db.prepare(
      `UPDATE fb_ads_daily SET freq_window = ?
       WHERE account_id = ? AND level = ? AND object_id = ?
         AND day = (SELECT MAX(day) FROM fb_ads_daily WHERE account_id = ? AND level = ? AND object_id = ?)`,
    ).run(freq, accountId, level, objectId, accountId, level, objectId);
  })();
}

export function listFbAdsDaily(accountId: string, sinceDay: string, levels?: string[]): FbAdsDailyRow[] {
  const lv = levels?.length ? ` AND level IN (${levels.map(() => '?').join(',')})` : '';
  return db.prepare(
    `SELECT * FROM fb_ads_daily WHERE account_id = ? AND day >= ?${lv} ORDER BY level, object_id, day`,
  ).all(accountId, sinceDay, ...(levels ?? [])) as FbAdsDailyRow[];
}

/** Re-derives `results` for every stored row after the owner changes the result type (no API call needed). */
export function recomputeFbAdsResults(accountId: string, resultsFromRaw: (rawJson: string) => number): void {
  const rows = db.prepare(`SELECT level, object_id, day, raw_json FROM fb_ads_daily WHERE account_id = ?`)
    .all(accountId) as Array<{ level: string; object_id: string; day: string; raw_json: string }>;
  const stmt = db.prepare(`UPDATE fb_ads_daily SET results = ? WHERE account_id = ? AND level = ? AND object_id = ? AND day = ?`);
  db.transaction(() => { for (const r of rows) stmt.run(resultsFromRaw(r.raw_json), accountId, r.level, r.object_id, r.day); })();
}

export function pruneFbAdsData(accountId: string, beforeDay: string): void {
  db.prepare(`DELETE FROM fb_ads_daily WHERE account_id = ? AND day < ?`).run(accountId, beforeDay);
  db.prepare(`DELETE FROM fb_ads_placement_daily WHERE account_id = ? AND day < ?`).run(accountId, beforeDay);
}

export interface FbAdsPlacementRow {
  account_id: string;
  day: string;
  placement: string;
  spend: number;
  impressions: number;
  results: number;
  captured_at: number;
}

/** Replaces the placement rows from `sinceDay` on (so placements Meta stopped reporting disappear). */
export function replaceFbAdsPlacements(accountId: string, sinceDay: string, rows: FbAdsPlacementRow[]): void {
  const stmt = db.prepare(
    `INSERT INTO fb_ads_placement_daily (account_id, day, placement, spend, impressions, results, captured_at)
     VALUES (@account_id, @day, @placement, @spend, @impressions, @results, @captured_at)
     ON CONFLICT(account_id, day, placement) DO UPDATE SET spend = excluded.spend,
       impressions = excluded.impressions, results = excluded.results, captured_at = excluded.captured_at`,
  );
  db.transaction(() => {
    db.prepare(`DELETE FROM fb_ads_placement_daily WHERE account_id = ? AND day >= ?`).run(accountId, sinceDay);
    for (const r of rows) stmt.run(r);
  })();
}

export function listFbAdsPlacements(accountId: string, sinceDay: string): FbAdsPlacementRow[] {
  return db.prepare(`SELECT * FROM fb_ads_placement_daily WHERE account_id = ? AND day >= ? ORDER BY day, placement`)
    .all(accountId, sinceDay) as FbAdsPlacementRow[];
}

export interface FbAdsRecommendationRow {
  id: number;
  account_id: string;
  level: string;
  object_id: string;
  object_name: string;
  action: string;
  rule: string;
  reason: string;
  metrics_json: string;
  state: string;
  snoozed_until: number | null;
  created_at: number;
  updated_at: number;
}

export function listFbAdsRecommendations(accountId: string, states?: string[]): FbAdsRecommendationRow[] {
  const where = states?.length ? ` AND state IN (${states.map(() => '?').join(',')})` : '';
  return db.prepare(`SELECT * FROM fb_ads_recommendations WHERE account_id = ?${where} ORDER BY id`)
    .all(accountId, ...(states ?? [])) as FbAdsRecommendationRow[];
}

export function getFbAdsRecommendation(id: number): FbAdsRecommendationRow | undefined {
  return db.prepare(`SELECT * FROM fb_ads_recommendations WHERE id = ?`).get(id) as FbAdsRecommendationRow | undefined;
}

export function insertFbAdsRecommendation(r: {
  accountId: string; level: string; objectId: string; objectName: string;
  action: string; rule: string; reason: string; metricsJson: string;
}): number {
  const now = nowSec();
  const res = db.prepare(
    `INSERT INTO fb_ads_recommendations (account_id, level, object_id, object_name, action, rule, reason, metrics_json, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).run(r.accountId, r.level, r.objectId, r.objectName, r.action, r.rule, r.reason, r.metricsJson, now, now);
  return Number(res.lastInsertRowid);
}

export function updateFbAdsRecommendation(id: number, patch: {
  objectName?: string; action?: string; rule?: string; reason?: string; metricsJson?: string;
  state?: string; snoozedUntil?: number | null;
}): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.objectName !== undefined) { sets.push('object_name = ?'); params.push(patch.objectName); }
  if (patch.action !== undefined) { sets.push('action = ?'); params.push(patch.action); }
  if (patch.rule !== undefined) { sets.push('rule = ?'); params.push(patch.rule); }
  if (patch.reason !== undefined) { sets.push('reason = ?'); params.push(patch.reason); }
  if (patch.metricsJson !== undefined) { sets.push('metrics_json = ?'); params.push(patch.metricsJson); }
  if (patch.state !== undefined) { sets.push('state = ?'); params.push(patch.state); }
  if (patch.snoozedUntil !== undefined) { sets.push('snoozed_until = ?'); params.push(patch.snoozedUntil); }
  if (!sets.length) return;
  sets.push('updated_at = ?');
  params.push(nowSec(), id);
  db.prepare(`UPDATE fb_ads_recommendations SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

/** Open or snoozed recommendations nobody re-confirmed since `cutoffSec` (snapshots stopped) expire. */
export function expireStaleFbAdsRecommendations(cutoffSec: number): number {
  return db.prepare(
    `UPDATE fb_ads_recommendations SET state = 'expired', updated_at = ? WHERE state IN ('open', 'snoozed') AND updated_at < ?`,
  ).run(nowSec(), cutoffSec).changes;
}

export type { FbAdsOrganicRow } from '../../_lib/fb-types.js';
