import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  process.env.VIDEO_EDIT_FFMPEG = '/nonexistent/ffmpeg-for-tests';
  process.env.VIDEO_EDIT_FFPROBE = '/nonexistent/ffprobe-for-tests';
  return { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'kol-routes-')) };
});
vi.mock('./config.js', async (orig) => ({ ...(await orig<typeof import('./config.js')>()), STORE_DIR: store.dir, GOOGLE_API_KEY: '' }));
vi.mock('../../_lib/composio.js', () => ({ hasComposioKey: () => false }));

import fs from 'fs';
import path from 'path';

import { Hono } from 'hono';

import { _initTestDatabase } from './test-db.js';
import { insertAsset } from './assets.js';
import { kolDb, nowSec, resolveKolFile } from './core.js';
import { _resetWorkerForTests } from './generations.js';
import { _setProviderAdapterForTests } from './providers/index.js';
import type { ProviderAdapter } from './providers/types.js';
import { registerStudioRoutes } from './studio-routes.js';
import type { ModelInfo } from './types.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const IMAGE: ModelInfo = { id: 'gemini-3-pro-image', provider: 'gemini', kind: 'image', label: 'Nano Banana Pro', maxRefs: 14, aspects: ['1:1', '4:5', '9:16'], qualities: ['standard'], priceNote: '', recommended: true };

const fakeGemini: ProviderAdapter = {
  id: 'gemini', label: 'Google Gemini', hint: 'GOOGLE_API_KEY', configured: () => true, models: () => [IMAGE],
  generateImage: async () => ({ outputs: [{ bytes: PNG, mime: 'image/png' }] }),
  submitVideo: async () => ({ handle: 'x' }),
  pollVideo: async () => ({ state: 'pending' }),
};

let app: Hono;
/* eslint-disable @typescript-eslint/no-explicit-any */
const call = (p: string, init?: RequestInit) => app.request(p, init) as Promise<Response>;
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const upload = (bytes: Buffer, name = 'face.png'): RequestInit => ({ method: 'POST', headers: { 'x-file-name': encodeURIComponent(name), 'content-type': 'application/octet-stream' }, body: new Uint8Array(bytes) });
const body = async (r: Response): Promise<any> => r.json();

beforeEach(() => {
  _initTestDatabase();
  _resetWorkerForTests();
  app = new Hono();
  registerStudioRoutes(app);
});

afterEach(() => _setProviderAdapterForTests('gemini', null));

afterAll(() => fs.rmSync(store.dir, { recursive: true, force: true }));

async function newPersona(name = 'Mia'): Promise<string> {
  const r = await call('/api/kol/personas', json('POST', { name }));
  expect(r.status).toBe(200);
  return (await body(r)).persona.id;
}

