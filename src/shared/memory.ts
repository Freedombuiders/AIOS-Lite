import { camelRow, nowIso, type DB } from '../core/db.js';
import type { EventBus } from '../core/events.js';
import type { Memory } from '../core/types.js';
import type { MemoryAddInput, MemoryService } from './contracts.js';
import { ftsQuery } from './text.js';

interface Row {
  id: number;
  agent_id: string | null;
  content: string;
  source: string;
  source_task_id: number | null;
  source_run_id: number | null;
  pinned: number;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
}

function toMemory(r: Row): Memory {
  const m = camelRow<Memory & { pinned: unknown }>(r as unknown as Record<string, unknown>)!;
  return { ...m, pinned: Boolean(r.pinned) };
}

export function createMemoryService(deps: { db: DB; bus: EventBus }): MemoryService {
  const { db, bus } = deps;
  const getRow = (id: number) => db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Row | undefined;

  const svc: MemoryService = {
    add(input: MemoryAddInput) {
      const content = input.content.trim();
      if (!content) throw new Error('Nội dung bộ nhớ không được để trống.');
      const info = db
        .prepare('INSERT INTO memories (agent_id, content, source, source_task_id, source_run_id, pinned, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(input.agentId, content, input.source ?? 'user', input.sourceTaskId ?? null, input.sourceRunId ?? null, input.pinned ? 1 : 0, nowIso());
      const m = svc.get(Number(info.lastInsertRowid))!;
      bus.emit({ type: 'memory', memory: m });
      return m;
    },

    get(id) {
      const r = getRow(id);
      return r ? toMemory(r) : undefined;
    },

    list(filter = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      const scope = filter.scope ?? 'all';
      if (scope === 'team' || filter.agentId === null) where.push('m.agent_id IS NULL');
      else if (filter.agentId) {
        if (scope === 'private') {
          where.push('m.agent_id = ?');
          params.push(filter.agentId);
        } else {
          where.push('(m.agent_id IS NULL OR m.agent_id = ?)');
          params.push(filter.agentId);
        }
      } else if (scope === 'private') where.push('m.agent_id IS NOT NULL');
      const limit = filter.limit ?? 100;
      let from = 'memories m';
      let order = 'm.pinned DESC, m.id DESC';
      const q = filter.q ? ftsQuery(filter.q, 'or') : null;
      if (q) {
        from = 'memories_fts JOIN memories m ON m.id = memories_fts.rowid';
        where.push('memories_fts MATCH ?');
        params.push(q);
        order = 'bm25(memories_fts)';
      }
      const sql = `SELECT m.* FROM ${from} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`;
      return (db.prepare(sql).all(...params, limit) as Row[]).map(toMemory);
    },

    update(id, patch) {
      const cur = getRow(id);
      if (!cur) throw new Error(`Không tìm thấy bộ nhớ #${id}.`);
      const content = patch.content !== undefined ? patch.content.trim() : cur.content;
      if (!content) throw new Error('Nội dung bộ nhớ không được để trống.');
      const pinned = patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : cur.pinned;
      db.prepare('UPDATE memories SET content = ?, pinned = ? WHERE id = ?').run(content, pinned, id);
      const m = svc.get(id)!;
      bus.emit({ type: 'memory', memory: m });
      return m;
    },

    remove(id) {
      const m = svc.get(id);
      if (!m) return;
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      bus.emit({ type: 'memory', memory: m, deleted: true });
    },

    recall(agentId, query, opts) {
      if (opts.limit <= 0 || (!opts.team && !opts.private)) return [];
      const picked: Row[] = [];
      const seen = new Set<number>();
      const take = (rows: Row[]): void => {
        for (const r of rows) {
          if (picked.length >= opts.limit) return;
          if (!seen.has(r.id)) {
            seen.add(r.id);
            picked.push(r);
          }
        }
      };
      const pinned = (scopeSql: string, ...p: unknown[]) =>
        db.prepare(`SELECT * FROM memories WHERE pinned = 1 AND ${scopeSql} ORDER BY id DESC LIMIT ?`).all(...p, opts.limit) as Row[];
      if (opts.team) take(pinned('agent_id IS NULL'));
      if (opts.private) take(pinned('agent_id = ?', agentId));

      const q = ftsQuery(query, 'or');
      if (q && picked.length < opts.limit) {
        const conds: string[] = [];
        const params: unknown[] = [q];
        if (opts.team) conds.push('m.agent_id IS NULL');
        if (opts.private) {
          conds.push('m.agent_id = ?');
          params.push(agentId);
        }
        try {
          take(
            db
              .prepare(
                `SELECT m.* FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
                  WHERE memories_fts MATCH ? AND (${conds.join(' OR ')}) ORDER BY bm25(memories_fts) LIMIT ?`,
              )
              .all(...params, opts.limit * 2) as Row[],
          );
        } catch {
          // malformed query: fall back to pinned only
        }
      }
      if (picked.length) {
        const ts = nowIso();
        const upd = db.prepare('UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?');
        db.transaction(() => picked.forEach((r) => upd.run(ts, r.id)))();
      }
      return picked.map((r) => toMemory(getRow(r.id)!));
    },
  };
  return svc;
}
