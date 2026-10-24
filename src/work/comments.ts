import { camelRow, nowIso, type DB } from '../core/db.js';
import type { EventBus } from '../core/events.js';
import type { TaskComment } from '../core/types.js';
import type { CommentService, TaskService } from './contracts.js';

const REQUEUE_FROM = new Set(['done', 'review', 'failed', 'cancelled']);

export function createCommentService({ db, bus, tasks }: { db: DB; bus: EventBus; tasks: TaskService }): CommentService {
  const list = (taskId: number): TaskComment[] =>
    (db.prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY id').all(taskId) as Record<string, unknown>[]).map((r) => camelRow<TaskComment>(r)!);

  return {
    add(taskId, author, body, opts = {}) {
      const task = tasks.require(taskId);
      if (!body.trim()) throw new Error('Bình luận không được để trống');
      const info = db
        .prepare('INSERT INTO task_comments (task_id, author, body, run_id, created_at) VALUES (?,?,?,?,?)')
        .run(taskId, author, body, opts.runId ?? null, nowIso());
      const comment = camelRow<TaskComment>(db.prepare('SELECT * FROM task_comments WHERE id = ?').get(info.lastInsertRowid) as Record<string, unknown>)!;
      if (author === 'user' && opts.requeue !== false && REQUEUE_FROM.has(task.status)) {
        tasks.update(taskId, { status: 'queued', trigger: 'commented', error: null, runAfter: null });
      } else {
        bus.emit({ type: 'task', task: tasks.require(taskId) });
      }
      return comment;
    },
    list,
    since(taskId, isoTime) {
      return list(taskId).filter((c) => !isoTime || c.createdAt > isoTime);
    },
  };
}
