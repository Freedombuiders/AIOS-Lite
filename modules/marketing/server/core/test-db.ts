/** Test-only: a file-backed test database plus a second raw connection for seeding other workstreams' tables. */

import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { _initTestDatabase } from '../store.js';

let counter = 0;

export function initTestDbWithRawAccess(): Database.Database {
  const file = path.join(os.tmpdir(), `fbstudio-core-test-${process.pid}-${counter++}.db`);
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  _initTestDatabase(file);
  return new Database(file);
}
