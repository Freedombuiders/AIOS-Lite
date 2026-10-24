/**
 * Inbox v2 workflow VIEW: how a conversation row + its care-only state row + become a `CareConversationWorkflowDto`, and the tab classification of plan §3. Shared by the read model (list
 * rows, counts, single view) and the workflow service. Pure over the rows it is given; no writes. Imports types only from api/, so api/read-model.ts can depend on it.
 */

import type Database from 'better-sqlite3';
import type {
  CareAiStateDto,
  CareAssigneeDto,
  CareConversationWorkflowDto,
  CareInboxView,
  CareWorkflowStatus,
} from '../api/dto-inbox.js';

/** What the view needs from the outside world. */
export interface WorkflowEnv {
  now: () => number;
}

/** Columns every conversation SELECT that wants a workflow must carry (aliases `c`, `a`, `lm`, `cs` of CONV_FROM). */
export const WF_COLUMNS = `a.channel AS channel, c.account_id AS account_id, a.write_owner AS write_owner,
       c.waiting_since AS waiting_since,
       CASE WHEN lm.direction = 'in' AND lm.sender_role = 'customer' THEN 1 ELSE 0 END AS lm_inbound,
       cs.workflow AS cs_workflow, cs.snoozed_until AS cs_snoozed_until, cs.changed_at AS cs_changed_at,
       cs.assignee_kind AS cs_kind, cs.assignee_agent_id AS cs_agent, cs.ai_mode AS cs_ai_mode,
       cs.taken_over_at AS cs_taken_over_at, cs.state_revision AS cs_rev`;

export interface WfRawRow {
  id: string;
  channel: string;
  account_id: string;
  write_owner: string;
  last_message_at: number;
  waiting_since: number | null;
  lm_inbound: number;
  cs_workflow: 'auto' | 'snoozed' | 'done' | null;
  cs_snoozed_until: number | null;
  cs_changed_at: number | null;
  cs_kind: 'default' | 'owner' | 'agent' | 'none' | null;
  cs_agent: string | null;
  cs_ai_mode: 'off' | 'draft' | 'auto' | null;
  cs_taken_over_at: number | null;
  cs_rev: number | null;
}

/**
 * The customer wrote after a person closed/snoozed the conversation. `waiting_since` is the OLDEST unanswered customer
 * message, so a second customer message while one already waited does not move it: the newest message is checked too.
 */
const REOPENED_SQL = `COALESCE(c.waiting_since IS NOT NULL
  AND (c.waiting_since > COALESCE(cs.changed_at, 0)
       OR (lm.direction = 'in' AND lm.sender_role = 'customer' AND c.last_message_at > COALESCE(cs.changed_at, 0))), 0)`;

/** Effective status as a SQL expression over CONV_FROM (`c`, `lm`, `cs`). `now` is inlined as a checked integer. */
export function effectiveStatusSql(now: number): string {
  const n = Math.trunc(Number.isFinite(now) ? now : 0);
  return `(CASE
    WHEN cs.workflow = 'done' AND NOT ${REOPENED_SQL} THEN 'done'
    WHEN cs.workflow = 'snoozed' AND cs.snoozed_until > ${n} AND NOT ${REOPENED_SQL} THEN 'snoozed'
    WHEN c.waiting_since IS NOT NULL THEN 'open'
    ELSE 'pending' END)`;
}

/** The same rule in JS (kept in lockstep with the SQL; the tests compare both). */
export function effectiveStatus(row: WfRawRow, now: number): CareWorkflowStatus {
  const changed = row.cs_changed_at ?? 0;
  const reopened =
    row.waiting_since !== null &&
    (row.waiting_since > changed || (row.lm_inbound === 1 && Number(row.last_message_at) > changed));
  if (row.cs_workflow === 'done' && !reopened) return 'done';
  if (row.cs_workflow === 'snoozed' && row.cs_snoozed_until !== null && row.cs_snoozed_until > now && !reopened) return 'snoozed';
  return row.waiting_since !== null ? 'open' : 'pending';
}

function fromState(row: WfRawRow): { ai: CareAiStateDto; assignee: CareAssigneeDto } {
  const kind = row.cs_kind ?? 'default';
  const agentId = kind === 'agent' ? row.cs_agent : null;
  const assignee: CareAssigneeDto =
    kind === 'owner'
      ? { kind: 'owner', agentId: null, source: 'conversation' }
      : kind === 'agent' && agentId
        ? { kind: 'agent', agentId, source: 'conversation' }
        : { kind: 'none', agentId: null, source: kind === 'none' ? 'conversation' : 'none' };
  const ai: CareAiStateDto = {
    agentId,
    mode: row.cs_ai_mode ?? 'off',
    source: assignee.source,
    takenOver: kind === 'owner',
    // No AI runtime is wired to the inbox state itself yet.
    supported: false,
    note: 'CORE_AI_UNAVAILABLE',
  };
  return { ai, assignee };
}

const CHUNK = 400;

/** Core delivery intents (AI drafts / manual review) waiting per conversation. */
function coreDraftCounts(db: Database.Database, ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const rows = db
      .prepare(
        `SELECT conversation_id AS id, COUNT(*) AS n FROM care_delivery_intents
         WHERE status IN ('draft','needs_review') AND conversation_id IN (${part.map(() => '?').join(',')})
         GROUP BY conversation_id`,
      )
      .all(...part) as Array<{ id: string; n: number }>;
    for (const r of rows) out.set(r.id, Number(r.n));
  }
  return out;
}

/** Workflow DTOs for a batch of rows: one draft-count query for the whole batch. */
export function buildWorkflows(db: Database.Database, env: WorkflowEnv, rows: readonly WfRawRow[]): Map<string, CareConversationWorkflowDto> {
  const now = env.now();
  const out = new Map<string, CareConversationWorkflowDto>();
  if (rows.length === 0) return out;

  const coreDrafts = coreDraftCounts(db, rows.map((r) => r.id));

  for (const r of rows) {
    const status = effectiveStatus(r, now);
    const { ai, assignee } = fromState(r);
    out.set(r.id, {
      status,
      snoozedUntilMs: status === 'snoozed' ? r.cs_snoozed_until : null,
      changedAtMs: r.cs_changed_at ?? null,
      stateRevision: Number(r.cs_rev ?? 0),
      assignee,
      ai,
      pendingDrafts: coreDrafts.get(r.id) ?? 0,
    });
  }
  return out;
}

/** Plan §3 tab classification. `all` always holds and is not listed. */
export function viewMembership(wf: CareConversationWorkflowDto): Record<Exclude<CareInboxView, 'all'>, boolean> {
  const aiActive = Boolean(wf.ai.agentId) && wf.ai.mode !== 'off' && !wf.ai.takenOver && wf.ai.supported;
  return {
    me: wf.pendingDrafts > 0 || (wf.status === 'open' && !aiActive),
    ai: aiActive,
    none: wf.assignee.kind === 'none' || (!aiActive && wf.assignee.kind !== 'owner'),
  };
}

export function inView(wf: CareConversationWorkflowDto, view: CareInboxView | undefined): boolean {
  if (!view || view === 'all') return true;
  return viewMembership(wf)[view];
}
