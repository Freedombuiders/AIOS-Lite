/** Tiny SQLite helpers shared by the ops modules. Tolerant of older Care layouts (tables may be absent). */
import type Database from 'better-sqlite3';

export function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

export function columnExists(db: Database.Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
}

export function careTables(db: Database.Database): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'care\\_%' ESCAPE '\\' ORDER BY name`).all() as Array<{ name: string }>
  ).map((t) => t.name);
}

export function scalar(db: Database.Database, sql: string, ...params: unknown[]): number | null {
  const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  if (!row) return null;
  const v = Object.values(row)[0];
  return v === null || v === undefined ? null : Number(v);
}

export function metaGet(db: Database.Database, key: string): string | null {
  if (!tableExists(db, 'care_schema_meta')) return null;
  const row = db.prepare(`SELECT value FROM care_schema_meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function metaSet(db: Database.Database, key: string, value: string): void {
  db.prepare(`INSERT INTO care_schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}
