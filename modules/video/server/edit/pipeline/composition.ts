// EditPlan → HyperFrames composition (one HTML file). The same builder serves the live preview
// (proxy media, played by <hyperframes-player>) and the export (master media, rendered to MP4).
// Deterministic: same plan + transcript + profile (+ overrides) → same HTML.
//
// A plan with a non-legacy template (plan v2, Dựng nhanh) is built from the template's blocks by
// composition-v2/build.ts; every other plan keeps the builder below, unchanged.
import fs from 'node:fs';
import path from 'node:path';
import type { EditPlan, OverridesDoc, QuickSettings, Transcript, VideoAspect, VideoProfile, VideoStyle } from '../types.js';
import { getTemplate, LEGACY_PREFIX, templateDir } from '../templates/registry.js';
import type { TemplateManifest } from '../templates/types.js';
import { normWord } from './analyze.js';
import { makeMapper, computeKeep, type Segment } from './plan.js';
import type { AssetResolver, ResolvedAsset } from './library-resolve.js';
import { GSAP_URL, musicRelDb, r3 } from './tools.js';
import { buildTemplateComposition } from './composition-v2/build.js';
import { isSynthetic } from './composition-v2/captions.js';
import { cssFont, dbToGain, esc, mediaName, pngHasAlpha, safeColor } from './composition-v2/util.js';

export const ASPECT_SIZE: Record<VideoAspect, { w: number; h: number }> = {
  '9:16': { w: 1080, h: 1920 },
  '16:9': { w: 1920, h: 1080 },
  '1:1': { w: 1080, h: 1080 },
  '4:5': { w: 1080, h: 1350 },
};

export const BUILTIN_EFFECTS = ['two-tier-title', 'keyword-pop', 'big-number', 'stacked-list', 'compare-ab', 'cta-button'] as const;
export type BuiltinEffect = (typeof BUILTIN_EFFECTS)[number];

/** Catalog ids and loose names the agent may use, mapped to the six built-in effects. */
const EFFECT_ALIASES: Record<string, BuiltinEffect> = {
  'two-tier-title': 'two-tier-title', 'two-tier-hook': 'two-tier-title', 'title': 'two-tier-title', 'slide-up': 'two-tier-title',
  'keyword-pop': 'keyword-pop', 'keyword': 'keyword-pop', 'pop': 'keyword-pop', 'glow-text': 'keyword-pop', 'soft-blur': 'keyword-pop',
  'big-number': 'big-number', 'count-up': 'big-number', 'number': 'big-number',
  'stacked-list': 'stacked-list', 'list': 'stacked-list', 'numbered-steps': 'stacked-list',
  'compare-ab': 'compare-ab', 'compare': 'compare-ab',
  'cta-button': 'cta-button', 'cta': 'cta-button',
};

export function resolveEffect(effect: string): BuiltinEffect | null {
  const key = effect.trim().toLowerCase().replace(/^effect:/, '');
  return EFFECT_ALIASES[key] ?? null;
}

/** Where template packs come from (default: templates/registry.ts). */
export interface TemplateSource {
  get(id: string): TemplateManifest | null;
  dir(id: string): string | null;
}

export interface BuildInput {
  plan: EditPlan;
  transcript: Transcript;
  /** `quick` (Dựng nhanh settings) carries the owner's music choices: duck, snapToBeat, endOnFinal. */
  project: { code: string; title: string; aspect: VideoAspect; quick?: Pick<QuickSettings, 'music'> };
  profile: Pick<VideoProfile, 'brand' | 'audio'>;
  style?: VideoStyle | null;
  mode: 'preview' | 'export';
  resolver: AssetResolver;
  /** The owner's hand edits (overrides.json); template plans only, legacy plans have no element ids to edit. */
  overrides?: OverridesDoc | null;
  templates?: TemplateSource;
}

