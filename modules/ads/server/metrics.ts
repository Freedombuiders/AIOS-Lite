/**
 * Pure Meta Ads math: response parsing (zod), result-type mapping, window
 * aggregation and the derived rates the dashboard shows. No I/O, no DB, no
 * Composio — everything here is unit tested without mocks.
 *
 * Percentages are 0–100 numbers (4.3 = 4,3%), money is in the ad account
 * currency (major units), a value Meta did not return is null.
 */

import { z } from 'zod';

import type { AdsResultType } from '../../_lib/fb-types.js';

export type AdsLevel = 'account' | 'campaign' | 'adset' | 'ad';

// ── Result type mapping ───────────────────────────────────────────────

/**
 * Meta reports the same conversion under several action types: `lead` is the
 * on-Facebook + pixel total, `onsite_conversion.lead_grouped` and
 * `offsite_conversion.fb_pixel_lead` are its parts. Summing all of them would
 * double count, so the aggregate wins and the parts are only a fallback.
 */
export const RESULT_ACTIONS: Record<AdsResultType, { aggregate: string; parts: readonly string[] }> = {
  lead: { aggregate: 'lead', parts: ['onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'] },
  message: { aggregate: 'onsite_conversion.messaging_conversation_started_7d', parts: [] },
  purchase: { aggregate: 'purchase', parts: ['offsite_conversion.fb_pixel_purchase'] },
  registration: { aggregate: 'complete_registration', parts: [] },
};

export const RESULT_TYPES = Object.keys(RESULT_ACTIONS) as AdsResultType[];

export interface MetaAction { action_type: string; value?: string | number | null }

function actionNumber(actions: MetaAction[] | null | undefined, type: string): number | null {
  const found = actions?.find((a) => a.action_type === type);
  if (!found) return null;
  const n = Number(found.value);
  return Number.isFinite(n) ? n : null;
}

/** Results for one result type out of an `actions` array. */
export function resultsFromActions(actions: MetaAction[] | null | undefined, type: AdsResultType): number {
  const map = RESULT_ACTIONS[type];
  const aggregate = actionNumber(actions, map.aggregate);
  if (aggregate !== null) return aggregate;
  let sum = 0;
  for (const part of map.parts) sum += actionNumber(actions, part) ?? 0;
  return sum;
}

/** Results for every result type, stored in raw_json so a changed result type needs no new API call. */
export function resultsByType(actions: MetaAction[] | null | undefined): Record<AdsResultType, number> {
  return {
    lead: resultsFromActions(actions, 'lead'),
    message: resultsFromActions(actions, 'message'),
    purchase: resultsFromActions(actions, 'purchase'),
    registration: resultsFromActions(actions, 'registration'),
  };
}

