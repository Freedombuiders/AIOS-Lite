// Tempo and strong beats of a music track, measured from mono PCM (decoded by ffmpeg, see hub.ts).
//
// Rewritten in TypeScript after FireRed-OpenStoryline `src/open_storyline/nodes/core_nodes/select_bgm.py`
// (`analyze_music_metrics`, `_compute_accent_beats`), Copyright 2026 FireRed-OpenStoryline Authors,
// Apache License 2.0 (see THIRD_PARTY_NOTICES.md). Changes from the original: librosa's onset strength is a
// log-band spectral flux computed here; tempo is the autocorrelation peak under librosa's log-normal prior
// around 120 BPM; beats come from the same dynamic-programming tracker librosa uses (Ellis 2007); the accent
// step reads the full-signal envelope summed over the beat frame and its neighbours (no percussive split
// first); times are seconds, not milliseconds.

export const BEAT_SR = 22050;
const N_FFT = 1024;
const HOP = 512;
const BANDS = 32;
const F_MIN = 60;
const TOP_DB = 80;
const TIGHTNESS = 100;
const START_BPM = 120;
const RMS_FRAME = 2048;

export interface BeatAnalysis {
  bpm: number;
  /** Every tracked beat, seconds. */
  beats: number[];
  /** Strong beats (accents), seconds. */
  accents: number[];
  durationSec: number;
  energyMeanDb: number;
  dynamicRangeDb: number;
}

// ── Small numeric helpers (numpy semantics where the original relied on them) ──

/** np.percentile with linear interpolation. */
export function percentile(values: ArrayLike<number>, p: number): number {
  const s = Array.from(values).sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const pos = (p / 100) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(s.length - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** np.convolve(a, k, 'same') for a.length >= k.length; output keeps a's length. */
function convolveSame(a: ArrayLike<number>, k: ArrayLike<number>): Float64Array {
  const n = a.length;
  const m = k.length;
  const start = Math.floor((m - 1) / 2);
  const out = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let acc = 0;
    const i = t + start;
    for (let j = 0; j < m; j++) {
      const ai = i - j;
      if (ai >= 0 && ai < n) acc += k[j] * a[ai];
    }
    out[t] = acc;
  }
  return out;
}

function mean(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return a.length ? s / a.length : 0;
}

function std(a: ArrayLike<number>): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2;
  return Math.sqrt(s / (a.length - 1));
}

// ── Spectrum ──

function fftTables(n: number) {
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) { cos[k] = Math.cos((2 * Math.PI * k) / n); sin[k] = Math.sin((2 * Math.PI * k) / n); }
  return { rev, cos, sin };
}

/** In-place iterative radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array, t: ReturnType<typeof fftTables>): void {
  const n = re.length;
  for (let i = 0; i < n; i++) {
    const j = t.rev[i];
    if (j > i) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const wr = t.cos[k * step];
        const wi = -t.sin[k * step];
        const a = i + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

/** Onset strength per frame: mean positive change of log band energies (frames centred on t·HOP). */
export function onsetEnvelope(samples: Float32Array, sr: number): Float64Array {
  const frames = 1 + Math.floor(samples.length / HOP);
  const tables = fftTables(N_FFT);
  const hann = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);

  const bins = N_FFT / 2 + 1;
  const edges: number[] = [];
  for (let b = 0; b <= BANDS; b++) edges.push(F_MIN * (sr / 2 / F_MIN) ** (b / BANDS));
  const bandOf = new Int16Array(bins).fill(-1);
  for (let k = 1; k < bins; k++) {
    const f = (k * sr) / N_FFT;
    for (let b = 0; b < BANDS; b++) if (f >= edges[b] && f < edges[b + 1]) { bandOf[k] = b; break; }
  }

  const db = new Float64Array(frames * BANDS);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  let top = -Infinity;
  for (let t = 0; t < frames; t++) {
    const start = t * HOP - N_FFT / 2;
    for (let i = 0; i < N_FFT; i++) {
      const s = start + i;
      re[i] = s >= 0 && s < samples.length ? samples[s] * hann[i] : 0;
      im[i] = 0;
    }
    fft(re, im, tables);
    const energy = new Float64Array(BANDS);
    for (let k = 1; k < bins; k++) if (bandOf[k] >= 0) energy[bandOf[k]] += re[k] * re[k] + im[k] * im[k];
    for (let b = 0; b < BANDS; b++) {
      const v = 10 * Math.log10(Math.max(1e-10, energy[b]));
      db[t * BANDS + b] = v;
      if (v > top) top = v;
    }
  }
  const floor = top - TOP_DB;
  const env = new Float64Array(frames);
  for (let t = 1; t < frames; t++) {
    let s = 0;
    for (let b = 0; b < BANDS; b++) {
      const d = Math.max(floor, db[t * BANDS + b]) - Math.max(floor, db[(t - 1) * BANDS + b]);
      if (d > 0) s += d;
    }
    env[t] = s / BANDS;
  }
  return env;
}

