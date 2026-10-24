/**
 * Read-only sync of an ERP (Frappe edu_business MCP) into erp_snapshots / erp_daily / erp_period_totals.
 *
 * The connection is a module setting (MCP url + token, or a local command). Only the tools listed in
 * ERP_READ_TOOLS can ever be called; there is no write path to the ERP.
 */

import type { DB } from '../../../../src/core/db.js';
import { hasTarget, parseToolResult, type McpConnector, type McpTarget } from '../mcp.js';
import { readDaily, readSnapshot, upsertDaily, upsertPeriod, writeSnapshot } from './store.js';
import type { ErpDailyRow, ErpProgramCount } from './money.js';

/** The only ERP tools this module may call. Everything else is refused before it leaves the process. */
export const ERP_READ_TOOLS: ReadonlySet<string> = new Set([
  'business_summary', 'list_unmatched_transfers', 'list_partner_statements', 'list_my_unpaid_orders',
  'list_programs', 'list_offers', 'get_offer', 'list_share_policies', 'preview_share_policy', 'get_program_status',
]);

interface PlannedCall { key: string; tool: string; args: Record<string, unknown>; required?: boolean }
const CALLS: PlannedCall[] = [
  { key: 'summary_today', tool: 'business_summary', args: { period: 'today' }, required: true },
  { key: 'summary_week', tool: 'business_summary', args: { period: 'week' }, required: true },
  { key: 'summary_month', tool: 'business_summary', args: { period: 'month' }, required: true },
  { key: 'unmatched_transfers', tool: 'list_unmatched_transfers', args: { limit: 200 } },
  { key: 'partner_statements', tool: 'list_partner_statements', args: { limit: 200 } },
  { key: 'unpaid_orders', tool: 'list_my_unpaid_orders', args: { limit: 50 } },
];

export interface ErpSummary {
  period: 'today' | 'week' | 'month';
  from_date: string;
  to_date: string;
  revenue: number;
  paid_orders: number;
  registrations: number;
  company_share: number;
  programs?: Array<{ program: string; registrations: number; paid_orders: number; converted_people: number; conversion_rate_bps: number }>;
}

export interface ErpSyncStatus {
  ok: boolean;
  at: number;
  hubId: string | null;
  error?: string;
  /** Synced, but some optional sections failed. */
  warning?: string;
  /** Tools not approved for reading, so not synced. */
  skipped: string[];
  failed: string[];
}

export class ErpSyncError extends Error {}


const programCounts = (s: ErpSummary): ErpProgramCount[] =>
  (s.programs ?? []).map((p) => ({ program: p.program, registrations: p.registrations, paid_orders: p.paid_orders }));

const addDays = (date: string, n: number): string => {
  const t = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
};

/**
 * Pure: yesterday's final figures. The last "today" snapshot of a day can miss orders paid after it, so when a
 * week/month summary covers yesterday and every other earlier day of that period is known, yesterday is the
 * period total minus today minus those days. Null when no period allows that.
 */
export function correctedYesterday(periods: ErpSummary[], today: ErpSummary, known: ErpDailyRow[]): ErpDailyRow | null {
  const byDate = new Map(known.map((r) => [r.date, r]));
  const yesterday = addDays(today.to_date, -1);
  for (const p of periods) {
    if (p.to_date !== today.to_date || p.from_date > yesterday) continue;
    const others: ErpDailyRow[] = [];
    let complete = true;
    for (let d = p.from_date; d < yesterday; d = addDays(d, 1)) {
      const row = byDate.get(d);
      if (!row) { complete = false; break; }
      others.push(row);
    }
    if (!complete) continue;
    const rest = (f: 'revenue' | 'paid_orders' | 'registrations' | 'company_share') => p[f] - today[f] - others.reduce((s, r) => s + r[f], 0);
    const row = { date: yesterday, revenue: rest('revenue'), paid_orders: rest('paid_orders'), registrations: rest('registrations'), company_share: rest('company_share') };
    if (Object.values(row).some((v) => typeof v === 'number' && v < 0)) continue;
    return row;
  }
  return null;
}

