import { describe, expect, it } from 'vitest';
import type { ErpCatalog } from '../erp/sync.js';
import { adsFundRate, autoTarget, buildPnl, splitAds, type AdsRow, type PnlInputs } from './engine.js';
import { resolveRange } from './range.js';
import { DEFAULT_SETTINGS } from './types.js';

const PROGRAMS = new Set(['6x-ai-facebook-income', '5days-ai-agent', 'second-brain-sme', 'chuong-trinh-edit-video', 'skill-edit-video-free']);

const catalog: ErpCatalog = {
  programs: [...PROGRAMS].map((code) => ({ code, title: code, type: 'Workshop', status: 'Open', start: null, end: null })),
  offers: [
    { code: '6x_hoc_sau', title: '6X Học Sâu', price: 199_000, program: '6x-ai-facebook-income', policy: 'cs-sb', orderCount: 7 },
    { code: '6x_thuc_chien', title: '6X Thực Chiến', price: 499_000, program: '6x-ai-facebook-income', policy: 'cs-sb', orderCount: 5 },
    { code: 'reel', title: 'ReelStudio', price: 1_000_000, program: null, policy: 'cs-reel', orderCount: 1 },
  ],
  policies: [
    { policy: 'cs-sb', title: 'SB', adsFundBps: 3000, roles: [{ role: 'Author', bps: 2000 }], affiliateBps: 1000, companyBpsNoAffiliate: 4500, companyBpsWithAffiliate: 3600 },
    { policy: 'cs-reel', title: 'Reel', adsFundBps: 0, roles: [], affiliateBps: 0, companyBpsNoAffiliate: 10_000, companyBpsWithAffiliate: 10_000 },
  ],
  funnels: { '6x-ai-facebook-income': { registrations: 118, checkouts: 12, orders: 12, paid_orders: 3 } },
};

describe('autoTarget', () => {
  it('maps the real campaign names', () => {
    expect(autoTarget('Băng Nhi 1', '6X INCOME FACEBOOK - MẪU', PROGRAMS)?.target).toBe('6x-ai-facebook-income');
    expect(autoTarget('x', '29/8- workshop 5 ngày - mẫu', PROGRAMS)?.target).toBe('5days-ai-agent');
    expect(autoTarget('x', '[17/09] workshop 5 day - Test content win', PROGRAMS)?.target).toBe('5days-ai-agent');
    expect(autoTarget('x', 'CD 18/10 tôi nhớ đã lưu ở đâu', PROGRAMS)?.target).toBe('second-brain-sme');
    expect(autoTarget('Amz Global', 'amz 2 HN 21/10', PROGRAMS)?.target).toBe('out');
    expect(autoTarget('x', 'cd video 30/8 video', PROGRAMS)).toBeNull();
  });

  it('skips a program rule when the program does not exist', () => {
    expect(autoTarget('x', '6X', new Set())).toBeNull();
  });
});

describe('splitAds', () => {
  const r = (level: AdsRow['level'], objectId: string, name: string, day: string, spend: number, accountName = 'A', accountId = 'act_a'): AdsRow =>
    ({ accountId, accountName, currency: 'VND', level, objectId, name, day, spend, results: 1 });

  it('applies manual > out account > auto > unassigned and keeps account residuals as shared', () => {
    const rows = [
      r('campaign', 'c1', '6X ads', '2026-10-20', 100), r('campaign', 'c2', 'cd video', '2026-10-20', 50), r('account', 'act_a', 'A', '2026-10-20', 200),
      r('campaign', 'c3', 'amz 1', '2026-10-20', 70, 'Amz Global', 'act_z'),
    ];
    const s = splitAds(rows, { ...DEFAULT_SETTINGS, campaigns: { 'act_a:c2': 'second-brain-sme' } }, PROGRAMS, '2026-10-20', '2026-10-20');
    expect(s.byTarget.get('6x-ai-facebook-income')?.spend).toBe(100);
    expect(s.byTarget.get('second-brain-sme')?.spend).toBe(50);
    expect(s.byTarget.get('shared')?.spend).toBe(50);
    expect(s.byTarget.get('out')?.spend).toBe(70);
    expect(s.byDay.get('2026-10-20')).toBe(200);
    expect(s.campaigns.find((c) => c.campaignId === 'c2')?.by).toBe('manual');
  });
});

