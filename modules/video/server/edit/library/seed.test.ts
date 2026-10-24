import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LUT_SPECS, buildCube } from './luts.js';
import { parseFontMetadata, pickFontFiles, runSeedToEnd, getSeedStatus, type SeedDeps } from './seed.js';
import { clearLibraryCache, findAsset, libraryDir, listFonts, setLibraryDeps } from './store.js';
import { SYNTH_RECIPES } from './synth.js';

const TTF = Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(200)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200)]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(200)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);

const meta = (license: string, subsets: string[], fonts: string) =>
  `name: "X"\nlicense: "${license}"\n${fonts}\n${subsets.map((s) => `subsets: "${s}"`).join('\n')}\naxes {\n  tag: "wght"\n  min_value: 300.0\n  max_value: 900.0\n}\n`;
const font = (style: string, weight: number, filename: string) => `fonts {\n  name: "X"\n  style: "${style}"\n  weight: ${weight}\n  filename: "${filename}"\n}`;

let root: string;
const calls: string[] = [];

function fakeFetch(extra: Record<string, () => Response> = {}): SeedDeps['fetchImpl'] {
  const kenneyZip = new AdmZip();
  kenneyZip.addFile('Audio/click_001.ogg', OGG);
  kenneyZip.addFile('Audio/click_002.ogg', OGG);
  const zipBuf = kenneyZip.toBuffer();
  const routes: Record<string, () => Response> = {
    'raw.githubusercontent.com/google/fonts/main/ofl/demosans/METADATA.pb': () => new Response(meta('OFL', ['latin', 'vietnamese'], [font('normal', 400, 'DemoSans-Regular.ttf'), font('normal', 700, 'DemoSans-Bold.ttf'), font('italic', 400, 'DemoSans-Italic.ttf')].join('\n'))),
    'raw.githubusercontent.com/google/fonts/main/ofl/demosans/DemoSans-Regular.ttf': () => new Response(TTF),
    'raw.githubusercontent.com/google/fonts/main/ofl/demosans/DemoSans-Bold.ttf': () => new Response(TTF),
    'raw.githubusercontent.com/google/fonts/main/ofl/demosans/OFL.txt': () => new Response('SIL OPEN FONT LICENSE Version 1.1'),
    'raw.githubusercontent.com/google/fonts/main/ofl/latinonly/METADATA.pb': () => new Response(meta('OFL', ['latin'], font('normal', 400, 'LatinOnly-Regular.ttf'))),
    'raw.githubusercontent.com/google/fonts/main/ofl/restricted/METADATA.pb': () => new Response(meta('UFL', ['vietnamese'], font('normal', 400, 'R.ttf'))),
    'raw.githubusercontent.com/google/fonts/main/ofl/varfont/METADATA.pb': () => new Response(meta('OFL', ['vietnamese'], font('normal', 400, 'VarFont[wght].ttf'))),
    'raw.githubusercontent.com/google/fonts/main/ofl/varfont/VarFont%5Bwght%5D.ttf': () => new Response(TTF),
    'raw.githubusercontent.com/google/fonts/main/ofl/fake/METADATA.pb': () => new Response(meta('OFL', ['vietnamese'], font('normal', 400, 'Fake-Regular.ttf'))),
    'raw.githubusercontent.com/google/fonts/main/ofl/fake/Fake-Regular.ttf': () => new Response('<html>not a font</html>'),
    'kenney.nl/assets/interface-sounds': () => new Response('<a href="https://kenney.nl/media/pages/assets/interface-sounds/x/k.zip">zip</a>'),
    'kenney.nl/media/pages/assets/interface-sounds/x/k.zip': () => new Response(zipBuf),
    'opengameart.org/sites/default/files/song.mp3': () => new Response(MP3),
    'raw.githubusercontent.com/googlefonts/noto-emoji/main/2D/png/128/emoji_u1f525.png': () => new Response(PNG),
    'raw.githubusercontent.com/googlefonts/noto-emoji/main/2D/png/128/emoji_u2b50.png': () => new Response('missing', { status: 404 }),
    'raw.githubusercontent.com/googlefonts/noto-emoji/main/2D/svg/LICENSE': () => new Response('Apache License 2.0'),
    ...extra,
  };
  return async (input) => {
    const u = new URL(input);
    const key = `${u.host}${u.pathname}`;
    calls.push(key);
    const h = routes[key];
    return h ? h() : new Response('nope', { status: 404 });
  };
}

