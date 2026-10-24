import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.js';

export interface AppConfig {
  rootDir: string;
  envFile: string;
  dataDir: string;
  dbPath: string;
  agentsDir: string;
  modulesDir: string;
  workspacesDir: string;
  configDir: string;
  brainConfigFile: string;
  connectionsFile: string;
  skillsDirs: string[];
  host: string;
  port: number;
  token: string | undefined;
  maxParallel: number;
  dispatcherPollMs: number;
  maxDelegationDepth: number;
  maxChildrenPerRun: number;
  maxSummaryRounds: number;
  runTimeoutMs: number;
  encryptionKey: string | undefined;
  timezone: string;
}

/** Repo root: two levels up from src/core (also works from dist/src/core). */
export function defaultRootDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const up = path.resolve(here, '..', '..');
  return path.basename(up) === 'dist' ? path.dirname(up) : up;
}

export function expandHome(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function num(v: string | undefined, fallback: number): number {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Build the config from env. Loads <root>/.env first (without overriding real env vars)
 * unless `loadDotEnv` is false (tests).
 */
export function loadConfig(opts: { rootDir?: string; env?: NodeJS.ProcessEnv; loadDotEnv?: boolean } = {}): AppConfig {
  const rootDir = opts.rootDir ?? defaultRootDir();
  const env = opts.env ?? process.env;
  const envFile = path.join(rootDir, '.env');
  if (opts.loadDotEnv !== false) loadEnvFile(envFile, env);
  const abs = (p: string) => path.resolve(rootDir, expandHome(p));
  const dataDir = abs(env.AIOS_DATA_DIR || './data');
  const configDir = abs(env.AIOS_CONFIG_DIR || './config');
  return {
    rootDir,
    envFile,
    dataDir,
    dbPath: env.AIOS_DB_PATH ? abs(env.AIOS_DB_PATH) : path.join(dataDir, 'aios.db'),
    agentsDir: abs(env.AIOS_AGENTS_DIR || './agents'),
    modulesDir: abs(env.AIOS_MODULES_DIR || './modules'),
    workspacesDir: abs(env.AIOS_WORKSPACES_DIR || './workspaces'),
    configDir,
    brainConfigFile: path.join(configDir, 'brain.yaml'),
    connectionsFile: path.join(configDir, 'connections.yaml'),
    skillsDirs: (env.AIOS_SKILLS_DIRS || './skills').split(',').map((s) => s.trim()).filter(Boolean).map(abs),
    host: env.AIOS_HOST || '127.0.0.1',
    port: num(env.AIOS_PORT, 4380),
    token: env.AIOS_TOKEN || undefined,
    maxParallel: Math.max(1, num(env.AIOS_MAX_PARALLEL, 3)),
    dispatcherPollMs: Math.max(100, num(env.AIOS_DISPATCHER_POLL_MS, 1000)),
    maxDelegationDepth: num(env.AIOS_MAX_DELEGATION_DEPTH, 3),
    maxChildrenPerRun: num(env.AIOS_MAX_CHILDREN_PER_RUN, 5),
    maxSummaryRounds: num(env.AIOS_MAX_SUMMARY_ROUNDS, 3),
    runTimeoutMs: num(env.AIOS_RUN_TIMEOUT_SEC, 900) * 1000,
    encryptionKey: env.AIOS_ENCRYPTION_KEY || undefined,
    timezone: env.AIOS_TIMEZONE || 'Asia/Ho_Chi_Minh',
  };
}
