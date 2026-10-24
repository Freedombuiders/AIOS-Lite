import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../core/deps.js';
import { TERMINAL_STATUSES, type Task, type TaskStatus } from '../../core/types.js';
import type { TaskFilter } from '../../work/contracts.js';
import { badRequest, conflict } from '../errors.js';
import { body, csv, found, intParam, limitParam, optInt } from '../util.js';

const STATUSES = ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled'] as const;

const createInput = z.object({
  prompt: z.string().trim().min(1).max(100_000),
  title: z.string().max(300).optional(),
  agentId: z.string().optional(),
  kind: z.enum(['task']).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  parentId: z.number().int().nullable().optional(),
  contextProfile: z.enum(['standard', 'lean']).optional(),
  runAfter: z.string().datetime().nullable().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const teamInput = z.object({
  prompt: z.string().trim().min(1).max(100_000),
  title: z.string().max(300).optional(),
  agentIds: z.array(z.string()).min(1).max(10),
  mode: z.enum(['parallel', 'relay']),
  mergeBy: z.string().optional(),
  priority: z.number().int().min(0).max(100).optional(),
});

export function tasksRoutes(app: Hono, deps: AppDeps): void {
  const source = (c: { req: { header(n: string): string | undefined } }) => (c.req.header('x-aios-source') === 'api' ? 'api' : 'user');
  const agentOrFail = (id: string) => {
    if (!deps.agents.get(id)) throw badRequest(`Không tìm thấy agent "${id}".`);
  };
  const task = (c: Parameters<typeof intParam>[0]): Task => found(deps.tasks.get(intParam(c)), 'việc');

  app.get('/api/tasks/counts', (c) => c.json(deps.tasks.counts()));

  app.get('/api/tasks', (c) => {
    const statuses = csv(c, 'status');
    if (statuses?.some((s) => !STATUSES.includes(s as TaskStatus))) throw badRequest('Tham số status không hợp lệ.');
    const parent = c.req.query('parentId');
    const filter: TaskFilter = {
      status: statuses as TaskStatus[] | undefined,
      agentId: c.req.query('agentId') || undefined,
      parentId: parent === 'null' ? null : parent ? optInt(c, 'parentId') : undefined,
      source: c.req.query('source') || undefined,
      kind: (c.req.query('kind') as TaskFilter['kind']) || undefined,
      q: c.req.query('q') || undefined,
      limit: limitParam(c),
      beforeId: optInt(c, 'beforeId'),
    };
    return c.json({ items: deps.tasks.list(filter) });
  });

  app.post('/api/tasks', async (c) => {
    const input = await body(c, createInput);
    if (input.agentId) agentOrFail(input.agentId);
    if (input.parentId) found(deps.tasks.get(input.parentId), 'việc cha');
    return c.json(deps.tasks.create({ ...input, source: source(c) }), 201);
  });

  app.post('/api/tasks/team', async (c) => {
    const input = await body(c, teamInput);
    for (const id of [...input.agentIds, ...(input.mergeBy ? [input.mergeBy] : [])]) agentOrFail(id);
    return c.json(deps.team.createTeamTask({ ...input, source: source(c) }), 201);
  });

  app.get('/api/tasks/:id', (c) => {
    const t = task(c);
    return c.json({
      task: t,
      runs: deps.runs.list({ taskId: t.id, limit: 100 }),
      children: deps.tasks.children(t.id),
      comments: deps.comments.list(t.id),
      parent: t.parentId ? (deps.tasks.get(t.parentId) ?? null) : null,
    });
  });

  app.post('/api/tasks/:id/cancel', (c) => {
    const t = task(c);
    if (TERMINAL_STATUSES.includes(t.status)) throw conflict('Việc đã kết thúc, không thể huỷ.');
    deps.audit.log({ actor: 'user', action: 'task.cancel', target: String(t.id) });
    return c.json(deps.tasks.cancel(t.id));
  });
  app.post('/api/tasks/:id/retry', (c) => {
    const t = task(c);
    if (!TERMINAL_STATUSES.includes(t.status)) throw conflict('Việc chưa kết thúc, không thể chạy lại.');
    return c.json(deps.tasks.retry(t.id));
  });
  app.post('/api/tasks/:id/approve', (c) => {
    const t = task(c);
    if (t.status !== 'review') throw conflict('Việc không ở trạng thái chờ duyệt.');
    deps.audit.log({ actor: 'user', action: 'task.approve', target: String(t.id) });
    return c.json(deps.tasks.approve(t.id));
  });

  app.get('/api/tasks/:id/comments', (c) => c.json({ items: deps.comments.list(task(c).id) }));
  app.post('/api/tasks/:id/comments', async (c) => {
    const t = task(c);
    const input = await body(c, z.object({ body: z.string().trim().min(1).max(20_000), requeue: z.boolean().optional() }));
    return c.json(deps.comments.add(t.id, 'user', input.body, { requeue: input.requeue ?? true }), 201);
  });
}
