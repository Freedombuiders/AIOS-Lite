import { describe, expect, it } from 'vitest';
import { createWhopSync, mergeWhopSeries, WHOP_READ_TOOLS } from './pnl/whop-sync.js';
import { readWhopDays } from './pnl/store.js';
import { fakeConnector, testDb } from './test-kit.js';

const ts = (date: string) => Date.parse(`${date}T05:00:00Z`) / 1000;

describe('whop daily sync', () => {
  it('merges the three series per Vietnam day', () => {
    const rows = mergeWhopSeries({ gross: [{ timestamp: ts('2026-10-01'), value: 10 }], refunded: [{ timestamp: ts('2026-10-01'), value: 2 }], net: [{ timestamp: ts('2026-10-01'), value: 8 }] });
    expect(rows).toEqual([{ date: '2026-10-01', gross: 10, refunded: 2, net: 8 }]);
  });

  it('is a no-op until configured', async () => {
    const net = fakeConnector({});
    const sync = createWhopSync({ db: testDb(), connect: net.connect, target: () => ({}) });
    expect(await sync.run()).toBe(0);
    expect(net.calls).toEqual([]);
  });

  it('writes rows using read tools only', async () => {
    const db = testDb();
    const point = (v: number) => ({ data: { points: [{ timestamp: ts('2026-10-02'), value: v }] } });
    const net = fakeConnector({
      accounts_list: () => ({ data: [{ id: 'biz_1' }] }),
      'stats_time-series_get': (a) => point(a.metric === 'gross_revenue' ? 10 : a.metric === 'total_refunded' ? 1 : 9),
    });
    const sync = createWhopSync({ db, connect: net.connect, target: () => ({ url: 'https://whop.test/mcp', token: 't' }) });
    expect(await sync.run()).toBe(1);
    expect(net.calls.every((n) => WHOP_READ_TOOLS.has(n))).toBe(true);
    expect(readWhopDays(db, '2026-10-01', '2026-10-31').rows).toEqual([{ date: '2026-10-02', gross: 10, refunded: 1, net: 9 }]);
  });

  it('swallows connector errors', async () => {
    const sync = createWhopSync({ db: testDb(), connect: async () => { throw new Error('offline'); }, target: () => ({ url: 'https://whop.test/mcp' }) });
    expect(await sync.run()).toBe(0);
  });
});
