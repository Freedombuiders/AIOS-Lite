/**
 * CC-12 account ownership lock, runtime switches, backlog holds and the cutover audit log.
 *
 * Four independent pieces of durable state, all fail-closed:
 *
 *  1. care_account_holders  - ONE row per account: who currently holds the dispatch lock. A holder is a
 *     (holderId, processToken) pair where processToken is a random value generated at process start;
 *     a PID is informational only, so a recycled PID can never renew, release or steal a lock.
 *     Every mutation is a compare-and-swap in one statement/transaction on (holder, token, lock_seq).
 *     The lock also carries the GENERATION (= care_accounts.owner_epoch) it was acquired under: a holder
 *     whose generation is older than the account's current epoch can never acquire, renew or verify.
 *     Lock expiry is local coordination only; it is NEVER evidence that a provider RPC did not happen.
 *  2. care_runtime_switches - module / dispatch (kill) / channel / path switches, read by the gate.
 *  3. care_backlog_holds    - pending items parked at re-enable time for explicit review.
 *  4. care_cutover_log      - append-only audit of every owner transition (applied or refused).
 *
 * `ensureOwnershipSchema(db)` is called from createCareSchema inside its IMMEDIATE transaction on every
 * boot, so it is additive and idempotent. `CareOwnershipStore` is exposed as `stores.ownership`.
 */
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { CareError } from '../../../_lib/care-kit/errors.js';
import type { CareWriteOwner } from '../../../_lib/care-kit/types.js';
import { CARE_CHANNELS, oneOf, requireNonEmptyString, requireSafeInteger } from '../../../_lib/care-kit/validation.js';
import type { CareKeyInput } from './crypto.js';

