import { readFileSync } from 'node:fs';
import type { ModuleContext } from '../../../src/modules/sdk.js';
import { _initTestDatabase as init, getDb } from '../../../src/modules/compat/db.js';
import { bindTestContext } from './context.js';

export const settingValues = new Map<string, unknown>();

/** Fresh in-memory database with the radar tables and a minimal bound module context. */
export function _initTestDatabase(path = ':memory:'): void {
  init(path);
  settingValues.clear();
  bindTestContext({
    id: 'radar', db: getDb(), dataDir: '/tmp/radar-test',
    settings: { get: (k: string, fallback: unknown) => settingValues.get(k) ?? fallback, set: (k: string, v: unknown) => { settingValues.set(k, v); } },
    agents: { get: () => undefined },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as ModuleContext);
  getDb().exec(readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
}
