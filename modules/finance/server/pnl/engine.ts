/**
 * Pure P&L engine: inputs already read from SQLite → PnlDto. No I/O, so every rule is unit tested.
 *
 * Statement (VND):
 *   Doanh thu gộp           ERP revenue + Whop gross + other revenue in the ledger
 *   − Giảm trừ              Whop refunds, Whop fees / Whop affiliate, ledger refunds
 *   = Doanh thu thuần
 *   − Chia đối tác ERP      revenue − ERP company share − internal ads fund (author, instructor, affiliate, sales)
 *   = Doanh thu giữ lại     what the company keeps, ads fund included
 *   − Chi phí trực tiếp     ledger
 *   = Lãi gộp
 *   − Marketing             Meta Ads in scope (by program, shared, unassigned) + other ads in the ledger
 *   = Lãi sau marketing
 *   − Vận hành              AI cost of Freedom OS + ledger overhead
 *   = Lợi nhuận trước thuế
 *   − Thuế                  ledger
 *   = Lợi nhuận ròng
 */

import type { ProfitDocument } from '../profit/model.js';
import { erpRange, type ErpDailyRow, type ErpPeriodRow, type ErpProgramCount, type ErpRange } from '../erp/money.js';
import type { ErpCatalog } from '../erp/sync.js';
import {
  ADS_OUT, ADS_SHARED, ADS_UNASSIGNED,
  type AdsTarget, type PnlCampaign, type PnlDay, type PnlDto, type PnlIssue, type PnlKpis, type PnlLine, type PnlPreset, type PnlProgram, type PnlSettings,
} from './types.js';

export interface AdsRow {
  accountId: string;
  accountName: string;
  currency: string;
  level: 'account' | 'campaign';
  objectId: string;
  name: string;
  day: string;
  spend: number;
  results: number;
}

export interface WhopDayRow { date: string; gross: number; refunded: number; net: number }

export interface PnlInputs {
  preset: PnlPreset;
  from: string;
  to: string;
  label: string;
  prevFrom: string;
  prevTo: string;
  prevLabel: string;
  settings: PnlSettings;
  erp: { connected: boolean; syncedAt: number | null; daily: ErpDailyRow[]; periods: ErpPeriodRow[]; catalog: ErpCatalog | null };
  whop: { connected: boolean; syncedAt: number | null; daily: WhopDayRow[] };
  ads: AdsRow[];
  ledger: ProfitDocument | null;
  aiUsdByDay: Record<string, number>;
  nowIso: string;
}

// ── Dates ─────────────────────────────────────────────────────────────────────

export function addDays(date: string, n: number): string {
  const t = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 1000; d = addDays(d, 1)) out.push(d);
  return out;
}

// ── Ads attribution ───────────────────────────────────────────────────────────

export const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();

/** Name rules, first match wins. A program target applies only when that program exists in the ERP. */
const RULES: Array<{ re: RegExp; target: AdsTarget; rule: string }> = [
  { re: /\bamz\b|amazon/, target: ADS_OUT, rule: 'Amazon' },
  { re: /6x/, target: '6x-ai-facebook-income', rule: '"6X" trong tên' },
  { re: /5\s*(ngay|day)|5days/, target: '5days-ai-agent', rule: '"5 ngày" trong tên' },
  { re: /second\s*brain|bo nao|mindmirror|nho da luu/, target: 'second-brain-sme', rule: 'Second Brain / "nhớ đã lưu"' },
  { re: /skill.*free|free.*skill|mien phi/, target: 'skill-edit-video-free', rule: 'Skill video miễn phí' },
  { re: /edit\s*video|skill/, target: 'chuong-trinh-edit-video', rule: '"edit video" trong tên' },
  { re: /reel/, target: ADS_SHARED, rule: 'ReelStudio' },
];

export function autoTarget(accountName: string, campaignName: string, programs: Set<string>): { target: AdsTarget; rule: string } | null {
  const text = `${norm(accountName)} | ${norm(campaignName)}`;
  for (const r of RULES) {
    if (!r.re.test(text)) continue;
    if (r.target !== ADS_OUT && r.target !== ADS_SHARED && !programs.has(r.target)) continue;
    return { target: r.target, rule: r.rule };
  }
  for (const code of programs) if (norm(campaignName).includes(code)) return { target: code, rule: 'Mã chương trình trong tên' };
  return null;
}

