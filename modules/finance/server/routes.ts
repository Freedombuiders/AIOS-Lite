import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ModuleContext } from '../../../src/modules/sdk.js';
import { readSnapshot, readDaily } from './erp/store.js';
import type { ErpSummary, ErpSync, ErpSyncStatus } from './erp/sync.js';
import { datesBetween, buildPnl } from './pnl/engine.js';
import { buildOverview } from './overview.js';
import { isDate, resolveRange } from './pnl/range.js';
import { readInputs, readSettings, settingsSchema, writeSettings } from './pnl/store.js';
import { PNL_PRESETS, type PnlPreset } from './pnl/types.js';
import type { WhopSync } from './pnl/whop-sync.js';
import { addEntry, importAds, LedgerError, listAdAccounts, readArchivedAds, readDocument, readRevision, saveDocument, vnToday } from './profit/ledger.js';
import { monthLedger } from './summary.js';

const REFRESH_MIN_INTERVAL_MS = 60_000;
const ERP_MANUAL_MIN_INTERVAL_SEC = 60;

export function registerFinanceRoutes(app: Hono, ctx: ModuleContext, erp: ErpSync, whop: WhopSync) {
  const db = ctx.db;
  let lastRefresh = 0;
  const flags = () => ({ erpConnected: erp.configured(), whopConnected: whop.configured() });
  const fail = (c: { json: (b: unknown, s?: number) => Response }, err: unknown) => {
    if (err instanceof LedgerError) return c.json({ error: err.message }, err.status);
    throw err;
  };

  // ── P&L ──
  app.get('/pnl', (c) => {
    const preset = (c.req.query('preset') ?? 'month') as PnlPreset;
    if (!PNL_PRESETS.includes(preset)) return c.json({ error: 'Kỳ không hợp lệ.' }, 400);
    const range = resolveRange(preset, vnToday(), { from: c.req.query('from'), to: c.req.query('to') });
    if (!range) return c.json({ error: 'Khoảng ngày không hợp lệ (tối đa 366 ngày, không quá hôm nay).' }, 400);
    return c.json(buildPnl(readInputs(db, { preset, ...range }, flags())));
  });

  /** Tổng quan section: revenue vs costs per day for the period and the one before it. */
  app.get('/overview', async (c) => {
    const q = { from: c.req.query('from'), to: c.req.query('to'), prevFrom: c.req.query('prevFrom'), prevTo: c.req.query('prevTo') };
    if (!isDate(q.from) || !isDate(q.to) || !isDate(q.prevFrom) || !isDate(q.prevTo) || q.from > q.to || q.prevFrom > q.prevTo) {
      return c.json({ error: 'Khoảng ngày không hợp lệ.' }, 400);
    }
    if (datesBetween(q.from, q.to).length > 366 || datesBetween(q.prevFrom, q.prevTo).length > 366) {
      return c.json({ error: 'Khoảng ngày tối đa 366 ngày.' }, 400);
    }
    return c.json(await buildOverview(ctx, { from: q.from, to: q.to, prevFrom: q.prevFrom, prevTo: q.prevTo }, flags()));
  });

  app.put('/pnl/settings', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = settingsSchema.safeParse({ ...readSettings(db), ...(body ?? {}) });
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
    writeSettings(db, parsed.data);
    return c.json({ settings: parsed.data });
  });

  /** Pull ERP (with its catalog) and Whop now. */
  app.post('/pnl/refresh', async (c) => {
    if (Date.now() - lastRefresh < REFRESH_MIN_INTERVAL_MS) return c.json({ error: 'Vừa cập nhật xong, thử lại sau một phút.' }, 429);
    lastRefresh = Date.now();
    const [erpStatus, whopDays] = await Promise.all([erp.run({ catalog: true }), whop.run()]);
    return c.json({ erp: erpStatus, whopDays });
  });

  // ── Sổ thu chi ──
  app.get('/profit', (c) => c.json({ document: readDocument(db), ads: readArchivedAds(db), accounts: listAdAccounts(db), revision: readRevision(db) }));

  app.put('/profit', bodyLimit({ maxSize: 8 * 1024 * 1024 }), async (c) => {
    const body = await c.req.json().catch(() => null);
    try {
      return c.json({ revision: saveDocument(db, body?.document, body?.revision).revision });
    } catch (err) { return fail(c, err); }
  });

  app.post('/profit/ads-import', (c) => c.json({ ads: importAds(db) }));

  app.post('/profit/entries', async (c) => {
    const body = await c.req.json().catch(() => null);
    try {
      const { id } = addEntry(db, body);
      ctx.audit.log('ledger.add', id, { kind: body?.kind, amount: body?.amount }, 'owner');
      return c.json({ id, revision: readRevision(db) }, 201);
    } catch (err) { return fail(c, err); }
  });

  app.get('/summary', (c) => c.json({ month: monthLedger(db) }));

  // ── ERP (read-only) ──
  app.get('/erp', (c) => {
    const snap = <T>(key: string) => readSnapshot<T>(db, key);
    const status = snap<ErpSyncStatus>('status')?.payload ?? null;
    const month = snap<ErpSummary>('summary_month');
    const today = snap<ErpSummary>('summary_today')?.payload.to_date ?? vnToday();
    const from = new Date(Date.parse(today) - 59 * 86_400_000).toISOString().slice(0, 10);
    return c.json({
      hub: erp.configured() ? { id: 'erp', name: 'ERP (MCP)', status: status ? (status.ok ? 'ok' : 'error') : 'pending' } : null,
      status,
      summaries: { today: snap<ErpSummary>('summary_today'), week: snap<ErpSummary>('summary_week'), month },
      unmatchedTransfers: snap('unmatched_transfers'),
      partnerStatements: snap('partner_statements'),
      unpaidOrders: snap('unpaid_orders'),
      daily: readDaily(db, month && month.payload.from_date < from ? month.payload.from_date : from, today),
    });
  });

  app.post('/erp/sync', async (c) => {
    const last = readSnapshot<ErpSyncStatus>(db, 'status')?.payload;
    const now = Math.floor(Date.now() / 1000);
    if (last && now - last.at < ERP_MANUAL_MIN_INTERVAL_SEC) return c.json({ error: 'Vừa đồng bộ xong, thử lại sau một phút.' }, 429);
    const status = await erp.run();
    return c.json({ status }, status.ok ? 200 : 422);
  });
}
