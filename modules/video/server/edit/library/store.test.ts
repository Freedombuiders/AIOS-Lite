import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addFile, assetFilePath, clearLibraryCache, deleteAsset, enrichLibrary, findAsset, getLibrary, installSeedAsset, isSeedInstalled,
  LibraryError, libraryDir, libraryStats, listFonts, onLibraryAdded, recordAssetIndex, rescanLibrary, resolveLibraryFile, setLibraryDeps, updateAsset,
} from './store.js';

let root: string;
const TTF = Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(64)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);

function put(rel: string, data: Buffer | string = 'x') {
  const abs = path.join(libraryDir(root), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  return abs;
}
function tmp(name: string, data: Buffer | string = 'x') {
  const abs = path.join(root, 'scratch', name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  return abs;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlib-'));
  clearLibraryCache();
  setLibraryDeps({
    probeDuration: async () => 12.5,
    fontInfo: (file) => ({ family: path.basename(file).startsWith('Be') ? 'Be Vietnam Pro' : 'Demo Sans', style: /Bold/.test(file) ? 'Bold' : 'Regular', weight: /Bold/.test(file) ? 700 : 400, italic: false }),
  });
});
afterEach(() => { setLibraryDeps(null); fs.rmSync(root, { recursive: true, force: true }); });

describe('builtin catalog merge', () => {
  it('lists builtin entries without files as unavailable', () => {
    const all = getLibrary(root);
    expect(all.filter((a) => a.kind === 'sfx')).toHaveLength(11);
    expect(all.filter((a) => a.kind === 'bgm')).toHaveLength(6);
    expect(all.filter((a) => a.kind === 'font')).toHaveLength(60);
    expect(all.find((a) => a.id === 'sfx:whoosh')).toMatchObject({ source: 'builtin', available: false });
    expect(all.filter((a) => a.kind === 'lut').map((a) => a.id)).toEqual(expect.arrayContaining(['lut:warm-film', 'lut:teal-orange', 'lut:bw']));
  });

  it('adopts a dropped file named like a builtin entry', () => {
    put('sfx/whoosh.mp3');
    const whoosh = getLibrary(root).find((a) => a.id === 'sfx:whoosh')!;
    expect(whoosh).toMatchObject({ source: 'library', available: true, file: 'sfx/whoosh.mp3', name: 'whoosh' });
    expect(whoosh.license).toMatch(/chưa rõ/);
  });

  it('seed entries overlay the builtin entry and keep its id', () => {
    const asset = installSeedAsset(root, {
      id: 'sfx:ding', kind: 'sfx', durationSec: 1.4, files: [{ tempPath: tmp('ding.mp3', MP3), relName: 'ding.mp3' }],
      meta: { name: 'Ding', description: 'Chuông ngắn.', license: 'tự tổng hợp (CC0)' },
    });
    expect(asset).toMatchObject({ id: 'sfx:ding', source: 'seed', available: true });
    expect(isSeedInstalled(root, 'sfx:ding')).toBe(true);
    const merged = findAsset(root, 'sfx:ding')!;
    expect(merged).toMatchObject({ available: true, license: 'tự tổng hợp (CC0)', file: 'sfx/ding.mp3', durationSec: 1.4 });
    expect(assetFilePath(root, merged)).toBe(path.join(libraryDir(root), 'sfx', 'ding.mp3'));
    expect(getLibrary(root).filter((a) => a.id === 'sfx:ding')).toHaveLength(1);
  });

  it('resolves a builtin mood to the first enabled track of that mood', () => {
    installSeedAsset(root, {
      id: 'seed:bgm:zeta', kind: 'bgm', durationSec: 60, files: [{ tempPath: tmp('z.mp3', MP3), relName: 'tap-trung/zeta.mp3' }],
      meta: { name: 'Zeta', mood: 'Tập trung', license: 'CC0 1.0', sourceUrl: 'https://opengameart.org/content/zeta' },
    });
    installSeedAsset(root, {
      id: 'seed:bgm:alpha', kind: 'bgm', durationSec: 90, files: [{ tempPath: tmp('a.mp3', MP3), relName: 'tap-trung/alpha.mp3' }],
      meta: { name: 'Alpha', mood: 'Tập trung', license: 'CC0 1.0' },
    });
    const mood = findAsset(root, 'bgm:tap-trung')!;
    expect(mood).toMatchObject({ available: true, aliasOf: 'seed:bgm:alpha', file: 'bgm/tap-trung/alpha.mp3', durationSec: 90 });
    updateAsset(root, 'seed:bgm:alpha', { enabled: false });
    expect(findAsset(root, 'bgm:tap-trung')!.aliasOf).toBe('seed:bgm:zeta');
    expect(findAsset(root, 'bgm:nang-luong')!.available).toBe(false);
  });
});

describe('discovery and rescan', () => {
  it('registers unknown files with the default licence and subfolder tags, and prunes missing ones', async () => {
    put('bgm/vui/Chill Vibes.mp3');
    put('lut/film.cube', 'LUT_3D_SIZE 2');
    put('sfx/readme.txt');
    put('sfx/.hidden.mp3');
    const lib = getLibrary(root);
    const chill = lib.find((a) => a.id === 'lib:bgm:chill-vibes')!;
    expect(chill).toMatchObject({ kind: 'bgm', source: 'library', tags: ['vui'], license: 'chưa rõ — do bạn thêm' });
    expect(lib.find((a) => a.id === 'lib:lut:film')).toBeDefined();
    expect(lib.some((a) => a.name === 'readme' || a.name === '.hidden')).toBe(false);

    await enrichLibrary(root);
    expect(findAsset(root, 'lib:bgm:chill-vibes')!.durationSec).toBe(12.5);

    fs.rmSync(path.join(libraryDir(root), 'bgm/vui/Chill Vibes.mp3'));
    const r = await rescanLibrary(root);
    expect(r.removed).toBe(1);
    expect(findAsset(root, 'lib:bgm:chill-vibes')).toBeUndefined();
  });

  it('reads the family of a dropped font and groups faces in listFonts', () => {
    put('font/BeVietnamPro-Regular.ttf', TTF);
    put('font/BeVietnamPro-Bold.ttf', TTF);
    const fonts = listFonts(root);
    expect(fonts).toHaveLength(1);
    expect(fonts[0].family).toBe('Be Vietnam Pro');
    expect(fonts[0].faces.map((f) => f.weight).sort()).toEqual([400, 700]);
    expect(path.isAbsolute(fonts[0].faces[0].file)).toBe(true);
  });

  it('survives a corrupt manifest', () => {
    put('sfx/pop-up.mp3');
    getLibrary(root);
    fs.writeFileSync(path.join(libraryDir(root), 'manifest.json'), '{not json');
    clearLibraryCache();
    expect(getLibrary(root).find((a) => a.id === 'lib:sfx:pop-up')).toBeDefined();
  });
});

describe('add, update, delete', () => {
  it('adds an upload with a probed duration and unique names', async () => {
    const a = await addFile(root, { kind: 'sfx', tempPath: tmp('tieng chuong.mp3', MP3), fileName: 'tiếng chuông.mp3' });
    expect(a).toMatchObject({ id: 'lib:sfx:tieng-chuong', source: 'library', durationSec: 12.5, file: 'sfx/tiếng chuông.mp3' });
    const b = await addFile(root, { kind: 'sfx', tempPath: tmp('2.mp3', MP3), fileName: 'tiếng chuông.mp3', meta: { license: 'CC0', tags: ['a'] } });
    expect(b.id).toBe('lib:sfx:tieng-chuong-2');
    expect(b.file).toBe('sfx/tiếng chuông-2.mp3');
    expect(b).toMatchObject({ license: 'CC0', tags: ['a'] });
  });

  it('rejects a wrong extension and kinds without files', async () => {
    await expect(addFile(root, { kind: 'font', tempPath: tmp('x.mp3', MP3), fileName: 'x.mp3' })).rejects.toMatchObject({ status: 415 });
    await expect(addFile(root, { kind: 'effect', tempPath: tmp('x.mp3', MP3), fileName: 'x.mp3' })).rejects.toMatchObject({ status: 400 });
  });

  it('detects the family name of an uploaded font', async () => {
    const a = await addFile(root, { kind: 'font', tempPath: tmp('f.ttf', TTF), fileName: 'DemoSans-Bold.ttf' });
    expect(a).toMatchObject({ family: 'Demo Sans', name: 'Demo Sans Bold' });
    expect(a.faces?.[0]).toMatchObject({ weight: 700, style: 'normal' });
  });

  it('patches metadata, clears fields with null and overrides builtin entries', () => {
    const a = updateAsset(root, 'sfx:ding', { enabled: false, license: 'tự có', tags: ['x'] });
    expect(a).toMatchObject({ enabled: false, license: 'tự có', tags: ['x'], name: 'Ding', source: 'builtin' });
    const cleared = updateAsset(root, 'sfx:ding', { license: null });
    expect(cleared.license).toMatch(/cần bổ sung/);
    expect(() => updateAsset(root, 'nope', { name: 'x' })).toThrowError(/Không tìm thấy/);
  });

  it('deletes library files with their empty folders, and only disables a builtin without a file', async () => {
    const a = await addFile(root, { kind: 'bgm', tempPath: tmp('b.mp3', MP3), fileName: 'b.mp3' });
    const abs = assetFilePath(root, a)!;
    expect(deleteAsset(root, a.id).deleted).toBe(true);
    expect(fs.existsSync(abs)).toBe(false);
    expect(findAsset(root, a.id)).toBeUndefined();

    const r = deleteAsset(root, 'effect:keyword-pop');
    expect(r.deleted).toBe(false);
    expect(r.asset.enabled).toBe(false);
    expect(findAsset(root, 'effect:keyword-pop')).toBeDefined();
  });

  it('counts files and bytes', async () => {
    await addFile(root, { kind: 'sfx', tempPath: tmp('c.mp3', MP3), fileName: 'c.mp3' });
    const stats = libraryStats(root);
    expect(stats.byKind.sfx).toBe(1);
    expect(stats.bytes).toBe(MP3.length);
  });
});

describe('paths', () => {
  it('never resolves outside the library folder', () => {
    expect(resolveLibraryFile(root, '../../etc/passwd')).toBeNull();
    expect(resolveLibraryFile(root, '/etc/passwd')).toBeNull();
    expect(resolveLibraryFile(root, 'sfx/a.mp3')).toBe(path.join(libraryDir(root), 'sfx', 'a.mp3'));
    expect(assetFilePath(root, { file: '../manifest.json' })).toBeNull();
  });
});

describe('Asset Hub index', () => {
  it('stores index results, on a builtin entry too, and keeps them across reads', async () => {
    const clip = await addFile(root, { kind: 'video', tempPath: tmp('c.mp4', 'v'), fileName: 'c.mp4', meta: { projectId: 'p1' } });
    expect(clip.projectId).toBe('p1');
    const saved = recordAssetIndex(root, clip.id, { caption: 'Rót cà phê', quality: 0.8, indexedAt: '2026-10-25T00:00:00Z' });
    expect(saved).toMatchObject({ caption: 'Rót cà phê', quality: 0.8, available: true });
    clearLibraryCache();
    expect(findAsset(root, clip.id)).toMatchObject({ caption: 'Rót cà phê', quality: 0.8, indexedAt: '2026-10-25T00:00:00Z' });

    expect(recordAssetIndex(root, 'bgm:tap-trung', { genre: 'BGM' })).toMatchObject({ id: 'bgm:tap-trung', genre: 'BGM', mood: 'Tập trung' });
    expect(() => recordAssetIndex(root, 'lib:video:none', { caption: 'x' })).toThrow(LibraryError);
  });

  it('tells listeners about added and dropped-in files', async () => {
    const seen: string[] = [];
    const stop = onLibraryAdded((r, assets) => { if (r === root) seen.push(...assets.map((a) => a.id)); });
    const a = await addFile(root, { kind: 'image', tempPath: tmp('a.png', 'p'), fileName: 'a.png' });
    put('video/dropped.mp4', 'v');
    getLibrary(root);
    stop();
    await addFile(root, { kind: 'image', tempPath: tmp('b.png', 'p'), fileName: 'b.png' });
    expect(seen).toEqual([a.id, 'lib:video:dropped']);
  });
});