interface AdsSplit {
  campaigns: PnlCampaign[];
  /** In-scope spend per day (everything except `out`). */
  byDay: Map<string, number>;
  byTarget: Map<AdsTarget, { spend: number; results: number }>;
  accounts: Map<string, { id: string; name: string; spend: number }>;
}

/** VND spend of one row; other currencies go through the USD rate (only USD is supported). */
const vnd = (amount: number, currency: string, usdVnd: number) => (currency === 'VND' ? amount : currency === 'USD' ? amount * usdVnd : 0);

export function splitAds(rows: AdsRow[], settings: PnlSettings, programs: Set<string>, from: string, to: string): AdsSplit {
  const inRange = rows.filter((r) => r.day >= from && r.day <= to);
  const out: AdsSplit = { campaigns: [], byDay: new Map(), byTarget: new Map(), accounts: new Map() };
  const outAccounts = new Set(settings.outAccounts);
  const add = (target: AdsTarget, day: string, spend: number, results: number) => {
    const t = out.byTarget.get(target) ?? { spend: 0, results: 0 };
    t.spend += spend;
    t.results += results;
    out.byTarget.set(target, t);
    if (target !== ADS_OUT) out.byDay.set(day, (out.byDay.get(day) ?? 0) + spend);
  };

  const campaigns = new Map<string, PnlCampaign>();
  const campaignDay = new Map<string, number>();
  for (const r of inRange.filter((x) => x.level === 'campaign')) {
    const key = `${r.accountId}:${r.objectId}`;
    const spend = vnd(r.spend, r.currency, settings.usdVnd);
    let c = campaigns.get(key);
    if (!c) {
      const manual = settings.campaigns[key];
      const auto = autoTarget(r.accountName, r.name, programs);
      const [target, by, rule]: [AdsTarget, PnlCampaign['by'], string | undefined] =
        manual ? [manual, 'manual', undefined]
          : outAccounts.has(r.accountId) ? [ADS_OUT, 'account', undefined]
            : auto ? [auto.target, 'auto', auto.rule]
              : [ADS_UNASSIGNED, 'none', undefined];
      c = { key, accountId: r.accountId, accountName: r.accountName, campaignId: r.objectId, name: r.name, spend: 0, results: 0, lastDay: r.day, target, by, ...(rule ? { rule } : {}) };
      campaigns.set(key, c);
    }
    c.spend += spend;
    c.results += r.results;
    if (r.day > c.lastDay) { c.lastDay = r.day; c.name = r.name || c.name; }
    add(c.target, r.day, spend, r.results);
    const k = `${r.accountId}|${r.day}`;
    campaignDay.set(k, (campaignDay.get(k) ?? 0) + spend);
  }

  // Account totals above the sum of their campaigns (campaign detail missing) stay visible as shared spend.
  for (const r of inRange.filter((x) => x.level === 'account')) {
    const spend = vnd(r.spend, r.currency, settings.usdVnd);
    const acc = out.accounts.get(r.accountId) ?? { id: r.accountId, name: r.accountName, spend: 0 };
    acc.spend += spend;
    out.accounts.set(r.accountId, acc);
    const residual = spend - (campaignDay.get(`${r.accountId}|${r.day}`) ?? 0);
    if (residual <= 0.5) continue;
    const accOut = outAccounts.has(r.accountId) || autoTarget(r.accountName, '', programs)?.target === ADS_OUT;
    add(accOut ? ADS_OUT : ADS_SHARED, r.day, residual, 0);
  }
  out.campaigns = [...campaigns.values()].sort((a, b) => b.spend - a.spend);
  return out;
}

// ── Ads fund of the ERP share policies ────────────────────────────────────────

/**
 * Basis points of ERP revenue kept as the internal ads fund. Exact when every order of the period falls under
 * policies with the same rate; otherwise an order-weighted estimate.
 */
