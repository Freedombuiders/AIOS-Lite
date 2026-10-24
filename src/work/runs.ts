import { camelRow, nowIso, parseJson, type DB } from '../core/db.js';
import type { EventBus } from '../core/events.js';
import type { Run, RunEvent, StoredRunEvent } from '../core/types.js';
import type { RunService } from './contracts.js';

const toRun = (row: Record<string, unknown> | undefined): Run | undefined => camelRow<Run>(row);

export function createRunService({ db, bus }: { db: DB; bus: EventBus }): RunService {
  const get = (id: number): Run | undefined => toRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined);

  const service: RunService = {
    start(input) {
      const info = db
        .prepare(
          `INSERT INTO runs (task_id, agent_id, runtime, model, status, trigger, access_json, skills_json, started_at)
           VALUES (?,?,?,?, 'running', ?,?,?,?)`,
        )
        .run(input.taskId, input.agentId, input.runtime, input.model ?? null, input.trigger, input.accessJson ?? null, input.skillsJson ?? null, nowIso());
      const run = get(Number(info.lastInsertRowid))!;
      bus.emit({ type: 'run', run });
      return run;
    },

    addEvent(runId, taskId, event: RunEvent) {
      db.prepare('INSERT INTO run_events (run_id, ts, type, data) VALUES (?,?,?,?)').run(runId, nowIso(), event.type, JSON.stringify(event));
      bus.emit({ type: 'run-event', runId, taskId, event });
    },

    finish(runId, input) {
      const cur = get(runId);
      if (!cur) throw new Error(`Không tìm thấy lượt chạy #${runId}`);
      const now = nowIso();
      const u = input.usage ?? {};
      db.prepare(
        `UPDATE runs SET status = ?, output = ?, session_id = ?, error_family = ?, error = ?, input_tokens = ?, output_tokens = ?,
           cost_usd = ?, model = COALESCE(?, model), finished_at = ?, duration_ms = ? WHERE id = ?`,
      ).run(
        input.status,
        input.output ?? null,
        input.sessionId ?? null,
        input.errorFamily ?? null,
        input.error ?? null,
        u.inputTokens ?? null,
        u.outputTokens ?? null,
        u.costUsd ?? null,
        input.model ?? null,
        now,
        Math.max(0, Date.parse(now) - Date.parse(cur.startedAt)),
        runId,
      );
      const run = get(runId)!;
      bus.emit({ type: 'run', run });
      return run;
    },

    get,

    list(filter = {}) {
      const where: string[] = [];
      const args: unknown[] = [];
      if (filter.taskId !== undefined) (where.push('task_id = ?'), args.push(filter.taskId));
      if (filter.agentId) (where.push('agent_id = ?'), args.push(filter.agentId));
      if (filter.status) (where.push('status = ?'), args.push(filter.status));
      if (filter.since) (where.push('started_at >= ?'), args.push(filter.since));
      if (filter.beforeId) (where.push('id < ?'), args.push(filter.beforeId));
      const sql = `SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
      return (db.prepare(sql).all(...args, Math.min(filter.limit ?? 100, 500)) as Record<string, unknown>[]).map((r) => toRun(r)!);
    },

    events(runId, opts = {}) {
      const rows = db
        .prepare('SELECT id, run_id, ts, data FROM run_events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?')
        .all(runId, opts.afterId ?? 0, Math.min(opts.limit ?? 500, 5000)) as { id: number; run_id: number; ts: string; data: string }[];
      return rows.map((r): StoredRunEvent => ({ id: r.id, runId: r.run_id, ts: r.ts, event: parseJson<RunEvent>(r.data, { type: 'status', message: '' }) }));
    },

    monthCost(agentId) {
      const d = new Date();
      const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
      const row = db.prepare('SELECT SUM(cost_usd) AS s FROM runs WHERE agent_id = ? AND started_at >= ? AND cost_usd IS NOT NULL').get(agentId, start) as { s: number | null };
      return row.s ?? 0;
    },

    failOrphans(reason) {
      const now = nowIso();
      return db
        .prepare(
          `UPDATE runs SET status = 'failed', error = ?, error_family = 'unknown', finished_at = ?,
             duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER) WHERE status = 'running'`,
        )
        .run(reason, now, now).changes;
    },
  };
  return service;
}
