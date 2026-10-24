/**
 * Runtime switch control. Turning a switch back ON and parking the backlog older than that moment happen in
 * ONE transaction, so there is no window in which a worker can claim backlog between "enabled" and "held".
 */
import type Database from 'better-sqlite3';
import type { CareChannel } from '../../../_lib/care-kit/types.js';
import { CareOwnershipStore, type SetSwitchResult } from '../persistence/ownership-store.js';
import { careJobsBacklogSource, markBacklogHeld, type BacklogSource } from './backlog.js';
import { switchKeyForPath, type DispatchSource } from './gates.js';

export const SWITCH = {
  module: 'module',
  dispatch: 'dispatch',
  ai: 'ai',
  autoSend: 'auto_send',
  channel: (c: CareChannel) => `channel:${c}`,
  path: (p: DispatchSource) => switchKeyForPath(p),
} as const;

export interface SetRuntimeSwitchOptions {
  actor: string;
  reason?: string;
  nowMs?: number;
  /** Extra backlog sources (e.g. the CC-11 outbox) parked together with care_jobs on re-enable. */
  extraSources?: BacklogSource[];
}

export type SetRuntimeSwitchResult = SetSwitchResult & { held: number };

export function setRuntimeSwitch(db: Database.Database, key: string, enabled: boolean, opts: SetRuntimeSwitchOptions): SetRuntimeSwitchResult {
  const store = new CareOwnershipStore(db);
  const run = db.transaction((): SetRuntimeSwitchResult => {
    const res = store.setSwitch(key, enabled, opts);
    if (!res.reenabled) return { ...res, held: 0 };
    let accountIds: string[] | null = null;
    if (key.startsWith('channel:')) {
      accountIds = (db.prepare('SELECT id FROM care_accounts WHERE channel = ?').all(key.slice('channel:'.length)) as Array<{ id: string }>).map((r) => r.id);
    }
    const held = markBacklogHeld(db, {
      cutoffMs: res.atMs,
      accountIds,
      sources: [careJobsBacklogSource(db), ...(opts.extraSources ?? [])],
      actor: opts.actor,
      reason: `re-enabled:${key}`,
      nowMs: res.atMs,
    });
    return { ...res, held: held.held };
  });
  return run.immediate();
}

export const engageKillSwitch = (db: Database.Database, opts: SetRuntimeSwitchOptions) => setRuntimeSwitch(db, SWITCH.dispatch, false, opts);
export const releaseKillSwitch = (db: Database.Database, opts: SetRuntimeSwitchOptions) => setRuntimeSwitch(db, SWITCH.dispatch, true, opts);
