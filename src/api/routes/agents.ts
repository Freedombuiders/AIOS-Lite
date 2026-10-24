import { AGENT_ID_RE } from '../../agents/schema.js';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AgentInput } from '../../agents/contracts.js';
import type { AppDeps } from '../../core/deps.js';
import { RUNTIME_IDS } from '../../core/types.js';
import { badRequest, conflict } from '../errors.js';
import { body, found } from '../util.js';

const RUNTIME = z.enum(RUNTIME_IDS as [string, ...string[]]);

const agentInput = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    runtime: RUNTIME.optional(),
    model: z.string().optional(),
    runtimeOptions: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    permission: z.enum(['safe', 'full']).optional(),
    context: z.enum(['standard', 'lean']).optional(),
    reportsTo: z.string().optional(),
    canDelegate: z.boolean().optional(),
    maxConcurrent: z.number().int().min(1).max(20).optional(),
    budgetUsdMonth: z.number().min(0).optional(),
    enabled: z.boolean().optional(),
    access: z.any().optional(),
    persona: z.string().optional(),
    workspace: z.string().optional(),
  })
  .strip();

const createInput = agentInput.extend({
  id: z.string().regex(AGENT_ID_RE, 'chỉ gồm chữ thường, số và dấu gạch ngang, 2–41 ký tự'),
  name: z.string().min(1).max(120),
  runtime: RUNTIME,
});

const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
};

export function agentsRoutes(app: Hono, deps: AppDeps): void {
  const stats = (id: string) => ({
    running: deps.tasks.list({ agentId: id, status: 'running', limit: 500 }).length,
    queued: deps.tasks.list({ agentId: id, status: 'queued', limit: 500 }).length,
    lastRunAt: deps.runs.list({ agentId: id, limit: 1 })[0]?.startedAt ?? null,
    costMonthUsd: deps.runs.monthCost(id),
    runsMonth: deps.runs.list({ agentId: id, since: monthStart(), limit: 500 }).length,
  });
  const summaries = () => deps.agents.list().map(({ persona: _p, ...a }) => ({ ...a, stats: stats(a.id) }));
  const listBody = () => ({ items: summaries(), errors: deps.agents.errors() });
  const wrap = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
  };

  app.get('/api/agents', (c) => c.json(listBody()));
  app.post('/api/agents/reload', (c) => {
    deps.agents.reload();
    return c.json(listBody());
  });
  app.get('/api/agents/:id', (c) => {
    const a = found(deps.agents.get(c.req.param('id')), 'agent');
    return c.json({ ...a, stats: stats(a.id) });
  });
  app.post('/api/agents', async (c) => {
    const { id, ...input } = await body(c, createInput);
    if (deps.agents.get(id)) throw conflict(`Agent "${id}" đã tồn tại.`);
    const created = wrap(() => deps.agents.create(id, input as AgentInput & { name: string; runtime: never }));
    deps.audit.log({ actor: 'user', action: 'agent.create', target: id });
    return c.json(created, 201);
  });
  app.put('/api/agents/:id', async (c) => {
    const id = c.req.param('id');
    found(deps.agents.get(id), 'agent');
    const patch = await body(c, agentInput);
    const updated = wrap(() => deps.agents.update(id, patch as AgentInput));
    deps.audit.log({ actor: 'user', action: 'agent.update', target: id });
    return c.json(updated);
  });
  app.delete('/api/agents/:id', (c) => {
    const id = c.req.param('id');
    found(deps.agents.get(id), 'agent');
    deps.agents.archive(id);
    deps.audit.log({ actor: 'user', action: 'agent.archive', target: id });
    return c.json({ ok: true });
  });
  app.get('/api/agents/:id/access', (c) => {
    const agent = found(deps.agents.get(c.req.param('id')), 'agent');
    const access = deps.access.snapshot(deps.access.resolve(agent));
    return c.json({ access, enforcement: deps.runtimes.get(agent.runtime).capabilities.enforces, runtime: agent.runtime });
  });
}
