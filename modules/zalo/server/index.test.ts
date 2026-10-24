// The zalo module through the real module manager: Add runs the migration and starts the REAL daemon child
// (daemon.ts via tsx, file database, no Zalo network without a nick), Remove stops it; care registration is
// exercised against an in-test fake `care` module. No call to Zalo is made.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDb, migrateCore } from '../../../src/core/db.js';
import { createModuleManager } from '../../../src/modules/manager.js';
import type { ModuleManager } from '../../../src/modules/contracts.js';
import { createTestHarness, type TestHarness } from '../../../src/modules/test-deps.js';
import { defineModule, type ModuleDefinition } from '../../../src/modules/sdk.js';
import { isProcessAlive } from './compat.js';
import { callZaloDaemon } from './control.js';

const ZALO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

describe('zalo module lifecycle', () => {
  let h: TestHarness;
  let mgr: ModuleManager;
  let modulesDir: string;
  let careCalls: { registered: string[]; unregistered: string[]; ensured: string[] };

  beforeEach(async () => {
    modulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zalo-mods-'));
    // Discovery skips symlinks: mirror the module's manifest, migrations, agents and skills; the server entry is a stub the importer below redirects to the real one.
    const mirror = path.join(modulesDir, 'zalo');
    fs.mkdirSync(path.join(mirror, 'server'), { recursive: true });
    for (const name of ['module.json', 'migrations', 'agents', 'skills']) fs.cpSync(path.join(ZALO_DIR, name), path.join(mirror, name), { recursive: true });
    fs.writeFileSync(path.join(mirror, 'server', 'index.ts'), 'export default {};\n');
    fs.mkdirSync(path.join(modulesDir, 'care', 'server'), { recursive: true });
    fs.writeFileSync(path.join(modulesDir, 'care', 'module.json'), JSON.stringify({ id: 'care', name: 'Care', description: 'fake', version: '1.0.0', category: 'sales', tables: [] }));
    fs.writeFileSync(path.join(modulesDir, 'care', 'server', 'index.ts'), 'export default {};\n');

    const port = await freePort();
    h = createTestHarness({ modulesDir });
    // the daemon child opens the same SQLite file: use a file database instead of :memory:
    const file = openDb(path.join(h.root, 'aios.db'));
    migrateCore(file);
    (h.deps as { db: typeof file }).db = file;
    careCalls = { registered: [], unregistered: [], ensured: [] };
    const fakeCare: ModuleDefinition = defineModule({
      provides: () => ({
        careChannels: {
          register: (c: { kind: string }) => { careCalls.registered.push(c.kind); },
          unregister: (id: string) => { careCalls.unregistered.push(id); },
          ensureAccount: (a: { id: string }) => { careCalls.ensured.push(a.id); return { id: a.id, epoch: 3 }; },
          getActiveEpoch: () => 3,
        },
      }),
    });
    const importer = async (f: string): Promise<unknown> => (f.includes(`${path.sep}care${path.sep}`) ? { default: fakeCare } : import('./index.js'));
    mgr = createModuleManager(h.deps, { fromDist: false, importer });
    (h.deps as { modules: ModuleManager }).modules = mgr;
    mgr.updateSettings('zalo', { controlPort: port });
  });

  afterEach(async () => {
    await mgr.stop();
    h.cleanup();
    fs.rmSync(modulesDir, { recursive: true, force: true });
  });

  it('Add creates every declared table and starts the daemon; Remove stops it and keeps the data', async () => {
    const res = await mgr.add('zalo', { installAgents: true });
    expect(res.migrationsApplied).toEqual(['001_init']);
    expect(res.agentsInstalled).toEqual(['zalo-care']);
    const info = mgr.get('zalo')!;
    for (const t of info.manifest.tables) {
      expect(h.deps.db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(t), t).toBeTruthy();
    }
    expect(info.manifest.license).toBe('AGPL-3.0-only');

    const app = new Hono();
    mgr.mount(app);
    const status = async () => (await (await app.request('/api/m/zalo/status')).json()) as { daemon: { running: boolean; pid: number | null } };
    expect(await until(async () => (await status()).daemon.running)).toBe(true);
    const pid = (await status()).daemon.pid!;
    expect(isProcessAlive(pid)).toBe(true);

    // the real daemon answers over the token-protected control channel and sees the shared database
    expect(await until(async () => { try { return (await callZaloDaemon('GET', '/status', { timeoutMs: 1_000 })).status === 200; } catch { return false; } })).toBe(true);
    const created = (await (await app.request('/api/m/zalo/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Nick thử' }) })).json()) as { account: { id: string } };
    const list = (await (await app.request('/api/m/zalo/accounts')).json()) as { accounts: Array<{ id: string }>; daemonReachable: boolean };
    expect(list.accounts.map((a) => a.id)).toEqual([created.account.id]);
    expect(list.daemonReachable).toBe(true);
    const daemonView = await callZaloDaemon<{ accounts: Record<string, unknown> }>('GET', '/status');
    expect(Object.keys(daemonView.data.accounts)).toEqual([created.account.id]);

    await mgr.remove('zalo');
    expect(await until(() => !isProcessAlive(pid))).toBe(true);
    expect((await app.request('/api/m/zalo/status')).status).toBe(404);
    // data survives Remove
    expect(h.deps.db.prepare('SELECT COUNT(*) AS n FROM zalo_accounts').get()).toEqual({ n: 1 });
    await expect(callZaloDaemon('GET', '/status')).rejects.toThrow();
  }, 60_000);

  it('registers the zalo channel with care when care is enabled, unregisters on Remove, and links the daemon', async () => {
    await mgr.add('care');
    await mgr.add('zalo');
    expect(careCalls.registered).toEqual(['zalo-zca']);
    h.deps.db.prepare("INSERT INTO zalo_accounts (id,label,zalo_uid,created_at,updated_at) VALUES ('n1','Nick',NULL,1,1)").run();
    // the 5 s tick announces new nicks to care and tells the daemon care is linked: its care routes answer 404 "not linked" until then
    const careRoute = async () => { try { return (await callZaloDaemon('GET', '/care/accounts/none/status', { timeoutMs: 1_000 })).status; } catch { return 0; } };
    expect(await until(async () => (await careRoute()) !== 404 && (await careRoute()) !== 0, 30_000)).toBe(true);
    expect(await until(() => careCalls.ensured.includes('n1'), 15_000)).toBe(true);
    await mgr.remove('zalo');
    expect(careCalls.unregistered).toEqual(['zalo-zca']);
  }, 60_000);

  it('does not register with care when care is not enabled, and exposes its accounts and daemon state', async () => {
    await mgr.add('zalo');
    expect(careCalls.registered).toEqual([]);
    const api = mgr.provides<{ accounts(): unknown[]; daemon(): { pid: number | null } }>('zalo')!;
    expect(api.accounts()).toEqual([]);
    expect(await until(() => api.daemon().pid !== null)).toBe(true);
    await mgr.remove('zalo');
  }, 60_000);
});
