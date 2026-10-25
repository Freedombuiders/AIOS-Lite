// Step "Soi chỗ lặng & vấp": silences, filler words, restarted phrases, scene changes,
// keyframes for the agent to look at, and loudness. Everything is deterministic ffmpeg + text.
// Filler sounds whisper left out are already in the transcript as synthetic words (transcribe.ts with
// speech-probe.ts): they are listed as fillers here, so the cut list removes them like any other.
import fs from 'node:fs';
import path from 'node:path';
import type { AnalysisResult, Transcript } from '../types.js';
import { r3, runFfmpeg } from './tools.js';

export const SILENCE_DB = Number(process.env.VIDEO_EDIT_SILENCE_DB) || -35;
export const SILENCE_MIN_SEC = 0.35;
/** A repeated phrase counts as a retake only when the two takes start this close together. */
export const RETAKE_WINDOW_SEC = 8;
export const RETAKE_MIN_WORDS = 3;
/**
 * ...and the aborted attempt is short: besides the repeated words it may hold at most this many extra
 * words. A longer stretch in between is real content that happens to repeat a phrase, not a stumble.
 */
const RETAKE_MAX_EXTRA_WORDS = 3;

/** Lower-case, no punctuation, composed form: the key words are compared by. */
export function normWord(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}%]+/gu, '');
}

// Standalone hesitation sounds. Matched on the whole token, so "à" inside a real word never counts.
const FILLER_RE = /^(?:ờ+|ừ+|ừm+|ờm+|ừhm+|ờhm+|ưm+|ừmm+|hmm+|hm+|mm+|à+|ơ+|ầm+|ê+|ah+|uh+|um+|umm+|er+|eh+)$/u;

export function isFillerWord(text: string): boolean {
  const n = normWord(text);
  return n.length > 0 && FILLER_RE.test(n);
}

/** A word the cut list may drop as a hesitation: a filler word, or a voiced sound with no word (synthetic). */
export const isFiller = (w: Pick<Transcript['words'][number], 'text' | 'synthetic'>): boolean => Boolean(w.synthetic) || isFillerWord(w.text);

export function findFillers(words: Transcript['words']): AnalysisResult['fillers'] {
  const out: AnalysisResult['fillers'] = [];
  for (const w of words) if (isFiller(w)) out.push({ wordIndex: w.i, text: w.text });
  return out;
}

/**
 * Restarted phrases: the speaker says a ≥3-word phrase, stumbles and says it again within ~8 s.
 * The earlier take (from its first word up to the word before the restart) is the retake.
 */
export function findRetakes(words: Transcript['words']): AnalysisResult['retakes'] {
  const keys = words.map((w) => (isFiller(w) ? '' : normWord(w.text)));
  const out: AnalysisResult['retakes'] = [];
  let i = 0;
  while (i < words.length) {
    if (!keys[i]) { i++; continue; }
    let best: { j: number; n: number } | null = null;
    for (let j = i + 1; j < words.length; j++) {
      if (words[j].start - words[i].start > RETAKE_WINDOW_SEC) break;
      let n = 0;
      while (j + n < words.length && keys[i + n] && keys[i + n] === keys[j + n] && i + n < j) n++;
      if (n >= RETAKE_MIN_WORDS && j - i <= n + RETAKE_MAX_EXTRA_WORDS && (!best || n > best.n)) best = { j, n };
    }
    if (best) {
      const toWord = best.j - 1;
      out.push({
        fromWord: i,
        toWord,
        text: words.slice(i, toWord + 1).map((w) => w.text).join(' '),
      });
      i = best.j;
    } else i++;
  }
  return out;
}

export function parseSilences(stderr: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start: number | null = null;
  for (const line of stderr.split('\n')) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) { start = Math.max(0, Number(s[1])); continue; }
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (e && start !== null) { out.push({ start: r3(start), end: r3(Number(e[1])) }); start = null; }
  }
  return out;
}

export async function detectSilences(wav: string, signal?: AbortSignal): Promise<{ start: number; end: number }[]> {
  const res = await runFfmpeg(
    ['-i', wav, '-af', `silencedetect=noise=${SILENCE_DB}dB:d=${SILENCE_MIN_SEC}`, '-f', 'null', '-'],
    { signal, timeoutMs: 10 * 60_000 },
  );
  return parseSilences(res.stderr);
}

