import { describe, expect, it } from 'vitest';
import type { EditPlan, Transcript } from '../types.js';
import {
  applyPatch, autoPlan, derivePlan, diffPlans, planMapper, preserveOwnerElements, validateAgentPlan, type PlanTemplate,
} from './plan.js';

const T: Transcript = {
  language: 'vi', model: 't', durationSec: 6, createdAt: '2026-01-01T00:00:00.000Z',
  words: ([
    ['Xin', 0.2, 0.5], ['chào', 0.5, 0.8], ['ờ', 0.9, 1.2], ['các', 1.3, 1.5], ['bạn', 1.5, 1.8],
    ['hôm', 3.0, 3.2], ['nay', 3.2, 3.5], ['mình', 3.5, 3.8], ['nói', 3.8, 4.1],
  ] as [string, number, number][]).map(([text, start, end], i) => ({ i, text, start, end })),
};
const ctx = { transcript: T, analysis: null };
const base = { previous: null, version: 2, aspect: '9:16' as const, styleId: 'kienthuc' };

const TEMPLATE: PlanTemplate = {
  components: {
    'text-beat': { kind: 'beat', props: { kicker: { type: 'text', maxWords: 2 }, title: { type: 'markup', required: true }, sub: { type: 'text' } }, animations: ['typewriter', 'pop', 'fade'] },
    'scene-steps': { kind: 'scene', props: { title: { type: 'text', required: true }, items: { type: 'list', required: true, maxItems: 5 } } },
    'logo-end': { kind: 'graphic', props: {} },
  },
  animations: [{ id: 'typewriter' }, { id: 'pop' }, { id: 'fade' }, { id: 'slide-up' }],
};
const templates = (id: string) => (id === 'th-vang' ? TEMPLATE : id === 'style:kienthuc' ? { ...TEMPLATE, components: {}, legacy: true } : null);
const v2 = (extra: Record<string, unknown>) => validateAgentPlan({ templateId: 'th-vang', cutWords: [2], ...extra }, ctx, { ...base, templates });
const beat = (extra: Record<string, unknown> = {}) => ({ at: 0.2, duration: 1, title: 'Làm *ba bước*', ...extra });

describe('validateAgentPlan: legacy plans', () => {
  it('keeps a legacy plan valid and in its old shape', () => {
    const res = validateAgentPlan({
      cutWords: [2], gapMs: 250,
      brolls: [{ id: 'r1', anchorWord: 2, duration: 1.5, title: 'Shop', layout: 'full' }],
      overlays: [{ id: 'o1', effect: 'keyword-pop', anchorWord: 7, duration: 1, props: { text: 'x' } }],
      zooms: [{ at: 0.5, duration: 0.8, scale: 1.15 }],
    }, ctx, { ...base, templates });
    expect(res.errors).toEqual([]);
    const plan = res.plan!;
    for (const key of ['planFormat', 'templateId', 'autoCut', 'beats', 'scenes', 'graphics']) expect(key in plan, key).toBe(false);
    expect(plan.zooms).toEqual([{ at: 0.5, duration: 0.8, scale: 1.15 }]);
    // the old rule: a B-roll may anchor on a cut word
    expect(plan.brolls[0]).toMatchObject({ id: 'r1', anchorWord: 2, enabled: true });
  });

  it('accepts a stored legacy plan as input and derives the same cut', () => {
    const stored = autoPlan({ transcript: T, project: { title: 'Việc mới', aspect: '9:16', styleId: 'kienthuc' }, profile: { keepWords: [] } });
    const res = validateAgentPlan(stored, ctx, { ...base, previous: stored });
    expect(res.errors).toEqual([]);
    expect(res.plan).toMatchObject({ cutWords: stored.cutWords, outputDurationSec: stored.outputDurationSec, keep: stored.keep });
    expect(res.plan!.changes).toEqual(['Không có thay đổi']);
  });

  it('still requires at or anchorWord on a zoom', () => {
    expect(validateAgentPlan({ zooms: [{ duration: 1, scale: 1.2 }] }, ctx, base).errors[0]).toMatch(/zooms\[0\]: cần at hoặc anchorWord/);
  });
});

