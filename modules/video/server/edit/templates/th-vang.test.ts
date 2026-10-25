// @vitest-environment jsdom
// Blocks of the th-vang pack: valid HTML, HyperFrames sub-composition shape, one paused GSAP timeline,
// determinism. Each block script runs in jsdom against a recording gsap stand-in, the way the HyperFrames
// runtime calls it (document, gsap, window with __hyperframes.getVariables and __timelines).
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'parse5';
import { describe, expect, it } from 'vitest';
import { getTemplate, templateDir } from './registry.js';

const manifest = getTemplate('th-vang')!;
const dir = templateDir('th-vang')!;
const ALL_PRESETS = manifest.animations.map((a) => a.id);

interface Decl { id: string; type: string; default: unknown; options?: { value: string }[] }
interface Call { m: string; targets: string[]; vars: Record<string, unknown>; from?: Record<string, unknown>; at: number }

function load(componentId: string) {
  const file = path.join(dir, manifest.components[componentId].file);
  const html = fs.readFileSync(file, 'utf8');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const decls = JSON.parse(doc.documentElement.getAttribute('data-composition-variables') ?? '[]') as Decl[];
  const template = doc.querySelector('template')!;
  return { html, doc, decls, template };
}

const label = (node: unknown): string => {
  const el = node as Element;
  return el && el.getAttribute ? `${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''}` : String(node);
};

/** Run the block once with `values` over the declared defaults; returns the recorded timeline. */
function run(componentId: string, values: Record<string, unknown>) {
  const { decls, template } = load(componentId);
  const doc = document.implementation.createHTMLDocument('block');
  for (const node of Array.from(template.content.childNodes)) doc.body.appendChild(doc.importNode(node, true));
  const source = doc.body.querySelector('script')!.textContent!;
  const vars = { ...Object.fromEntries(decls.map((d) => [d.id, d.default])), ...values };
  const timelines: { opts: Record<string, unknown>; calls: Call[] }[] = [];
  const gsap = {
    timeline(opts: Record<string, unknown>) {
      const calls: Call[] = [];
      const record = (m: string, t: unknown, vars: Record<string, unknown>, at: number, from?: Record<string, unknown>) => {
        const list = t && typeof t === 'object' && 'length' in (t as object) ? Array.from(t as ArrayLike<unknown>) : [t];
        calls.push({ m, targets: list.map(label), vars, at, ...(from ? { from } : {}) });
      };
      const tl = {
        set: (t: unknown, v: Record<string, unknown>, at: number) => { record('set', t, v, at); return tl; },
        to: (t: unknown, v: Record<string, unknown>, at: number) => { record('to', t, v, at); return tl; },
        from: (t: unknown, v: Record<string, unknown>, at: number) => { record('from', t, v, at); return tl; },
        fromTo: (t: unknown, a: Record<string, unknown>, b: Record<string, unknown>, at: number) => { record('fromTo', t, b, at, a); return tl; },
      };
      timelines.push({ opts, calls });
      return Object.assign(tl, { calls });
    },
  };
  const win = { __hyperframes: { getVariables: () => vars }, __timelines: {} as Record<string, unknown> };
  new Function('document', 'gsap', 'window', source)(doc, gsap, win);
  return { doc, timelines, win, duration: Number(vars.duration) };
}

const SAMPLE: Record<string, Record<string, unknown>> = {
  'text-beat': { kicker: 'BƯỚC 1', title: 'Giá trị *cốt lõi*|của bạn', sub: 'không cần chuẩn bị', duration: 2.4 },
  'scene-steps': { step: 2, title: 'Ba việc *mỗi sáng*', items: '["Uống nước", "Viết *3 việc*", "Tắt thông báo"]', duration: 5 },
  'scene-before-after': { title: 'Edit video', before: 'Cắt tay *3 tiếng*', after: 'AI dựng *10 phút*', afterImage: 'assets/a.png', duration: 4 },
  'broll-frame': { layout: 'pip-circle', video: 'assets/clip.mp4', caption: 'Pexels', duration: 2.5 },
  'logo-end': { name: 'Hoàng Anh AI', handle: '@hoanganh', cta: 'Theo dõi', duration: 3 },
};

