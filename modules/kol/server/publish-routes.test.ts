import { randomUUID } from 'crypto';

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  personas: new Map<string, unknown>(),
  assets: new Map<string, unknown>(),
  agentText: '',
}));

vi.mock('./personas.js', async () => {
  const { KolError } = await import('./core.js');
  return {
    getPersona: (id: string) => h.personas.get(id) ?? null,
    requirePersona: (id: string) => {
      const p = h.personas.get(id);
      if (!p) throw new KolError(404, 'Không tìm thấy KOL.');
      return p;
    },
    listPersonaIds: () => [...h.personas.keys()],
  };
});
vi.mock('./assets.js', () => ({
  listAssetsByIds: (ids: string[]) => ids.map((id) => h.assets.get(id)).filter(Boolean),
  getAsset: (id: string) => h.assets.get(id) ?? null,
  getAssetFile: () => null,
  patchAsset: () => null,
}));
vi.mock('./generations.js', () => ({ requestGeneration: () => { throw new Error('no'); }, getGeneration: () => null, listGenerationsForPost: () => [] }));
vi.mock('./spend.js', () => ({ spendByDay: () => [], personaSpendSince: () => 0 }));
vi.mock('./agent-turn.js', async (orig) => ({
  ...(await orig<typeof import('./agent-turn.js')>()),
  runKolAgent: async () => ({ text: h.agentText, model: 'm', costUsd: 0 }),
}));
vi.mock('../../_lib/composio.js', async (orig) => ({ ...(await orig<typeof import('../../_lib/composio.js')>()), hasComposioKey: () => false }));

import { _initTestDatabase } from './test-db.js';
import { kolDb } from './core.js';
import { registerPublishRoutes } from './publish-routes.js';
import type { PersonaDto } from './types.js';

const T0 = Math.floor(Date.now() / 1000);

let app: Hono;
/* eslint-disable @typescript-eslint/no-explicit-any */
const req = (p: string, init?: RequestInit) => app.request(p, init) as Promise<{ status: number; json(): Promise<any> }>;
const send = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

function account(): string {
  const id = randomUUID();
  kolDb().prepare(
    `INSERT INTO kol_accounts (id, persona_id, platform, connection_id, external_id, handle, window_start, window_end, created_at, updated_at)
     VALUES (?, 'p1', 'instagram', 'ca', 'ig1', '@mai', '00:00', '23:59', ?, ?)`,
  ).run(id, T0, T0);
  return id;
}

beforeEach(() => {
  _initTestDatabase();
  h.personas.clear();
  h.assets.clear();
  h.personas.set('p1', { id: 'p1', name: 'Mai', disclosureText: 'Ảnh AI.', languages: ['vi'], pillars: [], brainAgent: 'main', personality: {} } as unknown as PersonaDto);
  h.assets.set('a1', { id: 'a1', personaId: 'p1', kind: 'image', status: 'approved', width: 1080, height: 1350, durationSec: null, consistency: { score: 90, verdict: 'pass', notes: '' } });
  h.agentText = '';
  app = new Hono();
  registerPublishRoutes(app);
});