/** Reads the result count for `type` back out of a stored raw_json ({ r: {...} }). */
export function resultsFromRaw(rawJson: string, type: AdsResultType): number {
  try {
    const parsed = JSON.parse(rawJson) as { r?: Partial<Record<AdsResultType, number>> };
    const n = parsed.r?.[type];
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function isResultType(v: unknown): v is AdsResultType {
  return typeof v === 'string' && (RESULT_TYPES as string[]).includes(v);
}

/** Vietnamese labels: CPA name and the unit of one result. */
export const RESULT_LABELS: Record<AdsResultType, { cpa: string; unit: string; funnel: string }> = {
  lead: { cpa: 'CPL', unit: 'lead', funnel: 'Lead' },
  message: { cpa: 'CP/tin nhắn', unit: 'tin nhắn', funnel: 'Tin nhắn' },
  purchase: { cpa: 'CPA', unit: 'đơn', funnel: 'Đơn hàng' },
  registration: { cpa: 'CPA', unit: 'đăng ký', funnel: 'Đăng ký' },
};

// ── Meta response parsing ─────────────────────────────────────────────

const numLike = z.union([z.string(), z.number()]).nullish();
const ActionSchema = z.object({ action_type: z.string(), value: numLike });
const ActionsSchema = z.array(ActionSchema).nullish();

export const InsightsRowSchema = z.object({
  date_start: z.string().optional(),
  date_stop: z.string().optional(),
  account_id: z.string().optional(),
  campaign_id: z.string().optional(),
  campaign_name: z.string().optional(),
  adset_id: z.string().optional(),
  adset_name: z.string().optional(),
  ad_id: z.string().optional(),
  ad_name: z.string().optional(),
  spend: numLike,
  impressions: numLike,
  reach: numLike,
  frequency: numLike,
  clicks: numLike,
  inline_link_clicks: numLike,
  actions: ActionsSchema,
  action_values: ActionsSchema,
  video_thruplay_watched_actions: ActionsSchema,
  publisher_platform: z.string().optional(),
  platform_position: z.string().optional(),
});
export type InsightsRow = z.infer<typeof InsightsRowSchema>;

export function toNum(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toNumOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface ExtractedPage {
  rows: unknown[];
  /** Cursor for the next page, or null when this was the last one. */
  after: string | null;
}

const ROW_KEYS = ['data', 'ads', 'adsets', 'campaigns', 'accounts', 'ad_accounts', 'items', 'results', 'insights'];

/**
 * Composio wraps Graph responses in an unpredictable number of `data` layers
 * (often `data.data`). Walks down to the first array of rows and picks up the
 * paging cursor on the way. A cursor only counts when Meta says there is a
 * next page (`paging.next`), or the page came back full.
 */
export function extractRows(raw: unknown, pageSize?: number): ExtractedPage {
  let node: unknown = raw;
  let paging: { next?: unknown; cursors?: { after?: unknown } } | undefined;
  for (let depth = 0; depth < 5 && node && typeof node === 'object'; depth++) {
    if (Array.isArray(node)) break;
    const obj = node as Record<string, unknown>;
    if (obj.paging && typeof obj.paging === 'object') paging = obj.paging as typeof paging;
    const key = ROW_KEYS.find((k) => Array.isArray(obj[k]));
    if (key) { node = obj[key]; break; }
    const nested = ROW_KEYS.find((k) => obj[k] && typeof obj[k] === 'object');
    if (!nested) { node = undefined; break; }
    node = obj[nested];
  }
  const rows = Array.isArray(node) ? node : [];
  const cursor = typeof paging?.cursors?.after === 'string' ? paging.cursors.after : null;
  const more = Boolean(paging?.next) || (paging?.next === undefined && pageSize !== undefined && rows.length >= pageSize);
  return { rows, after: cursor && more ? cursor : null };
}

export interface DailyMetrics {
  spend: number;
  impressions: number;
  reach: number | null;
  frequency: number | null;
  clicks: number;
  linkClicks: number;
  lpViews: number;
  results: number;
  purchases: number;
  revenue: number;
  video3s: number;
  thruplays: number;
  byType: Record<AdsResultType, number>;
}

/** Metrics of one insights row for the account's result type. */
export function metricsFromInsights(row: InsightsRow, resultType: AdsResultType): DailyMetrics {
  const byType = resultsByType(row.actions);
  const linkClicks = row.inline_link_clicks != null ? toNum(row.inline_link_clicks) : (actionNumber(row.actions, 'link_click') ?? 0);
  const thruplays = actionNumber(row.video_thruplay_watched_actions, 'video_view')
    ?? row.video_thruplay_watched_actions?.reduce((s, a) => s + toNum(a.value), 0) ?? 0;
  return {
    spend: toNum(row.spend),
    impressions: Math.round(toNum(row.impressions)),
    reach: toNumOrNull(row.reach) === null ? null : Math.round(toNum(row.reach)),
    frequency: toNumOrNull(row.frequency),
    clicks: Math.round(toNum(row.clicks)),
    linkClicks: Math.round(linkClicks),
    lpViews: Math.round(actionNumber(row.actions, 'landing_page_view') ?? 0),
    results: Math.round(byType[resultType]),
    purchases: Math.round(byType.purchase),
    revenue: actionNumber(row.action_values, RESULT_ACTIONS.purchase.aggregate)
      ?? actionNumber(row.action_values, 'offsite_conversion.fb_pixel_purchase') ?? 0,
    // `video_view` in `actions` is Meta's 3-second video play.
    video3s: Math.round(actionNumber(row.actions, 'video_view') ?? 0),
    thruplays: Math.round(thruplays),
    byType,
  };
}

// ── Placements ────────────────────────────────────────────────────────

const PLATFORM_LABEL: Record<string, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  messenger: 'Messenger',
  threads: 'Threads',
  whatsapp: 'WhatsApp',
};

const POSITION_LABEL: Record<string, string> = {
  feed: 'Bảng tin',
  facebook_reels: 'Reels',
  instagram_reels: 'Reels',
  reels: 'Reels',
  reels_overlay: 'Reels',
  facebook_reels_overlay: 'Reels',
  story: 'Stories',
  facebook_stories: 'Stories',
  instagram_stories: 'Stories',
  video_feeds: 'Video',
  instream_video: 'Video chèn',
  marketplace: 'Marketplace',
  right_hand_column: 'Cột phải',
  search: 'Tìm kiếm',
  instagram_search: 'Tìm kiếm',
  instagram_explore: 'Khám phá',
  instagram_explore_grid_home: 'Khám phá',
  profile_feed: 'Trang cá nhân',
  instagram_profile_feed: 'Trang cá nhân',
  facebook_profile_feed: 'Trang cá nhân',
  messenger_inbox: 'Hộp thư',
  messenger_stories: 'Stories',
};

export function placementKey(platform: string | undefined, position: string | undefined): string {
  return `${platform || 'unknown'}|${position || 'unknown'}`;
}

/** 'facebook|facebook_reels' → 'Facebook Reels'; Audience Network collapses to one entry. */
export function placementLabel(key: string): string {
  const [platform = '', position = ''] = key.split('|');
  if (platform === 'audience_network') return 'Audience Network';
  const p = PLATFORM_LABEL[platform] ?? (platform && platform !== 'unknown' ? platform : '');
  const pos = POSITION_LABEL[position] ?? (position && position !== 'unknown' ? position.replace(/_/g, ' ') : '');
  return [p, pos].filter(Boolean).join(' ') || 'Khác';
}

// ── Currency ──────────────────────────────────────────────────────────

/** Currencies without minor units: Meta budgets for these are already whole units. */
const ZERO_DECIMAL = new Set([
  'VND', 'JPY', 'KRW', 'CLP', 'ISK', 'PYG', 'UGX', 'RWF', 'XAF', 'XOF', 'XPF', 'VUV', 'KMF', 'DJF', 'GNF', 'BIF',
]);

/** Meta returns budgets in minor units (cents); VND and other zero-decimal currencies are whole units. */
export function budgetFromMinorUnits(value: string | number | null | undefined, currency: string): number | null {
  const n = toNumOrNull(value);
  if (n === null || n <= 0) return null;
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? n : n / 100;
}

// ── Dates ─────────────────────────────────────────────────────────────

/** YYYY-MM-DD of `epochSec` in `timeZone` (UTC when the zone is unknown). */
export function dayIn(timeZone: string | null | undefined, epochSec: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(epochSec * 1000));
  } catch {
    return new Date(epochSec * 1000).toISOString().slice(0, 10);
  }
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** `count` consecutive days ending at `endDay`, oldest first. */
export function dayRange(endDay: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(endDay, i - count + 1));
}

