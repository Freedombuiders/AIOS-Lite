import { describe, expect, it } from 'vitest';
import { applyPlanOps, PlanOpError, type PlanOpsOptions } from './plan-ops.js';
import { planMapper, validateAgentPlan } from './pipeline/plan.js';
import type { EditPlan, OverridesDoc, PlanOp, Transcript } from './types.js';

const T: Transcript = {
  language: 'vi', model: 't', durationSec: 6, createdAt: '2026-01-01T00:00:00.000Z',
  words: ([
    ['Xin', 0.2, 0.5], ['chào', 0.5, 0.8], ['ờ', 0.9, 1.2], ['các', 1.3, 1.5], ['bạn', 1.5, 1.8],
    ['hôm', 3.0, 3.2], ['nay', 3.2, 3.5], ['mình', 3.5, 3.8], ['nói', 3.8, 4.1],
  ] as [string, number, number][]).map(([text, start, end], i) => ({ i, text, start, end })),
};
const ctx = { transcript: T, analysis: null };

/** v2: agent plan — b1 anchored on "các", b2 at 1.5s, zoom z1, B-roll r1. */
function agentPlan(): EditPlan {
  const res = validateAgentPlan({
    templateId: 'th-vang', cutWords: [2],
    beats: [{ anchorWord: 3, duration: 1.2, title: 'Xin *chào* bạn' }, { at: 1.5, duration: 0.8, title: 'Hôm nay nói' }],
    zooms: [{ id: 'z1', at: 0.5, duration: 1, scale: 1.2 }],
    brolls: [{ id: 'r1', anchorWord: 5, duration: 1, title: 'Shop' }],
  }, ctx, { version: 2, aspect: '9:16' });
  expect(res.errors).toEqual([]);
  return res.plan!;
}

const opts = (over: Partial<PlanOpsOptions> = {}): PlanOpsOptions => ({ nextVersion: 3, loadPlan: () => null, planStatus: 'waiting_approval', now: 'NOW', ...over });
const run = (plan: EditPlan, ops: PlanOp[], over: Partial<PlanOpsOptions> = {}) => applyPlanOps(plan, ops, ctx, opts(over));
const fails = (fn: () => unknown, kind: PlanOpError['kind'], message?: RegExp) => {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(PlanOpError);
    expect((err as PlanOpError).kind).toBe(kind);
    if (message) expect((err as Error).message).toMatch(message);
    return;
  }
  throw new Error('expected a PlanOpError');
};
const overridesOf = (elements: OverridesDoc['elements']): OverridesDoc => ({ version: 1, elements, updatedAt: 'x' });
const beatOf = (plan: EditPlan, id: string) => plan.beats!.find((b) => b.id === id)!;

