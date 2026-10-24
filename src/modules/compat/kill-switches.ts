import { boundModules, tryDeps } from './state.js';

export type KillSwitch =
  | 'WARROOM_TEXT_ENABLED'
  | 'WARROOM_VOICE_ENABLED'
  | 'LLM_SPAWN_ENABLED'
  | 'DASHBOARD_MUTATIONS_ENABLED'
  | 'MISSION_AUTO_ASSIGN_ENABLED'
  | 'SCHEDULER_ENABLED'
  | 'ZALO_AUTOREPLY_ENABLED'
  | 'FB_PUBLISH_ENABLED'
  | 'FB_AUTOREPLY_ENABLED'
  | 'EMAIL_AUTOREPLY_ENABLED'
  | 'KOL_GENERATE_ENABLED'
  | 'KOL_PUBLISH_ENABLED';

export class KillSwitchDisabledError extends Error {
  constructor(public readonly switchName: KillSwitch) {
    super(`Tính năng ${switchName} đang tắt.`);
    this.name = 'KillSwitchDisabledError';
  }
}

const OFF = new Set(['0', 'false', 'off', 'no']);
const overrides = new Map<KillSwitch, boolean>();

const kv = (key: string): string | undefined => {
  try {
    return (tryDeps()?.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  } catch {
    return undefined;
  }
};

/**
 * Order: in-process override → global emergency stop (kv `emergency_stop`) → a bound module's setting named <NAME> → kv `kill:<NAME>` → env <NAME> → on.
 * Switches are ON unless explicitly turned off.
 */
export function isEnabled(name: KillSwitch): boolean {
  const o = overrides.get(name);
  if (o !== undefined) return o;
  if (kv('emergency_stop') === '1') return false;
  for (const ctx of boundModules()) {
    if (ctx.manifest.settings?.[name]) {
      const v = ctx.settings.get<unknown>(name);
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string' && v) return !OFF.has(v.trim().toLowerCase());
    }
  }
  const stored = kv(`kill:${name}`) ?? process.env[name];
  return stored === undefined ? true : !OFF.has(stored.trim().toLowerCase());
}

export function requireEnabled(name: KillSwitch): void {
  if (!isEnabled(name)) throw new KillSwitchDisabledError(name);
}

/** Persist a switch (kv) so it survives restarts. */
export function setKillSwitch(name: KillSwitch, on: boolean): void {
  tryDeps()?.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`kill:${name}`, on ? '1' : '0');
}

/** Test helper: force a switch without touching the database. */
export function _setOverride(name: KillSwitch, on: boolean): void {
  overrides.set(name, on);
}

export function _reset(): void {
  overrides.clear();
}
