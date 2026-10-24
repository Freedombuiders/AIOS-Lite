/**
 * The all-accounts overview: every ad account any ACTIVE `metaads`
 * connection can see, with daily spend and results for two windows. One
 * paged `/me/adaccounts` read per connection, then one account-level daily
 * insights read per account (a few at a time). Insights cannot ride along as
 * a field expansion of the listing: Meta then answers `spend` and
 * `impressions` as "0" while still counting clicks and actions. Read-only
 * towards Meta; the listing also keeps fb_ad_accounts in step, like
 * "Đồng bộ tài khoản".
 *
 * The builder is pure (rows in, DTO out); the loader at the bottom calls Meta
 * and caches the result for a few minutes.
 */

import { listFbAdAccounts, type FbAdAccountRow } from './store.js';
import { logger } from '../../../src/modules/compat/logger.js';
import { ComposioConnectionExpiredError } from '../../_lib/composio.js';
import type { AdsOverviewAccountDto, AdsOverviewDto, AdsResultType, ConnStatus } from '../../_lib/fb-types.js';
import { getMetaadsConnections, LIST_AD_ACCOUNTS_TOOL, normalizeActId, recordListedAccount } from './accounts.js';
import { metaRead } from './graph-tools.js';
import {
  addDays,
  budgetFromMinorUnits,
  dayIn,
  dayRange,
  extractRows,
  InsightsRowSchema,
  isResultType,
  metricsFromInsights,
  monthStart,
  RESULT_TYPES,
  type DailyMetrics,
} from './metrics.js';
import { DEFAULT_TIMEZONE } from './model.js';
import { z } from 'zod';

export const OVERVIEW_WINDOWS = [7, 14, 28] as const;
const CACHE_TTL_SEC = 10 * 60;
const MIN_FRESH_GAP_SEC = 60;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export const INSIGHT_FIELDS = 'date_start,spend,impressions,clicks,inline_link_clicks,actions,action_values';
export const ACCOUNT_FIELDS = 'id,account_id,name,currency,timezone_name,account_status,disable_reason,amount_spent,balance,spend_cap,business{id,name}';
/** Insights reads in flight at once. */
const INSIGHTS_CONCURRENCY = 4;

const numLike = z.union([z.string(), z.number()]).nullish();
const OverviewRowSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  account_id: z.union([z.string(), z.number()]).optional(),
  name: z.string().nullish(),
  currency: z.string().nullish(),
  timezone_name: z.string().nullish(),
  account_status: numLike,
  disable_reason: numLike,
  amount_spent: numLike,
  balance: numLike,
  spend_cap: numLike,
  business: z.object({ id: z.union([z.string(), z.number()]), name: z.string().nullish() }).nullish(),
  insights: z.object({ data: z.array(z.unknown()) }).nullish(),
});

export interface OverviewRaw {
  /** One `/me/adaccounts` row as Meta sent it. */
  row: unknown;
}

export interface OverviewInput {
  window: number;
  /** Today in the reference time zone; the window ends today (same as the account screen). */
  today: string;
  fetchedAt: number;
  connection: ConnStatus;
  rows: OverviewRaw[];
  stored: FbAdAccountRow[];
  warnings: string[];
}

const intOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
};

interface Sum { spend: number; impressions: number; linkClicks: number; results: number; purchases: number; revenue: number; byType: Record<AdsResultType, number> }
const zero = (): Sum => ({ spend: 0, impressions: 0, linkClicks: 0, results: 0, purchases: 0, revenue: 0, byType: { lead: 0, message: 0, purchase: 0, registration: 0 } });

function add(sum: Sum, m: DailyMetrics): void {
  sum.spend += m.spend;
  sum.impressions += m.impressions;
  sum.linkClicks += m.linkClicks;
  sum.purchases += m.purchases;
  sum.revenue += m.revenue;
  for (const t of RESULT_TYPES) sum.byType[t] += m.byType[t];
}

