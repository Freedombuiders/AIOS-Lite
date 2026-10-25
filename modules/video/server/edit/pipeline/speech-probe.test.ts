// speech-probe on synthesised signals (no recording needed), the synthetic filler words it adds to the
// transcript, and the whisper-mapper rules of parseWhisperJson.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptWord } from '../types.js';
import { findFillers, findRetakes } from './analyze.js';
import {
  analyse, envelopeOf, insertSyntheticWords, MIN_DYNAMIC_RANGE_DB, percentile, probePcm, readWavPcm16, SAMPLE_RATE,
  unwordedSounds, voicedRuns,
} from './speech-probe.js';
import { parseWhisperJson, transcribeAudio } from './transcribe.js';

/** dBFS → the constant 16-bit amplitude that measures as that level. */
const amplitudeFor = (db: number) => Math.round(32768 * 10 ** (db / 20));
const WINDOW = 160; // 10 ms at 16 kHz

/** PCM whose level follows `plan`, one entry per 10 ms window. */
function pcmFrom(plan: number[]): Int16Array {
  const out = new Int16Array(plan.length * WINDOW);
  plan.forEach((db, w) => {
    const amp = amplitudeFor(db);
    for (let i = 0; i < WINDOW; i++) out[w * WINDOW + i] = i % 2 === 0 ? amp : -amp;
  });
  return out;
}
/** `ms` of one level as 10 ms windows. */
const span = (db: number, ms: number) => Array<number>(Math.round(ms / 10)).fill(db);

const FLOOR = -60;
const VOICE = -20;
// 0.5 s room, "xin" 0.5–1.0, 0.2 s pause, an "ừm" whisper left out 1.2–1.45, pause, "chào" 1.7–2.3, a click 2.6–2.68, room.
const SIGNAL = [
  ...span(FLOOR, 500), ...span(VOICE, 500), ...span(FLOOR, 200), ...span(VOICE + 4, 250), ...span(FLOOR, 250),
  ...span(VOICE, 600), ...span(FLOOR, 300), ...span(VOICE, 80), ...span(FLOOR, 520),
];
const WORDS: TranscriptWord[] = [{ i: 0, text: 'Xin', start: 0.5, end: 1 }, { i: 1, text: 'chào', start: 1.7, end: 2.3 }];

