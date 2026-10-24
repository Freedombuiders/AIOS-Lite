import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CORE_MIGRATION_001 } from './migrations/001_core.js';
import { CORE_MIGRATION_002 } from './migrations/002_integrations.js';

export type DB = Database.Database;

export const nowIso = (): string => new Date().toISOString();

/** Open (and create) the database with sane pragmas. ':memory:' is allowed for tests. */
export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    owner TEXT NOT NULL, id TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (owner, id))`);
  return db;
}

export interface Migration {
  id: string;
  /** SQL text, or a function for migrations that need logic */
  sql?: string;
  up?: (db: DB) => void;
}

/** Apply migrations for an owner ('core' or a module id) once each, in order, inside a transaction. */
export function applyMigrations(db: DB, owner: string, migrations: Migration[]): string[] {
  const done = new Set(
    (db.prepare('SELECT id FROM schema_migrations WHERE owner = ?').all(owner) as { id: string }[]).map((r) => r.id),
  );
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    db.transaction(() => {
      if (m.sql) db.exec(m.sql);
      if (m.up) m.up(db);
      db.prepare('INSERT INTO schema_migrations (owner, id) VALUES (?, ?)').run(owner, m.id);
    })();
    applied.push(m.id);
  }
  return applied;
}

export const CORE_MIGRATIONS: Migration[] = [
  { id: '001_core', sql: CORE_MIGRATION_001 },
  { id: '002_integrations', sql: CORE_MIGRATION_002 },
];

export function migrateCore(db: DB): string[] {
  return applyMigrations(db, 'core', CORE_MIGRATIONS);
}

/** Table names created by a SQL script (CREATE TABLE / CREATE VIRTUAL TABLE). */
export function tablesCreatedBy(sql: string): string[] {
  const out = new Set<string>();
  const re = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi;
  for (const m of sql.matchAll(re)) out.add(m[1]!);
  return [...out];
}

/** Read JSON column safely. */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Convert a snake_case row to camelCase keys (shallow). */
export function camelRow<T>(row: Record<string, unknown> | undefined): T | undefined {
  if (!row) return undefined;
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) o[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  return o as T;
}
