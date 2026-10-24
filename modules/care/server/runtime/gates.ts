/**
 * The ONE dispatch gate. Every path that can cause an outbound message or a model/ingest turn on a
 * Care account asks `evaluateDispatchGate` right before acting: the Care worker, the legacy responder
 * and sender (through `legacy-compat.ts`), schedules, campaigns, the CLI and the HTTP API. Switches are
 * data (care_runtime_switches / care_accounts), so they bind API, CLI, jobs and schedules - not only the UI.
 *
 * Pure read, fail-closed, stable reason codes. First failing check wins; the order below is part of the
 * contract (an old-epoch worker reports STALE_EPOCH rather than a switch name it should not know about).
 *
 *   core actor:   ACCOUNT_NOT_FOUND, KILL_SWITCH (send only), MODULE_DISABLED, PATH_DISABLED, CHANNEL_DISABLED,
 *                 OWNER_LEGACY / ACCOUNT_DRAINING, EPOCH_REQUIRED / STALE_EPOCH, ACCOUNT_NOT_ACTIVE,
 *                 SEND_DISABLED (send only), AUTO_SEND_DISABLED, BACKLOG_HELD, LOCK_LOST
 *   legacy actor: OWNER_CORE / ACCOUNT_DRAINING, STALE_EPOCH (when the caller tracks one), PATH_DISABLED,
 *                 BACKLOG_HELD. Module / kill / channel / per-account flags are Care policy and do not bind legacy.
 *
 * Defaults when a switch row is absent: everything ON (the module being Added is the opt-in).
 */
import type Database from 'better-sqlite3';
import type { CareActorType, CareChannel, CareWriteOwner } from '../../../_lib/care-kit/types.js';
import { CareOwnershipStore, isBacklogHeld, readRuntimeSwitches, type OwnershipLock } from '../persistence/ownership-store.js';

export type DispatchActorKind = 'core' | 'legacy';

/** Who is asking. A path switch (`path:<source>`) disables that path for BOTH actor kinds. */
export const DISPATCH_SOURCES = ['worker', 'job', 'api', 'cli', 'schedule', 'ui', 'campaign', 'responder', 'sender'] as const;
export type DispatchSource = (typeof DISPATCH_SOURCES)[number];

export type DispatchDenyCode =
  | 'ACCOUNT_NOT_FOUND'
  | 'KILL_SWITCH'
  | 'MODULE_DISABLED'
  | 'PATH_DISABLED'
  | 'CHANNEL_DISABLED'
  | 'OWNER_LEGACY'
  | 'OWNER_CORE'
  | 'ACCOUNT_DRAINING'
  | 'EPOCH_REQUIRED'
  | 'STALE_EPOCH'
  | 'ACCOUNT_NOT_ACTIVE'
  | 'SEND_DISABLED'
  | 'AUTO_SEND_DISABLED'
  | 'BACKLOG_HELD'
  | 'LOCK_LOST'
  | 'INVALID_SOURCE';

export type DispatchAllowCode = 'OK' | 'LEGACY_NOT_BRIDGED';

export type DispatchDecision =
  | { allow: true; code: DispatchAllowCode; accountId: string | null; owner: CareWriteOwner | null; epoch: number | null }
  | {
      allow: false;
      code: DispatchDenyCode;
      message: string;
      accountId: string | null;
      owner: CareWriteOwner | null;
      epoch: number | null;
      /** Extra stable detail, e.g. the ownership-lock denial reason for LOCK_LOST. */
      detail?: string;
    };

export interface DispatchGateOptions {
  /** `send` (default) = an outbound dispatch; `work` = ingest/model/sync (no kill switch, send flag or auto-send). */
  operation?: 'send' | 'work';
  /** auto-send is a separate global switch; manual/approved sends are not bound by it. */
  actorType?: CareActorType;
  /** A queue item (job id, outbox intent id...) to check against backlog holds. */
  item?: { kind: string; id: string };
  /** When given (core worker), the holder lock must still be valid at this instant. */
  lock?: OwnershipLock;
  nowMs?: number;
}

interface AccountGateRow {
  id: string;
  channel: CareChannel;
  write_owner: CareWriteOwner;
  owner_epoch: number;
  desired_state: string;
  send_enabled: number;
}

export function switchKeyForPath(source: DispatchSource): string {
  return `path:${source}`;
}

export function evaluateDispatchGate(
  db: Database.Database,
  accountId: string,
  epoch: number | null,
  actorKind: DispatchActorKind,
  source: DispatchSource,
  opts: DispatchGateOptions = {},
): DispatchDecision {
  // One deferred read transaction = one consistent snapshot of account row, switches and holds.
  return db.transaction((): DispatchDecision => decide(db, accountId, epoch, actorKind, source, opts))();
}

