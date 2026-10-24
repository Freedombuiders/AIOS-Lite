import { camelRow, nowIso, type DB } from '../core/db.js';
import type { EventBus } from '../core/events.js';
import type { AttentionItem } from '../core/types.js';
import type { AgentRegistry } from '../agents/contracts.js';
import type { AttentionService, RunService, TaskService } from './contracts.js';

const FAILED_WINDOW_MS = 7 * 24 * 3600 * 1000;

interface Row {
  key: string;
  kind: string;
  title: string;
  detail: string | null;
  taskId: number | null;
  moduleId: string | null;
  link: string | null;
  severity: AttentionItem['severity'];
  createdAt: string;
  resolvedAt: string | null;
}

export const budgetKey = (agentId: string, now = new Date()): string => `budget:${agentId}:${now.toISOString().slice(0, 7)}`;

export function createAttentionService({ db, bus, tasks, runs, agents }: { db: DB; bus: EventBus; tasks: TaskService; runs: RunService; agents: AgentRegistry }): AttentionService {
  const rows = (): Row[] => (db.prepare('SELECT * FROM attention').all() as Record<string, unknown>[]).map((r) => camelRow<Row>(r)!);
  const toItem = (r: Row): AttentionItem => {
    const item: AttentionItem = { key: r.key, kind: r.kind as AttentionItem['kind'], title: r.title, severity: r.severity, createdAt: r.createdAt };
    if (r.detail) item.detail = r.detail;
    if (r.taskId != null) item.taskId = r.taskId;
    if (r.moduleId) item.moduleId = r.moduleId;
    if (r.link) item.link = r.link;
    return item;
  };

  const service: AttentionService = {
    list() {
      const all = rows();
      const raised = all.filter((r) => r.kind !== 'ack' && !r.resolvedAt);
      const acks = new Map(all.filter((r) => r.kind === 'ack').map((r) => [r.key, r]));
      const out = new Map<string, AttentionItem>();
      const raisedTaskIds = new Set(raised.filter((r) => r.taskId != null).map((r) => r.taskId));

      for (const t of tasks.list({ status: 'review', limit: 200 })) {
        const ack = acks.get(`task:${t.id}`);
        if (ack && ack.detail === t.updatedAt) continue;
        out.set(`task:${t.id}`, {
          key: `task:${t.id}`, kind: 'review', title: `Cần duyệt: ${t.title}`, taskId: t.id, link: `/tasks/${t.id}`, severity: 'info', createdAt: t.updatedAt,
        });
      }
      const cutoff = Date.now() - FAILED_WINDOW_MS;
      for (const t of tasks.list({ status: 'failed', limit: 200 })) {
        if (raisedTaskIds.has(t.id)) continue;
        if (Date.parse(t.finishedAt ?? t.updatedAt) < cutoff) continue;
        const ack = acks.get(`task:${t.id}`);
        if (ack && ack.detail === t.updatedAt) continue;
        out.set(`task:${t.id}`, {
          key: `task:${t.id}`, kind: 'failed', title: `Việc thất bại: ${t.title}`, ...(t.error ? { detail: t.error } : {}), taskId: t.id,
          link: `/tasks/${t.id}`, severity: 'error', createdAt: t.finishedAt ?? t.updatedAt,
        });
      }
      for (const a of agents.list()) {
        if (!a.budgetUsdMonth || a.budgetUsdMonth <= 0) continue;
        const spent = runs.monthCost(a.id);
        const key = budgetKey(a.id);
        if (spent < a.budgetUsdMonth || acks.has(key)) continue;
        out.set(key, {
          key, kind: 'budget', title: `${a.name} đã dùng hết ngân sách tháng`, detail: `Đã chi $${spent.toFixed(2)} / $${a.budgetUsdMonth}`,
          link: `/agents/${a.id}`, severity: 'warn', createdAt: nowIso(),
        });
      }
      for (const r of raised) out.set(r.key, toItem(r));
      return [...out.values()].sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1));
    },

    raise(item) {
      const createdAt = item.createdAt ?? nowIso();
      db.prepare(
        `INSERT INTO attention (key, kind, title, detail, task_id, module_id, link, severity, created_at, resolved_at)
         VALUES (?,?,?,?,?,?,?,?,?,NULL)
         ON CONFLICT(key) DO UPDATE SET kind=excluded.kind, title=excluded.title, detail=excluded.detail, task_id=excluded.task_id,
           module_id=excluded.module_id, link=excluded.link, severity=excluded.severity, created_at=excluded.created_at, resolved_at=NULL`,
      ).run(item.key, item.kind, item.title, item.detail ?? null, item.taskId ?? null, item.moduleId ?? null, item.link ?? null, item.severity, createdAt);
      const out: AttentionItem = { ...item, createdAt };
      bus.emit({ type: 'attention', item: out });
      return out;
    },

    resolve(key) {
      const now = nowIso();
      const row = (db.prepare('SELECT * FROM attention WHERE key = ?').get(key) as Record<string, unknown> | undefined);
      const cur = camelRow<Row>(row);
      if (cur && cur.kind !== 'ack') {
        db.prepare('UPDATE attention SET resolved_at = ? WHERE key = ?').run(now, key);
        bus.emit({ type: 'attention', item: toItem(cur), resolved: true });
        return;
      }
      // derived key: store an acknowledgement
      const m = /^task:(\d+)$/.exec(key);
      const task = m ? tasks.get(Number(m[1])) : undefined;
      db.prepare(
        `INSERT INTO attention (key, kind, title, detail, severity, created_at, resolved_at) VALUES (?, 'ack', 'ack', ?, 'info', ?, ?)
         ON CONFLICT(key) DO UPDATE SET detail=excluded.detail, resolved_at=excluded.resolved_at, kind='ack'`,
      ).run(key, task?.updatedAt ?? null, now, now);
      bus.emit({ type: 'attention', item: { key, kind: key.startsWith('budget:') ? 'budget' : 'review', title: '', severity: 'info', createdAt: now }, resolved: true });
    },
  };
  return service;
}
