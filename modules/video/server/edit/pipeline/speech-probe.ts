// Where speech starts and stops, measured from the audio rather than read off a transcript.
//
// Word boundaries are not cut points: ASR can report a gap between two words where the waveform shows
// unbroken voicing, and cutting there slices a phoneme. The noise floor is measured per clip, since a
// street sits 20 dB above a quiet room and one fixed threshold finds gaps in one but not the other.
//
// Ported from open-edit `cli/src/commands/speech-probe.ts` (envelopeOf, percentile, analyse):
//   Copyright 2026 VEED LIMITED. Licensed under the Apache License, Version 2.0
//   (http://www.apache.org/licenses/LICENSE-2.0). Changes: the PCM is read from the 16 kHz WAV the
//   ingest step writes (ffmpeg only for other files), the CLI is dropped, and AIOS-Lite adds
//   voicedRuns/unwordedSounds/insertSyntheticWords to find sounds the transcript has no word for.
// See THIRD_PARTY_NOTICES.md › open-edit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TranscriptWord } from '../types.js';
import { r3, runFfmpeg } from './tools.js';

export const SAMPLE_RATE = 16_000;

export interface Gap {
  start: number;
  end: number;
  duration: number;
}

export interface ProbeResult {
  /** Measured noise floor in dBFS: the 10th percentile of the envelope. */
  floor: number;
  /** Loudest window in dBFS. */
  peak: number;
  /** Threshold used to separate speech from floor, in dBFS. */
  threshold: number;
  /** First window at or above threshold, in seconds from the start of the file. */
  onset: number | null;
  /** End of the last window at or above threshold, also in file seconds. */
  decay: number | null;
  /** Sub-threshold stretches at least `gapMs` long, in file seconds: the safe cut targets. */
  gaps: Gap[];
  /** False when the signal has no dynamic range to separate speech from floor; then onset, decay and gaps mean nothing. */
  speechFound: boolean;
  /** Per-window dBFS, so a caller can re-threshold without decoding again. */
  envelope: number[];
  windowMs: number;
  rangeStart: number;
}

/** dBFS of each fixed-length window of 16-bit mono PCM. */
export function envelopeOf(pcm: Int16Array, windowSamples: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + windowSamples <= pcm.length; i += windowSamples) {
    let sum = 0;
    for (let j = i; j < i + windowSamples; j++) sum += pcm[j] * pcm[j];
    const rms = Math.sqrt(sum / windowSamples);
    out.push(rms > 0 ? 20 * Math.log10(rms / 32768) : -100);
  }
  return out;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return -100;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[index];
}

// Below this the clip is one flat level (digital silence, room tone with nobody talking, or a decode that
// returned nothing): a threshold derived from it equals the floor and every window would count as speech.
export const MIN_DYNAMIC_RANGE_DB = 6;

/**
 * Speech is separated from the floor by a margin above the MEASURED floor, so the same numbers work
 * on a street and in a booth. The margin is deliberately generous: a false gap costs a bad cut, a
 * missed gap only costs a cut opportunity.
 */
export function analyse(envelope: number[], windowMs: number, gapMs: number, rangeStart: number): ProbeResult {
  const floor = percentile(envelope, 0.1);
  // reduce, not Math.max(...envelope): one argument per window throws RangeError on long clips.
  const peak = envelope.reduce((hi, v) => (v > hi ? v : hi), -100);
  const threshold = Math.min(floor + 12, floor + (peak - floor) * 0.35);
  if (envelope.length === 0 || peak - floor < MIN_DYNAMIC_RANGE_DB) {
    return { floor, peak, threshold, onset: null, decay: null, gaps: [], speechFound: false, envelope, windowMs, rangeStart };
  }
  const perSecond = 1000 / windowMs;
  const at = (index: number) => rangeStart + index / perSecond;

  const first = envelope.findIndex((v) => v >= threshold);
  const last = envelope.findLastIndex((v) => v >= threshold);
  const onset = first < 0 ? null : at(first);
  const decay = last < 0 ? null : at(last + 1);

  // ceil, not round: a reported gap is AT LEAST gapMs long.
  const minWindows = Math.max(1, Math.ceil(gapMs / windowMs - 1e-9));
  const gaps: Gap[] = [];
  let runStart = -1;
  for (let i = 0; i <= envelope.length; i++) {
    const quiet = i < envelope.length && envelope[i] < threshold;
    if (quiet && runStart < 0) runStart = i;
    if (!quiet && runStart >= 0) {
      if (i - runStart >= minWindows) gaps.push({ start: at(runStart), end: at(i), duration: (i - runStart) / perSecond });
      runStart = -1;
    }
  }

  return { floor, peak, threshold, onset, decay, gaps, speechFound: true, envelope, windowMs, rangeStart };
}

// ── Reading the audio ──

/** 16-bit mono PCM of a WAV file, or null when the file is not that (then decode it with ffmpeg). */
export function readWavPcm16(file: string): { pcm: Int16Array; sampleRate: number } | null {
  const buf = fs.readFileSync(file);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let pos = 12;
  let format: { channels: number; sampleRate: number; bits: number; tag: number } | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      format = { tag: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!format || format.tag !== 1 || format.channels !== 1 || format.bits !== 16) return null;
      // ffmpeg writes 0xFFFFFFFF as the size of a WAV it streamed; the data runs to the end of the file.
      const end = Math.min(buf.length, size === 0xffffffff ? buf.length : body + size);
      const bytes = buf.subarray(body, end - ((end - body) % 2));
      const pcm = new Int16Array(bytes.length / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2);
      return { pcm, sampleRate: format.sampleRate };
    }
    pos = body + size + (size % 2);
  }
  return null;
}

