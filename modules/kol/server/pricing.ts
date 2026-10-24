/**
 * KOL Studio price table and estimates. Pure: no database, no network.
 *
 * Prices are USD per unit: per image, per second of video, or per character of
 * speech. `settings.priceOverrides[modelId]` (USD per unit) always wins over the
 * built-in table. A model with no price and no override cannot be used: the
 * request is refused with 412 so nothing is ever spent "unpriced".
 *
 * Sources (2026-10): Google AI Studio pricing for Gemini/Veo, fal.ai model pages
 * (docs research in docs/plans). Entries marked `approx` are not confirmed from
 * an official page and should be checked by the owner. Higgsfield publishes no
 * per-model prices, so its models have none: the owner enters one in Settings.
 */

import { KolError } from './core.js';
import type { GenerationMode, ModelInfo, Quality } from './types.js';

export type PriceUnit = 'image' | 'second' | 'char';
type QualityPrices = Partial<Record<Quality, number>> & { default: number };

export interface PriceRule {
  unit: PriceUnit;
  /** Base price per unit (video: without audio). */
  usd: number | QualityPrices;
  /** Video: price per second when native audio is on. */
  audioUsd?: number | QualityPrices;
  /** Extra per input reference image. */
  inputImageUsd?: number;
  /** Not confirmed from an official price page. */
  approx?: boolean;
}

/** Speech for talking videos (ElevenLabs). Per character, approximate (depends on the owner's plan). */
export const TTS_PRICE_ID = 'elevenlabs/eleven_multilingual_v2';

export const PRICE_TABLE: Record<string, PriceRule> = {
  // ── Gemini (Google AI Studio) ──
  'gemini-3-pro-image': { unit: 'image', usd: { default: 0.134, ultra: 0.24 }, inputImageUsd: 0.0011 },
  'gemini-3.1-flash-image': { unit: 'image', usd: { default: 0.067, high: 0.101, ultra: 0.151 }, approx: true },
  'gemini-2.5-flash-image': { unit: 'image', usd: 0.039 },
  // The Gemini API always generates audio with Veo 3.x, so the audio price applies.
  'veo-3.1-generate-preview': { unit: 'second', usd: 0.4, audioUsd: 0.4 },
  'veo-3.1-fast-generate-preview': { unit: 'second', usd: 0.15, audioUsd: 0.15 },

  // ── ChatGPT (Codex, signed in with the owner's ChatGPT plan): no per-image price ──
  'chatgpt-image': { unit: 'image', usd: 0 },

  // ── fal.ai ──
  'fal-ai/nano-banana-pro/edit': { unit: 'image', usd: { default: 0.15, ultra: 0.3 } },
  'fal-ai/nano-banana-2/edit': { unit: 'image', usd: { default: 0.08, draft: 0.06, high: 0.12, ultra: 0.16 } },
  'fal-ai/nano-banana/edit': { unit: 'image', usd: 0.039 },
  'fal-ai/bytedance/seedream/v4.5/edit': { unit: 'image', usd: 0.04 },
  'fal-ai/kling-video/v3/pro/image-to-video': { unit: 'second', usd: 0.112, audioUsd: 0.168 },
  'fal-ai/veo3.1/fast/image-to-video': { unit: 'second', usd: 0.1, audioUsd: 0.15 },
  'fal-ai/veo3.1/image-to-video': { unit: 'second', usd: 0.2, audioUsd: 0.4 },
  'bytedance/seedance-2.0/image-to-video': { unit: 'second', usd: { default: 0.3034, high: 0.682 }, audioUsd: { default: 0.3034, high: 0.682 } },
  'fal-ai/bytedance/omnihuman/v1.5': { unit: 'second', usd: 0.16 },
  'fal-ai/kling-video/ai-avatar/v2/pro': { unit: 'second', usd: 0.115 },
  'veed/fabric-1.0': { unit: 'second', usd: { default: 0.15, draft: 0.08 } },

  // ── Speech ──
  [TTS_PRICE_ID]: { unit: 'char', usd: 0.0002, approx: true },
};

