// Ingest, step 2: turn the raw upload into the three working files every later step reads.
//   master.mp4  short side ≤ 1080, constant 30 fps, H.264 + AAC (what export renders from)
//   proxy.mp4   long side ≤ 960, small + keyframe-dense (what the live preview plays)
//   audio.wav   16 kHz mono PCM (what whisper and the analysis read)
import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg } from './tools.js';

export interface NormalizeInput {
  raw: string;
  /** Project `source/` folder; the three files are written there. */
  outDir: string;
  durationSec: number;
  hasAudio: boolean;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface NormalizeResult {
  master: string;
  proxy: string;
  audio: string;
}

/** Cap the short side at 1080 without ever upscaling; keep both sides even. */
export const MASTER_SCALE =
  "scale='if(gt(iw,ih),-2,min(1080,iw))':'if(gt(iw,ih),min(1080,ih),-2)':flags=lanczos";
/** Cap the long side at 960. */
export const PROXY_SCALE =
  "scale='if(gt(iw,ih),min(960,iw),-2)':'if(gt(iw,ih),-2,min(960,ih))':flags=bilinear";

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

  await runFfmpeg([
    '-y', '-i', input.raw, ...audioIn, ...maps,
    '-vf', `fps=30,${MASTER_SCALE},format=yuv420p`,
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

  return { master, proxy, audio };
}
