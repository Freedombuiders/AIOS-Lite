// Dựng nhanh helpers of the runner: settings → machine plan, settings forced on the director's plan, owner
// elements protected from the director. The chain itself is tested through the routes (routes-quick.test.ts).
import { describe, expect, it } from 'vitest';
import { getTemplate } from '../templates/registry.js';
import type { EditPlan, QuickSettings, Transcript } from '../types.js';
import { autoPlan, validateAgentPlan } from './plan.js';
import {
  applyQuickSettings, enforceQuickSettings, NO_CUT_GAP_MS, protectOwnerElements, QUICK_GAP_MS, spokenTitle,
} from './runner.js';

const T: Transcript = {
  language: 'vi', model: 't', durationSec: 6, createdAt: 'x',
  words: ([
    ['Xin', 0.2, 0.5], ['chào', 0.5, 0.8], ['ờ', 0.9, 1.2], ['các', 1.3, 1.5], ['bạn', 1.5, 1.8],
    ['hôm', 3.0, 3.2], ['nay', 3.2, 3.5], ['mình', 3.5, 3.8], ['nói', 3.8, 4.1],
  ] as [string, number, number][]).map(([text, start, end], i) => ({ i, text, start, end })),
};
const ctx = { transcript: T, analysis: null };
const QUICK: QuickSettings = {
  mode: 'manual', autoCut: true, cutLevel: 'vua', templateId: 'th-vang', assets: [], stock: true,
  music: { mode: 'none', duck: true, snapToBeat: false, endOnFinal: false }, startedAt: 'x',
};
const base = () => autoPlan({ transcript: T, analysis: null, project: { title: 'Việc mới', aspect: '9:16' }, profile: { keepWords: [] }, version: 3 });

describe('applyQuickSettings', () => {
  it('cut level → gapMs; the template, its captions and plan v2 markers on the plan', () => {
    const template = getTemplate('th-vang')!;
    for (const level of ['nhe', 'vua', 'sat'] as const) {
      const plan = applyQuickSettings(base(), { ...QUICK, cutLevel: level }, template, ctx);
      expect(plan).toMatchObject({ gapMs: QUICK_GAP_MS[level], templateId: 'th-vang', planFormat: 2, autoCut: true, cutWords: [2], version: 3 });
      expect(plan.captions.maxWordsPerChunk).toBe(template.captions.maxWordsPerChunk);
    }
    expect([QUICK_GAP_MS.nhe, QUICK_GAP_MS.vua, QUICK_GAP_MS.sat]).toEqual([800, 400, 250]);
  });

  it('auto-cut off keeps the video as it is', () => {
    const plan = applyQuickSettings(base(), { ...QUICK, autoCut: false }, null, ctx);
    expect(plan).toMatchObject({ autoCut: false, cutWords: [], gapMs: NO_CUT_GAP_MS });
    expect(plan.keep).toHaveLength(1);
    expect(plan.changes).toContain('Tắt tự cắt: giữ nguyên video');
  });

  it('music only when the owner did not say "no music"; titles from the spoken words', () => {
    const music = { assetId: 'lib:bgm:a', gainDb: -18 };
    expect(applyQuickSettings(base(), { ...QUICK, music: { ...QUICK.music, mode: 'pick', assetId: 'lib:bgm:a' } }, null, ctx, { music }).music)
      .toEqual({ assetId: 'lib:bgm:a', mood: '', gainDb: -18, duck: true });
    expect(applyQuickSettings(base(), QUICK, null, ctx, { music }).music).toBeUndefined();
    const titled = applyQuickSettings(base(), QUICK, null, ctx, { title: 'Video thử' });
    expect(titled.meta.title).toBe('Video thử');
    expect(titled.covers.every((c) => c.title === 'Video thử')).toBe(true);
  });

  it('spokenTitle skips fillers and synthetic sounds', () => {
    const words = [{ i: 0, text: 'ừm', start: 0, end: 0.2, synthetic: true as const }, ...T.words.map((w) => ({ ...w, i: w.i + 1 }))];
    expect(spokenTitle({ words })).toBe('Xin chào các bạn hôm nay mình nói');
    expect(spokenTitle({ words: [] })).toBe('Video mới');
  });
});