// ── Tempo and beats ──

/** Autocorrelation peak of the envelope, weighted by a log-normal prior (1 octave) around 120 BPM. */
export function estimateTempo(env: Float64Array, fps: number): number {
  // Smooth first: a beat period that is not a whole number of frames splits its peak across two lags,
  // which would hand the win to the half tempo (whose lag happens to be whole).
  const kernel: number[] = [];
  for (let i = -4; i <= 4; i++) kernel.push(Math.exp(-0.5 * (i / 1.5) ** 2));
  const smooth = env.length >= kernel.length ? convolveSame(env, kernel) : env;
  const m = mean(smooth);
  const x = Float64Array.from(smooth, (v) => v - m);
  const minLag = Math.max(1, Math.floor((60 * fps) / 300));
  const maxLag = Math.min(x.length - 2, Math.ceil((60 * fps) / 30));
  if (maxLag <= minLag + 1) return START_BPM;
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    if (lag < 0) continue;
    let s = 0;
    for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag];
    ac[lag] = s;
  }
  let best = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * Math.log2(bpm / START_BPM) ** 2);
    const score = Math.max(0, ac[lag]) * prior;
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  if (best < 0 || bestScore <= 0) return START_BPM;
  const [a, b, c] = [ac[best - 1], ac[best], ac[best + 1]];
  const denom = a - 2 * b + c;
  const shift = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
  return (60 * fps) / (best + shift);
}

/** librosa.beat.beat_track's dynamic programme: beat frames that follow onsets at the given tempo. */
export function trackBeats(env: Float64Array, fps: number, bpm: number): number[] {
  const n = env.length;
  const sd = std(env);
  if (n < 3 || sd === 0 || !(bpm > 0)) return [];
  const period = Math.max(1, Math.round((60 * fps) / bpm));

  const gauss: number[] = [];
  for (let i = -period; i <= period; i++) gauss.push(Math.exp(-0.5 * ((i * 32) / period) ** 2));
  const local = convolveSame(Float64Array.from(env, (v) => v / sd), gauss);

  const offsets: number[] = [];
  for (let o = -2 * period; o <= -Math.round(period / 2); o++) offsets.push(o);
  const txwt = offsets.map((o) => -TIGHTNESS * Math.log(-o / period) ** 2);
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const localMax = local.reduce((a, b) => Math.max(a, b), -Infinity);
  let first = true;
  for (let i = 0; i < n; i++) {
    let bestScore = -Infinity;
    let bestPrev = -1;
    for (let k = 0; k < offsets.length; k++) {
      const j = i + offsets[k];
      const score = txwt[k] + (j >= 0 ? cum[j] : 0);
      if (score > bestScore) { bestScore = score; bestPrev = j; }
    }
    cum[i] = local[i] + bestScore;
    if (first && local[i] < 0.01 * localMax) back[i] = -1;
    else { back[i] = bestPrev; first = false; }
  }

  // Last beat: the latest local maximum of the cumulative score above half its median.
  const peaks: number[] = [];
  for (let i = 0; i < n; i++) {
    const left = i === 0 ? -Infinity : cum[i - 1];
    const right = i === n - 1 ? -Infinity : cum[i + 1];
    if (cum[i] > left && cum[i] >= right) peaks.push(i);
  }
  if (peaks.length === 0) return [];
  const med = percentile(peaks.map((i) => cum[i]), 50);
  let tail = -1;
  for (const i of peaks) if (cum[i] * 2 > med) tail = i;
  if (tail < 0) return [];

  const beats = [tail];
  while (back[beats[beats.length - 1]] >= 0) beats.push(back[beats[beats.length - 1]]);
  beats.reverse();

  // Trim weak leading/trailing beats (librosa __trim_beats).
  const hann5 = [0, 0.3454915, 0.9045085, 0.9045085, 0.3454915];
  const smooth = beats.length >= hann5.length ? convolveSame(beats.map((b) => local[b]), hann5) : Float64Array.from(beats, (b) => local[b]);
  const threshold = 0.5 * Math.sqrt(mean(Array.from(smooth, (v) => v * v)));
  let lo = 0;
  let hi = beats.length;
  while (lo < hi && smooth[lo] <= threshold) lo++;
  while (hi > lo && smooth[hi - 1] <= threshold) hi--;
  return beats.slice(lo, hi);
}

