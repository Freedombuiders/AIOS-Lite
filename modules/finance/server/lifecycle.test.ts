import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createModuleManager } from '../../../src/modules/manager.js';
import type { ModuleManager } from '../../../src/modules/contracts.js';
import { createTestHarness, type TestHarness } from '../../../src/modules/test-deps.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('finance module lifecycle', () => {
  let h: TestHarness;
  let mgr: ModuleManager;
  let modulesDir: string;

  beforeEach(() => {
    modulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-mods-'));
    // Discovery skips symlinks: mirror the manifest, migrations, agents and skills; the importer loads the real server entry.
    const mirror = path.join(modulesDir, 'finance');
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

  it('Add creates every declared table and serves routes; Remove stops them but keeps the data', async () => {
    const res = await mgr.add('finance', { installAgents: true });
    expect(res.migrationsApplied).toEqual(['001_init']);
    for (const t of mgr.get('finance')!.manifest.tables) expect(tableExists(t), t).toBe(true);
    expect(mgr.get('finance')!.manifest.category).toBe('finance');

    const app = new Hono();
    mgr.mount(app);
    const post = await app.request('/api/m/finance/profit/entries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'revenue', amount: 100000, note: 'Thử' }) });
    expect(post.status).toBe(201);
    expect((await app.request('/api/m/finance/summary')).status).toBe(200);

    await mgr.remove('finance');
    expect(mgr.isEnabled('finance')).toBe(false);
    expect((await app.request('/api/m/finance/summary')).status).toBe(404);
    expect(tableExists('finance_kv')).toBe(true);
    expect((h.deps.db.prepare('SELECT COUNT(*) AS n FROM finance_kv').get() as { n: number }).n).toBeGreaterThan(0);

    await mgr.add('finance');
    expect(mgr.isEnabled('finance')).toBe(true);
  });

  it('Purge drops exactly the module tables', async () => {
    await mgr.add('finance');
    await mgr.remove('finance');
    await mgr.purge('finance', 'finance');
    for (const t of ['erp_snapshots', 'erp_daily', 'erp_period_totals', 'pnl_whop_daily', 'finance_kv']) expect(tableExists(t), t).toBe(false);
  });
});