describe('applyPlanOps: add / remove', () => {
  it('adds an owner element with a machine id and an anchored time, as a new owner version', () => {
    const cur = agentPlan();
    const res = run(cur, [{ op: 'add', kind: 'beat', element: { id: 'mine', anchorWord: 7, duration: 1, title: 'Mình nói nhé', origin: 'ai' } }]);
    expect(res).toMatchObject({ changed: true, inPlace: false });
    expect(res.plan).toMatchObject({ version: 3, author: 'owner', createdAt: 'NOW' });
    const added = beatOf(res.plan, 'b3');
    expect(added).toMatchObject({ component: 'text-beat', origin: 'owner', anchorWord: 7 });
    expect(added.at).toBeCloseTo(planMapper(res.plan, ctx).map(T.words[7].start)!, 3);
    expect(res.plan.changes).toEqual(['Thêm chữ «Mình nói nhé»']);
    // the current plan is untouched
    expect(cur.beats).toHaveLength(2);
  });

  it('never reuses an id that still has an override, and adds zooms and B-roll', () => {
    const res = run(agentPlan(), [
      { op: 'add', kind: 'beat', element: { at: 0.2, duration: 0.5, title: 'Một hai' } },
      { op: 'add', kind: 'zoom', element: { at: 1, duration: 0.5, scale: 1.3 } },
      { op: 'add', kind: 'broll', element: { anchorWord: 7, duration: 1, title: 'Cận cảnh' } },
    ], { overrides: overridesOf({ b3: { t: [1, 1], updatedAt: 'x' } }) });
    expect(res.plan.beats!.map((b) => b.id)).toEqual(['b1', 'b2', 'b4']);
    expect(res.plan.zooms.map((z) => [z.id, z.origin])).toEqual([['z1', undefined], ['z2', 'owner']]);
    expect(res.plan.brolls.at(-1)).toMatchObject({ id: 'br1', origin: 'owner', layout: 'card', enabled: true });
  });

  it('refuses an element that breaks the plan rules', () => {
    fails(() => run(agentPlan(), [{ op: 'add', kind: 'beat', element: { anchorWord: 2, duration: 1, title: 'Ờ ờ' } }]), 'invalid', /từ đã cắt/);
    fails(() => run(agentPlan(), [{ op: 'add', kind: 'beat', element: { at: 0, duration: 1 } }]), 'invalid', /title/);
    fails(() => run(agentPlan(), [{ op: 'add', kind: 'scene', element: { at: 0, duration: 1, component: 'nope' } }], {
      templates: () => ({ components: {}, animations: [] }),
    }), 'invalid', /không có component "nope"/);
  });

  it('removes owner elements only, with their overrides', () => {
    const added = run(agentPlan(), [{ op: 'add', kind: 'beat', element: { at: 0.2, duration: 0.5, title: 'Một hai' } }]).plan;
    const res = run(added, [{ op: 'remove', id: 'b3' }], { overrides: overridesOf({ b3: { s: 1.2, updatedAt: 'x' }, b1: { s: 2, updatedAt: 'x' } }) });
    expect(res.plan.beats!.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(res.plan.changes).toEqual(['Xoá chữ «Một hai»']);
    expect(Object.keys(res.overrides!.elements)).toEqual(['b1']);
    fails(() => run(agentPlan(), [{ op: 'remove', id: 'b1' }]), 'invalid', /AI dựng/);
    fails(() => run(agentPlan(), [{ op: 'remove', id: 'zzz' }]), 'conflict');
  });
});

describe('applyPlanOps: split', () => {
  it('splits a timed element; the right half is <id>-b and snaps to the next word', () => {
    const cur = agentPlan();
    const b1 = beatOf(cur, 'b1');
    const { map } = planMapper(cur, ctx);
    const res = run(cur, [{ op: 'split', id: 'b1', at: b1.at + 0.15 }]);
    const left = beatOf(res.plan, 'b1');
    const right = beatOf(res.plan, 'b1-b');
    expect(res.plan.beats!.map((b) => b.id)).toEqual(['b1', 'b1-b', 'b2']);
    // "bạn" (word 4) starts 0.2s after "các": the right half anchors there
    expect(right).toMatchObject({ anchorWord: 4, origin: 'owner', title: b1.title });
    expect(right.at).toBeCloseTo(map(T.words[4].start)!, 3);
    expect(left).toMatchObject({ anchorWord: 3, origin: 'owner' });
    expect(left.duration).toBeCloseTo(right.at - b1.at, 3);
    expect(right.at + right.duration).toBeCloseTo(b1.at + b1.duration, 3);
    expect(res.plan.changes![0]).toMatch(/^Tách chữ «Xin chào bạn» tại /);

    const again = run(res.plan, [{ op: 'split', id: 'b1', at: left.at + 0.1 }], { nextVersion: 4 });
    expect(again.plan.beats!.map((b) => b.id)).toContain('b1-b-2');
  });

  it('splits an unanchored element at the exact moment', () => {
    const res = run(agentPlan(), [{ op: 'split', id: 'b2', at: 1.9 }, { op: 'split', id: 'z1', at: 1 }]);
    expect(res.plan.beats!.filter((b) => b.id.startsWith('b2')).map((b) => [b.id, b.at, b.duration])).toEqual([['b2', 1.5, 0.4], ['b2-b', 1.9, 0.4]]);
    expect(res.plan.zooms.map((z) => [z.id, z.at, z.duration])).toEqual([['z1', 0.5, 0.5], ['z1-b', 1, 0.5]]);
  });

  it('uses the times the owner set by hand and shares the rest of the override', () => {
    const overrides = overridesOf({ b1: { at: 0.3, duration: 1, t: [4, 0], updatedAt: 'x' } });
    const res = run(agentPlan(), [{ op: 'split', id: 'b1', at: 0.8 }], { overrides });
    expect(beatOf(res.plan, 'b1')).toMatchObject({ at: 0.3, duration: 0.5 });
    expect(beatOf(res.plan, 'b1-b')).toMatchObject({ at: 0.8, duration: 0.5 });
    expect('anchorWord' in beatOf(res.plan, 'b1')).toBe(false);
    expect(res.overrides!.elements).toEqual({ b1: { t: [4, 0], updatedAt: 'NOW' }, 'b1-b': { t: [4, 0], updatedAt: 'NOW' } });
  });

  it('refuses a split outside the element, of a B-roll, or of a missing element', () => {
    fails(() => run(agentPlan(), [{ op: 'split', id: 'b2', at: 1.55 }]), 'invalid', /cách hai đầu/);
    fails(() => run(agentPlan(), [{ op: 'split', id: 'b2', at: 5 }]), 'invalid');
    fails(() => run(agentPlan(), [{ op: 'split', id: 'r1', at: 1 }]), 'invalid', /B-roll/);
    fails(() => run(agentPlan(), [{ op: 'split', id: 'gone', at: 1 }]), 'conflict');
  });
});

describe('applyPlanOps: toggleWords / restore', () => {
  it('toggles cut words like PATCH and re-times anchored elements', () => {
    const cur = agentPlan();
    const res = run(cur, [{ op: 'toggleWords', words: [2, 0, 999] }]);
    expect(res.plan.cutWords).toEqual([0]);
    expect(res.plan.changes).toEqual(expect.arrayContaining(['Bỏ 1 từ: «Xin»', 'Giữ lại 1 từ: «ờ»']));
    expect(beatOf(res.plan, 'b1').at).not.toBe(beatOf(cur, 'b1').at);
  });

  it('restores an element from an earlier version as the owner’s', () => {
    const v2 = agentPlan();
    const v3: EditPlan = { ...v2, version: 3, beats: v2.beats!.filter((b) => b.id !== 'b1') };
    const loadPlan = (v: number) => (v === 2 ? v2 : null);
    const res = run(v3, [{ op: 'restore', id: 'b1', fromVersion: 2 }], { loadPlan, nextVersion: 4 });
    expect(beatOf(res.plan, 'b1')).toMatchObject({ origin: 'owner', title: 'Xin *chào* bạn', anchorWord: 3 });
    expect(res.plan.changes).toEqual(['Khôi phục chữ «Xin chào bạn» từ bản 2']);
    // already back: nothing to do
    expect(run(res.plan, [{ op: 'restore', id: 'b1', fromVersion: 2 }], { loadPlan }).changed).toBe(false);
    fails(() => run(v3, [{ op: 'restore', id: 'b1', fromVersion: 9 }], { loadPlan }), 'conflict', /phiên bản 9/);
    fails(() => run(v3, [{ op: 'restore', id: 'b8', fromVersion: 2 }], { loadPlan }), 'conflict', /không có phần tử "b8"/);
  });
});

describe('applyPlanOps: working draft', () => {
  it('edits an owner draft in place (rev), with one change list for the whole draft', () => {
    const first = run(agentPlan(), [{ op: 'toggleWords', words: [8] }]).plan;
    expect(first).toMatchObject({ version: 3, author: 'owner' });
    expect(first.rev).toBeUndefined();
    const second = run(first, [{ op: 'toggleWords', words: [7] }], { planStatus: 'draft', nextVersion: 4 });
    expect(second.inPlace).toBe(true);
    expect(second.plan).toMatchObject({ version: 3, rev: 1, author: 'owner' });
    const third = run(second.plan, [{ op: 'add', kind: 'beat', element: { at: 0.2, duration: 0.4, title: 'Thêm nữa' } }], { planStatus: 'draft', nextVersion: 4 });
    expect(third.plan).toMatchObject({ version: 3, rev: 2 });
    const changes = third.plan.changes!;
    expect(changes.filter((c) => c.startsWith('Thời lượng'))).toHaveLength(1);
    expect(changes).toEqual(expect.arrayContaining(['Bỏ 1 từ: «nói»', 'Bỏ 1 từ: «mình»', 'Thêm chữ «Thêm nữa»']));
    expect(changes.at(-1)).toMatch(new RegExp(`^Thời lượng ${Math.round(agentPlan().outputDurationSec * 10) / 10}s → `));
  });

  it('starts a new version over an agent plan or an approved owner plan', () => {
    const owner = run(agentPlan(), [{ op: 'toggleWords', words: [8] }]).plan;
    const res = run(owner, [{ op: 'toggleWords', words: [7] }], { planStatus: 'approved', nextVersion: 4 });
    expect(res).toMatchObject({ inPlace: false, plan: { version: 4, author: 'owner' } });
    expect(res.plan.changes).not.toContain('Bỏ 1 từ: «nói»');
  });

  it('needs at least one op and reports no change for a no-op', () => {
    fails(() => run(agentPlan(), []), 'invalid');
    const res = run(agentPlan(), [{ op: 'toggleWords', words: [999] }]);
    expect(res.changed).toBe(false);
    expect(res.plan.changes).toEqual(['Không có thay đổi']);
  });
});
