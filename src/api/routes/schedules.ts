import { Cron } from 'croner';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../core/deps.js';
import { badRequest } from '../errors.js';
import { body, found, intParam } from '../util.js';

const scheduleInput = z.object({
  name: z.string().trim().min(1).max(120),
  agentId: z.string().min(1),
  cron: z.string().trim().min(1).max(100),
  timezone: z.string().optional(),
  prompt: z.string().trim().min(1).max(100_000),
  enabled: z.boolean().optional(),
});

function checkCron(expr: string | undefined, timezone: string | undefined): void {
  if (expr === undefined) return;
  try {
    new Cron(expr, { paused: true, timezone }).stop();
  } catch {
    throw badRequest('Biểu thức cron hoặc múi giờ không hợp lệ.');
  }
}

export function schedulesRoutes(app: Hono, deps: AppDeps): void {
  const agentOrFail = (id: string | undefined) => {
    if (id !== undefined && !deps.agents.get(id)) throw badRequest(`Không tìm thấy agent "${id}".`);
  };
  const sched = (c: Parameters<typeof intParam>[0]) => found(deps.scheduler.get(intParam(c)), 'lịch');

  app.get('/api/schedules', (c) => c.json({ items: deps.scheduler.list() }));
  app.post('/api/schedules', async (c) => {
    const input = await body(c, scheduleInput);
    agentOrFail(input.agentId);
    checkCron(input.cron, input.timezone ?? deps.config.timezone);
    return c.json(deps.scheduler.create(input), 201);
  });
  app.put('/api/schedules/:id', async (c) => {
    const s = sched(c);
    const patch = await body(c, scheduleInput.partial());
    agentOrFail(patch.agentId);
    checkCron(patch.cron, patch.timezone ?? s.timezone);
    return c.json(deps.scheduler.update(s.id, patch));
  });
  app.delete('/api/schedules/:id', (c) => {
    deps.scheduler.remove(sched(c).id);
    return c.json({ ok: true });
  });
  app.post('/api/schedules/:id/run', (c) => c.json(deps.scheduler.runNow(sched(c).id)));
}
