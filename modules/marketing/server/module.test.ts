// Add / Remove through the real module manager, plus the agent bridge and provides contract.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createApiServer } from '../../../src/api/server.js';
import { createModuleManager } from '../../../src/modules/manager.js';
import { createTestHarness, type TestHarness } from '../../../src/modules/test-deps.js';
import { makePage } from './core/test-fixtures.js';
import { isEnabled, isFbStudioEnabled } from './settings.js';
import { getPublisherState } from './core/publisher.js';

const MODULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let h: TestHarness | undefined;
afterEach(() => h?.cleanup());

async function boot() {
  h = createTestHarness({ modulesDir: MODULES_DIR });
  h.fakes.connections.set('composio', { id: 'composio', type: 'composio' } as never);
  const mgr = createModuleManager(h.deps, { fromDist: false });
  (h.deps as { modules: unknown }).modules = mgr;
  return { mgr, app: createApiServer(h.deps).app };
}

describe('marketing module with the manager', () => {
  it('adds, serves its routes, stays off until enabled, and removes cleanly', async () => {
    const { mgr, app } = await boot();
    const add = await mgr.add('marketing', { installAgents: true });
    expect(add.module.error).toBeUndefined();
    expect(add.migrationsApplied).toEqual(['001_init']);
    expect([...add.agentsInstalled].sort()).toEqual(['content-fb', 'fb-analyst']);
    for (const t of ['fb_pages', 'fb_content', 'fb_comments', 'fb_post_metrics']) {
      expect(h!.deps.db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(t)).toBeTruthy();
    }

    const settings = await app.request('/api/m/marketing/settings');
    expect(await settings.json()).toMatchObject({ enabled: false, apiBudgetPerHour: 600 });
    expect(isFbStudioEnabled()).toBe(false);
    expect(isEnabled('FB_PUBLISH_ENABLED')).toBe(true);

    const put = await app.request('/api/m/marketing/settings', { method: 'PUT', body: JSON.stringify({ enabled: true, apiBudgetPerHour: 90 }), headers: { 'content-type': 'application/json' } });
    expect(await put.json()).toMatchObject({ enabled: true, apiBudgetPerHour: 90 });
    expect(isFbStudioEnabled()).toBe(true);
    expect(mgr.settings('marketing')).toMatchObject({ enabled: true, api_budget_per_hour: 90 });

    expect(getPublisherState().running).toBe(true);
    await mgr.remove('marketing');
    expect(getPublisherState().running).toBe(false);
    expect((await app.request('/api/m/marketing/pages')).status).toBe(404);
    await mgr.purge('marketing', 'marketing');
    expect(h!.deps.db.prepare("SELECT name FROM sqlite_master WHERE name = 'fb_pages'").get()).toBeUndefined();
    await mgr.stop();
  });

  it('exposes topPosts and pageInfo to other modules', async () => {
    const { mgr } = await boot();
    await mgr.add('marketing', { installAgents: false });
    makePage('P1');
    const api = mgr.provides('marketing') as { topPosts(pageId?: string, days?: number): unknown[]; pageInfo(id: string): { id: string } | undefined };
    expect(api.pageInfo('P1')).toMatchObject({ id: 'P1' });
    expect(api.pageInfo('none')).toBeUndefined();
    expect(api.topPosts('P1', 28)).toEqual([]);
    await mgr.stop();
  });

  it('registers the content actions and they reach the command engine', async () => {
    const { mgr } = await boot();
    await mgr.add('marketing', { installAgents: false });
    makePage('P1', { approval_required: 1 });
    const reg = h!.deps.hooks.moduleActions!;
    expect([...reg.keys()].sort()).toEqual(['marketing:content.add', 'marketing:content.schedule', 'marketing:content.update']);
    const add = reg.get('marketing:content.add')!;
    expect(add.scope).toBe('content.write');
    const call = { agentId: 'content-fb', taskId: 1, runId: null };
    const res = (await add.run({ page: 'P1', format: 'text', title: 'Bài thử', caption: 'Xin chào', hooks: ['a', 'b', 'c'] }, call)) as { ok: boolean; content: { id: number; status: string; source: string } };
    expect(res.ok).toBe(true);
    expect(res.content).toMatchObject({ status: 'review', source: 'content-fb' });
    const upd = (await reg.get('marketing:content.update')!.run({ id: res.content.id, caption: 'Sửa' }, call)) as { ok: boolean };
    expect(upd.ok).toBe(true);
    expect(() => add.run({ page: 'P1', format: 'bogus', title: 't' }, call)).toThrow(/format/);
    expect(() => add.run('x', call)).toThrow(/đối tượng/);
    await mgr.stop();
  });
});
