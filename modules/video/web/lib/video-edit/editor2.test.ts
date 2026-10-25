import { describe, expect, it } from 'vitest';
import {
  applyElementPatch, applyOverridesPatch, askMark, buildElements, clockVi, componentDef, elementForTool, emptyOverrides,
  fieldPatch, inspectorFields, layersAt, markupCheck, markupStats, mergePatches, musicPickPatch, musicState,
  planSummary, quickPreviewUrl, scalePatch, soundAssetId, soundPatch, type TemplateManifest,
} from './editor2';
import { buildModel, captionChunks } from './plan-geometry';
import type { EditPlan, OverridesDoc, TranscriptWord } from './types';

const WORDS: TranscriptWord[] = ['có', 'gì', 'trong', 'đầu', 'là', 'nói', 'luôn', 'gửi', 'cho', 'ChatGPT'].map((text, i) => ({ i, text, start: i, end: i + 0.8 }));

function makePlan(patch: Partial<EditPlan> = {}): EditPlan {
  return {
    version: 2, createdAt: '', styleId: 'kienthuc', aspect: '9:16', summary: '', sourceDurationSec: 10, outputDurationSec: 10,
    cutWords: [], gapMs: 400, keep: [{ start: 0, end: 10 }], removed: [], brolls: [
      { id: 'br1', anchorWord: 7, duration: 2, title: 'gõ laptop', reason: '', source: 'pexels', layout: 'full', enabled: true, assetId: 'lib-a', query: { description: 'gõ phím', keywords: ['typing'] } },
      { id: 'br-off', anchorWord: 2, duration: 2, title: 'tắt', reason: '', source: 'library', layout: 'full', enabled: false },
    ],
    captions: { styleId: 'x', position: 'bottom', highlight: [], maxWordsPerChunk: 3 }, overlays: [], zooms: [{ id: 'z1', at: 6, duration: 1, scale: 1.07 }],
    sfx: [], covers: [], meta: { title: '', caption: '', hashtags: [] }, author: 'agent', planFormat: 2, templateId: 'th-vang',
    beats: [
      { id: 'b2', at: 4, duration: 2, component: 'text-beat', title: 'Gửi cho *ChatGPT*', animIn: 'pop' },
      { id: 'b1', at: 0.5, duration: 2.4, component: 'text-beat', kicker: 'BƯỚC 1', title: 'Có gì trong đầu|*nói luôn*', sub: 'không cần chuẩn bị', animIn: 'slide-up' },
    ],
    scenes: [{ id: 's1', at: 7, duration: 2.5, component: 'scene-steps', props: { step: 3, title: 'Nhờ *ChatGPT* edit', items: ['Quay', 'Gửi'] } }],
    graphics: [{ id: 'g1', at: 9, duration: 1, component: 'logo-end', props: { name: 'Kênh' } }],
    ...patch,
  };
}

const TEMPLATE = {
  id: 'th-vang', name: 'Talking head vàng', tokens: { fonts: { title: 'Anton', sub: 'Montserrat', caption: 'Montserrat' }, colors: {} },
  components: {
    'text-beat': { kind: 'beat', label: 'Nhịp chữ', file: '', runtime: 'gsap', duration: { min: 1, max: 4, default: 2 }, props: {
      kicker: { type: 'text', label: 'Nhãn nhỏ', maxWords: 3 },
      title: { type: 'markup', label: 'Tiêu đề', required: true, maxWords: 6, maxLines: 2 },
      sub: { type: 'text', label: 'Chữ phụ' },
    } },
    'scene-steps': { kind: 'scene', label: 'Các bước', file: '', runtime: 'gsap', duration: { min: 2, max: 8, default: 5 }, animations: ['pop'], props: {
      step: { type: 'number', label: 'Số bước' }, title: { type: 'markup', label: 'Tiêu đề', maxWords: 6 }, items: { type: 'list', label: 'Các mục', maxItems: 5 },
    } },
    'broll-frame': { kind: 'broll-frame', label: 'Khung cảnh trám', file: '', runtime: 'gsap', duration: { min: 1, max: 6, default: 2 }, props: { layout: { type: 'text', label: 'Kiểu khung' } } },
    'logo-end': { kind: 'graphic', label: 'Logo cuối', file: '', runtime: 'gsap', duration: { min: 1, max: 4, default: 2 }, props: { name: { type: 'text', label: 'Tên kênh' } } },
  },
  animations: [{ id: 'typewriter', label: 'Gõ chữ', sound: 'sfx:typing' }, { id: 'pop', label: 'Bật lên', sound: 'sfx:pop' }, { id: 'fade', label: 'Hiện mờ' }],
} as unknown as TemplateManifest;

const doc = (elements: OverridesDoc['elements'] = {}, extra: Partial<OverridesDoc> = {}): OverridesDoc => ({ version: 1, elements, updatedAt: '2026-10-25T03:00:00.000Z', ...extra });

function elementsOf(plan = makePlan(), overrides = doc()) {
  const model = buildModel(plan, WORDS, {});
  return buildElements(plan, { words: WORDS, model, overrides, componentLabel: (c) => TEMPLATE.components[c]?.label });
}

