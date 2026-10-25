// Sound of a template plan: the music bed (lower while someone speaks, its last note on the last frame when
// asked, its strong beats for snapToBeat) and the automatic SFX of the template's entrance presets.
//
// The bed follows the speech with HyperFrames audio automation, the same mechanism as its voiceover carve: a
// `volume` lane (louder between phrases, the profile's music level under the voice) and two peaking dips in the
// voice band whose gain lanes follow the same envelope. The speech is known exactly from the transcript, so the
// envelope is computed here instead of being measured from the audio; preview and render play the same lanes.
import type { ElementSound, TranscriptWord } from '../../types.js';
import type { TemplateManifest } from '../../templates/types.js';
import type { ResolvedAsset } from '../library-resolve.js';
import type { Segment } from '../plan.js';
import { r3 } from '../tools.js';
import { dbToGain } from './util.js';

const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'ogg', 'aac'];

/**
 * Bed level between phrases, above its level under the voice: the usual 12 dB duck. The profile's music level
 * stays the level under the voice, so the bed never fights a phrase and comes up in the pauses.
 */
const OPEN_DB = 12;
/** Seconds the bed takes to get out of the way before a phrase, and to come back after it (slow on purpose). */
const ATTACK = 0.2;
const RELEASE = 0.5;
/** Voice-band dips of the carve, and how deep they go under the voice. */
const CARVE_BANDS = [{ id: 'n1', frequency: 1000, label: 'Chừa giọng 1 kHz' }, { id: 'n2', frequency: 2500, label: 'Chừa giọng 2,5 kHz' }];
const CARVE_DB = -6;
const MAX_LANE_POINTS = 500;

export type Range = { start: number; end: number };

