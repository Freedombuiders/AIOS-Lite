import { createCipher } from '../../core/crypto.js';
import { loadConfig } from '../../core/config.js';
import { migrateCore, openDb, type DB } from '../../core/db.js';
import type { AppDeps } from '../../core/deps.js';
import { createEventBus } from '../../core/events.js';
import { createLogger } from '../../core/log.js';
import { bindCompat, getDeps, tryDeps } from './state.js';

/** The shared SQLite handle (the one in AppDeps). Module code touches only its own tables. */
export function getDb(): DB {
  return getDeps().db;
}

/** Proxy so `db.prepare(...)` works like a module-level handle. */
export const db: DB = new Proxy({} as DB, {
  get(_t, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const v = real[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
});

/** Test helper: bind compat to a fresh database (default in-memory) with the core schema. */
export function _initTestDatabase(databasePath = ':memory:', _opts: { key?: Buffer } = {}): void {
  const database = openDb(databasePath);
  migrateCore(database);
  const config = loadConfig({ loadDotEnv: false, env: {} });
  bindCompat({ config, db: database, bus: createEventBus(), log: createLogger({ level: 'silent' }), cipher: createCipher(undefined) } as unknown as AppDeps);
}

/** Upstream opened its own database here; AIOS-Lite already did at boot, so this only checks the binding. */
export function initDatabase(): void {
  if (!tryDeps()) _initTestDatabase();
}

const totals = { inputTokens: 0, outputTokens: 0, cacheRead: 0, costUsd: 0, turns: 0 };

/** Token accounting lives in runs (written by the engine); this only keeps in-memory totals for diagnostics. */
export interface TokenTelemetry {
  model?: string | null; durationMs?: number; durationApiMs?: number; numTurns?: number;
  stopReason?: string | null; isError?: boolean; costSource?: 'provider' | 'unknown';
}

export function saveTokenUsage(
  chatId: string, sessionId: string | undefined, inputTokens: number, outputTokens: number, cacheRead: number,
  contextTokens: number, costUsd: number, didCompact: boolean, agentId = 'main', contextWindow: number | null = null,
  cacheCreation = 0, telemetry: TokenTelemetry = {},
): void {
  totals.inputTokens += inputTokens;
  totals.outputTokens += outputTokens;
  totals.cacheRead += cacheRead;
  totals.costUsd += telemetry.costSource === 'unknown' ? 0 : costUsd;
  totals.turns += 1;
  tryDeps()?.log.debug({ chatId, sessionId, agentId, inputTokens, outputTokens, contextTokens, didCompact, contextWindow, cacheCreation, ...telemetry }, 'compat token usage');
}

export const tokenUsageTotals = () => ({ ...totals });