describe('status & settings', () => {
  it('reports providers, spend, switches, queue, judge and voice', async () => {
    const r = await call('/api/kol/status');
    expect(r.status).toBe(200);
    const s = await body(r);
    expect(s.enabled).toBe(true);
    expect(s.providers.map((p: any) => p.id)).toEqual(['gemini', 'chatgpt', 'fal', 'higgsfield']);
    expect(s.providers[0].configured).toBe(false);
    expect(s.providers[0].hint).toContain('GOOGLE_API_KEY');
    expect(s.providers.every((p: any) => p.models.length > 0)).toBe(true);
    expect(s.spend).toEqual({ todayUsd: 0, monthUsd: 0, dailyCapUsd: 10, monthlyCapUsd: 150 });
    expect(s.killSwitches).toEqual({ generate: true, publish: true });
    expect(s.queue).toEqual({ running: 0, queued: 0 });
    expect(s.composio).toBe(false);
    expect(s.judge).toEqual({ configured: false, model: 'auto', provider: null });
    expect(typeof s.voice.configured).toBe('boolean');
    expect(s.chatgpt).toMatchObject({ mode: 'none', configured: false, imagesToday: 0, dailyLimit: 40, model: 'gpt-6-luna' });
    expect(s.chatgpt.hint).toContain('codex login');
    expect(s.providers[1]).toMatchObject({ id: 'chatgpt', configured: false });
  });

  it('accepts the ChatGPT settings and the chatgpt/auto judge', async () => {
    const ok = await call('/api/kol/settings', json('PUT', { judgeModel: 'chatgpt', chatgptDailyLimit: 12, codexModel: 'gpt-5.6-terra' }));
    expect((await body(ok)).settings).toMatchObject({ judgeModel: 'chatgpt', chatgptDailyLimit: 12, codexModel: 'gpt-5.6-terra' });
    expect((await call('/api/kol/settings', json('PUT', { judgeModel: 'auto' }))).status).toBe(200);
    expect((await call('/api/kol/settings', json('PUT', { chatgptDailyLimit: -1 }))).status).toBe(400);
    expect((await call('/api/kol/settings', json('PUT', { codexModel: 'bad model!' }))).status).toBe(400);
  });

  it('reads and validates settings', async () => {
    expect((await body(await call('/api/kol/settings'))).settings.concurrency).toBe(2);
    const ok = await call('/api/kol/settings', json('PUT', { dailyCapUsd: 3, priceOverrides: { 'higgsfield/xai/grok-imagine-image-2.0': 0.05 } }));
    expect((await body(ok)).settings).toMatchObject({ dailyCapUsd: 3, priceOverrides: { 'higgsfield/xai/grok-imagine-image-2.0': 0.05 } });
    expect((await call('/api/kol/settings', json('PUT', { concurrency: 9 }))).status).toBe(400);
    expect((await call('/api/kol/settings', json('PUT', { defaultImageModel: 'veo-3.1-generate-preview' }))).status).toBe(400);
    expect((await call('/api/kol/settings', json('PUT', { judgeModel: 'gpt-4o' }))).status).toBe(400);
    const bad = await call('/api/kol/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(bad.status).toBe(400);
    expect((await body(bad)).error).toContain('JSON');
  });
});

describe('personas & identity pack', () => {
  it('creates, lists, reads, patches and archives', async () => {
    expect((await call('/api/kol/personas', json('POST', {}))).status).toBe(400);
    const id = await newPersona();
    const list = await body(await call('/api/kol/personas'));
    expect(list.personas.map((p: any) => p.id)).toEqual([id]);
    expect((await body(await call(`/api/kol/personas/${id}`))).persona.name).toBe('Mia');
    const patched = await body(await call(`/api/kol/personas/${id}`, json('PATCH', { tagline: 'Cô nàng mê cà phê', handle: '@mia.cafe' })));
    expect(patched.persona).toMatchObject({ tagline: 'Cô nàng mê cà phê', handle: 'mia.cafe' });
    const bad = await call(`/api/kol/personas/${id}`, json('PATCH', { status: 'active' }));
    expect(bad.status).toBe(400);
    expect((await body(bad)).error).toContain('anchor');
    expect((await call(`/api/kol/personas/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await body(await call(`/api/kol/personas/${id}`))).persona.status).toBe('archived');
    expect((await call('/api/kol/personas/missing')).status).toBe(404);
  });

  it('uploads refs from the raw body, sniffs them, serves them with Range, patches and deletes', async () => {
    const id = await newPersona();
    const r = await call(`/api/kol/personas/${id}/refs?kind=anchor&label=${encodeURIComponent('Chính diện')}`, upload(PNG));
    expect(r.status).toBe(200);
    const ref = (await body(r)).ref;
    expect(ref).toMatchObject({ kind: 'anchor', isPrimary: true, label: 'Chính diện', width: 1, height: 1 });

    const media = await call(ref.url);
    expect(media.status).toBe(200);
    expect(media.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await media.arrayBuffer()).equals(PNG)).toBe(true);
    const ranged = await call(ref.url, { headers: { range: 'bytes=0-3' } });
    expect(ranged.status).toBe(206);

    const notImage = await call(`/api/kol/personas/${id}/refs?kind=anchor`, upload(Buffer.from('<html>hi</html>'), 'face.jpg'));
    expect(notImage.status).toBe(415);
    expect((await body(notImage)).error).toContain('JPEG');
    expect((await call(`/api/kol/personas/${id}/refs?kind=anchor`, { method: 'POST' })).status).toBe(400);

    expect((await body(await call(`/api/kol/refs/${ref.id}`, json('PATCH', { label: 'Mặt trước' })))).ref.label).toBe('Mặt trước');
    expect((await call(`/api/kol/refs/${ref.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(ref.url)).status).toBe(404);
  });

  it('imports the owner\'s existing images into the gallery without spending', async () => {
    const id = await newPersona();
    const r = await call(`/api/kol/personas/${id}/assets/import?status=approved&tags=${encodeURIComponent('sân khấu,genprint')}`, upload(PNG, 'stage.png'));
    expect(r.status).toBe(200);
    const asset = (await body(r)).asset;
    expect(asset).toMatchObject({ personaId: id, generationId: null, kind: 'image', status: 'approved', provider: 'owner', model: 'upload', costUsd: 0, tags: ['sân khấu', 'genprint'] });
    expect(asset.prompt).toContain('stage.png');
    expect((await call(asset.url)).status).toBe(200);
    const listed = (await body(await call(`/api/kol/assets?personaId=${id}`))).assets;
    expect(listed.map((a: any) => a.id)).toContain(asset.id);

    expect((await call(`/api/kol/personas/${id}/assets/import`, upload(Buffer.from('<html>hi</html>'), 'x.png'))).status).toBe(415);
    expect((await call(`/api/kol/personas/${id}/assets/import?status=rejected`, upload(PNG))).status).toBe(400);
    expect((await call('/api/kol/personas/missing/assets/import', upload(PNG))).status).toBe(404);
  });
});

describe('media', () => {
  it('answers 404 for unknown areas, missing files and traversal attempts', async () => {
    expect((await call('/api/kol/media/secrets/abc')).status).toBe(404);
    expect((await call('/api/kol/media/asset/does-not-exist')).status).toBe(404);
    expect((await call('/api/kol/media/ref/..%2F..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
    expect((await call('/api/kol/media/thumb/abc.def')).status).toBe(404);
  });

  it('never serves a stored path that points outside KOL_DIR', async () => {
    const id = await newPersona();
    const now = nowSec();
    kolDb().prepare(`INSERT INTO kol_assets (id, persona_id, kind, file, mime, created_at, updated_at) VALUES ('evil', ?, 'image', '../../outside.png', 'image/png', ?, ?)`).run(id, now, now);
    fs.writeFileSync(path.join(store.dir, '..', 'outside.png'), PNG);
    try {
      expect((await call('/api/kol/media/asset/evil')).status).toBe(404);
    } finally {
      fs.rmSync(path.join(store.dir, '..', 'outside.png'), { force: true });
    }
  });
});

describe('library & templates', () => {
  it('lists the builtin library, protects builtins, accepts owner items', async () => {
    const items = (await body(await call('/api/kol/library?kind=expression'))).items;
    expect(items.length).toBeGreaterThanOrEqual(90);
    expect((await call('/api/kol/library/b-expr-wink', { method: 'DELETE' })).status).toBe(409);
    const created = await call('/api/kol/library', json('POST', { kind: 'scene', group: 'Của tôi', name: 'Quán quen', prompt: 'a tiny corner café with green tiles' }));
    expect((await body(created)).item).toMatchObject({ kind: 'scene', builtin: false });
    const img = await call('/api/kol/library/b-scene-cozy-cafe/image', upload(PNG));
    expect((await body(img)).item.imageUrl).toBe('/api/kol/media/library/b-scene-cozy-cafe');
    expect((await call('/api/kol/media/library/b-scene-cozy-cafe')).status).toBe(200);
  });

  it('uploads templates (single and carousel) from the raw body', async () => {
    const t = await body(await call(`/api/kol/templates?name=${encodeURIComponent('Cà phê')}&notes=sang`, upload(PNG, 'cafe.png')));
    expect(t.template).toMatchObject({ name: 'Cà phê', kind: 'single', notes: 'sang' });
    const c = await body(await call('/api/kol/templates?kind=carousel', upload(PNG, 'slide.png')));
    expect(c.template.setId).toBeTruthy();
    const list = (await body(await call('/api/kol/templates'))).templates;
    expect(list).toHaveLength(2);
    expect((await call(`/api/kol/templates/${t.template.id}`, json('PATCH', { notes: 'chiều' }))).status).toBe(200);
    expect((await call(`/api/kol/templates/${t.template.id}`, { method: 'DELETE' })).status).toBe(200);
  });
});

describe('preview & generations', () => {
  it('previews without a key and without spending', async () => {
    const id = await newPersona();
    const r = await call('/api/kol/preview', json('POST', { personaId: id, mode: 'compose', selection: { expressionId: 'b-expr-wink' } }));
    expect(r.status).toBe(200);
    const p = await body(r);
    expect(p.prompt).toContain('Expression: winking one eye');
    expect(p.model.id).toBe('gemini-3-pro-image');
    expect(p.estimateUsd).toBeGreaterThan(0);
    expect(p.warnings.join(' ')).toContain('Chưa có ảnh gốc');
    expect(p.warnings.join(' ')).toContain('chưa được cấu hình');
    expect((await call('/api/kol/preview', json('POST', { personaId: 'nope', mode: 'compose' }))).status).toBe(404);
  });

  it('answers 412 without a provider key, 402 over the cap, 409 when disabled, then queues', async () => {
    const id = await newPersona();
    await call(`/api/kol/personas/${id}/refs?kind=anchor`, upload(PNG));
    const gen = () => call('/api/kol/generations', json('POST', { personaId: id, mode: 'compose' }));

    const r412 = await gen();
    expect(r412.status).toBe(412);
    expect((await body(r412)).error).toContain('GOOGLE_API_KEY');

    _setProviderAdapterForTests('gemini', fakeGemini);
    await call('/api/kol/settings', json('PUT', { dailyCapUsd: 0.01 }));
    const r402 = await gen();
    expect(r402.status).toBe(402);
    expect((await body(r402)).code).toBe('daily_cap');

    await call('/api/kol/settings', json('PUT', { dailyCapUsd: 10, enabled: false }));
    expect((await gen()).status).toBe(409);

    await call('/api/kol/settings', json('PUT', { enabled: true }));
    const ok = await gen();
    expect(ok.status).toBe(200);
    const g = (await body(ok)).generation;
    expect(g.status).toBe('queued');

    const list = await body(await call(`/api/kol/generations?personaId=${id}&status=queued`));
    expect(list.generations.map((x: any) => x.id)).toEqual([g.id]);
    expect((await call('/api/kol/generations?status=bogus')).status).toBe(400);
    const one = await body(await call(`/api/kol/generations/${g.id}`));
    expect(one).toMatchObject({ generation: { id: g.id }, assets: [] });
    expect((await body(await call(`/api/kol/generations/${g.id}/cancel`, { method: 'POST' }))).generation.status).toBe('cancelled');
    expect((await call(`/api/kol/generations/${g.id}/cancel`, { method: 'POST' })).status).toBe(409);
    expect((await call('/api/kol/generations', json('POST', { personaId: id, mode: 'compose', params: { count: 9 } }))).status).toBe(400);
  });
});

describe('assets', () => {
  it('lists with a cursor, patches, refuses to delete media used by a post, deletes otherwise', async () => {
    const id = await newPersona();
    const rel = `assets/${id}/2026-10/as1.png`;
    fs.mkdirSync(path.dirname(resolveKolFile(rel)), { recursive: true });
    fs.writeFileSync(resolveKolFile(rel), PNG);
    insertAsset({ id: 'as1', personaId: id, generationId: null, kind: 'image', file: rel, thumb: null, mime: 'image/png', width: 1, height: 1, durationSec: null, bytes: PNG.length, model: 'm', provider: 'gemini', costUsd: 0.1, prompt: 'p' });
    const audioRel = `assets/${id}/2026-10/au1.mp3`;
    fs.writeFileSync(resolveKolFile(audioRel), Buffer.from('ID3....'));
    insertAsset({ id: 'au1', personaId: id, generationId: null, kind: 'audio', file: audioRel, thumb: null, mime: 'audio/mpeg', width: null, height: null, durationSec: 2, bytes: 7, model: 'tts', provider: 'elevenlabs', costUsd: 0, prompt: '' });

    const page = await body(await call(`/api/kol/assets?personaId=${id}&limit=1`));
    expect(page.assets).toHaveLength(2);
    expect(page.nextBefore).toBe(page.assets[1].createdAt);
    const images = await body(await call(`/api/kol/assets?personaId=${id}&kind=image`));
    expect(images).toEqual({ assets: [expect.objectContaining({ id: 'as1' })], nextBefore: null });

    expect((await body(await call('/api/kol/assets/as1', json('PATCH', { status: 'approved', favorite: true, tags: ['tet'] })))).asset)
      .toMatchObject({ status: 'approved', favorite: true, tags: ['tet'] });
    expect((await body(await call(`/api/kol/assets?personaId=${id}&favorite=1`))).assets.map((a: any) => a.id)).toEqual(['as1']);
    expect((await call('/api/kol/assets/as1', json('PATCH', { status: 'maybe' }))).status).toBe(400);
    expect((await call('/api/kol/assets/au1/recheck', { method: 'POST' })).status).toBe(400);

    kolDb().prepare(`INSERT INTO kol_posts (id, persona_id, asset_ids_json, status, created_at, updated_at) VALUES ('p1', ?, '["as1"]', 'draft', ?, ?)`).run(id, nowSec(), nowSec());
    const busy = await call('/api/kol/assets/as1', { method: 'DELETE' });
    expect(busy.status).toBe(409);
    kolDb().prepare("UPDATE kol_posts SET status = 'cancelled' WHERE id = 'p1'").run();
    expect((await call('/api/kol/assets/as1', { method: 'DELETE' })).status).toBe(200);
    expect(fs.existsSync(resolveKolFile(rel))).toBe(false);
    expect((await call('/api/kol/assets/as1', { method: 'DELETE' })).status).toBe(404);
  });
});