describe('adsFundRate', () => {
  it('is exact when every order is under one rate', () => {
    expect(adsFundRate(catalog, [{ program: '6x-ai-facebook-income', registrations: 117, paid_orders: 3 }], 3)).toEqual({ bps: 3000, exact: true });
  });
  it('weights by orders and says it is an estimate when rates differ', () => {
    expect(adsFundRate(catalog, [{ program: '6x-ai-facebook-income', registrations: 1, paid_orders: 3 }], 4)).toEqual({ bps: 2250, exact: false });
  });
  it('is null without a catalog', () => {
    expect(adsFundRate(null, null, 3)).toBeNull();
  });
});

describe('buildPnl', () => {
  const range = resolveRange('month', '2026-10-21')!;
  const inputs: PnlInputs = {
    preset: 'month', ...range,
    settings: { ...DEFAULT_SETTINGS, usdVnd: 25_000, usdVndConfirmed: true },
    erp: {
      connected: true, syncedAt: 1, catalog,
      daily: [{ date: '2026-10-21', revenue: 0, paid_orders: 0, registrations: 101, company_share: 0, programs: [] }],
      periods: [{ period: 'month', from_date: '2026-10-01', to_date: '2026-10-21', revenue: 897_000, paid_orders: 3, registrations: 389, company_share: 565_110, programs: [{ program: '6x-ai-facebook-income', registrations: 117, paid_orders: 3 }] }],
    },
    whop: { connected: true, syncedAt: 1, daily: [{ date: '2026-10-10', gross: 100, refunded: 10, net: 60 }] },
    ads: [{ accountId: 'a', accountName: 'Băng Nhi 1', currency: 'VND', level: 'campaign', objectId: 'c', name: '6X INCOME', day: '2026-10-10', spend: 1_000_000, results: 40 }],
    ledger: null,
    aiUsdByDay: { '2026-10-10': 2 },
    nowIso: '2026-10-21T15:00:00Z',
  };
  const dto = buildPnl(inputs);
  const line = (key: string) => dto.statement.find((l) => l.key === key)!;

  it('splits ERP revenue into partners, ads fund and company share', () => {
    expect(dto.kpis.erpRevenue).toBe(897_000);
    expect(dto.kpis.adsFund).toBeCloseTo(269_100);
    expect(line('partners').value).toBeCloseTo(897_000 - 565_110 - 269_100);
    expect(line('partners').exact).toBe(true);
  });

  it('builds the statement down to net profit', () => {
    const whopGross = 100 * 25_000;
    expect(line('gross').value).toBe(897_000 + whopGross);
    expect(line('deductions').value).toBe((10 + 30) * 25_000);
    const retained = 897_000 + 60 * 25_000 - 62_790;
    expect(line('retained').value).toBeCloseTo(retained);
    expect(line('marketing').value).toBe(1_000_000);
    expect(line('operating').value).toBe(50_000);
    expect(line('netProfit').value).toBeCloseTo(retained - 1_000_000 - 50_000);
    expect(dto.kpis.cac).toBeCloseTo(1_000_000 / 3);
  });

  it('per program: counts, ads, CPL, CAC and the policy', () => {
    const p = dto.programs.find((x) => x.code === '6x-ai-facebook-income')!;
    expect(p).toMatchObject({ registrations: 117, paidOrders: 3, ads: 1_000_000, adsResults: 40 });
    expect(p.cac).toBeCloseTo(333_333.33, 0);
    expect(p.policy?.adsFundBps).toBe(3000);
  });

  it('flags a missing comparison instead of comparing with nothing', () => {
    expect(dto.prev).toBeNull();
    expect(dto.issues.some((i) => i.action === 'ledger')).toBe(true);
  });
});

describe('resolveRange', () => {
  it('month compares with the same days of last month; week starts Monday', () => {
    expect(resolveRange('month', '2026-10-21')).toMatchObject({ from: '2026-10-01', to: '2026-10-21', prevFrom: '2026-09-01', prevTo: '2026-09-21' });
    expect(resolveRange('week', '2026-10-21')).toMatchObject({ from: '2026-10-19', prevFrom: '2026-10-12', prevTo: '2026-10-14' });
    expect(resolveRange('last_month', '2026-03-15')).toMatchObject({ from: '2026-02-01', to: '2026-02-28', prevFrom: '2026-01-01', prevTo: '2026-01-31' });
    expect(resolveRange('custom', '2026-10-21', { from: '2026-10-22', to: '2026-10-23' })).toBeNull();
  });
});
