// Step "Chép lời tiếng Việt": whisper-cli with per-word timestamps, then cleanup so the plan can
// address words by index and the cut logic can trust the gaps between them.
//
// parseWhisperJson takes three rules from open-edit `cli/src/transcript/whisper-mapper.ts` (Copyright 2026
// VEED LIMITED, Apache License 2.0; see THIRD_PARTY_NOTICES.md › open-edit): a token holding several words
// is split with times proportional to their length, untimed tokens borrow a window from their timed
// neighbours, and words whose starts run backwards are put back in order. Rewritten for whisper.cpp JSON.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Transcript, TranscriptWord } from '../types.js';
import { detectSilences } from './analyze.js';
import { insertSyntheticWords, probeSpeech, unwordedSounds, voicedRuns, type ProbeResult } from './speech-probe.js';
import { findWhisperModel, r3, runChecked } from './tools.js';

interface WhisperToken {
  text?: string;
  offsets?: { from?: number; to?: number };
}

const SPECIAL_TOKEN = /^(?:\[[^\]]*\]|\([^)]*\)|<\|[^|]*\|>|♪+)$/;
const PUNCT_ONLY = /^[\p{P}\p{S}\s]+$/u;

/** A piece of a whisper token on its way to becoming a word; times are seconds, absent when whisper gave none. */
interface Pending {
  text: string;
  start?: number;
  end?: number;
  /** No leading space in the token: it continues the previous word. */
  glued: boolean;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** A token with spaces inside is several words: split it, each word timed in proportion to its length. */
function splitToken(text: string, glued: boolean, start?: number, end?: number): Pending[] {
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return [{ text, glued, ...(finite(start) && finite(end) ? { start, end } : {}) }];
  if (!finite(start) || !finite(end)) return parts.map((t, k) => ({ text: t, glued: k === 0 && glued }));
  const total = parts.reduce((n, t) => n + t.length, 0) || parts.length;
  const span = Math.max(0, end - start);
  let cursor = start;
  return parts.map((t, k) => {
    const width = (span * t.length) / total;
    const piece = { text: t, glued: k === 0 && glued, start: cursor, end: cursor + width };
    cursor += width;
    return piece;
  });
}

/** Untimed pieces share the window between their timed neighbours; with no timed piece at all, everything is 0. */
function timeUntimed(pending: Pending[]): { text: string; glued: boolean; start: number; end: number }[] {
  const timed = pending.map((p) => finite(p.start) && finite(p.end));
  const first = timed.indexOf(true);
  const last = timed.lastIndexOf(true);
  const out = pending.map((p) => ({ text: p.text, glued: p.glued, start: p.start ?? 0, end: p.end ?? 0 }));
  if (first < 0) return out;
  let i = 0;
  while (i < pending.length) {
    if (timed[i]) { i++; continue; }
    let j = i;
    while (j < pending.length && !timed[j]) j++;
    const from = i > first ? out[i - 1].end : out[first].start;
    const to = j <= last ? out[j].start : out[last].end;
    const lo = Math.min(from, to);
    const step = (Math.max(from, to) - lo) / (j - i);
    for (let k = i; k < j; k++) { out[k].start = lo + step * (k - i); out[k].end = lo + step * (k - i + 1); }
    i = j;
  }
  return out;
}

/**
 * whisper `-ml 1 -sow` JSON → words. Empty and bracketed special tokens are dropped, punctuation-only
 * tokens stick to the previous word, and pieces without a leading space are merged into it.
 */
export function parseWhisperJson(json: unknown): TranscriptWord[] {
  const items = ((json as { transcription?: WhisperToken[] })?.transcription ?? []) as WhisperToken[];
  const pending: Pending[] = [];
  for (const item of items) {
    const raw = item.text ?? '';
    const text = raw.trim();
    if (!text || SPECIAL_TOKEN.test(text)) continue;
    const from = item.offsets?.from;
    const to = item.offsets?.to;
    const start = finite(from) ? from / 1000 : undefined;
    const end = finite(to) && start !== undefined ? Math.max(start, to / 1000) : undefined;
    pending.push(...splitToken(text, !/^\s/.test(raw), start, end));
  }
  const words: TranscriptWord[] = [];
  for (const piece of timeUntimed(pending)) {
    const last = words[words.length - 1];
    if (last && (PUNCT_ONLY.test(piece.text) || piece.glued)) {
      last.text += piece.text;
      last.end = Math.max(last.end, piece.end);
      continue;
    }
    if (PUNCT_ONLY.test(piece.text)) continue;
    words.push({ i: words.length, text: piece.text, start: piece.start, end: piece.end });
  }
  // Starts that run backwards (provider order is not guaranteed) are sorted so the text reads in time order.
  if (words.some((w, k) => k > 0 && w.start < words[k - 1].start)) words.sort((a, b) => a.start - b.start);
  return words.map((w, i) => ({ i, text: w.text, start: r3(w.start), end: r3(w.end) }));
}

/**
 * whisper stretches every word to touch the next one, so pauses vanish. Snap word edges to the
 * silences ffmpeg actually heard: a word never ends inside a silence nor starts inside one.
 */
export function snapWordsToSilence(words: TranscriptWord[], silences: { start: number; end: number }[]): TranscriptWord[] {
  const out = words.map((w) => ({ ...w }));
  for (const w of out) {
    for (const s of silences) {
      if (s.end <= w.start || s.start >= w.end) continue;
      // Silence covers the tail of the word: end at its start. Covers the head: start at its end.
      if (s.start > w.start + 0.04 && s.start < w.end) w.end = r3(s.start);
      else if (s.end < w.end - 0.04 && s.end > w.start) w.start = r3(s.end);
    }
    if (w.end < w.start) w.end = w.start;
  }
  return out;
}

export interface TranscribeInput {
  audio: string;
  durationSec: number;
  language?: string;
  /** Product/brand terms; passed to whisper as the initial prompt. */
  keepWords?: string[];
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Test seam: replaces the whisper-cli invocation and returns its parsed JSON. */
  runWhisper?: (args: { audio: string; model: string; language: string; prompt: string; outBase: string }) => Promise<unknown>;
  /** Test seam: the speech probe of the audio (default: speech-probe on the 16 kHz WAV). */
  probe?: (audio: string, signal?: AbortSignal) => Promise<ProbeResult>;
}

export async function transcribeAudio(input: TranscribeInput): Promise<Transcript> {
  const model = findWhisperModel();
  if (!model && !input.runWhisper) throw new Error('Chưa có model whisper (ggml-*.bin). Xem mục Kiểm tra máy.');
  const language = input.language ?? process.env.VIDEO_EDIT_LANGUAGE ?? 'vi';
  const prompt = (input.keepWords ?? []).map((w) => w.trim()).filter(Boolean).join(', ').slice(0, 400);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'video-edit-whisper-'));
  try {
    const outBase = path.join(work, 'out');
    let json: unknown;
    if (input.runWhisper) {
      json = await input.runWhisper({ audio: input.audio, model: model ?? '', language, prompt, outBase });
    } else {
      const args = ['-m', model!, '-l', language, '-f', input.audio, '-ml', '1', '-sow', '-oj', '-of', outBase, '-np', '-pp'];
      if (prompt) args.push('--prompt', prompt);
      await runChecked('whisper-cli', args, {
        signal: input.signal,
        timeoutMs: 60 * 60_000,
        onData: (chunk) => {
          // `-pp` prints "progress = NN%".
          const m = /progress\s*=\s*(\d+)%/.exec(chunk);
          if (m) input.onProgress?.(Math.min(0.95, Number(m[1]) / 100));
        },
      });
      json = JSON.parse(fs.readFileSync(`${outBase}.json`, 'utf8'));
    }
    let words = parseWhisperJson(json);
    const probe = input.probe ?? ((file: string, signal?: AbortSignal) => probeSpeech(file, { signal }));
    let speech: ProbeResult | null = null;
    try {
      speech = await probe(input.audio, input.signal);
    } catch (err) {
      if (input.signal?.aborted) throw err;
      /* the fixed-threshold silences below still snap the words */
    }
    const gaps = speech?.speechFound ? speech.gaps : [];
    try {
      const silences = await detectSilences(input.audio, input.signal);
      words = snapWordsToSilence(words, [...silences, ...gaps]);
    } catch (err) {
      if (input.signal?.aborted) throw err;
      // Without silencedetect the gaps measured against this clip's own floor still snap word edges.
      if (gaps.length) words = snapWordsToSilence(words, gaps);
    }
    // Sounds whisper gave no word for ("ừm", "à") become synthetic filler words, before anything indexes words.
    if (speech?.speechFound) words = insertSyntheticWords(words, unwordedSounds(words, voicedRuns(speech)));
    input.onProgress?.(1);
    return {
      language,
      model: model ? path.basename(model) : 'test',
      durationSec: r3(input.durationSec),
      words,
      createdAt: new Date().toISOString(),
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

