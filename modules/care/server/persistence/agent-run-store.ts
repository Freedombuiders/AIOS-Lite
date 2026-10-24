/**
 * CC-10 agent Care runs: one row per (conversation, trigger message, context revision).
 *
 * A run records WHY an agent turn did or did not produce a draft (skip/failure reason codes),
 * the sanitized decision (encrypted), the draft reference handed to the CC-11 draft sink, and a
 * cost placeholder. It never stores raw model output or customer text outside `decision_enc`.
 *
 *  - `ensureAgentRunSchema(db)` is called from createCareSchema inside its IMMEDIATE transaction on every boot, so
 *    it is additive and idempotent (CREATE ... IF NOT EXISTS only).
 *  - `CareAgentRunStore` is exposed as a field of CareStores (see index.ts).
 *
 * Idempotency: `beginRun` is the only way to start a run. A second begin for the same
 * (conversation, trigger, context revision) never inserts a second row: it returns the existing
 * one, flagged terminal / in progress, or takes over a `running` row whose lease went stale.
 * The trigger kind (inbound | manual) is part of the key on purpose: an automatic run that was
 * skipped (observe mode, quiet hours...) must not block an operator's explicit "draft now" for
 * the same message, while a redelivered job or a double click stays a no-op.
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { CareError } from '../../../_lib/care-kit/errors.js';
import { requireNonEmptyString, requireSafeInteger } from '../../../_lib/care-kit/validation.js';
import { decryptCareJson, encryptCareJson, type CareKeyInput } from './crypto.js';
import { requireAccountRow, requireConversationOfAccount } from './shared.js';

export const AGENT_RUN_STATUSES = ['running', 'skipped', 'failed', 'drafted'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];
export type AgentRunTriggerKind = 'inbound' | 'manual';
export type AgentRunCostSource = 'placeholder' | 'provider';

export interface CareAgentRunRecord {
  id: string;
  accountId: string;
  conversationId: string;
  triggerMessageId: string;
  contextRevision: number;
  policyRevision: string;
  assignmentId: string | null;
  agentId: string;
  mode: 'observe' | 'draft' | 'auto' | null;
  triggerKind: AgentRunTriggerKind;
  status: AgentRunStatus;
  /** Stable machine reason: why skipped, or the failure class when status is 'failed'. */
  skipReason: string | null;
  /** Sanitized decision / error detail. Decrypted on read; never raw model output. */
  decision: Record<string, unknown> | null;
  draftRef: string | null;
  modelCalled: boolean;
  latencyMs: number | null;
  costUsd: number;
  costSource: AgentRunCostSource;
  attempts: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export type BeginRunOutcome = 'created' | 'taken_over' | 'in_progress' | 'terminal';

export interface BeginRunInput {
  accountId: string;
  conversationId: string;
  triggerMessageId: string;
  contextRevision: number;
  policyRevision: string;
  assignmentId?: string | null;
  agentId?: string;
  mode?: 'observe' | 'draft' | 'auto' | null;
  triggerKind?: AgentRunTriggerKind;
}

export interface CompleteRunPatch {
  status: Exclude<AgentRunStatus, 'running'>;
  skipReason?: string | null;
  decision?: Record<string, unknown> | null;
  draftRef?: string | null;
  modelCalled?: boolean;
  latencyMs?: number | null;
  costUsd?: number;
  costSource?: AgentRunCostSource;
  /** Updates the recorded policy/agent facts once the effective rule is known. */
  policyRevision?: string;
  assignmentId?: string | null;
  agentId?: string;
  mode?: 'observe' | 'draft' | 'auto' | null;
}

export interface ListRunsFilter {
  accountId?: string;
  conversationId?: string;
  status?: AgentRunStatus;
  limit?: number;
  /** Return runs created strictly before this timestamp (keyset by created_at, id). */
  beforeMs?: number;
}

/** A `running` row not touched for this long is considered abandoned (worker crash). */
export const DEFAULT_RUN_LEASE_MS = 5 * 60_000;

