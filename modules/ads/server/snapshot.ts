import { currentContext } from './context.js';
/**
 * The Meta Ads snapshot: pulls insights and entity state through Composio
 * (read tools only), normalises them into fb_ads_daily / fb_ads_placement_daily
 * and re-runs the rules.
 *
 * Calls per account and run (steady state, one page each):
 *   3  entity state     METAADS_LIST_CAMPAIGNS, METAADS_READ_ADSETS, METAADS_LIST_ADS
 *   4  daily insights   METAADS_GET_INSIGHTS level account / campaign / adset / ad, time_increment=1
 *   3  7-day frequency  METAADS_GET_INSIGHTS level campaign / adset / ad, one row per object
 *   1  placements       METAADS_GET_INSIGHTS breakdowns publisher_platform + platform_position
 *  11  in total; more only when a level has over 500 rows (extra pages).
 * Never a create / update / pause / delete tool.
 */

import {
  getFbAdAccount,
  markFbAdAccountSynced,
  pruneFbAdsData,
  replaceFbAdsPlacements,
  setFbAdsWindowFrequency,
  upsertFbAdsDaily,
  type FbAdAccountRow,
  type FbAdsDailyInput,
  type FbAdsPlacementRow,
} from './store.js';
import { logger } from '../../../src/modules/compat/logger.js';
import {
  ComposioAuthError,
  ComposioConnectionExpiredError,
  ComposioRateLimitError,
  FbBudgetExceeded,
  type FbCallTarget,
} from '../../_lib/composio.js';
import type { AdsResultType } from '../../_lib/fb-types.js';
import { clearExpiredNotice, markAccountExpired } from './accounts.js';
import { runEvaluation } from './evaluate.js';
import { metaRead } from './graph-tools.js';
import {
  budgetFromMinorUnits,
  extractRows,
  InsightsRowSchema,
  metricsFromInsights,
  monthStart,
  placementKey,
  resultsFromActions,
  addDays,
  dayIn,
  toNum,
  type AdsLevel,
  type InsightsRow,
} from './metrics.js';
import { accountResultType, accountTimezone } from './model.js';

export const TOOLS = {
  campaigns: 'METAADS_LIST_CAMPAIGNS',
  adsets: 'METAADS_READ_ADSETS',
  ads: 'METAADS_LIST_ADS',
  insights: 'METAADS_GET_INSIGHTS',
} as const;

/** Object-level history: the UI's longest window (28 days). */
const HISTORY_DAYS = 28;
const KEEP_DAYS = 45;
const INSIGHTS_PAGE = 500;
const MAX_PAGES = 8;

/** Fields shared by every insights call. */
const METRIC_FIELDS = [
  'spend', 'impressions', 'reach', 'frequency', 'clicks', 'inline_link_clicks',
  'actions', 'action_values', 'video_thruplay_watched_actions',
];

const LEVEL_FIELDS: Record<AdsLevel, string[]> = {
  account: ['account_id'],
  campaign: ['campaign_id', 'campaign_name'],
  adset: ['adset_id', 'adset_name', 'campaign_id'],
  ad: ['ad_id', 'ad_name', 'adset_id', 'campaign_id'],
};

interface EntityState {
  name: string;
  status: string;
  dailyBudget: number | null;
  learning: string;
  parentId: string;
  creativeJson: string;
}

type EntityMap = Map<string, EntityState>;

interface CallCounter { calls: number }

const asString = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

async function call(counter: CallCounter, args: Record<string, unknown>, slug: string, target: FbCallTarget): Promise<unknown> {
  counter.calls++;
  return metaRead(slug, args, target);
}

/** Errors that must abort the whole run (connection, key, limits); everything else degrades gracefully. */
function isFatal(err: unknown): boolean {
  return err instanceof ComposioConnectionExpiredError
    || err instanceof ComposioRateLimitError
    || err instanceof ComposioAuthError
    || err instanceof FbBudgetExceeded;
}

// ── Entity state ──────────────────────────────────────────────────────

async function fetchCampaigns(account: FbAdAccountRow, target: FbCallTarget, counter: CallCounter): Promise<EntityMap> {
  const out: EntityMap = new Map();
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await call(counter, {
      ad_account_id: account.id,
      fields: ['id', 'name', 'effective_status', 'daily_budget'],
      limit: 200,
      ...(after ? { after } : {}),
    }, TOOLS.campaigns, target);
    const { rows, after: next } = extractRows(raw, 200);
    for (const r of rows as Array<Record<string, unknown>>) {
      const id = asString(r.id);
      if (!id) continue;
      out.set(id, {
        name: asString(r.name), status: asString(r.effective_status || r.status), parentId: '',
        dailyBudget: budgetFromMinorUnits(r.daily_budget as string | undefined, account.currency),
        learning: '', creativeJson: '{}',
      });
    }
    if (!next) break;
    after = next;
  }
  return out;
}

