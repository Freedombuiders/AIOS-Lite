import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EditPlan, OverridesDoc, Transcript } from '../../types.js';
import { getTemplate } from '../../templates/registry.js';
import { buildComposition, materializeAssets, type BuildInput } from '../composition.js';
import type { AssetResolver, ResolvedAsset } from '../library-resolve.js';
import { derivePlan } from '../plan.js';
import { elementSounds, musicAttrs, placeMusic, snapToBeat, speechRanges } from './audio.js';
import { blockInstance, blockValues, blockVars, type Block } from './blocks.js';
import { captionCues, chunkWords } from './captions.js';

// Two phrases with a long pause (2.0 → 4.0) and a short one (1.0 → 1.1).
const W: [string, number, number][] = [
  ['Làm', 0.1, 0.3], ['video', 0.3, 0.6], ['mất', 0.6, 0.8], ['ba', 0.8, 1.0], ['tiếng.', 1.1, 1.5], ['Hôm', 1.6, 1.8], ['nay', 1.8, 2.0],
  ['chỉ', 4.0, 4.3], ['mười', 4.3, 4.6], ['phút', 4.6, 5.0], ['thôi', 5.0, 5.4], ['ừm', 5.5, 5.8], ['nhé', 5.9, 6.2],
];
const T: Transcript = {
  language: 'vi', model: 't', durationSec: 7, createdAt: 'x',
  words: W.map(([text, start, end], i) => ({ i, text, start, end, ...(text === 'ừm' ? { synthetic: true } : {}) })),
};

const LIB: Record<string, ResolvedAsset> = {
  'bgm:x': { id: 'bgm:x', kind: 'bgm', name: 'Nhạc', file: '/lib/x.mp3', ext: 'mp3', durationSec: 30, beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 29] },
  'bgm:y': { id: 'bgm:y', kind: 'bgm', name: 'Nhạc khác', file: '/lib/y.mp3', ext: 'mp3', durationSec: 20 },
  'sfx:whoosh': { id: 'sfx:whoosh', kind: 'sfx', name: 'whoosh', file: '/lib/whoosh.mp3', ext: 'mp3', durationSec: 0.6 },
  'sfx:pop': { id: 'sfx:pop', kind: 'sfx', name: 'pop', file: '/lib/pop.mp3', ext: 'mp3', durationSec: 0.3 },
  'sfx:typing': { id: 'sfx:typing', kind: 'sfx', name: 'typing', file: '/lib/typing.mp3', ext: 'mp3', durationSec: 0.8 },
  'sfx:ding': { id: 'sfx:ding', kind: 'sfx', name: 'ding', file: '/lib/ding.mp3', ext: 'mp3', durationSec: 0.5 },
  'image:a': { id: 'image:a', kind: 'image', name: 'Ảnh', file: '/lib/a.png', ext: 'png' },
  'video:c': { id: 'video:c', kind: 'video', name: 'Clip', file: '/lib/c.mp4', ext: 'mp4', durationSec: 3 },
  'image:logo': { id: 'image:logo', kind: 'image', name: 'Logo', file: '/lib/logo.png', ext: 'png' },
};
const FONTS = ['anton', 'montserrat'];
const resolver = (fonts = FONTS): AssetResolver => ({
  byId: (id) => LIB[id] ?? null,
  font: (spec) => (spec && fonts.includes(spec.toLowerCase()) ? { id: `font:${spec}`, kind: 'font', name: spec, file: `/lib/${spec}.ttf`, ext: 'ttf' } : null),
});

function plan(extra: Partial<EditPlan> = {}): EditPlan {
  const base: EditPlan = {
    version: 3, createdAt: 'x', styleId: 'kienthuc', aspect: '9:16', summary: '', sourceDurationSec: 7, outputDurationSec: 7,
    cutWords: [], gapMs: 5000, keep: [], removed: [],
    brolls: [
      { id: 'br1', anchorWord: 5, duration: 1.2, title: 'Ảnh', reason: '', source: 'library', layout: 'card', enabled: true, assetId: 'image:a' },
      { id: 'br2', anchorWord: 8, duration: 1, title: 'Clip', reason: '', source: 'library', layout: 'full', enabled: true, assetId: 'video:c' },
    ],
    captions: { styleId: 'caption:th-vang', position: 'bottom', highlight: ['mười phút'], maxWordsPerChunk: 3 },
    overlays: [], zooms: [{ id: 'z1', at: 4.3, duration: 1, scale: 1.1 }], sfx: [], covers: [],
    music: { assetId: 'bgm:x', mood: 'vui', gainDb: -18, duck: true },
    meta: { title: 't', caption: '', hashtags: [] }, author: 'agent',
    planFormat: 2, templateId: 'th-vang',
    beats: [
      { id: 'b1', anchorWord: 0, at: 0, duration: 1.5, component: 'text-beat', kicker: 'SỰ THẬT', title: 'Mất *3 tiếng*', animIn: 'typewriter' },
      { id: 'b2', at: 4.2, duration: 1.5, component: 'text-beat', title: 'Chỉ *10 phút*', animIn: 'pop' },
    ],
    scenes: [{ id: 's1', at: 2.2, duration: 1.6, component: 'scene-steps', props: { step: 0, title: 'Ba *bước*', items: ['Quay', 'Chọn mẫu'] } }],
    graphics: [{ id: 'g1', at: 5.6, duration: 0.6, component: 'logo-end', props: { name: 'Kênh thử' } }],
  };
  return derivePlan({ ...base, ...extra }, { transcript: T });
}

