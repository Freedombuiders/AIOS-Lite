import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createFinanceModule } from './index.js';
import { ERP_READ_TOOLS } from './erp/sync.js';
import { fakeConnector, fakeCtx, summaryOf, testDb } from './test-kit.js';
import { vnToday } from './profit/ledger.js';

const today = vnToday();
const month = `${today.slice(0, 7)}-01`;
const erpHandlers = {
  business_summary: (a: Record<string, unknown>) => a.period === 'today' ? summaryOf('today', today, today, 1_000_000, 2)
    : a.period === 'week' ? summaryOf('week', month, today, 1_000_000, 2) : summaryOf('month', month, today, 1_000_000, 2),
  list_unmatched_transfers: () => ({ items: [] }),
  list_partner_statements: () => ({ items: [] }),
  list_my_unpaid_orders: () => ({ items: [] }),
  list_programs: () => ({ programs: [] }),
  list_offers: () => ({ offers: [] }),
  list_share_policies: () => ({ policies: [] }),
};

function setup(settings: Record<string, unknown> = {}, handlers = erpHandlers) {
  const db = testDb({ ads: true });
  const k = fakeCtx(db, settings);
  const net = fakeConnector(handlers);
  const mod = createFinanceModule(net.connect);
  const app = new Hono();
  mod.routes!(app, k.ctx);
  const json = (path: string, method = 'GET', body?: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { db, mod, app, json, net, ...k };
}

describe('ledger routes', () => {
  it('saves a validated ledger and rejects stale or invalid saves in Vietnamese', async () => {
    const { json } = setup();
    const first = await (await json('/profit')).json() as { document: { startDate: string }; revision: string };
    expect((await json('/profit', 'PUT', { document: first.document, revision: first.revision })).status).toBe(200);
    const stale = await json('/profit', 'PUT', { document: first.document, revision: first.revision });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toContain('phiên khác');
    const bad = await json('/profit', 'PUT', { document: { ...first.document, openingCash: 'x' }, revision: '' });
    expect(bad.status).toBe(400);
  });

  it('adds an entry, validating the amount', async () => {
    const { json, emitted } = setup();
    const ok = await json('/profit/entries', 'POST', { kind: 'overhead', amount: 250000, note: 'Hosting' });
    expect(ok.status).toBe(201);
    expect(emitted).toContain('changed');
    for (const amount of [0, -5, 'abc', null]) {
      const res = await json('/profit/entries', 'POST', { kind: 'overhead', amount, note: 'x' });
      expect(res.status).toBe(400);
    }
    const noNote = await json('/profit/entries', 'POST', { kind: 'overhead', amount: 5, note: ' ' });
    expect(((await noNote.json()) as { error: string }).error).toContain('ghi chú');
    const kind = await json('/profit/entries', 'POST', { kind: 'nope', amount: 5, note: 'x' });
    expect(((await kind.json()) as { error: string }).error).toContain('Loại khoản');
  });

  it('imports ad spend idempotently, keeping history and the account residual', async () => {
    const { db, json } = setup();
    db.prepare("INSERT INTO fb_ad_accounts VALUES ('a','Meta','USD','UTC',1)").run();
    const day = db.prepare('INSERT INTO fb_ads_daily (account_id, level, object_id, name, day, spend, captured_at) VALUES (?,?,?,?,?,?,?)');
    day.run('a', 'account', 'a', '', '2026-01-01', 20, 1);
    day.run('a', 'campaign', 'c', 'Course', '2026-01-01', 15, 1);
    const sync = async () => ((await (await json('/profit/ads-import', 'POST')).json()) as { ads: Array<{ spend: number }> }).ads;
    expect((await sync()).reduce((s, x) => s + x.spend, 0)).toBe(20);
    expect((await sync()).length).toBe(2);
    day.run('a', 'campaign', 'c', 'Course', '2026-01-02', 12, 2);
    expect((await sync()).reduce((s, x) => s + x.spend, 0)).toBe(32);
  });

  it('summarises the month for the dashboard widget', async () => {
    const { json } = setup();
    await json('/profit/entries', 'POST', { kind: 'revenue', amount: 1_000_000, note: 'Học phí' });
    await json('/profit/entries', 'POST', { kind: 'direct', amount: 300_000, note: 'Chi phí giảng viên' });
    const { month: m } = await (await json('/summary')).json() as { month: { revenue: number; costs: number; profit: number; cashIn: number; cashOut: number } };
    expect(m).toMatchObject({ revenue: 1_000_000, costs: 300_000, profit: 700_000, cashIn: 1_000_000, cashOut: 300_000 });
  });
});

describe('P&L and ERP (read-only, fake MCP)', () => {
  it('serves a P&L without ERP configured and reports it as not connected', async () => {
    const { json } = setup();
    const dto = await (await json('/pnl?preset=month')).json() as { erp: { connected: boolean }; statement: unknown[] };
    expect(dto.erp.connected).toBe(false);
    expect((await json('/pnl?preset=bad')).status).toBe(400);
    expect((await json('/erp')).status).toBe(200);
  });

  it('syncs ERP through the allowlist only and feeds the P&L', async () => {
    const { json, net } = setup({ erp_mcp_url: 'https://erp.test/mcp', erp_mcp_token: 't' });
    const res = await json('/erp/sync', 'POST');
    expect(res.status).toBe(200);
    expect(net.calls.length).toBeGreaterThan(0);
    expect(net.calls.every((name) => ERP_READ_TOOLS.has(name))).toBe(true);
    const erp = await (await json('/erp')).json() as { hub: { status: string }; summaries: { month: { payload: { revenue: number } } } };
    expect(erp.hub.status).toBe('ok');
    expect(erp.summaries.month.payload.revenue).toBe(1_000_000);
    const dto = await (await json('/pnl?preset=month')).json() as { kpis: { erpRevenue: number }; erp: { connected: boolean } };
    expect(dto.erp.connected).toBe(true);
    expect(dto.kpis.erpRevenue).toBe(1_000_000);
    expect((await json('/erp/sync', 'POST')).status).toBe(429);
  });

  it('records a failure when the ERP is unreachable instead of throwing', async () => {
    const { json } = setup({ erp_mcp_url: 'https://erp.test/mcp' }, { ...erpHandlers, business_summary: () => { throw new Error('boom'); } });
    const res = await json('/erp/sync', 'POST');
    expect(res.status).toBe(422);
    expect(((await res.json()) as { status: { error: string } }).status.error).toContain('ERP');
  });
});

describe('agents', () => {
  it('gives the monthly summary only to agents holding a finance scope', async () => {
    const { mod, ctx } = setup();
    const input = (scopes: string[]) => ({ agent: {} as never, task: {} as never, scopes });
    expect(await mod.agentContext!(input([]), ctx)).toBeUndefined();
    const text = await mod.agentContext!(input(['finance.read']), ctx);
    expect(text).toContain('Tài chính tháng');
    expect(String(text).length).toBeLessThan(3000);
  });

  it('ledger.add needs finance.write and returns Vietnamese errors', async () => {
    const { mod, ctx, db, audit } = setup();
    const action = mod.actions!['ledger.add']!;
    expect(action.scope).toBe('finance.write');
    const call = { agentId: 'bot', taskId: 1, runId: null };
    const res = await action.handler({ kind: 'revenue', amount: 500000, note: 'Đơn DH-1' }, call, ctx) as { ok: boolean; id: string };
    expect(res.ok).toBe(true);
    expect(audit).toContainEqual({ action: 'ledger.add', actor: 'bot' });
    expect((db.prepare("SELECT value FROM finance_kv WHERE key = 'profit.document.v1'").get() as { value: string }).value).toContain('Đơn DH-1');
    await expect(action.handler({ kind: 'revenue', amount: -1, note: 'x' }, call, ctx)).rejects.toThrow('lớn hơn 0');
    await expect(action.handler({ kind: 'revenue', amount: 1e20, note: 'x' }, call, ctx)).rejects.toThrow('quá lớn');
    await expect(action.handler({ kind: 'revenue', amount: 5, note: 'x', date: '2026-13-40' }, call, ctx)).rejects.toThrow('Ngày không hợp lệ');
  });

  it('schedules ERP and Whop syncs and stops them on Remove', () => {
    const { mod, ctx } = setup();
    const stops: string[] = [];
    (ctx.schedule as { every: unknown }).every = (name: string) => () => { stops.push(name); };
    mod.start!(ctx); mod.start!(ctx);
    expect(stops.sort()).toEqual(['erp-sync', 'whop-sync']);
    mod.stop!(ctx);
    expect(stops.length).toBe(4);
  });
});
