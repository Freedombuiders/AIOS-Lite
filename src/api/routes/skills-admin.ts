import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../core/deps.js';
import { adminServices } from '../../shared/admin-services.js';
import { badRequest, notFound } from '../errors.js';
import { body } from '../util.js';

/** Must be mounted before the `/api/skills/:id` route. */
export function skillsAdminRoutes(app: Hono, deps: AppDeps): void {
  const { skillRoots } = adminServices(deps);
  const usedBy = (id: string) => deps.agents.list().filter((a) => a.access.skills === 'all' || a.access.skills.includes(id)).map((a) => a.id);

  app.get('/api/skills/roots', (c) => c.json({ items: skillRoots.list(), suggestions: skillRoots.suggestions() }));

  app.post('/api/skills/roots', async (c) => {
    const input = await body(c, z.object({ path: z.string().min(1), label: z.string().max(80).optional() }));
    const root = skillRoots.add(input);
    deps.audit.log({ actor: 'user', action: 'skills.root.add', target: root.path });
    return c.json(root, 201);
  });

  app.delete('/api/skills/roots', async (c) => {
    const { path } = await body(c, z.object({ path: z.string().min(1) }));
    skillRoots.remove(path);
    deps.audit.log({ actor: 'user', action: 'skills.root.remove', target: path });
    return c.json({ ok: true });
  });

  app.put('/api/skills/:id/agents', async (c) => {
    const id = c.req.param('id');
    if (!deps.skills.get(id)) throw notFound('Không tìm thấy skill.');
    const { agentIds } = await body(c, z.object({ agentIds: z.array(z.string()) }));
    const all = deps.agents.list();
    const wanted = new Set(agentIds);
    for (const a of wanted) if (!all.some((x) => x.id === a)) throw badRequest(`Không có agent "${a}".`);
    for (const a of all) {
      if (a.access.skills === 'all') continue;
      const has = a.access.skills.includes(id);
      if (wanted.has(a.id) === has) continue;
      const skills = has ? a.access.skills.filter((s) => s !== id) : [...a.access.skills, id];
      deps.agents.update(a.id, { access: { ...a.access, skills } });
      deps.audit.log({ actor: 'user', action: 'agent.update', target: a.id, detail: { skill: id, granted: !has } });
    }
    return c.json({ usedBy: usedBy(id) });
  });
}