function decide(
  db: Database.Database,
  accountId: string,
  epoch: number | null,
  actorKind: DispatchActorKind,
  source: DispatchSource,
  opts: DispatchGateOptions,
): DispatchDecision {
  const operation = opts.operation ?? 'send';
  const deny = (code: DispatchDenyCode, message: string, a?: AccountGateRow, detail?: string): DispatchDecision => ({
    allow: false,
    code,
    message,
    accountId,
    owner: a?.write_owner ?? null,
    epoch: a ? Number(a.owner_epoch) : null,
    ...(detail === undefined ? {} : { detail }),
  });

  if (!(DISPATCH_SOURCES as readonly string[]).includes(source)) return deny('INVALID_SOURCE', `Unknown dispatch source: ${String(source)}`);
  if (actorKind !== 'core' && actorKind !== 'legacy') return deny('OWNER_LEGACY', 'Unknown actor kind');

  const a = db
    .prepare('SELECT id, channel, write_owner, owner_epoch, desired_state, send_enabled FROM care_accounts WHERE id = ?')
    .get(accountId) as AccountGateRow | undefined;
  if (!a) return deny('ACCOUNT_NOT_FOUND', 'Care account not found');
  const currentEpoch = Number(a.owner_epoch);
  const switches = readRuntimeSwitches(db);
  const off = (key: string, defaultOn: boolean) => {
    const row = switches.get(key);
    return row ? !row.enabled : !defaultOn;
  };

  if (actorKind === 'core') {
    if (operation === 'send' && off('dispatch', true)) return deny('KILL_SWITCH', 'Care dispatch kill switch is engaged', a);
    if (off('module', true)) return deny('MODULE_DISABLED', 'Customer Care module is disabled', a);
    if (off(switchKeyForPath(source), true)) return deny('PATH_DISABLED', `Dispatch path "${source}" is disabled`, a);
    if (off(`channel:${a.channel}`, true)) return deny('CHANNEL_DISABLED', `Channel "${a.channel}" is disabled`, a);
    if (a.write_owner === 'legacy') return deny('OWNER_LEGACY', 'Account is owned by the legacy sender; Care must not dispatch', a);
    if (a.write_owner === 'draining') return deny('ACCOUNT_DRAINING', 'Account is draining; no dispatch by anyone until cutover resolves', a);
    if (epoch === null || !Number.isSafeInteger(epoch)) return deny('EPOCH_REQUIRED', 'A core dispatcher must present the owner epoch it runs under', a);
    if (epoch !== currentEpoch) return deny('STALE_EPOCH', `Epoch ${epoch} is not the account epoch ${currentEpoch}`, a);
    if (a.desired_state !== 'active') return deny('ACCOUNT_NOT_ACTIVE', `Account desired state is "${a.desired_state}"`, a);
    if (operation === 'send') {
      if (a.send_enabled !== 1) return deny('SEND_DISABLED', 'Account send flag is off', a);
      if (opts.actorType === 'auto' && off('auto_send', true)) return deny('AUTO_SEND_DISABLED', 'Auto-send is disabled', a);
    }
  } else {
    if (a.write_owner === 'core') return deny('OWNER_CORE', 'Account is owned by Care core; the legacy sender must not dispatch', a);
    if (a.write_owner === 'draining') return deny('ACCOUNT_DRAINING', 'Account is draining; no dispatch by anyone until cutover resolves', a);
    if (epoch !== null && epoch !== currentEpoch) return deny('STALE_EPOCH', `Legacy epoch ${epoch} is not the account epoch ${currentEpoch}`, a);
    if (off(switchKeyForPath(source), true)) return deny('PATH_DISABLED', `Dispatch path "${source}" is disabled`, a);
  }

  if (opts.item && isBacklogHeld(db, opts.item.kind, opts.item.id)) {
    return deny('BACKLOG_HELD', 'Item is parked for review after a re-enable', a);
  }

  if (opts.lock) {
    if (opts.lock.accountId !== accountId) return deny('LOCK_LOST', 'Lock belongs to another account', a, 'NOT_HOLDER');
    const check = new CareOwnershipStore(db).verify(opts.lock, opts.nowMs);
    if (!check.ok) return deny('LOCK_LOST', 'Ownership lock is no longer valid', a, check.reason);
  }

  return { allow: true, code: 'OK', accountId, owner: a.write_owner, epoch: currentEpoch };
}