async function fetchAdsets(account: FbAdAccountRow, target: FbCallTarget, counter: CallCounter): Promise<EntityMap> {
  const raw = await call(counter, {
    ad_account_id: account.id,
    fields: ['id', 'name', 'campaign_id', 'effective_status', 'daily_budget', 'learning_stage_info'],
    limit: 1000,
  }, TOOLS.adsets, target);
  const out: EntityMap = new Map();
  for (const r of extractRows(raw).rows as Array<Record<string, unknown>>) {
    const id = asString(r.id);
    if (!id) continue;
    const learning = (r.learning_stage_info as { status?: unknown } | undefined)?.status;
    out.set(id, {
      name: asString(r.name), status: asString(r.effective_status || r.status), parentId: asString(r.campaign_id),
      dailyBudget: budgetFromMinorUnits(r.daily_budget as string | undefined, account.currency),
      learning: asString(learning), creativeJson: '{}',
    });
  }
  return out;
}

/** Whether Meta accepted the nested `creative{...}` field expansion; flips off after one rejection. */
let nestedCreativeOk = true;
export function _resetCreativeProbe(): void { nestedCreativeOk = true; }

const AD_FIELDS_PLAIN = 'id,name,adset_id,campaign_id,effective_status';
const AD_FIELDS_NESTED = `${AD_FIELDS_PLAIN},creative{id,object_type,video_id,thumbnail_url,effective_object_story_id}`;

function creativeJsonOf(r: Record<string, unknown>): string {
  const c = r.creative as Record<string, unknown> | undefined;
  if (!c || typeof c !== 'object') return '{}';
  const objectType = asString(c.object_type).toUpperCase();
  const videoId = asString(c.video_id);
  const format = videoId ? 'video' : objectType === 'PHOTO' ? 'photo' : objectType === 'SHARE' ? 'link' : '';
  return JSON.stringify({
    id: asString(c.id), objectType, videoId, thumbnailUrl: asString(c.thumbnail_url),
    storyId: asString(c.effective_object_story_id), format,
  });
}

async function fetchAds(account: FbAdAccountRow, target: FbCallTarget, counter: CallCounter): Promise<EntityMap> {
  const request = (fields: string) => call(counter, { ad_account_id: account.id, fields, limit: 100 }, TOOLS.ads, target);
  let raw: unknown;
  if (nestedCreativeOk) {
    try {
      raw = await request(AD_FIELDS_NESTED);
    } catch (err) {
      if (isFatal(err)) throw err;
      nestedCreativeOk = false; // field expansion refused: fall back to the plain list from now on
      raw = await request(AD_FIELDS_PLAIN);
    }
  } else {
    raw = await request(AD_FIELDS_PLAIN);
  }
  const out: EntityMap = new Map();
  for (const r of extractRows(raw).rows as Array<Record<string, unknown>>) {
    const id = asString(r.id);
    if (!id) continue;
    out.set(id, {
      name: asString(r.name), status: asString(r.effective_status || r.status), parentId: asString(r.adset_id),
      dailyBudget: null, learning: '', creativeJson: creativeJsonOf(r),
    });
  }
  return out;
}

/** An entity listing failing for a non-fatal reason (permissions, shape) leaves states unknown, it does not stop the run. */
async function softly(label: string, fn: () => Promise<EntityMap>): Promise<EntityMap> {
  try {
    return await fn();
  } catch (err) {
    if (isFatal(err)) throw err;
    logger.warn({ err: (err as Error).name, message: (err as Error).message.slice(0, 200), step: label }, 'fbstudio ads: entity listing failed, continuing without it');
    return new Map();
  }
}

// ── Insights ──────────────────────────────────────────────────────────

interface InsightsQuery {
  level: AdsLevel;
  since: string;
  until: string;
  /** 1 = one row per day; 'all_days' = one row per object for the whole range. */
  increment: 1 | 'all_days';
  breakdowns?: string[];
  fields?: string[];
}

