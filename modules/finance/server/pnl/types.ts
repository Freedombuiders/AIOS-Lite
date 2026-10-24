/**
 * GET /api/pnl: the company P&L (Freedom Builders: ERP education + Whop), in VND.
 * Shared with the web app (web/src/pages/Pnl.tsx imports this file).
 *
 * Every line names its source and says whether it is exact; a figure that cannot be known is null or
 * listed in `issues`, never filled with a guess.
 */

export const PNL_PRESETS = ['today', 'week', 'month', 'last_month', '7d', '30d', 'custom'] as const;
export type PnlPreset = (typeof PNL_PRESETS)[number];

/** Where a campaign's spend goes: an ERP program code, shared brand spend, or outside the P&L (e.g. Amazon). */
export type AdsTarget = string;
export const ADS_SHARED = 'shared';
export const ADS_OUT = 'out';
export const ADS_UNASSIGNED = 'unassigned';

export interface PnlSettings {
  /** VND per USD for Whop, AI and USD ledger lines. */
  usdVnd: number;
  /** False until the owner saves a rate; the page asks for it. */
  usdVndConfirmed: boolean;
  /** Manual campaign targets by `${accountId}:${campaignId}`; they win over the automatic rules. */
  campaigns: Record<string, AdsTarget>;
  /** Accounts wholly outside the P&L. */
  outAccounts: string[];
}

export const DEFAULT_SETTINGS: PnlSettings = { usdVnd: 26_000, usdVndConfirmed: false, campaigns: {}, outAccounts: [] };

export type LineKind = 'revenue' | 'deduction' | 'subtotal' | 'cost' | 'result';

export interface PnlLine {
  key: string;
  label: string;
  kind: LineKind;
  /** VND; deductions and costs are positive amounts that are subtracted. */
  value: number;
  /** Where the number comes from, shown on hover / in the detail. */
  source: string;
  /** False for an estimate (e.g. ads fund split across share policies) or a total with missing days. */
  exact: boolean;
  note?: string;
  children?: PnlLine[];
}

export interface PnlKpis {
  grossRevenue: number;
  netRevenue: number;
  retained: number;
  marketing: number;
  netProfit: number;
  /** netProfit / netRevenue; null when there is no revenue. */
  margin: number | null;
  /** (ERP revenue + Whop gross) / Meta Ads in scope. */
  roas: number | null;
  /** Marketing / ERP paid orders. */
  cac: number | null;
  /** ERP revenue / ERP paid orders. */
  aov: number | null;
  erpRevenue: number;
  whopNet: number;
  paidOrders: number;
  registrations: number;
  /** ERP paid orders / registrations. */
  conversion: number | null;
  /** Internal ads fund kept from ERP revenue by the share policies. */
  adsFund: number | null;
  /** Meta Ads in scope / ads fund. */
  adsFundUse: number | null;
}

export interface PnlDay {
  date: string;
  /** Null when ERP has no figure for this day (its revenue may sit in `erp.undated`). */
  erpRevenue: number | null;
  whopNet: number;
  ads: number;
  ai: number;
  ledgerCosts: number;
  /** Profit of the day: ERP kept share + Whop net − Ads − AI − ledger costs; null when ERP is unknown that day. */
  profit: number | null;
}

export interface PnlProgram {
  code: string;
  title: string;
  type: string;
  status: string;
  start: string | null;
  end: string | null;
  registrations: number | null;
  paidOrders: number | null;
  conversion: number | null;
  ads: number;
  /** Meta "results" (leads / registrations as optimised) of the mapped campaigns. */
  adsResults: number;
  cpl: number | null;
  cac: number | null;
  funnel: { registrations: number; checkouts: number; orders: number; paid_orders: number } | null;
  offers: Array<{ code: string; title: string; price: number; orderCount: number | null }>;
  policy: { title: string; adsFundBps: number; roles: Array<{ role: string; bps: number }>; affiliateBps: number; companyBpsNoAffiliate: number } | null;
}

export interface PnlCampaign {
  key: string;
  accountId: string;
  accountName: string;
  campaignId: string;
  name: string;
  spend: number;
  results: number;
  lastDay: string;
  target: AdsTarget;
  /** How the target was chosen. */
  by: 'manual' | 'account' | 'auto' | 'none';
  rule?: string;
}

export interface PnlIssue { level: 'warn' | 'info'; text: string; action?: 'fx' | 'ads' | 'ledger' | 'erp' | 'whop' }

export interface PnlDto {
  range: { preset: PnlPreset; from: string; to: string; days: number; label: string };
  prevRange: { from: string; to: string; label: string };
  generatedAt: string;
  settings: PnlSettings;
  statement: PnlLine[];
  kpis: PnlKpis;
  /** Previous period KPIs; null when ERP does not cover it fully (a comparison would mislead). */
  prev: PnlKpis | null;
  daily: PnlDay[];
  erp: {
    connected: boolean;
    syncedAt: number | null;
    missingDays: string[];
    undated: Array<{ period: string; from: string; to: string; revenue: number; paidOrders: number }>;
    adsFundExact: boolean;
  };
  whop: { connected: boolean; syncedAt: number | null; grossUsd: number; refundedUsd: number; netUsd: number; feesUsd: number };
  programs: PnlProgram[];
  /** Counts not tied to a program (ERP paid orders outside every program, e.g. software). */
  otherOrders: number;
  ads: {
    inScope: number;
    outOfScope: number;
    byTarget: Array<{ target: AdsTarget; label: string; spend: number }>;
    campaigns: PnlCampaign[];
    accounts: Array<{ id: string; name: string; spend: number; out: boolean }>;
  };
  issues: PnlIssue[];
}