const asSummary = (v: unknown): ErpSummary => {
  const s = v as ErpSummary;
  if (typeof s?.revenue !== 'number' || typeof s.to_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.to_date)) throw new ErpSyncError('business_summary trả dữ liệu lạ');
  return s;
};

// ── Catalog: programs, offers, revenue-share policies, program funnels ────────────

/** Share of a policy, in basis points of the order amount, from a preview on 1,000,000. */
export interface ErpPolicyRates {
  policy: string;
  title: string;
  /** Internal ads fund kept by the company (not paid out). */
  adsFundBps: number;
  /** Paid-out roles without an affiliate (Author, Instructor, Sales…), plus the affiliate's share when present. */
  roles: Array<{ role: string; bps: number }>;
  affiliateBps: number;
  companyBpsNoAffiliate: number;
  companyBpsWithAffiliate: number;
}

export interface ErpCatalog {
  programs: Array<{ code: string; title: string; type: string; status: string; start: string | null; end: string | null }>;
  offers: Array<{ code: string; title: string; price: number; program: string | null; policy: string | null; orderCount: number | null }>;
  policies: ErpPolicyRates[];
  /** Lifetime funnel per program from get_program_status. */
  funnels: Record<string, { registrations: number; checkouts: number; orders: number; paid_orders: number }>;
}

const CATALOG_EVERY_SEC = 6 * 3600;
const PREVIEW_BASE = 1_000_000;

type Line = { key: [number, string, ...unknown[]]; amount: number };
const bps = (amount: number) => Math.round((amount / PREVIEW_BASE) * 10_000);

/** Pure: rates of one policy from its preview_share_policy result. */
export function policyRates(policy: string, title: string, preview: { with_affiliate: { company_amount: number; lines: Line[] }; without_affiliate: { company_amount: number; lines: Line[] } }): ErpPolicyRates {
  const sumRole = (lines: Line[], role: string) => lines.filter((l) => l.key[1] === role).reduce((s, l) => s + l.amount, 0);
  const noAff = preview.without_affiliate.lines;
  const roles = [...new Set(noAff.map((l) => l.key[1]).filter((r) => r !== 'AdsFund'))].map((role) => ({ role, bps: bps(sumRole(noAff, role)) }));
  return {
    policy, title,
    adsFundBps: bps(sumRole(noAff, 'AdsFund')),
    roles,
    affiliateBps: bps(sumRole(preview.with_affiliate.lines, 'Affiliate')),
    companyBpsNoAffiliate: bps(preview.without_affiliate.company_amount),
    companyBpsWithAffiliate: bps(preview.with_affiliate.company_amount),
  };
}

type Call = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

async function fetchCatalog(call: Call): Promise<ErpCatalog> {
  const programs = ((await call('list_programs', {})) as { programs: Array<Record<string, string | null>> }).programs.map((p) => ({
    code: String(p.program_code ?? p.name), title: String(p.title ?? p.name), type: String(p.program_type ?? ''), status: String(p.status ?? ''),
    start: p.start_date ?? null, end: p.end_date ?? null,
  }));
  const listed = ((await call('list_offers', {})) as { offers: Array<{ offer_code: string; title: string; price: number; program: string | null }> }).offers;
  const offers: ErpCatalog['offers'] = [];
  for (const o of listed) {
    const detail = await call('get_offer', { offer: o.offer_code }).catch(() => null) as { share_policy?: string | null; order_count?: number } | null;
    offers.push({ code: o.offer_code, title: o.title, price: o.price, program: o.program, policy: detail?.share_policy ?? null, orderCount: detail?.order_count ?? null });
  }
  const titles = new Map(((await call('list_share_policies', {}).catch(() => ({ policies: [] }))) as { policies: Array<{ policy: string; title: string }> }).policies.map((p) => [p.policy, p.title]));
  const policies: ErpPolicyRates[] = [];
  for (const policy of new Set(offers.map((o) => o.policy).filter((p): p is string => !!p))) {
    const preview = await call('preview_share_policy', { policy, base_amount: PREVIEW_BASE }).catch(() => null);
    if (preview) policies.push(policyRates(policy, titles.get(policy) ?? policy, preview as Parameters<typeof policyRates>[2]));
  }
  const funnels: ErpCatalog['funnels'] = {};
  for (const p of programs) {
    const st = await call('get_program_status', { program: p.code }).catch(() => null) as { counts?: ErpCatalog['funnels'][string] } | null;
    if (st?.counts) funnels[p.code] = st.counts;
  }
  return { programs, offers, policies, funnels };
}