describe('speech-probe (open-edit)', () => {
  it('measures each window in dBFS, ignores a partial window and reads digital silence as the floor sentinel', () => {
    const env = envelopeOf(pcmFrom([-6, -20, -40]), WINDOW);
    env.forEach((db, k) => expect(Math.abs(db - [-6, -20, -40][k])).toBeLessThan(0.1));
    expect(envelopeOf(new Int16Array(400).fill(amplitudeFor(-6)), WINDOW)).toHaveLength(2);
    expect(envelopeOf(new Int16Array(320), WINDOW)).toEqual([-100, -100]);
    expect(percentile([-10, -50, -30, -20, -40], 0.5)).toBe(-30);
    expect(percentile([], 0.1)).toBe(-100);
  });

  it('finds onset, decay and the safe cut gaps against the floor of this clip', () => {
    const r = probePcm(pcmFrom(SIGNAL));
    expect(r.speechFound).toBe(true);
    expect(r.floor).toBeCloseTo(FLOOR, 0);
    expect(r.onset).toBeCloseTo(0.5, 5);
    expect(r.decay).toBeCloseTo(2.68, 5);
    // gaps of 250 ms or more: the opening room, the pause after "ừm", the pause after "chào" and the tail; not the 200 ms pause
    expect(r.gaps.map((g) => [Number(g.start.toFixed(2)), Number(g.end.toFixed(2))])).toEqual([[0, 0.5], [1.45, 1.7], [2.3, 2.6], [2.68, 3.2]]);
  });

  it('the same speech in a noisy room still separates: the threshold follows the measured floor', () => {
    const noisy = SIGNAL.map((db) => (db === FLOOR ? -38 : db));
    const r = probePcm(pcmFrom(noisy));
    expect(r.speechFound).toBe(true);
    expect(r.gaps.length).toBe(4);
  });

  it('a flat clip has no speech to separate', () => {
    const r = analyse(span(-30, 1000), 10, 250, 0);
    expect(r.peak - r.floor).toBeLessThan(MIN_DYNAMIC_RANGE_DB);
    expect(r).toMatchObject({ speechFound: false, onset: null, gaps: [] });
    expect(voicedRuns(r)).toEqual([]);
  });

  it('reads the 16 kHz mono WAV the ingest step writes', () => {
    const pcm = pcmFrom([-20, -40]);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length * 2, 4); header.write('WAVE', 8);
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(pcm.length * 2, 40);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-wav-'));
    try {
      const file = path.join(dir, 'audio.wav');
      fs.writeFileSync(file, Buffer.concat([header, Buffer.from(pcm.buffer)]));
      const wav = readWavPcm16(file)!;
      expect(wav.sampleRate).toBe(SAMPLE_RATE);
      expect([...wav.pcm]).toEqual([...pcm]);
      fs.writeFileSync(path.join(dir, 'not.wav'), 'hello');
      expect(readWavPcm16(path.join(dir, 'not.wav'))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sounds the transcript has no word for', () => {
  it('finds the voiced stretch between two words, ≥150 ms and clearly above the floor; not clicks, not word voicing', () => {
    const probe = probePcm(pcmFrom(SIGNAL));
    const runs = voicedRuns(probe);
    expect(runs).toHaveLength(4);
    expect(unwordedSounds(WORDS, runs)).toEqual([{ start: 1.2, end: 1.45 }]);
  });

  it('leaves out stretches that are too long to be a filler, and quiet ones', () => {
    const long = [...span(FLOOR, 500), ...span(VOICE, 2000), ...span(FLOOR, 500)];
    expect(unwordedSounds([], voicedRuns(probePcm(pcmFrom(long))))).toEqual([]);
    // 13 dB over the floor is above the gap threshold (floor + 12) but not "clearly voiced" (floor + 15)
    const quiet = [...span(FLOOR, 500), ...span(VOICE, 500), ...span(FLOOR, 200), ...span(FLOOR + 13, 300), ...span(FLOOR, 500)];
    const probe = probePcm(pcmFrom(quiet));
    expect(probe.envelope.some((db) => db > probe.threshold && db < FLOOR + 14)).toBe(true);
    expect(unwordedSounds([{ i: 0, text: 'a', start: 0.5, end: 1 }], voicedRuns(probe))).toEqual([]);
  });

  it('inserts synthetic "ừm" words by time and renumbers every word without losing one', () => {
    const words: TranscriptWord[] = [
      { i: 0, text: 'Xin', start: 0.5, end: 1 }, { i: 1, text: 'chào', start: 1.7, end: 2.3 }, { i: 2, text: 'bạn', start: 3, end: 3.3 },
    ];
    const out = insertSyntheticWords(words, [{ start: 1.2, end: 1.45 }, { start: 2.5, end: 2.8 }]);
    expect(out.map((w) => [w.i, w.text, Boolean(w.synthetic)])).toEqual([
      [0, 'Xin', false], [1, 'ừm', true], [2, 'chào', false], [3, 'ừm', true], [4, 'bạn', false],
    ]);
    expect(out.filter((w) => !w.synthetic).map((w) => w.text)).toEqual(['Xin', 'chào', 'bạn']);
    expect(insertSyntheticWords(words, [])).toBe(words);
    // they are fillers for the cut list, and never part of a repeated phrase
    expect(findFillers(out).map((f) => f.wordIndex)).toEqual([1, 3]);
    expect(findRetakes(out)).toEqual([]);
  });
});

describe('transcribe with the speech probe', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-transcribe-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('adds the filler whisper left out before words are numbered, so word indexes stay consistent', async () => {
    const json = { transcription: [
      { text: ' Xin', offsets: { from: 500, to: 1000 } },
      { text: ' chào', offsets: { from: 1700, to: 2300 } },
    ] };
    const t = await transcribeAudio({
      audio: path.join(dir, 'missing.wav'), durationSec: 3.2,
      runWhisper: async () => json,
      probe: async () => probePcm(pcmFrom(SIGNAL)),
    });
    expect(t.words.map((w) => [w.i, w.text, w.synthetic ?? false])).toEqual([[0, 'Xin', false], [1, 'ừm', true], [2, 'chào', false]]);
    expect(t.words[1]).toMatchObject({ start: 1.2, end: 1.45 });
    expect(t.words.every((w, k) => w.i === k)).toBe(true);
  });

  it('without a usable probe the transcript is whisper\'s words only', async () => {
    const t = await transcribeAudio({
      audio: path.join(dir, 'missing.wav'), durationSec: 3,
      runWhisper: async () => ({ transcription: [{ text: ' Xin', offsets: { from: 0, to: 300 } }] }),
      probe: async () => { throw new Error('không đọc được âm thanh'); },
    });
    expect(t.words).toEqual([{ i: 0, text: 'Xin', start: 0, end: 0.3 }]);
  });
});

describe('whisper parsing (whisper-mapper rules)', () => {
  it('splits a token holding several words in proportion to their length', () => {
    const words = parseWhisperJson({ transcription: [{ text: ' xin chào bạn', offsets: { from: 0, to: 1000 } }] });
    expect(words.map((w) => [w.text, w.start, w.end])).toEqual([['xin', 0, 0.3], ['chào', 0.3, 0.7], ['bạn', 0.7, 1]]);
  });

  it('gives untimed tokens a window between their timed neighbours', () => {
    const words = parseWhisperJson({ transcription: [
      { text: ' một', offsets: { from: 0, to: 400 } },
      { text: ' hai' },
      { text: ' ba' },
      { text: ' bốn', offsets: { from: 1000, to: 1400 } },
    ] });
    expect(words.map((w) => [w.text, w.start, w.end])).toEqual([['một', 0, 0.4], ['hai', 0.4, 0.7], ['ba', 0.7, 1], ['bốn', 1, 1.4]]);
  });

  it('puts words whose starts run backwards back in time order and renumbers them', () => {
    const words = parseWhisperJson({ transcription: [
      { text: ' b', offsets: { from: 600, to: 900 } },
      { text: ' a', offsets: { from: 100, to: 400 } },
    ] });
    expect(words).toEqual([{ i: 0, text: 'a', start: 0.1, end: 0.4 }, { i: 1, text: 'b', start: 0.6, end: 0.9 }]);
  });
});
