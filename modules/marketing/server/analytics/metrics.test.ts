import { describe, expect, it } from 'vitest';

import {
  buildChannelDashboard, buildPostDetail, buildPostsDashboard, enoughCoverage, erOf, interactionsOf, latestMetric, mean, median,
  medianErForPeriod, pctChange, pillarVerdicts, previousDays, round, sumNullable,
  type DailyFact, type MetricFact, type PostFact,
} from './metrics.js';

const VN = 'Asia/Ho_Chi_Minh';
/** Vietnam local time → unix seconds. */
const vn = (s: string) => Date.parse(`${s.replace(' ', 'T')}:00+07:00`) / 1000;
const NOW = vn('2026-10-07 12:00'); // Wednesday

function metric(postId: string, over: Partial<MetricFact> = {}): MetricFact {
  return {
    post_id: postId, milestone: 'latest', captured_at: NOW - 100, reach: null, impressions: null, reactions: null,
    comments: null, shares: null, clicks: null, video_views_3s: null, avg_watch_s: null, video_length_s: null, follows: null,
    ...over,
  };
}

function post(postId: string, over: Partial<PostFact> = {}): PostFact {
  return {
    postId, contentId: null, title: `Bài ${postId}`, format: 'reel', pillar: '', source: 'user',
    publishedAt: vn('2026-10-06 19:30'), permalink: '', ...over,
  };
}

function day(d: string, over: Partial<DailyFact> = {}): DailyFact {
  return {
    day: d, reach: null, impressions: null, engaged_users: null, new_follows: null, unfollows: null,
    followers_total: null, link_clicks: null, messages: null, ...over,
  };
}

describe('numeric helpers', () => {
  it('computes medians', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('computes means, sums and rounding', () => {
    expect(mean([])).toBeNull();
    expect(mean([1, 2, 6])).toBe(3);
    expect(sumNullable([null, null])).toBeNull();
    expect(sumNullable([null, 2, 3])).toBe(5);
    expect(sumNullable([0])).toBe(0);
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(2.345, 1)).toBe(2.3);
  });

  it('computes % change and refuses a zero or missing base', () => {
    expect(pctChange(112, 100)).toBe(12);
    expect(pctChange(90, 100)).toBe(-10);
    expect(pctChange(5, 0)).toBeNull();
    expect(pctChange(null, 5)).toBeNull();
    expect(pctChange(5, null)).toBeNull();
    expect(pctChange(0, 10)).toBe(-100);
  });

  it('builds the previous period of the same length', () => {
    expect(previousDays(['2026-10-05', '2026-10-06', '2026-10-07'])).toEqual(['2026-10-02', '2026-10-03', '2026-10-04']);
  });
});

describe('ER per post', () => {
  it('is (reactions + comments + shares) / reach * 100', () => {
    expect(erOf({ reactions: 50, comments: 10, shares: 5, reach: 1000 })).toBeCloseTo(6.5, 10);
    expect(interactionsOf({ reactions: 50, comments: 10, shares: 5 })).toBe(65);
  });

  it('treats a missing count as zero but needs at least one count and a positive reach', () => {
    expect(erOf({ reactions: 40, comments: null, shares: null, reach: 1000 })).toBe(4);
    expect(erOf({ reactions: null, comments: null, shares: null, reach: 1000 })).toBeNull();
    expect(interactionsOf({ reactions: null, comments: null, shares: null })).toBeNull();
    expect(erOf({ reactions: 5, comments: 1, shares: 0, reach: 0 })).toBeNull();
    expect(erOf({ reactions: 5, comments: 1, shares: 0, reach: null })).toBeNull();
  });

  it('picks the freshest snapshot of a post', () => {
    const rows = [
      metric('p', { milestone: '1h', captured_at: 100 }),
      metric('p', { milestone: 'latest', captured_at: 900 }),
      metric('p', { milestone: '24h', captured_at: 500 }),
    ];
    expect(latestMetric(rows)?.milestone).toBe('latest');
    expect(latestMetric([])).toBeUndefined();
    expect(latestMetric(undefined)).toBeUndefined();
  });
});