export function adsFundRate(catalog: ErpCatalog | null, programs: ErpProgramCount[] | null, paidOrders: number): { bps: number; exact: boolean } | null {
  if (!catalog?.policies.length) return null;
  const policyBps = new Map(catalog.policies.map((p) => [p.policy, p.adsFundBps]));
  const offers = catalog.offers.filter((o) => o.policy && policyBps.has(o.policy));
  if (!offers.length) return null;
  const ratesOf = (program: string | null) => [...new Set(offers.filter((o) => o.program === program && o.price > 0).map((o) => policyBps.get(o.policy!)!))];
  const weighted: Array<{ w: number; rates: number[] }> = [];
  if (programs) {
    for (const p of programs) if (p.paid_orders > 0) weighted.push({ w: p.paid_orders, rates: ratesOf(p.program) });
    const other = paidOrders - programs.reduce((s, p) => s + p.paid_orders, 0);
    if (other > 0) weighted.push({ w: other, rates: ratesOf(null) });
  }
  const known = weighted.filter((x) => x.rates.length);
  if (!known.length) {
    const all = [...new Set(offers.filter((o) => o.price > 0).map((o) => policyBps.get(o.policy!)!))];
    if (!all.length) return null;
    return { bps: all.reduce((s, r) => s + r, 0) / all.length, exact: all.length === 1 && paidOrders === 0 };
  }
  const distinct = new Set(known.flatMap((x) => x.rates));
  const total = known.reduce((s, x) => s + x.w, 0);
  const bps = known.reduce((s, x) => s + x.w * (x.rates.reduce((a, r) => a + r, 0) / x.rates.length), 0) / total;
  return { bps, exact: distinct.size === 1 && known.length === weighted.length };
}

// ── Core computation for one range ────────────────────────────────────────────

