/**
 * Legacy-bridge persistence: capture registry, per-account bridge progress, non-dispatching
 * artifacts and journal retention pins. Nothing here can send, enqueue a deliverable intent or
 * start a model turn: artifacts are mirrors (`dispatchable` is constrained to 0 by the schema).
 */

import type Database from 'better-sqlite3';
import { CareError } from '../../../_lib/care-kit/errors.js';
import { requireNonEmptyString, requireSafeInteger } from '../../../_lib/care-kit/validation.js';
import { decryptCareJson, encryptCareJson, type CareKeyInput } from './crypto.js';
import { requireAccountRow } from './shared.js';

export type BridgeSourceKind = 'zalo' | 'email';
export type BridgeStatus = 'enabled' | 'backfilling' | 'backfilled' | 'disabled';

export interface CaptureRegistration {
  sourceKind: BridgeSourceKind;
  sourceAccountId: string;
  careAccountId: string;
  enabled: boolean;
  enabledAtMs: number | null;
}

export interface BridgeState {
  careAccountId: string;
  sourceKind: BridgeSourceKind;
  sourceAccountId: string;
  status: BridgeStatus;
  /** Journal watermark taken in the same transaction that turned capture on. */
  watermarkS0: number;
  /** Per-table "last primary key done" backfill cursors (IDs only, no content). */
  cursors: Record<string, string>;
  /** Highest journal sequence already replayed into canonical state. */
  appliedSeq: number;
  backfillDoneAtMs: number | null;
}

export interface BridgeArtifact {
  id: string;
  accountId: string;
  sourceKind: BridgeSourceKind;
  sourceTable: string;
  sourceId: string;
  state: string | null;
  sourceDeleted: boolean;
  sourceVersion: number;
  payload: Record<string, unknown>;
  dispatchable: false;
}

export class CareBridgeStore {
  constructor(
    private readonly db: Database.Database,
    private readonly key?: CareKeyInput,
  ) {}

