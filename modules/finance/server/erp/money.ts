/**
 * Pure: ERP revenue for any run of Vietnam days.
 *
 * ERP only answers "today / this week / this month", so a range is assembled from what was synced:
 * week / month totals (exact, kept per period in erp_period_totals) that fit inside the range, then the daily rows
 * (erp_daily) for the remaining days. Part of a period total that has no daily row is reported as `undated`, a
 * day nothing covers is listed in `missingDays`; nothing is spread or guessed.
 */

export interface ErpProgramCount { program: string; registrations: number; paid_orders: number }

export interface ErpDailyRow {
  date: string;
  revenue: number;
  paid_orders: number;
  registrations: number;
  company_share: number;
  /** Per-program counts of the day; empty on rows synced before they were kept. */
  programs?: ErpProgramCount[];
}

export interface ErpPeriodRow {
  period: string;
  from_date: string;
  to_date: string;
  revenue: number;
  paid_orders: number;
  registrations: number;
  company_share: number;
  programs: ErpProgramCount[];
}

export interface ErpRange {
  revenue: number;
  paidOrders: number;
  registrations: number;
  companyShare: number;
  /** One row per day of the range; null where the day's own figure is unknown (inside `undated`, or missing). */
  days: Array<{ date: string; revenue: number | null; paidOrders: number | null; companyShare: number | null }>;
  /** Period totals not split by day: the part of a week / month total without daily rows. */
  undated: Array<{ period: string; from: string; to: string; revenue: number; paidOrders: number; companyShare: number }>;
  /** Days no synced figure covers; the totals leave them out. */
  missingDays: string[];
  /** Per-program counts, or null when some covered day has none. */
  programs: ErpProgramCount[] | null;
}

const span = (p: ErpPeriodRow) => Date.parse(p.to_date) - Date.parse(p.from_date);

function addPrograms(into: Map<string, ErpProgramCount>, list: ErpProgramCount[]): void {
  for (const p of list) {
    const cur = into.get(p.program) ?? { program: p.program, registrations: 0, paid_orders: 0 };
    cur.registrations += p.registrations;
    cur.paid_orders += p.paid_orders;
    into.set(p.program, cur);
  }
}

/** Null when nothing synced covers any day of `days` (ascending Vietnam dates). */
export function erpRange(daily: ErpDailyRow[], periods: ErpPeriodRow[], days: string[]): ErpRange | null {
  if (!days.length) return null;
  const first = days[0];
  const last = days[days.length - 1];
  const byDate = new Map(daily.map((r) => [r.date, r]));

  // Largest period totals first, never overlapping one already taken.
  const blocks: ErpPeriodRow[] = [];
  for (const p of periods.filter((x) => x.from_date >= first && x.to_date <= last && x.to_date >= x.from_date).sort((a, b) => span(b) - span(a))) {
    if (blocks.some((b) => p.from_date <= b.to_date && p.to_date >= b.from_date)) continue;
    blocks.push(p);
  }
  const blockOf = (d: string) => blocks.find((b) => d >= b.from_date && d <= b.to_date);

  const out: ErpRange = { revenue: 0, paidOrders: 0, registrations: 0, companyShare: 0, days: [], undated: [], missingDays: [], programs: null };
  const programs = new Map<string, ErpProgramCount>();
  let programsComplete = true;
  let covered = false;

  for (const b of blocks) {
    covered = true;
    out.revenue += b.revenue;
    out.paidOrders += b.paid_orders;
    out.registrations += b.registrations;
    out.companyShare += b.company_share;
    if (b.programs.length || (b.paid_orders === 0 && b.registrations === 0)) addPrograms(programs, b.programs);
    else programsComplete = false;
    const inside = daily.filter((r) => r.date >= b.from_date && r.date <= b.to_date);
    const rest = {
      revenue: b.revenue - inside.reduce((s, r) => s + r.revenue, 0),
      paidOrders: b.paid_orders - inside.reduce((s, r) => s + r.paid_orders, 0),
      companyShare: b.company_share - inside.reduce((s, r) => s + r.company_share, 0),
    };
    if (rest.revenue > 0.5 || rest.paidOrders > 0) {
      out.undated.push({ period: b.period, from: b.from_date, to: b.to_date, revenue: Math.max(0, rest.revenue), paidOrders: Math.max(0, rest.paidOrders), companyShare: Math.max(0, rest.companyShare) });
    }
  }

  for (const d of days) {
    const row = byDate.get(d);
    const inBlock = !!blockOf(d);
    out.days.push({ date: d, revenue: row?.revenue ?? null, paidOrders: row?.paid_orders ?? null, companyShare: row?.company_share ?? null });
    if (inBlock) continue;
    if (!row) { out.missingDays.push(d); continue; }
    covered = true;
    out.revenue += row.revenue;
    out.paidOrders += row.paid_orders;
    out.registrations += row.registrations;
    out.companyShare += row.company_share;
    if (row.programs?.length || (row.paid_orders === 0 && row.registrations === 0)) addPrograms(programs, row.programs ?? []);
    else programsComplete = false;
  }
  if (!covered) return null;
  out.programs = programsComplete ? [...programs.values()] : null;
  return out;
}

export interface ErpMoney {
  revenue: {
    total: number; orders: number; avgOrder: number | null; prevTotal: number | null; currency: string;
    daily: Array<{ date: string; total: number; orders: number | null }>;
    /** First day the totals cover when it is later than the period start, else null. */
    coverageFrom: string | null;
  };
  collected: { total: number; outstanding: null; currency: string };
  validOrders: number;
  prevValidOrders: number | null;
}

/** Command Center money from ERP: totals of `days`, compared with `prevDays` only when those are fully covered. */
export function erpMoney(daily: ErpDailyRow[], periods: ErpPeriodRow[], days: string[], prevDays: string[]): ErpMoney | null {
  const cur = erpRange(daily, periods, days);
  if (!cur) return null;
  const prev = erpRange(daily, periods, prevDays);
  const prevComplete = prev && prev.missingDays.length === 0 ? prev : null;
  const missing = new Set(cur.missingDays);
  return {
    revenue: {
      total: cur.revenue, orders: cur.paidOrders, avgOrder: cur.paidOrders > 0 ? Math.round(cur.revenue / cur.paidOrders) : null,
      prevTotal: prevComplete?.revenue ?? null, currency: 'VND',
      daily: cur.days.map((d) => ({ date: d.date, total: d.revenue ?? 0, orders: d.paidOrders })),
      coverageFrom: missing.size ? (days.find((d) => !missing.has(d)) ?? null) : null,
    },
    collected: { total: cur.revenue, outstanding: null, currency: 'VND' },
    validOrders: cur.paidOrders,
    prevValidOrders: prevComplete?.paidOrders ?? null,
  };
}