export interface BuiltComposition {
  html: string;
  /**
   * Files to expose under `assets/` next to the HTML (name → absolute path). `content` is written as a file
   * instead of a link (template blocks: the preview's assets route only serves files inside the project).
   */
  assets: { name: string; file: string; content?: string }[];
  durationSec: number;
  width: number;
  height: number;
  warnings: string[];
  stats: {
    segments: number; captions: number; overlays: number; brolls: number; sfx: number; music: boolean;
    /** Template plans: elements drawn from the template's blocks. */
    beats?: number; scenes?: number; graphics?: number;
  };
}

const REGISTRY: TemplateSource = { get: getTemplate, dir: templateDir };

/** The plan's template when it is a block template on this machine; legacy `style:<id>` templates are not. */
function blockTemplate(plan: EditPlan, source: TemplateSource): { manifest: TemplateManifest; dir: string } | null {
  if (!plan.templateId || plan.templateId.startsWith(LEGACY_PREFIX)) return null;
  const manifest = source.get(plan.templateId);
  const dir = manifest && !manifest.legacy ? source.dir(plan.templateId) : null;
  return manifest && dir ? { manifest, dir } : null;
}

interface Theme {
  accent: string;
  text: string;
  cardBg: string;
  dark: string;
  heading: string;
  caption: string;
  fontFaces: string;
}

export function buildComposition(input: BuildInput): BuiltComposition {
  const { plan } = input;
  const size = ASPECT_SIZE[plan.aspect ?? input.project.aspect] ?? ASPECT_SIZE['9:16'];
  const template = blockTemplate(plan, input.templates ?? REGISTRY);
  if (template) return buildTemplateComposition(input, template, size);
  const built = buildLegacy(input, size);
  if (plan.templateId && !plan.templateId.startsWith(LEGACY_PREFIX)) {
    built.warnings.unshift(`Mẫu "${plan.templateId}" không có trên máy — dựng theo kiểu cũ.`);
  }
  return built;
}

