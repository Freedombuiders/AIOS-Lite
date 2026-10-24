import { _initTestDatabase } from './test-db.js';
import { describe, expect, it } from 'vitest';

import { addDays, type DayStats } from './metrics.js';
import {
  ACTION_ORDER,
  estimateImpact,
  evaluateAccount,
  evaluateObject,
  reconcile,
  THRESHOLDS,
  type Evaluation,
  type ExistingRec,
  type RuleContext,
  type RuleObject,
} from './rules.js';

const TODAY = '2026-10-07';
const NOW = Date.UTC(2026, 9, 7, 5, 0) / 1000;
const TARGET = 120_000;

function ctx(over: Partial<RuleContext> = {}): RuleContext {
  return { today: TODAY, targetCpa: TARGET, resultType: 'lead', currency: 'VND', nowSec: NOW, ...over };
}

function day(offset: number, p: Partial<DayStats> = {}): DayStats {
  return {
    day: addDays(TODAY, offset), spend: 0, impressions: 0, reach: null, frequency: null, clicks: 0,
    linkClicks: 0, lpViews: 0, results: 0, purchases: 0, revenue: 0, video3s: 0, thruplays: 0, ...p,
  };
}

/** Seven days (offsets -6..0) that add up to the given totals; results rounded down per day, remainder on today. */
function week(spend: number, results: number, per: Partial<DayStats> = {}): DayStats[] {
  const perResults = Math.floor(results / 7);
  return [-6, -5, -4, -3, -2, -1, 0].map((o) => day(o, {
    spend: spend / 7,
    results: o === 0 ? results - perResults * 6 : perResults,
    impressions: 10000,
    linkClicks: 150,
    ...per,
  }));
}

function obj(over: Partial<RuleObject> = {}): RuleObject {
  return {
    level: 'adset', id: 'a1', name: 'Nhóm A', parentId: 'c1', status: 'ACTIVE', learning: 'SUCCESS',
    dailyBudget: null, days: week(1_000_000, 10), windowFrequency: null, ...over,
  };
}

describe('R1: spent without any result', () => {
  it('turns a 9x spend with zero leads into off_now with the numbers', () => {
    const e = evaluateObject(obj({ days: week(1_100_000, 0), learning: '' }), ctx());
    expect(e.action).toBe('off_now');
    expect(e.rule).toBe('R1');
    expect(e.actionable).toBe(true);
    expect(e.reason).toContain('Chi 1,1 tr (9,17× CPL mục tiêu)');
    expect(e.reason).toContain('chưa có lead nào');
  });

  it('waits below 2x the target', () => {
    const e = evaluateObject(obj({ days: week(230_000, 0) }), ctx());
    expect(e.action).toBe('watch');
    expect(e.actionable).toBe(false);
  });

  it('applies even while learning', () => {
    const e = evaluateObject(obj({ days: week(500_000, 0), learning: 'LEARNING' }), ctx());
    expect(e.rule).toBe('R1');
  });

  it('mentions a weak hook for video', () => {
    const days = week(1_100_000, 0, { impressions: 10000, video3s: 1400 });
    expect(evaluateObject(obj({ days }), ctx()).reason).toContain('Hook 14%');
  });
});

describe('R5: learning', () => {
  it('leaves an object in Meta learning alone even when the CPA is bad', () => {
    const e = evaluateObject(obj({ days: week(4_300_000, 22), learning: 'LEARNING' }), ctx());
    expect(e.action).toBe('keep');
    expect(e.rule).toBe('R5');
    expect(e.actionable).toBe(false);
    expect(e.reason).toContain('22/50 lead');
  });

  it('treats a young object with unknown learning state as learning, an old one as judged', () => {
    const young = [-1, 0].map((o) => day(o, { spend: 2_150_000, results: 11, impressions: 10000, linkClicks: 100 }));
    expect(evaluateObject(obj({ days: young, learning: '' }), ctx()).rule).toBe('R5');
    expect(evaluateObject(obj({ days: week(4_300_000, 22), learning: '' }), ctx()).rule).toBe('R2');
  });

  it('LEARNING_LIMITED counts as out of learning', () => {
    expect(evaluateObject(obj({ days: week(4_300_000, 22), learning: 'LEARNING_LIMITED' }), ctx()).rule).toBe('R2');
  });
});