export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** Share of the month elapsed at the end of `day`, 0–100. */
export function monthElapsedPct(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return (d / daysInMonth) * 100;
}

// ── Aggregation ───────────────────────────────────────────────────────

export interface DayStats {
  day: string;
  spend: number;
  impressions: number;
  reach: number | null;
  frequency: number | null;
  clicks: number;
  linkClicks: number;
  lpViews: number;
  results: number;
  purchases: number;
  revenue: number;
  video3s: number;
  thruplays: number;
}

export interface Totals {
  spend: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  lpViews: number;
  results: number;
  purchases: number;
  revenue: number;
  video3s: number;
  thruplays: number;
}

export function emptyTotals(): Totals {
  return { spend: 0, impressions: 0, clicks: 0, linkClicks: 0, lpViews: 0, results: 0, purchases: 0, revenue: 0, video3s: 0, thruplays: 0 };
}

export function sumDays(days: readonly DayStats[]): Totals {
  const t = emptyTotals();
  for (const d of days) {
    t.spend += d.spend;
    t.impressions += d.impressions;
    t.clicks += d.clicks;
    t.linkClicks += d.linkClicks;
    t.lpViews += d.lpViews;
    t.results += d.results;
    t.purchases += d.purchases;
    t.revenue += d.revenue;
    t.video3s += d.video3s;
    t.thruplays += d.thruplays;
  }
  return t;
}