describe('enforceQuickSettings', () => {
  it('forces the template, auto-cut off and the music choice onto the director\'s plan', () => {
    const agent = { summary: 's', cutWords: [2], gapMs: 250, templateId: 'khac', music: { assetId: 'lib:bgm:x', mood: 'vui', gainDb: -3, duck: false } };
    expect(enforceQuickSettings(agent, { ...QUICK, autoCut: false }, -18)).toMatchObject({ templateId: 'th-vang', planFormat: 2, autoCut: false, cutWords: [], gapMs: NO_CUT_GAP_MS });
    expect(enforceQuickSettings(agent, QUICK, -18)).not.toHaveProperty('music');
    expect((enforceQuickSettings(agent, { ...QUICK, music: { ...QUICK.music, mode: 'pick', assetId: 'lib:bgm:mine' } }, -18) as EditPlan).music)
      .toEqual({ assetId: 'lib:bgm:mine', mood: 'vui', gainDb: -3, duck: true });
    expect((enforceQuickSettings({ summary: 's' }, { ...QUICK, music: { ...QUICK.music, mode: 'pick', assetId: 'lib:bgm:mine' } }, -18) as EditPlan).music)
      .toEqual({ assetId: 'lib:bgm:mine', mood: '', gainDb: -18, duck: true });
    // auto-cut on: the director's cut stays
    expect(enforceQuickSettings(agent, QUICK, -18)).toMatchObject({ cutWords: [2], gapMs: 250 });
    expect(enforceQuickSettings('not a plan', QUICK, -18)).toBe('not a plan');
  });
});

describe('protectOwnerElements', () => {
  const previous: EditPlan = {
    ...base(), planFormat: 2, templateId: 'th-vang',
    beats: [{ id: 'b1', component: 'text-beat', anchorWord: 7, at: 2, duration: 2, title: 'Chủ kênh *thêm*', origin: 'owner' }],
  };

  it('a new director element never takes an owner id, so the owner element is not lost', () => {
    const input = { summary: 'Bản của đạo diễn.', cutWords: [2], beats: [{ component: 'text-beat', anchorWord: 5, duration: 2, title: 'Hôm nay *mình nói*' }] };
    const naive = validateAgentPlan(input, ctx, { previous, version: 4, aspect: '9:16' }).plan!;
    expect(naive.beats!.filter((b) => b.origin === 'owner')).toHaveLength(0);
    const plan = validateAgentPlan(protectOwnerElements(input, previous), ctx, { previous, version: 4, aspect: '9:16' }).plan!;
    expect(plan.beats!.map((b) => [b.id, b.origin ?? 'ai'])).toEqual([['b2', 'ai'], ['b1', 'owner']]);
  });

  it('a director copy of an owner element is dropped: the owner\'s own version comes back', () => {
    const input = { summary: 'Bản của đạo diễn.', cutWords: [2], beats: [{ id: 'b1', component: 'text-beat', anchorWord: 5, duration: 2, title: 'Đạo diễn sửa' }] };
    const plan = validateAgentPlan(protectOwnerElements(input, previous), ctx, { previous, version: 4, aspect: '9:16' }).plan!;
    expect(plan.beats).toHaveLength(1);
    expect(plan.beats![0]).toMatchObject({ id: 'b1', origin: 'owner', title: 'Chủ kênh *thêm*' });
  });

  it('an element of another kind with an owner id is renamed; nothing changes without owner elements', () => {
    const input = { summary: 's', cutWords: [], scenes: [{ id: 'b1', component: 'scene-steps', anchorWord: 5, duration: 4, props: {} }] };
    expect((protectOwnerElements(input, previous) as { scenes: { id: string }[] }).scenes[0].id).toBe('s1');
    expect(protectOwnerElements(input, base())).toBe(input);
    expect(protectOwnerElements(input, null)).toBe(input);
  });
});