describe('R2: too expensive after enough spend', () => {
  it('cuts when spend >= 3x target and CPA > 1.5x target, with CTR and frequency in the reason', () => {
    const days = week(4_300_000, 22, { impressions: 10000, linkClicks: 80 });
    const e = evaluateObject(obj({ days, windowFrequency: 3.1 }), ctx());
    expect(e.action).toBe('off');
    expect(e.rule).toBe('R2');
    expect(e.actionable).toBe(true);
    expect(e.reason).toContain('CPL 195k = 1,63× mục tiêu sau 4,3 tr chi (≥ 3× CPL mục tiêu)');
    expect(e.reason).toContain('CTR 0,8% thấp');
    expect(e.reason).toContain('tần suất 3,1');
  });

  it('does not cut before 3x target has been spent', () => {
    // CPA 300k = 2.5x target but only 300k spent (< 360k).
    const e = evaluateObject(obj({ days: week(300_000, 1) }), ctx());
    expect(e.action).toBe('watch');
  });

  it('does not cut a CPA at or under 1.5x target', () => {
    const e = evaluateObject(obj({ days: week(2_500_000, 14) }), ctx()); // CPA 178k = 1.49x
    expect(e.action).toBe('watch');
    expect(e.reason).toContain('1,49× mục tiêu');
  });
});

describe('R3: tired creative or audience', () => {
  const tired = (frequency: number, firstCtr: number, lastCtr: number): RuleObject => {
    const days = [-8, -7, -6, -5, -4, -3, -2, -1, 0].map((o, i) => {
      const ctr = i < 3 ? firstCtr : i >= 6 ? lastCtr : (firstCtr + lastCtr) / 2;
      return day(o, { spend: 600_000, results: 6, impressions: 10000, linkClicks: Math.round(100 * ctr) });
    });
    return obj({ days, windowFrequency: frequency });
  };

  it('asks for a refresh, not a cut, while the CPA is fine', () => {
    const e = evaluateObject(tired(3.4, 2.4, 1.6), ctx());
    expect(e.action).toBe('refresh');
    expect(e.rule).toBe('R3');
    expect(e.actionable).toBe(true);
    expect(e.reason).toContain('Tần suất 3,4; CTR giảm 33% so với 3 ngày đầu');
    expect(e.reason).toContain('CPL 100k vẫn trong mục tiêu nên đừng tắt');
  });

  it('needs frequency strictly above 3', () => {
    expect(evaluateObject(tired(3, 2.4, 1.6), ctx()).action).not.toBe('refresh');
  });

  it('needs a CTR drop of more than 30%', () => {
    expect(evaluateObject(tired(3.4, 2.4, 1.8), ctx()).action).not.toBe('refresh'); // -25%
  });

  it('falls back to the weighted daily frequency when Meta gave none', () => {
    const o = tired(0, 2.4, 1.6);
    o.windowFrequency = null;
    o.days = o.days.map((d) => ({ ...d, frequency: 3.5 }));
    expect(evaluateObject(o, ctx()).action).toBe('refresh');
  });

  it('is beaten by R2 when the CPA is also bad', () => {
    const o = tired(3.4, 2.4, 1.6);
    o.days = o.days.map((d) => ({ ...d, results: 2 })); // CPA 300k
    expect(evaluateObject(o, ctx()).rule).toBe('R2');
  });
});

