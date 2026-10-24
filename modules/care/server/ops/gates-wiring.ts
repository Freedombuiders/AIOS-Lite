/**
 * Gate wiring checks (CC-21). The ONE dispatch gate lives in runtime/gates.ts and every surface asks it:
 * the worker/jobs, the HTTP API, the CLI, schedules, campaigns and the legacy responder/sender. This module
 * does not add a second gate. It adds
 *
 *  - `GATED_SURFACES`: the list of surfaces that must be bound, so a new surface is a visible edit;
 *  - `evaluateGateMatrix`: what the real gate answers for every account x source x operation right now;
 *  - `findGateViolations`: an independent re-derivation of the answer straight from the switch/account rows
 *    (written from the contract in runtime/gates.ts, not by calling it), so a wiring regression in the gate
 *    shows up as a disagreement instead of passing silently;
 *  - `careNavigationState`: what the dashboard navigation may show (module switch + data-access gate).
 *
 * All pure reads. Nothing here enables, sends or changes anything.
 */
import type Database from 'better-sqlite3';
import { DISPATCH_SOURCES, evaluateDispatchGate, switchKeyForPath, type DispatchSource } from '../runtime/gates.js';

export interface GatedSurface {
  surface: 'navigation' | 'api' | 'worker' | 'jobs' | 'cli' | 'schedule' | 'campaign' | 'legacy-responder' | 'legacy-sender' | 'ui';
  /** The dispatch source it presents to the gate (navigation has none: it follows the module switch). */
  source: DispatchSource | null;
  /** Where it is bound. */
  boundBy: string;
}

export const GATED_SURFACES: readonly GatedSurface[] = [
  { surface: 'navigation', source: null, boundBy: 'ops/gates-wiring.careNavigationState (module switch + read gate)' },
  { surface: 'api', source: 'api', boundBy: 'api/gate.requireDispatch + api read gate + per-source canReadSource' },
  { surface: 'worker', source: 'worker', boundBy: 'runtime/worker (account lane gate before the ownership lock)' },
  { surface: 'jobs', source: 'job', boundBy: 'runtime/worker (gate per tick and per job)' },
  { surface: 'cli', source: 'cli', boundBy: 'runtime/gates' },
  { surface: 'schedule', source: 'schedule', boundBy: 'runtime/gates' },
  { surface: 'campaign', source: 'campaign', boundBy: 'runtime/gates' },
  { surface: 'ui', source: 'ui', boundBy: 'runtime/gates' },
  { surface: 'legacy-responder', source: 'responder', boundBy: 'runtime/legacy-compat' },
  { surface: 'legacy-sender', source: 'sender', boundBy: 'runtime/legacy-compat' },
];

export interface GateMatrixRow {
  accountId: string;
  channel: string;
  source: DispatchSource;
  operation: 'send' | 'work';
  allow: boolean;
  code: string;
}

interface AccountRow {
  id: string;
  channel: string;
  write_owner: string;
  owner_epoch: number;
  desired_state: string;
  send_enabled: number;
}

function accounts(db: Database.Database): AccountRow[] {
  return db.prepare('SELECT id, channel, write_owner, owner_epoch, desired_state, send_enabled FROM care_accounts ORDER BY id').all() as AccountRow[];
}

/** The gate under test; defaults to the real one. Injectable so tests can prove the check catches a broken gate. */
export type GateEvaluator = typeof evaluateDispatchGate;

/** The real gate's answer for a core actor presenting each account's current epoch. */
export function evaluateGateMatrix(db: Database.Database, evaluate: GateEvaluator = evaluateDispatchGate): GateMatrixRow[] {
  const rows: GateMatrixRow[] = [];
  for (const a of accounts(db)) {
    for (const source of DISPATCH_SOURCES) {
      for (const operation of ['send', 'work'] as const) {
        const d = evaluate(db, a.id, Number(a.owner_epoch), 'core', source, { operation });
        rows.push({ accountId: a.id, channel: a.channel, source, operation, allow: d.allow, code: d.code });
      }
    }
  }
  return rows;
}

export interface GateViolation {
  accountId: string;
  source: DispatchSource;
  operation: 'send' | 'work';
  expected: string;
  actual: string;
}

/** Expected answer derived directly from the rows (first failing check wins, as documented in runtime/gates.ts). */
function expectedCode(
  a: AccountRow,
  op: 'send' | 'work',
  source: DispatchSource,
  sw: Map<string, boolean>,
): string {
  const on = (key: string, defaultOn: boolean) => sw.get(key) ?? defaultOn;
  if (op === 'send' && !on('dispatch', true)) return 'KILL_SWITCH';
  if (!on('module', false)) return 'MODULE_DISABLED';
  if (!on(switchKeyForPath(source), true)) return 'PATH_DISABLED';
  if (!on(`channel:${a.channel}`, true)) return 'CHANNEL_DISABLED';
  if (a.write_owner === 'legacy') return 'OWNER_LEGACY';
  if (a.write_owner === 'draining') return 'ACCOUNT_DRAINING';
  if (a.desired_state !== 'active') return 'ACCOUNT_NOT_ACTIVE';
  if (op === 'send' && Number(a.send_enabled) !== 1) return 'SEND_DISABLED';
  return 'OK';
}

export function findGateViolations(db: Database.Database, evaluate: GateEvaluator = evaluateDispatchGate): GateViolation[] {
  const sw = new Map((db.prepare('SELECT switch_key, enabled FROM care_runtime_switches').all() as Array<{ switch_key: string; enabled: number }>).map((r) => [r.switch_key, r.enabled === 1]));
  const byId = new Map(accounts(db).map((a) => [a.id, a]));
  const out: GateViolation[] = [];
  for (const row of evaluateGateMatrix(db, evaluate)) {
    const expected = expectedCode(byId.get(row.accountId)!, row.operation, row.source, sw);
    if (expected !== row.code) out.push({ accountId: row.accountId, source: row.source, operation: row.operation, expected, actual: row.code });
  }
  return out;
}

export function assertGateWiring(db: Database.Database, evaluate: GateEvaluator = evaluateDispatchGate): void {
  const bad = findGateViolations(db, evaluate);
  if (bad.length > 0) {
    const first = bad[0];
    throw new Error(`Care gate wiring violated for ${bad.length} case(s); first: ${first.source}/${first.operation} expected ${first.expected}, gate said ${first.actual}`);
  }
}

export type NavigationHidden = 'MODULE_DISABLED' | 'READ_DISABLED';

/** Navigation shows Care only while the module is switched on AND the data-access gate allows reading. */
export function careNavigationState(db: Database.Database, opts: { canRead: () => boolean }): { visible: boolean; reason: NavigationHidden | null } {
  const row = db.prepare(`SELECT enabled FROM care_runtime_switches WHERE switch_key = 'module'`).get() as { enabled: number } | undefined;
  if (!row || row.enabled !== 1) return { visible: false, reason: 'MODULE_DISABLED' };
  let allowed = false;
  try {
    allowed = opts.canRead() === true;
  } catch {
    allowed = false; // a broken gate is a closed gate
  }
  return allowed ? { visible: true, reason: null } : { visible: false, reason: 'READ_DISABLED' };
}
