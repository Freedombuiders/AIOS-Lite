import type { Hono } from 'hono';
import type { AppDeps } from '../../core/deps.js';
import { badRequest, notFound } from '../errors.js';
import { limitParam, optInt } from '../util.js';

export function miscRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/skills', (c) => {
    const agents = deps.agents.list();
    const items = deps.skills.list().map((s) => ({
      ...s,
      usedBy: agents.filter((a) => a.access.skills === 'all' || a.access.skills.includes(s.id)).map((a) => a.id),
    }));
    return c.json({ items });
  });
  app.get('/api/skills/:id', (c) => {
    const skill = deps.skills.get(c.req.param('id'));
    if (!skill) throw notFound('Không tìm thấy skill.');
    return c.json({ skill, content: deps.skills.read(skill.id) });
  });

  app.get('/api/board', (c) => c.json({ items: deps.board.recent(limitParam(c, 30)) }));

  app.get('/api/audit', (c) => {
    const since = c.req.query('since');
    if (since && Number.isNaN(Date.parse(since))) throw badRequest('Tham số since không hợp lệ.');
    return c.json({
      items: deps.audit.list({
        actor: c.req.query('actor') || undefined,
        action: c.req.query('action') || undefined,
        since: since || undefined,
        limit: limitParam(c),
        beforeId: optInt(c, 'beforeId'),
      }),
    });
  });
}
