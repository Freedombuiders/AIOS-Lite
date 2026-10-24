import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../core/deps.js';
import { registerIntegrationOAuthRoutes } from '../../integrations/composio/oauth-routes.js';
import { integrationServiceFor } from '../../integrations/mount.js';
import { getIntegration } from '../../integrations/registry.js';
import type { IntegrationService } from '../../integrations/service.js';
import { badRequest, conflict, errorBody } from '../errors.js';
import { body, found } from '../util.js';

/** Paths the MCP bridge calls with a per-run token instead of AIOS_TOKEN (server.ts lets them past the owner-token check). */
export const RUN_TOKEN_PATHS: readonly string[] = ['/api/integrations/tools', '/api/integrations/call'];

const callBody = z.object({
  integration: z.string().min(1).max(100),
  command: z.string().min(1).max(200),
  args: z.string().max(20_000).default(''),
});

export function mountIntegrationRoutes(app: Hono, deps: AppDeps, service: IntegrationService = integrationServiceFor(deps)): void {
  const known = (id: string) => found(getIntegration(id), 'integration');

  const runToken = (header: string | undefined) => {
    const h = header ?? '';
    return h.toLowerCase().startsWith('bearer ') ? service.verifyRunToken(h.slice(7).trim()) : null;
  };
  const unauthorized = () => errorBody('unauthorized', 'Thiếu hoặc sai token của lượt chạy.');

  app.get('/api/integrations', (c) => c.json({ items: service.credentials.list() }));

  // -- agent-facing (Bearer run token) ---------------------------------
  app.get('/api/integrations/tools', (c) => {
    const who = runToken(c.req.header('authorization'));
    if (!who) return c.json(unauthorized(), 401);
    return c.json({ tools: service.runner.tools(who.agentId) });
  });

  app.post('/api/integrations/call', async (c) => {
    const who = runToken(c.req.header('authorization'));
    if (!who) return c.json(unauthorized(), 401);
    const input = await body(c, callBody);
    return c.json(await service.runner.call({ agentId: who.agentId, taskId: who.taskId, ...input }));
  });

  // -- approvals ------------------------------------------------------
  app.get('/api/integrations/approvals', (c) => c.json({ items: service.approvals.list(c.req.query('status') || undefined) }));
  app.post('/api/integrations/approvals/:id/approve', async (c) => {
    const { always } = await body(c, z.object({ always: z.boolean().optional() }), { optional: true });
    return c.json(await service.approvals.approve(c.req.param('id'), { always }));
  });
  app.post('/api/integrations/approvals/:id/reject', (c) => c.json(service.approvals.reject(c.req.param('id'))));

  // -- credentials ----------------------------------------------------
  app.put('/api/integrations/:id', async (c) => {
    const definition = known(c.req.param('id'));
    if (definition.authKind === 'oauth') throw badRequest('Dùng nút đăng nhập Google.');
    const { values } = await body(c, z.object({ values: z.record(z.string(), z.unknown()) }));
    const res = await service.credentials.put(definition.id, values);
    if (!res.ok) {
      const e = errorBody('bad_request', res.detail);
      return c.json({ error: { ...e.error, detail: res.detail }, detail: res.detail }, 400);
    }
    return c.json(res.summary);
  });

  app.post('/api/integrations/:id/test', async (c) => {
    const definition = known(c.req.param('id'));
    const result = await service.credentials.test(definition.id);
    if (!result) throw conflict('Integration chưa được kết nối.');
    return c.json({ ok: result.ok, detail: result.detail, ...(result.accountLabel ? { accountLabel: result.accountLabel } : {}) });
  });

  app.delete('/api/integrations/:id', (c) => {
    service.credentials.remove(known(c.req.param('id')).id);
    return c.json({ ok: true });
  });

  registerIntegrationOAuthRoutes(app, service.oauthStore);

  // -- per-agent grants -----------------------------------------------
  app.get('/api/agents/:id/integrations', (c) => {
    const grants = found(service.grants.get(c.req.param('id')), 'agent');
    return c.json({ grants });
  });

  app.put('/api/agents/:id/integrations', async (c) => {
    const id = c.req.param('id');
    found(deps.agents.get(id), 'agent');
    const { grants } = await body(c, z.object({ grants: z.unknown() }));
    const res = service.grants.set(id, grants);
    if ('error' in res) throw badRequest(res.error);
    return c.json({ grants: res.grants });
  });
}