describe('title markup', () => {
  it('counts words and lines the way the server does', () => {
    expect(markupStats('Có gì trong đầu|*nói luôn*')).toEqual({ words: 6, lines: 2 });
    expect(markupStats('*một*')).toEqual({ words: 1, lines: 1 });
  });

  it('labels the count against the prop limits', () => {
    expect(markupCheck('Có gì trong đầu|*nói luôn*', { minWords: 2, maxWords: 6, maxLines: 2 })).toMatchObject({ ok: true, label: '6 từ · 2 dòng · đạt' });
    expect(markupCheck('Có gì trong đầu là|nói|luôn', { minWords: 2, maxWords: 6, maxLines: 2 }))
      .toMatchObject({ ok: false, label: '7 từ · 3 dòng · nên 2–6 từ, tối đa 2 dòng' });
    expect(markupCheck('Một', { minWords: 2, maxWords: 6 }).ok).toBe(false);
  });

  it('writes times the Vietnamese way', () => {
    expect(clockVi(9.74)).toBe('00:09,7');
    expect(clockVi(71.25, true)).toBe('1:11,3');
  });
});

describe('elements', () => {
  it('lists plan v2 elements by kind and time with their place, skipping B-roll that is off', () => {
    const els = elementsOf();
    expect(els.map((e) => e.id)).toEqual(['b1', 'b2', 's1', 'br1', 'g1', 'z1']);
    expect(els.find((e) => e.id === 'b2')).toMatchObject({ kind: 'beat', n: 2, count: 2, at: 4, end: 6, label: 'Gửi cho ChatGPT' });
    expect(els.find((e) => e.id === 's1')!.label).toBe('Bước 3 · Nhờ ChatGPT edit');
    expect(els.find((e) => e.id === 'br1')).toMatchObject({ at: 7, end: 9, label: 'gõ laptop · Pexels' });
    expect(els.find((e) => e.id === 'g1')!.label).toBe('Logo cuối');
    expect(els.find((e) => e.id === 'z1')!.label).toBe('Zoom 7%');
  });

  it('shows the owner override over the plan', () => {
    const els = elementsOf(makePlan(), doc({ b1: { text: { title: 'Nói *ngay*' }, at: 1, hidden: true, updatedAt: 'x' } }));
    expect(els.find((e) => e.id === 'b1')).toMatchObject({ label: 'Nói ngay', at: 1, end: 3.4, hidden: true });
  });

  it('opens the tool on the element playing, else the next one', () => {
    const els = elementsOf();
    expect(elementForTool(els, 'beat', 4.5)!.id).toBe('b2');
    expect(elementForTool(els, 'beat', 3)!.id).toBe('b2');
    expect(elementForTool(els, 'beat', 9)!.id).toBe('b1');
    expect(elementForTool(els, 'scene', 0)!.id).toBe('s1');
  });

  it('lists the layers at the playhead, top first, without hidden ones', () => {
    const plan = makePlan();
    const model = buildModel(plan, WORDS, {});
    const caps = captionChunks(plan, WORDS, model, new Set());
    const els = buildElements(plan, { words: WORDS, model, overrides: doc({ g1: { hidden: true, updatedAt: 'x' } }) });
    expect(layersAt(7.5, els, caps, model).map((l) => `${l.kindLabel}:${l.label}`)).toEqual([
      'Minh hoạ:Bước 3 · Nhờ ChatGPT edit', 'Cảnh trám:gõ laptop · Pexels', 'Phụ đề:luôn gửi cho', 'Video:Đoạn nguồn 0:07,5',
    ]);
    expect(layersAt(9.5, els, caps, model).some((l) => l.id === 'g1')).toBe(false);
    expect(planSummary(model.total, els)).toBe('0:10,0 sau khi cắt · 2 nhịp chữ · 1 cảnh minh hoạ · 1 cảnh trám');
  });
});