export function ensureAgentRunSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS care_agent_runs (
      id                  TEXT PRIMARY KEY,
      account_id          TEXT NOT NULL REFERENCES care_accounts(id) ON DELETE CASCADE,
      conversation_id     TEXT NOT NULL REFERENCES care_conversations(id) ON DELETE CASCADE,
      trigger_message_id  TEXT NOT NULL REFERENCES care_messages(id) ON DELETE CASCADE,
      context_revision    INTEGER NOT NULL,
      policy_revision     TEXT NOT NULL,
      assignment_id       TEXT,
      agent_id            TEXT NOT NULL DEFAULT '',
      mode                TEXT CHECK (mode IS NULL OR mode IN ('observe','draft','auto')),
      trigger_kind        TEXT NOT NULL DEFAULT 'inbound' CHECK (trigger_kind IN ('inbound','manual')),
      status              TEXT NOT NULL CHECK (status IN ('running','skipped','failed','drafted')),
      skip_reason         TEXT,
      decision_enc        TEXT,
      draft_ref           TEXT,
      model_called        INTEGER NOT NULL DEFAULT 0 CHECK (model_called IN (0,1)),
      latency_ms          INTEGER,
      cost_usd            REAL NOT NULL DEFAULT 0,
      cost_source         TEXT NOT NULL DEFAULT 'placeholder' CHECK (cost_source IN ('placeholder','provider')),
      attempts            INTEGER NOT NULL DEFAULT 1,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      UNIQUE(conversation_id, trigger_message_id, context_revision, trigger_kind)
    );

    CREATE INDEX IF NOT EXISTS idx_care_agent_runs_conversation
      ON care_agent_runs(conversation_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_care_agent_runs_agent_day
      ON care_agent_runs(agent_id, created_at) WHERE model_called = 1;
    CREATE INDEX IF NOT EXISTS idx_care_agent_runs_account
      ON care_agent_runs(account_id, status, created_at DESC);
  `);
}

export class CareAgentRunStore {
  constructor(
    protected readonly db: Database.Database,
    protected readonly key?: CareKeyInput,
  ) {}

  /**
   * Idempotent start. Returns the existing row for the same (conversation, trigger, revision)
   * instead of inserting: `terminal` when a result was already recorded, `in_progress` while
   * another worker holds a fresh `running` row, `taken_over` when that row's lease went stale.
   */
  beginRun(
    input: BeginRunInput,
    opts: { nowMs?: number; leaseMs?: number } = {},
  ): { run: CareAgentRunRecord; outcome: BeginRunOutcome } {
    const tx = this.db.transaction(() => {
      requireAccountRow(this.db, input.accountId);
      requireConversationOfAccount(this.db, input.conversationId, input.accountId);
      requireNonEmptyString(input.triggerMessageId, 'triggerMessageId', 128);
      requireNonEmptyString(input.policyRevision, 'policyRevision', 256);
      const revision = requireSafeInteger(input.contextRevision, 'contextRevision', 0);
      const msg = this.db
        .prepare('SELECT conversation_id FROM care_messages WHERE id = ?')
        .get(input.triggerMessageId) as { conversation_id: string } | undefined;
      if (!msg) throw new CareError('INVALID_TARGET', `Trigger message not found: ${input.triggerMessageId}`, 404);
      if (msg.conversation_id !== input.conversationId) {
        throw new CareError('INVALID_TARGET', 'Trigger message belongs to a different conversation', 400);
      }

      const now = opts.nowMs ?? Date.now();
      const lease = opts.leaseMs ?? DEFAULT_RUN_LEASE_MS;
      const triggerKind = input.triggerKind ?? 'inbound';
      if (triggerKind !== 'inbound' && triggerKind !== 'manual') {
        throw new CareError('INVALID_COMMAND', `Invalid triggerKind: ${String(triggerKind)}`, 400);
      }
      const existing = this.db
        .prepare(
          `SELECT * FROM care_agent_runs
           WHERE conversation_id = ? AND trigger_message_id = ? AND context_revision = ? AND trigger_kind = ?`,
        )
        .get(input.conversationId, input.triggerMessageId, revision, triggerKind) as any;
      if (existing) {
        if (existing.status !== 'running') return { run: this.mapRow(existing), outcome: 'terminal' as const };
        if (now - Number(existing.updated_at) < lease) return { run: this.mapRow(existing), outcome: 'in_progress' as const };
        // Compare-and-set on updated_at so two takeovers cannot both win.
        const won = this.db
          .prepare(
            `UPDATE care_agent_runs SET attempts = attempts + 1, updated_at = ?, policy_revision = ?
             WHERE id = ? AND status = 'running' AND updated_at = ?`,
          )
          .run(now, input.policyRevision, existing.id, existing.updated_at);
        const row = this.db.prepare('SELECT * FROM care_agent_runs WHERE id = ?').get(existing.id) as any;
        return { run: this.mapRow(row), outcome: won.changes === 1 ? ('taken_over' as const) : ('in_progress' as const) };
      }

      const id = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO care_agent_runs (
             id, account_id, conversation_id, trigger_message_id, context_revision, policy_revision,
             assignment_id, agent_id, mode, trigger_kind, status, attempts, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 1, ?, ?)`,
        )
        .run(
          id,
          input.accountId,
          input.conversationId,
          input.triggerMessageId,
          revision,
          input.policyRevision,
          input.assignmentId ?? null,
          input.agentId ?? '',
          input.mode ?? null,
          triggerKind,
          now,
          now,
        );
      return { run: this.getRun(id)!, outcome: 'created' as const };
    });
    return tx();
  }

  /**
   * Records the result of a `running` run. Compare-and-set on status: a run already finished
   * (or taken over by someone else finishing first) is never overwritten; returns null then.
   */
  completeRun(id: string, patch: CompleteRunPatch, nowMs?: number): CareAgentRunRecord | null {
    if (patch.status === 'drafted' && !patch.draftRef) {
      throw new CareError('INVALID_COMMAND', 'A drafted run requires a draftRef', 400);
    }
    const now = nowMs ?? Date.now();
    const latency = patch.latencyMs === undefined || patch.latencyMs === null ? null : requireSafeInteger(patch.latencyMs, 'latencyMs', 0);
    const cost = patch.costUsd ?? 0;
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
      throw new CareError('INVALID_COMMAND', 'costUsd must be a non-negative number', 400);
    }
    const res = this.db
      .prepare(
        `UPDATE care_agent_runs SET
           status = ?, skip_reason = ?, decision_enc = ?, draft_ref = ?, model_called = ?,
           latency_ms = ?, cost_usd = ?, cost_source = ?,
           policy_revision = COALESCE(?, policy_revision),
           assignment_id = CASE WHEN ? = 1 THEN ? ELSE assignment_id END,
           agent_id = COALESCE(?, agent_id),
           mode = CASE WHEN ? = 1 THEN ? ELSE mode END,
           updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(
        patch.status,
        patch.skipReason ?? null,
        patch.decision ? encryptCareJson(patch.decision, this.key) : null,
        patch.draftRef ?? null,
        patch.modelCalled ? 1 : 0,
        latency,
        cost,
        patch.costSource ?? 'placeholder',
        patch.policyRevision ?? null,
        patch.assignmentId === undefined ? 0 : 1,
        patch.assignmentId ?? null,
        patch.agentId ?? null,
        patch.mode === undefined ? 0 : 1,
        patch.mode ?? null,
        now,
        id,
      );
    return res.changes === 1 ? this.getRun(id) : null;
  }

  getRun(id: string): CareAgentRunRecord | null {
    const row = this.db.prepare('SELECT * FROM care_agent_runs WHERE id = ?').get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  getRunByKey(
    conversationId: string,
    triggerMessageId: string,
    contextRevision: number,
    triggerKind: AgentRunTriggerKind = 'inbound',
  ): CareAgentRunRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM care_agent_runs
         WHERE conversation_id = ? AND trigger_message_id = ? AND context_revision = ? AND trigger_kind = ?`,
      )
      .get(conversationId, triggerMessageId, contextRevision, triggerKind) as any;
    return row ? this.mapRow(row) : null;
  }

  listRuns(filter: ListRunsFilter = {}): CareAgentRunRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.accountId) {
      clauses.push('account_id = ?');
      params.push(filter.accountId);
    }
    if (filter.conversationId) {
      clauses.push('conversation_id = ?');
      params.push(filter.conversationId);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.beforeMs !== undefined) {
      clauses.push('created_at < ?');
      params.push(requireSafeInteger(filter.beforeMs, 'beforeMs', 0));
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM care_agent_runs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params, limit) as any[];
    return rows.map((r) => this.mapRow(r));
  }

  /** Replies the agent drafted in this conversation since `sinceMs` (per-thread daily quota). */
  countDraftedSince(conversationId: string, sinceMs: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM care_agent_runs WHERE conversation_id = ? AND status = 'drafted' AND created_at >= ?`)
      .get(conversationId, sinceMs) as { n: number };
    return Number(row.n);
  }

  /** Runs that actually reached the model for this agent since `sinceMs` (per-agent daily cap). */
  countModelRunsSince(agentId: string, sinceMs: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM care_agent_runs WHERE agent_id = ? AND model_called = 1 AND created_at >= ?`)
      .get(agentId, sinceMs) as { n: number };
    return Number(row.n);
  }

  private mapRow(row: any): CareAgentRunRecord {
    return {
      id: row.id,
      accountId: row.account_id,
      conversationId: row.conversation_id,
      triggerMessageId: row.trigger_message_id,
      contextRevision: Number(row.context_revision),
      policyRevision: row.policy_revision,
      assignmentId: row.assignment_id ?? null,
      agentId: row.agent_id ?? '',
      mode: row.mode ?? null,
      triggerKind: row.trigger_kind,
      status: row.status,
      skipReason: row.skip_reason ?? null,
      decision: row.decision_enc ? decryptCareJson<Record<string, unknown>>(row.decision_enc, this.key) : null,
      draftRef: row.draft_ref ?? null,
      modelCalled: Boolean(row.model_called),
      latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
      costUsd: Number(row.cost_usd),
      costSource: row.cost_source,
      attempts: Number(row.attempts),
      createdAtMs: Number(row.created_at),
      updatedAtMs: Number(row.updated_at),
    };
  }
}
