// Owner principal: route list coverage over the real route table, pairing, sessions, cross-site refusals, and the
// MCP bridge staying a non-owner path.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { registerKolRoutes } from '../../modules/kol/server/routes.js';
import kolVideoRoutes from '../../modules/kol/server/video-routes.js';
import { getFbContent } from '../../modules/marketing/server/store.js';
import { futureAt, makePage, seedContent } from '../../modules/marketing/server/core/test-fixtures.js';
import type { AppDeps } from '../core/deps.js';
import { redactString } from '../core/redact.js';
import { integrationServiceFor } from '../integrations/mount.js';
import { createModuleManager } from '../modules/manager.js';
import { createTestHarness, type TestHarness } from '../modules/test-deps.js';
import {
  NOT_OWNER_ROUTES, OWNER_HEADER, OWNER_ROUTES, createOwnerAuth, isExemptRoute, isOwnerRoute, looksSensitive, normalizePath,
} from './owner.js';
import { createApiServer } from './server.js';

const MODULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'modules');

let h: TestHarness | undefined;
let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
  h?.cleanup();
  h = undefined;
});

async function boot(opts: { token?: string; modules?: string[] } = {}) {
  h = createTestHarness({ modulesDir: MODULES_DIR, env: opts.token ? { AIOS_TOKEN: opts.token } : {} });
  h.fakes.connections.set('composio', { id: 'composio', type: 'composio' } as never);
  const mgr = createModuleManager(h.deps, { fromDist: false });
  (h.deps as { modules: unknown }).modules = mgr;
  const printed: string[] = [];
  const owner = createOwnerAuth({ db: h.deps.db, token: h.deps.config.token, print: (t) => void printed.push(t) });
  const server = createApiServer(h.deps, { owner });
  // add in dependency order: a module whose required module is not on yet is retried in the next pass
  let pending = opts.modules ?? mgr.discover().map((m) => m.manifest.id);
  for (let pass = 0; pending.length && pass < 5; pass++) {
    const next: string[] = [];
    for (const id of pending) {
      const requires = mgr.discover().find((m) => m.manifest.id === id)?.manifest.requires?.modules ?? [];
      if (requires.some((r) => !mgr.isEnabled(r))) {
        next.push(id);
        continue;
      }
      const r = await mgr.add(id, { installAgents: false });
      expect(r.module.error, id).toBeUndefined();
    }
    pending = next;
  }
  expect(pending).toEqual([]);
  stop = () => mgr.stop();
  return { mgr, app: server.app, owner, printed, deps: h.deps };
}

