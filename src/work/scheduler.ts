import { CronExpressionParser } from 'cron-parser';
import type { AppConfig } from '../core/config.js';
import { camelRow, nowIso, type DB } from '../core/db.js';
import type { Logger } from '../core/log.js';
import type { Schedule, Task } from '../core/types.js';
import type { AgentRegistry } from '../agents/contracts.js';
import type { ScheduleInput, SchedulerService, TaskService } from './contracts.js';
import { isTerminal } from './tasks.js';

const TICK_MS = 30_000;

function nextRun(cron: string, tz: string, from: Date): string {
  return CronExpressionParser.parse(cron, { tz, currentDate: from }).next().toDate().toISOString();
}

export function validateCron(cron: string, tz: string): void {
  try {
    nextRun(cron, tz, new Date());
  } catch (err) {
    throw new Error(`Lịch cron hoặc múi giờ không hợp lệ: ${(err as Error).message}`);
  }
}

export function createScheduler({ db, tasks, agents, log, config }: { db: DB; tasks: TaskService; agents: AgentRegistry; log: Logger; config: Pick<AppConfig, 'timezone'> }): SchedulerService {
  let timer: NodeJS.Timeout | undefined;

  const toSchedule = (row: Record<string, unknown> | undefined): Schedule | undefined => {
    const s = camelRow<Schedule & { enabled: number | boolean }>(row);
    return s ? { ...s, enabled: !!s.enabled } : undefined;
  };
  const get = (id: number): Schedule | undefined => toSchedule(db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as Record<string, unknown> | undefined);
  const require_ = (id: number): Schedule => {
    const s = get(id);
    if (!s) throw new Error(`Không tìm thấy lịch #${id}`);
    return s;
  };

  function fire(s: Schedule): Task {
    const task = tasks.create({ prompt: s.prompt, title: s.name, agentId: s.agentId, source: `schedule:${s.id}`, trigger: 'schedule' });
    db.prepare('UPDATE schedules SET last_run_at = ?, last_task_id = ?, updated_at = ? WHERE id = ?').run(nowIso(), task.id, nowIso(), s.id);
    return task;
  }

  function advance(s: Schedule, now: Date): void {
    let next: string | null = null;
    try {
      next = nextRun(s.cron, s.timezone, now);
    } catch (err) {
      log.warn({ err, scheduleId: s.id }, 'invalid cron, schedule paused');
    }
    db.prepare('UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ?').run(next, nowIso(), s.id);
  }

  const service: SchedulerService = {
    list: () => (db.prepare('SELECT * FROM schedules ORDER BY id').all() as Record<string, unknown>[]).map((r) => toSchedule(r)!),
    get,

    create(input: ScheduleInput) {
      const tz = input.timezone || config.timezone;
      if (!input.name?.trim()) throw new Error('Tên lịch không được để trống');
      if (!input.prompt?.trim()) throw new Error('Nội dung lịch không được để trống');
      if (!agents.get(input.agentId)) throw new Error(`Không tìm thấy agent "${input.agentId}"`);
      validateCron(input.cron, tz);
      const now = nowIso();
      const info = db
        .prepare('INSERT INTO schedules (name, agent_id, cron, timezone, prompt, enabled, next_run_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(input.name.trim(), input.agentId, input.cron, tz, input.prompt, input.enabled === false ? 0 : 1, nextRun(input.cron, tz, new Date()), now, now);
      return require_(Number(info.lastInsertRowid));
    },

    update(id, patch) {
      const cur = require_(id);
      const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Schedule;
      if (patch.agentId && !agents.get(patch.agentId)) throw new Error(`Không tìm thấy agent "${patch.agentId}"`);
      validateCron(next.cron, next.timezone);
      db.prepare('UPDATE schedules SET name=?, agent_id=?, cron=?, timezone=?, prompt=?, enabled=?, next_run_at=?, updated_at=? WHERE id=?').run(
        next.name, next.agentId, next.cron, next.timezone, next.prompt, next.enabled ? 1 : 0, nextRun(next.cron, next.timezone, new Date()), nowIso(), id,
      );
      return require_(id);
    },

    remove(id) {
      db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    },

    runNow(id) {
      return fire(require_(id));
    },

    tick(now = new Date()) {
      const created: Task[] = [];
      for (const s of service.list()) {
        if (!s.enabled || !s.nextRunAt || Date.parse(s.nextRunAt) > now.getTime()) continue;
        const agent = agents.get(s.agentId);
        const last = s.lastTaskId ? tasks.get(s.lastTaskId) : undefined;
        if (!agent || !agent.enabled) log.warn({ scheduleId: s.id }, 'schedule skipped: agent missing or disabled');
        else if (last && !isTerminal(last.status)) log.info({ scheduleId: s.id }, 'schedule skipped: previous run still active');
        else created.push(fire(s));
        advance(s, now);
      }
      return created;
    },

    start() {
      if (timer) return;
      // skip_missed: after downtime, move overdue schedules to their next future slot without running them
      const now = new Date();
      for (const s of service.list()) {
        if (s.enabled && s.nextRunAt && Date.parse(s.nextRunAt) < now.getTime()) advance(s, now);
      }
      timer = setInterval(() => {
        try {
          service.tick();
        } catch (err) {
          log.error({ err }, 'scheduler tick failed');
        }
      }, TICK_MS);
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  return service;
}
