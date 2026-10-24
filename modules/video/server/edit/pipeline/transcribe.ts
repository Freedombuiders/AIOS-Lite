// Step "Chép lời tiếng Việt": whisper-cli with per-word timestamps, then cleanup so the plan can
// address words by index and the cut logic can trust the gaps between them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Transcript, TranscriptWord } from '../types.js';
import { detectSilences } from './analyze.js';
import { findWhisperModel, r3, runChecked } from './tools.js';

interface WhisperToken {
  text?: string;
  offsets?: { from?: number; to?: number };
}

const SPECIAL_TOKEN = /^(?:\[[^\]]*\]|\([^)]*\)|<\|[^|]*\|>|♪+)$/;
const PUNCT_ONLY = /^[\p{P}\p{S}\s]+$/u;

/**
 * whisper `-ml 1 -sow` JSON → words. Empty and bracketed special tokens are dropped, punctuation-only
 * tokens stick to the previous word, and pieces without a leading space are merged into it.
 */
export function parseWhisperJson(json: unknown): TranscriptWord[] {
  const items = ((json as { transcription?: WhisperToken[] })?.transcription ?? []) as WhisperToken[];
  const words: TranscriptWord[] = [];
  for (const item of items) {
    const raw = item.text ?? '';
    const text = raw.trim();
    if (!text || SPECIAL_TOKEN.test(text)) continue;
    const start = (item.offsets?.from ?? 0) / 1000;
    const end = Math.max(start, (item.offsets?.to ?? 0) / 1000);
    const last = words[words.length - 1];
    const glued = !/^\s/.test(raw);
    if (last && (PUNCT_ONLY.test(text) || glued)) {
      last.text += text;
      last.end = Math.max(last.end, end);
      continue;
    }
    if (PUNCT_ONLY.test(text)) continue;
    words.push({ i: words.length, text, start: r3(start), end: r3(end) });
  }
  for (const w of words) w.end = r3(w.end);
  return words;
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
    try {
      const silences = await detectSilences(input.audio, input.signal);
      words = snapWordsToSilence(words, silences);
    } catch (err) {
      if (input.signal?.aborted) throw err;
      /* without silence data the raw whisper timings still work, just with fewer cuts */
    }
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

