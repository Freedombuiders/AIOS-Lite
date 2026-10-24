import type { AppConfig } from '../core/config.js';
import { nowIso, type DB } from '../core/db.js';
import type { EventBus } from '../core/events.js';
import type { Logger } from '../core/log.js';
import type { Task } from '../core/types.js';
import type { AgentRegistry } from '../agents/contracts.js';
import type { Dispatcher, Engine, TaskService } from './contracts.js';
import { rowToTask } from './tasks.js';

export interface DispatcherDeps {
  db: DB;
  config: Pick<AppConfig, 'maxParallel' | 'dispatcherPollMs'>;
  agents: AgentRegistry;
  tasks: TaskService;
  engine: Engine;
  log: Logger;
  /** when given, new queued tasks wake the dispatcher immediately */
  bus?: EventBus;
  stopTimeoutMs?: number;
}

const CLAIM_SQL = `
UPDATE tasks SET status = 'running', started_at = ?, updated_at = ?, finished_at = NULL, error = NULL
WHERE id = (
  SELECT id FROM tasks
  WHERE status = 'queued' AND (run_after IS NULL OR run_after <= ?)
    AND agent_id NOT IN (SELECT value FROM json_each(?))
  ORDER BY priority DESC, id LIMIT 1
) AND status = 'queued' RETURNING *`;

export function createDispatcher({ db, config, agents, tasks, engine, log, bus, stopTimeoutMs = 10_000 }: DispatcherDeps): Dispatcher {
  const running = new Map<number, { controller: AbortController; done: Promise<void> }>();
  let timer: NodeJS.Timeout | undefined;
  let off: (() => void) | undefined;
  let stopped = true;
  let kickScheduled = false;

  const emergency = (): boolean => (db.prepare("SELECT value FROM kv WHERE key = 'emergency_stop'").get() as { value: string } | undefined)?.value === '1';

  function blockedAgents(): string[] {
    const counts = new Map<string, number>();
    for (const r of db.prepare("SELECT agent_id, COUNT(*) AS n FROM tasks WHERE status = 'running' GROUP BY agent_id").all() as { agent_id: string; n: number }[]) counts.set(r.agent_id, r.n);
    const out: string[] = [];
    for (const a of agents.list()) {
      if (!a.enabled || (counts.get(a.id) ?? 0) >= Math.max(1, a.maxConcurrent)) out.push(a.id);
    }
    return out;
  }

  function globalRunning(): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'running'").get() as { n: number }).n;
  }

  function claim(): Task | undefined {
    const now = nowIso();
    const row = db.prepare(CLAIM_SQL).get(now, now, now, JSON.stringify(blockedAgents())) as Record<string, unknown> | undefined;
    return rowToTask(row);
  }

  function launch(task: Task): void {
    const controller = new AbortController();
    const done = (async () => {
      try {
        await engine.execute(task, controller.signal);
      } catch (err) {
        log.error({ err, taskId: task.id }, 'engine crashed');
        const cur = tasks.get(task.id);
        if (cur?.status === 'running') {
          tasks.update(task.id, { status: 'failed', error: `Lỗi nội bộ: ${(err as Error).message}` });
        }
      } finally {
        running.delete(task.id);
        if (!stopped) schedulePump();
      }
    })();
    running.set(task.id, { controller, done });
  }

  function pump(): void {
    if (stopped || emergency()) return;
    while (running.size < config.maxParallel && globalRunning() < config.maxParallel) {
      const task = claim();
      if (!task) return;
      tasks.update(task.id, {}); // emits the 'task' event for the new status
      launch(task);
    }
  }

  function schedulePump(): void {
    if (kickScheduled) return;
    kickScheduled = true;
    setImmediate(() => {
      kickScheduled = false;
      try {
        pump();
      } catch (err) {
        log.error({ err }, 'dispatcher pump failed');
      }
    });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      off = bus?.on('task', (e) => {
        if (e.task.status === 'queued') schedulePump();
      });
      timer = setInterval(schedulePump, config.dispatcherPollMs);
      timer.unref?.();
      schedulePump();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      off?.();
      off = undefined;
      const all = [...running.values()].map((r) => r.done);
      if (!all.length) return;
      let to: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((res) => (to = setTimeout(() => res('timeout'), stopTimeoutMs)));
      const outcome = await Promise.race([Promise.allSettled(all).then(() => 'ok' as const), timeout]);
      if (to) clearTimeout(to);
      if (outcome === 'timeout') {
        for (const r of running.values()) r.controller.abort();
        await Promise.allSettled([...running.values()].map((r) => r.done));
      }
    },
    kick: schedulePump,
    abort(taskId) {
      const r = running.get(taskId);
      if (!r) return false;
      r.controller.abort();
      return true;
    },
    runningTaskIds: () => [...running.keys()],
  };
}