/** The owner's result type when they set one, otherwise the type the account produced most of. */
function pickResultType(stored: FbAdAccountRow | undefined, observed: Record<AdsResultType, number>): { type: AdsResultType; guessed: boolean } {
  if (stored && (stored.enabled === 1 || stored.result_type !== 'lead') && isResultType(stored.result_type)) {
    return { type: stored.result_type, guessed: false };
  }
  let best: AdsResultType = isResultType(stored?.result_type) ? stored.result_type : 'lead';
  let max = 0;
  for (const t of RESULT_TYPES) if (observed[t] > max) { max = observed[t]; best = t; }
  return { type: best, guessed: true };
}

const ratio = (a: number, b: number, k = 1): number | null => (b > 0 ? (a / b) * k : null);

/** Builds the overview DTO. Pure; exported for tests. */
export function buildOverview(input: OverviewInput): AdsOverviewDto {
  const { window } = input;
  const end = input.today;
  const days = dayRange(end, window);
  const monthFrom = monthStart(end);
  const prevDays = dayRange(addDays(end, -window), window);
  const curSet = new Set(days);
  const prevSet = new Set(prevDays);
  const stored = new Map(input.stored.map((a) => [a.id, a]));

  const accounts: AdsOverviewAccountDto[] = [];
  const seen = new Set<string>();
  /** Previous-window reach inputs, kept out of the DTO (only the totals compare them). */
  const prevImpr = new Map<string, { impressions: number; linkClicks: number }>();
  for (const { row } of input.rows) {
    const parsed = OverviewRowSchema.safeParse(row);
    if (!parsed.success) continue;
    const p = parsed.data;
    const idRaw = p.id ?? p.account_id;
    if (idRaw === undefined) continue;
    const id = normalizeActId(idRaw);
    if (seen.has(id)) continue;
    seen.add(id);
    const db = stored.get(id);
    const currency = (p.currency || db?.currency || 'VND').toUpperCase();

    const daily = new Map<string, DailyMetrics>();
    for (const raw of p.insights?.data ?? []) {
      const ins = InsightsRowSchema.safeParse(raw);
      if (!ins.success || !ins.data.date_start) continue;
      daily.set(ins.data.date_start.slice(0, 10), metricsFromInsights(ins.data, 'lead'));
    }
    const cur = zero();
    const prev = zero();
    let lastSpendDay: string | null = null;
    let spendMonth = 0;
    for (const [day, m] of daily) {
      if (day >= monthFrom && day <= end) spendMonth += m.spend;
      if (curSet.has(day)) add(cur, m);
      else if (prevSet.has(day)) add(prev, m);
      if (m.spend > 0 && (!lastSpendDay || day > lastSpendDay)) lastSpendDay = day;
    }
    const observed = { ...cur.byType };
    for (const t of RESULT_TYPES) observed[t] += prev.byType[t];
    const { type, guessed } = pickResultType(db, observed);
    cur.results = Math.round(cur.byType[type]);
    prev.results = Math.round(prev.byType[type]);
    prevImpr.set(id, { impressions: prev.impressions, linkClicks: prev.linkClicks });

    accounts.push({
      id,
      name: p.name || db?.name || id,
      currency,
      timezone: p.timezone_name || db?.timezone || '',
      business: p.business ? { id: String(p.business.id), name: p.business.name || String(p.business.id) } : null,
      accountStatus: intOrNull(p.account_status),
      disableReason: intOrNull(p.disable_reason),
      amountSpent: budgetFromMinorUnits(p.amount_spent ?? null, currency),
      balance: budgetFromMinorUnits(p.balance ?? null, currency),
      spendCap: (() => { const v = budgetFromMinorUnits(p.spend_cap ?? null, currency); return v && v > 0 ? v : null; })(),
      enabled: db?.enabled === 1,
      resultType: type,
      resultTypeGuessed: guessed,
      targetCpa: db?.target_cpa ?? null,
      spend: cur.spend, spendPrev: prev.spend,
      spendToday: daily.get(input.today)?.spend ?? 0,
      spendMonth,
      monthlyBudget: db?.monthly_budget ?? null,
      results: cur.results, resultsPrev: prev.results,
      cpa: ratio(cur.spend, cur.results), cpaPrev: ratio(prev.spend, prev.results),
      impressions: cur.impressions,
      linkClicks: cur.linkClicks,
      ctr: ratio(cur.linkClicks, cur.impressions, 100),
      ctrPrev: ratio(prev.linkClicks, prev.impressions, 100),
      cpm: ratio(cur.spend, cur.impressions, 1000),
      purchases: Math.round(cur.purchases),
      revenue: cur.revenue,
      roas: cur.spend > 0 && cur.revenue > 0 ? cur.revenue / cur.spend : null,
      spark: days.map((d) => daily.get(d)?.spend ?? 0),
      lastSpendDay,
    });
  }

  accounts.sort((a, b) => b.spend - a.spend || b.spendPrev - a.spendPrev || b.spendToday - a.spendToday || a.name.localeCompare(b.name));

  // Totals in the currency that carries the most spend; others are listed, not summed.
  const spendByCurrency = new Map<string, number>();
  for (const a of accounts) spendByCurrency.set(a.currency, (spendByCurrency.get(a.currency) ?? 0) + a.spend + a.spendPrev + 1e-9);
  const currency = [...spendByCurrency.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'VND';
  const inCur = accounts.filter((a) => a.currency === currency);

  const resultsByType: AdsOverviewDto['totals']['resultsByType'] = {};
  for (const a of inCur) {
    if (a.results === 0 && a.resultsPrev === 0) continue;
    const t = (resultsByType[a.resultType] ??= { results: 0, resultsPrev: 0, spend: 0, spendPrev: 0 });
    t.results += a.results; t.resultsPrev += a.resultsPrev; t.spend += a.spend; t.spendPrev += a.spendPrev;
  }
  const sum = (f: (a: AdsOverviewAccountDto) => number) => inCur.reduce((s, a) => s + f(a), 0);
  const businesses = new Map<string, { id: string; name: string; spend: number; spendPrev: number; accounts: number }>();
  for (const a of inCur) {
    const key = a.business?.id ?? '';
    const b = businesses.get(key) ?? { id: key, name: a.business?.name ?? 'Không thuộc business portfolio', spend: 0, spendPrev: 0, accounts: 0 };
    b.spend += a.spend; b.spendPrev += a.spendPrev; b.accounts += 1;
    businesses.set(key, b);
  }

  return {
    connection: input.connection,
    window,
    days,
    today: input.today,
    fetchedAt: input.fetchedAt,
    currency,
    otherCurrencies: [...spendByCurrency.keys()].filter((c) => c !== currency).sort(),
    totals: {
      spend: sum((a) => a.spend),
      spendPrev: sum((a) => a.spendPrev),
      spendToday: sum((a) => a.spendToday),
      spendMonth: sum((a) => a.spendMonth),
      impressions: sum((a) => a.impressions),
      impressionsPrev: inCur.reduce((s, a) => s + (prevImpr.get(a.id)?.impressions ?? 0), 0),
      linkClicks: sum((a) => a.linkClicks),
      linkClicksPrev: inCur.reduce((s, a) => s + (prevImpr.get(a.id)?.linkClicks ?? 0), 0),
      purchases: sum((a) => a.purchases),
      revenue: sum((a) => a.revenue),
      resultsByType,
      activeAccounts: accounts.filter((a) => a.accountStatus === 1).length,
      spendingAccounts: accounts.filter((a) => a.spend > 0).length,
    },
    daily: days.map((day, i) => {
      const byAccount: Record<string, number> = {};
      let total = 0;
      for (const a of inCur) {
        const v = a.spark[i] ?? 0;
        if (v > 0) { byAccount[a.id] = v; total += v; }
      }
      return { day, total, byAccount };
    }),
    businesses: [...businesses.values()].sort((x, y) => y.spend - x.spend || y.spendPrev - x.spendPrev),
    accounts,
    warnings: input.warnings,
  };
}

// ── Loader ────────────────────────────────────────────────────────────

const cache = new Map<number, { at: number; dto: AdsOverviewDto }>();
export function _resetAdsOverviewCache(): void { cache.clear(); }

/** Normalises a requested window to one of OVERVIEW_WINDOWS. */
export function overviewWindow(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '7', 10);
  return (OVERVIEW_WINDOWS as readonly number[]).includes(n) ? n : 7;
}

