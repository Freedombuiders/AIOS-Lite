import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Transcript } from '../types.js';
import { estimateOutputSeconds, validatePlan } from './plan-schema.js';

const SKILL_REFS = path.resolve(__dirname, '../../../skills/video-edit/references');

/** 160 words of 0.4s each, 70s long: the transcript the documented example plan assumes. */
function fakeTranscript(n = 160): Transcript {
  return {
    language: 'vi', model: 'test', durationSec: 70, createdAt: new Date().toISOString(),
    words: Array.from({ length: n }, (_, i) => ({ i, text: `w${i}`, start: i * 0.4, end: i * 0.4 + 0.3 })),
  };
}

function basePlan(over: Record<string, unknown> = {}) {
  return {
    styleId: 'kienthuc',
    aspect: '9:16',
    summary: 'Cắt từ đệm, mở bằng con số, phụ đề 4 từ một lần.',
    cutWords: [3, 4],
    gapMs: 400,
    captions: { styleId: 'caption:highlight-bar', position: 'bottom', highlight: ['50%'], maxWordsPerChunk: 4 },
    meta: { title: 'Tiêu đề', caption: 'Caption', hashtags: ['#a'] },
    ...over,
  };
}

describe('validatePlan: shape', () => {
  it('accepts a minimal plan and fills defaults', () => {
    const r = validatePlan(basePlan(), fakeTranscript());
    expect(r.ok).toBe(true);
    expect(r.plan?.brolls).toEqual([]);
    expect(r.plan?.overlays).toEqual([]);
    expect(r.estimatedOutputSec).toBeGreaterThan(0);
  });

  it('reports missing and malformed fields with their path', () => {
    const r = validatePlan({ aspect: '3:2', summary: 'ngắn', cutWords: [-1], gapMs: 99999 });
    expect(r.ok).toBe(false);
    const text = r.errors.join('\n');
    expect(text).toContain('styleId');
    expect(text).toContain('aspect');
    expect(text).toContain('summary');
    expect(text).toContain('cutWords');
    expect(text).toContain('gapMs');
    expect(text).toContain('captions');
  });

  it('requires moveFromWord/moveToWord for a moved hook', () => {
    const r = validatePlan(basePlan({
      hook: { options: [{ id: 'h', kind: 'story', text: 'Hook', mode: 'moved' }], chosen: 'h' },
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('moveFromWord');
  });

  it('ignores derived fields the agent may pass', () => {
    const r = validatePlan(basePlan({ keep: [{ start: 0, end: 1 }], outputDurationSec: 5, version: 3, author: 'owner' }), fakeTranscript());
    expect(r.ok).toBe(true);
  });
});

describe('validatePlan: against the transcript', () => {
  const t = fakeTranscript();

  it('rejects word indexes outside the transcript', () => {
    const r = validatePlan(basePlan({ cutWords: [3, 999] }), t);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('999');
  });

  it('rejects B-roll and overlays anchored on a cut word', () => {
    const r = validatePlan(basePlan({
      brolls: [{ id: 'b', anchorWord: 3, duration: 2, title: 't', reason: 'r', source: 'library', assetId: 'image:x', layout: 'card', enabled: true }],
      overlays: [{ id: 'o', effect: 'keyword-pop', anchorWord: 4, at: 5, duration: 2, props: { text: 'x' } }],
    }), t);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('brolls[b]');
    expect(r.errors.join('\n')).toContain('overlays[o]');
  });

  it('checks hook.chosen, moved range bounds and duplicate ids', () => {
    const r = validatePlan(basePlan({
      hook: {
        options: [
          { id: 'a', kind: 'question', text: 'A', mode: 'overlay' },
          { id: 'a', kind: 'story', text: 'B', mode: 'moved', moveFromWord: 150, moveToWord: 500 },
        ],
        chosen: 'zzz',
      },
    }), t);
    expect(r.ok).toBe(false);
    const text = r.errors.join('\n');
    expect(text).toContain('trùng');
    expect(text).toContain('không nằm trong hook.options');
    expect(text).toContain('500');
  });

  it('flags a cover beyond the video and cutting every word', () => {
    expect(validatePlan(basePlan({ covers: [{ frameAt: 200, title: 'x' }] }), t).ok).toBe(false);
    const all = Array.from({ length: 160 }, (_, i) => i);
    expect(validatePlan(basePlan({ cutWords: all }), t).errors.join(' ')).toContain('cắt hết');
  });

  it('warns (not errors) about unknown effects, no ducking and a length far from the target', () => {
    const r = validatePlan(basePlan({
      targetSeconds: 20,
      overlays: [{ id: 'o', effect: 'rainbow', at: 5, duration: 2, props: {} }],
      music: { assetId: 'bgm:x', mood: 'm', gainDb: 0, duck: false },
      sfx: [{ at: 1, assetId: 'sfx:pop' }],
    }), t);
    expect(r.ok).toBe(true);
    const text = r.warnings.join('\n');
    expect(text).toContain('rainbow');
    expect(text).toContain('duck');
    expect(text).toContain('mục tiêu 20s');
  });

  it('only checks structure without a transcript, and says so', () => {
    const r = validatePlan(basePlan({ cutWords: [99999] }), null);
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toContain('transcript');
  });

  it('estimates the output length from kept words and capped gaps', () => {
    const words = [
      { i: 0, text: 'a', start: 0, end: 1 },
      { i: 1, text: 'b', start: 1.2, end: 2 },
      { i: 2, text: 'c', start: 5, end: 6 },
    ];
    // kept: a(1) + gap 0.2 + b(0.8) + gap min(3, 0.4) + c(1) = 3.4
    expect(estimateOutputSeconds(words, new Set(), 400)).toBeCloseTo(3.4, 5);
    // cut b: a(1) + gap min(4, 0.4) + c(1) = 2.4
    expect(estimateOutputSeconds(words, new Set([1]), 400)).toBeCloseTo(2.4, 5);
  });
});

describe('the documented example plan', () => {
  it('is valid against a 160-word transcript', () => {
    const md = fs.readFileSync(path.join(SKILL_REFS, 'plan-schema.md'), 'utf8');
    const block = /```json\n([\s\S]*?)\n```/.exec(md);
    expect(block).not.toBeNull();
    const r = validatePlan(JSON.parse(block![1]), fakeTranscript());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
