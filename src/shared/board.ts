import { camelRow, nowIso, type DB } from '../core/db.js';
import type { EventBus } from '../core/events.js';
import type { BoardEntry } from '../core/types.js';
import type { BoardService } from './contracts.js';

export function createBoardService(deps: { db: DB; bus: EventBus }): BoardService {
  const { db, bus } = deps;
  const get = (id: number) => camelRow<BoardEntry>(db.prepare('SELECT * FROM board WHERE id = ?').get(id) as Record<string, unknown>)!;
  return {
    add(entry) {
      const text = entry.text.trim();
      if (!text) throw new Error('Nội dung bảng hoạt động không được để trống.');
      const info = db
        .prepare('INSERT INTO board (agent_id, task_id, kind, text, created_at) VALUES (?,?,?,?,?)')
        .run(entry.agentId, entry.taskId ?? null, entry.kind ?? 'note', text, nowIso());
      const row = get(Number(info.lastInsertRowid));
      bus.emit({ type: 'board', entry: row });
      return row;
    },
    /** newest first */
    recent(limit = 10) {
      return (db.prepare('SELECT * FROM board ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map((r) => camelRow<BoardEntry>(r)!);
    },
  };
}
