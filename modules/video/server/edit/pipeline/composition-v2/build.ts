// Plan v2 → HyperFrames composition built from the template's blocks (Dựng nhanh). Beats, scenes, graphics,
// the hook and the B-roll frames are block instances (sub-compositions, props as variable values), each plan
// element's host slot tagged data-el-id with its id; overrides.json is applied on top (music included); captions
// follow the template's CaptionStyle; the music bed makes room for the voice. Deterministic like the legacy builder.
import type { BuildInput, BuiltComposition } from '../composition.js';
import type { OverridesDoc } from '../../types.js';
import type { ComponentDef, TemplateManifest } from '../../templates/types.js';
import { computeKeep, makeMapper } from '../plan.js';
import type { ResolvedAsset } from '../library-resolve.js';
import { GSAP_URL, r3 } from '../tools.js';
import { isAudio, elementSounds, musicAttrs, placeMusic, snapToBeat, speechRanges, type MusicPlan } from './audio.js';
import { blockInstance, blockValues, loadBlock, varDefault, type Block } from './blocks.js';
import { captionCues, captionFamily, captionLayer, captionStyle } from './captions.js';
import { beatText, effective, overrideOf, overridesScript, withProps, type Effective, type PlacedOverride } from './overrides.js';
import { cssFont, cssValue, dbToGain, esc, mediaName } from './util.js';

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'];
const VIDEO_EXTS = ['mp4', 'mov', 'webm', 'm4v'];
/** Vietnamese letters with stacked marks: what a font check must be able to draw. */
const FONT_SAMPLE = 'Ắ Ằ Ẳ Ẵ Ặ Ế Ề Ể Ễ Ệ Ố Ồ Ổ Ỗ Ộ Ớ Ờ Ở Ỡ Ợ Ứ Ừ Ử Ữ Ự đ Đ ơ ư 0123';

type SlotKind = 'hook' | 'beat' | 'scene' | 'graphic' | 'broll';

/** Timeline row and stacking of each kind: B-roll over the speaker, scenes over B-roll, captions over scenes. */
const LAYER: Record<SlotKind, { track: number; z: number }> = {
  broll: { track: 4, z: 12 },
  scene: { track: 5, z: 14 },
  hook: { track: 1, z: 20 },
  beat: { track: 6, z: 20 },
  graphic: { track: 7, z: 30 },
};

interface Slot extends Effective {
  id: string;
  kind: SlotKind;
  block: Block;
  def: ComponentDef;
  values: Record<string, unknown>;
  fullFrame?: boolean;
}