describe('publish routes (smoke)', () => {
  it('connections without a Composio key', async () => {
    const res = await req('/api/kol/connections');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ composio: false, connections: [] });
  });

  it('accounts: list, validation, unknown persona', async () => {
    account();
    expect((await (await req('/api/kol/personas/p1/accounts')).json()).accounts).toHaveLength(1);
    expect((await req('/api/kol/personas/nope/accounts')).status).toBe(404);
    const bad = await req('/api/kol/personas/p1/accounts', send('POST', { platform: 'myspace' }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Nền tảng/);
    const fb = await req('/api/kol/personas/p1/accounts', send('POST', { platform: 'facebook', connectionId: '' }));
    expect(fb.status).toBe(400);
    const ig = await req('/api/kol/personas/p1/accounts', send('POST', { platform: 'instagram', connectionId: 'ca' }));
    expect(ig.status).toBe(412);
    expect((await req('/api/kol/accounts/nope', send('PATCH', { enabled: false }))).status).toBe(404);
  });

  it('post lifecycle over HTTP', async () => {
    const acc = account();
    expect((await req('/api/kol/posts', send('POST', { title: 'x' }))).status).toBe(400);
    expect((await req('/api/kol/posts', send('POST', { personaId: 'ghost' }))).status).toBe(404);
    const created = await req('/api/kol/posts', send('POST', { personaId: 'p1', title: 'Đà Lạt', caption: 'Chiều', assetIds: ['a1'], accountIds: [acc] }));
    expect(created.status).toBe(200);
    const { post } = await created.json();
    expect(post).toMatchObject({ status: 'draft', format: 'photo', targets: [expect.objectContaining({ status: 'pending' })] });

    expect((await (await req('/api/kol/posts?personaId=p1&status=draft')).json()).posts).toHaveLength(1);
    expect((await req(`/api/kol/posts/${post.id}`)).status).toBe(200);
    expect((await req('/api/kol/posts/nope')).status).toBe(404);

    const patched = await req(`/api/kol/posts/${post.id}`, send('PATCH', { caption: 'Mới', format: 'bogus' }));
    expect(patched.status).toBe(400);
    expect((await (await req(`/api/kol/posts/${post.id}`, send('PATCH', { caption: 'Mới' }))).json()).post.caption).toBe('Mới');

    expect((await (await req(`/api/kol/posts/${post.id}/submit`, send('POST'))).json()).post.status).toBe('review');
    expect((await req(`/api/kol/posts/${post.id}/return`, send('POST', { feedback: '' }))).status).toBe(400);
    const past = await req(`/api/kol/posts/${post.id}/approve`, send('POST', { scheduledAt: T0 - 60 }));
    expect(past.status).toBe(409);
    expect((await past.json()).error).toMatch(/đã qua/);
    const sched = await req(`/api/kol/posts/${post.id}/approve`, send('POST', { scheduledAt: T0 + 3600 }));
    expect((await sched.json()).post.status).toBe('scheduled');

    const now = await req(`/api/kol/posts/${post.id}/publish-now`, send('POST'));
    expect(now.status).toBe(409);
    expect((await now.json()).error).toMatch(/Cho phép đăng bài/);
    expect((await req(`/api/kol/posts/${post.id}/retry`, send('POST', {}))).status).toBe(400);

    expect(await (await req(`/api/kol/posts/${post.id}`, send('DELETE'))).json()).toEqual({ ok: true });
    expect((await (await req(`/api/kol/posts/${post.id}`)).json()).post.status).toBe('cancelled');
  });

  it('captions through the persona brain', async () => {
    const acc = account();
    const { post } = await (await req('/api/kol/posts', send('POST', { personaId: 'p1', title: 'Đà Lạt', accountIds: [acc] }))).json();
    h.agentText = '{"variants": {"instagram": {"caption": "Chiều tím", "hashtags": ["dalat", "chill", "travel"]}}}';
    const res = await req(`/api/kol/posts/${post.id}/captions`, send('POST', {}));
    expect(res.status).toBe(200);
    expect((await res.json()).post.variants.instagram).toEqual({ caption: 'Chiều tím', hashtags: ['dalat', 'chill', 'travel'] });
    h.agentText = 'không phải JSON';
    expect((await req(`/api/kol/posts/${post.id}/captions`, send('POST', {}))).status).toBe(502);
  });

  it('growth, insights, strategist, autopilot, radar ideas', async () => {
    const growth = await (await req('/api/kol/personas/p1/growth?days=7')).json();
    expect(growth).toMatchObject({ days: 7, accounts: [], totals: { posts: 0 }, spend: [] });
    expect(growth.hours).toHaveLength(24);
    expect(await (await req('/api/kol/personas/p1/insights')).json()).toEqual({ insights: [] });
    h.agentText = 'oops';
    expect((await req('/api/kol/personas/p1/strategist', send('POST'))).status).toBe(502);
    const auto = await req('/api/kol/personas/p1/autopilot/run', send('POST'));
    expect(auto.status).toBe(200);
    expect((await auto.json()).insight.summary).toMatch(/chưa có tài khoản/);
    expect(await (await req('/api/kol/radar-ideas?limit=5')).json()).toEqual({ ideas: [] });
  });
});