  // ── capture registry (also read by the capture triggers) ─────────────────────────────────
  register(kind: BridgeSourceKind, sourceAccountId: string, careAccountId: string, enabled: boolean): void {
    requireNonEmptyString(sourceAccountId, 'sourceAccountId', 256);
    requireAccountRow(this.db, careAccountId);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO care_capture_accounts (source_kind, source_account_id, care_account_id, enabled, enabled_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_kind, source_account_id) DO UPDATE SET
           care_account_id = care_capture_accounts.care_account_id,
           enabled = excluded.enabled,
           enabled_at = CASE WHEN excluded.enabled = 1 AND care_capture_accounts.enabled = 0 THEN excluded.enabled_at ELSE care_capture_accounts.enabled_at END,
           updated_at = excluded.updated_at`,
      )
      .run(kind, sourceAccountId, careAccountId, enabled ? 1 : 0, enabled ? now : null, now, now);
  }

  getRegistration(kind: BridgeSourceKind, sourceAccountId: string): CaptureRegistration | null {
    const r = this.db
      .prepare('SELECT * FROM care_capture_accounts WHERE source_kind = ? AND source_account_id = ?')
      .get(kind, sourceAccountId) as any;
    return r ? this.mapReg(r) : null;
  }

  listRegistrations(onlyEnabled = false): CaptureRegistration[] {
    const rows = this.db
      .prepare(`SELECT * FROM care_capture_accounts ${onlyEnabled ? 'WHERE enabled = 1' : ''} ORDER BY source_kind, source_account_id`)
      .all() as any[];
    return rows.map((r) => this.mapReg(r));
  }

  anyEnabled(): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM care_capture_accounts WHERE enabled = 1 LIMIT 1').get());
  }

  private mapReg(r: any): CaptureRegistration {
    return {
      sourceKind: r.source_kind,
      sourceAccountId: r.source_account_id,
      careAccountId: r.care_account_id,
      enabled: Boolean(r.enabled),
      enabledAtMs: r.enabled_at === null ? null : Number(r.enabled_at),
    };
  }

  // ── bridge state ──────────────────────────────────────────────────────────────────────────
  getState(careAccountId: string): BridgeState | null {
    const r = this.db.prepare('SELECT * FROM care_bridge_state WHERE care_account_id = ?').get(careAccountId) as any;
    return r ? this.mapState(r) : null;
  }

  initState(careAccountId: string, kind: BridgeSourceKind, sourceAccountId: string, watermarkS0: number): BridgeState {
    requireSafeInteger(watermarkS0, 'watermarkS0', 0);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO care_bridge_state (care_account_id, source_kind, source_account_id, status, watermark_s0, cursors_json, applied_seq, created_at, updated_at)
         VALUES (?, ?, ?, 'enabled', ?, '{}', ?, ?, ?)
         ON CONFLICT(care_account_id) DO NOTHING`,
      )
      .run(careAccountId, kind, sourceAccountId, watermarkS0, watermarkS0, now, now);
    return this.getState(careAccountId)!;
  }

  /** Cursor + status + applied position change together with the effects they describe. */
  saveProgress(
    careAccountId: string,
    patch: { status?: BridgeStatus; cursors?: Record<string, string>; appliedSeq?: number; backfillDone?: boolean },
  ): BridgeState {
    const run = this.db.transaction(() => {
      const cur = this.getState(careAccountId);
      if (!cur) throw new CareError('NOT_FOUND', `No bridge state for account ${careAccountId}`, 404);
      if (patch.appliedSeq !== undefined && patch.appliedSeq < cur.appliedSeq) {
        throw new CareError('STALE_REVISION', 'Bridge applied sequence can never move backwards', 409);
      }
      this.db
        .prepare(
          `UPDATE care_bridge_state SET
             status = ?, cursors_json = ?, applied_seq = ?,
             backfill_done_at = CASE WHEN ? = 1 AND backfill_done_at IS NULL THEN ? ELSE backfill_done_at END,
             updated_at = ?
           WHERE care_account_id = ?`,
        )
        .run(
          patch.status ?? cur.status,
          JSON.stringify(patch.cursors ?? cur.cursors),
          patch.appliedSeq ?? cur.appliedSeq,
          patch.backfillDone ? 1 : 0,
          Date.now(),
          Date.now(),
          careAccountId,
        );
      return this.getState(careAccountId)!;
    });
    return run();
  }

  private mapState(r: any): BridgeState {
    let cursors: Record<string, string> = {};
    try {
      cursors = JSON.parse(r.cursors_json);
    } catch {
      cursors = {};
    }
    return {
      careAccountId: r.care_account_id,
      sourceKind: r.source_kind,
      sourceAccountId: r.source_account_id,
      status: r.status,
      watermarkS0: Number(r.watermark_s0),
      cursors,
      appliedSeq: Number(r.applied_seq),
      backfillDoneAtMs: r.backfill_done_at === null ? null : Number(r.backfill_done_at),
    };
  }

  // ── artifacts (non-dispatching mirrors) ───────────────────────────────────────────────────
  upsertArtifact(a: {
    id: string;
    accountId: string;
    sourceKind: BridgeSourceKind;
    sourceTable: string;
    sourceId: string;
    state: string | null;
    sourceDeleted: boolean;
    sourceVersion: number;
    payload: Record<string, unknown>;
    /**
     * Snapshot semantics: the row is the source's CURRENT state, so it replaces whatever an earlier
     * capture generation journalled. The stored version never moves backwards (max of both), so a
     * later journal entry of the new generation (always a higher version) still applies in order.
     */
    overwrite?: boolean;
  }): void {
    requireAccountRow(this.db, a.accountId);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO care_bridge_artifacts
           (id, account_id, source_kind, source_table, source_id, state, source_deleted, source_version, payload_enc, dispatchable, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(source_kind, source_table, source_id) DO UPDATE SET
           state = excluded.state, source_deleted = excluded.source_deleted,
           source_version = ${a.overwrite ? 'MAX(excluded.source_version, care_bridge_artifacts.source_version)' : 'excluded.source_version'},
           payload_enc = excluded.payload_enc, updated_at = excluded.updated_at
         ${a.overwrite ? '' : 'WHERE excluded.source_version >= care_bridge_artifacts.source_version'}`,
      )
      .run(a.id, a.accountId, a.sourceKind, a.sourceTable, a.sourceId, a.state, a.sourceDeleted ? 1 : 0, a.sourceVersion, encryptCareJson(a.payload, this.key), now, now);
  }

  getArtifact(kind: BridgeSourceKind, table: string, sourceId: string): BridgeArtifact | null {
    const r = this.db
      .prepare('SELECT * FROM care_bridge_artifacts WHERE source_kind = ? AND source_table = ? AND source_id = ?')
      .get(kind, table, sourceId) as any;
    return r ? this.mapArtifact(r) : null;
  }

  listArtifacts(accountId: string, table?: string): BridgeArtifact[] {
    const rows = (
      table
        ? this.db.prepare('SELECT * FROM care_bridge_artifacts WHERE account_id = ? AND source_table = ? ORDER BY source_id').all(accountId, table)
        : this.db.prepare('SELECT * FROM care_bridge_artifacts WHERE account_id = ? ORDER BY source_table, source_id').all(accountId)
    ) as any[];
    return rows.map((r) => this.mapArtifact(r));
  }

  countArtifacts(accountId: string, table: string, opts: { includeDeleted?: boolean; state?: string } = {}): number {
    let sql = 'SELECT COUNT(*) AS n FROM care_bridge_artifacts WHERE account_id = ? AND source_table = ?';
    const params: unknown[] = [accountId, table];
    if (!opts.includeDeleted) sql += ' AND source_deleted = 0';
    if (opts.state !== undefined) {
      sql += ' AND state = ?';
      params.push(opts.state);
    }
    return Number((this.db.prepare(sql).get(...params) as { n: number }).n);
  }

  private mapArtifact(r: any): BridgeArtifact {
    return {
      id: r.id,
      accountId: r.account_id,
      sourceKind: r.source_kind,
      sourceTable: r.source_table,
      sourceId: r.source_id,
      state: r.state ?? null,
      sourceDeleted: Boolean(r.source_deleted),
      sourceVersion: Number(r.source_version),
      payload: decryptCareJson<Record<string, unknown>>(r.payload_enc, this.key),
      dispatchable: false,
    };
  }

  // ── journal retention pins ────────────────────────────────────────────────────────────────
  pin(careAccountId: string, consumer: string, minSeq: number): void {
    requireNonEmptyString(consumer, 'consumer', 64);
    requireSafeInteger(minSeq, 'minSeq', 0);
    this.db
      .prepare(
        `INSERT INTO care_journal_pins (care_account_id, consumer, min_seq, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(care_account_id, consumer) DO UPDATE SET min_seq = MIN(care_journal_pins.min_seq, excluded.min_seq)`,
      )
      .run(careAccountId, consumer, minSeq, Date.now());
  }

  /**
   * Raises (never lowers) an existing pin: the consumer says it has replayed everything below `minSeq` and no longer
   * needs it. `pin()` keeps the MIN on purpose (a second consumer can only widen protection); only the owner of the
   * pin moves it forward, as the replay position advances.
   */
  advancePin(careAccountId: string, consumer: string, minSeq: number): boolean {
    requireSafeInteger(minSeq, 'minSeq', 0);
    return (
      this.db
        .prepare('UPDATE care_journal_pins SET min_seq = ? WHERE care_account_id = ? AND consumer = ? AND min_seq < ?')
        .run(minSeq, careAccountId, consumer, minSeq).changes > 0
    );
  }

  unpin(careAccountId: string, consumer: string): void {
    this.db.prepare('DELETE FROM care_journal_pins WHERE care_account_id = ? AND consumer = ?').run(careAccountId, consumer);
  }

  listPins(careAccountId: string): Array<{ consumer: string; minSeq: number }> {
    return (this.db.prepare('SELECT consumer, min_seq FROM care_journal_pins WHERE care_account_id = ?').all(careAccountId) as any[]).map((r) => ({
      consumer: r.consumer,
      minSeq: Number(r.min_seq),
    }));
  }
}
