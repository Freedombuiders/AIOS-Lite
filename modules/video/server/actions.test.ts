import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindModuleCtx } from './host.js';
import { fakeCtx, type FakeCtx } from './test-ctx.js';
import { setKolHost, type KolHost, type PersonaDto } from './kol-port.js';
import { createVideoModule } from './index.js';
import type { ModuleAction } from '../../../src/modules/sdk.js';

let ctx: FakeCtx;
let mod: ReturnType<typeof createVideoModule>;
const call = { agentId: 'director', taskId: 1, runId: 1 };
const action = (name: string): ModuleAction => mod.actions![name]!;
const run = async (name: string, payload: unknown, agentId = 'director') => action(name).handler(payload, { ...call, agentId }, ctx);

beforeEach(async () => {
  ctx = fakeCtx({ settings: { director_agent: 'director' }, agents: [{ id: 'main', runtime: 'claude' }, { id: 'director', runtime: 'claude' }], runLean: async () => ({ ok: true, output: 'Đã đọc yêu cầu.', taskId: 1, runId: 1 }) });
  mod = createVideoModule();
  await mod.start!(ctx);
});
afterEach(async () => {
  await mod.stop!(ctx);
  setKolHost(undefined);
  bindModuleCtx(undefined);
  ctx.cleanup();
});

describe('video actions', () => {
  it('declares scopes on every action', () => {
    for (const [name, a] of Object.entries(mod.actions!)) expect(['studio.read', 'studio.write'], name).toContain(a.scope);
    expect(action('job.status').scope).toBe('studio.read');
  });

  it('job.create (create) makes a project, starts the director and returns ids', async () => {
    const out = (await run('job.create', { mode: 'create', brief: 'Video 16 giây về cà phê sáng' })) as { projectId: string; mode: string };
    expect(out.mode).toBe('create');
    const status = (await run('job.status', { projectId: out.projectId })) as { id: string; mode: string };
    expect(status).toMatchObject({ id: out.projectId, mode: 'create' });
  });

  it('job.create (produce) creates a production without KOL; the director turn starts only with a cast', async () => {
    const out = (await run('job.create', { mode: 'produce', brief: 'Giới thiệu sản phẩm mới', targetSec: 30 })) as { productionId: string; projectId: string };
    expect(out.productionId).toBeTruthy();
    expect(ctx.leanCalls).toHaveLength(0);
  });

  it('job.create (produce) rejects a cast that the KOL module does not know', async () => {
    setKolHost({ getPersona: () => null, listPersonaSummaries: () => [] } as unknown as KolHost);
    await expect(run('job.create', { mode: 'produce', brief: 'Giới thiệu sản phẩm', cast: ['ghost'] })).rejects.toThrow('KOL');
  });

  it('job.create (produce) with a known KOL starts a lean director turn carrying the produce action guide', async () => {
    const persona = { id: 'k1', name: 'Tony', handle: 'tony', status: 'active', tagline: '', niche: '', languages: ['vi'], bio: '', audience: '', pillars: [], identitySource: 'synthetic', voiceId: '', brainAgent: 'main' } as PersonaDto;
    setKolHost({ getPersona: () => persona, listPersonaSummaries: () => [persona], listAssets: () => ({ assets: [] }), isProviderConfigured: () => false } as unknown as KolHost);
    await run('job.create', { mode: 'produce', brief: 'Giới thiệu sản phẩm mới của Tony', cast: ['k1'] });
    await new Promise((r) => setTimeout(r, 100));
    expect(ctx.leanCalls.length).toBeGreaterThan(0);
    expect(ctx.leanCalls[0].prompt).toContain('produce.call');
    expect(ctx.leanCalls[0].prompt).toContain('produce_request_generation');
  });

  it('job.status and job.cancel reject unknown projects', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    await expect(run('job.status', { projectId: missing })).rejects.toThrow('Không tìm thấy');
    await expect(run('job.cancel', { projectId: missing })).rejects.toThrow('Không tìm thấy');
    await expect(run('job.status', { projectId: 'nope' })).rejects.toThrow();
  });

  it('create.call only works for the director of a create project and validates the tool', async () => {
    const out = (await run('job.create', { mode: 'create', brief: 'Video 16 giây về trà chiều' })) as { projectId: string };
    await expect(run('create.call', { projectId: out.projectId, tool: 'create_status', args: {} }, 'someone-else')).rejects.toThrow('đạo diễn');
    await expect(run('create.call', { projectId: out.projectId, tool: 'shell', args: {} })).rejects.toThrow('không tồn tại');
    const status = (await run('create.call', { projectId: out.projectId, tool: 'create_status', args: {} })) as { project: { id: string } };
    expect(status.project.id).toBe(out.projectId);
  });

  it('create.call create_brief refuses to authorise generation without an explicit instruction', async () => {
    const out = (await run('job.create', { mode: 'create', brief: 'Cho mình xem storyboard video 16 giây' })) as { projectId: string };
    await expect(run('create.call', {
      projectId: out.projectId, tool: 'create_brief',
      args: { intent: 'generate', authorizationQuote: 'Cho mình xem storyboard', title: 'T', aspect: '9:16', targetSeconds: 16, visuals: 'auto', audio: 'native' },
    })).rejects.toThrow('chưa yêu cầu');
  });

  it('produce.call refuses projects that are not productions', async () => {
    const out = (await run('job.create', { mode: 'create', brief: 'Video 16 giây về bánh mì' })) as { projectId: string };
    await expect(run('produce.call', { projectId: out.projectId, tool: 'produce_estimate', args: {} })).rejects.toThrow('không phải video sản xuất');
  });

  it('keeps media and projects under the module data dir', async () => {
    await run('job.create', { mode: 'create', brief: 'Video 16 giây về trà đào' });
    expect(fs.existsSync(path.join(ctx.dataDir, 'video-edit'))).toBe(true);
  });
});

describe('default director', () => {
  it('prefers video-editor, then an agent holding studio.write, then main', async () => {
    const { resolveDefaultAgentId } = await import('./edit/turn.js');
    const make = (agents: string[], grants: Record<string, string[]> = {}) => bindModuleCtx(fakeCtx({ agents: agents.map((id) => ({ id, runtime: 'claude' as const })), grants }));
    make(['main', 'a', 'video-editor']);
    expect(resolveDefaultAgentId()).toBe('video-editor');
    make(['main', 'a', 'b'], { b: ['studio.write'] });
    expect(resolveDefaultAgentId()).toBe('b');
    make(['main', 'a']);
    expect(resolveDefaultAgentId()).toBe('main');
  });
});
