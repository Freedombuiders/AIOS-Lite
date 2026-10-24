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

describe('video module lifecycle', () => {
  let h: TestHarness;
  let mgr: ModuleManager;
  let modulesDir: string;

  beforeEach(() => {
    modulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-mods-'));
    // Discovery skips symlinks: mirror the manifest, agents and skills; the importer loads the real server entry.
    const mirror = path.join(modulesDir, 'video');
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

  const json = async (app: Hono, url: string, init?: RequestInit) => {
    const res = await app.request(url, init);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('Add serves the studio routes under /api/m/video, registers HeyGen and the actions; Remove undoes them', async () => {
    const res = await mgr.add('video', { installAgents: true });
    expect(res.agentsInstalled).toEqual(['video-editor']);
    expect(mgr.get('video')!.manifest.category).toBe('studio');
    expect(getIntegration('heygen')?.name).toBe('HeyGen');
    const actions = [...(h.deps.hooks.moduleActions?.keys() ?? [])].filter((k) => k.startsWith('video:')).sort();
    expect(actions).toEqual(['video:create.call', 'video:job.cancel', 'video:job.create', 'video:job.status', 'video:produce.call']);

    const app = new Hono();
    mgr.mount(app);
    const health = await json(app, '/api/m/video/health');
    expect(health.status).toBe(200);
    expect(typeof health.body.ffmpeg).toBe('boolean');
    if (!health.body.ffmpeg) expect(health.body.hint).toContain('brew install ffmpeg');
    expect((await json(app, '/api/m/video/edit/styles')).body.styles.length).toBeGreaterThanOrEqual(21);

    // a project lives under the module data dir, not the shared database
    const profile = (await json(app, '/api/m/video/edit/profiles', post({ name: 'Kênh thử' }))).body.profile;
    const project = (await json(app, '/api/m/video/edit/projects', post({ profileId: profile.id, title: 'Video thử' }))).body.project;
    expect(fs.existsSync(path.join(h.deps.config.dataDir, 'modules', 'video', 'video-edit', 'projects', project.id))).toBe(true);

    // an agent can read the status through the action registry
    const status = await h.deps.hooks.moduleActions!.get('video:job.status')!.run({ projectId: project.id }, { agentId: 'main', taskId: 1, runId: null });
    expect(status).toMatchObject({ id: project.id, title: 'Video thử' });

    await mgr.remove('video');
    expect(mgr.isEnabled('video')).toBe(false);
    expect((await json(app, '/api/m/video/health')).status).toBe(404);
    expect(getIntegration('heygen')).toBeUndefined();
    expect([...(h.deps.hooks.moduleActions?.keys() ?? [])].filter((k) => k.startsWith('video:'))).toEqual([]);

    await mgr.add('video');
    expect(mgr.isEnabled('video')).toBe(true);
    const again = await json(app, '/api/m/video/edit/projects');
    expect(again.body.projects.map((p: { id: string }) => p.id)).toContain(project.id); // data kept
  });

  it('raises an attention item for a pending approval and clears it when decided', async () => {
    await mgr.add('video');
    const { createApproval, decideApproval, registerApprovalHandler } = await import('./approvals.js');
    registerApprovalHandler('video_generate', { actions: () => [{ id: 'reject', label: 'Không tạo', kind: 'reject' }], onDecision: async () => ({ status: 'rejected' }) });
    const { approval } = createApproval({ kind: 'video_generate', agentId: 'main', title: 'Tạo 2 cảnh', summary: '≈ $1', payload: { x: 1 } });
    expect(h.deps.attention.list().some((i) => i.key.endsWith(`video:approval:${approval.id}`))).toBe(true);
    await decideApproval(approval.id, 'reject', 'dashboard');
    expect(h.deps.attention.list().some((i) => i.key.endsWith(`video:approval:${approval.id}`))).toBe(false);
  });
});
