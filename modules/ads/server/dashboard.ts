/**
 * AdsDashboardDto: everything the Ads screen shows, computed from stored
 * rows. The builder is a pure function of its input (rows in, DTO out); the
 * loader at the bottom reads SQLite.
 */

import {
  listFbAdsDaily,
  listFbAdsPlacements,
  listFbAdsRecommendations,
  type FbAdAccountRow,
  type FbAdsDailyRow,
  type FbAdsOrganicRow,
  type FbAdsPlacementRow,
  type FbAdsRecommendationRow,
} from './store.js';
import type {
  AdAccountDto,
  AdsAction,
  AdsDashboardDto,
  AdsRecommendationDto,
  ConnStatus,
  FbFormat,
} from '../../_lib/fb-types.js';
import { fmtNum, fmtPct } from './format.js';
import {
  accountResultType,
  accountTimezone,
  dayStatsOf,
  evaluateAccountRows,
  type EvaluatedAccount,
} from './model.js';
import {
  addDays,
  cpaOf,
  cpmOf,
  ctrChangePct,
  ctrOf,
  dayIn,
  dayRange,
  holdRateOf,
  hookRateOf,
  inRange,
  monthElapsedPct,
  monthStart,
  placementLabel,
  RESULT_LABELS,
  roasOf,
  sumDays,
  weightedFrequency,
  type DayStats,
} from './metrics.js';
import {
  ACTION_ORDER,
  estimateImpact,
  type Evaluation,
  type EvalMetrics,
  type RuleObject,
} from './rules.js';

/** Days of daily rows the loader reads: a month for pacing plus the 14-day window. */
export const DASHBOARD_HISTORY_DAYS = 32;
const SHOWN_CREATIVES = 24;
const SHOWN_ORGANIC = 5;
const ORGANIC_WINDOW_DAYS = 30;
const DONE_VISIBLE_SEC = 24 * 3600;

export function accountDto(a: FbAdAccountRow): AdAccountDto {
  return {
    id: a.id,
    name: a.name,
    currency: a.currency,
    enabled: a.enabled === 1,
    resultType: accountResultType(a),
    targetCpa: a.target_cpa,
    monthlyBudget: a.monthly_budget,
    status: (['ACTIVE', 'EXPIRED', 'MISSING', 'UNKNOWN'].includes(a.status) ? a.status : 'UNKNOWN') as ConnStatus,
    syncedAt: a.synced_at,
  };
}

export interface DashboardInput {
  account: FbAdAccountRow;
  connection: ConnStatus;
  days: number;
  nowSec: number;
  daily: FbAdsDailyRow[];
  placements: FbAdsPlacementRow[];
  recs: FbAdsRecommendationRow[];
  organic: FbAdsOrganicRow[];
}

const FORMATS: ReadonlySet<string> = new Set(['reel', 'video', 'photo', 'album', 'text', 'link']);

const rate = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10);

function safeJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** Story ids look like `<pageId>_<postId>`; compare on the post part so either spelling matches. */
const storyPart = (id: string): string => id.slice(id.lastIndexOf('_') + 1);

function recDto(r: FbAdsRecommendationRow): AdsRecommendationDto {
  return {
    id: r.id,
    level: r.level as AdsRecommendationDto['level'],
    objectId: r.object_id,
    objectName: r.object_name,
    action: r.action as AdsAction,
    rule: r.rule,
    reason: r.reason,
    state: r.state as AdsRecommendationDto['state'],
  };
}

function adLabel(ev: Evaluation | undefined): { action: AdsAction; reason: string } | null {
  return ev ? { action: ev.action, reason: ev.reason } : null;
}

/** 87 412 → 87 000 (two significant digits). */
function roundSignificant(n: number, digits: number): number {
  if (!(n > 0)) return n;
  const p = 10 ** (Math.floor(Math.log10(n)) - digits + 1);
  return Math.round(n / p) * p;
}

/** Meta creative object_type → the short format word the cards show. */
function creativeFormat(objectType: string | undefined): string {
  switch ((objectType ?? '').toUpperCase()) {
    case 'VIDEO': return 'video';
    case 'PHOTO': return 'ảnh';
    case 'SHARE': return 'link';
    case 'STATUS': return 'bài viết';
    case 'INVALID': return '';
    default: return objectType ? objectType.toLowerCase() : '';
  }
}

function totalsFor(days: readonly DayStats[], from: string, to: string) {
  return sumDays(inRange(days, from, to));
}

