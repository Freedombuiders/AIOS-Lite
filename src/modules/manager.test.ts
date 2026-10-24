import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Task } from '../core/types.js';
import { createModuleManager } from './manager.js';
import { createTestHarness, type TestHarness } from './test-deps.js';
import type { ModuleManager } from './contracts.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__tests__', 'modules');
type Fx = { started: number; stopped: number; ticks: number; finished: number[]; failStart?: boolean };
const g = globalThis as unknown as { __fx?: Fx };
const fx = (): Fx => (g.__fx ??= { started: 0, stopped: 0, ticks: 0, finished: [] });

let h: TestHarness;
let mgr: ModuleManager;
const tableExists = (t: string) => !!h.deps.db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t);

beforeEach(() => {
  h = createTestHarness({ modulesDir: FIXTURES });
  mgr = createModuleManager(h.deps, { fromDist: false });
  (h.deps as { modules: ModuleManager }).modules = mgr;
  Object.assign(fx(), { started: 0, stopped: 0, ticks: 0, finished: [], failStart: false });
});
afterEach(async () => {
  await mgr.stop();
  h.cleanup();
});

describe('discovery', () => {
  it('lists fixture modules, skips _ folders and reports capabilities', () => {
    const ids = mgr.list().map((m) => m.manifest.id);
    expect(ids).toEqual(['bad', 'fx', 'needs']);
    const info = mgr.get('fx')!;
    expect(info.hasServer).toBe(true);
    expect(info.hasWeb).toBe(false);
    expect(info.agentTemplates).toEqual(['fx-helper']);
    expect(info.state.enabled).toBe(false);
  });
});

