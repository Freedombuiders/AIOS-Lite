/** Key/value rows in radar_kv: config, run markers and the Apify rotation cursor. */
import { radarDatabase } from './context.js';

export function getKv(key: string): string | null {
  const row = radarDatabase().prepare('SELECT value FROM radar_kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setKv(key: string, value: string): void {
  radarDatabase().prepare('INSERT INTO radar_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
