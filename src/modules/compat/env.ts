import fs from 'node:fs';
import path from 'node:path';
import { parseEnv, setEnvKey as coreSetEnvKey } from '../../core/env.js';
import { tryDeps } from './state.js';

/** Upstream env.ts: read the listed keys from .env, falling back to process.env. Missing keys are omitted. */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = tryDeps()?.config.envFile ?? path.join(process.cwd(), '.env');
  let file: Record<string, string> = {};
  try {
    file = parseEnv(fs.readFileSync(envFile, 'utf8'));
  } catch {
    /* no .env */
  }
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = file[k] ?? process.env[k];
    if (v) out[k] = v;
  }
  return out;
}

/** Upstream env-write.ts: set KEY=value in the given env file (and process.env). */
export function setEnvKey(envPath: string, key: string, value: string): void {
  coreSetEnvKey(envPath, key, value);
}