describe('add / remove / purge', () => {
  it('runs the full lifecycle', async () => {
    const events: string[] = [];
    h.deps.bus.on('module', (e) => events.push(`${e.module.id}:${e.module.enabled}`));
    const res = await mgr.add('fx', { installAgents: true });
    expect(res.migrationsApplied).toEqual(['001_init']);
    expect(res.agentsInstalled).toEqual(['fx-helper']);
    expect(tableExists('fx_items')).toBe(true);
    expect(mgr.isEnabled('fx')).toBe(true);
    expect(res.module.state.installedAt).toBeTruthy();
    expect(fx().started).toBe(1);
    expect(h.fakes.skillRoots[0]?.source).toBe('module:fx');
    expect(h.deps.hooks.moduleContext.has('fx')).toBe(true);
    expect(mgr.provides<{ hello(): string }>('fx')?.hello()).toBe('hi');
    expect(events).toContain('fx:true');

    // idempotent
    const again = await mgr.add('fx');
    expect(again.migrationsApplied).toEqual([]);
    expect(fx().started).toBe(1);

    await new Promise((r) => setTimeout(r, 50));
    expect(fx().ticks).toBeGreaterThan(0);

    await mgr.remove('fx');
    const ticks = fx().ticks;
    await new Promise((r) => setTimeout(r, 40));
    expect(fx().ticks).toBe(ticks); // timers stopped
    expect(fx().stopped).toBe(1);
    expect(mgr.isEnabled('fx')).toBe(false);
    expect(h.fakes.skillRoots).toHaveLength(0);
    expect(h.deps.hooks.moduleContext.has('fx')).toBe(false);
    expect(h.deps.hooks.taskFinished.size).toBe(0);
    expect(mgr.provides('fx')).toBeUndefined();
    expect(tableExists('fx_items')).toBe(true); // data kept

    fs.mkdirSync(path.join(h.deps.config.dataDir, 'modules', 'fx'), { recursive: true });
    await expect(mgr.purge('fx', 'nope')).rejects.toMatchObject({ code: 'bad_request' });
    await mgr.purge('fx', 'fx');
    expect(tableExists('fx_items')).toBe(false);
    expect(tableExists('fx_search')).toBe(false);
    expect(fs.existsSync(path.join(h.deps.config.dataDir, 'modules', 'fx'))).toBe(false);
    expect(h.deps.db.prepare("SELECT COUNT(*) c FROM schema_migrations WHERE owner = 'fx'").get()).toEqual({ c: 0 });
    expect(h.deps.db.prepare("SELECT COUNT(*) c FROM modules WHERE id = 'fx'").get()).toEqual({ c: 0 });

    // can be added again after purge
    await mgr.add('fx');
    expect(tableExists('fx_items')).toBe(true);
  });

  it('refuses to purge an enabled module', async () => {
    await mgr.add('fx');
    await expect(mgr.purge('fx', 'fx')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('skips agent templates that already exist', async () => {
    h.fakes.agents.set('fx-helper', { ...h.fakes.agents.get('main')!, id: 'fx-helper' });
    const res = await mgr.add('fx', { installAgents: true });
    expect(res.agentsInstalled).toEqual([]);
  });

  it('refuses migrations that create undeclared tables', async () => {
    await expect(mgr.add('bad')).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('bad_extra') });
    expect(tableExists('bad_ok')).toBe(false);
    expect(mgr.isEnabled('bad')).toBe(false);
  });

  it('lists missing requirements with 412 semantics', async () => {
    const err = await mgr.add('needs').catch((e) => e);
    expect(err.code).toBe('requirements_missing');
    expect(err.message).toContain('fx');
    expect(err.message).toContain('composio');
    h.fakes.connections.set('composio', { id: 'composio', type: 'composio', apiKeyEnv: 'K' });
    await mgr.add('fx');
    await mgr.add('needs');
    await expect(mgr.remove('fx')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('stores start() errors without crashing', async () => {
    fx().failStart = true;
    const res = await mgr.add('fx');
    expect(res.module.error).toBe('boom');
    expect(mgr.isEnabled('fx')).toBe(true);
  });

  it('unknown module is not_found', async () => {
    await expect(mgr.add('zzz')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('hooks', () => {
  it('routes taskFinished only for the module own tasks and provides context', async () => {
    await mgr.add('fx');
    const mk = (source: string) => ({ id: source === 'module:fx' ? 11 : 12, source }) as Task;
    for (const hook of h.deps.hooks.taskFinished) {
      await hook(mk('module:fx'), null);
      await hook(mk('user'), null);
      await hook(mk('module:other'), null);
    }
    expect(fx().finished).toEqual([11]);
    expect(await h.deps.hooks.moduleContext.get('fx')!({} as Task)).toBe('ctx-fx');
  });

  it('boot start() starts enabled modules and stop() stops them', async () => {
    await mgr.add('fx');
    await mgr.stop();
    expect(fx().stopped).toBe(1);
    const mgr2 = createModuleManager(h.deps, { fromDist: false });
    await mgr2.start();
    expect(fx().started).toBe(2);
    await mgr2.stop();
  });
});

describe('routes gating', () => {
  const makeApp = () => {
    const app = new Hono();
    mgr.mount(app);
    return app;
  };

  it('404s until the module is added, then serves, then 404s again', async () => {
    const app = makeApp();
    let res = await app.request('/api/m/fx/ping');
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
    await mgr.add('fx');
    res = await app.request('/api/m/fx/ping');
    expect(await res.json()).toEqual({ pong: true, id: 'fx' });
    res = await app.request('/api/m/fx/echo', { method: 'POST', body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' } });
    expect(await res.json()).toEqual({ body: { a: 1 } });
    await mgr.remove('fx');
    expect((await app.request('/api/m/fx/ping')).status).toBe(404);
    expect((await app.request('/api/m/unknown/x')).status).toBe(404);
  });
});

describe('settings', () => {
  it('merges defaults, masks and encrypts secrets, validates types', async () => {
    expect(mgr.settings('fx')).toMatchObject({ greeting: 'xin chào', limit: 5 });
    const out = mgr.updateSettings('fx', { token: 'abc123', limit: '9' });
    expect(out.token).toBe('********');
    expect(out.limit).toBe(9);
    const stored = (h.deps.db.prepare("SELECT settings FROM modules WHERE id='fx'").get() as { settings: string }).settings;
    expect(stored).not.toContain('abc123');
    // masked value written back keeps the secret
    mgr.updateSettings('fx', { token: '********' });
    await mgr.add('fx');
    expect(() => mgr.updateSettings('fx', { limit: 'abc' })).toThrow();
    expect(() => mgr.updateSettings('fx', { nope: 1 })).toThrow();
    expect(mgr.get('fx')!.state.settings.token).toBe('********');
  });
});
