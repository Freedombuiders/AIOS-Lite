import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../core/deps.js';
import { body, found, readJson, parse } from '../util.js';
import { badRequest } from '../errors.js';

export function modulesRoutes(app: Hono, deps: AppDeps): void {
  const mod = (id: string) => found(deps.modules.get(id), 'module');

  app.get('/api/modules', (c) => c.json({ items: deps.modules.list() }));
  app.get('/api/modules/:id', (c) => c.json(mod(c.req.param('id'))));
  app.post('/api/modules/:id/add', async (c) => {
    mod(c.req.param('id'));
    const opts = await body(c, z.object({ installAgents: z.boolean().optional() }), { optional: true });
    return c.json(await deps.modules.add(c.req.param('id'), opts));
  });
  app.post('/api/modules/:id/remove', async (c) => {
    mod(c.req.param('id'));
    return c.json(await deps.modules.remove(c.req.param('id')));
  });
  app.post('/api/modules/:id/purge', async (c) => {
    mod(c.req.param('id'));
    const { confirm } = await body(c, z.object({ confirm: z.string() }));
    await deps.modules.purge(c.req.param('id'), confirm);
    return c.json({ ok: true });
  });
  app.get('/api/modules/:id/settings', (c) => c.json(deps.modules.settings(mod(c.req.param('id')).manifest.id)));
  app.put('/api/modules/:id/settings', async (c) => {
    const id = mod(c.req.param('id')).manifest.id;
    const patch = parse(z.record(z.string(), z.unknown()), await readJson(c));
    if (Array.isArray(patch)) throw badRequest('Cài đặt phải là một đối tượng.');
    return c.json(deps.modules.updateSettings(id, patch));
  });
}
