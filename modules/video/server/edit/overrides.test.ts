import { describe, expect, it } from 'vitest';
import { droppedElements, emptyOverrides, mergeOverrides } from './overrides.js';
import type { EditPlan, OverridesDoc, TextBeat } from './types.js';

const beat = (id: string, title = 'Hai từ', extra: Partial<TextBeat> = {}): TextBeat => ({ id, component: 'text-beat', at: 0, duration: 1, title, ...extra });
const plan = (version: number, beats: TextBeat[], extra: Partial<EditPlan> = {}) => ({ version, beats, brolls: [], zooms: [], ...extra }) as unknown as EditPlan;

describe('mergeOverrides', () => {
  it('merges one element at a time: keys not named stay, null removes, nested keys merge', () => {
    let doc = mergeOverrides(emptyOverrides('T0'), { elements: { b1: { t: [5, -3], text: { title: 'Mới' } } } }, 'T1');
    expect(doc).toEqual({ version: 1, elements: { b1: { t: [5, -3], text: { title: 'Mới' }, updatedAt: 'T1' } }, updatedAt: 'T1' });

    doc = mergeOverrides(doc, { elements: { b1: { s: 1.2, text: { sub: '' } }, s1: { props: { items: ['a', 'b'] }, hidden: true } } }, 'T2');
    expect(doc.elements.b1).toEqual({ t: [5, -3], s: 1.2, text: { title: 'Mới', sub: '' }, updatedAt: 'T2' });
    expect(doc.elements.s1).toEqual({ props: { items: ['a', 'b'] }, hidden: true, updatedAt: 'T2' });

    doc = mergeOverrides(doc, { elements: { b1: { text: { title: null }, at: 1.23456 } } }, 'T3');
    expect(doc.elements.b1).toEqual({ t: [5, -3], s: 1.2, text: { sub: '' }, at: 1.235, updatedAt: 'T3' });
    expect(doc.elements.s1.updatedAt).toBe('T2'); // untouched
  });

  it('drops no-op values and removes an entry that is back to nothing', () => {
    let doc = mergeOverrides(emptyOverrides('T0'), { elements: { b1: { t: [2, 2], s: 1.5 }, b2: { animIn: 'pop' } } }, 'T1');
    doc = mergeOverrides(doc, { elements: { b1: { t: [0, 0] } } }, 'T2');
    expect(doc.elements.b1).toEqual({ s: 1.5, updatedAt: 'T2' });
    doc = mergeOverrides(doc, { elements: { b1: { s: 1, hidden: false } } }, 'T3');
    expect(doc.elements.b1).toBeUndefined();
    doc = mergeOverrides(doc, { elements: { b2: null } }, 'T4');
    expect(doc.elements).toEqual({});
    expect(mergeOverrides(emptyOverrides(), { elements: { b9: { t: [0, 0], s: 1, text: {} } } }).elements).toEqual({});
  });

  it('keeps updatedAt of an element when the patch changes nothing', () => {
    const doc = mergeOverrides(emptyOverrides('T0'), { elements: { b1: { s: 1.2, props: { a: 'x' } } } }, 'T1');
    expect(mergeOverrides(doc, { elements: { b1: { s: 1.2, props: { a: 'x' } } } }, 'T2').elements.b1.updatedAt).toBe('T1');
  });

  it('merges caption style keys and takes them away with null', () => {
    let doc = mergeOverrides(emptyOverrides('T0'), { captions: { fill: '#fff', pos: 0.7 } }, 'T1');
    doc = mergeOverrides(doc, { captions: { highlight: { color: '#ff0', mode: 'box' }, pos: null } }, 'T2');
    expect(doc.captions).toEqual({ fill: '#fff', highlight: { color: '#ff0', mode: 'box' } });
    expect(mergeOverrides(doc, { elements: {} }).captions).toEqual(doc.captions);
    expect('captions' in mergeOverrides(doc, { captions: null })).toBe(false);
  });
});

describe('droppedElements', () => {
  const v1 = plan(1, [beat('b1', 'Một hai'), beat('b2')]);
  const v2 = plan(2, [beat('b1', 'Làm *ba bước*'), beat('b2'), beat('b7')], { scenes: [{ id: 's1', component: 'scene-steps', at: 0, duration: 1, props: { title: 'Các bước' } }] } as Partial<EditPlan>);
  const v3 = plan(3, [beat('b2')]);
  const plans = new Map([[1, v1], [2, v2], [3, v3]]);
  const doc: OverridesDoc = {
    version: 1,
    updatedAt: 'x',
    elements: {
      b1: { t: [1, 1], updatedAt: 'x' },
      b2: { s: 1.2, updatedAt: 'x' },
      s1: { props: { title: 'Khác' }, updatedAt: 'x' },
      b5: { t: [1, 1], updatedAt: 'x' },
      b7: { hidden: true, updatedAt: 'x' },
    },
  };

  it('lists AI elements with an override that the current plan lost, from the latest version that had them', () => {
    const out = droppedElements(doc, v3, [1, 2, 3], (v) => plans.get(v) ?? null);
    expect(out).toEqual([
      { id: 'b1', kind: 'beat', label: 'Làm ba bước', fromVersion: 2 },
      { id: 's1', kind: 'scene', label: 'scene-steps: Các bước', fromVersion: 2 },
    ]);
  });

  it('is empty without a plan or when nothing was lost', () => {
    expect(droppedElements(doc, null, [1, 2, 3], (v) => plans.get(v) ?? null)).toEqual([]);
    expect(droppedElements(doc, v2, [1, 2, 3], (v) => plans.get(v) ?? null)).toEqual([]);
  });
});
