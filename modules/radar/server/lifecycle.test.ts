import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createModuleManager } from '../../../src/modules/manager.js';
import type { ModuleManager } from '../../../src/modules/contracts.js';
import { createTestHarness, type TestHarness } from '../../../src/modules/test-deps.js';
import { getIntegration } from '../../../src/integrations/registry.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('radar module lifecycle', () => {
  let h: TestHarness;
  let mgr: ModuleManager;
  let modulesDir: string;

  beforeEach(() => {
    modulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-mods-'));
    // Discovery skips symlinks: mirror the manifest, migrations, agents and skills; the importer loads the real server entry.
    const mirror = path.join(modulesDir, 'radar');
    fs.mkdirSync(path.join(mirror, 'server'), { recursive: true });
    for (const name of ['module.json', 'migrations', 'agents', 'skills']) if (fs.existsSync(path.join(DIR, name))) fs.cpSync(path.join(DIR, name), path.join(mirror, name), { recursive: true });
    fs.writeFileSync(path.join(mirror, 'server', 'index.ts'), 'export default {};\n');
    h = createTestHarness({ modulesDir });
    mgr = createModuleManager(h.deps, { fromDist: false, importer: async () => import('./index.js') });
    (h.deps as { modules: ModuleManager }).modules = mgr;
  });
  afterEach(async () => {
    await mgr.stop();
    h.cleanup();
    fs.rmSync(modulesDir, { recursive: true, force: true });
  });

  const tableExists = (t: string) => !!h.deps.db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(t);

  it('Add creates every declared table, registers integrations and serves routes; Remove stops them but keeps data', async () => {
    expect(getIntegration('apify')).toBeUndefined();
    const res = await mgr.add('radar', { installAgents: true });
    expect(res.migrationsApplied).toEqual(['001_init']);
    expect(res.agentsInstalled).toEqual(['radar-analyst']);
    for (const t of mgr.get('radar')!.manifest.tables) expect(tableExists(t), t).toBe(true);
    expect(getIntegration('apify')).toBeDefined();
    expect(getIntegration('rsshub')).toBeDefined();
    expect(mgr.get('radar')!.manifest.category).toBe('marketing');

    const app = new Hono();
    mgr.mount(app);
    const latest = await app.request('/api/m/radar/latest');
    expect(latest.status).toBe(200);
    expect((await latest.json() as { latest: unknown }).latest).toBeNull();
    const cfg = await app.request('/api/m/radar/config');
    expect(cfg.status).toBe(200);
    expect((await cfg.json() as { config: { enabled: boolean } }).config.enabled).toBe(false); // off by default

    const on = await app.request('/api/m/radar/enabled', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
    expect(on.status).toBe(200);
    expect(mgr.get('radar')!.state.settings.enabled).toBe(true);

    await mgr.remove('radar');
    expect(mgr.isEnabled('radar')).toBe(false);
    expect((await app.request('/api/m/radar/latest')).status).toBe(404);
    expect(getIntegration('apify')).toBeUndefined();
    expect(tableExists('radar_kv')).toBe(true);

    await mgr.add('radar');
    expect(mgr.isEnabled('radar')).toBe(true);
  });

  it('Purge drops exactly the module tables', async () => {
    await mgr.add('radar');
    await mgr.remove('radar');
    await mgr.purge('radar', 'radar');
    for (const t of ['radar_runs', 'radar_items', 'radar_seen', 'radar_pains', 'radar_reports', 'radar_kv']) expect(tableExists(t), t).toBe(false);
  });
});
