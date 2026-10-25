import { describe, expect, it } from 'vitest';
import { accentBeats, analyzeBeats, BEAT_SR, percentile } from './beats.js';

/** Clicks every 60/bpm s from `offset`, every other click louder; a little deterministic noise underneath. */
function clickTrack(bpm: number, seconds: number, offset = 0.1, sr = BEAT_SR): { samples: Float32Array; clicks: number[]; strong: number[] } {
  const samples = new Float32Array(Math.round(seconds * sr));
  let seed = 12345;
  for (let i = 0; i < samples.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    samples[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.005;
  }
  const clicks: number[] = [];
  const strong: number[] = [];
  const period = 60 / bpm;
  for (let k = 0, t = offset; t < seconds - 0.05; k++, t = offset + k * period) {
    clicks.push(t);
    const amp = k % 2 === 0 ? 0.9 : 0.35;
    if (k % 2 === 0) strong.push(t);
    const start = Math.round(t * sr);
    for (let i = 0; i < Math.round(0.03 * sr) && start + i < samples.length; i++) {
      samples[start + i] += amp * Math.sin((2 * Math.PI * 1000 * i) / sr) * Math.exp(-i / (0.006 * sr));
    }
  }
  return { samples, clicks, strong };
}

const near = (t: number, list: number[], tol: number) => list.some((c) => Math.abs(c - t) <= tol);

describe('analyzeBeats', () => {
  it('measures 120 BPM and lands beats on the clicks', () => {
    const { samples, clicks, strong } = clickTrack(120, 30);
    const r = analyzeBeats(samples);
    expect(r.bpm).toBeGreaterThan(118);
    expect(r.bpm).toBeLessThan(122);
    expect(r.durationSec).toBeCloseTo(30, 1);
    expect(r.beats.length).toBeGreaterThan(50);
    expect(r.beats.filter((b) => near(b, clicks, 0.06)).length / r.beats.length).toBeGreaterThan(0.95);
    const gaps = r.beats.slice(1).map((b, i) => b - r.beats[i]);
    expect(percentile(gaps, 50)).toBeCloseTo(0.5, 1);
    // Strong beats: the louder clicks, never two adjacent beats.
    expect(r.accents.length).toBeGreaterThan(10);
    expect(r.accents.filter((a) => near(a, strong, 0.06)).length / r.accents.length).toBeGreaterThan(0.8);
    expect(r.energyMeanDb).toBeLessThan(0);
  });

  it('follows a different tempo (90 BPM)', () => {
    const r = analyzeBeats(clickTrack(90, 30, 0.2).samples);
    expect(r.bpm).toBeGreaterThan(88);
    expect(r.bpm).toBeLessThan(92);
  });

  it('returns no beats for silence or a too-short buffer', () => {
    expect(analyzeBeats(new Float32Array(BEAT_SR * 3))).toMatchObject({ beats: [], accents: [] });
    expect(analyzeBeats(new Float32Array(100))).toMatchObject({ bpm: 0, beats: [] });
  });
});

describe('accentBeats', () => {
  it('keeps local peaks at least one beat apart', () => {
    const env = Float64Array.from([0, 5, 0, 1, 0, 6, 0, 1, 0, 5, 0, 1, 0, 6, 0, 1, 0]);
    const frames = [1, 3, 5, 7, 9, 11, 13, 15];
    expect(accentBeats(env, frames)).toEqual([1, 5, 9, 13]);
  });
});
