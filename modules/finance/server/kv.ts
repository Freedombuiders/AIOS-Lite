import type { DB } from '../../../src/core/db.js';
import { nowIso } from '../../../src/core/db.js';

export const KEY_PNL_SETTINGS = 'pnl.settings.v1';
export const KEY_LEDGER = 'profit.document.v1';
export const KEY_LEDGER_ADS = 'profit.ads.v1';

export const kvGet = (db: DB, key: string): string | null =>
  (db.prepare('SELECT value FROM finance_kv WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;

export const kvSet = (db: DB, key: string, value: string): void => {
  db.prepare(`INSERT INTO finance_kv (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, nowIso());
};