interface Core {
  kpis: PnlKpis;
  statement: PnlLine[];
  daily: PnlDay[];
  erp: ErpRange | null;
  ads: AdsSplit;
  adsFundExact: boolean;
  whopUsd: { gross: number; refunded: number; net: number; fees: number };
  ledger: { revenue: number; refund: number; direct: number; overhead: number; tax: number; otherAds: number; entries: number };
  aiVnd: number;
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

function ledgerTotals(doc: ProfitDocument | null, from: string, to: string, usdVnd: number) {
  const t = { revenue: 0, refund: 0, direct: 0, overhead: 0, tax: 0, otherAds: 0, entries: 0 };
  const byDay = new Map<string, { revenue: number; costs: number }>();
  if (!doc) return { t, byDay };
  const rate = doc.currency === 'USD' ? usdVnd : 1;
  for (const e of doc.entries) {
    if (e.date < from || e.date > to) continue;
    const v = e.amount * rate;
    const day = byDay.get(e.date) ?? { revenue: 0, costs: 0 };
    switch (e.kind) {
      case 'revenue': t.revenue += v; day.revenue += v; break;
      case 'refund': t.refund += v; day.revenue -= v; break;
      case 'direct': t.direct += v; day.costs += v; break;
      case 'overhead': t.overhead += v; day.costs += v; break;
      case 'tax': t.tax += v; day.costs += v; break;
      case 'other_ads': t.otherAds += v; day.costs += v; break;
      default: continue;
    }
    t.entries++;
    byDay.set(e.date, day);
  }
  return { t, byDay };
}

function core(inp: PnlInputs, from: string, to: string): Core {
  const fx = inp.settings.usdVnd;
  const days = datesBetween(from, to);
  const programCodes = new Set((inp.erp.catalog?.programs ?? []).map((p) => p.code));

  // ERP
  const erp = erpRange(inp.erp.daily, inp.erp.periods, days);
  const erpRevenue = erp?.revenue ?? 0;
  const companyShare = erp?.companyShare ?? 0;
  const fund = adsFundRate(inp.erp.catalog, erp?.programs ?? null, erp?.paidOrders ?? 0);
  let adsFund = fund ? erpRevenue * (fund.bps / 10_000) : null;
  let adsFundExact = fund?.exact ?? false;
  let partners = erpRevenue - companyShare - (adsFund ?? 0);
  if (partners < 0) { adsFund = erpRevenue - companyShare; partners = 0; adsFundExact = false; }
  const erpExact = !!erp && erp.missingDays.length === 0;

  // Whop (USD)
  const whopRows = inp.whop.daily.filter((r) => r.date >= from && r.date <= to);
  const whopUsd = {
    gross: sum(whopRows.map((r) => r.gross)), refunded: sum(whopRows.map((r) => r.refunded)), net: sum(whopRows.map((r) => r.net)), fees: 0,
  };
  whopUsd.fees = Math.max(0, whopUsd.gross - whopUsd.refunded - whopUsd.net);

  // Ledger, ads, AI
  const { t: ledger, byDay: ledgerByDay } = ledgerTotals(inp.ledger, from, to, fx);
  const ads = splitAds(inp.ads, inp.settings, programCodes, from, to);
  const metaInScope = sum([...ads.byTarget].filter(([k]) => k !== ADS_OUT).map(([, v]) => v.spend));
  const aiVnd = sum(days.map((d) => (inp.aiUsdByDay[d] ?? 0) * fx));

  const gross = erpRevenue + whopUsd.gross * fx + ledger.revenue;
  const deductions = (whopUsd.refunded + whopUsd.fees) * fx + ledger.refund;
  const netRevenue = gross - deductions;
  const retained = netRevenue - partners;
  const grossProfit = retained - ledger.direct;
  const marketing = metaInScope + ledger.otherAds;
  const contribution = grossProfit - marketing;
  const operating = aiVnd + ledger.overhead;
  const ebt = contribution - operating;
  const netProfit = ebt - ledger.tax;

  const targetLabel = (t: AdsTarget) => t === ADS_SHARED ? 'Chung / thương hiệu' : t === ADS_UNASSIGNED ? 'Chưa phân bổ chương trình' : (inp.erp.catalog?.programs.find((p) => p.code === t)?.title ?? t);
  const metaChildren: PnlLine[] = [...ads.byTarget].filter(([k]) => k !== ADS_OUT).sort((a, b) => b[1].spend - a[1].spend)
    .map(([k, v]) => ({ key: `ads:${k}`, label: targetLabel(k), kind: 'cost', value: v.spend, source: 'Meta Ads', exact: k !== ADS_UNASSIGNED }));

  const statement: PnlLine[] = [
    {
      key: 'gross', label: 'Doanh thu gộp', kind: 'revenue', value: gross, source: 'ERP + Whop + sổ thu chi', exact: erpExact,
      children: [
        { key: 'gross:erp', label: 'ERP · giáo dục (gồm VAT)', kind: 'revenue', value: erpRevenue, source: 'ERP business_summary', exact: erpExact, ...(erp && erp.missingDays.length ? { note: `Thiếu ${erp.missingDays.length} ngày` } : {}) },
        { key: 'gross:whop', label: 'Whop · membership', kind: 'revenue', value: whopUsd.gross * fx, source: `Whop gross $${whopUsd.gross.toFixed(2)} × ${fx.toLocaleString('vi-VN')}`, exact: inp.settings.usdVndConfirmed },
        ...(ledger.revenue ? [{ key: 'gross:ledger', label: 'Doanh thu khác (sổ thu chi)', kind: 'revenue' as const, value: ledger.revenue, source: 'Sổ thu chi', exact: true }] : []),
      ],
    },
    {
      key: 'deductions', label: 'Giảm trừ doanh thu', kind: 'deduction', value: deductions, source: 'Whop + sổ thu chi', exact: inp.settings.usdVndConfirmed,
      children: [
        { key: 'ded:whop-refund', label: 'Hoàn tiền Whop', kind: 'deduction', value: whopUsd.refunded * fx, source: 'Whop total_refunded', exact: inp.settings.usdVndConfirmed },
        { key: 'ded:whop-fees', label: 'Phí Whop & affiliate Whop', kind: 'deduction', value: whopUsd.fees * fx, source: 'Whop gross − hoàn tiền − net', exact: inp.settings.usdVndConfirmed },
        ...(ledger.refund ? [{ key: 'ded:ledger', label: 'Hoàn tiền (sổ thu chi)', kind: 'deduction' as const, value: ledger.refund, source: 'Sổ thu chi', exact: true }] : []),
      ],
    },
    { key: 'net', label: 'Doanh thu thuần', kind: 'subtotal', value: netRevenue, source: '', exact: erpExact },
    {
      key: 'partners', label: 'Chia đối tác ERP', kind: 'deduction', value: partners, source: 'ERP: doanh thu − phần công ty − quỹ Ads nội bộ', exact: erpExact && (fund ? adsFundExact : false),
      note: fund ? 'Tác giả, giảng viên, affiliate, sales theo chính sách chia' : 'Chưa tách được quỹ Ads nội bộ: số này gồm cả quỹ Ads',
    },
    {
      key: 'retained', label: 'Doanh thu giữ lại', kind: 'subtotal', value: retained, source: '', exact: erpExact,
      ...(adsFund !== null ? { note: `Gồm quỹ Ads nội bộ ${Math.round(adsFund).toLocaleString('vi-VN')}đ trích theo chính sách` } : {}),
    },
    { key: 'direct', label: 'Chi phí trực tiếp', kind: 'cost', value: ledger.direct, source: 'Sổ thu chi', exact: true },
    { key: 'grossProfit', label: 'Lãi gộp', kind: 'subtotal', value: grossProfit, source: '', exact: erpExact },
    {
      key: 'marketing', label: 'Marketing', kind: 'cost', value: marketing, source: 'Meta Ads + sổ thu chi', exact: !ads.byTarget.has(ADS_UNASSIGNED),
      children: [
        ...metaChildren,
        ...(ledger.otherAds ? [{ key: 'ads:ledger', label: 'Ads ngoài Meta (sổ thu chi)', kind: 'cost' as const, value: ledger.otherAds, source: 'Sổ thu chi', exact: true }] : []),
      ],
    },
    { key: 'contribution', label: 'Lãi sau marketing', kind: 'subtotal', value: contribution, source: '', exact: erpExact },
    {
      key: 'operating', label: 'Vận hành', kind: 'cost', value: operating, source: 'Chi phí AI + sổ thu chi', exact: inp.settings.usdVndConfirmed,
      children: [
        { key: 'op:ai', label: 'Chi phí AI (Freedom OS)', kind: 'cost', value: aiVnd, source: 'Lịch sử dùng model (USD)', exact: inp.settings.usdVndConfirmed },
        { key: 'op:ledger', label: 'Vận hành (sổ thu chi)', kind: 'cost', value: ledger.overhead, source: 'Sổ thu chi', exact: true },
      ],
    },
    { key: 'ebt', label: 'Lợi nhuận trước thuế', kind: 'subtotal', value: ebt, source: '', exact: erpExact },
    { key: 'tax', label: 'Thuế', kind: 'cost', value: ledger.tax, source: 'Sổ thu chi', exact: true },
    { key: 'netProfit', label: 'Lợi nhuận ròng', kind: 'result', value: netProfit, source: '', exact: erpExact },
  ];

  // Daily profit: the ERP share kept that day (company share + ads fund at the period rate).
  const erpDay = new Map((erp?.days ?? []).map((d) => [d.date, d]));
  const whopDay = new Map(whopRows.map((r) => [r.date, r]));
  const fundBps = fund?.bps ?? 0;
  const daily: PnlDay[] = days.map((date) => {
    const e = erpDay.get(date);
    const w = whopDay.get(date);
    const l = ledgerByDay.get(date) ?? { revenue: 0, costs: 0 };
    const adsD = ads.byDay.get(date) ?? 0;
    const ai = (inp.aiUsdByDay[date] ?? 0) * fx;
    const whopNet = (w?.net ?? 0) * fx;
    const erpRev = e?.revenue ?? null;
    const kept = erpRev === null ? null : (e?.companyShare ?? 0) + erpRev * (fundBps / 10_000);
    return { date, erpRevenue: erpRev, whopNet, ads: adsD, ai, ledgerCosts: l.costs, profit: kept === null ? null : kept + whopNet + l.revenue - adsD - ai - l.costs };
  });

  const paidOrders = erp?.paidOrders ?? 0;
  const kpis: PnlKpis = {
    grossRevenue: gross, netRevenue, retained, marketing, netProfit, margin: ratio(netProfit, netRevenue),
    roas: ratio(erpRevenue + whopUsd.gross * fx, metaInScope), cac: ratio(marketing, paidOrders), aov: ratio(erpRevenue, paidOrders),
    erpRevenue, whopNet: whopUsd.net * fx, paidOrders, registrations: erp?.registrations ?? 0, conversion: ratio(paidOrders, erp?.registrations ?? 0),
    adsFund, adsFundUse: adsFund ? ratio(metaInScope, adsFund) : null,
  };
  return { kpis, statement, daily, erp, ads, adsFundExact, whopUsd, ledger, aiVnd };
}

// ── Programs ──────────────────────────────────────────────────────────────────

function programRows(inp: PnlInputs, c: Core): PnlProgram[] {
  const cat = inp.erp.catalog;
  if (!cat) return [];
  const counts = new Map((c.erp?.programs ?? []).map((p) => [p.program, p]));
  const countsKnown = !!c.erp?.programs;
  const policies = new Map(cat.policies.map((p) => [p.policy, p]));
  return cat.programs.map((p): PnlProgram => {
    const offers = cat.offers.filter((o) => o.program === p.code);
    const pol = offers.map((o) => (o.policy ? policies.get(o.policy) : undefined)).find(Boolean) ?? null;
    const n = counts.get(p.code);
    const registrations = countsKnown ? (n?.registrations ?? 0) : null;
    const paidOrders = countsKnown ? (n?.paid_orders ?? 0) : null;
    const ads = c.ads.byTarget.get(p.code)?.spend ?? 0;
    return {
      code: p.code, title: p.title, type: p.type, status: p.status, start: p.start, end: p.end,
      registrations, paidOrders,
      conversion: registrations !== null && paidOrders !== null ? ratio(paidOrders, registrations) : null,
      ads, adsResults: c.ads.byTarget.get(p.code)?.results ?? 0,
      cpl: registrations && ads > 0 ? ratio(ads, registrations) : null,
      cac: paidOrders && ads > 0 ? ratio(ads, paidOrders) : null,
      funnel: cat.funnels[p.code] ?? null,
      offers: offers.map((o) => ({ code: o.code, title: o.title, price: o.price, orderCount: o.orderCount })),
      policy: pol ? { title: pol.title, adsFundBps: pol.adsFundBps, roles: pol.roles, affiliateBps: pol.affiliateBps, companyBpsNoAffiliate: pol.companyBpsNoAffiliate } : null,
    };
  }).sort((a, b) => (b.paidOrders ?? 0) - (a.paidOrders ?? 0) || (b.registrations ?? 0) - (a.registrations ?? 0) || b.ads - a.ads);
}

// ── Issues ────────────────────────────────────────────────────────────────────

const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

function issuesOf(inp: PnlInputs, c: Core): PnlIssue[] {
  const out: PnlIssue[] = [];
  if (!inp.erp.connected) out.push({ level: 'warn', text: 'Chưa kết nối ERP: doanh thu giáo dục chưa có trong P&L.', action: 'erp' });
  if (c.erp && c.erp.missingDays.length) {
    const m = c.erp.missingDays;
    out.push({ level: 'warn', text: `ERP chưa có số liệu cho ${m.length} ngày (${dmy(m[0])}–${dmy(m[m.length - 1])}); doanh thu và lợi nhuận chưa gồm các ngày này. Lịch sử theo ngày bắt đầu từ lần đồng bộ đầu tiên.`, action: 'erp' });
  }
  if (!inp.settings.usdVndConfirmed && (c.whopUsd.gross > 0 || c.aiVnd > 0)) {
    out.push({ level: 'warn', text: `Whop và chi phí AI tính bằng USD đang quy đổi theo tỷ giá tạm ${inp.settings.usdVnd.toLocaleString('vi-VN')}đ. Xác nhận tỷ giá để số chính xác.`, action: 'fx' });
  }
  const unassigned = c.ads.byTarget.get(ADS_UNASSIGNED)?.spend ?? 0;
  if (unassigned > 0) {
    const n = c.ads.campaigns.filter((x) => x.target === ADS_UNASSIGNED).length;
    out.push({ level: 'warn', text: `${n} chiến dịch (${Math.round(unassigned).toLocaleString('vi-VN')}đ) chưa gán chương trình: vẫn tính vào chi phí, nhưng chưa vào lãi lỗ từng chương trình.`, action: 'ads' });
  }
  if (!c.adsFundExact && c.kpis.adsFund !== null && c.kpis.erpRevenue > 0) {
    out.push({ level: 'info', text: 'Quỹ Ads nội bộ đang ước tính theo tỷ lệ chính sách của các chương trình có đơn; phần chia đối tác có thể lệch nhẹ.', action: 'erp' });
  }
  if (!c.ledger.overhead && !c.ledger.direct) {
    out.push({ level: 'info', text: 'Sổ thu chi chưa có chi phí trực tiếp hay vận hành (lương, công cụ, mặt bằng…) trong kỳ: lợi nhuận đang cao hơn thực tế.', action: 'ledger' });
  }
  if (!inp.whop.connected) out.push({ level: 'info', text: 'Chưa có dữ liệu Whop theo ngày: doanh thu Whop chưa vào P&L.', action: 'whop' });
  return out;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function buildPnl(inp: PnlInputs): PnlDto {
  const cur = core(inp, inp.from, inp.to);
  const prev = core(inp, inp.prevFrom, inp.prevTo);
  const prevComplete = !!prev.erp && prev.erp.missingDays.length === 0;
  const targetLabel = (t: AdsTarget) => t === ADS_SHARED ? 'Chung / thương hiệu' : t === ADS_UNASSIGNED ? 'Chưa phân bổ' : t === ADS_OUT ? 'Ngoài P&L' : (inp.erp.catalog?.programs.find((p) => p.code === t)?.title ?? t);
  const outAccounts = new Set(inp.settings.outAccounts);
  return {
    range: { preset: inp.preset, from: inp.from, to: inp.to, days: datesBetween(inp.from, inp.to).length, label: inp.label },
    prevRange: { from: inp.prevFrom, to: inp.prevTo, label: inp.prevLabel },
    generatedAt: inp.nowIso,
    settings: inp.settings,
    statement: cur.statement,
    kpis: cur.kpis,
    prev: prevComplete ? prev.kpis : null,
    daily: cur.daily,
    erp: {
      connected: inp.erp.connected, syncedAt: inp.erp.syncedAt,
      missingDays: cur.erp?.missingDays ?? datesBetween(inp.from, inp.to),
      undated: (cur.erp?.undated ?? []).map((u) => ({ period: u.period, from: u.from, to: u.to, revenue: u.revenue, paidOrders: u.paidOrders })),
      adsFundExact: cur.adsFundExact,
    },
    whop: { connected: inp.whop.connected, syncedAt: inp.whop.syncedAt, grossUsd: cur.whopUsd.gross, refundedUsd: cur.whopUsd.refunded, netUsd: cur.whopUsd.net, feesUsd: cur.whopUsd.fees },
    programs: programRows(inp, cur),
    otherOrders: cur.erp?.programs ? Math.max(0, cur.erp.paidOrders - cur.erp.programs.reduce((s, p) => s + p.paid_orders, 0)) : 0,
    ads: {
      inScope: sum([...cur.ads.byTarget].filter(([k]) => k !== ADS_OUT).map(([, v]) => v.spend)),
      outOfScope: cur.ads.byTarget.get(ADS_OUT)?.spend ?? 0,
      byTarget: [...cur.ads.byTarget].map(([target, v]) => ({ target, label: targetLabel(target), spend: v.spend })).sort((a, b) => b.spend - a.spend),
      campaigns: cur.ads.campaigns,
      accounts: [...cur.ads.accounts.values()].map((a) => ({ ...a, out: outAccounts.has(a.id) || autoTarget(a.name, '', new Set())?.target === ADS_OUT })).sort((a, b) => b.spend - a.spend),
    },
    issues: issuesOf(inp, cur),
  };
}
