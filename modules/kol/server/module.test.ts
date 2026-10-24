// Add / Remove through the real module manager: migration, routes behind /api/m/kol, integrations, actions.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createApiServer } from '../../../src/api/server.js';
import { getIntegration } from '../../../src/integrations/registry.js';
import { createModuleManager } from '../../../src/modules/manager.js';
import { createTestHarness, type TestHarness } from '../../../src/modules/test-deps.js';
import { argvFor } from './actions.js';

const MODULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TABLES = [
  'kol_settings', 'kol_personas', 'kol_refs', 'kol_library', 'kol_templates', 'kol_generations', 'kol_assets', 'kol_spend', 'kol_accounts',
  'kol_posts', 'kol_post_targets', 'kol_metrics', 'kol_account_daily', 'kol_insights', 'kol_library_previews', 'kol_persona_previews', 'kol_persona_preview_misses',
];

let h: TestHarness | undefined;
afterEach(() => h?.cleanup());

async function boot() {
  h = createTestHarness({ modulesDir: MODULES_DIR });
  h.fakes.connections.set('composio', { id: 'composio', type: 'composio' } as never);
  const mgr = createModuleManager(h.deps, { fromDist: false });
  (h.deps as { modules: unknown }).modules = mgr;
  return { mgr, app: createApiServer(h.deps).app };
}

const tableExists = (name: string) => !!h!.deps.db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(name);
const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

describe('kol module with the manager', () => {
  it('Add migrates, serves the routes under /api/m/kol and brings fal + Higgsfield; Remove stops; Purge drops the tables', async () => {
    const { mgr, app } = await boot();
    const add = await mgr.add('kol', { installAgents: true });
    expect(add.module.error).toBeUndefined();
    expect(add.migrationsApplied).toEqual(['001_init']);
    expect(add.agentsInstalled).toEqual(['kol-writer']);
    for (const t of TABLES) expect(tableExists(t)).toBe(true);
    expect(getIntegration('fal')?.category).toBe('AI tạo ảnh & video');
    expect(getIntegration('higgsfield')).toBeTruthy();

    const status = await app.request('/api/m/kol/status');
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ killSwitches: { generate: true, publish: true } });

    const created = await app.request('/api/m/kol/personas', json({ name: 'Mia' }));
    expect(created.status).toBeLessThan(300);
    const list = await (await app.request('/api/m/kol/personas')).json();
    expect(list.personas.map((p: { name: string }) => p.name)).toEqual(['Mia']);

    await mgr.remove('kol');
    expect((await app.request('/api/m/kol/status')).status).toBe(404);
    expect(getIntegration('fal')).toBeUndefined();
    expect(tableExists('kol_personas')).toBe(true);
    await mgr.purge('kol', 'kol');
    for (const t of TABLES) expect(tableExists(t)).toBe(false);
    await mgr.stop();
  });

  it('registers the agent actions; they go through the command engine and never publish', async () => {
    const { mgr } = await boot();
    await mgr.add('kol', { installAgents: false });
    const reg = h!.deps.hooks.moduleActions!;
    expect([...reg.keys()].sort()).toEqual(['kol:content.add', 'kol:content.update', 'kol:generation.request', 'kol:read']);
    expect(reg.get('kol:read')!.scope).toBe('kol.read');
    expect(reg.get('kol:content.add')!.scope).toBe('content.write');
    expect(reg.get('kol:generation.request')!.scope).toBe('media.generate');
    const call = { agentId: 'kol-writer', taskId: 1, runId: null };
    expect(await reg.get('kol:read')!.run({ command: 'personas' }, call)).toEqual([]);
    expect(() => reg.get('kol:read')!.run({ command: 'post-add' }, call)).toThrow(/không hợp lệ/);
    expect(() => reg.get('kol:read')!.run('x', call)).toThrow(/đối tượng/);
    await mgr.stop();
  });
});

describe('videoHost provides', () => {
  it('exposes the services the Video module needs, with mounted media urls and full persona fields', async () => {
    const { mgr, app } = await boot();
    await mgr.add('kol', { installAgents: false });
    await app.request('/api/m/kol/personas', json({ name: 'Mia' }));
    const host = (mgr.provides('kol') as { videoHost: Record<string, (...a: any[]) => any> }).videoHost;
    for (const k of ['listPersonaSummaries', 'getPersona', 'listAssets', 'getAsset', 'getAssetFile', 'importAssetFromUpload', 'createPost', 'loadSettings',
      'voiceConfigured', 'unitPriceUsd', 'findModel', 'isProviderConfigured', 'getAdapter', 'requestGeneration', 'getGeneration', 'downloadOutput', 'admission', 'recordSpend']) {
      expect(typeof host[k]).toBe('function');
    }
    const [p] = host.listPersonaSummaries();
    expect(p).toMatchObject({ name: 'Mia', identitySource: 'synthetic', voiceId: '' });
    expect(p).toHaveProperty('personality');
    expect(host.findModel('no-such-model')).toBeUndefined();
    expect(host.listAssets({ personaId: p.id, kind: 'video' })).toEqual({ assets: [] });
    await mgr.stop();
  });
});

describe('action payloads', () => {
  it('maps content.add to command-line flags', () => {
    expect(argvFor('content.add', { persona: '@mia', title: 'Ngày mới', format: 'photo', hashtags: ['a', 'b'], draft: true })).toEqual(
      ['post-add', '--persona', '@mia', '--title', 'Ngày mới', '--format', 'photo', '--hashtag', 'a', '--hashtag', 'b', '--draft'],
    );
    expect(argvFor('content.update', { id: 'p1', caption: 'x' })).toEqual(['post-update', 'p1', '--caption', 'x']);
    expect(argvFor('generation.request', { persona: '@mia', outfit: 'o1', count: 2, audio: false })).toEqual(
      ['generate', '--persona', '@mia', '--outfit', 'o1', '--count', '2', '--audio', 'false'],
    );
    expect(() => argvFor('content.add', { title: 'x' })).toThrow(/persona/);
    expect(() => argvFor('content.update', { caption: 'x' })).toThrow(/id/);
    expect(() => argvFor('content.add', { persona: 'a', hashtags: 'x' })).toThrow(/danh sách/);
  });
});