describe('validateAgentPlan: plan v2', () => {
  it('mints ids per kind, re-times anchored elements and keeps the v2 fields', () => {
    const res = v2({
      autoCut: true,
      beats: [beat({ anchorWord: 5, at: undefined, animIn: 'pop' }), beat({ kicker: 'BƯỚC 1', at: 0.1, duration: 0.5 })],
      scenes: [{ component: 'scene-steps', anchorWord: 7, duration: 0.5, props: { title: 'Các bước', items: ['Quay', 'Dựng'] } }],
      graphics: [{ component: 'logo-end', at: 2, duration: 0.4 }],
      zooms: [{ anchorWord: 3, duration: 0.8, scale: 1.2 }],
      brolls: [{ id: 'r1', anchorWord: 3, duration: 1, title: 'Shop', hint: 'cảnh shop', query: { description: 'cửa hàng', keywords: ['shop', 'store'] }, sound: { mode: 'none' } }],
    });
    expect(res.errors).toEqual([]);
    const plan = res.plan!;
    expect(plan).toMatchObject({ planFormat: 2, templateId: 'th-vang', autoCut: true, author: 'agent' });
    expect(plan.beats!.map((b) => [b.id, b.component])).toEqual([['b1', 'text-beat'], ['b2', 'text-beat']]);
    expect(plan.scenes![0].id).toBe('s1');
    expect(plan.graphics![0].id).toBe('g1');
    expect(plan.zooms[0].id).toBe('z1');
    expect(plan.brolls[0]).toMatchObject({ hint: 'cảnh shop', query: { keywords: ['shop', 'store'] }, sound: { mode: 'none', volume: 1 } });
    const { map } = planMapper(plan, ctx);
    expect(plan.beats![0].at).toBeCloseTo(map(T.words[5].start)!, 3);
    expect(plan.scenes![0].at).toBeCloseTo(map(T.words[7].start)!, 3);
    expect(plan.zooms[0].at).toBeCloseTo(map(T.words[3].start)!, 3);
    expect(plan.beats![1].at).toBe(0.1);
  });

  it('warns about title length and overlaps without blocking', () => {
    const res = v2({ beats: [beat({ title: 'Một' }), beat({ at: 0.5, title: 'Hai ba bốn năm sáu bảy tám' }), beat({ at: 1.6, title: 'a|b|c d' })] });
    expect(res.errors).toEqual([]);
    expect(res.warnings.join('\n')).toMatch(/beats "b1": tiêu đề nên 2–6 từ \(đang 1\)/);
    expect(res.warnings.join('\n')).toMatch(/beats "b2": tiêu đề nên 2–6 từ \(đang 7\)/);
    expect(res.warnings.join('\n')).toMatch(/beats "b3": tiêu đề tối đa 2 dòng/);
    expect(res.warnings.join('\n')).toMatch(/Track Chữ: "b2" chồng thời gian với "b1"/);
  });

  it('rejects broken v2 rules', () => {
    const err = (extra: Record<string, unknown>) => v2(extra).errors.join('\n');
    expect(err({ beats: [beat({ id: 'x1' })], scenes: [{ id: 'x1', component: 'scene-steps', at: 0, duration: 1, props: { title: 'a', items: ['b'] } }] })).toMatch(/id phần tử bị trùng: x1/);
    expect(err({ beats: [beat({ anchorWord: 2 })] })).toMatch(/beats "b1": anchorWord 2 là từ đã cắt/);
    expect(err({ beats: [beat({ anchorWord: 99 })] })).toMatch(/anchorWord vượt quá 8/);
    expect(err({ beats: [{ duration: 1, title: 'Hai từ' }] })).toMatch(/cần at hoặc anchorWord/);
    expect(err({ autoCut: false })).toMatch(/autoCut false/);
    expect(err({ beats: [beat({ component: 'nope' })] })).toMatch(/mẫu không có component "nope"/);
    expect(err({ beats: [beat({ component: 'scene-steps' })] })).toMatch(/dành cho scene, không dùng cho beat/);
    expect(err({ beats: [beat({ animIn: 'spin' })] })).toMatch(/mẫu không có hiệu ứng vào "spin"/);
    expect(err({ beats: [beat({ animIn: 'slide-up' })] })).toMatch(/không nhận hiệu ứng vào "slide-up"/);
    expect(err({ beats: [beat({ sound: { mode: 'asset' } })] })).toMatch(/cần assetId/);
    expect(err({ brolls: [{ anchorWord: 2, duration: 1, title: 'x' }] })).toMatch(/brolls "[^"]+": anchorWord 2 là từ đã cắt/);
    const scene = (props: Record<string, unknown>) => ({ scenes: [{ component: 'scene-steps', at: 0, duration: 1, props }] });
    expect(err(scene({ title: 'a' }))).toMatch(/thiếu prop "items"/);
    expect(err(scene({ title: 'a', items: 'b' }))).toMatch(/prop "items" phải là danh sách chữ/);
    expect(err(scene({ title: 'a', items: ['1', '2', '3', '4', '5', '6'] }))).toMatch(/tối đa 5 mục/);
    expect(err(scene({ title: 'a', items: ['1'], foo: 'x' }))).toMatch(/không có prop "foo"/);
    expect(v2({ beats: [beat({ id: 'a b' })] }).errors[0]).toMatch(/beats\.0\.id/);
    expect(v2({ beats: [beat({ kicker: 'BƯỚC MỘT HAI' })] }).warnings.join('\n')).toMatch(/"kicker" nên tối đa 2 từ/);
  });

  it('skips component checks for a template that is missing or legacy', () => {
    const odd = { beats: [beat({ component: 'whatever', animIn: 'spin' })] };
    const missing = validateAgentPlan({ ...odd, templateId: 'other' }, ctx, { ...base, templates });
    expect(missing.errors).toEqual([]);
    expect(missing.warnings.join('\n')).toMatch(/Mẫu "other" chưa có trên máy/);
    expect(validateAgentPlan({ ...odd, templateId: 'style:kienthuc' }, ctx, { ...base, templates }).errors).toEqual([]);
    expect(validateAgentPlan({ ...odd, templateId: 'th-vang' }, ctx, base).errors).toEqual([]);
  });

  it('lets origin owner stay only on elements the owner made', () => {
    const prev = v2({ beats: [beat({ id: 'b7', origin: 'owner' })] }).plan!;
    expect(prev.beats![0].origin).toBeUndefined(); // the agent cannot claim it
    const owned: EditPlan = { ...prev, beats: [{ ...prev.beats![0], origin: 'owner' }] };
    const res = validateAgentPlan({ templateId: 'th-vang', beats: [beat({ id: 'b7', origin: 'owner' }), beat({ id: 'b8', at: 1.5, origin: 'owner' })] }, ctx, { ...base, previous: owned, version: 3 });
    expect(res.plan!.beats!.map((b) => [b.id, b.origin])).toEqual([['b7', 'owner'], ['b8', undefined]]);
  });
});