/** Consistency judge (vision LLM): USD per million tokens. */
export const JUDGE_PRICES: Record<string, { inputPerM: number; outputPerM: number }> = {
  'gemini-2.5-flash': { inputPerM: 0.3, outputPerM: 2.5 },
  'gemini-2.5-flash-lite': { inputPerM: 0.1, outputPerM: 0.4 },
  'gemini-3-flash-preview': { inputPerM: 0.5, outputPerM: 3 },
  'gemini-2.5-pro': { inputPerM: 1.25, outputPerM: 10 },
  // Codex on the ChatGPT plan: no per-call price.
  chatgpt: { inputPerM: 0, outputPerM: 0 },
};
/** Pre-price of one judge call (a few images + a short JSON answer). */
export const JUDGE_ESTIMATE_USD = 0.002;

/** Speaking rate used to pre-price talking videos: characters per second (Vietnamese, natural pace). */
export const SPEECH_CHARS_PER_SEC = 12;

const pick = (v: number | QualityPrices, quality: Quality | undefined): number =>
  typeof v === 'number' ? v : (quality !== undefined && v[quality] !== undefined ? v[quality]! : v.default);

export type PriceSource = 'override' | 'builtin';

/** USD per unit for a model, or null when neither an override nor a built-in price exists. */
export function unitPriceUsd(
  modelId: string,
  opts: { quality?: Quality; audio?: boolean },
  overrides: Record<string, number> = {},
): { usd: number; unit: PriceUnit | null; source: PriceSource } | null {
  const rule = PRICE_TABLE[modelId];
  const override = overrides[modelId];
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) {
    return { usd: override, unit: rule?.unit ?? null, source: 'override' };
  }
  if (!rule) return null;
  const base = opts.audio && rule.audioUsd !== undefined ? rule.audioUsd : rule.usd;
  return { usd: pick(base, opts.quality), unit: rule.unit, source: 'builtin' };
}

export function hasPrice(modelId: string, overrides: Record<string, number> = {}): boolean {
  return unitPriceUsd(modelId, {}, overrides) !== null;
}

/** "$0,134" — Vietnamese decimal comma, up to 4 decimals without trailing zeros (min 2). */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0';
  const digits = n !== 0 && Math.abs(n) < 0.01 ? 4 : 3;
  let s = n.toFixed(digits);
  s = s.replace(/0+$/, '');
  const [i, d = ''] = s.split('.');
  return `$${i},${d.padEnd(2, '0')}`;
}

/** Short Vietnamese price note shown next to a model. */
export function priceNoteFor(modelId: string): string {
  if (modelId === 'chatgpt-image') return 'Trong gói ChatGPT, không tính tiền mỗi ảnh';
  const rule = PRICE_TABLE[modelId];
  if (!rule) return 'Chưa có giá công bố: nhập giá ở Cài đặt › Giá ghi đè';
  const unit = rule.unit === 'image' ? 'ảnh' : rule.unit === 'second' ? 'giây' : 'ký tự';
  const approx = rule.approx ? ' (ước tính)' : '';
  const base = rule.usd;
  const audio = rule.audioUsd;
  if (rule.unit === 'second' && audio !== undefined && pick(audio, undefined) !== pick(base, undefined)) {
    return `≈ ${fmtUsd(pick(base, undefined))}/${unit}, có tiếng ${fmtUsd(pick(audio, undefined))}/${unit}${approx}`;
  }
  if (typeof base === 'number') return `≈ ${fmtUsd(base)}/${unit}${approx}`;
  const extras: string[] = [];
  if (base.draft !== undefined) extras.push(`nháp ${fmtUsd(base.draft)}`);
  if (base.high !== undefined) extras.push(`cao ${fmtUsd(base.high)}`);
  if (base.ultra !== undefined) extras.push(`4K ${fmtUsd(base.ultra)}`);
  return `≈ ${fmtUsd(base.default)}/${unit}${extras.length ? ` (${extras.join(', ')})` : ''}${approx}`;
}

/** Seconds a script takes to speak, for pre-pricing (min 3 s). */
export function speechSecondsFor(script: string): number {
  const chars = script.trim().length;
  return Math.max(3, Math.ceil(chars / SPEECH_CHARS_PER_SEC));
}

