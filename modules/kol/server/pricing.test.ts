import { describe, expect, it } from 'vitest';

import { KolError } from './core.js';
import {
  actualCostUsd, estimateGeneration, fmtUsd, JUDGE_ESTIMATE_USD, judgeCostUsd, priceNoteFor, requirePriced, speechCostUsd, speechSecondsFor,
  unitPriceUsd, type EstimateInput,
} from './pricing.js';
import type { ModelInfo } from './types.js';

const m = (over: Partial<ModelInfo>): ModelInfo => ({
  id: 'gemini-3-pro-image', provider: 'gemini', kind: 'image', label: 'x', maxRefs: 14, aspects: ['4:5'], qualities: ['standard', 'high', 'ultra'], priceNote: '', ...over,
});

const est = (over: Partial<EstimateInput>) => estimateGeneration({
  model: m({}), mode: 'compose', quality: 'standard', count: 1, refsCount: 0, judge: false, ...over,
});

describe('unit prices', () => {
  it('picks the price by quality, with a default', () => {
    expect(unitPriceUsd('gemini-3-pro-image', { quality: 'standard' })?.usd).toBe(0.134);
    expect(unitPriceUsd('gemini-3-pro-image', { quality: 'high' })?.usd).toBe(0.134);
    expect(unitPriceUsd('gemini-3-pro-image', { quality: 'ultra' })?.usd).toBe(0.24);
    expect(unitPriceUsd('fal-ai/nano-banana-2/edit', { quality: 'draft' })?.usd).toBe(0.06);
  });

  it('uses the audio price for video when audio is on', () => {
    expect(unitPriceUsd('fal-ai/kling-video/v3/pro/image-to-video', { audio: false })?.usd).toBe(0.112);
    expect(unitPriceUsd('fal-ai/kling-video/v3/pro/image-to-video', { audio: true })?.usd).toBe(0.168);
    expect(unitPriceUsd('bytedance/seedance-2.0/image-to-video', { quality: 'high', audio: true })?.usd).toBe(0.682);
  });

  it('lets settings overrides win, and knows nothing about unpriced models', () => {
    expect(unitPriceUsd('gemini-3-pro-image', { quality: 'ultra' }, { 'gemini-3-pro-image': 0.5 })).toMatchObject({ usd: 0.5, source: 'override' });
    expect(unitPriceUsd('higgsfield/marketing-studio/image/flare', {})).toBeNull();
    expect(unitPriceUsd('higgsfield/marketing-studio/image/flare', {}, { 'higgsfield/marketing-studio/image/flare': 0.09 })?.usd).toBe(0.09);
  });
});

describe('estimateGeneration', () => {
  it('prices images by count, plus input images and the judge', () => {
    const e = est({ count: 3, refsCount: 4, judge: true, judgeModel: 'gemini-2.5-flash' });
    expect(e.units).toBe(3);
    expect(e.generationUsd).toBeCloseTo(3 * 0.134 + 3 * 4 * 0.0011, 6);
    expect(e.judgeUsd).toBeCloseTo(3 * JUDGE_ESTIMATE_USD, 6);
    expect(e.totalUsd).toBeCloseTo(e.generationUsd + e.judgeUsd, 6);
    expect(e.priced).toBe(true);
  });

  it('does not add input-image cost under an override (the override is the whole unit price)', () => {
    const e = est({ count: 2, refsCount: 5, overrides: { 'gemini-3-pro-image': 0.2 } });
    expect(e.generationUsd).toBeCloseTo(0.4, 6);
    expect(e.source).toBe('override');
  });

  it('prices video per second with audio', () => {
    const e = est({ model: m({ id: 'veo-3.1-fast-generate-preview', kind: 'video' }), mode: 'animate', durationSec: 8, audio: true });
    expect(e.units).toBe(8);
    expect(e.totalUsd).toBeCloseTo(8 * 0.15, 6);
    expect(e.judgeUsd).toBe(0);
  });

  it('prices talking videos by the spoken length of the script, plus speech', () => {
    const script = 'x'.repeat(120);
    const e = est({ model: m({ id: 'fal-ai/bytedance/omnihuman/v1.5', kind: 'lipsync' }), mode: 'talking', script });
    expect(e.units).toBe(speechSecondsFor(script));
    expect(e.units).toBe(10);
    expect(e.generationUsd).toBeCloseTo(10 * 0.16, 6);
    expect(e.speechUsd).toBeCloseTo(120 * 0.0002, 6);
  });

  it('marks unknown prices and refuses them with 412', () => {
    const e = est({ model: m({ id: 'higgsfield/xai/grok-imagine-image-2.0', provider: 'higgsfield' }) });
    expect(e.priced).toBe(false);
    expect(e.totalUsd).toBe(0);
    expect(() => requirePriced(e)).toThrowError(KolError);
    try { requirePriced(e); } catch (err) { expect((err as KolError).status).toBe(412); expect((err as KolError).message).toContain('Chưa có giá'); }
    expect(() => requirePriced(est({}))).not.toThrow();
  });
});

describe('costs after the fact', () => {
  it('computes judge cost from tokens', () => {
    expect(judgeCostUsd('gemini-2.5-flash', 4000, 200)).toBeCloseTo((4000 * 0.3 + 200 * 2.5) / 1e6, 9);
    expect(judgeCostUsd('unknown-judge', 1, 1)).toBe(JUDGE_ESTIMATE_USD);
  });

  it('computes actual cost by units and returns null when unpriced', () => {
    expect(actualCostUsd(m({}), { quality: 'standard', units: 2, refsCount: 1 })).toBeCloseTo(2 * 0.134 + 2 * 0.0011, 6);
    expect(actualCostUsd(m({ id: 'nope' }), { quality: 'standard', units: 1 })).toBeNull();
    expect(speechCostUsd('  hello  ')).toBeCloseTo(5 * 0.0002, 9);
  });
});

describe('formatting', () => {
  it('formats USD the Vietnamese way', () => {
    expect(fmtUsd(0.134)).toBe('$0,134');
    expect(fmtUsd(0.15)).toBe('$0,15');
    expect(fmtUsd(0.4)).toBe('$0,40');
    expect(fmtUsd(10)).toBe('$10,00');
    expect(fmtUsd(0.0011)).toBe('$0,0011');
  });

  it('writes price notes', () => {
    expect(priceNoteFor('gemini-3-pro-image')).toBe('≈ $0,134/ảnh (4K $0,24)');
    expect(priceNoteFor('fal-ai/kling-video/v3/pro/image-to-video')).toBe('≈ $0,112/giây, có tiếng $0,168/giây');
    expect(priceNoteFor('gemini-3.1-flash-image')).toContain('(ước tính)');
    expect(priceNoteFor('higgsfield/xai/grok-imagine-image-2.0')).toContain('Chưa có giá');
  });
});
