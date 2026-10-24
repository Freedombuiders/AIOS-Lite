// SQL for the integration tables (migration 002). All access to those tables goes through here.
import crypto from 'node:crypto';
import { nowIso, type DB } from '../core/db.js';

export interface CredentialRow {
  integrationId: string;
  valuesEnc: string;
  status: string;
  statusDetail: string;
  accountLabel: string;
  checkedAt: number | null;
  updatedAt: number;
}

export interface ApprovalRow {
  id: string;
  integrationId: string;
  agentId: string;
  taskId: number | null;
  command: string;
  argsJson: string;
  argsHash: string;
  risk: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'failed';
  resultJson: string | null;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
}

const sec = () => Math.floor(Date.now() / 1000);

type Raw = Record<string, unknown>;
const credRow = (r: Raw): CredentialRow => ({
  integrationId: r.integration_id as string,
  valuesEnc: r.values_enc as string,
  status: r.status as string,
  statusDetail: r.status_detail as string,
  accountLabel: r.account_label as string,
  checkedAt: (r.checked_at as number | null) ?? null,
  updatedAt: r.updated_at as number,
});
const apprRow = (r: Raw): ApprovalRow => ({
  id: r.id as string,
  integrationId: r.integration_id as string,
  agentId: r.agent_id as string,
  taskId: (r.task_id as number | null) ?? null,
  command: r.command as string,
  argsJson: r.args_json as string,
  argsHash: r.args_hash as string,
  risk: r.risk as string,
  status: r.status as ApprovalRow['status'],
  resultJson: (r.result_json as string | null) ?? null,
  error: (r.error as string | null) ?? null,
  createdAt: r.created_at as string,
  decidedAt: (r.decided_at as string | null) ?? null,
});

export function createIntegrationDb(db: DB) {
  return {
    getCredentials(id: string): CredentialRow | undefined {
      const r = db.prepare('SELECT * FROM integration_credentials WHERE integration_id = ?').get(id) as Raw | undefined;
      return r && credRow(r);
    },
    listCredentials(): CredentialRow[] {
      return (db.prepare('SELECT * FROM integration_credentials').all() as Raw[]).map(credRow);
    },
    upsertCredentials(id: string, valuesEnc: string, status: string, detail: string, accountLabel: string): void {
      db.prepare(
        `INSERT INTO integration_credentials (integration_id, values_enc, status, status_detail, account_label, checked_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(integration_id) DO UPDATE SET values_enc = excluded.values_enc, status = excluded.status,
           status_detail = excluded.status_detail, account_label = excluded.account_label, checked_at = excluded.checked_at, updated_at = excluded.updated_at`,
      ).run(id, valuesEnc, status, detail, accountLabel, sec(), sec());
    },
    setStatus(id: string, status: string, detail: string, accountLabel: string): void {
      db.prepare('UPDATE integration_credentials SET status = ?, status_detail = ?, account_label = ?, checked_at = ? WHERE integration_id = ?')
        .run(status, detail, accountLabel, sec(), id);
    },
    deleteCredentials(id: string): void {
      db.prepare('DELETE FROM integration_credentials WHERE integration_id = ?').run(id);
    },

    insertCall(c: { integrationId: string; agentId: string; taskId?: number | null; command: string; access: string; ok: boolean; error: string; durationMs: number }): void {
      db.prepare(
        'INSERT INTO integration_calls (integration_id, agent_id, task_id, command, access, ok, error, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      ).run(c.integrationId, c.agentId, c.taskId ?? null, c.command, c.access, c.ok ? 1 : 0, c.error, c.durationMs, sec());
    },
    countCallsSince(integrationId: string, sinceSec: number): number {
      return (db.prepare('SELECT COUNT(*) AS n FROM integration_calls WHERE integration_id = ? AND created_at >= ?').get(integrationId, sinceSec) as { n: number }).n;
    },

    findPendingApproval(agentId: string, integrationId: string, command: string, argsHash: string): ApprovalRow | undefined {
      const r = db.prepare(
        `SELECT * FROM integration_approvals WHERE status = 'pending' AND agent_id = ? AND integration_id = ? AND command = ? AND args_hash = ?`,
      ).get(agentId, integrationId, command, argsHash) as Raw | undefined;
      return r && apprRow(r);
    },
    insertApproval(a: { agentId: string; integrationId: string; taskId: number | null; command: string; argsJson: string; argsHash: string; risk: string }): ApprovalRow {
      const id = `apr_${crypto.randomBytes(6).toString('hex')}`;
      db.prepare(
        'INSERT INTO integration_approvals (id, integration_id, agent_id, task_id, command, args_json, args_hash, risk, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      ).run(id, a.integrationId, a.agentId, a.taskId, a.command, a.argsJson, a.argsHash, a.risk, nowIso());
      return this.getApproval(id)!;
    },
    getApproval(id: string): ApprovalRow | undefined {
      const r = db.prepare('SELECT * FROM integration_approvals WHERE id = ?').get(id) as Raw | undefined;
      return r && apprRow(r);
    },
    listApprovals(status?: string, limit = 200): ApprovalRow[] {
      const rows = status
        ? db.prepare('SELECT * FROM integration_approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
        : db.prepare('SELECT * FROM integration_approvals ORDER BY created_at DESC LIMIT ?').all(limit);
      return (rows as Raw[]).map(apprRow);
    },
    /** Claims a pending approval so two clicks cannot run it twice. */
    claimApproval(id: string): boolean {
      return db.prepare(`UPDATE integration_approvals SET status = 'approved', decided_at = ? WHERE id = ? AND status = 'pending'`).run(nowIso(), id).changes === 1;
    },
    finishApproval(id: string, status: ApprovalRow['status'], resultJson: string | null, error: string | null): void {
      db.prepare('UPDATE integration_approvals SET status = ?, result_json = ?, error = ?, decided_at = ? WHERE id = ?').run(status, resultJson, error, nowIso(), id);
    },
    rejectApproval(id: string): boolean {
      return db.prepare(`UPDATE integration_approvals SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'`).run(nowIso(), id).changes === 1;
    },

    hasTrustRule(agentId: string, integrationId: string, command: string, argsHash: string): boolean {
      return !!db.prepare('SELECT 1 FROM integration_trust_rules WHERE agent_id = ? AND integration_id = ? AND command = ? AND args_hash = ?')
        .get(agentId, integrationId, command, argsHash);
    },
    addTrustRule(agentId: string, integrationId: string, command: string, argsHash: string): void {
      db.prepare('INSERT OR IGNORE INTO integration_trust_rules (agent_id, integration_id, command, args_hash) VALUES (?,?,?,?)').run(agentId, integrationId, command, argsHash);
    },
  };
}

export type IntegrationDb = ReturnType<typeof createIntegrationDb>;