describe('derivePlan / diffPlans with v2 elements', () => {
  it('re-times anchored beats, scenes, graphics and zooms when the cuts change', () => {
    const v1 = v2({
      beats: [beat({ anchorWord: 7, at: undefined }), beat({ at: 0.3 })],
      scenes: [{ component: 'scene-steps', anchorWord: 8, duration: 0.3, props: { title: 'a', items: ['b'] } }],
      graphics: [{ component: 'logo-end', anchorWord: 6, duration: 0.3 }],
      zooms: [{ anchorWord: 7, duration: 0.5, scale: 1.1 }],
    }).plan!;
    const next = applyPatch(v1, { cutWords: [0, 1, 2] }, ctx);
    expect(next.beats![0].at).toBeLessThan(v1.beats![0].at);
    expect(next.scenes![0].at).toBeLessThan(v1.scenes![0].at);
    expect(next.graphics![0].at).toBeLessThan(v1.graphics![0].at);
    expect(next.zooms[0].at).toBeLessThan(v1.zooms[0].at);
    expect(next.beats![1].at).toBe(0.3);
  });

  it('lists element changes in the diff', () => {
    const a = v2({ beats: [beat(), beat({ at: 1.5 })] }).plan!;
    const b: EditPlan = { ...a, beats: [{ ...a.beats![0], title: 'Khác hẳn đi' }, ...a.beats!.slice(1), { ...a.beats![0], id: 'b9', at: 2 }] };
    expect(diffPlans(a, b)).toContain('Chữ: thêm 1, sửa 1');
  });
});