/** Days with `from <= day <= to`. */
export function inRange<T extends { day: string }>(days: readonly T[], from: string, to: string): T[] {
  return days.filter((d) => d.day >= from && d.day <= to);
}

export const cpaOf = (t: Pick<Totals, 'spend' | 'results'>): number | null => (t.results > 0 ? t.spend / t.results : null);
export const ctrOf = (t: Pick<Totals, 'linkClicks' | 'impressions'>): number | null => (t.impressions > 0 ? (t.linkClicks / t.impressions) * 100 : null);
export const cpmOf = (t: Pick<Totals, 'spend' | 'impressions'>): number | null => (t.impressions > 0 ? (t.spend / t.impressions) * 1000 : null);
export const roasOf = (t: Pick<Totals, 'spend' | 'revenue'>): number | null => (t.spend > 0 && t.revenue > 0 ? t.revenue / t.spend : null);
/** Hook rate: 3-second views ÷ impressions. */
export const hookRateOf = (t: Pick<Totals, 'video3s' | 'impressions'>): number | null =>
  t.video3s > 0 && t.impressions > 0 ? (t.video3s / t.impressions) * 100 : null;
/** Hold rate: thruplays ÷ 3-second views. */
export const holdRateOf = (t: Pick<Totals, 'thruplays' | 'video3s'>): number | null =>
  t.video3s > 0 ? (t.thruplays / t.video3s) * 100 : null;

/** Impression-weighted mean of the daily frequency; a lower bound for the true window frequency. */
export function weightedFrequency(days: readonly DayStats[]): number | null {
  let imps = 0;
  let weighted = 0;
  for (const d of days) {
    if (d.frequency === null || d.impressions <= 0) continue;
    imps += d.impressions;
    weighted += d.frequency * d.impressions;
  }
  return imps > 0 ? weighted / imps : null;
}

const CTR_MIN_IMPRESSIONS = 1000;

/**
 * CTR change (percent) of the last 3 delivery days vs the first 3 delivery
 * days of the data. Needs 6 days with delivery (no overlap) and enough
 * impressions on both sides, otherwise null.
 */
export function ctrChangePct(days: readonly DayStats[]): number | null {
  const delivered = days.filter((d) => d.impressions > 0).sort((a, b) => a.day.localeCompare(b.day));
  if (delivered.length < 6) return null;
  const first = sumDays(delivered.slice(0, 3));
  const last = sumDays(delivered.slice(-3));
  if (first.impressions < CTR_MIN_IMPRESSIONS || last.impressions < CTR_MIN_IMPRESSIONS) return null;
  const a = ctrOf(first);
  const b = ctrOf(last);
  if (a === null || b === null || a <= 0) return null;
  return ((b - a) / a) * 100;
}