const deps = (over: Partial<SeedDeps> = {}): SeedDeps => ({
  fetchImpl: fakeFetch(),
  skipFfmpeg: true,
  retryDelayMs: 1,
  fonts: [
    { family: 'Demo Sans', category: 'sans', note: 'Mẫu.' }, { family: 'Latin Only', category: 'sans', note: '' },
    { family: 'Restricted', category: 'sans', note: '' }, { family: 'Var Font', category: 'display', note: '' }, { family: 'Fake', category: 'sans', note: '' },
  ],
  kenney: [{
    pack: 'interface-sounds', title: 'Kenney Interface Sounds', page: 'https://kenney.nl/assets/interface-sounds', fallbackZip: 'https://kenney.nl/none.zip',
    entries: [
      { file: 'click_001', slug: 'click-1', name: 'Bấm 1', tags: ['click'] },
      { file: 'click_002', slug: 'click-2', name: 'Click chuột', tags: ['click'], builtin: 'mouse-click' },
      { file: 'click_009', slug: 'click-9', name: 'Không có', tags: [] },
    ],
  }],
  music: [{
    slug: 'song', title: 'Song', author: 'Someone', mood: { slug: 'tap-trung', label: 'Tập trung' }, description: 'Nhạc thử.', license: 'CC0 1.0 (OpenGameArt)',
    pageUrl: 'https://opengameart.org/content/song', fileUrl: 'https://opengameart.org/sites/default/files/song.mp3',
  }],
  stickers: [{ hex: '1f525', name: 'Lửa', tags: ['hot'] }, { hex: '2b50', name: 'Sao', tags: [] }],
  ...over,
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vseed-'));
  clearLibraryCache();
  calls.length = 0;
  setLibraryDeps({ probeDuration: async () => 30 });
});
afterEach(() => { setLibraryDeps(null); fs.rmSync(root, { recursive: true, force: true }); });

describe('font metadata', () => {
  it('parses licence, subsets, faces and the weight axis', () => {
    const m = parseFontMetadata(meta('OFL', ['latin', 'vietnamese'], font('normal', 400, 'A-Regular.ttf')));
    expect(m).toMatchObject({ license: 'OFL', subsets: ['latin', 'vietnamese'], wght: { min: 300, max: 900 } });
    expect(m.fonts).toEqual([{ style: 'normal', weight: 400, filename: 'A-Regular.ttf' }]);
  });

  it('picks the upright variable file, else 400/700/900 and never italics', () => {
    const v = pickFontFiles({ license: 'OFL', subsets: [], fonts: [{ style: 'italic', weight: 400, filename: 'A-Italic[wght].ttf' }, { style: 'normal', weight: 400, filename: 'A[wght].ttf' }] });
    expect(v).toEqual([{ file: { style: 'normal', weight: 400, filename: 'A[wght].ttf' }, variable: true }]);
    const s = pickFontFiles({ license: 'OFL', subsets: [], fonts: [100, 400, 500, 700, 800, 900].map((w) => ({ style: 'normal', weight: w, filename: `A-${w}.ttf` })).concat([{ style: 'italic', weight: 400, filename: 'A-I.ttf' }]) });
    expect(s.map((x) => x.file.weight)).toEqual([400, 700, 900]);
    const one = pickFontFiles({ license: 'OFL', subsets: [], fonts: [{ style: 'normal', weight: 300, filename: 'L.ttf' }, { style: 'normal', weight: 700, filename: 'B.ttf' }] });
    expect(one.map((x) => x.file.weight)).toEqual([300, 700]);
  });
});

