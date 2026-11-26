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

export function isProtectedEnvName(name: string): boolean {
  return names.has(name) || SECRET_ENV_PATTERN.test(name);
}

/** Register the env names an agent's runtime options point at (`key_env`). */
export function protectAgentSecrets(runtimeOptions: Record<string, string | number | boolean> | undefined, env?: Record<string, string | undefined>): void {
  const keyEnv = runtimeOptions?.key_env;
  if (typeof keyEnv === 'string') protectEnvName(keyEnv, env);
}
