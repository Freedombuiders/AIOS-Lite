import { camelRow, nowIso, parseJson, type DB } from '../core/db.js';
import type { EventBus } from '../core/events.js';
import { TERMINAL_STATUSES, type Task, type TaskStatus } from '../core/types.js';
import type { AgentRegistry } from '../agents/contracts.js';
import type { CreateTaskInput, TaskFilter, TaskService } from './contracts.js';

const ALL_STATUSES: TaskStatus[] = ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled'];

export function rowToTask(row: Record<string, unknown> | undefined): Task | undefined {
  const t = camelRow<Record<string, unknown>>(row);
  if (!t) return undefined;
  t.meta = parseJson<Record<string, unknown>>(t.meta as string, {});
  return t as unknown as Task;
}

export const isTerminal = (s: TaskStatus): boolean => TERMINAL_STATUSES.includes(s);

const snake = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function defaultTitle(prompt: string): string {
  const first = prompt.trim().split(/\r?\n/)[0] ?? '';
  return first.length > 80 ? first.slice(0, 79) + '…' : first || 'Việc mới';
}

export interface TaskServiceDeps {
  db: DB;
  bus: EventBus;
  agents: AgentRegistry;
  abort?: (id: number) => boolean;
}

export function createTaskService({ db, bus, agents, abort }: TaskServiceDeps): TaskService {
  const emit = (task: Task): Task => {
    bus.emit({ type: 'task', task });
    return task;
  };

  const get = (id: number): Task | undefined => rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined);

  const require_ = (id: number): Task => {
    const t = get(id);
    if (!t) throw new Error(`Không tìm thấy việc #${id}`);
    return t;
  };

  function update(id: number, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): Task {
    const cur = require_(id);
    const now = nowIso();
    const p: Record<string, unknown> = { ...patch };
    if (p.status && !('finishedAt' in p)) {
      const s = p.status as TaskStatus;
      if (isTerminal(s)) p.finishedAt = cur.finishedAt && isTerminal(cur.status) ? cur.finishedAt : now;
      else p.finishedAt = null;
    }
    p.updatedAt = now;
    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined || k === 'id' || k === 'createdAt') continue;
      cols.push(`${snake(k)} = ?`);
      vals.push(k === 'meta' ? JSON.stringify(v ?? {}) : v);
    }
    db.prepare(`UPDATE tasks SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
    return emit(require_(id));
  }

  function create(input: CreateTaskInput): Task {
    const agentId = input.agentId ?? 'main';
    const agent = agents.get(agentId);
    if (!agent) throw new Error(`Không tìm thấy agent "${agentId}"`);
    if (!input.prompt?.trim()) throw new Error('Nội dung việc không được để trống');
    const parent = input.parentId ? get(input.parentId) : undefined;
    if (input.parentId && !parent) throw new Error(`Không tìm thấy việc cha #${input.parentId}`);
    const kind = input.kind ?? 'task';
    const status = input.status ?? (kind === 'team' ? 'waiting' : 'queued');
    const now = nowIso();
    const info = db
      .prepare(
        `INSERT INTO tasks (title, prompt, agent_id, status, kind, priority, parent_id, conversation_id, source, trigger,
           context_profile, depth, run_after, meta, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        (input.title?.trim() || defaultTitle(input.prompt)).slice(0, 200),
        input.prompt,
        agentId,
        status,
        kind,
        input.priority ?? 0,
        input.parentId ?? null,
        input.conversationId ?? null,
        input.source ?? 'user',
        input.trigger ?? 'assigned',
        input.contextProfile ?? agent.context,
        parent ? parent.depth + 1 : 0,
        input.runAfter ?? null,
        JSON.stringify(input.meta ?? {}),
        now,
        now,
      );
    return emit(require_(Number(info.lastInsertRowid)));
  }

  function list(filter: TaskFilter = {}): Task[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.status) {
      const s = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${s.map(() => '?').join(',')})`);
      args.push(...s);
    }
    if (filter.agentId) (where.push('agent_id = ?'), args.push(filter.agentId));
    if (filter.parentId === null) where.push('parent_id IS NULL');
    else if (filter.parentId !== undefined) (where.push('parent_id = ?'), args.push(filter.parentId));
    if (filter.conversationId !== undefined) (where.push('conversation_id = ?'), args.push(filter.conversationId));
    if (filter.source) {
      if (filter.source.endsWith('*')) (where.push('source LIKE ?'), args.push(filter.source.slice(0, -1).replace(/[%_]/g, '\\$&') + '%'));
      else (where.push('source = ?'), args.push(filter.source));
    }
    if (filter.kind) (where.push('kind = ?'), args.push(filter.kind));
    if (filter.q) {
      where.push("(title LIKE ? ESCAPE '\\' OR prompt LIKE ? ESCAPE '\\')");
      const like = `%${filter.q.replace(/[%_\\]/g, '\\$&')}%`;
      args.push(like, like);
    }
    if (filter.beforeId) (where.push('id < ?'), args.push(filter.beforeId));
    const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    return (db.prepare(sql).all(...args, Math.min(filter.limit ?? 100, 500)) as Record<string, unknown>[]).map((r) => rowToTask(r)!);
  }

  const children = (id: number): Task[] =>
    (db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY id').all(id) as Record<string, unknown>[]).map((r) => rowToTask(r)!);

  function cancel(id: number): Task {
    const t = require_(id);
    if (isTerminal(t.status)) return t;
    const out = update(id, { status: 'cancelled', error: null });
    for (const c of children(id)) if (!isTerminal(c.status)) cancel(c.id);
    abort?.(id);
    return out;
  }

  function retry(id: number): Task {
    const t = require_(id);
    if (!isTerminal(t.status)) throw new Error(`Việc #${id} chưa kết thúc nên không thể chạy lại`);
    return update(id, { status: 'queued', trigger: 'retry', error: null, runAfter: null, recoverCount: 0 });
  }

  function approve(id: number): Task {
    const t = require_(id);
    if (t.status !== 'review') throw new Error(`Việc #${id} không ở trạng thái chờ duyệt`);
    return update(id, { status: 'done' });
  }

  function waitFor(id: number, opts: { timeoutMs?: number; signal?: AbortSignal; until?: TaskStatus[] } = {}): Promise<Task> {
    const stop = opts.until ?? [...TERMINAL_STATUSES, 'review' as TaskStatus];
    return new Promise<Task>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let poll: NodeJS.Timeout | undefined;
      let off: () => void = () => {};
      const cleanup = () => {
        off();
        if (timer) clearTimeout(timer);
        if (poll) clearInterval(poll);
        opts.signal?.removeEventListener('abort', onAbort);
      };
      const finish = (fn: () => void) => {
        cleanup();
        fn();
      };
      const check = () => {
        const t = get(id);
        if (!t) return finish(() => reject(new Error(`Không tìm thấy việc #${id}`)));
        if (stop.includes(t.status)) finish(() => resolve(t));
      };
      const onAbort = () => finish(() => reject(new Error('Đã huỷ việc chờ')));
      if (opts.signal?.aborted) return reject(new Error('Đã huỷ việc chờ'));
      opts.signal?.addEventListener('abort', onAbort);
      off = bus.on('task', (e) => {
        if (e.task.id === id) check();
      });
      poll = setInterval(check, 1000);
      if (opts.timeoutMs) timer = setTimeout(() => finish(() => reject(new Error(`Hết thời gian chờ việc #${id}`))), opts.timeoutMs);
      check();
    });
  }

  function counts(): Record<TaskStatus, number> {
    const out = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all() as { status: TaskStatus; n: number }[]) out[r.status] = r.n;
    return out;
  }

  return { create, get, require: require_, list, children, update, cancel, retry, approve, waitFor, counts };
}