describe('pillarVerdicts', () => {
  const rows = (...r: [string, number, number | null][]) => r.map(([name, posts, index]) => ({ name, posts, index }));

  it('names the highest index among pillars with at least 3 posts the winner', () => {
    const { verdicts, winner } = pillarVerdicts(rows(['A', 7, 0.9], ['B', 3, 1.82], ['C', 4, 1.4]));
    expect(winner).toBe('B');
    expect(verdicts).toEqual(['keep', 'win', 'good']);
  });

  it('does not let a pillar with fewer than 3 posts win, however high its index', () => {
    const { verdicts, winner } = pillarVerdicts(rows(['A', 2, 2.5], ['B', 3, 1.05], ['C', 1, 0.2]));
    expect(winner).toBe('B');
    expect(verdicts).toEqual(['promising', 'win', 'cut']);
  });

  it('marks index >= 1.3 with fewer than 3 posts promising', () => {
    const { verdicts, winner } = pillarVerdicts(rows(['A', 2, 1.3], ['B', 1, 1.29]));
    expect(winner).toBeNull();
    expect(verdicts).toEqual(['promising', 'good']);
  });

  it('applies the thresholds good >= 1.0, keep >= 0.85, fix >= 0.6, else cut', () => {
    const { verdicts } = pillarVerdicts(rows(['a', 5, 2], ['b', 5, 1.0], ['c', 5, 0.99], ['d', 5, 0.85], ['e', 5, 0.84], ['f', 5, 0.6], ['g', 5, 0.59]));
    expect(verdicts).toEqual(['win', 'good', 'keep', 'keep', 'fix', 'fix', 'cut']);
  });

  it('keeps a high-index pillar with 3+ posts that did not win at "good", not "promising"', () => {
    const { verdicts } = pillarVerdicts(rows(['a', 5, 2.0], ['b', 4, 1.6]));
    expect(verdicts).toEqual(['win', 'good']);
  });

  it('has no winner when no pillar has 3 posts, and leaves a pillar without posts at "keep"', () => {
    const { verdicts, winner } = pillarVerdicts(rows(['a', 2, 1.1], ['b', 0, null]));
    expect(winner).toBeNull();
    expect(verdicts).toEqual(['good', 'keep']);
  });

  it('has no winner when the only pillar with 3+ posts has an index below 1.0', () => {
    const { verdicts, winner } = pillarVerdicts(rows(['Kiến thức', 12, 0.39], ['Case study', 2, 1.4], ['Hỏi đáp', 1, 0.9]));
    expect(winner).toBeNull();
    expect(verdicts).toEqual(['cut', 'promising', 'keep']);
  });

  it('requires index >= 1.0 to win, and a lower pillar with 3+ posts takes its threshold verdict', () => {
    expect(pillarVerdicts(rows(['a', 3, 1.0])).winner).toBe('a');
    expect(pillarVerdicts(rows(['a', 3, 0.99])).winner).toBeNull();
    const { verdicts, winner } = pillarVerdicts(rows(['a', 5, 0.99], ['b', 4, 0.5]));
    expect(winner).toBeNull();
    expect(verdicts).toEqual(['keep', 'cut']);
  });

  it('breaks no ties silently: the first of equal indexes wins', () => {
    const { winner } = pillarVerdicts(rows(['a', 3, 1.5], ['b', 3, 1.5]));
    expect(winner).toBe('a');
  });
});