export function ensureOwnershipSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS care_account_holders (
      account_id     TEXT PRIMARY KEY REFERENCES care_accounts(id) ON DELETE CASCADE,
      role           TEXT NOT NULL CHECK (role IN ('core','legacy')),
      holder_id      TEXT NOT NULL,
      process_token  TEXT NOT NULL,
      pid            INTEGER,
      host           TEXT,
      generation     INTEGER NOT NULL CHECK (generation >= 1),
      lock_seq       INTEGER NOT NULL CHECK (lock_seq >= 1),
      acquired_at    INTEGER NOT NULL,
      heartbeat_at   INTEGER NOT NULL,
      expires_at     INTEGER NOT NULL,
      released_at    INTEGER
    );

    CREATE TABLE IF NOT EXISTS care_runtime_switches (
      switch_key     TEXT PRIMARY KEY,
      enabled        INTEGER NOT NULL CHECK (enabled IN (0,1)),
      enabled_since  INTEGER,
      changed_at     INTEGER NOT NULL,
      changed_by     TEXT NOT NULL,
      reason         TEXT
    );

    CREATE TABLE IF NOT EXISTS care_runtime_switch_log (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      switch_key  TEXT NOT NULL,
      from_state  INTEGER,
      to_state    INTEGER NOT NULL,
      actor       TEXT NOT NULL,
      reason      TEXT,
      at          INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS care_backlog_holds (
      item_kind    TEXT NOT NULL,
      item_id      TEXT NOT NULL,
      account_id   TEXT NOT NULL,
      status       TEXT NOT NULL CHECK (status IN ('held','released','discarded')),
      held_at      INTEGER NOT NULL,
      cutoff_at    INTEGER NOT NULL,
      reason       TEXT NOT NULL,
      held_by      TEXT NOT NULL,
      resolved_at  INTEGER,
      resolved_by  TEXT,
      PRIMARY KEY (item_kind, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_care_backlog_holds_account
      ON care_backlog_holds(account_id, status);

    -- Legacy dispatches (a direct Zalo send, an Email reply) that are MID-RPC. The legacy sender takes a row in the same
    -- transaction that re-checks ownership, and deletes it in a finally; the cutover probe counts every row, expired or
    -- not (an RPC that may still be out is never assumed finished). A process that dies leaves its rows behind: the
    -- sender's startup sweep clears them like the legacy 'interrupted' outbox rows (outcome unknown, never retried).
    CREATE TABLE IF NOT EXISTS care_legacy_inflight (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      source_kind       TEXT NOT NULL CHECK (source_kind IN ('zalo','email')),
      source_account_id TEXT NOT NULL,
      path              TEXT NOT NULL,
      started_at        INTEGER NOT NULL,
      expires_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_care_legacy_inflight_account ON care_legacy_inflight(source_kind, source_account_id);

    -- Append-only; deliberately NO foreign key so the trail survives account removal.
    CREATE TABLE IF NOT EXISTS care_cutover_log (
      seq             INTEGER PRIMARY KEY AUTOINCREMENT,
      id              TEXT NOT NULL UNIQUE,
      account_id      TEXT NOT NULL,
      from_owner      TEXT NOT NULL,
      to_owner        TEXT NOT NULL,
      epoch_before    INTEGER NOT NULL,
      epoch_after     INTEGER,
      transition_kind TEXT NOT NULL CHECK (transition_kind IN ('forward','rollback','abort')),
      outcome         TEXT NOT NULL CHECK (outcome IN ('applied','refused')),
      refusal_codes   TEXT,
      actor           TEXT NOT NULL,
      reason          TEXT NOT NULL,
      evidence_json   TEXT NOT NULL DEFAULT '[]',
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_care_cutover_log_account ON care_cutover_log(account_id, seq);

    -- Account re-enable (paused/disconnected -> active, or send flag off -> on) parks every pending job and outbox
    -- intent created at or before that moment (second granularity, rounded up) for explicit review. The trigger lives
    -- in the database, so API, CLI, bridge and any other writer get the same behaviour without remembering to call it.
    CREATE TRIGGER IF NOT EXISTS care_accounts_reenable_hold
    AFTER UPDATE OF desired_state, send_enabled ON care_accounts
    WHEN (NEW.desired_state = 'active' AND OLD.desired_state <> 'active') OR (NEW.send_enabled = 1 AND OLD.send_enabled = 0)
    BEGIN
      INSERT INTO care_backlog_holds (item_kind, item_id, account_id, status, held_at, cutoff_at, reason, held_by)
      SELECT 'job', j.id, j.account_id, 'held', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000 + 999,
             're-enabled:account', 'trigger'
      FROM care_jobs j
      WHERE j.account_id = NEW.id AND j.status = 'pending' AND j.job_type IN ('outbox_dispatch','inbound_turn')
        AND j.created_at <= CAST(strftime('%s','now') AS INTEGER) * 1000 + 999
      ON CONFLICT(item_kind, item_id) DO UPDATE SET
        status = 'held', held_at = excluded.held_at, cutoff_at = excluded.cutoff_at, reason = excluded.reason,
        held_by = excluded.held_by, resolved_at = NULL, resolved_by = NULL
      WHERE care_backlog_holds.status <> 'held';

      INSERT INTO care_backlog_holds (item_kind, item_id, account_id, status, held_at, cutoff_at, reason, held_by)
      SELECT 'outbox_intent', i.id, i.account_id, 'held', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000 + 999,
             're-enabled:account', 'trigger'
      FROM care_delivery_intents i
      WHERE i.account_id = NEW.id AND i.status IN ('pending','retry_wait')
        AND i.created_at <= CAST(strftime('%s','now') AS INTEGER) * 1000 + 999
      ON CONFLICT(item_kind, item_id) DO UPDATE SET
        status = 'held', held_at = excluded.held_at, cutoff_at = excluded.cutoff_at, reason = excluded.reason,
        held_by = excluded.held_by, resolved_at = NULL, resolved_by = NULL
      WHERE care_backlog_holds.status <> 'held';
    END;

    CREATE TRIGGER IF NOT EXISTS care_cutover_log_no_update BEFORE UPDATE ON care_cutover_log
    BEGIN SELECT RAISE(ABORT, 'care_cutover_log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS care_cutover_log_no_delete BEFORE DELETE ON care_cutover_log
    BEGIN SELECT RAISE(ABORT, 'care_cutover_log is append-only'); END;

    -- Retired: these named legacy tables, and SQLite compiles trigger bodies when the triggering statement is prepared,
    -- so on a database without those tables they broke every update of care_backlog_holds (and, through the re-enable
    -- trigger, every account re-enable). Discarding a held legacy row is done in resolveHold instead.
    DROP TRIGGER IF EXISTS care_hold_discard_legacy_zalo;
    DROP TRIGGER IF EXISTS care_hold_discard_legacy_email;
  `);

}

// ── ownership lock ───────────────────────────────────────────────────────────────────────────

export type OwnershipRole = 'core' | 'legacy';

export type OwnershipDenial =
  | 'ACCOUNT_NOT_FOUND'
  /** Caller generation older than the account epoch: a superseded owner. */
  | 'STALE_GENERATION'
  /** Caller generation newer than the account epoch: the caller has information the DB does not. */
  | 'GENERATION_AHEAD'
  | 'DRAINING'
  /** Role does not match the account's write_owner (core worker on a legacy account and vice versa). */
  | 'OWNER_MISMATCH'
  | 'HELD_BY_OTHER'
  /** Not the current holder (never held, or superseded by a later lock_seq / process token). */
  | 'NOT_HOLDER'
  | 'RELEASED'
  | 'EXPIRED';

export interface OwnershipLock {
  accountId: string;
  role: OwnershipRole;
  holderId: string;
  /** Random per process start. NOT a PID. */
  processToken: string;
  /** owner_epoch the lock was acquired under. */
  generation: number;
  /** Monotonic per account; a later acquisition by anyone supersedes every earlier one. */
  lockSeq: number;
  acquiredAtMs: number;
  expiresAtMs: number;
}

export type OwnershipResult =
  | { ok: true; lock: OwnershipLock }
  | { ok: false; reason: OwnershipDenial; currentEpoch?: number; currentOwner?: CareWriteOwner; heldBy?: string; heldUntilMs?: number };

export type OwnershipCheck =
  | { ok: true }
  | { ok: false; reason: OwnershipDenial; currentEpoch?: number; currentOwner?: CareWriteOwner };

export interface AcquireInput {
  accountId: string;
  holderId: string;
  processToken: string;
  role: OwnershipRole;
  /** The owner_epoch the caller believes is current (the generation handshake). */
  generation: number;
  ttlMs: number;
  nowMs?: number;
  /** Informational only; never used for any decision. */
  pid?: number;
  host?: string;
}

// ── switches / holds / cutover ───────────────────────────────────────────────────────────────

/**
 * Switch keys: `module`, `dispatch` (global; disabled = kill switch engaged), `ai`, `auto_send`,
 * `channel:<zalo|telegram|email>`, `path:<dispatch path>`.
 */
export type RuntimeSwitchKey = string;

export interface RuntimeSwitchRecord {
  key: RuntimeSwitchKey;
  enabled: boolean;
  /** When the switch last turned (or was created) on; the "re-enable moment". */
  enabledSinceMs: number | null;
  changedAtMs: number;
  changedBy: string;
  reason: string | null;
}

export interface SetSwitchResult {
  key: RuntimeSwitchKey;
  /** null = the switch did not exist before. */
  previous: boolean | null;
  enabled: boolean;
  /** True when the switch moved from off to on (backlog must be held). */
  reenabled: boolean;
  atMs: number;
}

export type BacklogHoldStatus = 'held' | 'released' | 'discarded';

export interface BacklogHoldRecord {
  itemKind: string;
  itemId: string;
  accountId: string;
  status: BacklogHoldStatus;
  heldAtMs: number;
  cutoffMs: number;
  reason: string;
  heldBy: string;
  resolvedAtMs: number | null;
  resolvedBy: string | null;
}

export type CutoverKind = 'forward' | 'rollback' | 'abort';

export interface CutoverLogEntry {
  seq: number;
  id: string;
  accountId: string;
  fromOwner: CareWriteOwner;
  toOwner: CareWriteOwner;
  epochBefore: number;
  epochAfter: number | null;
  kind: CutoverKind;
  outcome: 'applied' | 'refused';
  refusalCodes: string[];
  actor: string;
  reason: string;
  evidence: string[];
  createdAtMs: number;
}

export interface OwnerTransitionInput {
  accountId: string;
  expectedOwner: CareWriteOwner;
  expectedEpoch: number;
  toOwner: CareWriteOwner;
  kind: CutoverKind;
  actor: string;
  reason: string;
  evidence?: string[];
  nowMs?: number;
}

export type OwnerTransitionResult =
  | { ok: true; epochBefore: number; epochAfter: number; logId: string }
  | { ok: false; code: 'ACCOUNT_NOT_FOUND' | 'CAS_MISMATCH'; currentOwner?: CareWriteOwner; currentEpoch?: number };

/** The only legal owner edges. Direct legacy<->core is never allowed: every change passes through draining. */
const LEGAL_EDGES: ReadonlyArray<readonly [CareWriteOwner, CareWriteOwner]> = [
  ['legacy', 'draining'],
  ['core', 'draining'],
  ['draining', 'core'],
  ['draining', 'legacy'],
];

const SWITCH_KEY = /^(module|dispatch|ai|auto_send|channel:[a-z]+|path:[a-z_]+)$/;
const MAX_EVIDENCE = 50;
const MAX_FIELD = 500;

function cleanText(value: unknown, label: string, max = MAX_FIELD): string {
  const s = requireNonEmptyString(value, label, max);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new CareError('INVALID_COMMAND', `${label} contains control characters`, 400);
  return s;
}

function cleanEvidence(evidence: unknown): string[] {
  if (evidence === undefined) return [];
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE) {
    throw new CareError('INVALID_COMMAND', `evidence must be an array of at most ${MAX_EVIDENCE} references`, 400);
  }
  return evidence.map((e, i) => cleanText(e, `evidence[${i}]`, 256));
}

export function validateSwitchKey(key: unknown): RuntimeSwitchKey {
  const k = requireNonEmptyString(key, 'switchKey', 64);
  if (!SWITCH_KEY.test(k)) throw new CareError('INVALID_COMMAND', `Unknown switch key: ${k}`, 400);
  if (k.startsWith('channel:')) oneOf(CARE_CHANNELS, k.slice('channel:'.length), 'switch channel');
  return k;
}

function mapHolder(row: any): OwnershipLock {
  return {
    accountId: row.account_id,
    role: row.role,
    holderId: row.holder_id,
    processToken: row.process_token,
    generation: Number(row.generation),
    lockSeq: Number(row.lock_seq),
    acquiredAtMs: Number(row.acquired_at),
    expiresAtMs: Number(row.expires_at),
  };
}

function mapHold(row: any): BacklogHoldRecord {
  return {
    itemKind: row.item_kind,
    itemId: row.item_id,
    accountId: row.account_id,
    status: row.status,
    heldAtMs: Number(row.held_at),
    cutoffMs: Number(row.cutoff_at),
    reason: row.reason,
    heldBy: row.held_by,
    resolvedAtMs: row.resolved_at === null ? null : Number(row.resolved_at),
    resolvedBy: row.resolved_by,
  };
}

function mapLog(row: any): CutoverLogEntry {
  return {
    seq: Number(row.seq),
    id: row.id,
    accountId: row.account_id,
    fromOwner: row.from_owner,
    toOwner: row.to_owner,
    epochBefore: Number(row.epoch_before),
    epochAfter: row.epoch_after === null ? null : Number(row.epoch_after),
    kind: row.transition_kind,
    outcome: row.outcome,
    refusalCodes: row.refusal_codes ? (JSON.parse(row.refusal_codes) as string[]) : [],
    actor: row.actor,
    reason: row.reason,
    evidence: JSON.parse(row.evidence_json) as string[],
    createdAtMs: Number(row.created_at),
  };
}

/** Read-only snapshot of every switch row (used by the gate). */
export function readRuntimeSwitches(db: Database.Database): Map<RuntimeSwitchKey, RuntimeSwitchRecord> {
  const rows = db.prepare('SELECT * FROM care_runtime_switches').all() as any[];
  const out = new Map<RuntimeSwitchKey, RuntimeSwitchRecord>();
  for (const r of rows) {
    out.set(r.switch_key, {
      key: r.switch_key,
      enabled: r.enabled === 1,
      enabledSinceMs: r.enabled_since === null ? null : Number(r.enabled_since),
      changedAtMs: Number(r.changed_at),
      changedBy: r.changed_by,
      reason: r.reason,
    });
  }
  return out;
}

/** True when an item is currently parked for review. */
export function isBacklogHeld(db: Database.Database, itemKind: string, itemId: string): boolean {
  const row = db.prepare('SELECT status FROM care_backlog_holds WHERE item_kind = ? AND item_id = ?').get(itemKind, itemId) as
    | { status: BacklogHoldStatus }
    | undefined;
  return row?.status === 'held';
}

export class CareOwnershipStore {
  constructor(
    protected readonly db: Database.Database,
    protected readonly key?: CareKeyInput,
  ) {}

  // ── lock ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Generation handshake + acquire, atomically. Succeeds only when ALL hold:
   *  - the caller's generation equals the account's current owner_epoch,
   *  - the account is not draining and its write_owner equals the caller's role,
   *  - nobody else holds an unexpired, current-generation lock (same holder + same process token
   *    re-acquiring simply renews).
   * A lock row of an older generation is dead on arrival and is taken over immediately.
   */
  acquire(input: AcquireInput): OwnershipResult {
    const accountId = requireNonEmptyString(input.accountId, 'accountId', 256);
    const holderId = cleanText(input.holderId, 'holderId', 256);
    const processToken = cleanText(input.processToken, 'processToken', 256);
    const role = oneOf(['core', 'legacy'] as const, input.role, 'role');
    const generation = requireSafeInteger(input.generation, 'generation', 1);
    const ttlMs = requireSafeInteger(input.ttlMs, 'ttlMs', 1);
    const now = input.nowMs ?? Date.now();

    const run = this.db.transaction((): OwnershipResult => {
      const acct = this.db.prepare('SELECT write_owner, owner_epoch FROM care_accounts WHERE id = ?').get(accountId) as
        | { write_owner: CareWriteOwner; owner_epoch: number }
        | undefined;
      if (!acct) return { ok: false, reason: 'ACCOUNT_NOT_FOUND' };
      const epoch = Number(acct.owner_epoch);
      const base = { currentEpoch: epoch, currentOwner: acct.write_owner };
      if (generation < epoch) return { ok: false, reason: 'STALE_GENERATION', ...base };
      if (generation > epoch) return { ok: false, reason: 'GENERATION_AHEAD', ...base };
      if (acct.write_owner === 'draining') return { ok: false, reason: 'DRAINING', ...base };
      if (acct.write_owner !== role) return { ok: false, reason: 'OWNER_MISMATCH', ...base };

      const row = this.db.prepare('SELECT * FROM care_account_holders WHERE account_id = ?').get(accountId) as any;
      const expiresAt = now + ttlMs;
      if (!row) {
        this.db
          .prepare(
            `INSERT INTO care_account_holders
               (account_id, role, holder_id, process_token, pid, host, generation, lock_seq, acquired_at, heartbeat_at, expires_at, released_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL)`,
          )
          .run(accountId, role, holderId, processToken, input.pid ?? null, input.host ?? null, epoch, now, now, expiresAt);
        return { ok: true, lock: this.requireLock(accountId) };
      }

      const sameIdentity = row.holder_id === holderId && row.process_token === processToken;
      const live =
        row.released_at === null &&
        Number(row.expires_at) >= now &&
        Number(row.generation) === epoch &&
        row.role === acct.write_owner;
      if (live && !sameIdentity) {
        return { ok: false, reason: 'HELD_BY_OTHER', ...base, heldBy: row.holder_id, heldUntilMs: Number(row.expires_at) };
      }
      if (live && sameIdentity) {
        this.db
          .prepare('UPDATE care_account_holders SET heartbeat_at = ?, expires_at = ? WHERE account_id = ? AND lock_seq = ?')
          .run(now, expiresAt, accountId, row.lock_seq);
        return { ok: true, lock: this.requireLock(accountId) };
      }
      // Free, expired, released or superseded generation: takeover under a NEW lock_seq so every
      // earlier holder identity is invalidated, including a previous incarnation of this holder.
      this.db
        .prepare(
          `UPDATE care_account_holders SET
             role = ?, holder_id = ?, process_token = ?, pid = ?, host = ?, generation = ?,
             lock_seq = lock_seq + 1, acquired_at = ?, heartbeat_at = ?, expires_at = ?, released_at = NULL
           WHERE account_id = ?`,
        )
        .run(role, holderId, processToken, input.pid ?? null, input.host ?? null, epoch, now, now, expiresAt, accountId);
      return { ok: true, lock: this.requireLock(accountId) };
    });
    return run.immediate();
  }

  /** Heartbeat. One CAS statement: identity, lock_seq, generation == CURRENT epoch, role == CURRENT owner, unexpired. */
  renew(lock: OwnershipLock, opts: { ttlMs: number; nowMs?: number }): OwnershipResult {
    const ttlMs = requireSafeInteger(opts.ttlMs, 'ttlMs', 1);
    const now = opts.nowMs ?? Date.now();
    const run = this.db.transaction((): OwnershipResult => {
      const res = this.db
        .prepare(
          `UPDATE care_account_holders SET heartbeat_at = ?, expires_at = ?
           WHERE account_id = ? AND holder_id = ? AND process_token = ? AND lock_seq = ?
             AND released_at IS NULL AND expires_at >= ?
             AND generation = ? AND role = ?
             AND EXISTS (SELECT 1 FROM care_accounts a WHERE a.id = care_account_holders.account_id
                           AND a.owner_epoch = care_account_holders.generation
                           AND a.write_owner = care_account_holders.role)`,
        )
        .run(now, now + ttlMs, lock.accountId, lock.holderId, lock.processToken, lock.lockSeq, now, lock.generation, lock.role);
      if (res.changes > 0) return { ok: true, lock: this.requireLock(lock.accountId) };
      const why = this.diagnose(lock, now);
      return why.ok ? { ok: false, reason: 'NOT_HOLDER' } : why;
    });
    return run.immediate();
  }

  /** Read-only: may this lock still act right now? Call right before an RPC. */
  verify(lock: OwnershipLock, nowMs?: number): OwnershipCheck {
    return this.diagnose(lock, nowMs ?? Date.now());
  }

  /** CAS release by exact identity; a superseded or foreign lock cannot release someone else's. */
  release(lock: OwnershipLock, nowMs?: number): boolean {
    const now = nowMs ?? Date.now();
    const res = this.db
      .prepare(
        `UPDATE care_account_holders SET released_at = ?, expires_at = ?
         WHERE account_id = ? AND holder_id = ? AND process_token = ? AND lock_seq = ? AND released_at IS NULL`,
      )
      .run(now, now, lock.accountId, lock.holderId, lock.processToken, lock.lockSeq);
    return res.changes > 0;
  }

  getHolder(accountId: string): (OwnershipLock & { pid: number | null; host: string | null; heartbeatAtMs: number; releasedAtMs: number | null }) | null {
    const row = this.db.prepare('SELECT * FROM care_account_holders WHERE account_id = ?').get(accountId) as any;
    if (!row) return null;
    return {
      ...mapHolder(row),
      pid: row.pid === null ? null : Number(row.pid),
      host: row.host,
      heartbeatAtMs: Number(row.heartbeat_at),
      releasedAtMs: row.released_at === null ? null : Number(row.released_at),
    };
  }

  private requireLock(accountId: string): OwnershipLock {
    return mapHolder(this.db.prepare('SELECT * FROM care_account_holders WHERE account_id = ?').get(accountId));
  }

  private diagnose(lock: OwnershipLock, now: number): OwnershipCheck {
    const acct = this.db.prepare('SELECT write_owner, owner_epoch FROM care_accounts WHERE id = ?').get(lock.accountId) as
      | { write_owner: CareWriteOwner; owner_epoch: number }
      | undefined;
    if (!acct) return { ok: false, reason: 'ACCOUNT_NOT_FOUND' };
    const base = { currentEpoch: Number(acct.owner_epoch), currentOwner: acct.write_owner };
    const row = this.db.prepare('SELECT * FROM care_account_holders WHERE account_id = ?').get(lock.accountId) as any;
    if (!row || row.holder_id !== lock.holderId || row.process_token !== lock.processToken || Number(row.lock_seq) !== lock.lockSeq) {
      return { ok: false, reason: 'NOT_HOLDER', ...base };
    }
    // Generation / owner come BEFORE time: a superseded owner is stale no matter how fresh its heartbeat.
    if (Number(row.generation) !== base.currentEpoch || lock.generation !== base.currentEpoch) {
      return { ok: false, reason: 'STALE_GENERATION', ...base };
    }
    if (acct.write_owner === 'draining') return { ok: false, reason: 'DRAINING', ...base };
    if (acct.write_owner !== row.role) return { ok: false, reason: 'OWNER_MISMATCH', ...base };
    if (row.released_at !== null) return { ok: false, reason: 'RELEASED', ...base };
    if (Number(row.expires_at) < now) return { ok: false, reason: 'EXPIRED', ...base };
    return { ok: true };
  }

  // ── runtime switches ───────────────────────────────────────────────────────────────────────

  /** Idempotent set. Reports whether this call turned the switch back ON (the caller must hold the backlog). */
  setSwitch(keyIn: RuntimeSwitchKey, enabled: boolean, meta: { actor: string; reason?: string; nowMs?: number }): SetSwitchResult {
    const key = validateSwitchKey(keyIn);
    const actor = cleanText(meta.actor, 'actor', 128);
    const reason = meta.reason === undefined ? null : cleanText(meta.reason, 'reason');
    const now = meta.nowMs ?? Date.now();
    const run = this.db.transaction((): SetSwitchResult => {
      const prev = this.db.prepare('SELECT enabled FROM care_runtime_switches WHERE switch_key = ?').get(key) as { enabled: number } | undefined;
      const previous = prev ? prev.enabled === 1 : null;
      // `module` is opt-in: an absent row already means OFF, so its first enable is a re-enable too.
      const reenabled = enabled && (previous === false || (previous === null && key === 'module'));
      if (previous === enabled) return { key, previous, enabled, reenabled: false, atMs: now };
      this.db
        .prepare(
          `INSERT INTO care_runtime_switches (switch_key, enabled, enabled_since, changed_at, changed_by, reason)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(switch_key) DO UPDATE SET
             enabled = excluded.enabled,
             enabled_since = CASE WHEN excluded.enabled = 1 THEN excluded.enabled_since ELSE care_runtime_switches.enabled_since END,
             changed_at = excluded.changed_at, changed_by = excluded.changed_by, reason = excluded.reason`,
        )
        .run(key, enabled ? 1 : 0, enabled ? now : null, now, actor, reason);
      this.db
        .prepare('INSERT INTO care_runtime_switch_log (switch_key, from_state, to_state, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(key, previous === null ? null : previous ? 1 : 0, enabled ? 1 : 0, actor, reason, now);
      return { key, previous, enabled, reenabled, atMs: now };
    });
    return run.immediate();
  }

  getSwitch(key: RuntimeSwitchKey): RuntimeSwitchRecord | null {
    return readRuntimeSwitches(this.db).get(validateSwitchKey(key)) ?? null;
  }

  listSwitches(): RuntimeSwitchRecord[] {
    return [...readRuntimeSwitches(this.db).values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  // ── backlog holds ──────────────────────────────────────────────────────────────────────────

  /** Parks items for explicit review. Re-holding an already resolved item holds it again (a later re-enable). */
  holdItems(
    items: ReadonlyArray<{ kind: string; id: string; accountId: string }>,
    meta: { cutoffMs: number; reason: string; actor: string; nowMs?: number },
  ): number {
    const now = meta.nowMs ?? Date.now();
    const reason = cleanText(meta.reason, 'reason');
    const actor = cleanText(meta.actor, 'actor', 128);
    const cutoff = requireSafeInteger(meta.cutoffMs, 'cutoffMs', 0);
    const stmt = this.db.prepare(
      `INSERT INTO care_backlog_holds (item_kind, item_id, account_id, status, held_at, cutoff_at, reason, held_by)
       VALUES (?, ?, ?, 'held', ?, ?, ?, ?)
       ON CONFLICT(item_kind, item_id) DO UPDATE SET
         status = 'held', held_at = excluded.held_at, cutoff_at = excluded.cutoff_at, reason = excluded.reason,
         held_by = excluded.held_by, resolved_at = NULL, resolved_by = NULL
       WHERE care_backlog_holds.status <> 'held'`,
    );
    const run = this.db.transaction(() => {
      let n = 0;
      for (const it of items) n += stmt.run(cleanText(it.kind, 'kind', 64), cleanText(it.id, 'id', 256), it.accountId, now, cutoff, reason, actor).changes;
      return n;
    });
    return run.immediate();
  }

  isHeld(kind: string, id: string): boolean {
    return isBacklogHeld(this.db, kind, id);
  }

  /**
   * Explicit review outcome. Only a currently held item can be resolved. Discarding a held LEGACY outbox row also closes
   * that row (status `discarded`) in the same transaction, so a discarded hold can never turn into a sendable row.
   */
  resolveHold(kind: string, id: string, resolution: 'released' | 'discarded', meta: { actor: string; nowMs?: number }): boolean {
    const now = meta.nowMs ?? Date.now();
    const outcome = oneOf(['released', 'discarded'] as const, resolution, 'resolution');
    const actor = cleanText(meta.actor, 'actor', 128);
    const run = this.db.transaction((): boolean => {
      const res = this.db
        .prepare(`UPDATE care_backlog_holds SET status = ?, resolved_at = ?, resolved_by = ? WHERE item_kind = ? AND item_id = ? AND status = 'held'`)
        .run(outcome, now, actor, kind, id);
      if (res.changes === 0) return false;
      if (outcome === 'discarded' && (kind === 'zalo_outbox' || kind === 'email_outbox')) {
        const exists = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(kind);
        if (exists) this.db.prepare(`UPDATE ${kind} SET status = 'discarded' WHERE id = CAST(? AS INTEGER) AND status IN ('pending','draft')`).run(id);
      }
      return true;
    });
    return run.immediate();
  }

  listHolds(filter: { accountId?: string; status?: BacklogHoldStatus } = {}): BacklogHoldRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.accountId) {
      where.push('account_id = ?');
      params.push(filter.accountId);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    const sql = `SELECT * FROM care_backlog_holds ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY held_at ASC, item_kind ASC, item_id ASC`;
    return (this.db.prepare(sql).all(...params) as any[]).map(mapHold);
  }

  // ── cutover ────────────────────────────────────────────────────────────────────────────────

  /**
   * Atomic owner transition: CAS on (write_owner, owner_epoch), epoch strictly +1, audit row in the SAME
   * transaction. A mismatch aborts without writing (the controller records the refusal separately).
   * This does not look at lock expiry, in-flight work or switches: those are the controller's gates.
   */
  applyOwnerTransition(input: OwnerTransitionInput): OwnerTransitionResult {
    const accountId = requireNonEmptyString(input.accountId, 'accountId', 256);
    const from = oneOf(['legacy', 'draining', 'core'] as const, input.expectedOwner, 'expectedOwner');
    const to = oneOf(['legacy', 'draining', 'core'] as const, input.toOwner, 'toOwner');
    const expectedEpoch = requireSafeInteger(input.expectedEpoch, 'expectedEpoch', 1);
    const kind = oneOf(['forward', 'rollback', 'abort'] as const, input.kind, 'kind');
    const actor = cleanText(input.actor, 'actor', 128);
    const reason = cleanText(input.reason, 'reason');
    const evidence = cleanEvidence(input.evidence);
    if (!LEGAL_EDGES.some(([a, b]) => a === from && b === to)) {
      throw new CareError('CONFIGURATION_CONFLICT', `Illegal owner transition ${from} -> ${to}`, 409);
    }
    const now = input.nowMs ?? Date.now();

    const run = this.db.transaction((): OwnerTransitionResult => {
      const acct = this.db.prepare('SELECT write_owner, owner_epoch FROM care_accounts WHERE id = ?').get(accountId) as
        | { write_owner: CareWriteOwner; owner_epoch: number }
        | undefined;
      if (!acct) return { ok: false, code: 'ACCOUNT_NOT_FOUND' };
      const epoch = Number(acct.owner_epoch);
      if (acct.write_owner !== from || epoch !== expectedEpoch) {
        return { ok: false, code: 'CAS_MISMATCH', currentOwner: acct.write_owner, currentEpoch: epoch };
      }
      const upd = this.db
        .prepare(
          `UPDATE care_accounts SET write_owner = ?, owner_epoch = owner_epoch + 1, updated_at = ?
           WHERE id = ? AND write_owner = ? AND owner_epoch = ?`,
        )
        .run(to, now, accountId, from, expectedEpoch);
      if (upd.changes !== 1) return { ok: false, code: 'CAS_MISMATCH', currentOwner: acct.write_owner, currentEpoch: epoch };
      const id = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO care_cutover_log
             (id, account_id, from_owner, to_owner, epoch_before, epoch_after, transition_kind, outcome, refusal_codes, actor, reason, evidence_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'applied', NULL, ?, ?, ?, ?)`,
        )
        .run(id, accountId, from, to, expectedEpoch, expectedEpoch + 1, kind, actor, reason, JSON.stringify(evidence), now);
      return { ok: true, epochBefore: expectedEpoch, epochAfter: expectedEpoch + 1, logId: id };
    });
    return run.immediate();
  }

  /** Audit of an attempt that did NOT change ownership (blockers, CAS mismatch). Account state is untouched. */
  recordRefusedTransition(input: {
    accountId: string;
    fromOwner: CareWriteOwner;
    toOwner: CareWriteOwner;
    epochBefore: number;
    kind: CutoverKind;
    actor: string;
    reason: string;
    refusalCodes: string[];
    evidence?: string[];
    nowMs?: number;
  }): string {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO care_cutover_log
           (id, account_id, from_owner, to_owner, epoch_before, epoch_after, transition_kind, outcome, refusal_codes, actor, reason, evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, 'refused', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        requireNonEmptyString(input.accountId, 'accountId', 256),
        oneOf(['legacy', 'draining', 'core'] as const, input.fromOwner, 'fromOwner'),
        oneOf(['legacy', 'draining', 'core'] as const, input.toOwner, 'toOwner'),
        requireSafeInteger(input.epochBefore, 'epochBefore', 0),
        oneOf(['forward', 'rollback', 'abort'] as const, input.kind, 'kind'),
        JSON.stringify(input.refusalCodes.slice(0, 50).map((c) => String(c).slice(0, 128))),
        cleanText(input.actor, 'actor', 128),
        cleanText(input.reason, 'reason'),
        JSON.stringify(cleanEvidence(input.evidence)),
        input.nowMs ?? Date.now(),
      );
    return id;
  }

  listCutoverLog(accountId: string): CutoverLogEntry[] {
    return (this.db.prepare('SELECT * FROM care_cutover_log WHERE account_id = ? ORDER BY seq ASC').all(accountId) as any[]).map(mapLog);
  }

  /** Last APPLIED entry that moved the account into `draining` (where an abort must return to). */
  lastDrainOrigin(accountId: string): { origin: Exclude<CareWriteOwner, 'draining'>; epochAfter: number } | null {
    const row = this.db
      .prepare(
        `SELECT from_owner, epoch_after FROM care_cutover_log
         WHERE account_id = ? AND outcome = 'applied' AND to_owner = 'draining' ORDER BY seq DESC LIMIT 1`,
      )
      .get(accountId) as { from_owner: 'legacy' | 'core'; epoch_after: number } | undefined;
    return row ? { origin: row.from_owner, epochAfter: Number(row.epoch_after) } : null;
  }
}
