import { bindTestContext } from './context.js';
import type { ModuleContext } from '../../../src/modules/sdk.js';
import { readFileSync } from 'node:fs';
import { _initTestDatabase as init, getDb } from '../../../src/modules/compat/db.js';
export function _initTestDatabase(path = ':memory:'): void {
 init(path);
 const settings = new Map<string, unknown>();
 bindTestContext({ db: getDb(), settings: { get: (k: string, fallback: unknown) => settings.get(k) ?? fallback, set: (k: string, v: unknown) => { settings.set(k, v); } } } as unknown as ModuleContext);
 getDb().exec(readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
}