const codeIn = (text: string): string => /mã ([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(text)![1]!;

async function pair(app: Hono, owner: ReturnType<typeof createOwnerAuth>): Promise<string> {
  const res = await app.request('/api/owner/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ code: owner.issueCode() }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie')!;
  return cookie.split(';')[0]!;
}

describe('owner route list', () => {
  it('covers every sensitive state-changing route of core and all modules; every entry matches a real route', async () => {
    const { app, mgr } = await boot();
    const kol = new Hono();
    registerKolRoutes(kol);
    kol.route('/api/kol/videos', kolVideoRoutes);
    const table = [
      ...app.routes.map((r) => ({ method: r.method, path: r.path })),
      ...mgr.routeTable(),
      ...kol.routes.map((r) => ({ method: r.method, path: r.path.replace(/^\/api\/kol/, '/api/m/kol') })),
    ].filter((r) => r.method !== 'ALL'); // ALL = middleware (app.use)
    const routes = table.filter((r) => r.method !== 'GET');
    expect(routes.length).toBeGreaterThan(200);

    const uncovered = routes.filter((r) => looksSensitive(r.method, r.path) && !isOwnerRoute(r.method, r.path) && !isExemptRoute(r.method, r.path));
    expect(uncovered.map((r) => `${r.method} ${r.path}`)).toEqual([]);

    // stale or misspelled entries would silently protect nothing
    // ('*' prefix entries such as /api/m/crm/* guard a module with no write route yet: a GET under it is enough)
    for (const [method, pattern] of [...OWNER_ROUTES, ...NOT_OWNER_ROUTES]) {
      const pool = method === '*' ? table.map((r) => ({ ...r, method: '*' })) : routes;
      expect(pool.some((r) => matchesOne(method, pattern, r)), `${method} ${pattern}`).toBe(true);
    }

    // routes added on main since S1 (T22 packs + cloud, T08 crm, T14 learn) and care's pause / AI mode
    for (const [m, p] of [
      ['POST', '/api/packs/:id/preview'], ['POST', '/api/packs/:id/install'], ['POST', '/api/packs/:id/uninstall/preview'], ['POST', '/api/packs/:id/uninstall'],
      ['POST', '/api/cloud/login/start'], ['POST', '/api/m/learn/sync'], ['POST', '/api/m/crm/anything-new'],
      ['POST', '/api/m/dream/channels'], ['POST', '/api/m/dream/videos'], ['DELETE', '/api/m/dream/videos/x'], ['PUT', '/api/m/dream/settings'],
      ['PUT', '/api/m/care/conversations/:id/pause'], ['DELETE', '/api/m/care/conversations/:id/pause'],
      ['PUT', '/api/m/care/conversations/:id/ai'], ['PUT', '/api/m/care/conversations/:id/customer-care'], ['PUT', '/api/m/care/runtime/switches'],
      // G1: GenBot key, base URL, bot id and every bot change; the per-agent check can send the stored key
      ['POST', '/api/genbot/bots'], ['PUT', '/api/genbot/bots/:id'], ['PUT', '/api/genbot/bots/:id/key'], ['DELETE', '/api/genbot/bots/:id/key'],
      ['POST', '/api/genbot/bots/:id/check'], ['POST', '/api/genbot/bots/:id/pause'], ['DELETE', '/api/genbot/bots/:id'], ['POST', '/api/genbot/bots/:id/convert'],
      ['PUT', '/api/genbot/connection'], ['POST', '/api/genbot/connection/check'], ['POST', '/api/genbot/probe'], ['POST', '/api/runtimes/genbot/check'],
    ] as const) expect(isOwnerRoute(m, p), `${m} ${p}`).toBe(true);
    expect(isOwnerRoute('GET', '/api/genbot')).toBe(false);
    // reads and the cloud OAuth callback stay open
    for (const p of ['/api/packs', '/api/packs/installed', '/api/packs/updates', '/api/cloud/status', '/api/cloud/callback', '/api/m/crm/customers', '/api/m/learn/content-lab']) {
      expect(isOwnerRoute('GET', p), p).toBe(false);
    }
    // a run-token path is never an owner path, even though "integrations" looks sensitive
    expect(isOwnerRoute('POST', '/api/integrations/call')).toBe(false);
  });

  it('matches the paths a request can really take and ignores reads', () => {
    expect(isOwnerRoute('POST', '/api/m/care/drafts/12/approve')).toBe(true);
    expect(isOwnerRoute('POST', '/api/m/care//drafts/12/approve/')).toBe(true);
    expect(isOwnerRoute('POST', '/api/m/care/drafts/12%2Fapprove')).toBe(true);
    expect(isOwnerRoute('post', '/API/M/CARE/DRAFTS/12/APPROVE')).toBe(true);
    expect(isOwnerRoute('GET', '/api/m/care/drafts/12')).toBe(false);
    expect(isOwnerRoute('POST', '/api/tasks')).toBe(false);
    expect(isOwnerRoute('PUT', '/api/m/ads')).toBe(true);
    expect(normalizePath('/a//b/')).toBe('/a/b');
  });
});

/** Is this concrete route one the given list pattern describes? (same compile rules as owner.ts) */
function matchesOne(method: string, pattern: string, r: { method: string; path: string }): boolean {
  if (method !== '*' && method !== r.method) return false;
  const re = new RegExp(`^${pattern.split('/').map((s) => (s === '*' ? '.*' : s.startsWith(':') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/').replace(/\/\.\*$/, '(?:/.*)?')}$`, 'i');
  return re.test(r.path);
}

describe('owner gate over HTTP', () => {
  it('approving a post needs the owner: no cookie is 401, a paired browser approves', async () => {
    const { app, owner } = await boot({ modules: ['marketing'] });
    makePage('p1');
    const id = seedContent({ status: 'review' });
    const approve = (headers: Record<string, string> = {}) =>
      app.request(`/api/m/marketing/content/${id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ scheduledAt: futureAt(2, '10:00') }) });

    const anon = await approve();
    expect(anon.status).toBe(401);
    expect(anon.headers.get(OWNER_HEADER)).toBe('required');
    expect(getFbContent(id)?.status).toBe('review');
    // reads stay open without the cookie
    expect((await app.request('/api/m/marketing/content')).status).toBe(200);
    // a forged or random cookie is not a session
    expect((await approve({ cookie: 'aios_owner=' + 'x'.repeat(43) })).status).toBe(401);

    const cookie = await pair(app, owner);
    const ok = await approve({ cookie, origin: 'http://localhost', 'sec-fetch-site': 'same-origin' });
    expect(ok.status).toBe(200);
    expect(getFbContent(id)?.status).toBe('scheduled');
  });

  it('refuses the owner cookie on cross-site requests, and any cross-site state change', async () => {
    const { app, owner } = await boot({ modules: ['marketing'] });
    makePage('p1');
    const id = seedContent({ status: 'review' });
    const cookie = await pair(app, owner);
    const post = (headers: Record<string, string>) =>
      app.request(`/api/m/marketing/content/${id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, ...headers }, body: '{}' });
    expect((await post({ origin: 'http://evil.example' })).status).toBe(403);
    expect((await post({ origin: 'http://localhost:3000' })).status).toBe(403); // another localhost port is same-site, not same-origin
    expect((await post({ 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await post({ origin: 'null' })).status).toBe(403);
    expect(getFbContent(id)?.status).toBe('review');
    // a non-owner route still refuses a cross-site write
    const task = await app.request('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: JSON.stringify({ prompt: 'x' }) });
    expect(task.status).toBe(403);
  });

  it('AIOS_TOKEN bearer counts as owner and the token gate works as before', async () => {
    const { app, owner } = await boot({ token: 'owner-token-123', modules: ['marketing'] });
    makePage('p1');
    const id = seedContent({ status: 'review' });
    expect((await app.request('/api/health')).status).toBe(401);
    const res = await app.request(`/api/m/marketing/content/${id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer owner-token-123' }, body: '{}' });
    expect(res.status).toBe(200);
    expect(getFbContent(id)?.status).toBe('approved');
    // pairing stays reachable without the token; a paired session passes the token gate for reads
    const cookie = await pair(app, owner);
    expect((await app.request('/api/health', { headers: { cookie } })).status).toBe(200);
    // the cloud sign-in callback is a browser redirect: no token, no cookie; its OAuth state is what guards it
    const callback = await app.request('/api/cloud/callback?code=x&state=not-a-pending-state');
    expect(callback.status).toBe(400);
    expect(await callback.text()).not.toContain('AIOS_TOKEN');

  });

  it('the MCP bridge keeps working with its run token and is never the owner', async () => {
    const { app, deps } = await boot({ modules: [] });
    const run = integrationServiceFor(deps as AppDeps).createRunToken('agent-x', 3);
    const call = await app.request('/api/integrations/call', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${run}` }, body: JSON.stringify({ integration: 'pancake', command: 'orders list' }) });
    expect(call.status).toBe(200);
    expect(await call.json()).toMatchObject({ ok: false }); // not connected in this harness, but authorised and answered
    const tools = await app.request('/api/integrations/tools', { headers: { authorization: `Bearer ${run}` } });
    expect(tools.status).toBe(200);
    // starting a cloud sign-in, installing or uninstalling a pack, or a learn sync needs the owner
    for (const p of ['/api/cloud/login/start', '/api/packs/demo/install', '/api/packs/demo/uninstall', '/api/m/learn/sync']) {
      const r = await app.request(p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${run}` }, body: '{}' });
      expect(r.status, p).toBe(401);
      expect(r.headers.get(OWNER_HEADER), p).toBe('required');
    }
    // the same run token on an owner route is refused
    const grant = await app.request('/api/agents/main/integrations', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${run}` }, body: JSON.stringify({ grants: { pancake: 'write' } }) });
    expect(grant.status).toBe(401);
  });
});

describe('pairing and sessions', () => {
  it('a code is single use, wrong guesses burn it, and only the token hash is stored', async () => {
    const { app, owner, deps } = await boot({ modules: [] });
    const code = owner.issueCode();
    expect(redactString(`code ${code}`)).not.toContain(code);
    const token = owner.redeem(code.toLowerCase())!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(owner.redeem(code)).toBeUndefined();
    const rows = deps.db.prepare('SELECT * FROM owner_sessions').all();
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(redactString(`cookie ${token}`)).not.toContain(token);

    const next = owner.issueCode();
    for (let i = 0; i < 5; i++) expect(owner.redeem('AAAA-AAAA-AAAA')).toBeUndefined();
    expect(owner.redeem(next)).toBeUndefined();

    const res = await app.request('/api/owner/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'ZZZZ-ZZZZ-ZZZZ' }) });
    expect(res.status).toBe(401);
  });

  it('the terminal link sets an HttpOnly SameSite=Strict cookie; a link from another site is refused', async () => {
    const { app, owner, printed } = await boot({ modules: [] });
    owner.announce('http://127.0.0.1:4380');
    const text = printed.join('');
    expect(text).toContain('http://127.0.0.1:4380/api/owner/pair?code=');
    const code = codeIn(text);

    const cross = await app.request(`/api/owner/pair?code=${code}`, { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(cross.status).toBe(302);
    expect(cross.headers.get('set-cookie')).toBeNull();

    const res = await app.request(`/api/owner/pair?code=${code}`, { headers: { 'sec-fetch-site': 'none' } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^aios_owner=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    const session = cookie.split(';')[0]!;
    expect(await (await app.request('/api/owner/status', { headers: { cookie: session } })).json()).toMatchObject({ owner: true });
    expect(await (await app.request('/api/owner/status')).json()).toMatchObject({ owner: false });

    await app.request('/api/owner/logout', { method: 'POST', headers: { cookie: session } });
    expect(await (await app.request('/api/owner/status', { headers: { cookie: session } })).json()).toMatchObject({ owner: false });
  });

  it('asking for a new code prints it on the terminal and never returns it', async () => {
    const { app, printed } = await boot({ modules: [] });
    const res = await app.request('/api/owner/pair/request', { method: 'POST' });
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, printed: true });
    const code = codeIn(printed.join(''));
    expect(JSON.stringify(body)).not.toContain(code);
    expect(await (await app.request('/api/owner/pair/request', { method: 'POST' })).json()).toMatchObject({ printed: false });
    // pair-link (another device) is for the owner only
    expect((await app.request('/api/owner/pair-link', { method: 'POST' })).status).toBe(401);
  });
});