export function buildAdsDashboard(input: DashboardInput): AdsDashboardDto {
  const { account, nowSec } = input;
  const days = Math.min(28, Math.max(1, Math.round(input.days)));
  const resultType = accountResultType(account);
  const label = RESULT_LABELS[resultType];
  const evaluated: EvaluatedAccount = evaluateAccountRows(account, input.daily, input.recs, nowSec);
  const { today } = evaluated;
  const evalByKey = new Map(evaluated.evaluations.map((e) => [`${e.level}:${e.objectId}`, e]));
  const objectByKey = new Map(evaluated.objects.map((o) => [`${o.level}:${o.id}`, o]));

  // ── Account-level totals ──
  const accountDays = input.daily.filter((r) => r.level === 'account').map(dayStatsOf).sort((a, b) => a.day.localeCompare(b.day));
  const curFrom = addDays(today, -(days - 1));
  const prevTo = addDays(curFrom, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  const cur = totalsFor(accountDays, curFrom, today);
  // Snapshots read 28 days of daily rows and Meta omits days without delivery, so once an account has been
  // pulled, a 7- or 14-day previous window with no rows means it did not run (zero), not that data is missing.
  const hasPrev = days * 2 <= 28 && (inRange(accountDays, prevFrom, prevTo).length > 0 || (account.synced_at !== null && accountDays.length > 0));
  const prev = hasPrev ? totalsFor(accountDays, prevFrom, prevTo) : null;

  const monthSpend = totalsFor(accountDays, monthStart(today), today).spend;
  const pacing = account.monthly_budget && account.monthly_budget > 0
    ? { spentPct: (monthSpend / account.monthly_budget) * 100, elapsedPct: monthElapsedPct(today) }
    : null;

  const kpis: AdsDashboardDto['kpis'] = {
    spend: cur.spend,
    spendPrev: prev ? prev.spend : null,
    results: cur.results,
    resultsPrev: prev ? prev.results : null,
    cpa: cpaOf(cur),
    cpaPrev: prev ? cpaOf(prev) : null,
    purchases: cur.purchases > 0 ? cur.purchases : null,
    roas: roasOf(cur),
    ctr: ctrOf(cur),
    ctrPrev: prev ? ctrOf(prev) : null,
    cpm: cpmOf(cur),
    cpmPrev: prev ? cpmOf(prev) : null,
    pacing,
    spendToday: totalsFor(accountDays, today, today).spend,
    spendMonth: monthSpend,
  };

  // A first target to offer when none is set: the last 14 days' cost per result, rounded to two significant digits.
  const last14 = totalsFor(accountDays, addDays(today, -13), today);
  const cpa14 = cpaOf(last14);
  const suggestedTargetCpa = account.target_cpa === null && cpa14 !== null && last14.results >= 5 ? roundSignificant(cpa14, 2) : null;

  const byDay = new Map(accountDays.map((d) => [d.day, d]));
  const daily = dayRange(today, 14).map((day) => {
    const d = byDay.get(day);
    return { day, spend: d?.spend ?? 0, cpa: d ? cpaOf(d) : null };
  });

  // ── Queue ──
  const visibleRecs = input.recs.filter((r) =>
    r.state === 'open'
    || (r.state === 'snoozed' && (r.snoozed_until ?? 0) > nowSec)
    || (r.state === 'done' && nowSec - r.updated_at < DONE_VISIBLE_SEC));
  const queue = visibleRecs
    // Open items first; acted-on ones (done / snoozed) follow, dimmed by the UI.
    .sort((a, b) => Number(a.state !== 'open') - Number(b.state !== 'open')
      || (ACTION_ORDER[a.action as AdsAction] ?? 9) - (ACTION_ORDER[b.action as AdsAction] ?? 9) || a.id - b.id)
    .map(recDto);

  const openMetrics = input.recs
    .filter((r) => r.state === 'open')
    .map((r) => ({ action: r.action, metrics: safeJson<Partial<EvalMetrics>>(r.metrics_json, {}) }));
  const impact = estimateImpact(openMetrics, account.target_cpa);

  // ── Tree ──
  const windowStats = (o: RuleObject) => totalsFor(o.days, curFrom, today);
  const isShown = (o: RuleObject) => windowStats(o).spend > 0 || o.status.toUpperCase() === 'ACTIVE';
  const campaigns = evaluated.objects.filter((o) => o.level === 'campaign' && isShown(o))
    .sort((a, b) => windowStats(b).spend - windowStats(a).spend);
  const shownCampaignIds = new Set(campaigns.map((c) => c.id));
  const treeRow = (o: RuleObject): AdsDashboardDto['tree'][number] => {
    const t = windowStats(o);
    const learning = o.level === 'adset' && o.learning.toUpperCase() === 'LEARNING' && o.status.toUpperCase() !== 'PAUSED';
    return {
      level: o.level as 'campaign' | 'adset',
      id: o.id,
      parentId: o.level === 'adset' && shownCampaignIds.has(o.parentId) ? o.parentId : null,
      name: o.name,
      status: learning ? 'LEARNING' : o.status,
      dailyBudget: o.dailyBudget,
      spend: t.spend,
      spendToday: totalsFor(o.days, today, today).spend,
      results: t.results,
      cpa: cpaOf(t),
      ctr: ctrOf(t),
      cpm: cpmOf(t),
      frequency: o.windowFrequency ?? weightedFrequency(inRange(o.days, curFrom, today)),
      recommendation: adLabel(evalByKey.get(`${o.level}:${o.id}`)),
    };
  };
  const adsetsByCampaign = new Map<string, RuleObject[]>();
  for (const o of evaluated.objects) {
    if (o.level !== 'adset' || !isShown(o)) continue;
    (adsetsByCampaign.get(o.parentId) ?? adsetsByCampaign.set(o.parentId, []).get(o.parentId)!).push(o);
  }
  const tree: AdsDashboardDto['tree'] = [];
  for (const c of campaigns) {
    tree.push(treeRow(c));
    for (const a of (adsetsByCampaign.get(c.id) ?? []).sort((x, y) => windowStats(y).spend - windowStats(x).spend)) tree.push(treeRow(a));
  }
  for (const [parent, sets] of adsetsByCampaign) {
    if (shownCampaignIds.has(parent)) continue;
    for (const a of sets.sort((x, y) => windowStats(y).spend - windowStats(x).spend)) tree.push(treeRow(a));
  }

  // ── Funnel ──
  const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : null);
  const ctr = ctrOf(cur);
  const lpRate = pct(cur.lpViews, cur.linkClicks);
  const convRate = pct(cur.results, cur.lpViews);
  const toSale = pct(cur.purchases, cur.results);
  // The single weakest step against its "good" threshold is called out; the UI highlights on "chỗ rò lớn nhất".
  const steps = [
    { key: 'link_clicks', value: ctr, good: 1.2 },
    { key: 'lp_views', value: lpRate, good: 70 },
    { key: 'results', value: convRate, good: 8 },
  ].filter((x): x is { key: string; value: number; good: number } => x.value !== null && x.value < x.good)
    .sort((a, b) => a.value / a.good - b.value / b.good);
  const leak = steps[0]?.key;
  const leakTag = (key: string) => (leak === key ? ': chỗ rò lớn nhất' : '');
  const funnel: AdsDashboardDto['funnel'] = [
    { key: 'impressions', label: 'Hiển thị', value: cur.impressions || null, note: 'Mốc gốc' },
    {
      key: 'link_clicks', label: 'Click link', value: cur.linkClicks || null,
      note: ctr === null ? 'Chưa có dữ liệu' : `CTR ${fmtPct(ctr, 2)} · ngưỡng tốt ≥ 1,2%${leakTag('link_clicks')}`,
    },
    {
      key: 'lp_views', label: 'Xem trang đích', value: cur.lpViews || null,
      note: lpRate === null ? 'Chưa ghi nhận lượt xem trang đích (cần pixel)' : `${fmtNum(lpRate, 0)}% click tải xong trang · ngưỡng tốt ≥ 70%${leakTag('lp_views')}`,
    },
    {
      key: 'results', label: label.funnel, value: cur.results || null,
      note: convRate === null ? `${label.funnel} trên toàn tài khoản` : `${fmtNum(convRate)}% người xem trang để lại ${label.unit} · ngưỡng tốt ≥ 8%${leakTag('results')}`,
    },
  ];
  if (resultType !== 'purchase') {
    funnel.push({
      key: 'purchases', label: 'Đơn hàng', value: cur.purchases || null,
      note: toSale === null ? 'Chưa ghi nhận đơn từ quảng cáo' : `${fmtNum(toSale)}% ${label.unit} thành đơn`,
    });
  }

  // ── Creatives ──
  const campaignOfAdset = (adsetId: string): { name: string } => {
    const adset = objectByKey.get(`adset:${adsetId}`);
    const campaign = adset ? objectByKey.get(`campaign:${adset.parentId}`) : undefined;
    return { name: campaign?.name ?? '' };
  };
  const creatives = evaluated.objects
    .filter((o) => o.level === 'ad' && windowStats(o).spend > 0)
    .sort((a, b) => windowStats(b).spend - windowStats(a).spend)
    .slice(0, SHOWN_CREATIVES)
    .map((o): AdsDashboardDto['creatives'][number] => {
      const t = windowStats(o);
      const creative = safeJson<{ format?: string; objectType?: string; thumbnailUrl?: string }>(
        input.daily.find((r) => r.level === 'ad' && r.object_id === o.id && r.creative_json !== '{}')?.creative_json ?? '{}', {});
      return {
        adId: o.id,
        name: o.name,
        format: creative.format ?? creativeFormat(creative.objectType),
        status: o.status,
        thumbnailUrl: typeof creative.thumbnailUrl === 'string' && /^https:\/\//.test(creative.thumbnailUrl) ? creative.thumbnailUrl : null,
        spend: t.spend,
        results: t.results,
        campaignName: campaignOfAdset(o.parentId).name,
        hookRate: rate(hookRateOf(t)),
        holdRate: rate(holdRateOf(t)),
        ctr: ctrOf(t),
        ctrChangePct: rate(ctrChangePct(o.days)),
        cpa: cpaOf(t),
        frequency: o.windowFrequency ?? weightedFrequency(inRange(o.days, curFrom, today)),
        recommendation: adLabel(evalByKey.get(`ad:${o.id}`)),
      };
    });

  // ── Placements (stored for 7 days) ──
  const placeFrom = addDays(today, -(Math.min(days, 7) - 1));
  const placeTotals = new Map<string, { spend: number; results: number }>();
  for (const p of input.placements) {
    if (p.day < placeFrom || p.day > today) continue;
    const key = placementLabel(p.placement);
    const t = placeTotals.get(key) ?? { spend: 0, results: 0 };
    t.spend += p.spend;
    t.results += p.results;
    placeTotals.set(key, t);
  }
  const placeSpend = [...placeTotals.values()].reduce((s, t) => s + t.spend, 0);
  const placements = [...placeTotals.entries()]
    .map(([placement, t]) => ({
      placement,
      spend: t.spend,
      results: t.results,
      cpa: t.results > 0 ? t.spend / t.results : null,
      spendShare: placeSpend > 0 ? (t.spend / placeSpend) * 100 : 0,
    }))
    .filter((p) => p.spend > 0)
    .sort((a, b) => b.spend - a.spend);

  // ── Organic posts worth promoting ──
  const adStories = new Set<string>();
  for (const r of input.daily) {
    if (r.level !== 'ad' || r.creative_json === '{}') continue;
    const story = safeJson<{ storyId?: string }>(r.creative_json, {}).storyId;
    if (story) adStories.add(storyPart(story));
  }
  const organicCandidates = input.organic
    .filter((p) => p.reach && p.reach > 0 && !adStories.has(storyPart(p.post_id)))
    .map((p) => ({
      postId: p.post_id,
      pageName: p.page_name,
      title: p.title || p.caption.replace(/\s+/g, ' ').trim().slice(0, 80),
      format: (FORMATS.has(p.format) ? p.format : 'text') as FbFormat,
      er: ((p.reactions ?? 0) + (p.comments ?? 0) + (p.shares ?? 0)) / (p.reach as number) * 100,
      shares: p.shares,
    }))
    .sort((a, b) => b.er - a.er)
    .slice(0, SHOWN_ORGANIC);

  return {
    account: accountDto({ ...account, status: input.connection }),
    connection: input.connection,
    days,
    range: { from: curFrom, to: today },
    suggestedTargetCpa,
    lastSnapshotAt: account.synced_at,
    queue,
    impact,
    kpis,
    daily,
    tree,
    funnel,
    creatives,
    placements,
    organicCandidates,
  };
}

/** Reads SQLite and builds the dashboard for one account. */
export function loadAdsDashboard(account: FbAdAccountRow, connection: ConnStatus, days: number, nowSec: number, organic: FbAdsOrganicRow[] = []): AdsDashboardDto {
  const today = dayIn(accountTimezone(account), nowSec);
  const sinceDay = addDays(today, -(DASHBOARD_HISTORY_DAYS - 1));
  return buildAdsDashboard({
    account,
    connection,
    days,
    nowSec,
    daily: listFbAdsDaily(account.id, sinceDay),
    placements: listFbAdsPlacements(account.id, addDays(today, -6)),
    recs: listFbAdsRecommendations(account.id, ['open', 'snoozed', 'done']),
    organic,
  });
}
