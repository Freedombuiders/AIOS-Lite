// Export: build the export composition, render it with HyperFrames, normalise loudness with ffmpeg,
// extract QA frames from the result and describe it as a RenderRecord.
import fs from 'node:fs';
import path from 'node:path';
import type { EditPlan, RenderRecord, StepKey, Transcript, VideoProfile, VideoProject, VideoStyle } from '../types.js';
import type { VideoEditStore } from '../store.js';
import { buildComposition, materializeAssets } from './composition.js';
import type { AssetResolver } from './library-resolve.js';
import { fmtDur, hyperframesVersion, probeDuration, r1, r3, runChecked, runFfmpeg } from './tools.js';

export interface HyperframesRenderArgs {
  /** Project directory HyperFrames renders from (the project's `composition/` folder). */
  dir: string;
  /** Composition file inside `dir`. */
  composition: string;
  out: string;
  quality: 'draft' | 'looks';
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/** Default renderer: `npx -y hyperframes@<pin> render`. Tests replace it. */
export async function runHyperframesRender(a: HyperframesRenderArgs): Promise<void> {
  const args = ['-y', `hyperframes@${hyperframesVersion()}`, 'render', a.dir, '-c', a.composition, '-o', a.out, '--quality', a.quality, '--fps', '30'];
  const res = await runChecked('npx', args, {
    signal: a.signal,
    timeoutMs: 60 * 60_000,
    onData: (chunk) => {
      // The CLI prints progress as percentages; take the last one in the chunk.
      const all = [...chunk.matchAll(/(\d{1,3})\s*%/g)];
      if (all.length) a.onProgress?.(Math.min(0.99, Number(all[all.length - 1][1]) / 100));
    },
  });
  void res;
}

export interface RenderInput {
  store: VideoEditStore;
  project: Pick<VideoProject, 'id' | 'code' | 'title' | 'aspect'>;
  profile: Pick<VideoProfile, 'brand' | 'audio'>;
  style?: VideoStyle | null;
  plan: EditPlan;
  transcript: Transcript;
  resolver: AssetResolver;
  quality?: 'draft' | 'looks';
  onProgress?: (fraction: number, message?: string) => void;
  /** Evidence line for a ticket step. */
  log?: (step: StepKey, text: string) => void;
  signal?: AbortSignal;
  /** Test seams. */
  renderer?: (a: HyperframesRenderArgs) => Promise<void>;
  skipLoudnorm?: boolean;
}

interface LoudnormStats { input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string }

export function parseLoudnormJson(stderr: string): LoudnormStats | null {
  const m = [...stderr.matchAll(/\{[^{}]*"input_i"[^{}]*\}/g)].pop();
  if (!m) return null;
  try { return JSON.parse(m[0]) as LoudnormStats; } catch { return null; }
}

/** Two-pass loudnorm: measure, then apply linearly. Video is copied, audio re-encoded to AAC. */
export async function normalizeLoudness(
  input: string, output: string, targetLufs: number, signal?: AbortSignal,
): Promise<{ before?: number; after: number } | null> {
  const target = Math.max(-30, Math.min(-8, targetLufs));
  const base = `loudnorm=I=${target}:TP=-1.5:LRA=11`;
  const probe = await runFfmpeg(['-i', input, '-af', `${base}:print_format=json`, '-vn', '-f', 'null', '-'], { signal, timeoutMs: 20 * 60_000 });
  const stats = parseLoudnormJson(probe.stderr);
  const measured = stats ? Number(stats.input_i) : NaN;
  if (!stats || !Number.isFinite(measured)) {
    // Silent or unreadable audio: ship the render as is.
    fs.copyFileSync(input, output);
    return null;
  }
  const filter = `${base}:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true`;
  await runFfmpeg([
    '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-af', filter,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', output,
  ], { signal, timeoutMs: 30 * 60_000 });
  return { before: measured, after: target };
}

export async function extractQaFrames(video: string, outDir: string, version: number, durationSec: number, signal?: AbortSignal): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  for (const n of fs.readdirSync(outDir)) if (n.startsWith(`v${version}-`)) fs.rmSync(path.join(outDir, n), { force: true });
  const files: string[] = [];
  const count = 6;
  for (let k = 0; k < count; k++) {
    const at = Math.max(0, Math.min(durationSec - 0.1, ((k + 0.5) / count) * durationSec));
    const file = path.join(outDir, `v${version}-${k + 1}.png`);
    try {
      await runFfmpeg(['-y', '-ss', String(r3(at)), '-i', video, '-frames:v', '1', '-vf', 'scale=540:-2', file], { signal, timeoutMs: 60_000 });
      files.push(file);
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }
  return files;
}

export async function renderExport(input: RenderInput): Promise<RenderRecord & { warnings: string[]; qaFiles: string[] }> {
  const { store, project, plan, transcript } = input;
  const log = input.log ?? (() => {});
  const progress = input.onProgress ?? (() => {});
  const master = store.masterFile(project.id);
  if (!fs.existsSync(master)) throw new Error('Chưa có bản chuẩn hoá (master.mp4). Chạy lại bước Nhận video.');
  if (input.style?.id === 'quyen' && !plan.brolls.some((b) => b.enabled && b.source === 'pexels' && b.layout === 'cutout')) {
    throw new Error('Phong cách Quyên cần ít nhất một ảnh Pexels tách nền trên đầu. Thêm PNG alpha vào kho và cập nhật B-roll trong kế hoạch trước khi xuất.');
  }

  // 1. composition
  const built = buildComposition({
    plan, transcript, project, profile: input.profile, style: input.style, mode: 'export', resolver: input.resolver,
  });
  const compDir = store.compositionDir(project.id);
  fs.mkdirSync(compDir, { recursive: true });
  fs.writeFileSync(path.join(compDir, 'export.html'), built.html);
  materializeAssets(compDir, built.assets, master);
  progress(0.05, 'Đã dựng composition');

  const wordsKept = transcript.words.length - plan.cutWords.length;
  log('cut', `đã cắt ${r1(plan.sourceDurationSec)}s → còn ${r1(plan.outputDurationSec)}s (${built.stats.segments} đoạn, ${wordsKept} từ giữ lại)`);
  log('captions', `${built.stats.captions} cụm phụ đề, kiểu ${plan.captions.styleId}, tô ${plan.captions.highlight.length} từ khoá`);
  log('effects', `${plan.hook ? 'hook, ' : ''}${built.stats.overlays} hiệu ứng, ${built.stats.brolls} B-roll${built.warnings.length ? `, bỏ qua ${built.warnings.length} mục` : ''}`);
  for (const w of built.warnings) log('effects', w);
  const a = input.profile.audio;
  log('audio', `${built.stats.music ? 'nhạc nền, ' : 'không nhạc, '}${built.stats.sfx} tiếng động, chuẩn hoá về ${a.finalLufs} LUFS`);

  // 2. render
  const rendersDir = store.rendersDir(project.id);
  fs.mkdirSync(rendersDir, { recursive: true });
  const raw = path.join(rendersDir, `.raw.v${plan.version}.mp4`);
  fs.rmSync(raw, { force: true });
  const quality = input.quality ?? (process.env.VIDEO_EDIT_RENDER_QUALITY === 'draft' ? 'draft' : 'looks');
  const started = Date.now();
  await (input.renderer ?? runHyperframesRender)({
    dir: compDir, composition: 'export.html', out: raw, quality, signal: input.signal,
    onProgress: (f) => progress(0.05 + 0.8 * f, 'Đang xuất video'),
  });
  if (!fs.existsSync(raw)) throw new Error('HyperFrames không tạo ra video.');
  progress(0.86, 'Chuẩn hoá âm lượng');

  // 3. loudness
  const final = path.join(rendersDir, `final.v${plan.version}.mp4`);
  const tmpFinal = path.join(rendersDir, `.final.v${plan.version}.part.mp4`);
  let loud: { before?: number; after: number } | null = null;
  if (input.skipLoudnorm) fs.copyFileSync(raw, tmpFinal);
  else loud = await normalizeLoudness(raw, tmpFinal, a.finalLufs, input.signal);
  fs.renameSync(tmpFinal, final);
  fs.rmSync(raw, { force: true });
  progress(0.94, 'Chụp khung để soát');

  // 4. QA frames + checks
  const duration = await probeDuration(final);
  const qaFiles = await extractQaFrames(final, store.qaDir(project.id), plan.version, duration, input.signal);
  const drift = Math.abs(duration - plan.outputDurationSec);
  const loudText = loud ? `${r1(loud.before ?? 0)} → ${loud.after} LUFS` : 'giữ nguyên (không đo được)';
  log('render', `${fmtDur(duration)} · ${(fs.statSync(final).size / 1024 / 1024).toFixed(1)} MB · ${Math.round((Date.now() - started) / 1000)}s xuất · âm lượng ${loudText}${drift > 1 ? ` · lệch ${r1(drift)}s so với kế hoạch` : ''} · ${qaFiles.length} khung soát`);
  progress(1);

  return {
    version: plan.version,
    file: path.relative(store.projectDir(project.id), final).split(path.sep).join('/'),
    durationSec: r3(duration),
    sizeBytes: fs.statSync(final).size,
    createdAt: new Date().toISOString(),
    warnings: built.warnings,
    qaFiles,
  };
}
