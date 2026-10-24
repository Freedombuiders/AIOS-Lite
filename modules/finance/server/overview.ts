/**
 * GET /overview: the "Doanh thu & chi phí" section of Tổng quan. Revenue per day by source (ERP, Whop, Pancake orders),
 * costs (Meta Ads, AI, ledger) and a profit estimate equal to the P&L net profit (+ Pancake sales), for the period and the one before it.
 * Reuses the P&L engine for ERP / Whop / ads / AI; only Pancake orders are fetched here (cached 10 minutes).
 * Unknown is null, never 0. Pancake order revenue is sales value and may overlap with ERP if the same sales are in both.
 *
 * Pancake order rules (status codes, which orders count) are adapted from FreedomOS src/command-center/summary.ts (owner-only).
 */
import type { DB } from '../../../src/core/db.js';
import type { ModuleContext } from '../../../src/modules/sdk.js';
import { addDays, buildPnl, datesBetween } from './pnl/engine.js';
import { readInputs } from './pnl/store.js';
import type { PnlDay, PnlDto } from './pnl/types.js';
import { kvGet, kvSet } from './kv.js';

/** Pancake statuses that are not revenue: canceled / returned / deleted ones (4-7). */
export const NON_REVENUE_STATUSES: ReadonlySet<number> = new Set([4, 5, 6, 7]);
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const CACHE_MS = 10 * 60_000;
const PANCAKE_TIMEOUT_MS = 20_000;
export const DOUBLE_COUNT = ' Đơn ghi ở cả ERP và Pancake sẽ bị tính hai lần: chỉ nên kết nối một trong hai cho cùng một cửa hàng.';

export interface OverviewDay {
  date: string;
  erp: number | null;
  whop: number | null;
  pancake: number | null;
  /** sum of the known sources; null when none is known that day */
  revenue: number | null;
  ads: number;
  ai: number;
  ledger: number;
  cost: number;
  /** P&L daily profit + Pancake sales; null when ERP is unknown that day */
  profit: number | null;
}

export interface OverviewPeriod {
  from: string;
  to: string;
  revenue: number | null;
  revenueBySource: { erp: number | null; whop: number | null; pancake: number | null };
  orders: number | null;
  aov: number | null;
  costs: { ads: number; ai: number; ledger: number; total: number };
  profit: number | null;
  roas: number | null;
  daily: OverviewDay[];
}

export interface OverviewSource {
  id: 'erp' | 'whop' | 'pancake' | 'meta_ads';
  label: string;
  connected: boolean;
  detail: string;
  lastSync: string | null;
}

export interface OverviewDto {
  current: OverviewPeriod;
  previous: OverviewPeriod;
  sources: OverviewSource[];
  generatedAt: string;
}

export interface OverviewRangeInput { from: string; to: string; prevFrom: string; prevTo: string }

interface PancakeBuckets { orders: number; days: Record<string, { total: number; orders: number }> }
type PancakeResult = { ok: true; cur: PancakeBuckets; prev: PancakeBuckets; at: number } | { ok: false; error: string };

const sum = (xs: Array<number | null>): number | null => {
  const k = xs.filter((x): x is number => x !== null);
  return k.length ? k.reduce((a, b) => a + b, 0) : null;
};
const iso = (at: number | null | undefined): string | null => {
  if (!at) return null;
  return new Date(at > 1e11 ? at : at * 1000).toISOString();
};
const vnDate = (ms: number) => new Date(ms + 7 * 3600_000).toISOString().slice(0, 10);

function bucketOrders(items: unknown[], from: string, to: string, into: PancakeBuckets): void {
  for (const it of items) {
    const o = it as { status?: { code?: number }; createdAt?: string; total?: number };
    const code = o.status?.code;
    if (typeof code === 'number' && NON_REVENUE_STATUSES.has(code)) continue;
    const ms = o.createdAt ? Date.parse(o.createdAt) : NaN;
    if (Number.isNaN(ms)) continue;
    const day = vnDate(ms);
    if (day < from || day > to) continue;
    const b = (into.days[day] ??= { total: 0, orders: 0 });
    b.total += Number(o.total) || 0;
    b.orders += 1;
    into.orders += 1;
  }
}

async function fetchPeriod(ctx: ModuleContext, from: string, to: string): Promise<PancakeBuckets> {
  const out: PancakeBuckets = { orders: 0, days: {} };
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await ctx.integrations.read('pancake', `orders list --since ${addDays(from, -1)} --until ${addDays(to, 1)} --limit ${PAGE_SIZE} --page ${page} --sort oldest`) as
      { items?: unknown[]; totalPages?: number } | null;
    const items = res?.items ?? [];
    bucketOrders(items, from, to, out);
    if (items.length < PAGE_SIZE || (res?.totalPages !== undefined && page >= res.totalPages)) return out;
  }
  return out;
}

/** Pancake orders for both periods; cached per range in finance_kv. Never throws. */
async function pancakeOrders(ctx: ModuleContext, r: OverviewRangeInput): Promise<PancakeResult> {
  const key = `overview.pancake.v1:${r.prevFrom}:${r.from}:${r.to}`;
  try {
    const cached = kvGet(ctx.db, key);
    if (cached) {
      const c = JSON.parse(cached) as { cur: PancakeBuckets; prev: PancakeBuckets; at: number };
      if (Date.now() - c.at < CACHE_MS) return { ok: true, ...c };
    }
  } catch { /* stale or corrupt cache: refetch */ }
  try {
    const work = Promise.all([fetchPeriod(ctx, r.from, r.to), fetchPeriod(ctx, r.prevFrom, r.prevTo)]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('Pancake phản hồi quá chậm.')), PANCAKE_TIMEOUT_MS); });
    const [cur, prev] = await Promise.race([work, timeout]).finally(() => clearTimeout(timer));
    const at = Date.now();
    kvSet(ctx.db, key, JSON.stringify({ cur, prev, at }));
    return { ok: true, cur, prev, at };
  } catch (err) {
    return { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
  }
}

