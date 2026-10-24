import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { ToolCall } from './bridge.js';
import { RocketFlowService, rocketFlowService, schema } from './service.js';
export type { StudioJob } from './service.js';
export function registerVideoStudioRoutes(app: Hono, options: { root?: string; call?: ToolCall } = {}) {
  const service = options.root || options.call ? new RocketFlowService(options.root, options.call) : rocketFlowService;
  app.use('/studio/*', bodyLimit({ maxSize: 1_000_000 }));
  app.get('/studio/jobs', c => c.json({ jobs: service.list() }));
  app.get('/studio/connection', c => { c.header('Cache-Control', 'no-store'); return c.json({ mode: 'local-auto', grants: service.grants() }); });
  app.post('/studio/grants', async c => {
    const parsed = z.object({ agentId: z.string(), access: z.enum(['off', 'read', 'write']) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid grant' }, 400);
    try { service.grant(parsed.data.agentId, parsed.data.access); return c.json({ grants: service.grants() }); } catch { return c.json({ error: 'Invalid agent ID' }, 400); }
  });
  for (const [route, tool] of [['status', 'rocketflow_status'], ['capabilities', 'list_capabilities']]) {
    app.post(`/studio/${route}`, async c => {
      try { return c.json({ output: await service.call(tool, {}) }); } catch (e) { return c.json({ error: String(e instanceof Error ? e.message : e) }, 503); }
    });
  }
  app.post('/studio/jobs', async c => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Kiểm tra tên dự án, prompt và thông số tạo.' }, 400);
    try { return c.json({ job: await service.submit(parsed.data, { project: 'studio' }) }); } catch (e) { return c.json({ error: String(e instanceof Error ? e.message : e) }, 400); }
  });
  app.post('/studio/jobs/:id/:action', async c => {
    const action = c.req.param('action');
    if (action !== 'refresh' && action !== 'cancel') return c.json({ error: 'Thao tác không hợp lệ.' }, 400);
    try { service.read(c.req.param('id')); } catch { return c.json({ error: 'Không tìm thấy job.' }, 404); }
    try { return c.json({ job: await service.action(c.req.param('id'), action) }); } catch (e) { return c.json({ error: String(e instanceof Error ? e.message : e) }, 409); }
  });
}
