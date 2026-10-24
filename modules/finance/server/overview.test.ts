import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { ModuleContext } from '../../../src/modules/sdk.js';
import { createFinanceModule } from './index.js';
import { fakeConnector, fakeCtx, summaryOf, testDb } from './test-kit.js';
import { addDays } from './pnl/engine.js';
import { vnToday } from './profit/ledger.js';
import type { OverviewDto } from './overview.js';

const today = vnToday();
const from = addDays(today, -2);
const q = `from=${from}&to=${today}&prevFrom=${addDays(from, -3)}&prevTo=${addDays(from, -1)}`;
const erpHandlers = {
  business_summary: (a: Record<string, unknown>) => summaryOf(a.period as 'today', from, today, 3_000_000, 3),
  list_unmatched_transfers: () => ({ items: [] }), list_partner_statements: () => ({ items: [] }), list_my_unpaid_orders: () => ({ items: [] }),
  list_programs: () => ({ programs: [] }), list_offers: () => ({ offers: [] }), list_share_policies: () => ({ policies: [] }),
};

function setup(opts: { pancake?: (cmd: string) => unknown | Promise<unknown>; erp?: boolean } = {}) {
  const db = testDb({ ads: true });
  const k = fakeCtx(db, opts.erp ? { erp_mcp_url: 'https://erp.test/mcp', erp_mcp_token: 't' } : {});
  const reads: string[] = [];
  (k.ctx as { integrations: unknown }).integrations = {
    values: (id: string) => (id === 'pancake' && opts.pancake ? { pos_api_key: 'x' } : null),
    read: async (_id: string, cmd: string) => { reads.push(cmd); return opts.pancake!(cmd); },
  };
  const mod = createFinanceModule(fakeConnector(erpHandlers).connect);
  const app = new Hono();
  mod.routes!(app, k.ctx as ModuleContext);
  db.prepare('INSERT INTO fb_ad_accounts (id, name, currency, timezone, synced_at) VALUES (?, ?, ?, ?, ?)').run('a1', 'Acc', 'VND', 'Asia/Ho_Chi_Minh', 1_800_000_000);
  db.prepare("INSERT INTO fb_ads_daily (account_id, level, object_id, name, day, spend) VALUES ('a1', 'account', 'a1', 'Acc', ?, 500000)").run(today);
  return { app, reads, db };
}
const get = async (app: Hono, qs = q) => { const r = await app.request(`/overview?${qs}`); return { status: r.status, body: await r.json() as OverviewDto & { error?: string } }; };
const order = (day: string, total: number, code = 1) => ({ createdAt: `${day}T05:00:00.000Z`, total, status: { code } });

describe('GET /overview', () => {
  it('reports unknown revenue as null when nothing is connected, but still shows ads spend', async () => {
    const { app } = setup();
    const { status, body } = await get(app);
    expect(status).toBe(200);
    expect(body.current.revenue).toBeNull();
    expect(body.current.profit).toBeNull();
    expect(body.current.roas).toBeNull();
    expect(body.current.orders).toBeNull();
    expect(body.current.costs.ads).toBe(500_000);
    expect(body.current.daily).toHaveLength(3);
    expect(body.sources.map((s) => [s.id, s.connected])).toEqual([['erp', false], ['whop', false], ['pancake', false], ['meta_ads', true]]);
  });

  it('adds Pancake orders (skipping canceled), orders, AOV, ROAS and profit, and caches for 10 minutes', async () => {
    const { app, reads } = setup({ pancake: () => ({ items: [order(today, 1_000_000), order(today, 500_000, 5), order(from, 2_000_000)] }) });
    const { body } = await get(app);
    expect(body.current.revenueBySource.pancake).toBe(3_000_000);
    expect(body.current.orders).toBe(2);
    expect(body.current.aov).toBe(1_500_000);
    expect(body.current.revenue).toBe(3_000_000);
    expect(body.current.roas).toBe(6);
    expect(body.current.profit).toBe(3_000_000 - 500_000);
    expect(body.previous.revenue).toBe(0);
    expect(body.sources.find((s) => s.id === 'pancake')?.connected).toBe(true);
    const n = reads.length;
    await get(app);
    expect(reads.length).toBe(n);
  });

  it('keeps the response when Pancake fails and says why', async () => {
    const { app } = setup({ pancake: () => { throw new Error('401 key sai'); } });
    const { status, body } = await get(app);
    expect(status).toBe(200);
    const p = body.sources.find((s) => s.id === 'pancake')!;
    expect(p.connected).toBe(false);
    expect(p.detail).toContain('401 key sai');
    expect(body.current.revenueBySource.pancake).toBeNull();
    expect(body.current.costs.ads).toBe(500_000);
  });

  it('profit equals the P&L net profit when Pancake is off, and adds Pancake sales when on', async () => {
    const off = setup({ erp: true });
    await off.app.request('/erp/sync', { method: 'POST' });
    const pnl = await (await off.app.request(`/pnl?preset=custom&from=${from}&to=${today}`)).json() as { kpis: { netProfit: number } };
    const o = (await get(off.app)).body;
    expect(o.current.profit).toBe(pnl.kpis.netProfit);
    const on = setup({ erp: true, pancake: () => ({ items: [order(today, 1_000_000)] }) });
    await on.app.request('/erp/sync', { method: 'POST' });
    const b = (await get(on.app)).body;
    expect(b.current.profit).toBe(pnl.kpis.netProfit + 1_000_000);
    expect(b.sources.find((s) => s.id === 'pancake')?.detail).toContain('tính hai lần');
  });

  it('includes ERP revenue once synced', async () => {
    const { app } = setup({ erp: true });
    await app.request('/erp/sync', { method: 'POST' });
    const { body } = await get(app);
    expect(body.sources.find((s) => s.id === 'erp')?.connected).toBe(true);
    expect(body.current.revenueBySource.erp).not.toBeNull();
  });

  it('validates dates and the 366 day limit', async () => {
    const { app } = setup();
    expect((await get(app, 'from=nope&to=x&prevFrom=y&prevTo=z')).status).toBe(400);
    expect((await get(app, `from=${today}&to=${from}&prevFrom=${from}&prevTo=${from}`)).status).toBe(400);
    expect((await get(app, `from=2020-01-01&to=${today}&prevFrom=2019-01-01&prevTo=2019-12-31`)).status).toBe(400);
  });
});
