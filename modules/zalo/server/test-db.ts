// Test helper: bind compat to a fresh in-memory database (core schema) and apply the zalo module migration.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _initTestDatabase as bindTestDatabase, getDb } from './compat.js';

const MIGRATION = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '001_init.sql');

export function _initTestDatabase(databasePath = ':memory:'): void {
  bindTestDatabase(databasePath);
  getDb().exec(fs.readFileSync(MIGRATION, 'utf8'));
}
