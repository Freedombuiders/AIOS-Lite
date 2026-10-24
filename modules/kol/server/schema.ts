import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { sourcePath } from '../../_lib/source-path.js';

/**
 * KOL Studio tables live in migrations/001_init.sql (applied by the module manager on Add).
 * This only re-applies that file (idempotent: CREATE ... IF NOT EXISTS) the first time a database
 * handle is used, so tests and a database that was reset under a running app both work.
 * Times are unix SECONDS. JSON columns end in _json. Ids are UUIDs unless noted.
 */
const SQL_FILE = sourcePath(new URL('../migrations/001_init.sql', import.meta.url));

export function ensureKolSchema(database: Database.Database): void {
  database.exec(fs.readFileSync(SQL_FILE, 'utf8'));
}
