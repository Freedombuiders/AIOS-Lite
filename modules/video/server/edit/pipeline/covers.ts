// Three cover images: a frame from the video plus the title inside the safe zone.
// Typeset by Chrome (HyperFrames snapshot) so Vietnamese diacritics, wrapping and fonts just work.
import fs from 'node:fs';
import path from 'node:path';
import type { EditPlan, VideoProfile, VideoProject, VideoStyle } from '../types.js';
import type { VideoEditStore } from '../store.js';
import { ASPECT_SIZE } from './composition.js';
import type { AssetResolver } from './library-resolve.js';
import { extractFrame } from './analyze.js';
import { hyperframesVersion, runChecked, runFfmpeg, GSAP_URL } from './tools.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export interface CoverInput {
  store: VideoEditStore;
  project: Pick<VideoProject, 'id' | 'code' | 'title' | 'aspect'>;
  profile: Pick<VideoProfile, 'brand' | 'coverStyle'>;
  style?: VideoStyle | null;
  plan: EditPlan;
  resolver: AssetResolver;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  /** Test seam: replaces the HyperFrames snapshot (must write the PNGs `at` asks for). */
  snapshot?: (a: { dir: string; times: number[]; outDir: string; signal?: AbortSignal }) => Promise<string[]>;
}

export async function defaultSnapshot(a: { dir: string; times: number[]; outDir: string; signal?: AbortSignal }): Promise<string[]> {
  fs.mkdirSync(a.outDir, { recursive: true });
  await runChecked('npx', [
    '-y', `hyperframes@${hyperframesVersion()}`, 'snapshot', a.dir, '--at', a.times.join(','), '--no-end', '-o', a.outDir, '--describe', 'false',
  ], { signal: a.signal, timeoutMs: 10 * 60_000 });
  return fs.readdirSync(a.outDir).filter((n) => n.endsWith('.png')).sort().map((n) => path.join(a.outDir, n));
}

type Variant = 'bottom' | 'top' | 'center';

