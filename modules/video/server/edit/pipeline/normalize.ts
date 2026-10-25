// Ingest, step 2: turn the raw upload into the three working files every later step reads.
//   master.mp4  short side ≤ 1080, constant 30 fps, H.264 + AAC (what export renders from)
//   proxy.mp4   long side ≤ 960, small + keyframe-dense (what the live preview plays)
//   audio.wav   16 kHz mono PCM (what whisper and the analysis read)
// HDR footage (iPhone HLG, PQ cameras) is tone-mapped to Rec.709 SDR on the way into the master; without it
// the 8-bit master keeps HDR transfer tags and players show it blown out.
import fs from 'node:fs';
import path from 'node:path';
import { ffprobeBin, runChecked, runFfmpeg } from './tools.js';

export interface NormalizeInput {
  raw: string;
  /** Project `source/` folder; the three files are written there. */
  outDir: string;
  durationSec: number;
  hasAudio: boolean;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Test seams: the source's colour transfer (ffprobe) and whether ffmpeg has zscale + tonemap. */
  colorTransfer?: (raw: string) => Promise<string | null>;
  canTonemap?: () => Promise<boolean>;
}

export interface NormalizeResult {
  master: string;
  proxy: string;
  audio: string;
  /** tonemapped = HDR source turned into SDR; untouched = HDR source, but ffmpeg has no zimg to convert it. */
  hdr?: 'tonemapped' | 'untouched';
}

/** Cap the short side at 1080 without ever upscaling; keep both sides even. */
export const MASTER_SCALE =
  "scale='if(gt(iw,ih),-2,min(1080,iw))':'if(gt(iw,ih),min(1080,ih),-2)':flags=lanczos";
/** Cap the long side at 960. */
export const PROXY_SCALE =
  "scale='if(gt(iw,ih),min(960,iw),-2)':'if(gt(iw,ih),-2,min(960,ih))':flags=bilinear";

// HDR → SDR, from video-use `helpers/render.py` (Copyright (c) 2026 Browser Use, MIT License; see
// THIRD_PARTY_NOTICES.md › video-use): PQ (HDR10) and HLG sources, linearised, Hable tone curve, Rec.709.
export const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);
export const TONEMAP_CHAIN =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
/** Tag the SDR master as Rec.709 so players do not guess. */
const BT709_TAGS = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];

export const isHdrTransfer = (transfer: string | null | undefined): boolean => HDR_TRANSFERS.has((transfer ?? '').trim());

/** Video filter of the master: tone-mapped first when the source is HDR and ffmpeg can do it. */
export function masterVideoFilter(transfer: string | null | undefined, canTonemap: boolean): string {
  const tonemap = isHdrTransfer(transfer) && canTonemap ? `${TONEMAP_CHAIN},` : '';
  return `fps=30,${tonemap}${MASTER_SCALE},format=yuv420p`;
}

/** color_transfer of the first video stream ("arib-std-b67" = HLG, "smpte2084" = PQ), null when unknown. */
export async function probeColorTransfer(raw: string): Promise<string | null> {
  try {
    const res = await runChecked(ffprobeBin(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_transfer', '-of', 'default=noprint_wrappers=1:nokey=1', raw], { timeoutMs: 30_000 });
    return res.stdout.trim().split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

/** zscale and tonemap need ffmpeg built with zimg (doctor reports it). Lines of `ffmpeg -filters` look like " ... zscale  V->V  …". */
export function hasTonemapFilters(filters: string): boolean {
  return /\szscale\s/.test(filters) && /\stonemap\s/.test(filters);
}

let tonemapSupport: Promise<boolean> | null = null;
export function ffmpegCanTonemap(): Promise<boolean> {
  tonemapSupport ??= runFfmpeg(['-filters'], { timeoutMs: 15_000 }).then((r) => hasTonemapFilters(r.stdout), () => false);
  return tonemapSupport;
}

export async function normalizeSource(input: NormalizeInput): Promise<NormalizeResult> {
  fs.mkdirSync(input.outDir, { recursive: true });
  const master = path.join(input.outDir, 'master.mp4');
  const proxy = path.join(input.outDir, 'proxy.mp4');
  const audio = path.join(input.outDir, 'audio.wav');
  // Write next to the target, then rename, so a crash never leaves a half-written master.
  const tmp = (file: string) => file.replace(/\.(\w+)$/, '.part.$1');
  const span = input.durationSec;
  const report = (from: number, to: number) => (f: number) => input.onProgress?.(from + (to - from) * f);
  const common = { signal: input.signal, durationSec: span };

  // Footage without sound gets a silent track so loudnorm, captions timing and mixing never special-case it.
  const audioIn = input.hasAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
  const maps = input.hasAudio ? ['-map', '0:v:0', '-map', '0:a:0'] : ['-map', '0:v:0', '-map', '1:a:0', '-shortest'];

  const transfer = await (input.colorTransfer ?? probeColorTransfer)(input.raw);
  const hdr = isHdrTransfer(transfer);
  const tonemap = hdr && await (input.canTonemap ?? ffmpegCanTonemap)();

  await runFfmpeg([
    '-y', '-i', input.raw, ...audioIn, ...maps,
    '-vf', masterVideoFilter(transfer, tonemap),
    ...(tonemap ? BT709_TAGS : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', '30', '-keyint_min', '30',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', '-f', 'mp4', tmp(master),
  ], { ...common, onProgress: report(0, 0.7), timeoutMs: 60 * 60_000 });
  fs.renameSync(tmp(master), master);

  await runFfmpeg([
    '-y', '-i', master,
    '-vf', `${PROXY_SCALE},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-g', '15', '-keyint_min', '15',
    '-c:a', 'aac', '-b:a', '96k', '-ar', '44100',
    '-movflags', '+faststart', '-f', 'mp4', tmp(proxy),
  ], { ...common, onProgress: report(0.7, 0.92), timeoutMs: 30 * 60_000 });
  fs.renameSync(tmp(proxy), proxy);

  await runFfmpeg([
    '-y', '-i', master, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', tmp(audio),
  ], { ...common, onProgress: report(0.92, 1), timeoutMs: 10 * 60_000 });
  fs.renameSync(tmp(audio), audio);

  return { master, proxy, audio, ...(hdr ? { hdr: tonemap ? 'tonemapped' as const : 'untouched' as const } : {}) };
}
