import { _initTestDatabase } from './test-db.js';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  getFbAdAccount,
  replaceFbAdsPlacements,
  updateFbAdAccountSettings,
  updateFbAdsRecommendation,
  upsertFbAdAccount,
  upsertFbAdsDaily,
  type FbAdsDailyInput,
} from './store.js';
import { loadAdsDashboard } from './dashboard.js';
import { runEvaluation } from './evaluate.js';
import { addDays } from './metrics.js';

const NOW = Date.UTC(2026, 9, 7, 5, 0) / 1000; // 12:00 on 2026-10-07 in Ho Chi Minh
const TODAY = '2026-10-07';
const ACCOUNT = 'act_1';
let organic: import('./store.js').FbAdsOrganicRow[] = [];

function row(level: string, id: string, parent: string, name: string, offset: number, p: Partial<FbAdsDailyInput> = {}): FbAdsDailyInput {
  return {
    account_id: ACCOUNT, level, object_id: id, parent_id: parent, day: addDays(TODAY, offset), name, status: 'ACTIVE',
    daily_budget: null, spend: 0, impressions: 10000, reach: null, frequency: null, clicks: 0, link_clicks: 150,
    lp_views: 0, results: 0, result_value: 0, purchases: 0, video_3s: 0, thruplays: 0, creative_json: '{}',
    learning: 'SUCCESS', raw_json: '{}', captured_at: NOW, ...p,
  };
}

/** One row per day for `offsets`; `results` may be a per-day array. */
function series(level: string, id: string, parent: string, name: string, offsets: number[], spend: number, results: number | number[], p: Partial<FbAdsDailyInput> = {}): FbAdsDailyInput[] {
  return offsets.map((o, i) => row(level, id, parent, name, o, { spend, results: Array.isArray(results) ? results[i]! : results, ...p }));
}

const WEEK = [-6, -5, -4, -3, -2, -1, 0];
const TWO_WEEKS = [-13, -12, -11, -10, -9, -8, -7, ...WEEK];