describe('th-vang blocks', () => {
  for (const [id, def] of Object.entries(manifest.components)) {
    describe(id, () => {
      const { html, doc, decls, template } = load(id);
      const presets = def.animations ?? ALL_PRESETS;

      it('is valid HTML shaped as a HyperFrames sub-composition', () => {
        const errors: string[] = [];
        parse(html, { onParseError: (e) => { errors.push(`${e.code} @${e.startLine}:${e.startCol}`); } });
        expect(errors).toEqual([]);
        expect(template).toBeTruthy();
        const root = template.content.querySelector('[data-composition-id]')!;
        expect(root.getAttribute('data-composition-id')).toBe(id);
        expect(root.id).toBe('root');
        // No fixed canvas: the block fills the host slot, whatever the aspect.
        expect(root.hasAttribute('data-width') || root.hasAttribute('data-height')).toBe(false);
        // Style and script travel inside <template>: the runtime drops everything outside it.
        expect(template.content.querySelector('style')).toBeTruthy();
        expect(template.content.querySelectorAll('script')).toHaveLength(1);
        expect(doc.head.querySelector('style, script, link')).toBeNull();
      });

      it('registers one paused GSAP timeline under its composition id', () => {
        const source = template.content.querySelector('script')!.textContent!;
        expect(source.match(/gsap\.timeline\(/g)).toHaveLength(1);
        expect(source).toContain('gsap.timeline({ paused: true })');
        expect(source).toContain(`window.__timelines["${id}"] = tl;`);
      });

      it('has no clock, randomness, timers, endless loop or network', () => {
        for (const banned of [/Math\.random/, /requestAnimationFrame/, /setInterval/, /setTimeout/, /Date\.now/, /performance\.now/,
          /repeat:\s*-1/, /https?:\/\//, /@import/, /\bfetch\s*\(/, /XMLHttpRequest/, /@font-face/, /\burl\(/]) {
          expect(html, String(banned)).not.toMatch(banned);
        }
      });

      it('declares a variable for every prop plus duration and animIn', () => {
        const ids = decls.map((d) => d.id);
        for (const prop of Object.keys(def.props)) expect(ids).toContain(prop);
        expect(ids).toEqual(expect.arrayContaining(['duration', 'animIn']));
        const anim = decls.find((d) => d.id === 'animIn')!;
        expect(anim.type).toBe('enum');
        expect(anim.options!.map((o) => o.value).sort()).toEqual([...presets].sort());
        expect(presets).toContain(anim.default);
        for (const d of decls) expect(d.default, d.id).not.toBeUndefined();
      });

      for (const preset of presets) {
        it(`builds a seek-safe, deterministic timeline with animIn "${preset}"`, () => {
          const values = { ...SAMPLE[id], animIn: preset };
          const a = run(id, values);
          expect(a.timelines).toHaveLength(1);
          const [tl] = a.timelines;
          expect(tl.opts).toEqual({ paused: true });
          expect(a.win.__timelines[id]).toBeDefined();
          expect(tl.calls.length).toBeGreaterThan(0);
          for (const c of tl.calls) {
            expect(Number.isFinite(c.at) && c.at >= 0 && c.at < a.duration, `${c.m} at ${c.at}`).toBe(true);
            expect(c.vars.repeat === undefined || (Number.isInteger(c.vars.repeat) && (c.vars.repeat as number) >= 0)).toBe(true);
            const dur = (c.vars.duration as number | undefined) ?? 0;
            const stagger = ((c.vars.stagger as number | undefined) ?? 0) * Math.max(0, c.targets.length - 1);
            const end = c.at + dur * (1 + ((c.vars.repeat as number | undefined) ?? 0)) + stagger;
            expect(end, `${c.m} ${c.targets.join(' ')} ends at ${end}`).toBeLessThanOrEqual(a.duration + 1e-9);
          }
          const b = run(id, values);
          expect(JSON.stringify(b.timelines[0].calls)).toBe(JSON.stringify(tl.calls));
          expect(b.doc.body.innerHTML).toBe(a.doc.body.innerHTML);
        });
      }

      it('fits a short slot too', () => {
        const { timelines, duration } = run(id, { ...SAMPLE[id], duration: def.duration.min });
        for (const c of timelines[0].calls) expect(c.at).toBeLessThan(duration);
      });
    });
  }

  it('text-beat turns the markup into lines, a highlight box and typed characters', () => {
    const slide = run('text-beat', { ...SAMPLE['text-beat'], animIn: 'slide-up' }).doc;
    const lines = Array.from(slide.querySelectorAll('.tb-line'));
    expect(lines.map((l) => l.querySelector('.tb-hl-b') ? 'hl' : 'plain')).toEqual(['hl', 'plain']);
    expect(slide.querySelector('.tb-hl-b')!.textContent).toBe('cốt lõi');
    expect(slide.querySelector('.tb-kicker')!.textContent).toBe('BƯỚC 1');
    expect(slide.querySelector('.tb-caret')).toBeNull();
    const typed = run('text-beat', { ...SAMPLE['text-beat'], animIn: 'typewriter', kicker: '', sub: '' });
    expect(typed.doc.querySelectorAll('.tb-caret')).toHaveLength(2);
    expect(Array.from(typed.doc.querySelectorAll('.tb-ch')).map((c) => c.textContent).join('')).toBe('Giátrịcốtlõicủabạn');
    expect((typed.doc.querySelector('.tb-kicker') as HTMLElement).style.display).toBe('');
    const sets = typed.timelines[0].calls.filter((c) => c.m === 'set' && c.vars.display === 'inline').map((c) => c.at);
    expect(sets).toEqual([...sets].sort((x, y) => x - y));
  });

  it('scene-steps shows the step label and one row per item (at most five)', () => {
    const { doc } = run('scene-steps', { ...SAMPLE['scene-steps'], items: 'a\nb\nc\nd\ne\nf' });
    expect(doc.querySelector('.ss-kicker')!.textContent).toBe('BƯỚC 2');
    expect(Array.from(doc.querySelectorAll('.ss-text')).map((t) => t.textContent)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(run('scene-steps', SAMPLE['scene-steps']).doc.querySelector('.ss-text .ss-hl')!.textContent).toBe('3 việc');
  });

  it('broll-frame keeps only the media it was given', () => {
    const video = run('broll-frame', SAMPLE['broll-frame']).doc;
    expect(video.querySelector('video')).toBeTruthy();
    expect(video.querySelector('img, .bf-empty')).toBeNull();
    expect(video.querySelector('.bf-frame')!.className).toBe('bf-frame pip');
    const image = run('broll-frame', { layout: 'full', image: 'assets/a.png', video: '' }).doc;
    expect(image.querySelector('img')).toBeTruthy();
    expect(image.querySelector('video, .bf-empty')).toBeNull();
    expect(run('broll-frame', { layout: 'card' }).doc.querySelector('.bf-empty')!.textContent).toBe('Chưa có tư liệu');
  });

  it('logo-end falls back to the channel initials without a logo', () => {
    const { doc } = run('logo-end', SAMPLE['logo-end']);
    expect(doc.querySelector('.le-logo')!.textContent).toBe('HA');
    expect(doc.querySelector('.le-name')!.textContent).toBe('Hoàng Anh AI');
  });
});
