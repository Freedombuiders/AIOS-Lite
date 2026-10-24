import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createModuleManager } from '../../../src/modules/manager.js';
import { createTestHarness, type TestHarness } from '../../../src/modules/test-deps.js';
import type { ModuleManager } from '../../../src/modules/contracts.js';

const MODULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let h: TestHarness;
let mgr: ModuleManager;
const tableExists = (t: string) => !!h.deps.db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(t);

beforeEach(() => {
  h = createTestHarness({ modulesDir: MODULES_DIR });
  mgr = createModuleManager(h.deps, { fromDist: false });
  (h.deps as { modules: ModuleManager }).modules = mgr;
});
afterEach(async () => {
  await mgr.stop();
  h.cleanup();
});

describe('care module Add / Remove / Purge', () => {
  it('is discovered with its manifest, scopes, template and skill', () => {
    const info = mgr.get('care')!;
    expect(info.manifest.category).toBe('sales');
    expect(Object.keys(info.manifest.scopes ?? {})).toEqual(['inbox.read', 'customers.read', 'customers.write', 'reply.draft', 'reply.send']);
    expect(info.agentTemplates).toEqual(['cskh']);
    expect(info.hasServer).toBe(true);
    expect(info.hasWeb).toBe(true);
  });

  it('Add creates exactly the declared tables, copies cskh, serves routes and provides careChannels', async () => {
    const res = await mgr.add('care', { installAgents: true });
    expect(res.migrationsApplied).toEqual(['001_init']);
    expect(res.agentsInstalled).toEqual(['cskh']);
    for (const t of mgr.get('care')!.manifest.tables) expect(tableExists(t), t).toBe(true);
    expect(h.fakes.skillRoots.some((r) => r.source === 'module:care')).toBe(true);
    const careTables = (h.deps.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'care\\_%' ESCAPE '\\'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(careTables.sort()).toEqual([...mgr.get('care')!.manifest.tables].sort());

    const app = new Hono();
    mgr.mount(app);
    const status = await app.request('/api/m/care/status');
    expect(status.status).toBe(200);
    const channels = mgr.provides<{ careChannels: { register: unknown; unregister: unknown; ingest: unknown; ensureAccount: unknown } }>('care')!.careChannels;
    expect(typeof channels.register).toBe('function');
    expect(typeof channels.ingest).toBe('function');
  });

  it('Remove stops serving but keeps the data; Add again works; Purge drops the tables', async () => {
    await mgr.add('care');
    const app = new Hono();
    mgr.mount(app);
    const channels = mgr.provides<{ careChannels: { ensureAccount(i: unknown): { id: string; epoch: number } } }>('care')!.careChannels;
    const acct = channels.ensureAccount({ id: 'n1', channel: 'zalo', connectorKind: 'fake', label: 'Shop' });

    await mgr.remove('care');
    expect(mgr.isEnabled('care')).toBe(false);
    expect((await app.request('/api/m/care/status')).status).toBe(404);
    expect(mgr.provides('care')).toBeUndefined();
    expect(tableExists('care_accounts')).toBe(true);
    expect((h.deps.db.prepare('SELECT COUNT(*) AS n FROM care_accounts').get() as { n: number }).n).toBe(1);

    await mgr.add('care');
    const again = mgr.provides<{ careChannels: { ensureAccount(i: unknown): { id: string; epoch: number } } }>('care')!.careChannels;
    expect(again.ensureAccount({ id: 'n1', channel: 'zalo', connectorKind: 'fake', label: 'Shop' }).id).toBe(acct.id);

    await mgr.remove('care');
    await mgr.purge('care', 'care');
    expect(tableExists('care_accounts')).toBe(false);
    expect(tableExists('care_messages')).toBe(false);
  });

  it('ingest reports failed for an unknown account; getActiveEpoch throws; ensureAccount keeps the channel id', async () => {
    await mgr.add('care');
    const c = mgr.provides<{ careChannels: { ingest(e: unknown): Promise<{ outcome: string; error?: string }>; getActiveEpoch(id: string): number; ensureAccount(i: unknown): { id: string; epoch: number } } }>('care')!.careChannels;
    expect(await c.ingest({ type: 'account.status', eventId: 'e', accountId: 'nope', timestampMs: 1 })).toMatchObject({ outcome: 'failed' });
    expect(() => c.getActiveEpoch('nope')).toThrow();
    expect(c.ensureAccount({ id: 'gm-1', channel: 'email', connectorKind: 'gmail-composio', label: 'Hộp thư', address: 'a@b.c' })).toEqual({ id: 'gm-1', epoch: 1 });
    expect(c.getActiveEpoch('gm-1')).toBe(1);
  });
});