/** Any audio or video file → 16 kHz mono 16-bit PCM. */
export async function decodePcm16(file: string, signal?: AbortSignal): Promise<Int16Array> {
  const wav = readWavPcm16(file);
  if (wav && wav.sampleRate === SAMPLE_RATE) return wav.pcm;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'video-edit-probe-'));
  try {
    const raw = path.join(work, 'audio.raw');
    await runFfmpeg(['-y', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', raw], { signal, timeoutMs: 10 * 60_000 });
    const bytes = fs.readFileSync(raw);
    const pcm = new Int16Array(Math.floor(bytes.length / 2));
    for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2);
    return pcm;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export interface ProbeOptions {
  /** Envelope window, default 10 ms. */
  windowMs?: number;
  /** Silence long enough to count as a safe cut gap, default 250 ms. */
  gapMs?: number;
  signal?: AbortSignal;
}

/** Envelope + measured floor + safe cut gaps of the whole file. */
export function probePcm(pcm: Int16Array, opts: Omit<ProbeOptions, 'signal'> = {}): ProbeResult {
  const windowSamples = Math.max(1, Math.round((SAMPLE_RATE * (opts.windowMs ?? 10)) / 1000));
  // The window the envelope was actually cut with: a whole number of samples.
  const windowMs = (windowSamples * 1000) / SAMPLE_RATE;
  return analyse(envelopeOf(pcm, windowSamples), windowMs, opts.gapMs ?? 250, 0);
}

export async function probeSpeech(file: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  return probePcm(await decodePcm16(file, opts.signal), opts);
}

// ── Sounds the transcript has no word for (AIOS-Lite) ──
// whisper often leaves out "ừm", "à": the stretch shows up as a pause between two words, yet it is voiced.
// Found here, it becomes a synthetic filler word the cut list can remove like any other filler.

/** Clearly voiced: this far above the measured floor (and never below the probe threshold). */
export const VOICED_MARGIN_DB = 15;
/** Shorter voiced stretches are clicks and breaths, not a hesitation sound. */
export const UNWORDED_MIN_SEC = 0.15;
/** Longer ones may be real speech whisper missed: never guess those are fillers. */
export const UNWORDED_MAX_SEC = 1.2;
/** A word's edges are not exact; voicing this close to a word belongs to it. */
const WORD_PAD_SEC = 0.08;
/** Dips this short inside a voiced stretch do not split it. */
const BRIDGE_MS = 30;

/** Stretches clearly above the floor (≥ max(threshold, floor + VOICED_MARGIN_DB)), short dips bridged. */
export function voicedRuns(probe: ProbeResult, marginDb = VOICED_MARGIN_DB): { start: number; end: number }[] {
  if (!probe.speechFound) return [];
  const level = Math.max(probe.threshold, probe.floor + marginDb);
  const bridge = Math.max(0, Math.round(BRIDGE_MS / probe.windowMs));
  const env = probe.envelope;
  const runs: { from: number; to: number }[] = [];
  for (let i = 0; i < env.length; i++) {
    if (env[i] < level) continue;
    const last = runs[runs.length - 1];
    if (last && i - last.to <= bridge + 1) last.to = i + 1;
    else runs.push({ from: i, to: i + 1 });
  }
  const at = (index: number) => r3(probe.rangeStart + (index * probe.windowMs) / 1000);
  return runs.map((r) => ({ start: at(r.from), end: at(r.to) }));
}

/** Voiced stretches no word covers, 0.15–1.2 s, as source seconds: the filler candidates. */
export function unwordedSounds(
  words: Pick<TranscriptWord, 'start' | 'end'>[],
  runs: { start: number; end: number }[],
): { start: number; end: number }[] {
  const taken = words.map((w) => ({ start: w.start - WORD_PAD_SEC, end: w.end + WORD_PAD_SEC })).sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const run of runs) {
    let pieces = [{ ...run }];
    for (const t of taken) {
      if (t.end <= run.start || t.start >= run.end) continue;
      pieces = pieces.flatMap((p) => {
        if (t.end <= p.start || t.start >= p.end) return [p];
        return [{ start: p.start, end: t.start }, { start: t.end, end: p.end }].filter((x) => x.end > x.start);
      });
    }
    for (const p of pieces) {
      const d = p.end - p.start;
      // A piece that was clipped by a word is only kept when what is left is a stretch of its own.
      if (d >= UNWORDED_MIN_SEC - 1e-9 && d <= UNWORDED_MAX_SEC + 1e-9) out.push({ start: r3(p.start), end: r3(p.end) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Text of a synthetic filler word; `isFillerWord` matches it, so the cut list treats it as one. */
export const SYNTHETIC_FILLER_TEXT = 'ừm';

/** Merge synthetic filler words into the transcript by time and re-number every word (`i` = position). */
export function insertSyntheticWords(words: TranscriptWord[], sounds: { start: number; end: number }[]): TranscriptWord[] {
  if (!sounds.length) return words;
  const extra: TranscriptWord[] = sounds.map((s) => ({ i: -1, text: SYNTHETIC_FILLER_TEXT, start: s.start, end: s.end, synthetic: true }));
  // Stable: a real word and a synthetic one starting at the same moment keep the real word first.
  const merged = [...words.map((w, k) => ({ w, k, real: 0 })), ...extra.map((w, k) => ({ w, k, real: 1 }))]
    .sort((a, b) => a.w.start - b.w.start || a.real - b.real || a.k - b.k)
    .map((x) => x.w);
  return merged.map((w, i) => ({ ...w, i }));
}