describe('inspector fields', () => {
  it('generates the beat form from the component props; kicker/title/sub go to text', () => {
    const b1 = elementsOf().find((e) => e.id === 'b1')!;
    const fields = inspectorFields(b1, componentDef(TEMPLATE, b1));
    expect(fields.map((f) => [f.key, f.def.type, f.target, f.value])).toEqual([
      ['kicker', 'text', 'text', 'BƯỚC 1'], ['title', 'markup', 'text', 'Có gì trong đầu|*nói luôn*'], ['sub', 'text', 'text', 'không cần chuẩn bị'],
    ]);
    const title = fields[1];
    expect(fieldPatch(title, 'Nói *ngay*')).toEqual({ text: { title: 'Nói *ngay*' } });
    // Typing the AI's text back removes the key instead of keeping an override that changes nothing.
    expect(fieldPatch(title, 'Có gì trong đầu|*nói luôn*')).toEqual({ text: { title: null } });
  });

  it('scene and B-roll props go to override.props, read from the plan', () => {
    const els = elementsOf(makePlan(), doc({ s1: { props: { items: ['Quay', 'Gửi', 'Chờ'] }, updatedAt: 'x' } }));
    const s1 = els.find((e) => e.id === 's1')!;
    const fields = inspectorFields(s1, componentDef(TEMPLATE, s1));
    expect(fields.map((f) => [f.key, f.target, f.value])).toEqual([['step', 'props', 3], ['title', 'props', 'Nhờ *ChatGPT* edit'], ['items', 'props', ['Quay', 'Gửi', 'Chờ']]]);
    expect(fieldPatch(fields[2], ['Quay', 'Gửi'])).toEqual({ props: { items: null } });
    const br1 = els.find((e) => e.id === 'br1')!;
    expect(componentDef(TEMPLATE, br1)!.label).toBe('Khung cảnh trám');
    expect(inspectorFields(br1, componentDef(TEMPLATE, br1))[0]).toMatchObject({ key: 'layout', value: 'full' });
  });

  it('sound, size and the preset sound "Nghe thử" plays', () => {
    const b2 = elementsOf().find((e) => e.id === 'b2')!;
    expect(soundAssetId(b2, TEMPLATE)).toBe('sfx:pop');
    expect(soundPatch(b2, { mode: 'auto', volume: 1 })).toEqual({ sound: null });
    expect(soundPatch(b2, { mode: 'none', volume: 1 })).toEqual({ sound: { mode: 'none', volume: 1 } });
    expect(scalePatch(112)).toEqual({ s: 1.12 });
    expect(scalePatch(100)).toEqual({ s: null });
  });
});

describe('override patches', () => {
  it('merges debounced edits of one element into one patch', () => {
    expect(mergePatches({ text: { title: 'A' }, s: 1.1 }, { text: { sub: 'B' } })).toEqual({ text: { title: 'A', sub: 'B' }, s: 1.1 });
    expect(mergePatches({ text: { title: 'A' } }, { text: { title: 'AB' } })).toEqual({ text: { title: 'AB' } });
    expect(mergePatches({ props: { a: 1 } }, { props: null })).toEqual({ props: null });
  });

  it('applies a patch locally the way the server merges it', () => {
    const prev = { text: { title: 'A', sub: 'B' }, s: 1.1, updatedAt: 'old' };
    expect(applyElementPatch(prev, { text: { sub: null }, animIn: 'pop' }, 'now')).toEqual({ text: { title: 'A' }, s: 1.1, animIn: 'pop', updatedAt: 'now' });
    expect(applyElementPatch(prev, { text: null, s: null }, 'now')).toBeUndefined();
    expect(applyElementPatch(undefined, { hidden: false }, 'now')).toBeUndefined();
    const next = applyOverridesPatch(doc({ b1: prev }), { elements: { b1: null, b2: { assetId: 'x' } }, music: { assetId: 'bgm-2' } }, 'now');
    expect(next.elements).toEqual({ b2: { assetId: 'x', updatedAt: 'now' } });
    expect(next.music).toEqual({ assetId: 'bgm-2' });
    expect(applyOverridesPatch(next, { music: null }, 'later').music).toBeUndefined();
  });

  it('music: the owner choice over plan.music, its own pick again = back to the AI', () => {
    const plan = makePlan({ music: { assetId: 'bgm-1', mood: 'Tập trung', gainDb: 0, duck: true } });
    expect(musicState(plan, emptyOverrides())).toMatchObject({ assetId: 'bgm-1', duck: true, off: false, edited: false });
    expect(musicState(plan, doc({}, { music: { assetId: 'bgm-2', duck: false } }))).toMatchObject({ assetId: 'bgm-2', duck: false, edited: true });
    expect(musicState(plan, doc({}, { music: { off: true } })).off).toBe(true);
    expect(musicPickPatch(plan, 'bgm-2')).toEqual({ assetId: 'bgm-2', off: null });
    expect(musicPickPatch(plan, 'bgm-1')).toEqual({ assetId: null, off: null });
    expect(musicPickPatch(plan, null)).toEqual({ off: true });
  });
});

it('asks the AI with the element as context, through a review mark', () => {
  const b1 = elementsOf().find((e) => e.id === 'b1')!;
  expect(askMark(' ngắn hơn ', b1, 3)).toEqual({ start: 0.5, end: 2.9, kind: 'text', note: 'Chữ “Có gì trong đầu nói luôn” (b1, 00:00,5–00:02,9): ngắn hơn' });
  expect(askMark('bỏ đoạn này', null, 4.26)).toEqual({ start: 4.3, kind: 'other', note: 'bỏ đoạn này' });
});

it('builds the preview URL with the overrides stamp (one place for the cache parameter)', () => {
  expect(quickPreviewUrl('p 1', 3, null)).toBe('/api/m/video/edit/projects/p%201/composition/preview.html?v=3');
  expect(quickPreviewUrl('p1', 3, '2026-10-25T03:00:00.000Z')).toBe('/api/m/video/edit/projects/p1/composition/preview.html?v=3&o=2026-10-25T03%3A00%3A00.000Z');
});
