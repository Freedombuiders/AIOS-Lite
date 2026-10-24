import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../agents/registry.js';
import { loadConfig } from '../core/config.js';
import { migrateCore, openDb } from '../core/db.js';
import type { AppDeps } from '../core/deps.js';
import { createLogger } from '../core/log.js';
import { errorBody, handleError } from './errors.js';
import { teamsRoutes } from './routes/teams.js';

const REPO = path.resolve(__dirname, '..', '..');
let root: string;
let app: Hono;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-api-teams-'));
  fs.mkdirSync(path.join(root, 'agents'));
  fs.cpSync(path.join(REPO, 'teams'), path.join(root, 'teams'), { recursive: true });
  const db = openDb(':memory:');
  migrateCore(db);
  const config = { ...loadConfig({ rootDir: root, loadDotEnv: false, env: {} }), skillsDirs: [path.join(root, 'skills')] };
  const agents = createAgentRegistry({ agentsDir: path.join(root, 'agents'), workspacesDir: path.join(root, 'ws') });
  agents.create('main', { name: 'Trợ lý chính', runtime: 'mock' });
  const schedules: unknown[] = [];
  const tasks: unknown[] = [];
  const deps = {
    config, db, agents,
    scheduler: { list: () => schedules, create: (i: { name: string }) => { const s = { id: schedules.length + 1, ...i }; schedules.push(s); return s; }, remove: () => undefined },
    skills: { list: () => [], get: () => undefined, reload() {} },
    brain: { folders: () => [] },
    modules: { discover: () => [], add: async () => { throw new Error('n/a'); } },
    runs: { monthCost: () => 0 },
    tasks: { list: () => [], create: (i: unknown) => { tasks.push(i); return { id: tasks.length }; } },
    audit: undefined,
  } as unknown as AppDeps;
  app = new Hono();
  app.onError(handleError(createLogger({ level: 'silent' })));
  app.notFound((c) => c.json(errorBody('not_found', 'x'), 404));
  teamsRoutes(app, deps);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const post = (p: string, b: unknown) => app.request(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

describe('teams api', () => {
  it('lists, previews and installs a catalog package', async () => {
    const list = await (await app.request('/api/teams')).json();
    expect(list.items.map((t: { slug: string }) => t.slug)).toContain('fb-content-studio');
    const src = { kind: 'catalog', id: 'fb-content-studio' };
    const bad = await post('/api/teams/install', { source: src });
    expect(bad.status).toBe(400);
    const prev = await (await post('/api/teams/preview', { source: src, inputs: { BRAND_NAME: 'Rocket' }, defaultRuntime: 'mock' })).json();
    expect(prev.canInstall).toBe(true);
    const ok = await post('/api/teams/install', { source: src, inputs: { BRAND_NAME: 'Rocket' }, defaultRuntime: 'mock' });
    expect(ok.status).toBe(201);
    expect((await ok.json()).agents).toHaveLength(2);
  });

  it('exports then imports a zip over base64', async () => {
    await post('/api/teams/install', { source: { kind: 'catalog', id: 'fb-content-studio' }, inputs: { BRAND_NAME: 'Rocket' }, defaultRuntime: 'mock' });
    const ex = await (await post('/api/teams/export', { name: 'Bản sao', agentIds: ['fb-content-lead'] })).json();
    expect(ex.filename).toBe('ban-sao.zip');
    const imp = await post('/api/teams/import', { base64: ex.base64 });
    expect(imp.status).toBe(201);
    expect((await app.request('/api/teams')).status).toBe(200);
    expect((await post('/api/teams/import', { base64: Buffer.from('not a zip').toString('base64') })).status).toBe(400);
  });

  it('agent market and recos respond', async () => {
    const m = await (await app.request('/api/agent-market')).json();
    expect(m.templates.length).toBeGreaterThan(3);
    const r = await post('/api/agent-market/research-analyst/install', { runtime: 'mock', fields: { business: 'x' } });
    expect(r.status).toBe(201);
    expect((await post('/api/agent-market/nope/install', {})).status).toBe(404);
    const recos = await (await app.request('/api/recos')).json();
    expect(Array.isArray(recos.items)).toBe(true);
    expect((await post('/api/recos/apply-cart', {})).status).toBe(200);
  });
});