export function parseScenes(stderr: string): number[] {
  const out: number[] = [];
  for (const m of stderr.matchAll(/lavfi\.scd\.time:\s*([\d.]+)/g)) out.push(r3(Number(m[1])));
  return [...new Set(out)].sort((a, b) => a - b);
}

export async function detectScenes(video: string, signal?: AbortSignal): Promise<number[]> {
  const res = await runFfmpeg(
    ['-i', video, '-an', '-vf', 'scdet=threshold=10:sc_pass=1', '-f', 'null', '-'],
    { signal, timeoutMs: 15 * 60_000 },
  );
  return parseScenes(res.stderr);
}

export function parseLoudness(stderr: string): number | undefined {
  // The final summary block: "  I:         -23.0 LUFS".
  const m = [...stderr.matchAll(/^\s*I:\s*(-?[\d.]+)\s*LUFS/gm)].pop();
  return m ? r3(Number(m[1])) : undefined;
}

export async function measureLoudness(wav: string, signal?: AbortSignal): Promise<number | undefined> {
  const res = await runFfmpeg(['-i', wav, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { signal, timeoutMs: 10 * 60_000 });
  return parseLoudness(res.stderr);
}

/** Times to look at: an even spread (≥6) plus a point just after each scene change (capped). */
export function pickFrameTimes(durationSec: number, scenes: number[], minFrames = 6, maxScene = 6): number[] {
  const d = Math.max(0.2, durationSec);
  const times: number[] = [];
  for (let k = 0; k < minFrames; k++) times.push(r3(((k + 0.5) / minFrames) * d));
  const step = Math.max(1, Math.ceil(scenes.length / maxScene));
  for (let k = 0; k < scenes.length; k += step) {
    const t = Math.min(d - 0.1, scenes[k] + 0.25);
    if (t > 0 && times.every((x) => Math.abs(x - t) > 0.6)) times.push(r3(t));
  }
  return times.sort((a, b) => a - b);
}

export async function extractFrame(video: string, at: number, dest: string, width = 640, signal?: AbortSignal): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await runFfmpeg(
    ['-y', '-ss', String(Math.max(0, at)), '-i', video, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', dest],
    { signal, timeoutMs: 60_000 },
  );
}

export interface AnalyzeInput {
  transcript: Transcript;
  audio: string;
  /** Video the scene detection and frames read from (the proxy is plenty). */
  video: string;
  /** Project folder: frames go to <projectDir>/frames/. */
  projectDir: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export async function analyzeSource(input: AnalyzeInput): Promise<AnalysisResult> {
  const { transcript, signal } = input;
  const silences = await detectSilences(input.audio, signal);
  input.onProgress?.(0.2);
  const fillers = findFillers(transcript.words);
  const retakes = findRetakes(transcript.words);
  const scenes = await detectScenes(input.video, signal);
  input.onProgress?.(0.5);
  const loudnessLufs = await measureLoudness(input.audio, signal);
  input.onProgress?.(0.6);

  const framesDir = path.join(input.projectDir, 'frames');
  fs.rmSync(framesDir, { recursive: true, force: true });
  const times = pickFrameTimes(transcript.durationSec, scenes);
  const frames: AnalysisResult['frames'] = [];
  for (let k = 0; k < times.length; k++) {
    const file = path.join('frames', `f-${String(Math.round(times[k] * 1000)).padStart(6, '0')}.jpg`);
    try {
      await extractFrame(input.video, times[k], path.join(input.projectDir, file), 640, signal);
      frames.push({ at: times[k], file: file.split(path.sep).join('/') });
    } catch (err) {
      if (signal?.aborted) throw err;
      /* a frame that cannot be decoded is skipped; the rest still help the agent */
    }
    input.onProgress?.(0.6 + 0.4 * ((k + 1) / times.length));
  }

  return {
    silences, fillers, retakes, scenes, frames,
    ...(loudnessLufs !== undefined ? { loudnessLufs } : {}),
    createdAt: new Date().toISOString(),
  };
}