describe('R4: scale a proven winner', () => {
  const winner = (over: Partial<RuleObject> = {}): RuleObject =>
    obj({ dailyBudget: 1_800_000, days: week(12_040_000, 140), ...over });

  it('recommends +20% with the new budget in the reason', () => {
    const e = evaluateObject(winner(), ctx());
    expect(e.action).toBe('up');
    expect(e.rule).toBe('R4');
    expect(e.actionable).toBe(true);
    expect(e.reason).toContain('CPL 86k = 0,72× mục tiêu 3 ngày liền, 140 lead/tuần');
    expect(e.reason).toContain('Tăng ngân sách từ 1,8 tr lên 2,16 tr/ngày');
  });

  it('needs 50 results in the week', () => {
    expect(evaluateObject(winner({ days: week(3_440_000, 40) }), ctx()).action).not.toBe('up');
  });

  it('needs every one of the last 3 full days under 0.8x target', () => {
    const o = winner();
    const yesterday = o.days.find((d) => d.day === addDays(TODAY, -1))!;
    yesterday.spend = yesterday.results * 100_000; // 100k = 0.83x
    expect(evaluateObject(o, ctx()).action).not.toBe('up');
  });

  it('is not recommended again within 3 days of the owner applying it', () => {
    const recent = evaluateObject(winner(), ctx({ lastUpAt: () => NOW - 2 * 86400 }));
    expect(recent.action).not.toBe('up');
    const old = evaluateObject(winner(), ctx({ lastUpAt: () => NOW - 3 * 86400 }));
    expect(old.action).toBe('up');
  });

  it('needs a known daily budget and is never for a single ad', () => {
    expect(evaluateObject(winner({ dailyBudget: null }), ctx()).action).not.toBe('up');
    expect(evaluateObject(winner({ level: 'ad' }), ctx()).action).not.toBe('up');
  });

  it('is not for an ad set still learning', () => {
    expect(evaluateObject(winner({ learning: 'LEARNING' }), ctx()).rule).toBe('R5');
  });

  it('works on a campaign that holds the budget (CBO)', () => {
    expect(evaluateObject(winner({ level: 'campaign', parentId: '' }), ctx()).action).toBe('up');
  });
});

describe('no recommendation', () => {
  it('says why an expensive-but-improving object is only watched', () => {
    const cpaPerDay = [1_600_000, 1_600_000, 1_600_000, 1_680_000, 1_500_000, 1_390_000, 1_400_000];
    const days = [-6, -5, -4, -3, -2, -1, 0].map((o, i) => day(o, { spend: cpaPerDay[i]!, results: 10, impressions: 10000, linkClicks: 150 }));
    const e = evaluateObject(obj({ days }), ctx());
    expect(e.action).toBe('watch');
    expect(e.actionable).toBe(false);
    expect(e.reason).toContain('nhưng giảm 3 ngày liền (168k → 139k)');
  });

  it('keeps a CPA within target', () => {
    const e = evaluateObject(obj({ days: week(1_000_000, 10) }), ctx());
    expect(e.action).toBe('keep');
    expect(e.rule).toBe('OK');
    expect(e.reason).toContain('CPL 100k = 0,83× mục tiêu');
  });

  it('does nothing for paused objects', () => {
    for (const status of ['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED', 'DELETED']) {
      const e = evaluateObject(obj({ status, days: week(1_100_000, 0) }), ctx());
      expect(e.actionable).toBe(false);
      expect(e.rule).toBe('OFF');
    }
  });

  it('trusts recent delivery when the status is unknown', () => {
    const stopped = [-6, -5, -4].map((o) => day(o, { spend: 400_000 }));
    expect(evaluateObject(obj({ status: '', days: stopped }), ctx()).rule).toBe('OFF');
    expect(evaluateObject(obj({ status: '', days: week(1_100_000, 0) }), ctx()).rule).toBe('R1');
  });

  it('needs a target CPA', () => {
    const e = evaluateObject(obj({ days: week(1_100_000, 0) }), ctx({ targetCpa: null }));
    expect(e.rule).toBe('NO_TARGET');
    expect(e.actionable).toBe(false);
    expect(e.reason).toContain('CPL mục tiêu');
  });

  it('uses CPA wording of the result type', () => {
    const e = evaluateObject(obj({ days: week(1_100_000, 0) }), ctx({ resultType: 'purchase' }));
    expect(e.reason).toContain('CPA mục tiêu');
    expect(e.reason).toContain('chưa có đơn nào');
  });
});

