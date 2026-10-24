/**
 * Cost of a batch of scenes before it is generated, and a fingerprint of the batch so an approval
 * no longer applies once any scene in it changes.
 *
 * Veo and fal use KOL Studio's price table (and the owner's overrides). HeyGen spends plan credits:
 * measured 18 credits for a 42 s Avatar IV video on 2026-10-20, about 26 credits a minute
 * (override with VIDEO_STUDIO_HEYGEN_CREDITS_PER_MIN). RocketFlow uses the owner's Google Flow plan;
 * Pexels stock and existing clips are free.
 */

import { createHash } from 'node:crypto';

import { unitPriceUsd } from '../../kol-port.js';
import { FAL_VIDEO_MODEL, VEO_MODEL } from './kol-bridge.js';
import { estimateSpeechSec } from './store.js';
import type { CostEstimate, CostLine, ProductionScene } from './types.js';
import { VEO_MAX_SEC } from './types.js';

export const HEYGEN_CREDITS_PER_MIN = 26;

const VEO_DURATIONS = [4, 6, 8];
const FAL_DURATIONS = [5, 10, 15];
const nearest = (wanted: number, allowed: number[]) => allowed.reduce((b, d) => (Math.abs(d - wanted) < Math.abs(b - wanted) ? d : b), allowed[0]);

function heygenPerMin(): number {
  const n = Number(process.env.VIDEO_STUDIO_HEYGEN_CREDITS_PER_MIN);
  return Number.isFinite(n) && n > 0 ? n : HEYGEN_CREDITS_PER_MIN;
}

type Pricer = (modelId: string, opts: { audio?: boolean }) => { usd: number; unit: string | null } | null;

export function estimateScenes(scenes: ProductionScene[], overrides: Record<string, number> = {}, price: Pricer = (m, o) => unitPriceUsd(m, o, overrides)): CostEstimate {
  const lines: CostLine[] = [];
  for (const s of scenes) {
    const talking = s.kind === 'talking';
    if (s.engine === 'veo' || s.engine === 'fal') {
      const model = s.model || (s.engine === 'veo' ? VEO_MODEL : FAL_VIDEO_MODEL);
      const seconds = s.engine === 'veo' ? nearest(Math.min(VEO_MAX_SEC, s.durationSec), VEO_DURATIONS) : nearest(Math.min(15, s.durationSec), FAL_DURATIONS);
      const p = price(model, { audio: talking });
      const usd = p ? Math.round(p.usd * (p.unit === 'second' ? seconds : 1) * 1000) / 1000 : null;
      lines.push({ sceneId: s.id, engine: s.engine, seconds, usd, credits: null, note: usd === null ? 'chưa có giá cho model này' : `${seconds}s` });
    } else if (s.engine === 'heygen') {
      const seconds = Math.max(estimateSpeechSec(s.text), 2);
      const credits = Math.max(1, Math.ceil((seconds / 60) * heygenPerMin()));
      lines.push({ sceneId: s.id, engine: s.engine, seconds, usd: null, credits, note: `≈ ${seconds}s lời nói` });
    } else if (s.engine === 'rocketflow') {
      lines.push({ sceneId: s.id, engine: s.engine, seconds: Math.min(VEO_MAX_SEC, s.durationSec), usd: null, credits: null, note: 'credit Google Flow' });
    } else {
      lines.push({ sceneId: s.id, engine: s.engine, seconds: s.durationSec, usd: 0, credits: null, note: s.engine === 'stock' ? 'Pexels, miễn phí' : 'clip có sẵn' });
    }
  }
  return {
    usd: Math.round(lines.reduce((t, l) => t + (l.engine === 'veo' || l.engine === 'fal' ? l.usd ?? 0 : 0), 0) * 100) / 100,
    unpriced: lines.filter((l) => (l.engine === 'veo' || l.engine === 'fal') && l.usd === null).length,
    heygenCredits: lines.reduce((t, l) => t + (l.credits ?? 0), 0),
    flowScenes: lines.filter((l) => l.engine === 'rocketflow').length,
    freeScenes: lines.filter((l) => l.engine === 'stock' || l.engine === 'clip').length,
    lines,
  };
}

/** One line for cards and Telegram: "≈ $2,40 Veo · ≈ 18 credit HeyGen · 1 cảnh Flow". */
export function describeEstimate(e: CostEstimate): string {
  const parts: string[] = [];
  if (e.usd > 0) parts.push(`≈ $${e.usd.toFixed(2).replace('.', ',')} (Veo/fal)`);
  if (e.unpriced) parts.push(`${e.unpriced} cảnh chưa có giá`);
  if (e.heygenCredits) parts.push(`≈ ${e.heygenCredits} credit HeyGen`);
  if (e.flowScenes) parts.push(`${e.flowScenes} cảnh dùng credit Google Flow`);
  if (e.freeScenes) parts.push(`${e.freeScenes} cảnh miễn phí`);
  return parts.join(' · ') || 'Không tốn chi phí';
}

/** Changes whenever any scene of the batch changes in a way that affects what gets generated. */
export function sceneFingerprint(scenes: ProductionScene[], ctx: { aspect?: string; voices?: Record<string, { voiceId: string }> } = {}): string {
  const rows = [...scenes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => [s.id, s.kind, s.kolId, s.text, s.visual, s.engine, s.model, s.sourceAssetId, s.clipAssetId, s.durationSec, s.kolId ? ctx.voices?.[s.kolId]?.voiceId ?? null : null]);
  return createHash('sha256').update(JSON.stringify([ctx.aspect ?? null, rows])).digest('hex').slice(0, 24);
}