/** When someone speaks, in output seconds: kept words, merged across gaps shorter than `mergeGap`. */
export function speechRanges(words: TranscriptWord[], segments: Segment[], cut: Set<number>, mergeGap = ATTACK + RELEASE): Range[] {
  const spans: Range[] = [];
  for (const seg of segments) {
    for (const w of words) {
      if (cut.has(w.i) || w.start < seg.start - 0.001 || w.start >= seg.end) continue;
      spans.push({ start: seg.out + (w.start - seg.start), end: seg.out + (Math.min(w.end, seg.end) - seg.start) });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.start - last.end < mergeGap) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

type Point = { t: number; v: number };

/** 1 between phrases, 0 under the voice, with the attack and release ramps; breakpoints in clip seconds. */
function duckShape(speech: Range[], start: number, dur: number): Point[] {
  const pts: Point[] = [];
  for (const r of speech) {
    const s = r.start - start;
    const e = r.end - start;
    if (e <= 0 || s >= dur) continue;
    pts.push({ t: s - ATTACK, v: 1 }, { t: s, v: 0 }, { t: e, v: 0 }, { t: e + RELEASE, v: 1 });
  }
  return pts;
}

const lerpAt = (pts: Point[], t: number, outside: number): number => {
  if (!pts.length || t <= pts[0].t) return pts.length && t === pts[0].t ? pts[0].v : outside;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (t >= a.t && t <= b.t) return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
  }
  return outside;
};

export interface MusicPlan {
  asset: ResolvedAsset;
  /** Output seconds the bed starts at, seconds into the track it starts from, how long it plays. */
  start: number;
  mediaStart: number;
  duration: number;
  /** The track's strong beats in output seconds (empty when the track has none indexed). */
  beats: number[];
  /** True when the last note was lined up with the end of the video. */
  endAligned: boolean;
}

/**
 * Where the bed sits on the timeline. With endOnFinal the track is entered late so its final note (last strong
 * beat, else its end) lands on the last frame; a track shorter than the video cannot be lined up.
 */
export function placeMusic(asset: ResolvedAsset, total: number, endOnFinal: boolean, warnings: string[]): MusicPlan {
  const len = asset.durationSec;
  let mediaStart = 0;
  let endAligned = false;
  if (endOnFinal) {
    if (!len) warnings.push(`Nhạc "${asset.name}" chưa có thời lượng trong kho — không canh được nốt cuối.`);
    else if (len < total) warnings.push(`Nhạc "${asset.name}" ngắn hơn video — không canh được nốt cuối.`);
    else {
      const last = asset.beats?.length ? asset.beats[asset.beats.length - 1] : null;
      // The final hit plays just before the end; without beats the track's own end is the final note.
      const target = last !== null && last > total ? last + 0.3 : len;
      mediaStart = r3(Math.min(len - total, Math.max(0, target - total)));
      endAligned = true;
    }
  }
  const duration = r3(len ? Math.min(total, len - mediaStart) : total);
  const beats = (asset.beats ?? [])
    .filter((b) => b >= mediaStart && b <= mediaStart + duration)
    .map((b) => r3(b - mediaStart));
  return { asset, start: 0, mediaStart, duration, beats, endAligned };
}

/**
 * The bed's mix attributes. Without ducking: the static level and fades, as legacy compositions have. With it:
 * one `volume` lane in absolute gain that holds the fades too, and the carve's dips with their gain lanes.
 */
export function musicAttrs(m: MusicPlan, baseDb: number, speech: Range[] | null): Record<string, string> {
  const base = dbToGain(baseDb);
  const fadeIn = Math.min(0.6, m.duration / 3);
  const fadeOut = m.endAligned ? Math.min(0.3, m.duration / 3) : Math.min(2, m.duration / 3);
  if (!speech || !speech.length) {
    return { 'data-volume': String(r3(base)), 'data-fade-in': String(r3(fadeIn)), 'data-fade-out': String(r3(fadeOut)) };
  }
  const open = Math.min(1, Math.max(base, dbToGain(baseDb + OPEN_DB)));
  let gap = ATTACK + RELEASE;
  let shape = duckShape(speech, m.start, m.duration);
  // A long talk with many short pauses: merge pauses until the lane fits the point limit.
  while (shape.length > MAX_LANE_POINTS - 8) {
    gap *= 1.5;
    shape = duckShape(mergeRanges(speech, gap), m.start, m.duration);
  }
  const fade = (t: number) => Math.max(0, Math.min(1, t / Math.max(0.001, fadeIn), (m.duration - t) / Math.max(0.001, fadeOut)));
  const times = [...new Set([0, fadeIn, m.duration - fadeOut, m.duration, ...shape.map((p) => p.t)]
    .filter((t) => t >= 0 && t <= m.duration).map(r3))].sort((a, b) => a - b);
  const volume = times.map((t) => {
    const open01 = lerpAt(shape, t, 1);
    return { t, v: r3((base + (open - base) * open01) * fade(t)) };
  });
  const lanes: { target: string; points: Point[] }[] = [{ target: 'volume', points: dedupe(volume) }];
  const carveTimes = [...new Set([0, ...shape.map((p) => p.t)].filter((t) => t >= 0 && t <= m.duration).map(r3))].sort((a, b) => a - b);
  for (const band of CARVE_BANDS) {
    lanes.push({ target: `fx.${band.id}.gain`, points: dedupe(carveTimes.map((t) => ({ t, v: r3(CARVE_DB * (1 - lerpAt(shape, t, 1))) }))) });
  }
  const chain = {
    version: 1,
    nodes: CARVE_BANDS.map((b) => ({ type: 'peaking', id: b.id, label: b.label, params: { frequency: b.frequency, gain: 0, q: 1.4 } })),
  };
  // No data-volume or data-fade-*: when a track has a volume lane, preview and render both play the lane's values.
  return {
    'data-fx-chain': JSON.stringify(chain),
    'data-automation': JSON.stringify({ version: 1, lanes }),
  };
}

function mergeRanges(ranges: Range[], gap: number): Range[] {
  const out: Range[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r.start - last.end < gap) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Consecutive points with the same value collapse to the ends of the run. */
function dedupe(points: Point[]): Point[] {
  return points.filter((p, i) => i === 0 || i === points.length - 1 || !(points[i - 1].v === p.v && points[i + 1].v === p.v));
}

/** `at` moved onto the nearest strong beat when one is within `window` seconds (earlier beat on a tie). */
export function snapToBeat(at: number, beats: number[], window = 0.5): number {
  let best: number | null = null;
  for (const b of beats) {
    const d = Math.abs(b - at);
    if (d <= window + 1e-9 && (best === null || d < Math.abs(best - at) - 1e-9)) best = b;
  }
  return best ?? at;
}

/** Seconds between two automatic sounds, by the template's density. */
const DENSITY_GAP: Record<TemplateManifest['sounds']['density'], number> = { none: Infinity, low: 3, medium: 1.5, high: 0.6 };

export interface SoundCue { id: string; at: number; assetId: string; volume: number }

/**
 * The SFX of placed elements, in time order. `asset` sounds always play; `auto` plays the entrance preset's
 * sound (scenes, graphics and full-frame B-roll fall back to the template's transition sound), no closer to the
 * previous automatic sound than the template's density allows; `none` is silent. No `sound` means `auto`.
 */
export function elementSounds(
  els: { id: string; kind: string; at: number; animIn?: string; sound?: ElementSound; fullFrame?: boolean }[],
  template: Pick<TemplateManifest, 'animations' | 'sounds'>,
): SoundCue[] {
  const gap = DENSITY_GAP[template.sounds.density] ?? DENSITY_GAP.low;
  const out: SoundCue[] = [];
  let lastAuto = -Infinity;
  for (const el of [...els].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))) {
    const sound = el.sound ?? { mode: 'auto' as const, volume: 1 };
    if (sound.mode === 'none') continue;
    if (sound.mode === 'asset') {
      if (sound.assetId) out.push({ id: el.id, at: el.at, assetId: sound.assetId, volume: sound.volume });
      continue;
    }
    const preset = template.animations.find((a) => a.id === el.animIn)?.sound;
    const fallback = el.kind === 'scene' || el.kind === 'graphic' || el.fullFrame ? template.sounds.transition : undefined;
    const assetId = preset ?? fallback;
    if (!assetId || !Number.isFinite(gap) || el.at - lastAuto < gap) continue;
    lastAuto = el.at;
    out.push({ id: el.id, at: el.at, assetId, volume: sound.volume });
  }
  return out;
}

export const isAudio = (a: ResolvedAsset | null): a is ResolvedAsset => Boolean(a && AUDIO_EXTS.includes(a.ext));
