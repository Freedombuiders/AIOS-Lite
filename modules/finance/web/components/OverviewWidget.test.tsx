import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Router } from 'wouter-preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverviewWidget } from './OverviewWidget';

let n = 0; // useFetch caches by URL, so each test needs its own range
const rangeOf = () => ({ ...range, prevTo: `2026-10-${String(10 + ++n).padStart(2, '0')}` });
const range = { days: 2, from: '2026-10-23', to: '2026-10-24', prevFrom: '2026-10-21', prevTo: '2026-10-22' };
const day = (date: string, revenue: number | null, ads: number) => ({ date, erp: null, whop: null, pancake: revenue, revenue, ads, ai: 0, ledger: 0, cost: ads, profit: revenue === null ? null : revenue - ads });
const period = (revenue: number | null, ads: number) => ({
  from: '', to: '', revenue, revenueBySource: { erp: null, whop: null, pancake: revenue }, orders: revenue === null ? null : 4, aov: revenue === null ? null : revenue / 4,
  costs: { ads, ai: 0, ledger: 0, total: ads }, profit: revenue === null ? null : revenue - ads, roas: revenue === null || !ads ? null : revenue / ads,
  daily: [day('2026-10-23', revenue, ads / 2), day('2026-10-24', revenue, ads / 2)],
});
const src = (pancake: boolean) => [
  { id: 'erp', label: 'ERP', connected: false, detail: '', lastSync: null }, { id: 'whop', label: 'Whop', connected: false, detail: '', lastSync: null },
  { id: 'pancake', label: 'Pancake', connected: pancake, detail: '', lastSync: null }, { id: 'meta_ads', label: 'Meta Ads', connected: true, detail: '', lastSync: null },
];

async function mount(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })));
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(() => render(<Router><OverviewWidget range={rangeOf()} /></Router>, el));
  for (let i = 0; i < 30 && !/Doanh thu/.test(el.textContent ?? ''); i++) await act(() => new Promise((r) => setTimeout(r, 50)));
  return el;
}

describe('OverviewWidget', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows KPIs, chart and cost breakdown when a revenue source is connected', async () => {
    const el = await mount({ current: period(8_000_000, 2_000_000), previous: period(4_000_000, 2_000_000), sources: src(true), generatedAt: '' });
    const t = el.textContent ?? '';
    expect(t).toContain('Lợi nhuận ước tính');
    expect(t).toContain('ROAS');
    expect(t).toContain('Đơn hàng');
    expect(t).toContain('Doanh thu và chi phí theo ngày');
    expect(t).toContain('Quảng cáo Meta');
    expect(el.querySelectorAll('[role="group"] button')).toHaveLength(2);
    expect(t).not.toContain('Chưa có nguồn doanh thu');
  });

  it('says plainly when no revenue source is connected and links to the settings', async () => {
    const el = await mount({ current: period(null, 2_000_000), previous: period(null, 0), sources: src(false), generatedAt: '' });
    expect(el.textContent).toContain('Chưa có nguồn doanh thu nào được kết nối');
    const hrefs = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/modules');
    expect(hrefs).toContain('/connections');
    expect(el.textContent).not.toContain('Đơn hàng');
  });
});