export function buildTemplateComposition(
  input: BuildInput,
  template: { manifest: TemplateManifest; dir: string },
  size: { w: number; h: number },
): BuiltComposition {
  const { plan, transcript, profile, mode, resolver } = input;
  const { manifest: tpl, dir } = template;
  const { w: W, h: H } = size;
  const ov: OverridesDoc | null = input.overrides ?? null;
  const music = input.project.quick?.music;
  const warnings: string[] = [];
  const assets = new Map<string, { file: string; content?: string }>();
  const useAsset = (a: ResolvedAsset): string => {
    const name = mediaName(a);
    assets.set(name, { file: a.file });
    return `assets/${name}`;
  };

  // ── Timeline ──
  const words = transcript.words;
  const res = computeKeep(transcript, plan.cutWords, plan.gapMs, plan.hook?.options.find((o) => o.id === plan.hook?.chosen));
  const segments = res.segments;
  const map = makeMapper(segments);
  const total = Math.max(0.1, res.outputDurationSec);
  const cut = new Set(plan.cutWords);

  // ── Fonts and colours: template tokens as inherited CSS variables, every family declared from the library ──
  // A family named in CSS without its own @font-face would make the HyperFrames compiler fetch it from Google
  // Fonts at render time; a family missing from the library falls back to the generic sans-serif instead.
  const faces: string[] = [];
  const fontChecks: { family: string; weight: number }[] = [];
  const declared = new Map<string, string | null>();
  const family = (name: string, weight: number): string | null => {
    const key = name.trim().toLowerCase();
    if (declared.has(key)) return declared.get(key)!;
    const asset = resolver.font(name, weight >= 600 ? 'bold' : 'regular');
    const fam = cssFont(name.trim());
    if (!asset || !fam) {
      warnings.push(`Font "${name}" của mẫu chưa có trong thư viện font — chữ dùng font dự phòng. Thêm font vào Kho rồi dựng lại.`);
      declared.set(key, null);
      return null;
    }
    const fmt = asset.ext === 'otf' ? 'opentype' : asset.ext === 'woff' ? 'woff' : asset.ext === 'woff2' ? 'woff2' : 'truetype';
    faces.push(`@font-face{font-family:'${fam}';src:url('${useAsset(asset)}') format('${fmt}');font-weight:100 900;font-style:normal;font-display:block}`);
    fontChecks.push({ family: fam, weight });
    declared.set(key, fam);
    return fam;
  };
  const varFamily = (fam: string | null) => (fam ? `'${fam}'` : 'sans-serif');
  const capStyle = captionStyle(tpl.captions, ov?.captions);
  const fonts = tpl.tokens.fonts;
  const themeVars = [
    `--th-font-title:${varFamily(family(fonts.title, 400))}`,
    `--th-font-sub:${varFamily(family(fonts.sub, 700))}`,
    `--th-font-caption:${varFamily(family(fonts.caption, capStyle.font.weight))}`,
    ...Object.entries(tpl.tokens.colors).map(([k, v]) => `--th-${k.replace(/[^A-Za-z0-9_-]/g, '')}:${cssValue(v, '#FFFFFF')}`),
  ];
  const capFamily = family(capStyle.font.family, capStyle.font.weight);

  const clips: string[] = [];
  const tl: string[] = [];

  // ── A-roll: one clip per kept range ──
  let mediaSrc = '../source/proxy.mp4';
  if (mode === 'export') {
    assets.set('master.mp4', { file: '@master' });
    mediaSrc = 'assets/master.mp4';
  }
  segments.forEach((s, i) => {
    clips.push(`<video id="v${i}" class="clip vc" src="${mediaSrc}" playsinline data-start="${r3(s.out)}" data-duration="${r3(s.end - s.start)}" data-media-start="${r3(s.start)}" data-fade-in="0.03" data-fade-out="0.03" data-has-audio="true" data-track-index="0" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1"></video>`);
  });

  // ── Music placement first: snapToBeat needs the beats on the output timeline ──
  // The owner's editor choice (overrides.json) wins over the Dựng nhanh settings, which win over the plan.
  const ownMusic = ov?.music;
  const musicId = ownMusic?.off ? undefined : ownMusic?.assetId ?? plan.music?.assetId;
  let bed: MusicPlan | null = null;
  if (musicId) {
    const a = resolver.byId(musicId);
    if (isAudio(a)) bed = placeMusic(a, total, Boolean(music?.endOnFinal), warnings);
    else warnings.push(`Nhạc "${musicId}" không có trong kho — bỏ qua.`);
  }
  const beatsToSnap = music?.snapToBeat && bed?.beats.length ? bed.beats : null;

  // ── Elements → block slots ──
  const blocks = new Map<string, Block | null>();
  const blockFor = (componentId: string): { block: Block; def: ComponentDef } | null => {
    const def = tpl.components[componentId];
    if (!def) return null;
    if (!blocks.has(componentId)) blocks.set(componentId, loadBlock(tpl, dir, componentId, def));
    const block = blocks.get(componentId);
    return block ? { block, def } : null;
  };
  const firstOfKind = (kind: ComponentDef['kind']) => Object.keys(tpl.components).find((id) => tpl.components[id].kind === kind) ?? null;
  const fileOf = (assetId: string, where: string): string => {
    const a = resolver.byId(assetId);
    if (a && (IMAGE_EXTS.includes(a.ext) || VIDEO_EXTS.includes(a.ext))) return useAsset(a);
    warnings.push(`${where}: tư liệu "${assetId}" không có trong kho — để trống.`);
    return '';
  };
  /** Asset props hold library ids in the plan; the block gets the file path. */
  const resolveAssetProps = (def: ComponentDef, values: Record<string, unknown>, where: string) => {
    for (const [key, p] of Object.entries(def.props)) {
      const v = values[key];
      if (p.type === 'asset' && typeof v === 'string' && v && !v.startsWith('assets/')) values[key] = fileOf(v, where);
    }
  };
  const slots: Slot[] = [];
  const missing = (what: string, id: string, component: string) =>
    warnings.push(`${what} "${id}": mẫu ${tpl.name} không có component "${component}" — bỏ qua.`);

  const hook = plan.hook?.options.find((o) => o.id === plan.hook?.chosen);
  const hookComponent = tpl.components['text-beat']?.kind === 'beat' ? 'text-beat' : firstOfKind('beat');
  if (hook && hookComponent) {
    const b = blockFor(hookComponent);
    if (b) slots.push({ id: 'hook', kind: 'hook', ...b, at: 0, duration: Math.min(2, total), atFixed: true, values: { title: hook.text, sub: hook.subtext ?? '' } });
  }
  for (const beat of plan.beats ?? []) {
    const o = overrideOf(ov, beat.id);
    if (o?.hidden) continue;
    const component = beat.component || 'text-beat';
    const b = blockFor(component);
    if (!b) { missing('Nhịp chữ', beat.id, component); continue; }
    slots.push({ id: beat.id, kind: 'beat', ...b, ...effective(beat, o), values: { ...(o?.props ?? {}), ...beatText(beat, o) } });
  }
  for (const scene of plan.scenes ?? []) {
    const o = overrideOf(ov, scene.id);
    if (o?.hidden) continue;
    const b = blockFor(scene.component);
    if (!b) { missing('Cảnh minh hoạ', scene.id, scene.component); continue; }
    const values: Record<string, unknown> = withProps(scene.props, o);
    resolveAssetProps(b.def, values, `Cảnh minh hoạ "${scene.id}"`);
    slots.push({ id: scene.id, kind: 'scene', ...b, ...effective(scene, o), values });
  }
  for (const g of plan.graphics ?? []) {
    const o = overrideOf(ov, g.id);
    if (o?.hidden) continue;
    const b = blockFor(g.component);
    if (!b) { missing('Đồ hoạ', g.id, g.component); continue; }
    const values: Record<string, unknown> = withProps(g.props, o);
    // The element's own asset (or the channel logo for a `logo` prop) fills the block's first empty asset prop;
    // the owner's swapped file takes that prop too, or the first asset prop when the props fill them all.
    const assetProps = Object.entries(b.def.props).filter(([, p]) => p.type === 'asset');
    const assetProp = assetProps.find(([key]) => !values[key]) ?? (o?.assetId ? assetProps[0] : undefined);
    if (assetProp) {
      const id = o?.assetId ?? g.assetId ?? (assetProp[0] === 'logo' ? profile.brand.logoAssetId : undefined);
      if (id) values[assetProp[0]] = id;
    }
    resolveAssetProps(b.def, values, `Đồ hoạ "${g.id}"`);
    slots.push({ id: g.id, kind: 'graphic', ...b, ...effective(g, o), values });
  }
  const frameComponent = firstOfKind('broll-frame');
  for (const br of plan.brolls) {
    const o = overrideOf(ov, br.id);
    if (!br.enabled || o?.hidden) continue;
    if (!frameComponent) { warnings.push(`B-roll "${br.title}": mẫu ${tpl.name} không có khung cảnh trám — bỏ qua.`); continue; }
    const b = blockFor(frameComponent);
    if (!b) continue;
    const anchor = words[br.anchorWord];
    const mapped = anchor ? map(anchor.start) : null;
    if (o?.at === undefined && mapped === null) continue;
    const props = withProps(undefined, o);
    const layout = typeof props.layout === 'string' && props.layout ? props.layout : br.layout === 'cutout' ? 'pip-circle' : br.layout;
    const values: Record<string, unknown> = { ...props, layout };
    // The owner's swapped file over the plan's.
    const assetId = o?.assetId ?? br.assetId;
    const a = assetId ? resolver.byId(assetId) : null;
    if (a && VIDEO_EXTS.includes(a.ext)) values.video = useAsset(a);
    else if (a && IMAGE_EXTS.includes(a.ext)) values.image = useAsset(a);
    else if (mode === 'export') { warnings.push(`B-roll "${br.title}" chưa có file — bỏ qua khi xuất.`); continue; }
    else if (assetId) warnings.push(`B-roll "${br.title}": tư liệu "${assetId}" không có trong kho — để trống.`);
    slots.push({ id: br.id, kind: 'broll', ...b, ...effective({ ...br, at: mapped ?? 0 }, o), values, fullFrame: layout === 'full' });
  }
  for (const o of plan.overlays) {
    warnings.push(`Hiệu ứng cũ "${o.effect}" không dùng với mẫu ${tpl.name} (mẫu dùng nhịp chữ và cảnh minh hoạ) — bỏ qua.`);
  }

  // ── Timing: snap to the beat, keep inside the video ──
  const placed: Slot[] = [];
  for (const s of slots) {
    if (beatsToSnap && !s.atFixed && (s.kind === 'beat' || s.kind === 'scene')) s.at = snapToBeat(s.at, beatsToSnap);
    if (s.at >= total) continue;
    s.duration = Math.min(s.duration, total - s.at);
    if (s.duration < 0.2) continue;
    const allowed = s.def.animations ?? tpl.animations.map((a) => a.id);
    if (s.animIn && !allowed.includes(s.animIn)) {
      warnings.push(`"${s.id}": component "${s.block.componentId}" không có hiệu ứng vào "${s.animIn}" — dùng hiệu ứng mặc định.`);
      delete s.animIn;
    }
    placed.push(s);
  }

  const moved: PlacedOverride[] = [];
  const stats = { segments: segments.length, captions: 0, overlays: 0, brolls: 0, sfx: 0, music: false, beats: 0, scenes: 0, graphics: 0 };
  for (const s of placed) {
    const values = blockValues(s.block, { ...s.values, ...(s.animIn ? { animIn: s.animIn } : {}), duration: r3(s.duration) });
    const { track, z } = LAYER[s.kind];
    const file = blockInstance(s.block, values);
    assets.set(file.name, { file: s.block.file, content: file.html });
    // The hook is not a plan element (it is plan.hook's chosen option, changed by picking another option), so it
    // has no data-el-id: the editor cannot select it, and PUT /overrides has nothing to key it on.
    const ident = s.kind === 'hook' ? 'id="hook" class="clip"' : `id="el-${s.id}" class="clip el" data-el-id="${esc(s.id)}"`;
    clips.push(`<div ${ident} data-composition-id="${esc(s.block.compositionId)}" data-composition-src="assets/${file.name}" data-variable-values="${esc(JSON.stringify(values))}" data-start="${r3(s.at)}" data-duration="${r3(s.duration)}" data-track-index="${track}" data-width="${W}" data-height="${H}" style="position:absolute;inset:0;z-index:${z}"></div>`);
    if (s.t || s.s !== undefined) moved.push({ id: s.id, ...(s.t ? { t: s.t } : {}), ...(s.s !== undefined ? { s: s.s } : {}) });
    if (s.kind === 'broll') stats.brolls++;
    else if (s.kind === 'beat') stats.beats++;
    else if (s.kind === 'scene') stats.scenes++;
    else if (s.kind === 'graphic') stats.graphics++;
  }
  stats.overlays = stats.beats + stats.scenes + stats.graphics;

  // ── Captions ──
  const cues = captionCues(words, segments, cut, plan.captions.highlight, capStyle.maxWordsPerChunk, total);
  const captions = captionLayer(cues, capStyle, captionFamily(capFamily), { W, H, dark: tpl.tokens.colors.dark ?? '#141416' });
  clips.push(...captions.clips);
  tl.push(...captions.tweens);
  stats.captions = cues.length;

  // ── Zooms on the A-roll ──
  for (const zm of plan.zooms) {
    const o = overrideOf(ov, zm.id);
    if (o?.hidden) continue;
    const at = o?.at ?? zm.at;
    if (at >= total) continue;
    const d = Math.min(o?.duration ?? zm.duration, total - at);
    const up = Math.min(0.3, d / 2);
    tl.push(`tl.fromTo(".vc",{scale:1},{scale:${zm.scale},duration:${r3(up)},ease:"power2.out",immediateRender:false},${r3(at)});`);
    tl.push(`tl.to(".vc",{scale:1,duration:${r3(up)},ease:"power2.inOut"},${r3(at + d - up)});`);
  }

  // ── SFX: the elements' sounds (template rules), then the plan's own list ──
  const audio = profile.audio;
  const sfxBase = audio.musicLufs - audio.voiceLufs + 8;
  const own = elementSounds(placed.map((s) => ({
    id: s.id, kind: s.kind === 'hook' ? 'beat' : s.kind, at: s.at, fullFrame: s.fullFrame, sound: s.sound,
    animIn: s.animIn ?? (varDefault(s.block, 'animIn') as string | undefined),
  })), tpl);
  const sounds = [
    ...own.map((c) => ({ at: c.at, assetId: c.assetId, gain: dbToGain(sfxBase) * c.volume })),
    ...plan.sfx.map((s) => ({ at: s.at, assetId: s.assetId, gain: dbToGain(s.gainDb ?? sfxBase) })),
  ].sort((a, b) => a.at - b.at);
  const lanes: number[] = [];
  const missingSfx = new Set<string>();
  sounds.forEach((s, k) => {
    if (s.at >= total) return;
    const a = resolver.byId(s.assetId);
    if (!isAudio(a)) {
      if (!missingSfx.has(s.assetId)) warnings.push(`Tiếng động "${s.assetId}" không có trong kho — bỏ qua.`);
      missingSfx.add(s.assetId);
      return;
    }
    const dur = Math.min(a.durationSec ?? 2, total - s.at);
    if (dur < 0.05) return;
    // First SFX row that is free at this time, so two sounds never share a row while both play.
    let lane = lanes.findIndex((end) => end <= s.at);
    if (lane < 0) { lanes.push(0); lane = lanes.length - 1; }
    lanes[lane] = s.at + dur;
    clips.push(`<audio id="sfx${k}" class="clip" src="${useAsset(a)}" data-start="${r3(s.at)}" data-duration="${r3(dur)}" data-media-start="0" data-volume="${r3(Math.min(3.98, s.gain))}" data-track-index="${11 + lane}"></audio>`);
    stats.sfx++;
  });

  // ── Music bed ──
  if (bed) {
    // The plan's gainDb is the bed under the voice; the owner's gainDb fine-tunes around the profile level instead.
    const profileRel = audio.musicLufs - audio.voiceLufs;
    const rel = ownMusic?.gainDb !== undefined ? profileRel + ownMusic.gainDb
      : plan.music && Number.isFinite(plan.music.gainDb) ? plan.music.gainDb : profileRel;
    const duck = ownMusic?.duck ?? music?.duck ?? plan.music?.duck ?? true;
    const attrs = musicAttrs(bed, rel, duck ? speechRanges(words, segments, cut) : null);
    const extra = Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
    clips.push(`<audio id="music" class="clip" src="${useAsset(bed.asset)}" data-start="${r3(bed.start)}" data-duration="${r3(bed.duration)}" data-media-start="${r3(bed.mediaStart)}" ${extra} data-track-index="10"></audio>`);
    stats.music = true;
  }

  const html = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=${W}, height=${H}">
<script src="${GSAP_URL}"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#000}
:root{${themeVars.join(';')}}
${faces.join('\n')}
${captions.css}
</style></head>
<body><div id="main" data-composition-id="main" data-start="0" data-duration="${r3(total)}" data-width="${W}" data-height="${H}">
${clips.join('\n')}
</div>
<script>
window.__timelines=window.__timelines||{};
(function(){
${overridesScript(moved)}
function build(){
var tl=gsap.timeline({paused:true});
${tl.join('\n')}
applyOverrides();
window.__timelines["main"]=tl;
}
${fontCheckScript(fontChecks, mode === 'export')}
})();
</script></body></html>`;

  return {
    html,
    assets: [...assets.entries()].map(([name, a]) => ({ name, file: a.file, ...(a.content !== undefined ? { content: a.content } : {}) })),
    durationSec: r3(total),
    width: W,
    height: H,
    warnings,
    stats,
  };
}

/**
 * Before the timeline is registered (the runtime waits for it): load every declared face with Vietnamese marks,
 * then check it loaded. A face that did not load would render in a fallback font with no error, so an export
 * stops with the runtime's startup error instead; the preview only reports it.
 */
function fontCheckScript(fonts: { family: string; weight: number }[], strict: boolean): string {
  if (!fonts.length) return 'build();';
  return [
    `var FONTS=${JSON.stringify(fonts).replace(/</g, '\\u003c')},SAMPLE=${JSON.stringify(FONT_SAMPLE)};`,
    'var spec=function(f){return f.weight+" 64px \\""+f.family+"\\"";};',
    'if(!document.fonts||!document.fonts.load){build();return;}',
    'Promise.all(FONTS.map(function(f){return document.fonts.load(spec(f),SAMPLE).catch(function(){return [];});})).then(function(){',
    '  var missing=FONTS.filter(function(f){return !document.fonts.check(spec(f),SAMPLE);}).map(function(f){return f.family;});',
    '  window.__vsFontCheck={ok:missing.length===0,missing:missing};',
    '  if(missing.length){',
    '    console.error("[video] Font chưa nạp: "+missing.join(", "));',
    strict ? '    window.__hfStartupError="Font chưa nạp được: "+missing.join(", ")+". Kiểm tra font trong Kho rồi xuất lại.";' : '',
    '  }',
    '  build();',
    '});',
  ].filter(Boolean).join('\n');
}