const PROFILE: BuildInput['profile'] = { brand: { logoAssetId: 'image:logo' }, audio: { speechRate: 1, voiceLufs: -16, musicLufs: -34, finalLufs: -15.5 } };
const MUSIC = { mode: 'pick' as const, duck: true, snapToBeat: false, endOnFinal: false };

const build = (p: EditPlan, o: Partial<BuildInput> = {}) => buildComposition({
  plan: p, transcript: T, project: { code: 'V', title: 't', aspect: '9:16', quick: { music: MUSIC } }, profile: PROFILE,
  mode: 'preview', resolver: resolver(), ...o,
});

/** The host slot of one element (or of the hook): its attributes and decoded variable values. */
function slot(html: string, id: string) {
  const tag = new RegExp(`<div id="(?:el-)?${id}"[^>]*>`).exec(html)?.[0];
  if (!tag) return null;
  const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  const values = JSON.parse((attr('data-variable-values') ?? '{}').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'"));
  return { tag, attr, values, start: Number(attr('data-start')), duration: Number(attr('data-duration')) };
}

const overrides = (elements: OverridesDoc['elements'], captions?: OverridesDoc['captions'], music?: OverridesDoc['music']): OverridesDoc =>
  ({ version: 1, elements, ...(captions ? { captions } : {}), ...(music ? { music } : {}), updatedAt: 'x' });

describe('template plans (plan v2) build from the template blocks', () => {
  it('every element gets a host slot with data-el-id, mounting the right component with its props', () => {
    const b = build(plan({ hook: { options: [{ id: 'h', kind: 'number', text: 'Mười phút', mode: 'overlay' }], chosen: 'h' } }));
    for (const id of ['b1', 'b2', 's1', 'g1', 'br1', 'br2']) expect(b.html).toContain(`data-el-id="${id}"`);
    // The hook is plan.hook's chosen option, not a plan element: no data-el-id, so the editor never offers an override.
    expect(slot(b.html, 'hook')!.tag).toMatch(/^<div id="hook" class="clip" data-composition-id="text-beat"/);
    expect(b.html).not.toContain('data-el-id="hook"');
    const expected: Record<string, string> = { hook: 'text-beat', b1: 'text-beat', b2: 'text-beat', s1: 'scene-steps', g1: 'logo-end', br1: 'broll-frame', br2: 'broll-frame' };
    for (const [id, component] of Object.entries(expected)) {
      const s = slot(b.html, id)!;
      expect(s.attr('data-composition-id')).toBe(component);
      const src = s.attr('data-composition-src')!;
      expect(src).toMatch(new RegExp(`^assets/tpl-th-vang-${component}-[0-9a-f]{8}\\.html$`));
      const file = b.assets.find((a) => `assets/${a.name}` === src)!;
      expect(file.content).toContain(`data-composition-id="${component}"`);
      expect(s.attr('data-width')).toBe('1080');
    }
    expect(slot(b.html, 'b1')!.values).toEqual({ kicker: 'SỰ THẬT', title: 'Mất *3 tiếng*', sub: '', animIn: 'typewriter', duration: 1.5 });
    expect(slot(b.html, 's1')!.values).toEqual({ step: 0, title: 'Ba *bước*', items: 'Quay\nChọn mẫu', duration: 1.6 });
    expect(slot(b.html, 'hook')!.values).toMatchObject({ title: 'Mười phút', duration: 2 });
    // The graphic's asset prop takes the channel logo; B-roll gets layout and its file.
    expect(slot(b.html, 'g1')!.values).toMatchObject({ logo: expect.stringMatching(/^assets\/image-logo-/), name: 'Kênh thử' });
    expect(slot(b.html, 'br1')!.values).toMatchObject({ layout: 'card', image: expect.stringMatching(/^assets\/image-a-/) });
    expect(slot(b.html, 'br2')!.values).toMatchObject({ layout: 'full', video: expect.stringMatching(/^assets\/video-c-/) });
    expect(b.stats).toMatchObject({ beats: 2, scenes: 1, graphics: 1, brolls: 2, music: true });
    expect(b.html).not.toContain('id="fx');
    expect(b.html).toContain('data-composition-id="main"');
    expect(b.warnings).toEqual([]);
  });

  it('a video B-roll mounts its own copy of the block with the file as authored src (nested media timing)', () => {
    const b = build(plan());
    const video = b.assets.find((a) => `assets/${a.name}` === slot(b.html, 'br2')!.attr('data-composition-src'))!;
    const image = b.assets.find((a) => `assets/${a.name}` === slot(b.html, 'br1')!.attr('data-composition-src'))!;
    expect(video.name).not.toBe(image.name);
    expect(video.content).toMatch(/<video [^>]*data-var-src="video" src="assets\/video-c-[0-9a-f]+\.mp4"/);
    expect(image.content).not.toMatch(/\ssrc="assets/);
    const block: Block = { componentId: 'x', compositionId: 'x', name: 'tpl-x-x-00000000.html', file: '/x', html: '<video data-var-src="v"></video><img data-var-src="i">', vars: [] };
    expect(blockInstance(block, { i: 'a.png' })).toEqual({ name: block.name, html: block.html });
    expect(blockInstance(block, { v: 'a"b.mp4' }).html).toBe('<video data-var-src="v" src="a&#34;b.mp4"></video><img data-var-src="i">');
  });

  it('applies overrides: words, props, entrance, timing, sound; hidden elements are left out; position and size in the page', () => {
    const doc = overrides({
      b1: { text: { title: 'Sửa *tay*', kicker: '' }, animIn: 'fade', updatedAt: 'x' },
      b2: { hidden: true, updatedAt: 'x' },
      s1: { at: 2.5, duration: 1.2, props: { title: 'Hai *bước*' }, updatedAt: 'x' },
      br1: { props: { layout: 'pip-circle', caption: 'Nguồn: kho' }, t: [5, -10], s: 1.2, updatedAt: 'x' },
      br2: { hidden: true, updatedAt: 'x' },
      z1: { hidden: true, updatedAt: 'x' },
      g1: { sound: { mode: 'none', volume: 1 }, updatedAt: 'x' },
    });
    const b = build(plan(), { overrides: doc });
    expect(slot(b.html, 'b1')!.values).toMatchObject({ kicker: '', title: 'Sửa *tay*', animIn: 'fade' });
    expect(slot(b.html, 'b2')).toBeNull();
    expect(slot(b.html, 'br2')).toBeNull();
    expect(b.html).not.toContain('data-el-id="b2"');
    expect(b.html).not.toContain('scale:1.1');
    const s1 = slot(b.html, 's1')!;
    expect([s1.start, s1.duration]).toEqual([2.5, 1.2]);
    expect(s1.values).toMatchObject({ title: 'Hai *bước*', items: 'Quay\nChọn mẫu', duration: 1.2 });
    expect(slot(b.html, 'br1')!.values).toMatchObject({ layout: 'pip-circle', caption: 'Nguồn: kho' });
    // Offset and size are not baked into the slot; the page applies them with translate/scale after each seek.
    expect(slot(b.html, 'br1')!.tag).not.toContain('translate');
    expect(b.html).toContain('var OV=[{"id":"br1","t":[5,-10],"s":1.2}];');
    expect(b.html).toContain('el.style.setProperty("translate",o.t[0]+"% "+o.t[1]+"%")');
    expect(b.html).toContain('window.addEventListener("hf-seek",applyOverrides);');
    // b1's fade has no sound, so br1's pop is the first automatic sound; g1 was silenced.
    const sfx = (html: string) => [...html.matchAll(/<audio id="sfx\d+"[^>]*src="assets\/sfx-([a-z]+)-[^"]*" data-start="([\d.]+)"/g)].map((m) => `${m[1]}@${m[2]}`);
    expect(sfx(b.html)).toEqual(['pop@1.55']);
    const without = build(plan());
    expect(without.html).toContain('var OV=[];');
    expect(sfx(without.html)).toEqual(['typing@0.05', 'pop@4.2']);
  });

  it('an owner override never reaches a legacy plan', () => {
    const legacy = plan({ templateId: undefined, planFormat: undefined, beats: undefined, scenes: undefined, graphics: undefined });
    const a = build(legacy);
    const b = build(legacy, { overrides: overrides({ br1: { hidden: true, updatedAt: 'x' } }) });
    expect(b.html).toBe(a.html);
    expect(a.html).not.toContain('data-el-id');
  });

  it('a template that is not on this machine falls back to the legacy builder with a warning', () => {
    const b = build(plan({ templateId: 'khong-co' }));
    expect(b.html).not.toContain('data-el-id');
    expect(b.warnings[0]).toContain('khong-co');
  });

  it('skips an unknown component and an entrance the component does not offer, with warnings', () => {
    const b = build(plan({
      beats: [{ id: 'b1', at: 0.2, duration: 1, component: 'nope', title: 'Hai từ' }],
      scenes: [{ id: 's1', at: 2.2, duration: 1.6, component: 'scene-steps', animIn: 'typewriter', props: { title: 'X y', items: ['a', 'b'] } }],
    }));
    expect(slot(b.html, 'b1')).toBeNull();
    expect(slot(b.html, 's1')!.values.animIn).toBeUndefined();
    expect(b.warnings.join('\n')).toMatch(/không có component "nope"/);
    expect(b.warnings.join('\n')).toMatch(/không có hiệu ứng vào "typewriter"/);
  });

  it('exports skip a B-roll without a file; the preview shows the empty frame', () => {
    const p = plan({ brolls: [{ id: 'br9', anchorWord: 5, duration: 1, title: 'Chưa có', reason: '', source: 'pexels', layout: 'card', enabled: true }] });
    expect(slot(build(p).html, 'br9')!.values).toEqual({ layout: 'card', duration: 1 });
    const ex = build(p, { mode: 'export' });
    expect(slot(ex.html, 'br9')).toBeNull();
    expect(ex.warnings.join(' ')).toContain('Chưa có');
    expect(ex.html).toContain('src="assets/master.mp4"');
  });

  it('the owner can swap the file of a B-roll; a file gone from the library leaves the frame empty with a warning', () => {
    const b = build(plan(), { overrides: overrides({ br1: { assetId: 'video:c', updatedAt: 'x' }, br2: { assetId: 'image:a', updatedAt: 'x' } }) });
    const br1 = slot(b.html, 'br1')!;
    expect(br1.values).toMatchObject({ layout: 'card', video: expect.stringMatching(/^assets\/video-c-/) });
    expect(br1.values.image).toBeUndefined();
    // A swapped-in clip gets its own block copy with the authored src, like a planned one.
    expect(b.assets.find((a) => `assets/${a.name}` === br1.attr('data-composition-src'))!.content).toMatch(/data-var-src="video" src="assets\/video-c-/);
    expect(slot(b.html, 'br2')!.values).toMatchObject({ layout: 'full', image: expect.stringMatching(/^assets\/image-a-/) });
    expect(slot(b.html, 'br2')!.values.video).toBeUndefined();
    expect(b.warnings).toEqual([]);

    const gone = overrides({ br1: { assetId: 'image:gone', updatedAt: 'x' } });
    const p = build(plan(), { overrides: gone });
    expect(slot(p.html, 'br1')!.values).toEqual({ layout: 'card', duration: 1.2 });
    expect(p.warnings).toEqual(['B-roll "Ảnh": tư liệu "image:gone" không có trong kho — để trống.']);
    const ex = build(plan(), { overrides: gone, mode: 'export' });
    expect(slot(ex.html, 'br1')).toBeNull();
    expect(ex.warnings).toEqual(['B-roll "Ảnh" chưa có file — bỏ qua khi xuất.']);
  });

  it('the owner can swap the file of a graphic, over the channel logo or a file set in its props', () => {
    const logo = (o: OverridesDoc | null, p = plan()) => slot(build(p, { overrides: o }).html, 'g1')!.values.logo;
    expect(logo(null)).toMatch(/^assets\/image-logo-/);
    expect(logo(overrides({ g1: { assetId: 'image:a', updatedAt: 'x' } }))).toMatch(/^assets\/image-a-/);
    const withProp = plan({ graphics: [{ id: 'g1', at: 5.6, duration: 0.6, component: 'logo-end', props: { name: 'K', logo: 'image:logo' } }] });
    expect(logo(null, withProp)).toMatch(/^assets\/image-logo-/);
    expect(logo(overrides({ g1: { assetId: 'image:a', updatedAt: 'x' } }), withProp)).toMatch(/^assets\/image-a-/);
    const own = plan({ graphics: [{ id: 'g1', at: 5.6, duration: 0.6, component: 'logo-end', assetId: 'image:a', props: { name: 'K' } }] });
    expect(logo(overrides({ g1: { assetId: 'image:logo', updatedAt: 'x' } }), own)).toMatch(/^assets\/image-logo-/);
    const gone = build(plan(), { overrides: overrides({ g1: { assetId: 'image:gone', updatedAt: 'x' } }) });
    expect(slot(gone.html, 'g1')!.values.logo).toBe('');
    expect(gone.warnings).toEqual(['Đồ hoạ "g1": tư liệu "image:gone" không có trong kho — để trống.']);
  });

  it('is deterministic', () => {
    const doc = overrides({ b1: { t: [1, 2], updatedAt: 'x' } });
    const a = build(plan(), { overrides: doc, mode: 'export' });
    const b = build(plan(), { overrides: doc, mode: 'export' });
    expect(b.html).toBe(a.html);
    expect(b.assets).toEqual(a.assets);
  });

  it('writes block files next to the composition and links media', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-comp-v2-'));
    try {
      const b = build(plan(), { mode: 'export' });
      materializeAssets(dir, b.assets, '/m/master.mp4');
      const block = b.assets.find((a) => a.content)!;
      expect(fs.lstatSync(path.join(dir, 'assets', block.name)).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(dir, 'assets', block.name), 'utf8')).toBe(block.content);
      expect(fs.readlinkSync(path.join(dir, 'assets', 'master.mp4'))).toBe('/m/master.mp4');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('fonts', () => {
  it('declares every template family from the library, so the render never fetches web fonts', () => {
    const b = build(plan(), { mode: 'export' });
    expect(b.html).toContain(`@font-face{font-family:'Anton';src:url('assets/font-Anton-`);
    expect(b.html).toContain(`@font-face{font-family:'Montserrat';`);
    expect(b.html).toContain(":root{--th-font-title:'Anton';--th-font-sub:'Montserrat';--th-font-caption:'Montserrat';--th-accent:#FFD23F");
    expect(b.html).not.toMatch(/Be Vietnam Pro|Helvetica|Arial/);
    expect(b.html).toContain('var FONTS=[{"family":"Anton","weight":400},{"family":"Montserrat","weight":700}]');
    expect(b.html).toContain('document.fonts.check(spec(f),SAMPLE)');
    expect(b.html).toContain('window.__hfStartupError=');
    expect(build(plan()).html).not.toContain('window.__hfStartupError=');
  });

  it('a family missing from the library falls back to the generic family, never to a named web font', () => {
    const b = build(plan(), { resolver: resolver(['montserrat']) });
    expect(b.warnings.join(' ')).toMatch(/Font "Anton"/);
    expect(b.html).toContain('--th-font-title:sans-serif');
    expect(b.html).not.toContain("'Anton'");
    expect(b.html).toContain('var FONTS=[{"family":"Montserrat","weight":700}]');
    const none = build(plan(), { resolver: resolver([]) });
    expect(none.html).toContain('font-family:sans-serif');
    expect(none.html).not.toContain('var FONTS');
    expect(none.html).toContain('applyOverrides();\nwindow.__timelines["main"]=tl;\n}\nbuild();');
  });
});

describe('captions', () => {
  const words = (spec: [string, number, number][]) => spec.map(([text, start, end]) => ({ text, start, end }));

  it('chunkWords: two words by default, a pause or punctuation ends a cue, a flash grows to the maximum', () => {
    const texts = (c: { text: string }[][]) => c.map((x) => x.map((w) => w.text).join(' '));
    expect(texts(chunkWords(words([['a', 0, 0.3], ['b', 0.3, 0.6], ['c', 0.6, 0.9], ['d', 0.9, 1.2]]), 3))).toEqual(['a b', 'c d']);
    expect(texts(chunkWords(words([['a', 0, 0.1], ['b', 0.1, 0.2], ['c', 0.2, 0.3], ['d', 0.3, 0.4]]), 3))).toEqual(['a b c', 'd']);
    expect(texts(chunkWords(words([['a', 0, 0.3], ['b', 0.7, 0.9], ['c', 0.9, 1.2]]), 3))).toEqual(['a', 'b c']);
    // A title-case word starts a sentence (whisper adds no punctuation in Vietnamese); names in caps do not.
    expect(texts(chunkWords(words([['này', 0, 0.1], ['Đó', 0.1, 0.2], ['là', 0.2, 0.3]]), 3))).toEqual(['này', 'Đó là']);
    expect(texts(chunkWords(words([['mở', 0, 0.1], ['ChatGPT', 0.1, 0.2], ['AI', 0.2, 0.3]]), 3))).toEqual(['mở ChatGPT AI']);
    expect(texts(chunkWords(words([['a,', 0, 0.1], ['b', 0.1, 0.2], ['c', 0.2, 0.3]]), 3))).toEqual(['a,', 'b c']);
    expect(texts(chunkWords(words([['a', 0, 0.1], ['b', 0.1, 0.2], ['c', 0.2, 0.3]]), 1))).toEqual(['a', 'b', 'c']);
  });

  it('cues never cross a cut, skip synthetic fillers and mark highlighted words', () => {
    const p = plan({ cutWords: [5] });
    const b = build(p);
    const res = captionCues(T.words, [
      { start: 0, end: 1.55, out: 0 }, { start: 1.75, end: 6.3, out: 1.55 },
    ], new Set([5]), ['mười phút'], 3, 6.1);
    const text = res.map((c) => c.words.map((w) => w.text).join(' '));
    expect(text).toEqual(['Làm video', 'mất ba', 'tiếng.', 'nay', 'chỉ mười', 'phút thôi', 'nhé']);
    expect(res.flatMap((c) => c.words).filter((w) => w.key).map((w) => w.text)).toEqual(['mười', 'phút']);
    expect(b.html).not.toContain('>ừm<');
    expect(b.html).toMatch(/class="w k">mười</);
    expect(b.html).not.toContain('>Hôm<');
    expect(b.stats.captions).toBeGreaterThan(4);
  });

  it('follows the template CaptionStyle with the owner caption overrides on top', () => {
    const b = build(plan());
    expect(b.html).toContain('.cap{position:absolute;left:0;right:0;top:76%;');
    expect(b.html).toMatch(/\.cap-in\{[^}]*font-family:'Montserrat',sans-serif;font-weight:800;font-size:66\.96px;[^}]*-webkit-text-stroke:4px #000000/);
    expect(b.html).toContain('.cap .k{color:#FFD23F}');
    const o = build(plan(), { overrides: overrides({}, { pos: 0.5, highlight: { color: '#00FF00', mode: 'box' }, maxWordsPerChunk: 1, fill: '#fff;}body{x' }) });
    expect(o.html).toContain('top:50%');
    expect(o.html).toMatch(/\.cap \.k\{background:#00FF00;color:#141416/);
    expect(o.html).toContain('color:#fffbodyx');
    expect(o.stats.captions).toBeGreaterThan(b.stats.captions);
  });
});

describe('music, beats and sounds', () => {
  it('ducks the bed under the voice with a volume lane and carve dips, louder in the long pause', () => {
    const b = build(plan());
    const tag = /<audio id="music"[^>]*>/.exec(b.html)![0];
    expect(tag).not.toContain('data-volume');
    const lanes = JSON.parse(/data-automation="([^"]*)"/.exec(tag)![1].replace(/&quot;/g, '"')).lanes as { target: string; points: { t: number; v: number }[] }[];
    expect(lanes.map((l) => l.target)).toEqual(['volume', 'fx.n1.gain', 'fx.n2.gain']);
    const at = (t: number) => {
      const pts = lanes[0].points;
      const i = pts.findIndex((p) => p.t >= t);
      return pts[i].t === t ? pts[i].v : pts[i - 1].v + ((pts[i].v - pts[i - 1].v) * (t - pts[i - 1].t)) / (pts[i].t - pts[i - 1].t);
    };
    const speech = at(1);
    const pause = at(3);
    // The profile level (-18 dB) under the voice, 12 dB more in the long pause.
    expect(speech).toBeCloseTo(0.126, 2);
    expect(pause).toBeCloseTo(0.501, 2);
    expect(20 * Math.log10(pause / speech)).toBeCloseTo(12, 0);
    // The bed is already down when the second phrase starts (3.95 on the output timeline): it goes down 0.2 s before.
    expect(at(3.75)).toBeCloseTo(0.501, 2);
    expect(at(3.95)).toBeCloseTo(0.126, 2);
    expect(lanes[0].points[0]).toEqual({ t: 0, v: 0 });
    expect(lanes[0].points[lanes[0].points.length - 1].v).toBe(0);
    expect(lanes[1].points.some((p) => p.v === -6)).toBe(true);
    expect(JSON.parse(/data-fx-chain="([^"]*)"/.exec(tag)![1].replace(/&quot;/g, '"')).nodes.map((n: { id: string }) => n.id)).toEqual(['n1', 'n2']);
  });

  it('without ducking keeps the static level and fades', () => {
    const b = build(plan(), { project: { code: 'V', title: 't', aspect: '9:16', quick: { music: { ...MUSIC, duck: false } } } });
    expect(/<audio id="music"[^>]*>/.exec(b.html)![0]).toMatch(/data-volume="0\.126" data-fade-in="[\d.]+" data-fade-out="[\d.]+"/);
    expect(b.html).not.toContain('data-automation');
  });

  it('the owner music override wins over the Dựng nhanh settings and the plan: track, off, level, ducking', () => {
    const tag = (b: { html: string }) => /<audio id="music"[^>]*>/.exec(b.html)?.[0] ?? null;
    const music = (m: OverridesDoc['music'], o: Partial<BuildInput> = {}, p = plan()) => build(p, { overrides: overrides({}, undefined, m), ...o });
    const quick = (q: Partial<typeof MUSIC>) => ({ project: { code: 'V', title: 't', aspect: '9:16' as const, quick: { music: { ...MUSIC, ...q } } } });

    // Another track, with the plan's level and the settings' ducking.
    const swapped = music({ assetId: 'bgm:y' });
    expect(tag(swapped)).toMatch(/src="assets\/bgm-y-[0-9a-f]+\.mp3" data-start="0"/);
    expect(tag(swapped)).toContain('data-automation');
    // A track for a plan that had none.
    expect(tag(music({ assetId: 'bgm:y' }, {}, plan({ music: undefined })))).toContain('src="assets/bgm-y-');
    expect(music({ assetId: 'bgm:gone' }).warnings).toEqual(['Nhạc "bgm:gone" không có trong kho — bỏ qua.']);

    // Off: no bed, even with a track named; snapToBeat has no beat to snap to.
    const off = music({ off: true, assetId: 'bgm:y' }, quick({ snapToBeat: true }), plan({ beats: [{ id: 'b1', at: 0.8, duration: 1, component: 'text-beat', title: 'Hai từ' }] }));
    expect(tag(off)).toBeNull();
    expect(off.stats.music).toBe(false);
    expect(slot(off.html, 'b1')!.start).toBe(0.8);

    // gainDb fine-tunes around the profile level (-18 dB) instead of the plan's level.
    // The plan's gainDb too: -3 fine-tunes to -21 dB; an old absolute level (≤ -12, here -20) is kept as is.
    expect(tag(build(plan({ music: { assetId: 'bgm:x', mood: 'vui', gainDb: -3, duck: true } }), quick({ duck: false })))).toContain('data-volume="0.089"');
    expect(tag(build(plan({ music: { assetId: 'bgm:x', mood: 'vui', gainDb: -20, duck: true } }), quick({ duck: false })))).toContain('data-volume="0.1"');
    const p10 = plan({ music: { assetId: 'bgm:x', mood: 'vui', gainDb: -10, duck: true } });
    expect(tag(music({ gainDb: 0 }, quick({ duck: false }), p10))).toContain('data-volume="0.126"');
    expect(tag(music({ gainDb: -3 }, quick({ duck: false }), p10))).toContain('data-volume="0.089"');

    // duck: the owner's flag over the settings' flag over the plan's.
    expect(tag(music({ duck: false }))).toMatch(/data-volume="0\.126" data-fade-in/);
    expect(tag(music({ duck: true }, quick({ duck: false })))).toContain('data-automation');
    expect(tag(build(plan(), quick({ duck: false })))).not.toContain('data-automation');
    expect(tag(build(plan(), { project: { code: 'V', title: 't', aspect: '9:16' } }))).toContain('data-automation');
  });

  it('speechRanges merges short pauses and keeps the long one', () => {
    const r = speechRanges(T.words, [{ start: 0, end: 7, out: 0 }], new Set());
    expect(r.map((x) => [x.start, x.end])).toEqual([[0.1, 2], [4, 6.2]]);
  });

  it('endOnFinal enters the track late so its last strong beat lands on the end', () => {
    const warnings: string[] = [];
    const m = placeMusic(LIB['bgm:x'], 7, true, warnings);
    expect(m).toMatchObject({ mediaStart: 22.3, duration: 7, endAligned: true });
    expect(m.beats).toEqual([6.7]);
    expect(placeMusic({ ...LIB['bgm:x'], durationSec: 5 }, 7, true, warnings).endAligned).toBe(false);
    expect(warnings[0]).toContain('ngắn hơn video');
    expect(placeMusic(LIB['bgm:x'], 7, false, []).beats.slice(0, 3)).toEqual([0, 0.5, 1]);
    expect(musicAttrs(m, -18, null)['data-fade-out']).toBe('0.3');
  });

  it('snapToBeat moves beats and scenes onto a beat within 0.5 s, never further, never an owner-set time', () => {
    expect(snapToBeat(1.2, [0, 0.5, 1, 1.5])).toBe(1);
    expect(snapToBeat(1.25, [0, 0.5, 1, 1.5])).toBe(1);
    expect(snapToBeat(2.3, [0, 3])).toBe(2.3);
    expect(snapToBeat(2.5, [0, 3])).toBe(3);
    const snapped = { project: { code: 'V', title: 't', aspect: '9:16' as const, quick: { music: { ...MUSIC, snapToBeat: true } } } };
    const p = plan({
      beats: [{ id: 'b1', at: 0.8, duration: 1, component: 'text-beat', title: 'Hai từ' }, { id: 'b2', at: 4.2, duration: 1, component: 'text-beat', title: 'Ba bốn' }],
      scenes: [{ id: 's1', at: 2.3, duration: 1, component: 'scene-steps', props: { title: 'Ba *bước*', items: ['a', 'b'] } }],
      graphics: [{ id: 'g1', at: 5.7, duration: 0.5, component: 'logo-end', props: { name: 'K' } }],
    });
    const b = build(p, { ...snapped, overrides: overrides({ b2: { at: 4.2, updatedAt: 'x' } }) });
    expect(slot(b.html, 'b1')!.start).toBe(1);
    expect(slot(b.html, 's1')!.start).toBe(2.5);
    expect(slot(b.html, 'b2')!.start).toBe(4.2);
    expect(slot(b.html, 'g1')!.start).toBe(5.7);
    expect(slot(build(p).html, 'b1')!.start).toBe(0.8);
  });

  it('automatic SFX follow the entrance presets and the template density; asset sounds always play', () => {
    const tpl = getTemplate('th-vang')!;
    const cues = elementSounds([
      { id: 'a', kind: 'beat', at: 0, animIn: 'typewriter' },
      { id: 'b', kind: 'beat', at: 1, animIn: 'pop' },
      { id: 'c', kind: 'scene', at: 3.5 },
      { id: 'd', kind: 'beat', at: 4, animIn: 'pop', sound: { mode: 'asset', assetId: 'sfx:ding', volume: 0.5 } },
      { id: 'e', kind: 'beat', at: 8, animIn: 'fade' },
      { id: 'f', kind: 'broll', at: 9, fullFrame: true },
      { id: 'g', kind: 'beat', at: 14, animIn: 'pop', sound: { mode: 'none', volume: 1 } },
    ], tpl);
    expect(cues.map((c) => `${c.id}:${c.assetId}`)).toEqual(['a:sfx:typing', 'c:sfx:whoosh', 'd:sfx:ding', 'f:sfx:whoosh']);
    expect(cues.find((c) => c.id === 'd')!.volume).toBe(0.5);
    expect(elementSounds([{ id: 'a', kind: 'beat', at: 0, animIn: 'pop' }], { ...tpl, sounds: { density: 'none' } })).toEqual([]);
  });

  it('a missing SFX file is reported once and two sounds never share an audio row while both play', () => {
    const b = build(plan({ sfx: [{ at: 0.9, assetId: 'sfx:pop' }, { at: 1, assetId: 'sfx:gone' }, { at: 2, assetId: 'sfx:gone' }] }));
    expect(b.warnings.filter((w) => w.includes('sfx:gone'))).toHaveLength(1);
    const rows = [...b.html.matchAll(/<audio id="sfx\d+"[^>]*data-start="([\d.]+)" data-duration="([\d.]+)"[^>]*data-track-index="(\d+)"/g)]
      .map((m) => ({ start: Number(m[1]), end: Number(m[1]) + Number(m[2]), row: m[3] }));
    expect(rows.length).toBeGreaterThan(1);
    for (const a of rows) for (const c of rows) if (a !== c && a.row === c.row) expect(a.end <= c.start || c.end <= a.start).toBe(true);
  });
});

describe('blocks', () => {
  it('reads declared variables and coerces values to them', () => {
    const vars = blockVars(`<html lang="vi" data-composition-variables='[{"id":"n","type":"number","default":1},{"id":"e","type":"enum","default":"a","options":[{"value":"a"},{"value":"b"}]},{"id":"s","type":"string","default":"x &amp; y"}]'>`);
    expect(vars.map((v) => v.id)).toEqual(['n', 'e', 's']);
    const block: Block = { componentId: 'c', compositionId: 'c', name: 'n', file: 'f', html: '', vars };
    expect(blockValues(block, { s: ['a', 'b'], n: '2.5', e: 'z', extra: 1 })).toEqual({ n: 2.5, s: 'a\nb' });
    expect(blockValues(block, { e: 'b', n: 'x' })).toEqual({ e: 'b' });
    expect(blockVars('<html>')).toEqual([]);
  });
});