function period(from: string, to: string, pnlDaily: PnlDay[], netProfit: number, flags: { erp: boolean; whop: boolean }, pc: PancakeBuckets | null): OverviewPeriod {
  const byDate = new Map(pnlDaily.map((d) => [d.date, d]));
  const daily: OverviewDay[] = datesBetween(from, to).map((date) => {
    const d = byDate.get(date);
    const erp = flags.erp ? (d?.erpRevenue ?? null) : null;
    const whop = flags.whop ? (d?.whopNet ?? 0) : null;
    const pancake = pc ? (pc.days[date]?.total ?? 0) : null;
    const revenue = sum([erp, whop, pancake]);
    const ads = d?.ads ?? 0;
    const ai = d?.ai ?? 0;
    const ledger = d?.ledgerCosts ?? 0;
    const cost = ads + ai + ledger;
    // same figure as the P&L page (ERP kept share + Whop − costs) plus Pancake sales, which carry no cost of goods
    const profit = d?.profit == null ? null : d.profit + (pancake ?? 0);
    return { date, erp, whop, pancake, revenue, ads, ai, ledger, cost, profit };
  });
  const col = (k: 'erp' | 'whop' | 'pancake') => sum(daily.map((d) => d[k]));
  const revenueBySource = { erp: col('erp'), whop: col('whop'), pancake: col('pancake') };
  const revenue = sum([revenueBySource.erp, revenueBySource.whop, revenueBySource.pancake]);
  const costs = { ads: 0, ai: 0, ledger: 0, total: 0 };
  for (const d of daily) { costs.ads += d.ads; costs.ai += d.ai; costs.ledger += d.ledger; costs.total += d.cost; }
  const orders = pc ? pc.orders : null;
  return {
    from, to, revenue, revenueBySource, orders,
    aov: pc && pc.orders > 0 ? (revenueBySource.pancake ?? 0) / pc.orders : null,
    costs,
    profit: flags.erp || flags.whop || pc ? netProfit + (revenueBySource.pancake ?? 0) : null,
    roas: revenue !== null && costs.ads > 0 ? revenue / costs.ads : null,
    daily,
  };
}

function adsLastSync(db: DB): number | null {
  try { return (db.prepare('SELECT MAX(synced_at) AS at FROM fb_ad_accounts').get() as { at: number | null }).at; } catch { return null; }
}

export async function buildOverview(ctx: ModuleContext, r: OverviewRangeInput, flags: { erpConnected: boolean; whopConnected: boolean }): Promise<OverviewDto> {
  const read = (from: string, to: string): PnlDto => {
    const n = datesBetween(from, to).length;
    return buildPnl(readInputs(ctx.db, { preset: 'custom', from, to, label: '', prevFrom: addDays(from, -n), prevTo: addDays(from, -1), prevLabel: '' }, flags));
  };
  const cur = read(r.from, r.to);
  const prev = read(r.prevFrom, r.prevTo);
  const pancakeOn = !!ctx.integrations.values('pancake');
  const pc = pancakeOn ? await pancakeOrders(ctx, r) : null;
  const erpOn = cur.erp.connected;
  const whopOn = cur.whop.connected;
  const adsAt = adsLastSync(ctx.db);
  const adsSeen = cur.daily.some((d) => d.ads > 0) || prev.daily.some((d) => d.ads > 0) || cur.ads.accounts.length > 0;

  const sources: OverviewSource[] = [
    { id: 'erp', label: 'ERP', connected: erpOn, lastSync: iso(cur.erp.syncedAt),
      detail: erpOn ? 'Doanh thu đơn đã thanh toán từ ERP (MCP).' : 'Chưa kết nối ERP MCP. Thêm trong cài đặt module Tài chính.' },
    { id: 'whop', label: 'Whop', connected: whopOn, lastSync: iso(cur.whop.syncedAt),
      detail: whopOn ? 'Doanh thu ròng từ Whop (MCP), đổi sang VND theo tỷ giá trong P&L.' : 'Chưa kết nối Whop MCP. Thêm trong cài đặt module Tài chính.' },
    { id: 'pancake', label: 'Pancake', connected: pc?.ok === true, lastSync: pc?.ok ? new Date(pc.at).toISOString() : null,
      detail: !pancakeOn ? 'Chưa kết nối Pancake. Thêm trong Kết nối.' : pc?.ok ? `Đơn hàng Pancake POS, trừ đơn huỷ / hoàn / xoá.${erpOn ? DOUBLE_COUNT : ''}` : `Không đọc được Pancake: ${pc?.ok === false ? pc.error : ''}` },
    { id: 'meta_ads', label: 'Meta Ads', connected: adsSeen, lastSync: iso(adsAt),
      detail: adsSeen ? 'Chi phí quảng cáo Meta đã nhập từ module Quảng cáo.' : 'Chưa có dữ liệu chi phí Meta Ads.' },
  ];

  return {
    current: period(r.from, r.to, cur.daily, cur.kpis.netProfit, { erp: erpOn, whop: whopOn }, pc?.ok ? pc.cur : null),
    previous: period(r.prevFrom, r.prevTo, prev.daily, prev.kpis.netProfit, { erp: erpOn, whop: whopOn }, pc?.ok ? pc.prev : null),
    sources,
    generatedAt: new Date().toISOString(),
  };
}
