import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../core/deps.js';
import { badRequest } from '../errors.js';
import { body, found, intParam, limitParam } from '../util.js';

export function memoryRoutes(app: Hono, deps: AppDeps): void {
  const mem = (c: Parameters<typeof intParam>[0]) => found(deps.memory.get(intParam(c)), 'ký ức');

  app.get('/api/memory', (c) => {
    const scope = (c.req.query('scope') ?? 'all') as 'team' | 'private' | 'all';
    if (!['team', 'private', 'all'].includes(scope)) throw badRequest('Tham số scope không hợp lệ.');
    return c.json({
      items: deps.memory.list({ scope, agentId: c.req.query('agentId') || undefined, q: c.req.query('q') || undefined, limit: limitParam(c) }),
    });
  });
  app.post('/api/memory', async (c) => {
    const input = await body(c, z.object({ content: z.string().trim().min(1).max(20_000), agentId: z.string().nullable(), pinned: z.boolean().optional() }));
    if (input.agentId && !deps.agents.get(input.agentId)) throw badRequest(`Không tìm thấy agent "${input.agentId}".`);
    return c.json(deps.memory.add({ ...input, source: 'user' }), 201);
  });
  app.patch('/api/memory/:id', async (c) => {
    const m = mem(c);
    const patch = await body(c, z.object({ content: z.string().trim().min(1).max(20_000).optional(), pinned: z.boolean().optional() }));
    return c.json(deps.memory.update(m.id, patch));
  });
  app.delete('/api/memory/:id', (c) => {
    deps.memory.remove(mem(c).id);
    return c.json({ ok: true });
  });
}
