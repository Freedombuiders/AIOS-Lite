import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerVideoEditRoutes } from '../routes.js';
import { indexQueueIdle } from './indexer.js';
import { broll, makeHubKit, pexelsVideo, type HubKit } from './testkit.js';

let kit: HubKit;
let app: Hono;
let reg: ReturnType<typeof registerVideoEditRoutes>;

const j = async (res: Response) => (await res.json()) as any;
const post = (url: string, body: unknown) => app.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  kit = makeHubKit();
  app = new Hono();
  reg = registerVideoEditRoutes(app, { root: kit.root, autoStart: false, isLocal: () => true });
  kit.pexels.videos = [pexelsVideo(81, 'pouring-coffee', 8), pexelsVideo(82, 'coffee-steam', 6), pexelsVideo(83, 'wide-cafe', 8, 1920, 1080)];
});
afterEach(async () => {
  await indexQueueIdle();
  reg.stop();
  kit.cleanup();
});

describe('GET /assets/search', () => {
  it('searches the sources (not taken for an asset id) and returns licences', async () => {
    const res = await app.request('/edit/assets/search?q=pouring%20coffee&source=pexels');
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.notes).toEqual([]);
    expect(body.candidates.map((c: { ref: string }) => c.ref)).toEqual(['pexels:video:81', 'pexels:video:82']);
    expect(body.candidates[0].license).toMatchObject({ name: 'Pexels License', creator: 'Ana Lee' });
    expect(kit.turns).toEqual([]);
  });

  it('scores against a B-roll slot of the current plan, best first', async () => {
    kit.savePlan([broll('br1', 4, { description: 'Hơi nước bốc lên từ cốc cà phê', keywords: ['coffee steam'] })]);
    kit.scoreOf = (caption) => (caption === 'coffee steam' ? 5 : 3);
    const res = await app.request(`/edit/assets/search?projectId=${kit.project.id}&brollId=br1&source=pexels`);
    const body = await j(res);
    expect(res.status).toBe(200);
    expect(body.candidates.map((c: { ref: string; score: number }) => [c.ref, c.score])).toEqual([['pexels:video:82', 5], ['pexels:video:81', 3]]);
    expect(kit.pexels.queries[0].query).toBe('coffee steam');
    expect(kit.turns[0].prompt).toContain('Cảnh cần có: Hơi nước bốc lên từ cốc cà phê');
  });

  it('asks for words, and 404s an unknown project or slot', async () => {
    expect((await j(await app.request('/edit/assets/search'))).code).toBe('no_query');
    expect((await app.request('/edit/assets/search?q=x&projectId=khong-co')).status).toBe(404);
    kit.savePlan([]);
    expect((await j(await app.request(`/edit/assets/search?projectId=${kit.project.id}&brollId=br9`))).code).toBe('no_broll');
    expect((await app.request('/edit/assets/search?q=x&la=1')).status).toBe(400);
  });

  it('lists library music for kind=bgm', async () => {
    const track = await kit.addAsset('bgm', 'chill-coffee.mp3', { mood: 'Bình yên' });
    const body = await j(await app.request('/edit/assets/search?q=coffee&kind=bgm'));
    expect(body.candidates.map((c: { ref: string }) => c.ref)).toEqual([track.id]);
    expect(kit.pexels.queries).toEqual([]);
  });
});

describe('POST /assets/fetch', () => {
  it('downloads a searched stock clip into the library once, with its licence', async () => {
    await app.request('/edit/assets/search?q=coffee&source=pexels');
    const first = await post('/edit/assets/fetch', { ref: 'pexels:video:81', keywords: ['coffee'] });
    expect(first.status).toBe(201);
    const { asset } = await j(first);
    expect(asset).toMatchObject({ kind: 'video', license: 'Pexels License', attribution: 'Video: Ana Lee · Pexels', sourceUrl: 'https://www.pexels.com/video/pouring-coffee-81/', tags: ['pexels', 'coffee'] });
    expect((await j(await app.request(`/edit/assets/${encodeURIComponent(asset.id)}`))).asset.id).toBe(asset.id);

    const again = await post('/edit/assets/fetch', { ref: 'pexels:video:81' });
    expect(again.status).toBe(200);
    expect(await j(again)).toMatchObject({ downloaded: false, asset: { id: asset.id } });
    expect(kit.downloads.filter((u) => u.endsWith('hd.mp4'))).toEqual(['https://videos.pexels.com/video-files/81/hd.mp4']);
  });

  it('asks to search again for a stock ref it no longer knows, returns library refs as they are', async () => {
    expect(await j(await post('/edit/assets/fetch', { ref: 'pexels:video:999' }))).toMatchObject({ code: 'stale_ref' });
    const own = await kit.addAsset('video', 'own.mp4');
    expect(await j(await post('/edit/assets/fetch', { ref: own.id }))).toMatchObject({ downloaded: false, asset: { id: own.id } });
    expect((await post('/edit/assets/fetch', { ref: 'lib:video:khong-co' })).status).toBe(404);
  });
});

describe('POST /assets/index', () => {
  it('indexes one file and maps library errors to their status', async () => {
    const clip = await kit.addAsset('video', 'clip.mp4');
    const res = await post('/edit/assets/index', { assetId: clip.id, force: true });
    expect(res.status).toBe(200);
    expect(await j(res)).toMatchObject({ asset: { id: clip.id, quality: 0.81 }, notes: [] });
    const sfx = await kit.addAsset('sfx', 'pop.mp3');
    expect((await post('/edit/assets/index', { assetId: sfx.id })).status).toBe(422);
    expect((await post('/edit/assets/index', { assetId: 'lib:video:khong-co' })).status).toBe(404);
    expect((await post('/edit/assets/index', {})).status).toBe(400);
  });
});