function coverHtml(opts: {
  W: number; H: number; items: { frame: string; title: string; subtitle?: string; variant: Variant }[];
  accent: string; text: string; dark: string; fontFace: string; family: string;
}): string {
  const { W, H } = opts;
  const u = Math.min(W, H) / 1080;
  const landscape = W > H;
  // TikTok/Reels cover the bottom ~22% and the right edge: keep text in the middle band.
  const slides = opts.items.map((it, k) => {
    const place = it.variant === 'top' ? `top:${0.12 * H}px` : it.variant === 'center' ? `top:${0.34 * H}px` : `top:${(landscape ? 0.5 : 0.52) * H}px`;
    const card = it.variant === 'center'
      ? `background:rgba(12,12,16,.74);border-radius:${34 * u}px;padding:${40 * u}px ${44 * u}px;`
      : '';
    return `<div id="c${k}" class="clip" data-start="${k}" data-duration="1" data-track-index="${k}" style="position:absolute;inset:0;overflow:hidden">`
      + `<img src="${esc(it.frame)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">`
      + `<div style="position:absolute;inset:0;background:linear-gradient(${it.variant === 'top' ? '180deg' : '0deg'},rgba(0,0,0,.72) 0%,rgba(0,0,0,0) ${landscape ? 62 : 52}%)"></div>`
      + `<div style="position:absolute;left:${8 * u}%;right:${14}%;${place};text-align:${it.variant === 'center' ? 'center' : 'left'};font-family:${opts.family};${card}">`
      + `<div style="font-weight:900;font-size:${(landscape ? 104 : it.variant === 'center' ? 96 : 112) * u}px;line-height:1.08;color:${opts.text};text-shadow:0 ${6 * u}px ${24 * u}px rgba(0,0,0,.8)"><span style="color:${opts.accent}">${esc(it.title.split(' ').slice(0, 2).join(' '))}</span> ${esc(it.title.split(' ').slice(2).join(' '))}</div>`
      + (it.subtitle ? `<div style="font-weight:700;font-size:${46 * u}px;line-height:1.25;color:${opts.text};margin-top:${18 * u}px;opacity:.95;text-shadow:0 ${4 * u}px ${16 * u}px rgba(0,0,0,.8)">${esc(it.subtitle)}</div>` : '')
      + '</div></div>';
  }).join('\n');
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=${W}, height=${H}">
<script src="${GSAP_URL}"></script>
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:${W}px;height:${H}px;overflow:hidden;background:#000}${opts.fontFace}</style></head>
<body><div id="root" data-composition-id="main" data-start="0" data-duration="${opts.items.length}" data-width="${W}" data-height="${H}">
${slides}
</div><script>window.__timelines=window.__timelines||{};const tl=gsap.timeline({paused:true});window.__timelines["main"]=tl;</script></body></html>`;
}

export async function makeCovers(input: CoverInput): Promise<{ files: string[] }> {
  const { store, project, plan } = input;
  const master = store.masterFile(project.id);
  if (!fs.existsSync(master)) throw new Error('Chưa có bản chuẩn hoá (master.mp4).');
  const { w: W, h: H } = ASPECT_SIZE[plan.aspect ?? project.aspect];
  const workDir = path.join(store.projectDir(project.id), 'covers', '_work');
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const variants: Variant[] = ['bottom', 'top', 'center'];
  const covers = [...plan.covers];
  while (covers.length < 3) covers.push(covers[covers.length - 1] ?? { frameAt: plan.sourceDurationSec * (0.2 + 0.3 * covers.length), title: plan.meta.title || project.title });
  const items: { frame: string; title: string; subtitle?: string; variant: Variant }[] = [];
  for (let k = 0; k < 3; k++) {
    const c = covers[k];
    const frameName = `frame-${k + 1}.jpg`;
    await extractFrame(master, Math.max(0, Math.min(plan.sourceDurationSec - 0.1, c.frameAt)), path.join(workDir, frameName), W, input.signal);
    items.push({
      frame: frameName,
      title: c.title || plan.meta.title || project.title,
      ...(c.subtitle ? { subtitle: c.subtitle } : {}),
      variant: variants[k],
    });
    input.onProgress?.(0.1 + 0.15 * (k + 1));
  }

  const fontSpec = input.profile.brand.fontCover ?? input.profile.brand.fontHeading ?? input.style?.fontHeading;
  const font = input.resolver.font(fontSpec, 'bold');
  let fontFace = '';
  let family = `'${(fontSpec ?? 'Be Vietnam Pro').replace(/[^\p{L}\p{N} \-]/gu, '')}'`;
  if (font) {
    const fname = `cover-font.${font.ext}`;
    try { fs.symlinkSync(font.file, path.join(workDir, fname)); } catch { /* fall back to system font */ }
    if (fs.existsSync(path.join(workDir, fname))) {
      fontFace = `@font-face{font-family:'coverfont';src:url('${fname}');font-weight:100 900}`;
      family = "'coverfont'";
    }
  }
  const safeHex = (c: string | undefined, d: string) => (c && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : d);
  const html = coverHtml({
    W, H, items,
    accent: safeHex(input.profile.brand.accent, safeHex(input.style?.palette.highlight, '#FFD23F')),
    text: safeHex(input.profile.brand.text, '#FFFFFF'),
    dark: safeHex(input.profile.brand.dark, '#141416'),
    fontFace, family: `${family},'Be Vietnam Pro','Helvetica Neue',Arial,sans-serif`,
  });
  fs.writeFileSync(path.join(workDir, 'index.html'), html);

  const shotDir = path.join(workDir, 'shots');
  const times = [0.5, 1.5, 2.5];
  const pngs = await (input.snapshot ?? defaultSnapshot)({ dir: workDir, times, outDir: shotDir, signal: input.signal });
  if (pngs.length < 3) throw new Error(`Chụp ảnh bìa chỉ ra ${pngs.length}/3 ảnh.`);
  input.onProgress?.(0.8);

  const coversDir = store.coversDir(project.id);
  fs.mkdirSync(coversDir, { recursive: true });
  const files: string[] = [];
  for (let k = 0; k < 3; k++) {
    const out = store.coverFile(project.id, (k + 1) as 1 | 2 | 3);
    await runFfmpeg(['-y', '-i', pngs[k], '-frames:v', '1', '-q:v', '2', out], { signal: input.signal, timeoutMs: 60_000 });
    files.push(out);
  }
  fs.rmSync(workDir, { recursive: true, force: true });
  input.onProgress?.(1);
  return { files };
}
