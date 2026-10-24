import type { DB } from '../../../../src/core/db.js';
import type { ErpDailyRow, ErpPeriodRow, ErpProgramCount } from './money.js';

export function readSnapshot<T>(db: DB, key: string): { payload: T; syncedAt: number } | null {
  const row = db.prepare('SELECT payload, synced_at FROM erp_snapshots WHERE key = ?').get(key) as { payload: string; synced_at: number } | undefined;
  return row ? { payload: JSON.parse(row.payload) as T, syncedAt: row.synced_at } : null;
}

export function writeSnapshot(db: DB, key: string, payload: unknown, at: number): void {
  db.prepare(`INSERT INTO erp_snapshots (key, payload, synced_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, synced_at = excluded.synced_at`).run(key, JSON.stringify(payload), at);
}

export function readDaily(db: DB, from: string, to: string): ErpDailyRow[] {
  const rows = db.prepare('SELECT date, revenue, paid_orders, registrations, company_share, programs FROM erp_daily WHERE date BETWEEN ? AND ? ORDER BY date')
    .all(from, to) as Array<Omit<ErpDailyRow, 'programs'> & { programs: string }>;
  return rows.map((r) => ({ ...r, programs: JSON.parse(r.programs) as ErpProgramCount[] }));
}

/** Week / month totals overlapping [from, to]. */
export function readPeriods(db: DB, from: string, to: string): ErpPeriodRow[] {
  const rows = db.prepare(`SELECT period, from_date, to_date, revenue, paid_orders, registrations, company_share, programs
    FROM erp_period_totals WHERE to_date >= ? AND from_date <= ? ORDER BY from_date`).all(from, to) as Array<Omit<ErpPeriodRow, 'programs'> & { programs: string }>;
  return rows.map((r) => ({ ...r, programs: JSON.parse(r.programs) as ErpProgramCount[] }));
}

/** Rows without `programs` (a corrected yesterday) keep the counts already stored. */
export function upsertDaily(db: DB, row: ErpDailyRow, at: number): void {
  const programs = row.programs ? JSON.stringify(row.programs) : null;
  db.prepare(`INSERT INTO erp_daily (date, revenue, paid_orders, registrations, company_share, programs, synced_at) VALUES (?, ?, ?, ?, ?, COALESCE(?, '[]'), ?)
    ON CONFLICT(date) DO UPDATE SET revenue = excluded.revenue, paid_orders = excluded.paid_orders,
      registrations = excluded.registrations, company_share = excluded.company_share,
      programs = COALESCE(?, erp_daily.programs), synced_at = excluded.synced_at`)
    .run(row.date, row.revenue, row.paid_orders, row.registrations, row.company_share, programs, at, programs);
}

export function upsertPeriod(db: DB, s: { period: string; from_date: string; to_date: string; revenue: number; paid_orders: number; registrations: number; company_share: number; programs: ErpProgramCount[] }, at: number): void {
  db.prepare(`INSERT INTO erp_period_totals (period, from_date, to_date, revenue, paid_orders, registrations, company_share, programs, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(period, from_date) DO UPDATE SET to_date = excluded.to_date, revenue = excluded.revenue, paid_orders = excluded.paid_orders,
      registrations = excluded.registrations, company_share = excluded.company_share, programs = excluded.programs, synced_at = excluded.synced_at`)
    .run(s.period, s.from_date, s.to_date, s.revenue, s.paid_orders, s.registrations, s.company_share, JSON.stringify(s.programs), at);
}
