import { describe, expect, it } from 'vitest';
import { erpMoney, erpRange, type ErpDailyRow, type ErpPeriodRow } from './money.js';
import { correctedYesterday, policyRates, type ErpSummary } from './sync.js';

const row = (date: string, revenue: number, paid_orders = 1): ErpDailyRow => ({ date, revenue, paid_orders, registrations: 2, company_share: revenue / 2, programs: [] });
const summary = (period: ErpSummary['period'], from_date: string, to_date: string, revenue: number, paid_orders: number): ErpSummary =>
  ({ period, from_date, to_date, revenue, paid_orders, registrations: 2 * paid_orders, company_share: revenue / 2 });
const block = (period: string, from_date: string, to_date: string, revenue: number, paid_orders: number): ErpPeriodRow =>
  ({ period, from_date, to_date, revenue, paid_orders, registrations: 10, company_share: revenue * 0.63, programs: [{ program: 'p', registrations: 10, paid_orders }] });
const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));

describe('erpRange', () => {
  it('is null when nothing synced covers the range', () => {
    expect(erpRange([row('2026-10-01', 5)], [], days('2026-10-19', 3))).toBeNull();
  });

  it('uses a month total that fits the range and reports the undated part', () => {
    const r = erpRange([row('2026-10-21', 0, 0)], [block('month', '2026-10-01', '2026-10-21', 897_000, 3)], days('2026-10-01', 21))!;
    expect(r.revenue).toBe(897_000);
    expect(r.paidOrders).toBe(3);
    expect(r.missingDays).toEqual([]);
    expect(r.undated).toEqual([{ period: 'month', from: '2026-10-01', to: '2026-10-21', revenue: 897_000, paidOrders: 3, companyShare: 565_110 }]);
    expect(r.programs).toEqual([{ program: 'p', registrations: 10, paid_orders: 3 }]);
  });

  it('adds daily rows outside the block and lists days nothing covers', () => {
    const r = erpRange([row('2026-09-29', 100)], [block('month', '2026-10-01', '2026-10-21', 897_000, 3)], days('2026-09-28', 24))!;
    expect(r.revenue).toBe(897_100);
    expect(r.missingDays).toEqual(['2026-09-28', '2026-09-30']);
  });

  it('prefers the larger block and never double counts an overlapping week', () => {
    const r = erpRange([], [block('week', '2026-10-19', '2026-10-21', 897_000, 3), block('month', '2026-10-01', '2026-10-21', 897_000, 3)], days('2026-10-01', 21))!;
    expect(r.revenue).toBe(897_000);
  });

  it('a block that ends after the range is not used', () => {
    const r = erpRange([row('2026-10-20', 7)], [block('month', '2026-10-01', '2026-10-21', 897_000, 3)], days('2026-10-19', 2))!;
    expect(r.revenue).toBe(7);
    expect(r.missingDays).toEqual(['2026-10-19']);
  });
});

describe('erpMoney', () => {
  it('compares with the previous period only when it is fully covered', () => {
    const daily = days('2026-10-16', 6).map((d) => row(d, 100));
    const m = erpMoney(daily, [], days('2026-10-19', 3), days('2026-10-16', 3))!;
    expect(m.revenue.total).toBe(300);
    expect(m.revenue.prevTotal).toBe(300);
    expect(m.revenue.coverageFrom).toBeNull();
    const partial = erpMoney(daily.slice(4), [], days('2026-10-19', 3), days('2026-10-16', 3))!;
    expect(partial.revenue.prevTotal).toBeNull();
    expect(partial.revenue.coverageFrom).toBe('2026-10-20');
  });
});

describe('correctedYesterday', () => {
  const today = summary('today', '2026-10-21', '2026-10-21', 100, 1);

  it('derives yesterday from the week when every earlier day is known', () => {
    const week = summary('week', '2026-10-19', '2026-10-21', 1000, 6);
    expect(correctedYesterday([week], today, [row('2026-10-19', 400, 2)])).toMatchObject({ date: '2026-10-20', revenue: 500, paid_orders: 3 });
  });

  it('gives up when an earlier day is missing or the result would be negative', () => {
    expect(correctedYesterday([summary('week', '2026-10-19', '2026-10-21', 1000, 6)], today, [])).toBeNull();
    expect(correctedYesterday([summary('week', '2026-10-20', '2026-10-21', 50, 1)], today, [])).toBeNull();
  });
});

describe('policyRates', () => {
  it('reads the ads fund, paid roles and affiliate share in basis points', () => {
    const line = (role: string, amount: number) => ({ key: [1, role] as [number, string], amount });
    const r = policyRates('cs', 'CS', {
      without_affiliate: { company_amount: 450_000, lines: [line('AdsFund', 300_000), line('Author', 200_000), line('Instructor', 50_000)] },
      with_affiliate: { company_amount: 360_000, lines: [line('AdsFund', 300_000), line('Affiliate', 100_000), line('Author', 200_000), line('Instructor', 40_000)] },
    });
    expect(r).toEqual({
      policy: 'cs', title: 'CS', adsFundBps: 3000, roles: [{ role: 'Author', bps: 2000 }, { role: 'Instructor', bps: 500 }],
      affiliateBps: 1000, companyBpsNoAffiliate: 4500, companyBpsWithAffiliate: 3600,
    });
  });
});
