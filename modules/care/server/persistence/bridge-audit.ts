/**
 * Append-only audit of operator actions on the legacy bridge (enable, backfill, catch-up, verify, disable), written by
 * the dashboard control (`bridge/control.ts`). Same shape of promise as `care_cutover_log`: who, when, why, what came
 * out. IDs, enums and counts only; the reason is the operator's own short text and is never a message body.
 *
 * `ensureBridgeAuditSchema(db)` is called from createCareSchema inside its IMMEDIATE transaction, so it is additive
 * and idempotent (CREATE ... IF NOT EXISTS). No foreign key: the trail survives account removal.
 */
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BridgeSourceKind } from './bridge-store.js';

export type BridgeAuditAction = 'enable' | 'backfill' | 'cancel' | 'catchup' | 'verify' | 'disable';
export type BridgeAuditOutcome = 'accepted' | 'refused' | 'completed' | 'failed' | 'cancelled';

export interface BridgeAuditEntry {
  seq: number;
  id: string;
  action: BridgeAuditAction;
  sourceKind: BridgeSourceKind;
  sourceAccountId: string;
  careAccountId: string;
  actor: string;
  reason: string;
  outcome: BridgeAuditOutcome;
  /** Counts / enum codes only. */
  detail: Record<string, unknown>;
  createdAtMs: number;
}

export function ensureBridgeAuditSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS care_bridge_audit (
      seq               INTEGER PRIMARY KEY AUTOINCREMENT,
      id                TEXT NOT NULL UNIQUE,
      action            TEXT NOT NULL,
      source_kind       TEXT NOT NULL,
      source_account_id TEXT NOT NULL,
      care_account_id   TEXT NOT NULL,
      actor             TEXT NOT NULL,
      reason            TEXT NOT NULL,
      outcome           TEXT NOT NULL,
      detail_json       TEXT NOT NULL DEFAULT '{}',
      created_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_care_bridge_audit_account ON care_bridge_audit(care_account_id, seq);

    CREATE TRIGGER IF NOT EXISTS care_bridge_audit_no_update BEFORE UPDATE ON care_bridge_audit
    BEGIN SELECT RAISE(ABORT, 'care_bridge_audit is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS care_bridge_audit_no_delete BEFORE DELETE ON care_bridge_audit
    BEGIN SELECT RAISE(ABORT, 'care_bridge_audit is append-only'); END;
  `);
}

export class CareBridgeAuditStore {
  constructor(private readonly db: Database.Database) {}

  record(entry: Omit<BridgeAuditEntry, 'seq' | 'id' | 'createdAtMs'>, nowMs: number = Date.now()): string {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO care_bridge_audit (id, action, source_kind, source_account_id, care_account_id, actor, reason, outcome, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entry.action,
        entry.sourceKind,
        entry.sourceAccountId,
        entry.careAccountId,
        entry.actor.slice(0, 120),
        entry.reason.slice(0, 500),
        entry.outcome,
        JSON.stringify(entry.detail),
        nowMs,
      );
    return id;
  }

  list(careAccountId: string, limit = 50): BridgeAuditEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM care_bridge_audit WHERE care_account_id = ? ORDER BY seq DESC LIMIT ?')
      .all(careAccountId, Math.min(Math.max(Math.trunc(limit) || 1, 1), 200)) as Array<Record<string, any>>;
    return rows.map((r) => ({
      seq: Number(r.seq),
      id: r.id,
      action: r.action,
      sourceKind: r.source_kind,
      sourceAccountId: r.source_account_id,
      careAccountId: r.care_account_id,
      actor: r.actor,
      reason: r.reason,
      outcome: r.outcome,
      detail: safeJson(r.detail_json),
      createdAtMs: Number(r.created_at),
    }));
  }
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
