/**
 * P&L storage and readers: Whop revenue per day (pnl_whop_daily), P&L settings (finance_kv `pnl.settings.v1`),
 * and the inputs of the engine read from the tables other modules own (ads, runs).
 */

import { z } from 'zod';
import type { DB } from '../../../../src/core/db.js';
import { KEY_LEDGER, KEY_PNL_SETTINGS, kvGet, kvSet } from '../kv.js';
import { documentSchema, type ProfitDocument } from '../profit/model.js';
import { readDaily, readPeriods, readSnapshot } from '../erp/store.js';
import type { ErpCatalog, ErpSyncStatus } from '../erp/sync.js';
import type { AdsRow, PnlInputs, WhopDayRow } from './engine.js';
import { DEFAULT_SETTINGS, type PnlSettings } from './types.js';

const VN_OFFSET_SEC = 7 * 3600;

export const settingsSchema = z.object({
  usdVnd: z.number().finite().min(1000).max(100_000),
  usdVndConfirmed: z.boolean(),
  campaigns: z.record(z.string().min(3).max(200), z.string().min(1).max(140)).refine((r) => Object.keys(r).length <= 5000),
  outAccounts: z.array(z.string().min(1).max(120)).max(200),
});

export function readSettings(db: DB): PnlSettings {
  try {
    const raw = kvGet(db, KEY_PNL_SETTINGS);
    const parsed = raw ? settingsSchema.safeParse(JSON.parse(raw)) : null;
    return parsed?.success ? parsed.data : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(db: DB, s: PnlSettings): void {
  kvSet(db, KEY_PNL_SETTINGS, JSON.stringify(s));
}

export function upsertWhopDays(db: DB, rows: WhopDayRow[], at: number): void {
  const stmt = db.prepare(`INSERT INTO pnl_whop_daily (date, gross, refunded, net, synced_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET gross = excluded.gross, refunded = excluded.refunded, net = excluded.net, synced_at = excluded.synced_at`);
  db.transaction(() => { for (const r of rows) stmt.run(r.date, r.gross, r.refunded, r.net, at); })();
}

export function readWhopDays(db: DB, from: string, to: string): { rows: WhopDayRow[]; syncedAt: number | null } {
  const rows = db.prepare('SELECT date, gross, refunded, net FROM pnl_whop_daily WHERE date BETWEEN ? AND ? ORDER BY date').all(from, to) as WhopDayRow[];
  const last = db.prepare('SELECT MAX(synced_at) AS at FROM pnl_whop_daily').get() as { at: number | null };
  return { rows, syncedAt: last.at };
}

export function whopHistoryDays(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM pnl_whop_daily').get() as { n: number }).n;
}

/** Meta Ads spend comes from the `ads` module's tables; empty when that module was never added. */
function readAds(db: DB, from: string, to: string): AdsRow[] {
  try {
    return db.prepare(`
      SELECT d.account_id AS accountId, a.name AS accountName, a.currency AS currency, d.level AS level, d.object_id AS objectId,
             d.name AS name, d.day AS day, d.spend AS spend, d.results AS results
        FROM fb_ads_daily d JOIN fb_ad_accounts a ON a.id = d.account_id
       WHERE d.level IN ('account', 'campaign') AND d.day BETWEEN ? AND ?`).all(from, to) as AdsRow[];
  } catch {
    return [];
  }
}

/** AI cost per Vietnam day from the core runs table (USD). */
function readAiUsdByDay(db: DB, from: string, to: string): Record<string, number> {
  try {
    const rows = db.prepare(`
      SELECT date(started_at, '+7 hours') AS day, SUM(COALESCE(cost_usd, 0)) AS usd
        FROM runs WHERE date(started_at, '+7 hours') BETWEEN ? AND ? GROUP BY day`).all(from, to) as Array<{ day: string; usd: number }>;
    return Object.fromEntries(rows.map((r) => [r.day, r.usd ?? 0]));
  } catch {
    return {};
  }
}

export function readLedger(db: DB): ProfitDocument | null {
  try {
    const raw = kvGet(db, KEY_LEDGER);
    if (!raw) return null;
    const parsed = documentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Everything the engine needs for [from, to] and its comparison period. */
export function readInputs(db: DB, base: Omit<PnlInputs, 'settings' | 'erp' | 'whop' | 'ads' | 'ledger' | 'aiUsdByDay' | 'nowIso'>, flags: { erpConnected: boolean; whopConnected: boolean }): PnlInputs {
  const lo = base.prevFrom < base.from ? base.prevFrom : base.from;
  const hi = base.to;
  const status = readSnapshot<ErpSyncStatus>(db, 'status');
  const whop = readWhopDays(db, lo, hi);
  return {
    ...base,
    settings: readSettings(db),
    erp: {
      connected: flags.erpConnected && status?.payload.ok === true,
      syncedAt: status?.payload.ok ? status.payload.at : (readSnapshot(db, 'summary_today')?.syncedAt ?? null),
      daily: readDaily(db, lo, hi),
      periods: readPeriods(db, lo, hi),
      catalog: readSnapshot<ErpCatalog>(db, 'catalog')?.payload ?? null,
    },
    whop: { connected: flags.whopConnected || whop.rows.length > 0, syncedAt: whop.syncedAt, daily: whop.rows },
    ads: readAds(db, lo, hi),
    ledger: readLedger(db),
    aiUsdByDay: readAiUsdByDay(db, lo, hi),
    nowIso: new Date().toISOString(),
  };
}