describe('validateAgentPlan: owner ids', () => {
  it('never gives a new AI element the id of an owner element of the previous version', () => {
    const prev = v2({ beats: [beat({ id: 'b1' })] }).plan!;
    const owned: EditPlan = { ...prev, beats: [{ ...prev.beats![0], origin: 'owner' }] };
    // The AI drops the owner beat, writes one beat without an id and one that reuses 'b1'.
    const res = validateAgentPlan({ templateId: 'th-vang', beats: [beat({ title: 'Một *mới*' }), beat({ id: 'b1', at: 2, title: 'Hai *mới*' })] }, ctx, { ...base, previous: owned, version: 3, templates });
    expect(res.errors).toEqual([]);
    const beats = res.plan!.beats!;
    const ownerBeat = beats.find((b) => b.origin === 'owner');
    expect(ownerBeat?.id).toBe('b1');
    expect(ownerBeat?.title).toBe(owned.beats![0].title);
    expect(new Set(beats.map((b) => b.id)).size).toBe(beats.length);
    expect(beats.filter((b) => b.origin !== 'owner').map((b) => b.title).sort()).toEqual(['Hai *mới*', 'Một *mới*']);
  });
});

describe('preserveOwnerElements', () => {
  const prev = (): EditPlan => {
    const plan = v2({ beats: [beat(), beat({ at: 1.2 })], zooms: [{ id: 'z4', at: 0.5, duration: 0.5, scale: 1.2 }] }).plan!;
    plan.beats![1] = { ...plan.beats![1], origin: 'owner' };
    plan.zooms[0] = { ...plan.zooms[0], origin: 'owner' };
    return plan;
  };

  it('copies back the owner elements a new AI plan dropped, once', () => {
    const next = v2({ beats: [beat({ title: 'Bản mới hơn' })] }).plan!;
    const out = preserveOwnerElements(prev(), next);
    expect(out.beats!.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(out.beats![1].origin).toBe('owner');
    expect(out.zooms.map((z) => z.id)).toEqual(['z4']);
    expect(out.changes).toEqual(expect.arrayContaining(['Giữ chữ bạn đã thêm: «Làm ba bước»', 'Giữ zoom bạn đã thêm: «zoom 0.5s»']));
    expect(preserveOwnerElements(prev(), out)).toBe(out);
    expect(preserveOwnerElements(null, next)).toBe(next);
  });

  it('re-times kept anchored elements with ctx and runs inside validateAgentPlan', () => {
    const p = prev();
    p.beats![1] = { ...p.beats![1], anchorWord: 7 };
    const next = v2({ cutWords: [0, 1, 2], beats: [] }).plan!;
    const out = preserveOwnerElements(p, next, ctx);
    expect(out.beats![0].at).toBeCloseTo(planMapper(out, ctx).map(T.words[7].start)!, 3);
    const viaValidator = validateAgentPlan({ templateId: 'th-vang', cutWords: [2], beats: [] }, ctx, { ...base, previous: p, version: 3 });
    expect(viaValidator.plan!.beats!.map((b) => b.id)).toEqual(['b2']);
    expect(viaValidator.plan!.changes!.join('\n')).toMatch(/Giữ chữ bạn đã thêm/);
    expect(derivePlan(viaValidator.plan!, ctx).beats![0].at).toBe(viaValidator.plan!.beats![0].at);
  });
});
