import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import zaloWeb from '../index';
import { ZaloOverview, type ZaloOverviewData } from './ZaloOverview';

const range = { days: 2, from: '2026-10-10', to: '2026-10-11', prevFrom: '2026-10-08', prevTo: '2026-10-09' };
const host = document.createElement('div'); document.body.append(host);
afterEach(() => { act(() => render(null, host)); vi.unstubAllGlobals(); });

const period = { customers: 5, newCustomers: 4, customerMessages: 6, replies: 3, answeredRate: 0.5, medianResponseMin: 20, aiShare: 1 / 3 };
function stub(data: Partial<ZaloOverviewData>) {
  const body: ZaloOverviewData = {
    hasAccount: true, current: period, previous: { ...period, customers: 2 },
    series: [{ date: '2026-10-10', customerMessages: 6, replies: 2, newCustomers: 4 }, { date: '2026-10-11', customerMessages: 0, replies: 1, newCustomers: 0 }],
    waiting: { count: 2, over30m: 1, top: [{ threadId: 1, name: 'Khách An', accountId: 'a1', accountName: 'Nick 1', minutes: 90 }] },
    ...data,
  };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })));
  return vi.mocked(fetch);
}
async function mount() {
  await act(async () => { render(<ZaloOverview range={range} />, host); });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}

describe('zalo overview widget', () => {
  it('registers in the overview slot', () => {
    expect(zaloWeb.widgets?.[0]).toMatchObject({ slot: 'overview', id: 'zalo-overview', order: 30, title: 'Bán hàng qua Zalo' });
  });

  it('shows KPIs, the waiting list and the legend', async () => {
    const f = stub({});
    await mount();
    expect(String(f.mock.calls[0]![0])).toContain('/api/m/zalo/overview?from=2026-10-10');
    expect(String(f.mock.calls[0]![0])).toContain('groups=0');
    const t = host.textContent ?? '';
    for (const s of ['Khách nhắn tin', 'Khách mới', 'Tỉ lệ được trả lời', 'Thời gian phản hồi', 'AI trả lời', 'Khách An', 'Tin khách gửi', 'Chờ quá 30 phút', 'Gồm cả nhóm']) expect(t).toContain(s);
    expect(t).toContain('50%');
    expect(t).toContain('20 ph');
  });

  it('shows an empty state linking to the accounts page when there is no account', async () => {
    stub({ hasAccount: false, current: { ...period, customerMessages: 0, replies: 0 }, waiting: { count: 0, over30m: 0, top: [] } });
    await mount();
    expect(host.textContent).toContain('Chưa kết nối tài khoản Zalo');
    expect(host.textContent).toContain('chưa được theo dõi từ Zalo');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/m/zalo');
  });
});
