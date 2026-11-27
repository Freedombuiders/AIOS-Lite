// Env variables that hold a credential only core code may read (GenBot Bot API keys). Their names never reach a child
// process (buildChildEnv strips them, whatever the agent was granted) and their values are masked by redactString.
import { protectValue } from './redact.js';

/** Bot API keys by convention; any other name used as `runtime_options.key_env` is registered at agent load. */
const SECRET_ENV_PATTERN = /^GENBOT_KEY_/;
const names = new Set<string>();

/** Mark an env variable as core-only and mask its current value everywhere. */
export function protectEnvName(name: string, env: Record<string, string | undefined> = process.env): void {
  const n = name.trim();
  if (!n) return;
  names.add(n);
  protectValue(env[n]);
}

/** Core-only secret VALUES (GenBot keys stored in the app): any env entry carrying one is dropped from a child env. */
const coreValues = new Set<string>();

/** Mark a value as core-only (never in a child env) and mask it everywhere. */
export function protectCoreValue(value: string | undefined): void {
  const v = value?.trim();
  if (!v || v.length < 8) return;
  coreValues.add(v);
  protectValue(v);
}

/** True when `value` carries a core-only secret value. */
export function carriesCoreValue(value: string): boolean {
  for (const v of coreValues) if (value.includes(v)) return true;
  return false;
}

export function isProtectedEnvName(name: string): boolean {
  return names.has(name) || SECRET_ENV_PATTERN.test(name);
}

/** Register the env names an agent's runtime options point at (`key_env`). */
export function protectAgentSecrets(runtimeOptions: Record<string, string | number | boolean> | undefined, env?: Record<string, string | undefined>): void {
  const keyEnv = runtimeOptions?.key_env;
  if (typeof keyEnv === 'string') protectEnvName(keyEnv, env);
}