export interface ErpSyncDeps {
  db: DB;
  connect: McpConnector;
  target: () => McpTarget;
  now?: () => number;
}

export interface ErpSync {
  /** One sync pass; concurrent callers share the pass in flight. Never throws. */
  run(opts?: { catalog?: boolean }): Promise<ErpSyncStatus>;
  configured(): boolean;
}

export function createErpSync(deps: ErpSyncDeps): ErpSync {
  const { db } = deps;
  let running: Promise<ErpSyncStatus> | null = null;

  async function doSync(forceCatalog: boolean): Promise<ErpSyncStatus> {
    const at = deps.now?.() ?? Math.floor(Date.now() / 1000);
    const status: ErpSyncStatus = { ok: false, at, hubId: null, skipped: [], failed: [] };
    const finish = (error?: string): ErpSyncStatus => {
      if (error) status.error = error;
      status.ok = !error;
      writeSnapshot(db, 'status', status, at);
      return status;
    };
    const target = deps.target();
    if (!hasTarget(target)) return finish('Chưa cấu hình kết nối ERP (Module › Tài chính › Cài đặt).');

    try {
      const results = new Map<string, unknown>();
      let catalog: ErpCatalog | null = null;
      const link = await deps.connect(target);
      try {
        const call: Call = async (tool, args) => {
          if (!ERP_READ_TOOLS.has(tool)) throw new ErpSyncError(`Công cụ ERP "${tool}" không nằm trong danh sách chỉ đọc.`);
          const result = parseToolResult(await link.session.callTool(tool, args, 60_000).catch((err) => { throw new ErpSyncError(String((err as Error)?.message ?? err).slice(0, 200)); }));
          return result;
        };
        for (const c of CALLS) {
          try { results.set(c.key, await call(c.tool, c.args)); }
          catch { status.failed.push(c.key); }
        }
        const lastCatalog = readSnapshot<ErpCatalog>(db, 'catalog');
        if (forceCatalog || !lastCatalog || at - lastCatalog.syncedAt >= CATALOG_EVERY_SEC) {
          try { catalog = await fetchCatalog(call); }
          catch { status.failed.push('catalog'); }
        }
      } finally {
        await link.close();
      }

      const today = results.has('summary_today') ? asSummary(results.get('summary_today')) : null;
      if (!today) return finish('Không đọc được tóm tắt kinh doanh từ ERP.');
      const periods = ['summary_week', 'summary_month'].filter((k) => results.has(k)).map((k) => asSummary(results.get(k)));

      db.transaction(() => {
        for (const [key, payload] of results) writeSnapshot(db, key, payload, at);
        if (catalog) writeSnapshot(db, 'catalog', catalog, at);
        upsertDaily(db, { date: today.to_date, revenue: today.revenue, paid_orders: today.paid_orders, registrations: today.registrations, company_share: today.company_share, programs: programCounts(today) }, at);
        for (const p of periods) upsertPeriod(db, { ...p, programs: programCounts(p) }, at);
        const monthStart = periods.reduce((m, p) => (p.from_date < m ? p.from_date : m), today.to_date);
        const fixed = correctedYesterday(periods, today, readDaily(db, monthStart, today.to_date));
        if (fixed) upsertDaily(db, fixed, at);
      })();
      if (status.failed.length) status.warning = `Một số mục chưa đồng bộ được: ${status.failed.join(', ')}`;
      return finish();
    } catch (err) {
      return finish(err instanceof ErpSyncError ? err.message : 'Không kết nối được ERP. Kiểm tra địa chỉ MCP và token trong cài đặt.');
    }
  }

  return {
    run: (opts = {}) => (running ??= doSync(opts.catalog === true).finally(() => { running = null; })),
    configured: () => hasTarget(deps.target()),
  };
}
