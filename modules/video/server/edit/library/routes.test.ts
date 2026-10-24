import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerVideoLibraryRoutes } from './routes.js';
import { clearLibraryCache, libraryDir, setLibraryDeps } from './store.js';

const P = '/edit/assets';
const TTF = Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(300, 7)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(300, 9)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);

let root: string;
let app: Hono;

const j = async (res: Response) => res.json() as Promise<any>;

function upload(kind: string, name: string, data: Buffer, headers: Record<string, string> = {}) {
  return app.request(`${P}/upload?kind=${kind}`, {
    method: 'POST', body: data, headers: { 'x-file-name': encodeURIComponent(name), 'content-type': 'application/octet-stream', ...headers },
  });
}
const patch = (id: string, body: unknown) => app.request(`${P}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlibr-'));
  clearLibraryCache();
  setLibraryDeps({
    probeDuration: async () => 4.2,
    fontInfo: () => ({ family: 'Demo Sans', style: 'Regular', weight: 400, italic: false }),
  });
  app = new Hono();
  registerVideoLibraryRoutes(app, { root });
});
afterEach(() => { setLibraryDeps(null); delete process.env.VIDEO_LIBRARY_MAX_UPLOAD_BYTES; fs.rmSync(root, { recursive: true, force: true }); });

describe('GET /assets', () => {
  it('lists every kind with counts and filters by kind', async () => {
    const body = await j(await app.request(P));
    expect(body.kinds.map((k: any) => k.kind)).toEqual(['effect', 'caption', 'bgm', 'sfx', 'font', 'background', 'overlay', 'lut', 'video', 'icon', 'image']);
    const count = (kind: string) => body.kinds.find((k: any) => k.kind === kind).count;
    expect(count('effect')).toBe(20);
    expect(count('sfx')).toBe(11);
    expect(count('bgm')).toBe(6);
    expect(count('font')).toBe(60);
    expect(body.assets.length).toBe(body.kinds.reduce((n: number, k: any) => n + k.count, 0));
    const sfx = await j(await app.request(`${P}?kind=sfx`));
    expect(sfx.assets).toHaveLength(11);
    expect(sfx.kinds.find((k: any) => k.kind === 'effect').count).toBe(20);
    expect((await app.request(`${P}?kind=nope`)).status).toBe(400);
  });

  it('searches without caring about case or diacritics and filters by source and enabled', async () => {
    const vut = await j(await app.request(`${P}?q=vut`));
    expect(vut.assets.some((a: any) => a.id === 'sfx:whoosh')).toBe(true);
    expect(vut.kinds.find((k: any) => k.kind === 'bgm').count).toBe(0);
    const upper = await j(await app.request(`${P}?q=${encodeURIComponent('SO SÁNH')}&kind=effect`));
    expect(upper.assets.map((a: any) => a.id)).toContain('effect:compare-ab');
    const mood = await j(await app.request(`${P}?q=${encodeURIComponent('hồi hộp')}&kind=bgm`));
    expect(mood.assets.map((a: any) => a.id)).toContain('bgm:hoi-hop');

    await upload('sfx', 'my.mp3', MP3);
    const mine = await j(await app.request(`${P}?source=library`));
    expect(mine.assets.map((a: any) => a.id)).toEqual(['lib:sfx:my']);
    await patch('lib:sfx:my', { enabled: false });
    const on = await j(await app.request(`${P}?kind=sfx&enabled=1`));
    expect(on.assets.some((a: any) => a.id === 'lib:sfx:my')).toBe(false);
    expect((await j(await app.request(`${P}?kind=sfx`))).assets.some((a: any) => a.id === 'lib:sfx:my')).toBe(true);
  });
});

describe('upload', () => {
  it('stores a raw streamed file and returns the asset', async () => {
    const res = await upload('sfx', 'Tiếng chuông.mp3', MP3);
    expect(res.status).toBe(201);
    const { asset } = await j(res);
    expect(asset).toMatchObject({ id: 'lib:sfx:tieng-chuong', kind: 'sfx', source: 'library', available: true, durationSec: 4.2, sizeBytes: MP3.length });
    expect(asset.license).toMatch(/chưa rõ/);
    expect(fs.readFileSync(path.join(libraryDir(root), asset.file))).toEqual(MP3);
    expect(fs.readdirSync(path.join(libraryDir(root), '.tmp'))).toEqual([]);
  });

  it('detects the family of an uploaded font and accepts images', async () => {
    const font = (await j(await upload('font', 'x.ttf', TTF))).asset;
    expect(font).toMatchObject({ kind: 'font', family: 'Demo Sans', name: 'Demo Sans' });
    const img = (await j(await upload('image', 'logo.png', PNG))).asset;
    expect(img).toMatchObject({ kind: 'image', id: 'lib:image:logo' });
  });

  it('rejects a bad kind, extension, content, empty body and oversize body', async () => {
    expect((await upload('nope', 'a.mp3', MP3)).status).toBe(400);
    expect((await upload('effect', 'a.mp3', MP3)).status).toBe(400);
    expect((await upload('font', 'a.mp3', MP3)).status).toBe(415);
    const fake = await upload('sfx', 'a.mp3', Buffer.from('<html>not audio</html>'));
    expect(fake.status).toBe(415);
    expect((await j(fake)).code).toBe('bad_content');
    expect((await upload('sfx', 'a.mp3', Buffer.alloc(0))).status).toBe(400);
    process.env.VIDEO_LIBRARY_MAX_UPLOAD_BYTES = '100';
    const big = await upload('sfx', 'a.mp3', MP3);
    expect(big.status).toBe(413);
    expect(fs.readdirSync(path.join(libraryDir(root), '.tmp'))).toEqual([]);
    const declared = await upload('sfx', 'a.mp3', MP3, { 'content-length': '999' });
    expect(declared.status).toBe(413);
  });

  it('keeps a path in the file name out of the library folder', async () => {
    const { asset } = await j(await upload('sfx', '../../evil.mp3', MP3));
    expect(asset.file).toBe('sfx/evil.mp3');
  });
});

describe('PATCH and DELETE', () => {
  it('edits metadata and validates it', async () => {
    const { asset } = await j(await upload('bgm', 'song.mp3', MP3));
    const res = await patch(asset.id, { name: 'Bài hát', tags: ['a', 'b'], mood: 'Bình yên', bpm: 90, license: 'CC-BY 4.0', attribution: 'Tác giả X', sourceUrl: 'https://example.com/x', enabled: true });
    expect((await j(res)).asset).toMatchObject({ name: 'Bài hát', tags: ['a', 'b'], mood: 'Bình yên', bpm: 90, license: 'CC-BY 4.0', attribution: 'Tác giả X', sourceUrl: 'https://example.com/x' });
    const cleared = await j(await patch(asset.id, { bpm: null, attribution: null }));
    expect(cleared.asset.bpm).toBeUndefined();
    expect(cleared.asset.attribution).toBeUndefined();
    expect((await patch(asset.id, { bpm: 9999 })).status).toBe(400);
    expect((await patch(asset.id, { sourceUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await patch(asset.id, { surprise: 1 })).status).toBe(400);
    expect((await patch('nope', { name: 'x' })).status).toBe(404);
  });

  it('deletes files of library assets but only disables builtin ones', async () => {
    const { asset } = await j(await upload('sfx', 'gone.mp3', MP3));
    const abs = path.join(libraryDir(root), asset.file);
    const del = await j(await app.request(`${P}/${encodeURIComponent(asset.id)}`, { method: 'DELETE' }));
    expect(del).toMatchObject({ ok: true, deleted: true });
    expect(fs.existsSync(abs)).toBe(false);
    expect((await app.request(`${P}/${encodeURIComponent(asset.id)}/file`)).status).toBe(404);

    const builtin = await j(await app.request(`${P}/effect:keyword-pop`, { method: 'DELETE' }));
    expect(builtin).toMatchObject({ ok: true, deleted: false });
    expect(builtin.asset.enabled).toBe(false);
    expect((await app.request(`${P}/nope`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('GET /assets/:id/file', () => {
  it('serves with the right content type, nosniff and Range', async () => {
    const font = (await j(await upload('font', 'x.ttf', TTF))).asset;
    const f = await app.request(`${P}/${font.id}/file`);
    expect(f.status).toBe(200);
    expect(f.headers.get('content-type')).toBe('font/ttf');
    expect(f.headers.get('x-content-type-options')).toBe('nosniff');
    expect(f.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await f.arrayBuffer())).toEqual(TTF);

    const audio = (await j(await upload('sfx', 'a.mp3', MP3))).asset;
    const part = await app.request(`${P}/${audio.id}/file`, { headers: { range: 'bytes=3-10' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-type')).toBe('audio/mpeg');
    expect(part.headers.get('content-range')).toBe(`bytes 3-10/${MP3.length}`);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(MP3.subarray(3, 11));
    const tail = await app.request(`${P}/${audio.id}/file`, { headers: { range: 'bytes=-5' } });
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(MP3.subarray(MP3.length - 5));
    const bad = await app.request(`${P}/${audio.id}/file`, { headers: { range: 'bytes=9999-' } });
    expect(bad.status).toBe(416);

    const png = (await j(await upload('image', 'a.png', PNG))).asset;
    expect((await app.request(`${P}/${png.id}/file`)).headers.get('content-type')).toBe('image/png');

    const etag = f.headers.get('etag')!;
    expect((await app.request(`${P}/${font.id}/file`, { headers: { 'if-none-match': etag } })).status).toBe(304);
  });

  it('404s for an unknown asset and for a builtin entry without a file', async () => {
    expect((await app.request(`${P}/nope/file`)).status).toBe(404);
    const res = await app.request(`${P}/sfx:whoosh/file`);
    expect(res.status).toBe(404);
    expect((await j(res)).code).toBe('no_file');
  });
});

describe('rescan and seed endpoints', () => {
  it('rescan picks up dropped files', async () => {
    fs.mkdirSync(path.join(libraryDir(root), 'sfx'), { recursive: true });
    fs.writeFileSync(path.join(libraryDir(root), 'sfx', 'dropped.mp3'), MP3);
    const res = await j(await app.request(`${P}/rescan`, { method: 'POST' }));
    expect(res.added).toBe(1);
    const a = (await j(await app.request(`${P}/lib:sfx:dropped`))).asset;
    expect(a).toMatchObject({ durationSec: 4.2, available: true });
  });

  it('starts the starter pack in the background and reports progress', async () => {
    const idle = await j(await app.request(`${P}/seed`));
    expect(idle.state).toBe('idle');
    const started = await app.request(`${P}/seed`, { method: 'POST', body: JSON.stringify({ groups: ['luts'] }), headers: { 'content-type': 'application/json' } });
    expect(started.status).toBe(202);
    expect((await j(started)).groups).toEqual(['luts']);
    for (let i = 0; i < 100; i++) {
      const s = await j(await app.request(`${P}/seed`));
      if (s.state === 'done') { expect(s.counts.lut).toBe(7); expect(s.progress.done).toBe(7); return; }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('seed did not finish');
  });

  it('rejects unknown seed groups', async () => {
    const res = await app.request(`${P}/seed`, { method: 'POST', body: JSON.stringify({ groups: ['everything'] }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
  });
});