function buildLegacy(input: BuildInput, size: { w: number; h: number }): BuiltComposition {
  const { plan, transcript, profile, style, mode, resolver } = input;
  const { w: W, h: H } = size;
  const u = Math.min(W, H) / 1080;
  const landscape = W > H;
  const warnings: string[] = [];
  const assets = new Map<string, string>();
  const useAsset = (a: ResolvedAsset): string => {
    const name = mediaName(a);
    assets.set(name, a.file);
    return `assets/${name}`;
  };

  // ── Timeline ──
  const words = transcript.words;
  const res = computeKeep(transcript, plan.cutWords, plan.gapMs, plan.hook?.options.find((o) => o.id === plan.hook?.chosen));
  const segments: Segment[] = res.segments;
  const map = makeMapper(segments);
  const total = Math.max(0.1, res.outputDurationSec);
  const cutSet = new Set(plan.cutWords);

  // ── Theme: profile brand → style palette → defaults ──
  const brand = profile.brand ?? {};
  const fontFaces: string[] = [];
  let faceN = 0;
  const fontStack = (spec: string | undefined, fallbackFamily: string, prefer: 'bold' | 'regular'): string => {
    const asset = resolver.font(spec, prefer);
    if (asset) {
      const family = `vsfont${++faceN}`;
      const fmt = asset.ext === 'otf' ? 'opentype' : asset.ext === 'woff' ? 'woff' : asset.ext === 'woff2' ? 'woff2' : 'truetype';
      fontFaces.push(`@font-face{font-family:'${family}';src:url('${useAsset(asset)}') format('${fmt}');font-weight:100 900;font-style:normal}`);
      return `'${family}'`;
    }
    const chosen = cssFont(spec && !/\.(ttf|otf|woff2?)$/i.test(spec) && !spec.includes(':') ? spec : fallbackFamily);
    return `'${chosen}'`;
  };
  const stack = (first: string) => `${first},'Be Vietnam Pro','Helvetica Neue',Arial,sans-serif`;
  const theme: Theme = {
    accent: safeColor(brand.accent, safeColor(style?.palette.highlight, '#FFD23F')),
    text: safeColor(brand.text, safeColor(style?.palette.text, '#FFFFFF')),
    cardBg: brand.cardBg && /^(#|rgb)/.test(brand.cardBg) ? brand.cardBg.replace(/[;{}<>"']/g, '') : 'rgba(18,18,22,.88)',
    dark: safeColor(brand.dark, '#141416'),
    heading: stack(fontStack(brand.fontHeading, style?.fontHeading ?? 'Be Vietnam Pro', 'bold')),
    caption: stack(fontStack(brand.fontCaption ?? brand.fontBody ?? style?.fontCaption, 'Be Vietnam Pro', 'bold')),
    fontFaces: '',
  };
  theme.fontFaces = fontFaces.join('\n');

  const clips: string[] = [];
  const tl: string[] = [];
  const stats = { segments: segments.length, captions: 0, overlays: 0, brolls: 0, sfx: 0, music: false };

  // ── A-roll: one clip per kept range ──
  const mediaSrc = mode === 'export' ? useMaster(assets) : '../source/proxy.mp4';
  segments.forEach((s, i) => {
    clips.push(`<video id="v${i}" class="clip vc" src="${mediaSrc}" playsinline data-start="${r3(s.out)}" data-duration="${r3(s.end - s.start)}" data-media-start="${r3(s.start)}" data-fade-in="0.03" data-fade-out="0.03" data-has-audio="true" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1"></video>`);
  });

  // ── Hook: big text over the first 2 s ──
  const hook = plan.hook?.options.find((o) => o.id === plan.hook?.chosen);
  if (hook) {
    const dur = Math.min(2, total);
    const top = landscape ? 0.14 : 0.2;
    clips.push(`<div id="hook" class="clip" data-start="0" data-duration="${r3(dur)}" data-track-index="1" style="position:absolute;left:${6 * u}%;right:${6 * u}%;top:${top * H}px;z-index:20;text-align:center;font-family:${theme.heading};text-shadow:0 ${8 * u}px ${28 * u}px rgba(0,0,0,.85)">`
      + `<div id="hook-big" style="font-weight:900;font-size:${(landscape ? 96 : 118) * u}px;line-height:1.05;color:${theme.accent};text-transform:uppercase;letter-spacing:.01em">${esc(hook.text)}</div>`
      + (hook.subtext ? `<div style="font-weight:700;font-size:${50 * u}px;line-height:1.2;color:${theme.text};margin-top:${14 * u}px">${esc(hook.subtext)}</div>` : '')
      + '</div>');
    tl.push(`tl.from("#hook",{scale:.65,opacity:0,duration:.35,ease:"back.out(2)"},0);`);
  }

  // ── Captions: chunks that never cross a cut ──
  const capStyle = plan.captions.styleId.replace(/^caption:/, '');
  const perChunk = capStyle === 'single-word-pop' ? 1 : capStyle === 'pair-words' ? Math.min(2, plan.captions.maxWordsPerChunk) : plan.captions.maxWordsPerChunk;
  const highlight = new Set<string>();
  for (const h of plan.captions.highlight) for (const part of h.split(/\s+/)) { const n = normWord(part); if (n) highlight.add(n); }
  const capSize = (capStyle === 'bold-uppercase' ? 78 : landscape ? 62 : 70) * u;
  const position = plan.captions.position === 'middle' || plan.captions.position === 'behind' || capStyle === 'behind-subject' ? 'middle' : 'bottom';
  const posCss = position === 'middle'
    ? `top:${(landscape ? 0.5 : 0.44) * H}px`
    : `bottom:${(landscape ? 0.1 : plan.aspect === '9:16' ? 0.2 : 0.14) * H}px`;
  const chunks: { id: string; start: number; end: number; ws: { text: string; o: number; key: boolean }[] }[] = [];
  for (const seg of segments) {
    const inSeg = words.filter((x) => !cutSet.has(x.i) && !isSynthetic(x) && x.start >= seg.start - 0.001 && x.start < seg.end);
    let cur: typeof inSeg = [];
    const flush = () => {
      if (!cur.length) return;
      const o0 = seg.out + (cur[0].start - seg.start);
      const o1 = seg.out + (Math.min(cur[cur.length - 1].end, seg.end) - seg.start);
      chunks.push({
        id: `cap${chunks.length}`, start: o0, end: Math.max(o1, o0 + 0.25),
        ws: cur.map((x) => ({ text: x.text, o: seg.out + (x.start - seg.start), key: highlight.has(normWord(x.text)) })),
      });
      cur = [];
    };
    for (const x of inSeg) {
      cur.push(x);
      if (cur.length >= perChunk || /[.?!…]$/u.test(x.text)) flush();
    }
    flush();
  }
  chunks.forEach((c, k) => {
    const next = chunks[k + 1];
    const end = Math.min(c.end + 0.08, next && next.start >= c.start ? next.start : total, total);
    c.end = Math.max(c.start + 0.2, end);
  });
  const wordStyle = (key: boolean) => {
    if (!key) return '';
    if (capStyle === 'highlight-bar') return `background:${theme.accent};color:${theme.dark};padding:0 ${10 * u}px;border-radius:${8 * u}px;text-shadow:none`;
    return `color:${theme.accent}`;
  };
  const capBoxCss = capStyle === 'boxed'
    ? `background:rgba(10,10,14,.72);padding:${14 * u}px ${26 * u}px;border-radius:${18 * u}px;`
    : capStyle === 'outline-highlight' ? '-webkit-text-stroke:' + `${3 * u}px rgba(0,0,0,.9);paint-order:stroke fill;` : '';
  const upper = capStyle === 'bold-uppercase' ? 'text-transform:uppercase;' : '';
  for (const c of chunks) {
    const spans = c.ws.map((x, wi) => `<span id="${c.id}w${wi}" style="${wordStyle(x.key)}">${esc(x.text)}</span>`).join(' ');
    clips.push(`<div id="${c.id}" class="clip" data-start="${r3(c.start)}" data-duration="${r3(c.end - c.start)}" data-track-index="2" style="position:absolute;left:${6 * u}%;right:${6 * u}%;${posCss};z-index:15;text-align:center;font-family:${theme.caption};font-weight:800;font-size:${capSize}px;line-height:1.18;color:${theme.text};text-shadow:0 ${5 * u}px ${18 * u}px rgba(0,0,0,.9);${upper}"><span style="${capBoxCss}display:inline-block">${spans}</span></div>`);
    tl.push(`tl.from("#${c.id}",{y:${Math.round(18 * u)},opacity:0,duration:.12,ease:"power2.out"},${r3(c.start)});`);
    if (capStyle === 'karaoke') {
      c.ws.forEach((x, wi) => {
        tl.push(`tl.fromTo("#${c.id}w${wi}",{color:"${theme.text}"},{color:"${theme.accent}",duration:.08,immediateRender:false},${r3(x.o)});`);
      });
    }
    if (capStyle === 'single-word-pop') tl.push(`tl.from("#${c.id}",{scale:.7,duration:.16,ease:"back.out(2.4)"},${r3(c.start)});`);
  }
  stats.captions = chunks.length;

  // ── Overlay effects ──
  plan.overlays.forEach((o, k) => {
    const effect = resolveEffect(o.effect);
    if (!effect) { warnings.push(`Hiệu ứng "${o.effect}" chưa hỗ trợ ở giai đoạn 1 — bỏ qua.`); return; }
    let at = o.at;
    if (o.anchorWord !== undefined && words[o.anchorWord]) {
      const m = map(words[o.anchorWord].start);
      if (m === null) { warnings.push(`Hiệu ứng "${o.effect}" neo vào từ đã bị cắt — bỏ qua.`); return; }
      at = m;
    }
    if (at >= total) return;
    const dur = Math.min(o.duration, total - at);
    if (dur < 0.2) return;
    const id = `fx${k}`;
    const html = effectHtml(effect, id, o.props, { u, W, H, landscape, theme });
    clips.push(`<div id="${id}" class="clip" data-start="${r3(at)}" data-duration="${r3(dur)}" data-track-index="3" style="position:absolute;left:0;right:0;top:0;bottom:0;z-index:25;pointer-events:none;font-family:${theme.heading}">${html.body}</div>`);
    tl.push(...html.tween(r3(at), r3(dur)));
    stats.overlays++;
  });

  // ── B-roll ──
  plan.brolls.filter((b) => b.enabled).forEach((b, k) => {
    const anchor = words[b.anchorWord];
    const at = anchor ? map(anchor.start) : null;
    if (at === null || at === undefined || at >= total) return;
    const dur = Math.min(b.duration, total - at);
    if (dur < 0.3) return;
    const asset = b.assetId ? resolver.byId(b.assetId) : null;
    const validCutout = Boolean(asset && asset.ext === 'png' && pngHasAlpha(asset.file));
    const isImage = asset && ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(asset.ext) && (b.layout !== 'cutout' || validCutout);
    const isVideo = asset && ['mp4', 'mov', 'webm', 'm4v'].includes(asset.ext) && b.layout !== 'cutout';
    if (b.layout === 'cutout' && !validCutout) {
      const warning = `B-roll "${b.title}" cần PNG tách nền trong kho để đặt trên đầu người nói.`;
      if (mode === 'export') throw new Error(warning);
      warnings.push(warning);
    }
    if (!isImage && !isVideo && mode === 'export') {
      warnings.push(`B-roll "${b.title}" chưa có file — bỏ qua khi xuất.`);
      return;
    }
    const id = `br${k}`;
    const cutoutBox = b.box ?? { x: 18.5, y: 2.6, w: 63, h: 25 };
    const box = b.layout === 'full'
      ? 'position:absolute;inset:0;'
      : b.layout === 'cutout'
        ? `position:absolute;left:${cutoutBox.x}%;top:${cutoutBox.y}%;width:${cutoutBox.w}%;height:${cutoutBox.h}%;pointer-events:none;`
      : `position:absolute;left:${landscape ? 18 : 9}%;right:${landscape ? 18 : 9}%;top:${(landscape ? 0.1 : 0.12) * H}px;height:${(landscape ? 0.66 : 0.36) * H}px;border-radius:${34 * u}px;overflow:hidden;box-shadow:0 ${20 * u}px ${60 * u}px rgba(0,0,0,.55);`;
    let inner: string;
    if (isImage) inner = `<img src="${useAsset(asset!)}" style="width:100%;height:100%;object-fit:${b.layout === 'cutout' ? 'contain' : 'cover'}">`;
    else if (isVideo) inner = `<video src="${useAsset(asset!)}" muted playsinline data-media-start="0" style="width:100%;height:100%;object-fit:cover"></video>`;
    else inner = b.layout === 'cutout'
      ? `<div style="width:100%;height:100%;display:grid;place-items:center;text-align:center;border:2px dashed #fff8;color:#fff;padding:${20 * u}px;font-size:${30 * u}px">Cần ảnh tách nền: ${esc(b.title)}</div>`
      : `<div style="width:100%;height:100%;background:linear-gradient(135deg,#2a6b62,#3b3a6e);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:${40 * u}px;font-family:${theme.heading};color:#e8fffb"><div style="font-size:${34 * u}px;font-weight:700;opacity:.8">B-roll (chưa có file)</div><div style="font-size:${58 * u}px;font-weight:800;line-height:1.2;margin-top:${10 * u}px">${esc(b.title)}</div></div>`;
    // Image/video elements inside the wrapper do not get their own timing; the wrapper is the clip.
    clips.push(`<div id="${id}" class="clip" data-start="${r3(at)}" data-duration="${r3(dur)}" data-track-index="4" style="${box}z-index:12">${inner}</div>`);
    tl.push(`tl.from("#${id}",{opacity:0,scale:.94,duration:.25,ease:"power2.out"},${r3(at)});`);
    stats.brolls++;
  });

  // ── Zooms on the A-roll ──
  for (const z of plan.zooms) {
    if (z.at >= total) continue;
    const d = Math.min(z.duration, total - z.at);
    const up = Math.min(0.3, d / 2);
    tl.push(`tl.fromTo(".vc",{scale:1},{scale:${z.scale},duration:${r3(up)},ease:"power2.out",immediateRender:false},${r3(z.at)});`);
    tl.push(`tl.to(".vc",{scale:1,duration:${r3(Math.min(0.3, d / 2))},ease:"power2.inOut"},${r3(z.at + d - Math.min(0.3, d / 2))});`);
  }

  // ── Music + SFX ──
  const audio = profile.audio;
  if (plan.music) {
    const a = resolver.byId(plan.music.assetId);
    if (a && ['mp3', 'wav', 'm4a', 'ogg', 'aac'].includes(a.ext)) {
      // gainDb fine-tunes around the profile's music level (musicRelDb keeps old absolute values).
      const rel = musicRelDb(plan.music.gainDb, audio.musicLufs - audio.voiceLufs);
      const dur = a.durationSec ? Math.min(total, a.durationSec) : total;
      clips.push(`<audio id="music" class="clip" src="${useAsset(a)}" data-start="0" data-duration="${r3(dur)}" data-media-start="0" data-volume="${r3(dbToGain(rel))}" data-fade-in="0.6" data-fade-out="${r3(Math.min(2, dur / 3))}" data-track-index="10"></audio>`);
      stats.music = true;
    } else warnings.push(`Nhạc "${plan.music.assetId}" không có trong kho — bỏ qua.`);
  }
  plan.sfx.forEach((s, k) => {
    if (s.at >= total) return;
    const a = resolver.byId(s.assetId);
    if (!a || !['mp3', 'wav', 'm4a', 'ogg', 'aac'].includes(a.ext)) { warnings.push(`Tiếng động "${s.assetId}" không có trong kho — bỏ qua.`); return; }
    const dur = Math.min(a.durationSec ?? 2, total - s.at);
    if (dur < 0.05) return;
    clips.push(`<audio id="sfx${k}" class="clip" src="${useAsset(a)}" data-start="${r3(s.at)}" data-duration="${r3(dur)}" data-media-start="0" data-volume="${r3(dbToGain(s.gainDb ?? audio.musicLufs - audio.voiceLufs + 8))}" data-track-index="${11 + (k % 3)}"></audio>`);
    stats.sfx++;
  });

  const html = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=${W}, height=${H}">
<script src="${GSAP_URL}"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#000}
${theme.fontFaces}
</style></head>
<body><div id="root" data-composition-id="main" data-start="0" data-duration="${r3(total)}" data-width="${W}" data-height="${H}">
${clips.join('\n')}
</div>
<script>
window.__timelines=window.__timelines||{};
const tl=gsap.timeline({paused:true});
${tl.join('\n')}
window.__timelines["main"]=tl;
</script></body></html>`;

  return {
    html,
    assets: [...assets.entries()].map(([name, file]) => ({ name, file })),
    durationSec: r3(total),
    width: W,
    height: H,
    warnings,
    stats,
  };
}

/** Export reads the full-quality master through assets/ (the render symlinks it in). */
function useMaster(assets: Map<string, string>): string {
  assets.set('master.mp4', '@master');
  return 'assets/master.mp4';
}

// ── Built-in effects ──

interface FxCtx { u: number; W: number; H: number; landscape: boolean; theme: Theme }
interface FxOut { body: string; tween: (at: number, dur: number) => string[] }

const prop = (props: Record<string, string | number | string[]>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = props[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return '';
};
const listProp = (props: Record<string, string | number | string[]>, ...keys: string[]): string[] => {
  for (const k of keys) {
    const v = props[k];
    if (Array.isArray(v)) return v.map(String).filter(Boolean);
    if (typeof v === 'string' && v.trim()) return v.split(/\n|\|/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
};

function effectHtml(effect: BuiltinEffect, id: string, props: Record<string, string | number | string[]>, c: FxCtx): FxOut {
  const { u, H, landscape, theme } = c;
  const outTween = (at: number, dur: number) => `tl.to("#${id} .fx",{opacity:0,duration:.2,ease:"power1.in"},${r3(Math.max(at, at + dur - 0.2))});`;
  const shadow = `text-shadow:0 ${8 * u}px ${26 * u}px rgba(0,0,0,.85)`;

  if (effect === 'two-tier-title') {
    const small = prop(props, 'small', 'subtitle', 'top', 'kicker');
    const big = prop(props, 'big', 'title', 'text', 'main');
    return {
      body: `<div class="fx" style="position:absolute;left:${7 * u}%;right:${7 * u}%;top:${(landscape ? 0.18 : 0.26) * H}px;text-align:center;${shadow}">`
        + (small ? `<div class="s" style="font-weight:700;font-size:${52 * u}px;line-height:1.2;color:${theme.text};margin-bottom:${10 * u}px">${esc(small)}</div>` : '')
        + `<div class="b" style="font-weight:900;font-size:${(landscape ? 100 : 124) * u}px;line-height:1.04;color:${theme.accent};text-transform:uppercase">${esc(big)}</div></div>`,
      tween: (at, dur) => [
        `tl.from("#${id} .s",{y:${-30 * u},opacity:0,duration:.3,ease:"power2.out"},${at});`,
        `tl.from("#${id} .b",{y:${40 * u},opacity:0,scale:.9,duration:.4,ease:"back.out(1.8)"},${r3(at + 0.12)});`,
        outTween(at, dur),
      ],
    };
  }
  if (effect === 'keyword-pop') {
    const text = prop(props, 'text', 'word', 'keyword', 'big');
    return {
      body: `<div class="fx" style="position:absolute;left:0;right:0;top:${(landscape ? 0.3 : 0.34) * H}px;text-align:center;font-weight:900;font-size:${(landscape ? 130 : 150) * u}px;line-height:1;color:${theme.accent};text-transform:uppercase;${shadow}">${esc(text)}</div>`,
      tween: (at, dur) => [
        `tl.from("#${id} .fx",{scale:.3,opacity:0,duration:.32,ease:"back.out(2.6)"},${at});`,
        outTween(at, dur),
      ],
    };
  }
  if (effect === 'big-number') {
    const value = prop(props, 'value', 'number', 'text');
    const label = prop(props, 'label', 'caption', 'unit');
    return {
      body: `<div class="fx" style="position:absolute;left:0;right:0;top:${(landscape ? 0.2 : 0.22) * H}px;text-align:center;${shadow}">`
        + `<div class="n" style="font-weight:900;font-size:${(landscape ? 220 : 260) * u}px;line-height:1;color:${theme.accent}">${esc(value)}</div>`
        + (label ? `<div class="l" style="font-weight:700;font-size:${58 * u}px;color:${theme.text};margin-top:${6 * u}px">${esc(label)}</div>` : '')
        + '</div>',
      tween: (at, dur) => [
        `tl.from("#${id} .n",{scale:.4,opacity:0,duration:.32,ease:"back.out(2.5)"},${at});`,
        `tl.from("#${id} .l",{y:${24 * u},opacity:0,duration:.25},${r3(at + 0.18)});`,
        outTween(at, dur),
      ],
    };
  }
  if (effect === 'stacked-list') {
    const items = listProp(props, 'items', 'list', 'lines').slice(0, 6);
    const title = prop(props, 'title', 'heading');
    const rows = items.map((t, i) => `<div class="it" style="display:flex;align-items:center;gap:${18 * u}px;background:${theme.cardBg};border-radius:${22 * u}px;padding:${18 * u}px ${28 * u}px;font-weight:800;font-size:${50 * u}px;line-height:1.2;color:${theme.text}"><span style="flex:none;width:${54 * u}px;height:${54 * u}px;border-radius:50%;background:${theme.accent};color:${theme.dark};display:flex;align-items:center;justify-content:center;font-size:${32 * u}px">${i + 1}</span><span>${esc(t)}</span></div>`).join('');
    return {
      body: `<div class="fx" style="position:absolute;left:${landscape ? 25 : 8}%;right:${landscape ? 25 : 8}%;top:${(landscape ? 0.14 : 0.2) * H}px;display:flex;flex-direction:column;gap:${16 * u}px">`
        + (title ? `<div style="font-weight:900;font-size:${58 * u}px;color:${theme.accent};text-align:center;${shadow};margin-bottom:${4 * u}px">${esc(title)}</div>` : '')
        + `${rows}</div>`,
      tween: (at, dur) => [
        `tl.from("#${id} .it",{x:${-60 * u},opacity:0,duration:.3,stagger:${r3(Math.min(0.45, Math.max(0.15, (dur - 0.6) / Math.max(1, items.length)))) },ease:"power2.out"},${at});`,
        outTween(at, dur),
      ],
    };
  }
  if (effect === 'compare-ab') {
    const a = prop(props, 'textA', 'a', 'left', 'before');
    const b = prop(props, 'textB', 'b', 'right', 'after');
    const la = prop(props, 'labelA', 'labelLeft') || 'A';
    const lb = prop(props, 'labelB', 'labelRight') || 'B';
    const card = (cls: string, label: string, text: string, color: string) =>
      `<div class="${cls}" style="flex:1;background:${theme.cardBg};border-radius:${28 * u}px;border:${4 * u}px solid ${color};padding:${28 * u}px;text-align:center;display:flex;flex-direction:column;justify-content:center;gap:${10 * u}px"><div style="font-weight:800;font-size:${36 * u}px;color:${color}">${esc(label)}</div><div style="font-weight:900;font-size:${(landscape ? 56 : 66) * u}px;line-height:1.15;color:${theme.text}">${esc(text)}</div></div>`;
    return {
      body: `<div class="fx" style="position:absolute;left:${landscape ? 10 : 6}%;right:${landscape ? 10 : 6}%;top:${(landscape ? 0.16 : 0.2) * H}px;height:${(landscape ? 0.5 : 0.42) * H}px;display:flex;flex-direction:${landscape ? 'row' : 'column'};gap:${22 * u}px">`
        + card('ca', la, a, '#ff6b6b') + card('cb', lb, b, theme.accent) + '</div>',
      tween: (at, dur) => [
        `tl.from("#${id} .ca",{${landscape ? 'x' : 'y'}:${-80 * u},opacity:0,duration:.35,ease:"power2.out"},${at});`,
        `tl.from("#${id} .cb",{${landscape ? 'x' : 'y'}:${80 * u},opacity:0,duration:.35,ease:"power2.out"},${r3(at + 0.15)});`,
        outTween(at, dur),
      ],
    };
  }
  // cta-button
  const text = prop(props, 'text', 'label', 'cta') || 'Theo dõi kênh';
  const sub = prop(props, 'sub', 'subtitle');
  return {
    body: `<div class="fx" style="position:absolute;left:0;right:0;bottom:${(landscape ? 0.2 : 0.3) * H}px;display:flex;flex-direction:column;align-items:center;gap:${12 * u}px">`
      + `<div class="btn" style="background:${theme.accent};color:${theme.dark};font-weight:900;font-size:${58 * u}px;padding:${26 * u}px ${64 * u}px;border-radius:${999}px;box-shadow:0 ${14 * u}px ${44 * u}px rgba(0,0,0,.5)">${esc(text)}</div>`
      + (sub ? `<div style="font-weight:700;font-size:${40 * u}px;color:${theme.text};${shadow}">${esc(sub)}</div>` : '')
      + '</div>',
    tween: (at, dur) => [
      `tl.from("#${id} .fx",{y:${70 * u},opacity:0,duration:.35,ease:"back.out(1.7)"},${at});`,
      `tl.to("#${id} .btn",{scale:1.06,duration:.4,yoyo:true,repeat:${Math.max(0, Math.min(6, Math.floor((dur - 0.8) / 0.8)))},ease:"sine.inOut"},${r3(at + 0.5)});`,
      outTween(at, dur),
    ],
  };
}

/**
 * Write the assets the composition needs next to it as symlinks (`@master` resolves to the project's
 * master file), or as files for entries with `content`. Rebuilt from scratch each time so stale links never linger.
 */
export function materializeAssets(compositionDir: string, assets: BuiltComposition['assets'], masterFile: string): void {
  const dir = path.join(compositionDir, 'assets');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const a of assets) {
    if (a.content !== undefined) { fs.writeFileSync(path.join(dir, a.name), a.content); continue; }
    const target = a.file === '@master' ? masterFile : a.file;
    try { fs.symlinkSync(target, path.join(dir, a.name)); } catch { /* exists or unsupported: skip */ }
  }
}

