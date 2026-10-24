import { describe, expect, it } from 'vitest';

import {
  dailyBudget,
  estimateBroadcastCost,
  evaluateBroadcastPlan,
  maxGroupsWithinBudget,
  type BroadcastPlanInput,
} from './broadcast-cost.js';

function plan(over: Partial<BroadcastPlanInput> = {}) {
  return evaluateBroadcastPlan({
    groupCount: 10,
    hasText: true,
    attachments: [],
    timesPerDay: 1,
    timesOfDay: ['08:00'],
    minDelaySec: 20,
    maxDelaySec: 40,
    dailyCap: 200,
    bulkSharePercent: 60,
    ...over,
  });
}

describe('estimateBroadcastCost', () => {
  it('counts text, one album for all images, and each file/video', () => {
    const cost = estimateBroadcastCost({
      groupCount: 4,
      hasText: true,
      attachments: [{ kind: 'image' }, { kind: 'image' }, { kind: 'file' }, { kind: 'video' }],
      timesPerDay: 2,
      minDelaySec: 20,
      maxDelaySec: 40,
    });
    expect(cost.opsPerGroup).toBe(4); // text + album + file + video
    expect(cost.opsPerRun).toBe(16);
    expect(cost.opsPerDay).toBe(32);
  });

  it('skips the text op for an attachment-only template', () => {
    const cost = estimateBroadcastCost({
      groupCount: 1, hasText: false, attachments: [{ kind: 'image' }],
      timesPerDay: 1, minDelaySec: 20, maxDelaySec: 20,
    });
    expect(cost.opsPerGroup).toBe(1);
  });

  it('estimates duration as (n-1) average gaps plus 1.65 s per op', () => {
    const cost = estimateBroadcastCost({
      groupCount: 3, hasText: true, attachments: [], timesPerDay: 1, minDelaySec: 20, maxDelaySec: 40,
    });
    // 2 gaps * 30 s + 3 ops * 1.65 s = 64.95
    expect(cost.runDurationSec).toBe(65);
  });

  it('treats timesPerDay below 1 as 1 and a single group as no gap', () => {
    const cost = estimateBroadcastCost({
      groupCount: 1, hasText: true, attachments: [], timesPerDay: 0, minDelaySec: 100, maxDelaySec: 100,
    });
    expect(cost.opsPerDay).toBe(1);
    expect(cost.runDurationSec).toBe(2);
  });
});

describe('budget', () => {
  it('floors the bulk share of the effective cap', () => {
    expect(dailyBudget(200, 60)).toBe(120);
    expect(dailyBudget(155, 60)).toBe(93);
    expect(dailyBudget(0, 60)).toBe(0);
  });

  it('suggests how many groups still fit', () => {
    expect(maxGroupsWithinBudget(120, 2, 3)).toBe(20);
    expect(maxGroupsWithinBudget(120, 0, 1)).toBe(0);
  });
});

describe('evaluateBroadcastPlan', () => {
  it('passes a campaign inside the budget', () => {
    const p = plan();
    expect(p.errors).toEqual([]);
    expect(p.budget).toBe(120);
  });

  it('blocks with DAILY_BUDGET_EXCEEDED past the share of the cap', () => {
    const p = plan({ groupCount: 50, timesPerDay: 3, timesOfDay: ['08:00', '14:00', '20:00'] });
    expect(p.cost.opsPerDay).toBe(150);
    expect(p.errors.map((e) => e.code)).toContain('DAILY_BUDGET_EXCEEDED');
  });

  it('allows exactly the budget', () => {
    expect(plan({ groupCount: 120 }).errors.map((e) => e.code)).not.toContain('DAILY_BUDGET_EXCEEDED');
    expect(plan({ groupCount: 121 }).errors.map((e) => e.code)).toContain('DAILY_BUDGET_EXCEEDED');
  });

  it('uses the smaller (warm-up) cap it is given', () => {
    const p = plan({ groupCount: 20, dailyCap: 20 }); // budget 12
    expect(p.budget).toBe(12);
    expect(p.errors.map((e) => e.code)).toContain('DAILY_BUDGET_EXCEEDED');
  });

  it('enforces the hard caps on groups and times per day', () => {
    expect(plan({ groupCount: 51, dailyCap: 5000 }).errors.map((e) => e.code)).toContain('TOO_MANY_GROUPS');
    expect(plan({ timesPerDay: 13, dailyCap: 5000 }).errors.map((e) => e.code)).toContain('TOO_MANY_TIMES');
  });

  it('rejects an empty template', () => {
    expect(plan({ hasText: false, attachments: [] }).errors.map((e) => e.code)).toContain('TEMPLATE_EMPTY');
  });

  it('warns (not errors) when two send times are closer than one run', () => {
    // 40 groups * 30 s gap = ~20 min; times 10 minutes apart.
    const p = plan({ groupCount: 40, dailyCap: 5000, timesPerDay: 2, timesOfDay: ['08:00', '08:10'] });
    expect(p.errors).toEqual([]);
    expect(p.warnings.map((w) => w.code)).toEqual(['SCHEDULE_TOO_TIGHT']);
    expect(p.minGapMinutes).toBe(10);
  });

  it('warns about a too-tight wrap across midnight', () => {
    const p = plan({ groupCount: 40, dailyCap: 5000, timesPerDay: 2, timesOfDay: ['23:55', '00:05'] });
    expect(p.warnings.map((w) => w.code)).toContain('SCHEDULE_TOO_TIGHT');
  });

  it('has no gap warning for a single time', () => {
    const p = plan({ groupCount: 40, dailyCap: 5000 });
    expect(p.warnings).toEqual([]);
    expect(p.minGapMinutes).toBeNull();
  });
});