describe('buildChannelDashboard', () => {
  const posts: PostFact[] = [
    post('A', { pillar: 'Case study', format: 'reel', publishedAt: vn('2026-10-06 19:30') }), // Tue, slot 18-21
    post('B', { pillar: 'Case study', format: 'reel', publishedAt: vn('2026-10-04 19:00') }), // Sun
    post('C', { pillar: 'Case study', format: 'video', publishedAt: vn('2026-10-02 20:00') }), // Fri
    post('D', { pillar: 'Kiến thức', format: 'photo', publishedAt: vn('2026-10-05 09:30') }), // Mon, 09-12
    post('E', { pillar: 'Bán hàng', format: 'link', publishedAt: vn('2026-10-03 12:30') }), // Sat, 12-14
    post('F', { pillar: 'Kiến thức', format: 'text', publishedAt: vn('2026-10-07 08:00') }), // no metrics yet
    post('G', { pillar: 'Kiến thức', format: 'reel', publishedAt: vn('2026-09-28 19:00') }), // previous period
  ];
  const metrics: MetricFact[] = [
    metric('A', { reach: 1000, reactions: 50, comments: 10, shares: 5 }), // ER 6.5
    metric('B', { reach: 2000, reactions: 80, comments: 20, shares: 10 }), // 5.5
    metric('C', { reach: 500, reactions: 20, comments: 5, shares: 0 }), // 5.0
    metric('D', { reach: 1000, reactions: 10, comments: 2, shares: 0 }), // 1.2
    metric('E', { reach: 400, reactions: 4, comments: 1, shares: 0 }), // 1.25
    metric('G', { reach: 1000, reactions: 30, comments: 5, shares: 5 }), // 4.0
  ];
  const daily: DailyFact[] = [];
  for (let i = 1; i <= 7; i++) {
    daily.push(day(`2026-10-0${i}`, {
      reach: 100, impressions: 200, engaged_users: 10, new_follows: 5, unfollows: 1, link_clicks: 3,
      followers_total: i === 7 ? 5000 : 4900 + i,
    }));
  }
  for (const d of ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']) {
    daily.push(day(d, { reach: 80, new_follows: 4, unfollows: 1 }));
  }
  const pillars = [{ name: 'Case study', targetPct: 30 }, { name: 'Kiến thức', targetPct: 30 }, { name: 'Bán hàng', targetPct: 20 }];
  const input = {
    page: { id: 'p1', name: 'Page 1', role: 'Nhận biết', mainKpi: 'reach', followers: 4000, timezone: VN, pillars },
    now: NOW, days: 7, posts, metrics, daily, insight: null, lastSnapshotAt: NOW - 50,
  };
  const dto = buildChannelDashboard(input);
  const kpi = (key: string) => dto.kpis.find((k) => k.key === key)!;

  it('counts the posts of the period', () => {
    expect(dto.days).toBe(7);
    expect(dto.posts).toBe(6);
    expect(dto.lastSnapshotAt).toBe(NOW - 50);
  });

  it('takes the ER median over posts and compares with the previous period in points', () => {
    expect(kpi('er').value).toBe(5);
    expect(kpi('er').unit).toBe('pct');
    expect(kpi('er').delta).toBe(1);
    expect(kpi('er').deltaUnit).toBe('pt');
    expect(dto.page.er28d).toBe(5);
  });

  it('sums daily reach and compares with the previous period', () => {
    expect(kpi('reach').value).toBe(700);
    expect(kpi('reach').delta).toBe(25);
    expect(kpi('reach').label).toBe('Reach 7 ngày');
  });

  it('shows followers with net follows and the change of net follows', () => {
    expect(kpi('followers').value).toBe(5000);
    expect(kpi('followers').extra).toBe(28);
    expect(kpi('followers').delta).toBe(33.3);
    expect(kpi('followers').spark).toHaveLength(7);
    expect(kpi('followers').spark[6]).toBe(28);
  });

  it('adds link clicks to interactions and computes per-mille share rate and comments per post', () => {
    expect(kpi('interactions').value).toBe(217 + 21);
    expect(kpi('interactions').delta).toBe(495);
    expect(kpi('shareRate').value).toBe(21.43);
    expect(kpi('shareRate').unit).toBe('permille');
    expect(kpi('commentsPerPost').value).toBe(7.6);
    expect(kpi('commentsPerPost').delta).toBe(52);
    for (const k of dto.kpis) expect(k.spark).toHaveLength(7);
  });

  it('builds the funnel from Page daily numbers', () => {
    expect(dto.funnel.map((f) => [f.key, f.value])).toEqual([
      ['impressions', 1400], ['reach', 700], ['engaged', 70], ['actions', 21],
    ]);
  });

  it('builds the interaction mix', () => {
    expect(dto.mix).toEqual([
      { key: 'reaction', value: 164 }, { key: 'comment', value: 38 }, { key: 'share', value: 15 }, { key: 'click', value: 21 },
    ]);
  });

  it('computes pillar shares, index and verdicts over measured posts only', () => {
    const cs = dto.pillars.find((p) => p.name === 'Case study')!;
    expect(cs).toMatchObject({ posts: 3, postShare: 60, interactionShare: 92.2, index: 1.54, erMedian: 5.5, verdict: 'win' });
    expect(cs.commentsPerPost).toBe(11.7);
    expect(cs.sharesPerPost).toBe(5);
    const kt = dto.pillars.find((p) => p.name === 'Kiến thức')!;
    expect(kt.posts).toBe(1); // F has no snapshot yet and G is the previous period
    expect(kt.verdict).toBe('cut');
    expect(dto.winner).toBe('Case study');
    expect(dto.pillars.map((p) => p.name)).toEqual(['Case study', 'Kiến thức', 'Bán hàng']);
  });

  it('reports a null winner and threshold verdicts when no pillar with 3+ posts reaches index 1.0', () => {
    // The 3-post pillar gets almost no interactions, so its index is far below 1.0.
    const split = [
      post('S1', { pillar: 'Kiến thức', publishedAt: vn('2026-10-06 19:30') }), post('S2', { pillar: 'Kiến thức', publishedAt: vn('2026-10-05 19:30') }),
      post('S3', { pillar: 'Kiến thức', publishedAt: vn('2026-10-04 19:30') }), post('S4', { pillar: 'Case study', publishedAt: vn('2026-10-03 19:30') }),
    ];
    const m = [
      metric('S1', { reach: 1000, reactions: 1 }), metric('S2', { reach: 1000, reactions: 1 }), metric('S3', { reach: 1000, reactions: 1 }),
      metric('S4', { reach: 1000, reactions: 100 }),
    ];
    const out = buildChannelDashboard({ ...input, posts: split, metrics: m });
    expect(out.winner).toBeNull();
    const kt = out.pillars.find((p) => p.name === 'Kiến thức')!;
    expect(kt.posts).toBe(3);
    expect(kt.index).toBeLessThan(0.1);
    expect(kt.verdict).toBe('cut');
    expect(out.pillars.find((p) => p.name === 'Case study')?.verdict).toBe('promising');
  });

  it('lists every format with its post count and median ER', () => {
    expect(dto.formats.map((f) => f.format)).toEqual(['reel', 'video', 'photo', 'album', 'text', 'link']);
    expect(dto.formats).toEqual([
      { format: 'reel', posts: 2, erMedian: 6 },
      { format: 'video', posts: 1, erMedian: 5 },
      { format: 'photo', posts: 1, erMedian: 1.2 },
      { format: 'album', posts: 0, erMedian: null },
      { format: 'text', posts: 1, erMedian: null },
      { format: 'link', posts: 1, erMedian: 1.25 },
    ]);
  });

  it('puts posts into weekday x slot cells in the Page timezone, Monday = 0', () => {
    expect(dto.heat).toHaveLength(42);
    const cell = (weekday: number, slot: number) => dto.heat.find((c) => c.weekday === weekday && c.slot === slot)!;
    expect(cell(1, 4)).toMatchObject({ er: 6.5, posts: 1 }); // Tue 19:30
    expect(cell(6, 4)).toMatchObject({ er: 5.5, posts: 1 }); // Sun 19:00
    expect(cell(4, 4)).toMatchObject({ er: 5, posts: 1 }); // Fri 20:00
    expect(cell(0, 1)).toMatchObject({ er: 1.2, posts: 1 }); // Mon 09:30
    expect(cell(5, 2)).toMatchObject({ er: 1.25, posts: 1 }); // Sat 12:30
    expect(cell(2, 0)).toMatchObject({ er: null, posts: 0 });
    expect(dto.heat.filter((c) => c.posts > 0)).toHaveLength(5);
  });

  it('uses the median ER of the posts in a shared cell', () => {
    const extra = [
      ...posts,
      post('H', { pillar: 'Case study', publishedAt: vn('2026-10-06 20:15') }),
      post('I', { pillar: 'Case study', publishedAt: vn('2026-10-06 18:05') }),
    ];
    const m2 = [...metrics, metric('H', { reach: 1000, reactions: 20 }), metric('I', { reach: 1000, reactions: 90 })];
    const cell = buildChannelDashboard({ ...input, posts: extra, metrics: m2 }).heat.find((c) => c.weekday === 1 && c.slot === 4)!;
    expect(cell.posts).toBe(3);
    expect(cell.er).toBe(6.5); // median of 2, 6.5, 9
  });

  it('ranks the top 3 and bottom 2 by ER without overlap', () => {
    expect(dto.top.map((p) => p.postId)).toEqual(['A', 'B', 'C']);
    expect(dto.top[0]).toMatchObject({ er: 6.5, format: 'reel', pillar: 'Case study', title: 'Bài A' });
    expect(dto.bottom.map((p) => p.postId)).toEqual(['D', 'E']);
  });

  it('labels reach and follows per day, null where Meta gave no row', () => {
    expect(dto.reachDaily).toHaveLength(7);
    expect(dto.reachDaily[0]).toEqual({ day: '2026-10-01', reach: 100 });
    const sparse = buildChannelDashboard({ ...input, daily: [day('2026-10-07', { reach: 7 })] });
    expect(sparse.reachDaily[0].reach).toBeNull();
    expect(sparse.reachDaily[6].reach).toBe(7);
    expect(sparse.followsDaily[6]).toEqual({ day: '2026-10-07', newFollows: null, unfollows: null });
  });

  it('keeps nulls instead of inventing zeros when nothing was collected', () => {
    const empty = buildChannelDashboard({ ...input, posts: [], metrics: [], daily: [] });
    expect(empty.posts).toBe(0);
    expect(kpiOf(empty, 'er').value).toBeNull();
    expect(kpiOf(empty, 'reach').value).toBeNull();
    expect(kpiOf(empty, 'followers').value).toBe(4000); // falls back to the Page row
    expect(kpiOf(empty, 'followers').extra).toBeNull();
    expect(kpiOf(empty, 'interactions').value).toBeNull();
    expect(empty.funnel.every((f) => f.value === null)).toBe(true);
    expect(empty.winner).toBeNull();
    expect(empty.top).toEqual([]);
    expect(empty.pillars.every((p) => p.index === null && p.posts === 0)).toBe(true);
  });

  it('adds pillars found on posts but missing from the Page config, ignoring unclassified posts', () => {
    const odd = buildChannelDashboard({
      ...input,
      posts: [post('X', { pillar: 'Mới' }), post('Y', { pillar: '' })],
      metrics: [metric('X', { reach: 100, reactions: 5 }), metric('Y', { reach: 100, reactions: 50 })],
    });
    expect(odd.pillars.map((p) => p.name)).toEqual(['Case study', 'Kiến thức', 'Bán hàng', 'Mới']);
    const mới = odd.pillars.find((p) => p.name === 'Mới')!;
    expect(mới).toMatchObject({ posts: 1, postShare: 100, interactionShare: 100, index: 1 });
  });

  it('derives followers net from the follower total when follows are missing', () => {
    const d = [day('2026-10-01', { followers_total: 1000 }), day('2026-10-07', { followers_total: 1042 })];
    const out = buildChannelDashboard({ ...input, daily: d });
    expect(kpiOf(out, 'followers').extra).toBe(42);
    expect(kpiOf(out, 'followers').value).toBe(1042);
  });

  it('respects the Page timezone when assigning posts to days and slots', () => {
    // 2026-10-06 18:30Z is 01:30 on Oct 7 in Vietnam but 11:30 on Oct 6 in Los Angeles.
    const t = Date.parse('2026-10-06T18:30:00Z') / 1000;
    const p = [post('T', { publishedAt: t })];
    const m = [metric('T', { reach: 100, reactions: 10 })];
    const vnDash = buildChannelDashboard({ ...input, posts: p, metrics: m });
    expect(vnDash.heat.filter((c) => c.posts > 0)).toHaveLength(0); // 01:30 has no slot
    const la = buildChannelDashboard({ ...input, page: { ...input.page, timezone: 'America/Los_Angeles' }, posts: p, metrics: m });
    expect(la.heat.find((c) => c.posts > 0)).toMatchObject({ weekday: 1, slot: 1 }); // Tue 09-12
  });

  it('computes the 28 day ER median for a Page', () => {
    // 28 days also takes in G (4.0): 1.2, 1.25, 4, 5, 5.5, 6.5 → 4.5
    expect(medianErForPeriod(posts, metrics, NOW, VN, 28)).toBe(4.5);
    expect(medianErForPeriod([], [], NOW, VN, 28)).toBeNull();
  });

  it('passes the stored insight through', () => {
    const insight = { summary: ['a', 'b', 'c'], actions: ['x', 'y', 'z'], createdAt: 123 };
    expect(buildChannelDashboard({ ...input, insight }).insight).toEqual(insight);
  });
});

