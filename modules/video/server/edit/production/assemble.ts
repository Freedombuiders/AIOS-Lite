/**
 * Assemble a production into one A-roll and a word-timed transcript.
 *
 * Every finished scene is normalised to the production frame (cover-crop, 30 fps, AAC 48 kHz stereo,
 * silent track added when a clip has none), then concatenated. The transcript comes from the script,
 * not from speech recognition: HeyGen's SRT gives segment timings, and the words of each segment (or of
 * the whole line when there is no SRT) are spread evenly over their time. The HyperFrames editor then
 * treats the A-roll like any recorded video, without Whisper.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ASPECT_SIZE } from '../pipeline/composition.js';
import { probeDuration, runFfmpeg } from '../pipeline/tools.js';
import type { Transcript, TranscriptWord, VideoAspect } from '../types.js';
import type { ProductionScene } from './types.js';

export interface SrtCue { start: number; end: number; text: string }

function srtTime(t: string): number {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(t.trim());
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0').slice(0, 3)) / 1000;
}

export function parseSrt(text: string): SrtCue[] {
  const cues: SrtCue[] = [];
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    const timeLine = lines.findIndex((l) => l.includes('-->'));
    if (timeLine < 0) continue;
    const [a, b] = lines[timeLine].split('-->');
    const start = srtTime(a), end = srtTime(b);
    const body = lines.slice(timeLine + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && body) cues.push({ start, end, text: body });
  }
  return cues;
}

const splitWords = (text: string) => text.split(/\s+/).map((w) => w.trim()).filter(Boolean);

/** Words spread evenly over [start, end), each word's share weighted by its length. */
export function spreadWords(text: string, start: number, end: number): { text: string; start: number; end: number }[] {
  const words = splitWords(text);
  if (!words.length || end <= start) return [];
  const weights = words.map((w) => Math.max(2, w.length));
  const total = weights.reduce((s, x) => s + x, 0);
  const span = end - start;
  let t = start;
  return words.map((w, i) => {
    const d = (weights[i] / total) * span;
    const out = { text: w, start: round3(t), end: round3(t + d) };
    t += d;
    return out;
  });
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface TimedScene {
  scene: Pick<ProductionScene, 'kind' | 'text'>;
  /** Start of the scene in the A-roll. */
  offset: number;
  durationSec: number;
  srt: string | null;
  /** Trim start inside the take: SRT cues are shifted by it. */
  trimStart?: number;
}

/** Word-timed transcript of the assembled A-roll. Only talking scenes contribute words. */
export function scriptTranscript(scenes: TimedScene[], totalSec: number): Transcript {
  const words: TranscriptWord[] = [];
  for (const s of scenes) {
    if (s.scene.kind !== 'talking' || !s.scene.text.trim()) continue;
    const cut = s.trimStart ?? 0;
    const cues = s.srt
      ? parseSrt(s.srt).map((c) => ({ ...c, start: Math.max(0, c.start - cut), end: c.end - cut })).filter((c) => c.end > 0 && c.start < s.durationSec)
      : [];
    const parts = cues.length
      ? cues.flatMap((c) => spreadWords(c.text, s.offset + c.start, s.offset + Math.min(c.end, s.durationSec)))
      : spreadWords(s.scene.text, s.offset + Math.min(0.25, s.durationSec * 0.05), s.offset + Math.max(0.5, s.durationSec - 0.25));
    for (const w of parts) words.push({ i: words.length, text: w.text, start: w.start, end: w.end, prob: 1 });
  }
  return { language: 'vi', model: 'script', durationSec: round3(totalSec), words, createdAt: new Date().toISOString() };
}

export interface AssembleInput {
  aspect: VideoAspect;
  /** start: trim point inside the take; durationSec: how much of it plays. */
  scenes: { file: string; durationSec: number; start?: number; srt: string | null; scene: Pick<ProductionScene, 'kind' | 'text'> }[];
  workDir: string;
  out: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number, message?: string) => void;
  /** Test seam. */
  ffmpeg?: typeof runFfmpeg;
  probe?: (file: string) => Promise<number>;
  hasAudio?: (file: string) => Promise<boolean>;
}

async function fileHasAudio(file: string): Promise<boolean> {
  const { runChecked, ffprobeBin } = await import('../pipeline/tools.js');
  const r = await runChecked(ffprobeBin(), ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file], { timeoutMs: 30_000 });
  return r.stdout.trim().length > 0;
}

export async function assembleProduction(input: AssembleInput): Promise<{ file: string; durationSec: number; transcript: Transcript }> {
  const ffmpeg = input.ffmpeg ?? runFfmpeg;
  const probe = input.probe ?? probeDuration;
  const hasAudio = input.hasAudio ?? fileHasAudio;
  if (!input.scenes.length) throw new Error('Chưa có cảnh nào hoàn tất để ghép.');
  const { w, h } = ASPECT_SIZE[input.aspect];
  fs.mkdirSync(input.workDir, { recursive: true });

  const parts: string[] = [];
  const timed: TimedScene[] = [];
  let offset = 0;
  for (const [i, s] of input.scenes.entries()) {
    input.signal?.throwIfAborted();
    input.onProgress?.(i / (input.scenes.length + 1), `Chuẩn hoá cảnh ${i + 1}/${input.scenes.length}`);
    const part = path.join(input.workDir, `part-${String(i + 1).padStart(2, '0')}.mp4`);
    const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=30,format=yuv420p`;
    const audio = await hasAudio(s.file);
    const seek = s.start && s.start > 0 ? ['-ss', String(s.start)] : [];
    const args = audio
      ? ['-y', ...seek, '-i', s.file, '-t', String(s.durationSec), '-vf', vf, '-af', 'aresample=48000,aformat=channel_layouts=stereo', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', part]
      : ['-y', ...seek, '-i', s.file, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', String(s.durationSec), '-vf', vf, '-map', '0:v:0', '-map', '1:a:0', '-shortest', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', part];
    await ffmpeg(args, { signal: input.signal, timeoutMs: 15 * 60_000 });
    const d = (await probe(part)) || s.durationSec;
    parts.push(part);
    timed.push({ scene: s.scene, offset, durationSec: d, srt: s.srt, trimStart: s.start ?? 0 });
    offset += d;
  }

  input.onProgress?.(input.scenes.length / (input.scenes.length + 1), 'Ghép các cảnh');
  const list = path.join(input.workDir, 'concat.txt');
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', input.out], { signal: input.signal, timeoutMs: 15 * 60_000 });
  const total = (await probe(input.out)) || offset;
  input.onProgress?.(1, 'Đã ghép xong');
  return { file: input.out, durationSec: total, transcript: scriptTranscript(timed, total) };
}