function seed(): void {
  _initTestDatabase(':memory:');
  upsertFbAdAccount({ id: ACCOUNT, name: 'Rocket AI', currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', connectionId: 'ca_1', entityId: 'e1', status: 'ACTIVE' });
  updateFbAdAccountSettings(ACCOUNT, { enabled: true, resultType: 'lead', targetCpa: 120_000, monthlyBudget: 200_000_000 });

  const rows: FbAdsDailyInput[] = [
    // Account totals: this week 6.5 tr/day, 59 leads; last week 6.0 tr/day, 50 leads.
    ...series('account', ACCOUNT, '', 'Rocket AI', TWO_WEEKS.slice(0, 7), 6_000_000, 50, { impressions: 105_000, link_clicks: 1600, lp_views: 1100 }),
    ...series('account', ACCOUNT, '', 'Rocket AI', WEEK, 6_500_000, 59, { impressions: 106_000, link_clicks: 1500, lp_views: 1125, purchases: 4, result_value: 3_000_000 }),

    // Campaign c1: one ad set that scales (CPL 86k) and one that is too expensive (CPL 195k).
    ...series('campaign', 'c1', '', 'Lead · Lớp AI Agent T11', WEEK, 2_334_000, 23),
    ...series('adset', 'a1', 'c1', 'Chủ shop online 25–45', WEEK, 1_720_000, 20, { daily_budget: 1_800_000 }),
    ...series('adset', 'a2', 'c1', 'Sở thích: marketing', WEEK, 614_285.71, [3, 3, 3, 3, 3, 3, 4], { learning: 'LEARNING_LIMITED', link_clicks: 80 }),
    ...series('ad', 'd1', 'a1', 'Reel "3 prompt viết caption"', WEEK, 767_428.57, [10, 10, 10, 10, 10, 10, 8], {
      video_3s: 3800, thruplays: 800, creative_json: JSON.stringify({ id: 'cr1', format: 'video', storyId: 'P1_300' }),
    }),
    ...series('ad', 'd2', 'a1', 'Ảnh lịch học', WEEK, 525_714.29, [6, 6, 6, 6, 6, 5, 5], { creative_json: JSON.stringify({ format: 'photo' }) }),

    // Campaign c2: three days of spend, no lead at all.
    ...series('campaign', 'c2', '', 'Test · Video dài case study', [-2, -1, 0], 366_667, 0, { learning: '' }),
    ...series('adset', 'a3', 'c2', 'Broad 25–45', [-2, -1, 0], 366_667, 0, { learning: '' }),
    ...series('ad', 'd3', 'a3', 'Video dài case study', [-2, -1, 0], 366_667, 0, { learning: '', video_3s: 1400 }),
  ];
  upsertFbAdsDaily(rows);

  const placement = (placement: string, spend: number, results: number) => ({
    account_id: ACCOUNT, day: TODAY, placement, spend, impressions: 1000, results, captured_at: NOW,
  });
  replaceFbAdsPlacements(ACCOUNT, addDays(TODAY, -6), [
    placement('facebook|facebook_reels', 4_100_000, 45),
    placement('facebook|feed', 3_800_000, 36),
    placement('facebook|story', 1_400_000, 11),
    placement('audience_network|an_classic', 700_000, 2),
  ]);

  organic = [];
  const post = (post_id: string, title: string, published_at: number, metrics: { reach: number; reactions: number; comments: number; shares: number }) => {
    organic.push({ post_id, page_name: 'Tony Hoàng Learn AI', title, caption: title, format: 'reel', published_at, ...metrics });
  };
  post('P1_100', 'Checklist 5 prompt', NOW - 5 * 86400, { reach: 1000, reactions: 50, comments: 10, shares: 20 });  // ER 8
  post('P1_200', 'Spa dùng agent', NOW - 8 * 86400, { reach: 2000, reactions: 60, comments: 20, shares: 20 });     // ER 5
  post('P1_300', 'Đã chạy quảng cáo', NOW - 3 * 86400, { reach: 1000, reactions: 100, comments: 50, shares: 50 }); // ER 20, but already an ad
  post('P1_400', 'Quá cũ', NOW - 40 * 86400, { reach: 1000, reactions: 100, comments: 50, shares: 50 });           // outside 30 days
  post('P1_500', 'Chưa có reach', NOW - 2 * 86400, { reach: 0, reactions: 1, comments: 0, shares: 0 });

  runEvaluation(ACCOUNT, NOW);
}

describe('ads dashboard', () => {
  beforeEach(seed);

  const dash = (days = 7, connection: 'ACTIVE' | 'EXPIRED' = 'ACTIVE') =>
    loadAdsDashboard(getFbAdAccount(ACCOUNT)!, connection, days, NOW, organic.filter(p => p.published_at! >= NOW - 30 * 86400));

  it('reports the account and the connection state', () => {
    const d = dash();
    expect(d.account).toMatchObject({ id: ACCOUNT, name: 'Rocket AI', currency: 'VND', enabled: true, resultType: 'lead', targetCpa: 120_000, monthlyBudget: 200_000_000, status: 'ACTIVE' });
    expect(d.connection).toBe('ACTIVE');
    expect(d.days).toBe(7);
  });

  it('computes KPIs against the previous 7 days and the month pacing', () => {
    const k = dash().kpis;
    expect(k.spend).toBe(45_500_000);
    expect(k.spendPrev).toBe(42_000_000);
    expect(k.results).toBe(413);
    expect(k.resultsPrev).toBe(350);
    expect(k.cpa).toBeCloseTo(45_500_000 / 413, 5);
    expect(k.cpaPrev).toBeCloseTo(42_000_000 / 350, 5);
    expect(k.ctr).toBeCloseTo((1500 * 7) / (106_000 * 7) * 100, 5);
    expect(k.ctrPrev).toBeCloseTo((1600 / 105_000) * 100, 5);
    expect(k.cpm).toBeCloseTo((45_500_000 / (106_000 * 7)) * 1000, 5);
    expect(k.purchases).toBe(28);
    expect(k.roas).toBeCloseTo((3_000_000 * 7) / 45_500_000, 5);
    // 1–7 October: 45.5 tr of a 200 tr budget, 7 of 31 days.
    expect(k.pacing?.spentPct).toBeCloseTo(22.75, 5);
    expect(k.pacing?.elapsedPct).toBeCloseTo((7 / 31) * 100, 5);
  });

  it('has no previous period for a 14-day window and no pacing without a monthly budget', () => {
    updateFbAdAccountSettings(ACCOUNT, { monthlyBudget: null });
    const d = dash(14);
    expect(d.kpis.spendPrev).toBeNull();
    expect(d.kpis.cpaPrev).toBeNull();
    expect(d.kpis.pacing).toBeNull();
    expect(d.kpis.spend).toBe(45_500_000 + 42_000_000);
  });

  it('returns 14 days oldest first, with a zero for a day without spend', () => {
    const d = dash();
    expect(d.daily).toHaveLength(14);
    expect(d.daily[0]!.day).toBe('2026-09-24');
    expect(d.daily[13]).toMatchObject({ day: TODAY, spend: 6_500_000 });
    expect(d.daily[13]!.cpa).toBeCloseTo(6_500_000 / 59, 5);
  });

  it('builds the queue in severity order with reasons, one per object', () => {
    const q = dash().queue;
    expect(q.map((r) => [r.action, r.objectName, r.level])).toEqual([
      ['off_now', 'Test · Video dài case study', 'campaign'],
      ['off', 'Sở thích: marketing', 'adset'],
      ['up', 'Chủ shop online 25–45', 'adset'],
      ['clone', 'Reel "3 prompt viết caption"', 'ad'],
    ]);
    expect(q[0]!.reason).toContain('chưa có lead nào');
    expect(q[1]!.reason).toContain('CPL 195k = 1,63× mục tiêu');
    expect(q[2]!.reason).toContain('Tăng ngân sách từ 1,8 tr lên 2,16 tr/ngày');
    expect(q.every((r) => r.state === 'open')).toBe(true);
    // Children of the cut campaign are not listed on their own.
    expect(q.some((r) => r.objectName === 'Broad 25–45' || r.objectName === 'Video dài case study')).toBe(false);
  });

  it('prices the open queue', () => {
    const { impact } = dash();
    // c2: 1.1 tr over 7 days; a2: 4.3 tr over 7 days.
    expect(impact.savingsPerDay).toBeCloseTo((1_100_001 + 4_300_000) / 7, -1);
    expect(impact.extraResultsPerDay).toBeGreaterThan(0);
  });

  it('shows done and snoozed items briefly, hides expired ones', () => {
    const q0 = dash().queue;
    updateFbAdsRecommendation(q0[0]!.id, { state: 'done' });
    updateFbAdsRecommendation(q0[1]!.id, { state: 'snoozed', snoozedUntil: NOW + 3600 });
    const q = dash().queue;
    // Open first, then the acted-on ones.
    expect(q.map((r) => r.state)).toEqual(['open', 'open', 'done', 'snoozed']);
    updateFbAdsRecommendation(q0[1]!.id, { state: 'snoozed', snoozedUntil: NOW - 1 });
    expect(dash().queue.map((r) => r.id)).not.toContain(q0[1]!.id);
  });

  it('lists campaigns with their ad sets and each one\'s advice', () => {
    const tree = dash().tree;
    expect(tree.map((t) => [t.level, t.id, t.parentId])).toEqual([
      ['campaign', 'c1', null], ['adset', 'a1', 'c1'], ['adset', 'a2', 'c1'],
      ['campaign', 'c2', null], ['adset', 'a3', 'c2'],
    ]);
    const byId = new Map(tree.map((t) => [t.id, t]));
    expect(byId.get('a1')).toMatchObject({ status: 'ACTIVE', dailyBudget: 1_800_000, results: 140 });
    expect(byId.get('a1')!.cpa).toBeCloseTo(86_000, 0);
    expect(byId.get('a1')!.recommendation?.action).toBe('up');
    expect(byId.get('a2')!.recommendation?.action).toBe('off');
    expect(byId.get('c1')!.recommendation?.action).toBe('keep');
    expect(byId.get('c2')!.recommendation?.action).toBe('off_now');
    // Shown as "off" in the tree even though it is not a separate queue item.
    expect(byId.get('a3')!.recommendation?.action).toBe('off_now');
  });

  it('builds the funnel with the leak called out', () => {
    const f = dash().funnel;
    expect(f.map((s) => s.key)).toEqual(['impressions', 'link_clicks', 'lp_views', 'results', 'purchases']);
    expect(f[0]).toMatchObject({ label: 'Hiển thị', value: 742_000 });
    expect(f[1]!.value).toBe(10_500);
    expect(f[1]!.note).toContain('CTR 1,42%');
    expect(f[2]!.note).toContain('75%');
    expect(f[3]).toMatchObject({ label: 'Lead', value: 413 });
    expect(f[3]!.note).toContain('ngưỡng tốt ≥ 8%: chỗ rò lớn nhất');
    expect(f[4]!.value).toBe(28);
  });

  it('calls out exactly one weakest funnel step', () => {
    const f = dash().funnel;
    // CTR 1,42% (>= 1,2%) and 75% landing (>= 70%) are fine; only the lead step leaks.
    expect(f.filter((s) => s.note.includes('chỗ rò lớn nhất')).map((s) => s.key)).toEqual(['results']);
    expect(f.filter((s) => s.note.includes('rò')).length).toBe(1);
  });

  it('keeps 14 daily points whatever the window and supports the 28-day window', () => {
    expect(dash(28).daily).toHaveLength(14);
    expect(dash(28).days).toBe(28);
    expect(dash(7).daily).toHaveLength(14);
    // 28 days include last week's account rows too (7 more days of 6 tr).
    expect(dash(28).kpis.spend).toBe(45_500_000 + 42_000_000);
    expect(dash(28).kpis.spendPrev).toBeNull();
  });

  it('scores creatives: hook, hold, CPA and the clone call', () => {
    const c = dash().creatives;
    expect(c.map((x) => x.adId)).toEqual(['d1', 'd2', 'd3']);
    const d1 = c[0]!;
    expect(d1).toMatchObject({ name: 'Reel "3 prompt viết caption"', format: 'video', campaignName: 'Lead · Lớp AI Agent T11', hookRate: 38, holdRate: 21.1 });
    expect(d1.cpa).toBeCloseTo(79_000, -2);
    expect(d1.recommendation?.action).toBe('clone');
    expect(c[1]).toMatchObject({ format: 'photo', hookRate: null, holdRate: null });
    expect(c[2]!.hookRate).toBe(14);
    expect(c[2]!.cpa).toBeNull();
  });

  it('groups placements by label with their share of spend', () => {
    const p = dash().placements;
    expect(p.map((x) => x.placement)).toEqual(['Facebook Reels', 'Facebook Bảng tin', 'Facebook Stories', 'Audience Network']);
    expect(p[0]).toMatchObject({ spend: 4_100_000, results: 45 });
    expect(p[0]!.cpa).toBeCloseTo(4_100_000 / 45, 5);
    expect(p.reduce((s, x) => s + x.spendShare, 0)).toBeCloseTo(100, 5);
    expect(p[3]!.spendShare).toBeCloseTo((700_000 / 10_000_000) * 100, 5);
  });

  it('suggests top-ER organic posts that are not already ads', () => {
    const o = dash().organicCandidates;
    expect(o.map((x) => x.postId)).toEqual(['P1_100', 'P1_200']);
    expect(o[0]).toMatchObject({ pageName: 'Tony Hoàng Learn AI', title: 'Checklist 5 prompt', format: 'reel', shares: 20 });
    expect(o[0]!.er).toBeCloseTo(8, 5);
  });

  it('keeps the data and reports EXPIRED when the connection is down', () => {
    const d = dash(7, 'EXPIRED');
    expect(d.connection).toBe('EXPIRED');
    expect(d.account.status).toBe('EXPIRED');
    expect(d.kpis.spend).toBe(45_500_000);
  });
});

describe('ads dashboard without data', () => {
  it('renders empty arrays and zero KPIs for an account that was never snapshotted', () => {
    _initTestDatabase(':memory:');
    upsertFbAdAccount({ id: ACCOUNT, name: 'Rocket AI', currency: 'VND', timezone: '', connectionId: 'ca_1', entityId: 'e1', status: 'EXPIRED' });
    const d = loadAdsDashboard(getFbAdAccount(ACCOUNT)!, 'EXPIRED', 7, NOW);
    expect(d.lastSnapshotAt).toBeNull();
    expect(d.queue).toEqual([]);
    expect(d.tree).toEqual([]);
    expect(d.creatives).toEqual([]);
    expect(d.placements).toEqual([]);
    expect(d.organicCandidates).toEqual([]);
    expect(d.kpis).toMatchObject({ spend: 0, results: 0, cpa: null, ctr: null, spendPrev: null, pacing: null });
    expect(d.daily).toHaveLength(14);
    expect(d.impact).toEqual({ savingsPerDay: null, extraResultsPerDay: null });
    expect(d.funnel).toHaveLength(5);
    expect(d.funnel.every((s, i) => i === 0 || s.value === null)).toBe(true);
  });

  it('omits the sales step of the funnel when results already are purchases', () => {
    _initTestDatabase(':memory:');
    upsertFbAdAccount({ id: ACCOUNT, name: 'Shop', currency: 'VND', timezone: '', connectionId: 'ca_1', entityId: 'e1', status: 'ACTIVE' });
    updateFbAdAccountSettings(ACCOUNT, { resultType: 'purchase' });
    const d = loadAdsDashboard(getFbAdAccount(ACCOUNT)!, 'ACTIVE', 7, NOW);
    expect(d.funnel.map((s) => s.key)).toEqual(['impressions', 'link_clicks', 'lp_views', 'results']);
    expect(d.funnel[3]!.label).toBe('Đơn hàng');
  });
});