function kpiOf(dto: ReturnType<typeof buildChannelDashboard>, key: string) {
  return dto.kpis.find((k) => k.key === key)!;
}

describe('buildPostsDashboard', () => {
  const posts: PostFact[] = [
    post('A', { format: 'reel', pillar: 'Case study', publishedAt: vn('2026-10-06 19:30'), contentId: 11 }),
    post('B', { format: 'photo', publishedAt: vn('2026-10-05 12:00') }),
    post('C', { format: 'reel', publishedAt: vn('2026-10-05 20:00') }),
    post('D', { format: 'reel', publishedAt: vn('2026-10-06 08:00') }), // no 24h snapshot yet
    post('P1', { publishedAt: vn('2026-09-30 12:00') }), // previous period (days = 7)
  ];
  const at24 = (postId: string, over: Partial<MetricFact>) => metric(postId, { milestone: '24h', ...over });
  const metrics: MetricFact[] = [
    at24('A', { reach: 1000, reactions: 60, comments: 20, shares: 10, avg_watch_s: 15.26 }), // ER 9
    at24('B', { reach: 1000, reactions: 30, comments: 5, shares: 5 }), // 4
    at24('C', { reach: 1000, reactions: 10, comments: 2, shares: 1 }), // 1.3
    metric('D', { milestone: 'latest', reach: 100, reactions: 1 }), // only a later snapshot: must not be used for the 24h view
    at24('P1', { reach: 1000, reactions: 20, comments: 4, shares: 1 }), // 2.5
  ];
  const daily = [
    day('2026-10-05', { reach: 300 }), day('2026-10-06', { reach: 500 }), day('2026-10-07', { reach: 200 }),
    day('2026-09-30', { reach: 400 }),
    day('2026-09-27'), day('2026-09-28'), day('2026-09-29'), // rows exist (4 of 7 days), no reach
  ];
  const dto = buildPostsDashboard({
    page: { id: 'p1', name: 'Page 1', timezone: VN }, now: NOW, days: 7, milestone: '24h',
    posts, metrics, daily, comments: { needed: 20, answered: 19 },
  });

  it('uses the milestone snapshot, not the latest, for ER and the index', () => {
    const byId = Object.fromEntries(dto.rows.map((r) => [r.postId, r]));
    expect(byId.A).toMatchObject({ reach: 1000, er: 9, comments: 20, shares: 10, avgWatchS: 15.3, contentId: 11, pillar: 'Case study' });
    expect(byId.D).toMatchObject({ reach: null, er: null, index: null });
  });

  it('indexes each post against the Page median ER at the same milestone', () => {
    const byId = Object.fromEntries(dto.rows.map((r) => [r.postId, r]));
    // ERs 9, 4, 1.3 → median 4
    expect(dto.kpis.erMedian).toBe(4);
    expect(byId.A.index).toBe(2.25);
    expect(byId.B.index).toBe(1);
    expect(byId.C.index).toBe(0.33);
  });

  it('sorts by index, posts without one last', () => {
    expect(dto.rows.map((r) => r.postId)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('computes the KPIs against the previous period', () => {
    expect(dto.kpis.posts).toBe(4);
    expect(dto.kpis.postsDelta).toBe(3);
    expect(dto.kpis.reach).toBe(1000);
    expect(dto.kpis.reachDeltaPct).toBe(150);
    expect(dto.kpis.erDeltaPt).toBe(1.5);
    expect(dto.kpis.comments).toBe(27); // latest snapshot per post: A 20 + B 5 + C 2, D has none
    expect(dto.kpis.aiReplyRate).toBe(95);
    expect(dto.milestone).toBe('24h');
  });

  it('counts posts per day next to daily reach', () => {
    expect(dto.reachDaily).toHaveLength(7);
    expect(dto.reachDaily.find((d) => d.day === '2026-10-05')).toEqual({ day: '2026-10-05', reach: 300, posts: 2 });
    expect(dto.reachDaily.find((d) => d.day === '2026-10-07')).toEqual({ day: '2026-10-07', reach: 200, posts: 0 });
    expect(dto.reachDaily.find((d) => d.day === '2026-10-01')?.reach).toBeNull();
  });

  it('has no reply rate without comments and no ER for a milestone nobody reached', () => {
    const none = buildPostsDashboard({
      page: { id: 'p1', name: 'Page 1', timezone: VN }, now: NOW, days: 7, milestone: '28d',
      posts, metrics, daily, comments: { needed: 0, answered: 0 },
    });
    expect(none.kpis.aiReplyRate).toBeNull();
    expect(none.kpis.erMedian).toBeNull();
    expect(none.kpis.erDeltaPt).toBeNull();
    expect(none.rows.every((r) => r.er === null && r.index === null)).toBe(true);
  });
});

describe('previous-period comparisons need a measured previous period', () => {
  const NOWX = NOW;
  const cur = [post('A', { publishedAt: vn('2026-10-06 19:30') }), post('B', { publishedAt: vn('2026-10-05 19:30') })];
  const prevPosts = ['P1', 'P2', 'P3', 'P4'].map((id, i) => post(id, { publishedAt: vn(`2026-09-2${6 + (i % 4)} 12:00`) }));
  const curMetrics = [metric('A', { reach: 1000, reactions: 50 }), metric('B', { reach: 1000, reactions: 40 })];
  const prevMetric = (id: string) => metric(id, { reach: 1000, reactions: 10, comments: 1 });
  const curDaily = [day('2026-10-06', { reach: 500, link_clicks: 5, new_follows: 4 }), day('2026-10-07', { reach: 500, link_clicks: 5, new_follows: 4 })];
  const prevDaily = ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'].map((d) => day(d, { reach: 100, link_clicks: 1, new_follows: 2 }));
  const base = {
    page: { id: 'p1', name: 'P', role: '', mainKpi: '', followers: null, timezone: VN, pillars: [] }, now: NOWX, days: 7,
    insight: null, lastSnapshotAt: null,
  };
  const deltas = (dto: ReturnType<typeof buildChannelDashboard>) => Object.fromEntries(dto.kpis.map((k) => [k.key, k.delta]));

  it('shows deltas when at least half of the previous posts and days were measured', () => {
    const d = deltas(buildChannelDashboard({
      ...base, posts: [...cur, ...prevPosts], metrics: [...curMetrics, ...prevPosts.slice(0, 2).map((p) => prevMetric(p.postId))], daily: [...curDaily, ...prevDaily],
    }));
    expect(d.er).not.toBeNull();
    expect(d.interactions).not.toBeNull();
    expect(d.reach).toBe(150); // 1000 now vs 400 before
  });

  it('drops snapshot-based deltas when fewer than half of the previous posts have a snapshot', () => {
    const d = deltas(buildChannelDashboard({
      ...base, posts: [...cur, ...prevPosts], metrics: [...curMetrics, prevMetric('P1')], daily: [...curDaily, ...prevDaily],
    }));
    expect(d.er).toBeNull();
    expect(d.interactions).toBeNull(); // the +1830% case
    expect(d.shareRate).toBeNull();
    expect(d.commentsPerPost).toBeNull();
    expect(d.reach).not.toBeNull(); // daily numbers are measured
  });

  it('drops daily-based deltas when fewer than half of the previous days have a row', () => {
    const d = deltas(buildChannelDashboard({
      ...base, posts: [...cur, ...prevPosts], metrics: [...curMetrics, ...prevPosts.map((p) => prevMetric(p.postId))], daily: [...curDaily, prevDaily[0]],
    }));
    expect(d.reach).toBeNull();
    expect(d.followers).toBeNull();
    expect(d.interactions).toBeNull();
    expect(d.er).not.toBeNull();
  });

  it('drops every comparison when the previous period starts before the imported history', () => {
    const input = { ...base, posts: [...cur, ...prevPosts], metrics: [...curMetrics, ...prevPosts.map((p) => prevMetric(p.postId))], daily: [...curDaily, ...prevDaily] };
    const covered = deltas(buildChannelDashboard({ ...input, historyStart: vn('2026-09-01 00:00') }));
    expect(covered.er).not.toBeNull();
    const notCovered = deltas(buildChannelDashboard({ ...input, historyStart: vn('2026-09-26 00:00') }));
    expect(Object.values(notCovered).every((v) => v === null)).toBe(true);
    const posts = buildPostsDashboard({
      page: { id: 'p1', name: 'P', timezone: VN }, now: NOWX, days: 7, milestone: '24h',
      posts: input.posts, metrics: input.metrics.map((m) => ({ ...m, milestone: '24h' })), daily: input.daily,
      comments: { needed: 0, answered: 0 }, historyStart: vn('2026-09-26 00:00'),
    });
    expect(posts.kpis.postsDelta).toBeNull();
    expect(posts.kpis.reachDeltaPct).toBeNull();
    expect(posts.kpis.erDeltaPt).toBeNull();
    expect(posts.kpis.commentsDeltaPct).toBeNull();
  });

  it('applies the same coverage rule to the Posts dashboard', () => {
    const at24 = (m: MetricFact) => ({ ...m, milestone: '24h' });
    const run = (prevCount: number) => buildPostsDashboard({
      page: { id: 'p1', name: 'P', timezone: VN }, now: NOWX, days: 7, milestone: '24h',
      posts: [...cur, ...prevPosts], metrics: [...curMetrics, ...prevPosts.slice(0, prevCount).map((p) => prevMetric(p.postId))].map(at24),
      daily: [...curDaily, ...prevDaily], comments: { needed: 0, answered: 0 },
    });
    expect(run(1).kpis.erDeltaPt).toBeNull();
    expect(run(1).kpis.commentsDeltaPct).toBeNull();
    expect(run(2).kpis.erDeltaPt).not.toBeNull();
    expect(run(1).kpis.postsDelta).toBe(-2); // post counts do not depend on snapshots
  });

  it('decides coverage at the half mark', () => {
    expect(enoughCoverage(2, 4)).toBe(true);
    expect(enoughCoverage(1, 4)).toBe(false);
    expect(enoughCoverage(0, 0)).toBe(false);
  });
});

describe("milestone 'latest' (numbers to date)", () => {
  const D = 86400;
  const posts = [
    post('A', { publishedAt: NOW - 3 * D }), post('B', { publishedAt: NOW - 5 * D }), post('C', { publishedAt: NOW - 10 * D }),
    post('N', { publishedAt: NOW - 2 * D }), // no snapshot at all
  ];
  const metrics = [
    metric('A', { milestone: 'latest', captured_at: 900, reach: 1000, reactions: 60, comments: 4, shares: 2 }), // 6.6
    metric('A', { milestone: '24h', captured_at: 100, reach: 100, reactions: 1 }), // older, ignored by 'latest'
    metric('B', { milestone: 'latest', reach: 1000, reactions: 30 }), // 3
    metric('C', { milestone: 'latest', reach: 1000, reactions: 10 }), // 1
  ];
  const run = (milestone: 'latest' | '24h' | '7d' | '28d') => buildPostsDashboard({
    page: { id: 'p1', name: 'P', timezone: VN }, now: NOW, days: 28, milestone, posts, metrics, daily: [], comments: { needed: 0, answered: 0 },
  });

  it("uses each post's freshest snapshot and indexes against the median of those ERs", () => {
    const dto = run('latest');
    const byId = Object.fromEntries(dto.rows.map((r) => [r.postId, r]));
    expect(dto.milestone).toBe('latest');
    expect(byId.A).toMatchObject({ reach: 1000, er: 6.6, comments: 4, shares: 2 });
    expect(dto.kpis.erMedian).toBe(3);
    expect(byId.A.index).toBe(2.2);
    expect(byId.B.index).toBe(1);
    expect(byId.C.index).toBe(0.33);
    expect(byId.N).toMatchObject({ reach: null, er: null, index: null });
    expect(dto.rows.map((r) => r.postId)).toEqual(['A', 'B', 'C', 'N']);
  });

  it('keeps 24h, 7d and 28d strict: no fallback to the latest snapshot', () => {
    const d24 = run('24h');
    expect(d24.rows.filter((r) => r.er !== null).map((r) => r.postId)).toEqual(['A']);
    expect(run('7d').rows.every((r) => r.er === null)).toBe(true);
    expect(run('28d').rows.every((r) => r.er === null && r.reach === null)).toBe(true);
    expect(run('28d').kpis.erMedian).toBeNull();
  });
});

describe('buildPostDetail', () => {
  const p = post('A', { format: 'reel', pillar: 'Kiến thức', permalink: 'https://facebook.com/x/reel/1' });
  const mine = [
    metric('A', { milestone: '1h', captured_at: 10, reach: 1900 }),
    metric('A', { milestone: '6h', captured_at: 20, reach: 7800 }),
    metric('A', { milestone: '24h', captured_at: 30, reach: 13900, comments: 168, shares: 74, video_views_3s: 9000, avg_watch_s: 17, video_length_s: 22, follows: 12 }),
  ];
  const peers = [
    metric('X', { milestone: '1h', reach: 1000 }), metric('Y', { milestone: '1h', reach: 3000 }), metric('Z', { milestone: '1h', reach: 2000 }),
    metric('X', { milestone: '24h', reach: 7000 }), metric('Y', { milestone: '24h', reach: 9000 }),
  ];
  const dto = buildPostDetail({ post: p, metrics: mine, peerMetrics: peers, comments: { total: 40, answered: 38 }, note: 'Hook con số.' });

  it('gives the reach curve at every milestone, null where not reached yet', () => {
    expect(dto.curve).toEqual([
      { milestone: '1h', reach: 1900 }, { milestone: '6h', reach: 7800 }, { milestone: '24h', reach: 13900 },
      { milestone: '3d', reach: null }, { milestone: '7d', reach: null }, { milestone: '28d', reach: null },
    ]);
  });

  it('gives the median curve of the Page\'s posts', () => {
    expect(dto.medianCurve).toEqual([
      { milestone: '1h', reach: 2000 }, { milestone: '6h', reach: null }, { milestone: '24h', reach: 8000 },
      { milestone: '3d', reach: null }, { milestone: '7d', reach: null }, { milestone: '28d', reach: null },
    ]);
  });

  it('reads stats from the freshest snapshot and passes the note through', () => {
    expect(dto.stats).toEqual({
      views3s: 9000, avgWatchS: 17, videoLengthS: 22, follows: 12, comments: 168, commentsReplied: 38, shares: 74,
    });
    expect(dto.note).toBe('Hook con số.');
    expect(dto).toMatchObject({ postId: 'A', title: 'Bài A', format: 'reel', pillar: 'Kiến thức', permalink: 'https://facebook.com/x/reel/1' });
  });

  it('reports no replied count when the post has no comments from others', () => {
    const none = buildPostDetail({ post: p, metrics: [], peerMetrics: [], comments: { total: 0, answered: 0 }, note: null });
    expect(none.stats.commentsReplied).toBeNull();
    expect(none.stats.comments).toBeNull();
    expect(none.curve.every((c) => c.reach === null)).toBe(true);
  });
});
