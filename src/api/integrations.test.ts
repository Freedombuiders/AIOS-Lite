import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '../core/deps.js';
import { integrationServiceFor } from '../integrations/mount.js';
import { makeHarness } from '../integrations/test-harness.js';
import { createTestHarness } from '../modules/test-deps.js';
import { handleError } from './errors.js';
import { mountIntegrationRoutes } from './routes/integrations.js';
import { createApiServer } from './server.js';

let h: ReturnType<typeof makeHarness>;
afterEach(() => h?.cleanup());

function setup(grants: Parameters<typeof makeHarness>[0] = { pancake: 'ask' }) {
  h = makeHarness(grants);
  const app = new Hono();
  app.onError(handleError({ error() {}, warn() {}, info() {}, debug() {} } as never));
  mountIntegrationRoutes(app, { agents: h.agents } as unknown as AppDeps, h.service);
  const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const bearer = (agentId = 'agent-a', taskId = 1) => ({ authorization: `Bearer ${h.service.createRunToken(agentId, taskId)}` });
  return { app, req, bearer };
}

describe('integration routes', () => {
  it('PUT stores only a verified connection; responses never carry secrets', async () => {
    const { req } = setup();
    const bad = await req('PUT', '/api/integrations/pancake', { values: {} });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ detail: expect.any(String), error: { detail: expect.any(String), message: expect.any(String) } });

    const ok = await req('PUT', '/api/integrations/pancake', { values: { pos_api_key: 'pk-secret-9876' } });
    expect(ok.status).toBe(200);
    const summary = await ok.json();
    expect(summary).toMatchObject({ id: 'pancake', status: 'ok', grantedTo: [{ agentId: 'agent-a', grant: 'ask' }] });

    const list = await (await req('GET', '/api/integrations')).json();
    expect(list.items.length).toBeGreaterThan(5);
    const test = await (await req('POST', '/api/integrations/pancake/test')).json();
    expect(test).toMatchObject({ ok: true });
    const all = JSON.stringify([summary, list, test]);
    expect(all).not.toContain('pk-secret-9876');
    expect(all).toContain('••••9876');

    expect((await req('POST', '/api/integrations/botcake/test')).status).toBe(409);
    expect((await req('PUT', '/api/integrations/nope', { values: {} })).status).toBe(404);
    expect((await req('DELETE', '/api/integrations/pancake')).status).toBe(200);
    expect((await (await req('GET', '/api/integrations')).json()).items.find((i: { id: string }) => i.id === 'pancake').status).toBe('not_configured');
  });

  it('/tools and /call: bad token is 401, tools list only what is allowed', async () => {
    const { req, bearer } = setup({ pancake: 'read' });
    expect((await req('GET', '/api/integrations/tools')).status).toBe(401);
    expect((await req('GET', '/api/integrations/tools', undefined, { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await req('POST', '/api/integrations/call', { integration: 'pancake', command: 'orders list' }, { authorization: 'Bearer nope' })).status).toBe(401);

    const tools = (await (await req('GET', '/api/integrations/tools', undefined, bearer())).json()).tools as { name: string }[];
    expect(tools.map((t) => t.name)).toContain('pancake__orders_list');
    expect(tools.map((t) => t.name)).not.toContain('pancake__orders_set_status');

    await h.connectPancake();
    const ran = await (await req('POST', '/api/integrations/call', { integration: 'pancake', command: 'orders list', args: '--limit 2' }, bearer())).json();
    expect(ran).toMatchObject({ ok: true });
    const denied = await (await req('POST', '/api/integrations/call', { integration: 'pancake', command: 'orders set-status', args: '5 1' }, bearer())).json();
    expect(denied).toMatchObject({ ok: false, code: 'denied' });
  });

  it('approvals over HTTP: list pending, approve with always, reject, conflict', async () => {
    const { req, bearer } = setup({ pancake: 'ask' });
    await h.connectPancake();
    const task = h.finishedTask();
    const pend = await (await req('POST', '/api/integrations/call', { integration: 'pancake', command: 'orders set-status', args: '5 1' }, bearer('agent-a', task.id))).json();
    expect(pend).toMatchObject({ ok: false, code: 'approval_pending', approvalId: expect.any(String) });
    const items = (await (await req('GET', '/api/integrations/approvals?status=pending')).json()).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: pend.approvalId, integrationId: 'pancake', command: 'orders set-status', status: 'pending', taskId: task.id });

    const done = await (await req('POST', `/api/integrations/approvals/${pend.approvalId}/approve`, { always: true })).json();
    expect(done).toMatchObject({ status: 'approved' });
    expect((await req('POST', `/api/integrations/approvals/${pend.approvalId}/approve`)).status).toBe(409);
    expect((await req('POST', '/api/integrations/approvals/apr_x/reject')).status).toBe(404);

    const again = await (await req('POST', '/api/integrations/call', { integration: 'pancake', command: 'orders set-status', args: '5 1' }, bearer('agent-a', task.id))).json();
    expect(again).toMatchObject({ ok: true }); // trust rule
  });

  it('agent grants GET/PUT validate and persist', async () => {
    const { req } = setup({});
    expect(await (await req('GET', '/api/agents/agent-a/integrations')).json()).toEqual({ grants: {} });
    const put = await req('PUT', '/api/agents/agent-a/integrations', { grants: { pancake: 'write', botcake: 'off' } });
    expect(await put.json()).toEqual({ grants: { pancake: 'write' } });
    expect((await req('PUT', '/api/agents/agent-a/integrations', { grants: { pancake: 'root' } })).status).toBe(400);
    expect((await req('PUT', '/api/agents/ghost/integrations', { grants: {} })).status).toBe(404);
    expect((await req('GET', '/api/agents/ghost/integrations')).status).toBe(404);
  });
});

describe('createApiServer owner token', () => {
  it('lets run-token paths through the owner-token check but not the rest', async () => {
    const th = createTestHarness({ modulesDir: '/nonexistent', env: { AIOS_TOKEN: 'owner-token' } });
    const deps = { ...th.deps, modules: { mount() {} } } as unknown as AppDeps;
    const { app } = createApiServer(deps);
    expect((await app.request('/api/integrations')).status).toBe(401);
    const noRun = await app.request('/api/integrations/tools');
    expect(noRun.status).toBe(401);
    expect(((await noRun.json()) as { error: { message: string } }).error.message).toContain('lượt chạy');
    const token = integrationServiceFor(deps).createRunToken('agent-x', 3);
    const withRun = await app.request('/api/integrations/tools', { headers: { authorization: `Bearer ${token}` } });
    expect(withRun.status).toBe(200);
    expect(await withRun.json()).toEqual({ tools: [] });
  });
});