/**
 * Reads every account from Meta (one paged listing per ACTIVE connection),
 * stores new accounts, and builds the overview. Cached 10 minutes per window;
 * `fresh` skips the cache once a minute at most. Throws the typed Composio
 * errors only when no connection could be read at all.
 */
export async function loadAdsOverview(window: number, opts: { fresh?: boolean; nowSec?: number } = {}): Promise<AdsOverviewDto> {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const hit = cache.get(window);
  if (hit && (now - hit.at < (opts.fresh ? MIN_FRESH_GAP_SEC : CACHE_TTL_SEC))) return hit.dto;

  const { status, connections } = await getMetaadsConnections();
  const active = connections.filter((c) => c.status === 'ACTIVE');
  const today = dayIn(DEFAULT_TIMEZONE, now);
  // Both windows (today included) and the month so far.
  const windowsFrom = addDays(today, -(2 * window - 1));
  const since = monthStart(today) < windowsFrom ? monthStart(today) : windowsFrom;

  const rows: OverviewRaw[] = [];
  const warnings: string[] = [];
  const existing = new Map(listFbAdAccounts().map((a) => [a.id, a]));
  const pass = { existing, activeIds: new Set(active.map((c) => c.id)), seen: new Set<string>() };
  let lastError: unknown = null;
  let readAny = false;

  /** Rows still waiting for their insights, with the connection that listed them. */
  const pending: { row: Record<string, unknown>; target: { area: 'ads'; connectionId: string; entityId: string } }[] = [];
  for (const conn of active) {
    let after: string | undefined;
    const target = { area: 'ads' as const, connectionId: conn.id, entityId: conn.entityId };
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const raw = await metaRead(LIST_AD_ACCOUNTS_TOOL, { fields: ACCOUNT_FIELDS, limit: PAGE_SIZE, ...(after ? { after } : {}) }, target);
        const { rows: got, after: next } = extractRows(raw, PAGE_SIZE);
        for (const row of got) {
          if (recordListedAccount(row, conn, pass) && row && typeof row === 'object') pending.push({ row: row as Record<string, unknown>, target });
        }
        if (!next) break;
        after = next;
      }
      readAny = true;
    } catch (err) {
      lastError = err;
      const expired = err instanceof ComposioConnectionExpiredError;
      warnings.push(expired ? 'Một kết nối Meta Ads đã hết hạn nên có thể thiếu tài khoản của nó.' : 'Một kết nối Meta Ads chưa đọc được, số liệu có thể thiếu.');
      logger.warn({ err: (err as Error)?.name, message: String((err as Error)?.message ?? err).slice(0, 200), connection: conn.id }, 'fbstudio ads overview: listing failed');
    }
  }
  if (!readAny && lastError) throw lastError;

  // Daily account-level insights, a few accounts at a time. A failed account is listed without numbers.
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const item = pending[next++];
      try {
        const raw = await metaRead('METAADS_GET_INSIGHTS', {
          object_id: String(item.row.id ?? item.row.account_id),
          level: 'account',
          time_range: { since, until: today },
          time_increment: 1,
          fields: INSIGHT_FIELDS,
          limit: 100,
        }, item.target);
        item.row.insights = { data: extractRows(raw).rows };
      } catch (err) {
        failed++;
        lastError = err;
        logger.info({ err: (err as Error)?.name, account: item.row.id }, 'fbstudio ads overview: insights read failed');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(INSIGHTS_CONCURRENCY, pending.length) }, worker));
  if (failed && failed === pending.length && lastError) throw lastError;
  if (failed) warnings.push(`${failed} tài khoản chưa đọc được số liệu, đang hiện là 0. Bấm “Đọc lại từ Meta” sau ít phút.`);
  for (const item of pending) rows.push({ row: item.row });

  const dto = buildOverview({ window, today, fetchedAt: now, connection: status, rows, stored: listFbAdAccounts(), warnings });
  cache.set(window, { at: now, dto });
  return dto;
}