describe('LUTs', () => {
  it('writes valid 33^3 cube files for every spec', () => {
    expect(LUT_SPECS.map((s) => s.slug)).toEqual(['warm-film', 'cool-tech', 'clean-bright', 'teal-orange', 'bw', 'contrast', 'fade']);
    for (const spec of LUT_SPECS) {
      const lines = buildCube(spec.name, spec.grade).split('\n').filter(Boolean);
      expect(lines[1]).toBe('LUT_3D_SIZE 33');
      const rows = lines.slice(4);
      expect(rows).toHaveLength(33 ** 3);
      for (const row of rows.slice(0, 200)) for (const v of row.split(' ').map(Number)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    }
    const bw = LUT_SPECS.find((s) => s.slug === 'bw')!.grade([0.9, 0.2, 0.1]);
    expect(bw[0]).toBeCloseTo(bw[1]);
    expect(bw[1]).toBeCloseTo(bw[2]);
  });
  it('has a recipe per synthesised builtin sfx', () => {
    expect(SYNTH_RECIPES.map((r) => r.slug).sort()).toEqual(['bubble', 'ding', 'glitch', 'pop', 'riser', 'sub-drop', 'tick-tock', 'whoosh']);
  });
});

describe('starter pack run', () => {
  it('installs every group, skipping what does not qualify, and records licences', async () => {
    const status = await runSeedToEnd(root, { deps: deps() });
    expect(status.state).toBe('done');

    // fonts: Demo Sans (2 static faces) and Var Font installed; latin-only, UFL and a non-font skipped
    const fonts = listFonts(root);
    expect(fonts.map((f) => f.family).sort()).toEqual(['Demo Sans', 'Var Font']);
    expect(fonts.find((f) => f.family === 'Demo Sans')!.faces.map((f) => f.weight)).toEqual([400, 700]);
    const varFace = fonts.find((f) => f.family === 'Var Font')!.faces[0];
    expect(varFace).toMatchObject({ variable: true, weightMin: 300, weightMax: 900 });
    const demo = findAsset(root, 'font:demo-sans')!;
    expect(demo).toMatchObject({ source: 'seed', license: 'SIL OFL 1.1', name: 'Demo Sans', file: 'font/demo-sans/DemoSans-Regular.ttf' });
    expect(demo.sourceUrl).toBe('https://github.com/google/fonts/tree/main/ofl/demosans');
    expect(fs.existsSync(path.join(libraryDir(root), 'font/demo-sans/OFL.txt'))).toBe(true);
    expect(status.skipped.map((s) => s.item)).toEqual(expect.arrayContaining(['Latin Only', 'Restricted', 'Fake']));
    expect(status.skipped.find((s) => s.item === 'Restricted')!.reason).toMatch(/UFL/);
    expect(status.skipped.find((s) => s.item === 'Fake')!.reason).toMatch(/không phải/);

    // sfx: builtin id kept, other Kenney clips added under seed:
    expect(findAsset(root, 'sfx:mouse-click')).toMatchObject({ source: 'seed', available: true, name: 'Click chuột', license: 'CC0 1.0 (Kenney)', sourceUrl: 'https://kenney.nl/assets/interface-sounds' });
    expect(findAsset(root, 'seed:sfx:kenney-click-1')).toMatchObject({ available: true, file: 'sfx/kenney-click-1.ogg' });
    expect(status.skipped.some((s) => /Không có/.test(s.item))).toBe(true);

    // music, luts, stickers
    expect(findAsset(root, 'seed:bgm:song')).toMatchObject({ mood: 'Tập trung', durationSec: 30, license: 'CC0 1.0 (OpenGameArt)', sourceUrl: 'https://opengameart.org/content/song', file: 'bgm/tap-trung/song.mp3' });
    expect(findAsset(root, 'bgm:tap-trung')).toMatchObject({ available: true, aliasOf: 'seed:bgm:song' });
    expect(findAsset(root, 'lut:teal-orange')).toMatchObject({ source: 'seed', license: 'tự tạo', available: true });
    expect(fs.readFileSync(path.join(libraryDir(root), 'lut/bw.cube'), 'utf8')).toContain('LUT_3D_SIZE 33');
    expect(findAsset(root, 'seed:image:emoji-1f525')).toMatchObject({ kind: 'image', license: 'Apache-2.0 (Noto Emoji)' });
    expect(findAsset(root, 'seed:image:emoji-2b50')).toBeUndefined();

    expect(status.counts.font).toBe(2);
    expect(status.counts.lut).toBe(7);
    expect(status.progress.done).toBe(status.progress.total);
    expect(fs.readdirSync(path.join(libraryDir(root), '.tmp')).filter((n) => !n.endsWith('.part'))).toEqual([]);
  });

  it('is idempotent: a second run downloads nothing it already has', async () => {
    await runSeedToEnd(root, { deps: deps() });
    calls.length = 0;
    const again = await runSeedToEnd(root, { deps: deps() });
    expect(again.state).toBe('done');
    // Only items that failed or never existed are asked for again.
    expect(calls.filter((c) => /DemoSans|VarFont|song\.mp3|emoji_u1f525|OFL\.txt/.test(c))).toEqual([]);
  });

  it('enforces the total size cap and the per-file type check', async () => {
    const status = await runSeedToEnd(root, { groups: ['fonts'], deps: deps({ maxTotalBytes: 300 }) });
    expect(status.counts.font ?? 0).toBeLessThanOrEqual(1);
    expect(status.skipped.some((s) => /giới hạn|quá lớn/.test(s.reason))).toBe(true);
  });

  it('continues a partial download with a Range request', async () => {
    const url = 'https://opengameart.org/sites/default/files/song.mp3';
    let range = '';
    const fetchImpl: SeedDeps['fetchImpl'] = async (input, init) => {
      if (input === url) {
        range = String((init?.headers as Record<string, string> | undefined)?.Range ?? '');
        return range ? new Response(MP3.subarray(100), { status: 206 }) : new Response(MP3);
      }
      return new Response('', { status: 404 });
    };
    const key = (await import('node:crypto')).createHash('sha1').update(url).digest('hex').slice(0, 16);
    fs.mkdirSync(path.join(libraryDir(root), '.tmp'), { recursive: true });
    fs.writeFileSync(path.join(libraryDir(root), '.tmp', `${key}.part`), MP3.subarray(0, 100));
    await runSeedToEnd(root, { groups: ['music'], deps: deps({ fetchImpl }) });
    expect(range).toBe('bytes=100-');
    expect(fs.readFileSync(path.join(libraryDir(root), 'bgm/tap-trung/song.mp3'))).toEqual(MP3);
  });

  it('keeps the last result readable after the job ends', async () => {
    await runSeedToEnd(root, { groups: ['luts'], deps: deps() });
    expect(getSeedStatus(root)).toMatchObject({ state: 'done', groups: ['luts'] });
  });
});