async function fetchInsights(account: FbAdAccountRow, target: FbCallTarget, counter: CallCounter, q: InsightsQuery): Promise<InsightsRow[]> {
  const rows: InsightsRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await call(counter, {
      object_id: account.id,
      level: q.level,
      time_range: { since: q.since, until: q.until },
      time_increment: q.increment,
      fields: q.fields ?? [...METRIC_FIELDS, ...LEVEL_FIELDS[q.level]],
      ...(q.breakdowns ? { breakdowns: q.breakdowns } : {}),
      limit: INSIGHTS_PAGE,
      ...(after ? { after } : {}),
    }, TOOLS.insights, target);
    const { rows: pageRows, after: next } = extractRows(raw, INSIGHTS_PAGE);
    let bad = 0;
    for (const r of pageRows) {
      const parsed = InsightsRowSchema.safeParse(r);
      if (parsed.success) rows.push(parsed.data);
      else bad++;
    }
    // A response that parses to nothing at all means the shape drifted: fail loudly rather than store zeros.
    if (pageRows.length > 0 && bad === pageRows.length) throw new Error(`unexpected insights shape (level ${q.level})`);
    if (!next) break;
    after = next;
  }
  return rows;
}

function idsOf(row: InsightsRow, level: AdsLevel, accountId: string): { id: string; name: string; parentId: string } | null {
  switch (level) {
    case 'account': return { id: accountId, name: '', parentId: '' };
    case 'campaign': return row.campaign_id ? { id: row.campaign_id, name: row.campaign_name ?? '', parentId: '' } : null;
    case 'adset': return row.adset_id ? { id: row.adset_id, name: row.adset_name ?? '', parentId: row.campaign_id ?? '' } : null;
    case 'ad': return row.ad_id ? { id: row.ad_id, name: row.ad_name ?? '', parentId: row.adset_id ?? '' } : null;
  }
}

export function toDailyInputs(
  account: FbAdAccountRow,
  level: AdsLevel,
  rows: InsightsRow[],
  entities: EntityMap,
  resultType: AdsResultType,
  capturedAt: number,
): FbAdsDailyInput[] {
  const out: FbAdsDailyInput[] = [];
  for (const row of rows) {
    const ids = idsOf(row, level, account.id);
    const day = row.date_start;
    if (!ids || !day) continue;
    const m = metricsFromInsights(row, resultType);
    const entity = entities.get(ids.id);
    out.push({
      account_id: account.id,
      level,
      object_id: ids.id,
      parent_id: entity?.parentId || ids.parentId,
      day,
      name: entity?.name || ids.name || (level === 'account' ? account.name : ''),
      status: entity?.status ?? '',
      daily_budget: entity?.dailyBudget ?? null,
      spend: m.spend,
      impressions: m.impressions,
      reach: m.reach,
      frequency: m.frequency,
      clicks: m.clicks,
      link_clicks: m.linkClicks,
      lp_views: m.lpViews,
      results: m.results,
      result_value: m.revenue,
      purchases: m.purchases,
      video_3s: m.video3s,
      thruplays: m.thruplays,
      creative_json: entity?.creativeJson ?? '{}',
      learning: entity?.learning ?? '',
      raw_json: JSON.stringify({ r: m.byType }),
      captured_at: capturedAt,
    });
  }
  return out;
}

export function toPlacementRows(
  accountId: string,
  rows: InsightsRow[],
  resultType: AdsResultType,
  capturedAt: number,
): FbAdsPlacementRow[] {
  const merged = new Map<string, FbAdsPlacementRow>();
  for (const row of rows) {
    if (!row.date_start) continue;
    const placement = placementKey(row.publisher_platform, row.platform_position);
    const key = `${row.date_start}|${placement}`;
    const prev = merged.get(key) ?? {
      account_id: accountId, day: row.date_start, placement, spend: 0, impressions: 0, results: 0, captured_at: capturedAt,
    };
    prev.spend += toNum(row.spend);
    prev.impressions += Math.round(toNum(row.impressions));
    prev.results += Math.round(resultsFromActions(row.actions, resultType));
    merged.set(key, prev);
  }
  return [...merged.values()];
}

// ── One run ───────────────────────────────────────────────────────────

export interface SnapshotResult {
  calls: number;
  dailyRows: number;
  placementRows: number;
}