describe('account level: suppression and clone', () => {
  const ad = (id: string, spend: number, results: number, over: Partial<RuleObject> = {}): RuleObject =>
    obj({ level: 'ad', id, name: `Ad ${id}`, parentId: 'a1', days: week(spend, results), ...over });

  it('lists only the topmost object when a campaign is already recommended off', () => {
    const objects: RuleObject[] = [
      obj({ level: 'campaign', id: 'c1', parentId: '', days: week(3_000_000, 0) }),
      obj({ level: 'adset', id: 'a1', parentId: 'c1', days: week(3_000_000, 0) }),
      obj({ level: 'ad', id: 'd1', parentId: 'a1', days: week(3_000_000, 0) }),
    ];
    const byId = new Map(evaluateAccount(objects, ctx()).map((e) => [e.objectId, e]));
    expect(byId.get('c1')).toMatchObject({ actionable: true, action: 'off_now', suppressedBy: null });
    expect(byId.get('a1')).toMatchObject({ actionable: false, action: 'off_now', suppressedBy: 'c1' });
    expect(byId.get('d1')).toMatchObject({ actionable: false, suppressedBy: 'a1' });
  });

  it('does not suppress siblings of a cut ad set', () => {
    const objects: RuleObject[] = [
      obj({ level: 'campaign', id: 'c1', parentId: '', days: week(5_000_000, 40) }),
      obj({ level: 'adset', id: 'a1', parentId: 'c1', days: week(3_000_000, 0) }),
      obj({ level: 'adset', id: 'a2', parentId: 'c1', days: week(2_000_000, 40) }),
    ];
    const byId = new Map(evaluateAccount(objects, ctx()).map((e) => [e.objectId, e]));
    expect(byId.get('a1')?.actionable).toBe(true);
    expect(byId.get('a2')?.actionable).toBe(false);
    expect(byId.get('a2')?.suppressedBy).toBeNull();
  });

  it('picks the lowest-CPA ad with enough results as the one to clone', () => {
    const objects = [
      ad('A', 5_372_000, 68),            // CPL 79k, the winner
      ad('B', 3_680_000, 40),            // CPL 92k
      ad('C', 250_000, 5),               // CPL 50k but only 5 results
      ad('D', 4_300_000, 22),            // CPL 195k: recommended off
    ];
    const evals = evaluateAccount(objects, ctx());
    const clones = evals.filter((e) => e.action === 'clone');
    expect(clones).toHaveLength(1);
    expect(clones[0]).toMatchObject({ objectId: 'A', rule: 'CLONE', actionable: true });
    expect(clones[0]!.reason).toContain('CPL 79k = 0,66× mục tiêu, thấp nhất tài khoản với 68 lead/7 ngày');
    expect(evals.find((e) => e.objectId === 'D')?.action).toBe('off');
  });

  it('never clones an ad that is not under the target', () => {
    const evals = evaluateAccount([ad('A', 1_500_000, 10)], ctx()); // CPL 150k
    expect(evals.some((e) => e.action === 'clone')).toBe(false);
  });

  it('without a target compares against 85% of the account average', () => {
    const objects = [ad('A', 1_000_000, 20), ad('B', 3_000_000, 20)]; // 50k vs 150k, average 100k
    const evals = evaluateAccount(objects, ctx({ targetCpa: null }));
    expect(evals.find((e) => e.action === 'clone')?.objectId).toBe('A');
  });

  it('puts the hook rate in the clone reason for video', () => {
    const o = ad('A', 5_372_000, 68);
    o.days = o.days.map((d) => ({ ...d, impressions: 10000, video3s: 3800 }));
    const clone = evaluateAccount([o], ctx()).find((e) => e.action === 'clone');
    expect(clone?.reason).toContain('Hook 38%');
  });
});

