import { nowIso, parseJson, type DB } from '../core/db.js';
import type { EventBus } from '../core/events.js';
import { redactValue } from '../core/redact.js';
import type { AuditEntry } from '../core/types.js';
import type { AuditService } from './contracts.js';

interface Row {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  run_id: number | null;
  detail: string | null;
}

const toEntry = (r: Row): AuditEntry => ({
  id: r.id,
  ts: r.ts,
  actor: r.actor,
  action: r.action,
  target: r.target,
  runId: r.run_id,
  detail: r.detail ? parseJson<Record<string, unknown> | null>(r.detail, null) : null,
});

export function createAuditService(deps: { db: DB; bus: EventBus }): AuditService {
  const { db, bus } = deps;
  return {
    log(entry) {
      const detail = entry.detail ? JSON.stringify(redactValue(entry.detail)) : null;
      const info = db
        .prepare('INSERT INTO audit_log (ts, actor, action, target, run_id, detail) VALUES (?,?,?,?,?,?)')
        .run(nowIso(), entry.actor, entry.action, entry.target ?? null, entry.runId ?? null, detail);
      const e = toEntry(db.prepare('SELECT * FROM audit_log WHERE id = ?').get(info.lastInsertRowid) as Row);
      bus.emit({ type: 'audit', entry: e });
      return e;
    },
    list(filter = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.actor) (where.push('actor = ?'), params.push(filter.actor));
      if (filter.action) (where.push('action = ?'), params.push(filter.action));
      if (filter.since) (where.push('ts >= ?'), params.push(filter.since));
      if (filter.beforeId) (where.push('id < ?'), params.push(filter.beforeId));
      const sql = `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
      return (db.prepare(sql).all(...params, filter.limit ?? 100) as Row[]).map(toEntry);
    },
  };
}