/** Pulls and stores everything for one ad account. Throws the typed Composio errors. */
export async function snapshotAccount(account: FbAdAccountRow, nowSec: number = Math.floor(Date.now() / 1000)): Promise<SnapshotResult> {
  const target: FbCallTarget = { area: 'ads', connectionId: account.connection_id, entityId: account.entity_id };
  const counter: CallCounter = { calls: 0 };
  const resultType = accountResultType(account);
  const today = dayIn(accountTimezone(account), nowSec);
  const windowFrom = addDays(today, -(HISTORY_DAYS - 1));
  // Account-level rows also cover the month so far (pacing against the monthly budget).
  const accountFrom = monthStart(today) < windowFrom ? monthStart(today) : windowFrom;
  const weekFrom = addDays(today, -6);

  const [campaigns, adsets, ads] = [
    await softly('campaigns', () => fetchCampaigns(account, target, counter)),
    await softly('adsets', () => fetchAdsets(account, target, counter)),
    await softly('ads', () => fetchAds(account, target, counter)),
  ];
  const entities: Record<AdsLevel, EntityMap> = { account: new Map(), campaign: campaigns, adset: adsets, ad: ads };

  let dailyRows = 0;
  for (const level of ['account', 'campaign', 'adset', 'ad'] as const) {
    const rows = await fetchInsights(account, target, counter, {
      level, since: level === 'account' ? accountFrom : windowFrom, until: today, increment: 1,
    });
    const inputs = toDailyInputs(account, level, rows, entities[level], resultType, nowSec);
    upsertFbAdsDaily(inputs);
    dailyRows += inputs.length;
  }

  // 7-day frequency per object (daily frequencies cannot be summed). Optional: a failure here only costs R3 precision.
  for (const level of ['campaign', 'adset', 'ad'] as const) {
    try {
      const rows = await fetchInsights(account, target, counter, {
        level, since: weekFrom, until: today, increment: 'all_days',
        fields: ['frequency', ...LEVEL_FIELDS[level]],
      });
      for (const row of rows) {
        const ids = idsOf(row, level, account.id);
        const freq = row.frequency == null ? null : toNum(row.frequency);
        if (ids && freq !== null && freq > 0) setFbAdsWindowFrequency(account.id, level, ids.id, freq);
      }
    } catch (err) {
      if (isFatal(err)) throw err;
      logger.warn({ err: (err as Error).name, level }, 'fbstudio ads: window frequency unavailable');
    }
  }

  // Placements: last 7 days, per day, by platform and position.
  const placementInsights = await fetchInsights(account, target, counter, {
    level: 'account', since: weekFrom, until: today, increment: 1,
    breakdowns: ['publisher_platform', 'platform_position'],
    fields: ['spend', 'impressions', 'actions'],
  });
  const placementRows = toPlacementRows(account.id, placementInsights, resultType, nowSec);
  replaceFbAdsPlacements(account.id, weekFrom, placementRows);

  pruneFbAdsData(account.id, addDays(today, -KEEP_DAYS));
  markFbAdAccountSynced(account.id, nowSec);
  clearExpiredNotice(account.id);
  runEvaluation(account.id, nowSec);
  currentContext()?.events?.emit('snapshot', { accountId: account.id });
  return { calls: counter.calls, dailyRows, placementRows: placementRows.length };
}

// ── Guarded entry point shared by the worker and the refresh route ────

export class AdsRefreshBusyError extends Error {
  constructor() { super('Đang cập nhật tài khoản này, thử lại sau ít phút.'); this.name = 'AdsRefreshBusyError'; }
}
export class AdsRefreshTooSoonError extends Error {
  constructor(public readonly retryAfterSec: number) {
    super('Vừa cập nhật xong, đợi vài phút rồi thử lại.');
    this.name = 'AdsRefreshTooSoonError';
  }
}

const inFlight = new Set<string>();
const lastStartedAt = new Map<string, number>();
const MANUAL_MIN_INTERVAL_SEC = 120;

export function _resetSnapshotGuards(): void { inFlight.clear(); lastStartedAt.clear(); }

/**
 * Snapshot with an in-flight guard per account. An expired connection marks
 * the account EXPIRED (and notifies once) and is rethrown for the caller.
 */
export async function runAccountSnapshot(accountId: string, opts: { manual?: boolean; nowSec?: number } = {}): Promise<SnapshotResult> {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const account = getFbAdAccount(accountId);
  if (!account) throw new Error(`unknown ad account ${accountId}`);
  if (inFlight.has(accountId)) throw new AdsRefreshBusyError();
  const last = lastStartedAt.get(accountId);
  if (opts.manual && last !== undefined && nowSec - last < MANUAL_MIN_INTERVAL_SEC) {
    throw new AdsRefreshTooSoonError(MANUAL_MIN_INTERVAL_SEC - (nowSec - last));
  }
  inFlight.add(accountId);
  lastStartedAt.set(accountId, nowSec);
  try {
    return await snapshotAccount(account, nowSec);
  } catch (err) {
    if (err instanceof ComposioConnectionExpiredError) await markAccountExpired(account);
    throw err;
  } finally {
    inFlight.delete(accountId);
  }
}
