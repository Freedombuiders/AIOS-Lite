import { describe, expect, it } from 'vitest';
import type { AnalysisResult, EditPlan, Transcript } from '../types.js';
import { findFillers, findRetakes, isFillerWord, parseScenes, parseSilences, pickFrameTimes } from './analyze.js';
import { applyPatch, autoPlan, computeKeep, derivePlan, diffPlans, makeMapper, validateAgentPlan } from './plan.js';
import { parseWhisperJson, snapWordsToSilence } from './transcribe.js';

/** words as [text, start, end] */
function transcript(items: [string, number, number][], durationSec = 20): Transcript {
  return {
    language: 'vi', model: 't', durationSec, createdAt: '2026-01-01T00:00:00.000Z',
    words: items.map(([text, start, end], i) => ({ i, text, start, end })),
  };
}

const T = transcript([
  ['Xin', 0.2, 0.5], ['chào', 0.5, 0.8], ['ờ', 0.9, 1.2], ['các', 1.3, 1.5], ['bạn', 1.5, 1.8],
  ['hôm', 3.0, 3.2], ['nay', 3.2, 3.5], ['mình', 3.5, 3.8], ['nói', 3.8, 4.1],
], 6);

describe('analyze helpers', () => {
  it('finds standalone fillers only', () => {
    for (const w of ['ờ', 'Ừm', 'à,', 'hmm', 'ơ', 'ờm', 'ừ']) expect(isFillerWord(w), w).toBe(true);
    for (const w of ['à ơi', 'nhà', 'là', 'hôm']) expect(isFillerWord(w), w).toBe(false);
    expect(findFillers(T.words)).toEqual([{ wordIndex: 2, text: 'ờ' }]);
  });

  it('flags a short restarted phrase but not a repeated phrase far apart', () => {
    const restart = transcript([
      ['tôi', 0, 0.2], ['muốn', 0.2, 0.4], ['nói', 0.4, 0.6], ['là', 0.6, 0.8],
      ['tôi', 1.2, 1.4], ['muốn', 1.4, 1.6], ['nói', 1.6, 1.8], ['về', 1.8, 2.0], ['AI', 2.0, 2.3],
    ]);
    expect(findRetakes(restart.words)).toEqual([{ fromWord: 0, toWord: 3, text: 'tôi muốn nói là' }]);

    const filler = (n: number): [string, number, number][] => Array.from({ length: n }, (_, k) => [`w${k}`, 0.2 + k * 0.2, 0.4 + k * 0.2]);
    const far = transcript([['các', 0, 0.2], ['bạn', 0.2, 0.4], ['nhé', 0.4, 0.6], ...filler(14).map(([t, s, e]) => [t, s + 0.6, e + 0.6] as [string, number, number]),
      ['các', 4, 4.2], ['bạn', 4.2, 4.4], ['nhé', 4.4, 4.6]]);
    expect(findRetakes(far.words)).toEqual([]);
  });

  it('parses ffmpeg silence, scene and frame spreads', () => {
    expect(parseSilences('silence_start: 1.5\nsilence_end: 2.4 | silence_duration: 0.9\nsilence_start: 5\n')).toEqual([{ start: 1.5, end: 2.4 }]);
    expect(parseScenes('lavfi.scd.score: 20, lavfi.scd.time: 3.2\nlavfi.scd.time: 9.5')).toEqual([3.2, 9.5]);
    const times = pickFrameTimes(30, [10, 20]);
    expect(times.length).toBeGreaterThanOrEqual(6);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe('whisper parsing', () => {
  it('drops empty and special tokens, glues punctuation and sub-word pieces', () => {
    const json = { transcription: [
      { text: '', offsets: { from: 0, to: 0 } },
      { text: ' [_BEG_]', offsets: { from: 0, to: 0 } },
      { text: ' Xin', offsets: { from: 100, to: 400 } },
      { text: ',', offsets: { from: 400, to: 420 } },
      { text: ' chà', offsets: { from: 500, to: 700 } },
      { text: 'o', offsets: { from: 700, to: 800 } },
      { text: ' (music)', offsets: { from: 800, to: 900 } },
      { text: ' 100W', offsets: { from: 1000, to: 1400 } },
    ] };
    expect(parseWhisperJson(json)).toEqual([
      { i: 0, text: 'Xin,', start: 0.1, end: 0.42 },
      { i: 1, text: 'chào', start: 0.5, end: 0.8 },
      { i: 2, text: '100W', start: 1, end: 1.4 },
    ]);
  });

  it('snaps stretched word edges to real silences', () => {
    const words = [{ i: 0, text: 'a', start: 0, end: 2 }, { i: 1, text: 'b', start: 2, end: 3 }];
    const out = snapWordsToSilence(words, [{ start: 0.6, end: 1.9 }]);
    expect(out[0]).toMatchObject({ start: 0, end: 0.6 });
    expect(out[1]).toMatchObject({ start: 2, end: 3 });
  });
});

describe('computeKeep', () => {
  it('cuts removed words and pauses longer than gapMs, with padding that never touches neighbours', () => {
    const r = computeKeep(T, [2], 250);
    expect(r.keep).toHaveLength(3);
    expect(r.keep[0].start).toBeGreaterThanOrEqual(0.15);
    expect(r.keep[0].end).toBeLessThanOrEqual(0.9);
    // the filler (0.9–1.2) is gone
    expect(r.keep.every((k) => k.end <= 0.9 || k.start >= 1.05)).toBe(true);
    expect(r.removed.some((x) => x.kind === 'filler' && x.text === 'ờ')).toBe(true);
    expect(r.removed.some((x) => x.kind === 'silence')).toBe(true);
    expect(r.outputDurationSec).toBeCloseTo(r.keep.reduce((a, k) => a + k.end - k.start, 0), 2);
  });

  it('keeps a long pause when gapMs allows it', () => {
    const r = computeKeep(T, [2], 4000);
    expect(r.keep).toHaveLength(2); // only the filler splits it
  });

  it('plays the moved hook range first and does not repeat it', () => {
    const r = computeKeep(T, [], 4000, { id: 'h', kind: 'number', text: 'X', mode: 'moved', moveFromWord: 7, moveToWord: 8 });
    expect(r.keep[0].start).toBeCloseTo(3.5, 1);
    const total = r.keep.reduce((a, k) => a + k.end - k.start, 0);
    const plain = computeKeep(T, [], 4000).keep.reduce((a, k) => a + k.end - k.start, 0);
    expect(total).toBeCloseTo(plain, 1);
    const map = makeMapper(r.segments);
    expect(map(3.6)).toBeCloseTo(0.1, 1);
  });
});

const ANALYSIS: AnalysisResult = {
  silences: [], fillers: [{ wordIndex: 2, text: 'ờ' }], retakes: [], scenes: [],
  frames: [{ at: 1, file: 'frames/a.jpg' }, { at: 3.5, file: 'frames/b.jpg' }, { at: 4, file: 'frames/c.jpg' }], createdAt: 'x',
};

function basePlan(): EditPlan {
  return autoPlan({
    transcript: T, analysis: ANALYSIS, project: { title: 'Việc mới', aspect: '9:16', styleId: 'kienthuc' },
    profile: { keepWords: ['FreedomOS'] }, style: null,
  });
}

describe('autoPlan / applyPatch / diff', () => {
  it('builds v1 from fillers, pace and keep words', () => {
    const p = basePlan();
    expect(p).toMatchObject({ version: 1, author: 'auto', cutWords: [2], gapMs: 250, aspect: '9:16', styleId: 'kienthuc' });
    expect(p.captions.highlight).toContain('freedomos');
    expect(p.covers).toHaveLength(3);
    expect(p.meta.title).toContain('Xin chào');
    expect(p.outputDurationSec).toBeLessThan(p.sourceDurationSec);
    expect(p.changes?.length).toBeGreaterThan(0);
  });

  it('toggles words into a new owner version with Vietnamese changes', () => {
    const v1 = basePlan();
    const ctx = { transcript: T, analysis: ANALYSIS };
    const v2 = applyPatch(v1, { toggleWords: [2, 6] }, ctx);
    expect(v2).toMatchObject({ version: 2, author: 'owner', cutWords: [6] });
    expect(v2.changes?.join(' ')).toMatch(/Giữ lại 1 từ: «ờ»/);
    expect(v2.changes?.join(' ')).toMatch(/Bỏ 1 từ: «nay»/);
    const v3 = applyPatch(v2, { gapMs: 400, meta: { title: 'Mới' }, captions: { position: 'middle' } }, ctx);
    expect(v3.gapMs).toBe(400);
    expect(v3.meta.title).toBe('Mới');
    expect(v3.changes).toEqual(expect.arrayContaining([expect.stringContaining('250ms → 400ms'), expect.stringContaining('Đổi tiêu đề')]));
    const d = diffPlans(v1, v3, T);
    expect(d.join('\n')).toContain('Giữ lại 1 từ');
  });

  it('re-times overlays that anchor to a word when the cuts change', () => {
    const v1 = derivePlan({ ...basePlan(), overlays: [{ id: 'o', effect: 'keyword-pop', anchorWord: 7, at: 0, duration: 1, props: { text: 'x' } }] }, { transcript: T, analysis: ANALYSIS });
    const v2 = applyPatch(v1, { cutWords: [0, 1, 2] }, { transcript: T, analysis: ANALYSIS });
    expect(v2.overlays[0].at).toBeLessThan(v1.overlays[0].at);
  });
});

describe('validateAgentPlan', () => {
  const ctx = { transcript: T, analysis: ANALYSIS };
  const base = { previous: null, version: 2, aspect: '9:16' as const, styleId: 'kienthuc' };

  it('accepts a minimal agent plan and recomputes derived fields', () => {
    const v1 = basePlan();
    const res = validateAgentPlan({
      summary: 'Gọn', cutWords: [2], gapMs: 150, keep: [{ start: 0, end: 99 }], outputDurationSec: 999,
      hook: { options: [{ id: 'a', kind: 'question', text: 'Hay?', mode: 'overlay' }], chosen: 'a' },
      captions: { styleId: 'bottom-clean', position: 'bottom', highlight: [], maxWordsPerChunk: 2 },
      meta: { title: 'T', caption: '', hashtags: [] },
    }, ctx, { ...base, previous: v1, note: 'Thêm hook' });
    expect(res.errors).toEqual([]);
    expect(res.plan).toMatchObject({ version: 2, author: 'agent', gapMs: 150 });
    expect(res.plan!.outputDurationSec).toBeLessThan(6);
    expect(res.plan!.keep.every((k) => k.end < 99)).toBe(true);
    expect(res.plan!.changes![0]).toBe('Thêm hook');
    expect(res.plan!.changes!.join(' ')).toContain('Hook');
  });

  it('rejects bad indexes, hooks and shapes', () => {
    expect(validateAgentPlan({ cutWords: [999] }, ctx, base).errors[0]).toMatch(/cutWords/);
    expect(validateAgentPlan({ hook: { options: [{ id: 'a', kind: 'other', text: 'x', mode: 'overlay' }], chosen: 'zzz' } }, ctx, base).errors[0]).toMatch(/hook\.chosen/);
    expect(validateAgentPlan({ brolls: [{ anchorWord: 50, duration: 2, title: 'x' }] }, ctx, base).errors[0]).toMatch(/anchorWord/);
    expect(validateAgentPlan({ gapMs: -5 }, ctx, base).errors.length).toBeGreaterThan(0);
    expect(validateAgentPlan('nope', ctx, base).errors.length).toBeGreaterThan(0);
  });
});
