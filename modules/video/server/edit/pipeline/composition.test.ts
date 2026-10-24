import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EditPlan, Transcript } from '../types.js';
import { buildComposition, resolveEffect } from './composition.js';
import { derivePlan } from './plan.js';
import type { AssetResolver } from './library-resolve.js';

const T: Transcript = {
  language: 'vi', model: 't', durationSec: 8, createdAt: 'x',
  words: [
    ['Giảm', 0.2, 0.5], ['50%', 0.5, 1.0], ['hôm', 1.1, 1.3], ['nay', 1.3, 1.6], ['ờ', 1.7, 2.0], ['<b>mua</b>', 3.0, 3.4], ['ngay', 3.4, 3.8],
  ].map(([text, start, end], i) => ({ i, text: text as string, start: start as number, end: end as number })),
};

const none: AssetResolver = { byId: () => null, font: () => null };
const withAudio: AssetResolver = {
  byId: (id) => (id === 'bgm:x' ? { id, kind: 'bgm', name: 'x', file: '/lib/x.mp3', ext: 'mp3', durationSec: 60 } : null),
  font: () => null,
};

function plan(extra: Partial<EditPlan> = {}): EditPlan {
  const base: EditPlan = {
    version: 1, createdAt: 'x', styleId: '', aspect: '9:16', summary: '', sourceDurationSec: 8, outputDurationSec: 8,
    cutWords: [4], gapMs: 250, keep: [], removed: [], brolls: [],
    captions: { styleId: 'bottom-clean', position: 'bottom', highlight: ['50%'], maxWordsPerChunk: 3 },
    overlays: [], zooms: [], sfx: [], covers: [], meta: { title: 't', caption: '', hashtags: [] }, author: 'auto',
  };
  return derivePlan({ ...base, ...extra }, { transcript: T });
}

const build = (p: EditPlan, mode: 'preview' | 'export' = 'preview', resolver = none) =>
  buildComposition({ plan: p, transcript: T, project: { code: 'V', title: 't', aspect: '9:16' }, profile: { brand: {}, audio: { speechRate: 1, voiceLufs: -16, musicLufs: -34, finalLufs: -15.5 } }, mode, resolver });

describe('buildComposition', () => {
  it('emits one video clip per kept range, preview media and a registered timeline', () => {
    const b = build(plan());
    expect(b.width).toBe(1080);
    expect(b.height).toBe(1920);
    const clips = b.html.match(/<video id="v\d+"/g) ?? [];
    expect(clips.length).toBe(b.stats.segments);
    expect(b.html).toContain('src="../source/proxy.mp4"');
    expect(b.html).toContain('data-has-audio="true"');
    expect(b.html).toContain('data-composition-id="main"');
    expect(b.html).toContain('window.__timelines["main"]=tl');
    expect(b.durationSec).toBeCloseTo(plan().outputDurationSec, 2);
  });

  it('uses the master through assets/ for export', () => {
    const b = build(plan(), 'export');
    expect(b.html).toContain('src="assets/master.mp4"');
    expect(b.assets).toContainEqual({ name: 'master.mp4', file: '@master' });
  });

  it('chunks captions inside segments, highlights words and escapes text', () => {
    const b = build(plan());
    expect(b.stats.captions).toBeGreaterThan(1);
    expect(b.html).toContain('&lt;b&gt;mua&lt;/b&gt;');
    expect(b.html).not.toContain('<b>mua</b>');
    expect(b.html).toMatch(/color:#FFD23F[^>]*>50%/);
    expect(b.html).not.toContain('>ờ<');
  });

  it('maps the six built-in effects, aliases, and skips unknown ones with a warning', () => {
    const props = { small: 'a', big: 'b', text: 't', value: '50%', title: 'T', items: ['x', 'y'], labelA: 'A', textA: 'ta', labelB: 'B', textB: 'tb' };
    const p = plan({ overlays: ['two-tier-title', 'keyword-pop', 'big-number', 'stacked-list', 'compare-ab', 'cta-button', 'count-up', 'wobble'].map((effect, i) => ({ id: `o${i}`, effect, anchorWord: 0, at: 0, duration: 1, props })) });
    const b = build(p);
    expect(b.stats.overlays).toBe(7);
    expect(b.warnings.join(' ')).toContain('wobble');
    expect(b.html).toContain('>ta<');
    expect(b.html).toContain('>tb<');
    expect(resolveEffect('effect:count-up')).toBe('big-number');
    expect(resolveEffect('nope')).toBeNull();
  });

  it('drops overlays anchored on cut words, shows B-roll placeholder in preview only', () => {
    const p = plan({
      overlays: [{ id: 'o', effect: 'keyword-pop', anchorWord: 4, at: 0, duration: 1, props: { text: 'x' } }],
      brolls: [{ id: 'b', anchorWord: 2, duration: 1.5, title: 'Cảnh hub', reason: '', source: 'library', layout: 'card', enabled: true }],
    });
    const pv = build(p, 'preview');
    expect(pv.stats.overlays).toBe(0);
    expect(pv.stats.brolls).toBe(1);
    expect(pv.html).toContain('chưa có file');
    const ex = build(p, 'export');
    expect(ex.stats.brolls).toBe(0);
    expect(ex.warnings.join(' ')).toContain('Cảnh hub');
  });

  it('places a transparent Pexels cutout above the speaker without a card and blocks opaque photos', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-cutout-'));
    try {
      const png = path.join(dir, 'cutout.png');
      fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64'));
      const cutout = { id: 'b', anchorWord: 2, duration: 1.5, title: 'Trứng', reason: 'Khi nói trứng', source: 'pexels' as const, layout: 'cutout' as const, box: { x: 20, y: 5, w: 60, h: 22 }, enabled: true, assetId: 'image:egg' };
      const resolver: AssetResolver = { byId: () => ({ id: 'image:egg', kind: 'image', name: 'Trứng', file: png, ext: 'png' }), font: () => null };
      const b = build(plan({ brolls: [cutout] }), 'export', resolver);
      expect(b.stats.brolls).toBe(1);
      expect(b.html).toContain('left:20%;top:5%;width:60%;height:22%');
      expect(b.html).toContain('object-fit:contain');
      expect(b.html).not.toContain('border-radius:34px');
      fs.writeFileSync(png, Buffer.from('opaque'));
      expect(() => build(plan({ brolls: [cutout] }), 'export', resolver)).toThrow(/PNG tách nền/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('mixes music at the profile level relative to the voice and adds sfx', () => {
    const p = plan({
      music: { assetId: 'bgm:x', mood: 'm', gainDb: -18, duck: true },
      sfx: [{ at: 1, assetId: 'bgm:x' }],
    });
    const b = build(p, 'preview', withAudio);
    expect(b.stats.music).toBe(true);
    expect(b.stats.sfx).toBe(1);
    expect(b.html).toMatch(/<audio id="music"[^>]*data-volume="0\.126"/);
    expect(b.assets.length).toBe(1);
    expect(build(plan({ music: { assetId: 'missing', mood: '', gainDb: -18, duck: true } })).warnings.join(' ')).toContain('missing');
  });

  it('sizes the canvas per aspect', () => {
    const b = buildComposition({ plan: { ...plan(), aspect: '16:9' }, transcript: T, project: { code: 'V', title: 't', aspect: '16:9' }, profile: { brand: {}, audio: { speechRate: 1, voiceLufs: -16, musicLufs: -34, finalLufs: -15.5 } }, mode: 'preview', resolver: none });
    expect([b.width, b.height]).toEqual([1920, 1080]);
  });
});