/** `_compute_accent_beats`: the beats whose onset strength stands out locally (top 70 %, local peaks, 1 beat apart). */
export function accentBeats(env: Float64Array, beatFrames: number[], opts: { topPct?: number; minSepBeats?: number; localNormWin?: number } = {}): number[] {
  const topPct = opts.topPct ?? 70;
  const minSep = opts.minSepBeats ?? 1;
  const w = opts.localNormWin ?? 8;
  if (beatFrames.length === 0) return [];
  // Strength over the beat frame and its neighbours: an onset near a frame edge splits across two frames.
  const at = (f: number) => (f >= 0 && f < env.length ? env[f] : 0);
  const strength = beatFrames.map((f) => at(f - 1) + at(f) + at(f + 1));
  let norm = strength.slice();
  if (strength.length >= 3 && w >= 3) {
    const win = Math.min(w, strength.length);
    const localMean = convolveSame(strength, new Array(win).fill(1 / win));
    norm = strength.map((s, i) => s / (localMean[i] + 1e-8));
  }
  const thr = percentile(norm, 100 - topPct);
  let cand = norm.map((_, i) => i).filter((i) => norm[i] >= thr);
  if (cand.length > 0 && norm.length >= 3) {
    const last = norm.length - 1;
    const isPeak = norm.map((v, i) => (i === 0 ? v >= norm[1] : i === last ? v >= norm[last - 1] : v >= norm[i - 1] && v >= norm[i + 1]));
    cand = cand.filter((i) => isPeak[i]);
  }
  const suppressed = new Array(norm.length).fill(false);
  const selected: number[] = [];
  for (const i of [...cand].sort((a, b) => norm[b] - norm[a] || a - b)) {
    if (suppressed[i]) continue;
    selected.push(i);
    for (let j = Math.max(0, i - minSep); j <= Math.min(norm.length - 1, i + minSep); j++) suppressed[j] = true;
  }
  return selected.sort((a, b) => a - b).map((i) => beatFrames[i]);
}

function energyStats(samples: Float32Array): { meanDb: number; rangeDb: number } {
  const dbs: number[] = [];
  for (let start = 0; start < samples.length; start += RMS_FRAME) {
    const end = Math.min(samples.length, start + RMS_FRAME);
    let s = 0;
    for (let i = start; i < end; i++) s += samples[i] * samples[i];
    dbs.push(20 * Math.log10(Math.max(1e-10, Math.sqrt(s / Math.max(1, end - start)))));
  }
  if (dbs.length === 0) return { meanDb: -200, rangeDb: 0 };
  return { meanDb: mean(dbs), rangeDb: percentile(dbs, 95) - percentile(dbs, 10) };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** BPM, beats and strong beats of mono PCM at `sr`. */
export function analyzeBeats(samples: Float32Array, sr: number = BEAT_SR): BeatAnalysis {
  const fps = sr / HOP;
  const durationSec = samples.length / sr;
  const { meanDb, rangeDb } = energyStats(samples);
  const base = { durationSec: r2(durationSec), energyMeanDb: r2(meanDb), dynamicRangeDb: r2(rangeDb) };
  if (samples.length < N_FFT) return { bpm: 0, beats: [], accents: [], ...base };
  const env = onsetEnvelope(samples, sr);
  const bpm = estimateTempo(env, fps);
  const frames = trackBeats(env, fps, bpm);
  const toSec = (f: number) => r2((f * HOP) / sr);
  return { bpm: Math.round(bpm * 10) / 10, beats: frames.map(toSec), accents: accentBeats(env, frames).map(toSec), ...base };
}