export interface EstimateInput {
  model: ModelInfo;
  mode: GenerationMode;
  quality: Quality;
  count: number;
  durationSec?: number;
  audio?: boolean;
  script?: string;
  /** Reference images sent with each image request. */
  refsCount: number;
  /** Whether a consistency judge runs on each output. */
  judge: boolean;
  judgeModel?: string;
  overrides?: Record<string, number>;
}

export interface Estimate {
  totalUsd: number;
  generationUsd: number;
  judgeUsd: number;
  speechUsd: number;
  unitUsd: number | null;
  units: number;
  /** False when the model has no price: requests must be refused. */
  priced: boolean;
  source: PriceSource | null;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function judgeEstimateUsd(judgeModel: string | undefined): number {
  if (judgeModel === 'chatgpt') return 0;
  return judgeModel && JUDGE_PRICES[judgeModel] ? JUDGE_ESTIMATE_USD : JUDGE_ESTIMATE_USD * 2;
}

/** Pre-price of a generation request, including judge calls and speech. */
export function estimateGeneration(input: EstimateInput): Estimate {
  const overrides = input.overrides ?? {};
  const price = unitPriceUsd(input.model.id, { quality: input.quality, audio: input.audio }, overrides);
  let units: number;
  let speechUsd = 0;
  if (input.model.kind === 'image') {
    units = Math.max(1, input.count);
  } else if (input.model.kind === 'lipsync') {
    units = speechSecondsFor(input.script ?? '');
    const tts = unitPriceUsd(TTS_PRICE_ID, {}, overrides);
    speechUsd = (tts?.usd ?? 0) * (input.script ?? '').trim().length;
  } else {
    units = Math.max(1, input.durationSec ?? 5);
  }
  const rule = PRICE_TABLE[input.model.id];
  const inputImages = price?.source === 'builtin' && input.model.kind === 'image' ? (rule?.inputImageUsd ?? 0) * input.refsCount * units : 0;
  const generationUsd = price ? price.usd * units + inputImages : 0;
  const judgeUsd = input.judge && input.model.kind === 'image' ? judgeEstimateUsd(input.judgeModel) * units : 0;
  return {
    totalUsd: round6(generationUsd + judgeUsd + speechUsd),
    generationUsd: round6(generationUsd),
    judgeUsd: round6(judgeUsd),
    speechUsd: round6(speechUsd),
    unitUsd: price?.usd ?? null,
    units,
    priced: price !== null,
    source: price?.source ?? null,
  };
}

export const NO_PRICE_MESSAGE = 'Chưa có giá cho model này. Nhập giá (USD mỗi ảnh hoặc mỗi giây video) ở KOL Studio › Cài đặt › Giá ghi đè rồi thử lại.';

/** Throws 412 when the estimate has no price. */
export function requirePriced(est: Estimate): void {
  if (!est.priced) throw new KolError(412, NO_PRICE_MESSAGE, 'no_price');
}

/** USD of a judge call from token counts (estimated when the model is unknown). */
export function judgeCostUsd(judgeModel: string, inputTokens: number, outputTokens: number): number {
  const p = JUDGE_PRICES[judgeModel];
  if (!p) return JUDGE_ESTIMATE_USD;
  return round6((Math.max(0, inputTokens) * p.inputPerM + Math.max(0, outputTokens) * p.outputPerM) / 1e6);
}

/** Final cost of a finished generation when the provider reports nothing: unit price × actual units. */
export function actualCostUsd(model: ModelInfo, opts: { quality: Quality; audio?: boolean; units: number; refsCount?: number }, overrides: Record<string, number> = {}): number | null {
  const price = unitPriceUsd(model.id, { quality: opts.quality, audio: opts.audio }, overrides);
  if (!price) return null;
  const rule = PRICE_TABLE[model.id];
  const inputImages = price.source === 'builtin' && model.kind === 'image' ? (rule?.inputImageUsd ?? 0) * (opts.refsCount ?? 0) * opts.units : 0;
  return round6(price.usd * opts.units + inputImages);
}

/** USD of speech for a script (ElevenLabs), by characters. */
export function speechCostUsd(text: string, overrides: Record<string, number> = {}): number {
  const p = unitPriceUsd(TTS_PRICE_ID, {}, overrides);
  return round6((p?.usd ?? 0) * text.trim().length);
}