describe('reconcile', () => {
  const ev = (over: Partial<Evaluation> = {}): Evaluation => ({
    level: 'adset', objectId: 'a1', objectName: 'Nhóm A', parentId: 'c1', action: 'off', rule: 'R2', reason: 'r',
    actionable: true, suppressedBy: null,
    metrics: { spend7: 1, results7: 0, cpa7: null, ratio: null, ctr7: null, frequency: null, ctrChangePct: null, hookRate: null, spendPerDay: 0, resultsPerDay: 0, dailyBudget: null, activeDays: 7 },
    ...over,
  });
  const rec = (over: Partial<ExistingRec> = {}): ExistingRec => ({
    id: 1, level: 'adset', objectId: 'a1', action: 'off', state: 'open', snoozedUntil: null, createdAt: NOW - 3600, updatedAt: NOW - 3600, ...over,
  });

  it('creates one recommendation for a new finding', () => {
    expect(reconcile([], [ev()], NOW)).toEqual([{ type: 'create', ev: ev() }]);
  });

  it('refreshes the open one in place instead of creating a second', () => {
    const ops = reconcile([rec()], [ev({ action: 'off_now', rule: 'R1' })], NOW);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'refresh', id: 1 });
  });

  it('expires open and snoozed recommendations that no longer fire', () => {
    const ops = reconcile([rec(), rec({ id: 2, objectId: 'a2', state: 'snoozed', snoozedUntil: NOW + 100 }), rec({ id: 3, objectId: 'a3', state: 'done' })], [], NOW);
    expect(ops).toEqual([{ type: 'expire', id: 1 }, { type: 'expire', id: 2 }]);
  });

  it('leaves a snoozed one alone until the snooze ends, then reopens it', () => {
    const snoozed = rec({ state: 'snoozed', snoozedUntil: NOW + 3600 });
    expect(reconcile([snoozed], [ev()], NOW)).toEqual([]);
    const ops = reconcile([{ ...snoozed, snoozedUntil: NOW - 1 }], [ev()], NOW);
    expect(ops).toEqual([{ type: 'reopen', id: 1, ev: ev() }]);
  });

  it('does not repeat something the owner marked done within 24 hours', () => {
    const done = rec({ state: 'done', updatedAt: NOW - 3600 });
    expect(reconcile([done], [ev()], NOW)).toEqual([]);
    const older = rec({ state: 'done', updatedAt: NOW - THRESHOLDS.doneCooldownSec - 1 });
    expect(reconcile([older], [ev()], NOW)).toHaveLength(1);
  });

  it('keeps a done "up" quiet for 3 days', () => {
    const done = rec({ action: 'up', state: 'done', updatedAt: NOW - 2 * 86400 });
    expect(reconcile([done], [ev({ action: 'up', rule: 'R4' })], NOW)).toEqual([]);
  });

  it('collapses duplicate open rows to the newest', () => {
    const ops = reconcile([rec({ id: 1 }), rec({ id: 2 })], [ev()], NOW);
    expect(ops).toContainEqual({ type: 'expire', id: 1 });
    expect(ops).toContainEqual({ type: 'refresh', id: 2, ev: ev() });
  });
});

describe('estimateImpact', () => {
  it('adds up daily savings and the extra results that money would buy', () => {
    const impact = estimateImpact([
      { action: 'off_now', metrics: { spendPerDay: 157_000, resultsPerDay: 0 } },
      { action: 'off', metrics: { spendPerDay: 614_000, resultsPerDay: 3 } },
      { action: 'up', metrics: { dailyBudget: 1_800_000, cpa7: 86_000 } },
      { action: 'refresh', metrics: { spendPerDay: 700_000 } },
    ], TARGET);
    expect(impact.savingsPerDay).toBeCloseTo(771_000, 0);
    // 157k/120k + (614k/120k - 3) + 0.2*1.8M/86k
    expect(impact.extraResultsPerDay).toBeCloseTo(157_000 / 120_000 + (614_000 / 120_000 - 3) + 360_000 / 86_000, 5);
  });

  it('is null with an empty queue, nothing priceable or no target', () => {
    expect(estimateImpact([], TARGET)).toEqual({ savingsPerDay: null, extraResultsPerDay: null });
    expect(estimateImpact([{ action: 'refresh', metrics: {} }], TARGET)).toEqual({ savingsPerDay: null, extraResultsPerDay: null });
    expect(estimateImpact([{ action: 'off', metrics: { spendPerDay: 1 } }], null)).toEqual({ savingsPerDay: null, extraResultsPerDay: null });
  });

  it('orders the queue by severity', () => {
    const order = Object.entries(ACTION_ORDER).sort((a, b) => a[1] - b[1]).map(([k]) => k);
    expect(order.slice(0, 4)).toEqual(['off_now', 'off', 'down', 'up']);
  });
});
