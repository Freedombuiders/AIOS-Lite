/**
 * Pure aggregations behind the Facebook analytics dashboards. No I/O: the
 * service layer loads rows and calls these. ER, medians, pillar index and
 * verdicts, formats, weekday × slot heat, funnel, mix, KPI deltas, sparks and
 * the post index follow docs/facebook-content-studio.md (Workstream ANALYTICS).
 */

import type { FbPageDailyRow, FbPostMetricsRow } from '../store.js';
import type {
  ChannelDashboardDto,
  ChannelKpi,
  FbFormat,
  FbPillar,
  Milestone,
  PillarVerdict,
  PostDetailDto,
  PostRef,
  PostsDashboardDto,
} from '../types.js';
import { MILESTONE_KEYS } from './schedule.js';
import { addDays, lastNDays, localDay, localDayStartSec, localParts, slotOfHour } from './time.js';

export const FORMATS: FbFormat[] = ['reel', 'video', 'photo', 'album', 'text', 'link'];
/** A pillar needs this many measured posts to be judged a winner. */
export const MIN_POSTS_FOR_WINNER = 3;
/** ...and an index of at least this: a pillar that under-performs its post share is never the winner. */
export const MIN_INDEX_FOR_WINNER = 1.0;

export type MetricFact = Pick<FbPostMetricsRow,
  'post_id' | 'milestone' | 'captured_at' | 'reach' | 'impressions' | 'reactions' | 'comments' | 'shares' | 'clicks'
  | 'video_views_3s' | 'avg_watch_s' | 'video_length_s' | 'follows'>;

export type DailyFact = Pick<FbPageDailyRow,
  'day' | 'reach' | 'impressions' | 'engaged_users' | 'new_follows' | 'unfollows' | 'followers_total' | 'link_clicks' | 'messages'>;

export interface PostFact {
  postId: string;
  contentId: number | null;
  title: string;
  format: FbFormat;
  pillar: string;
  source: string;
  publishedAt: number;
  permalink: string;
}

// ── Small numeric helpers ──────────────────────────────────────────────

export function round(n: number, dp = 1): number {
  const k = 10 ** dp;
  return Math.round((n + Number.EPSILON) * k) / k;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Sum that ignores nulls; null when there was nothing to add. */
export function sumNullable(values: readonly (number | null | undefined)[]): number | null {
  let total = 0;
  let any = false;
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    total += v;
    any = true;
  }
  return any ? total : null;
}

/** % change from prev to cur (1 decimal); null when prev is missing or zero. */
export function pctChange(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return round(((cur - prev) / Math.abs(prev)) * 100, 1);
}

/**
 * A comparison with the previous period is only honest when most of that
 * period was actually measured: at least half of `total` must be `measured`.
 */
export function enoughCoverage(measured: number, total: number): boolean {
  return total > 0 && measured * 2 >= total;
}

function diff(cur: number | null, prev: number | null, dp: number): number | null {
  if (cur === null || prev === null) return null;
  return round(cur - prev, dp);
}

// ── Per-post metrics ───────────────────────────────────────────────────

type CountFields = Pick<MetricFact, 'reactions' | 'comments' | 'shares'>;

/** reactions + comments + shares; null when none of the three was collected. */
export function interactionsOf(m: CountFields): number | null {
  return sumNullable([m.reactions, m.comments, m.shares]);
}

/** ER = (reactions + comments + shares) ÷ reach × 100; null without reach or counts. */
export function erOf(m: CountFields & Pick<MetricFact, 'reach'>): number | null {
  const interactions = interactionsOf(m);
  if (interactions === null || m.reach === null || m.reach <= 0) return null;
  return (interactions / m.reach) * 100;
}

/** The freshest snapshot of a post (any milestone or 'latest'). */
export function latestMetric(rows: readonly MetricFact[] | undefined): MetricFact | undefined {
  if (!rows || rows.length === 0) return undefined;
  return rows.reduce((best, r) => (r.captured_at > best.captured_at ? r : best));
}

export function groupMetricsByPost(metrics: readonly MetricFact[]): Map<string, MetricFact[]> {
  const out = new Map<string, MetricFact[]>();
  for (const m of metrics) {
    const list = out.get(m.post_id);
    if (list) list.push(m); else out.set(m.post_id, [m]);
  }
  return out;
}

// ── Pillars ────────────────────────────────────────────────────────────

export interface PillarRowInput {
  name: string;
  posts: number;
  /** Index = interaction share ÷ post share; null when the pillar has no posts. */
  index: number | null;
}

/**
 * Verdict per pillar, in input order. Winner = highest index among pillars
 * with ≥ 3 posts and index ≥ 1.0 → 'win'; with none qualifying there is no
 * winner and every pillar gets its threshold verdict. Otherwise index ≥ 1.3 with < 3 posts → 'promising';
 * ≥ 1.0 good; ≥ 0.85 keep; ≥ 0.6 fix; else cut. A pillar with no posts has no
 * index and stays at 'keep' (nothing to judge yet).
 */
export function pillarVerdicts(rows: readonly PillarRowInput[]): { verdicts: PillarVerdict[]; winner: string | null } {
  let winnerIdx = -1;
  rows.forEach((r, i) => {
    if (r.posts < MIN_POSTS_FOR_WINNER || r.index === null || r.index < MIN_INDEX_FOR_WINNER) return;
    if (winnerIdx === -1 || r.index > (rows[winnerIdx].index as number)) winnerIdx = i;
  });
  const verdicts = rows.map((r, i): PillarVerdict => {
    if (i === winnerIdx) return 'win';
    if (r.index === null) return 'keep';
    if (r.index >= 1.3 && r.posts < MIN_POSTS_FOR_WINNER) return 'promising';
    if (r.index >= 1.0) return 'good';
    if (r.index >= 0.85) return 'keep';
    if (r.index >= 0.6) return 'fix';
    return 'cut';
  });
  return { verdicts, winner: winnerIdx >= 0 ? rows[winnerIdx].name : null };
}

/** The period of the same length directly before `curDays`. */
export function previousDays(curDays: readonly string[]): string[] {
  return curDays.map((_, i) => addDays(curDays[0], i - curDays.length));
}

// ── Shared period slicing ──────────────────────────────────────────────

interface MeasuredPost {
  post: PostFact;
  day: string;
  metric: MetricFact | undefined;
  er: number | null;
  interactions: number | null;
}

function measure(posts: readonly PostFact[], byPost: Map<string, MetricFact[]>, tz: string): MeasuredPost[] {
  return posts.map((post) => {
    const metric = latestMetric(byPost.get(post.postId));
    return {
      post,
      day: localDay(post.publishedAt, tz),
      metric,
      er: metric ? erOf(metric) : null,
      interactions: metric ? interactionsOf(metric) : null,
    };
  });
}

function numbers(values: (number | null)[]): number[] {
  return values.filter((v): v is number => v !== null);
}

function medianEr(rows: readonly MeasuredPost[]): number | null {
  return median(numbers(rows.map((r) => r.er)));
}

function toRef(r: MeasuredPost): PostRef {
  return {
    postId: r.post.postId,
    title: r.post.title,
    format: r.post.format,
    pillar: r.post.pillar,
    publishedAt: r.post.publishedAt,
    er: r.er === null ? null : round(r.er, 2),
  };
}

function netFollows(days: readonly string[], daily: Map<string, DailyFact>): number | null {
  const rows = days.map((d) => daily.get(d)).filter((r): r is DailyFact => !!r);
  const adds = sumNullable(rows.map((r) => r.new_follows));
  if (adds !== null) return adds - (sumNullable(rows.map((r) => r.unfollows)) ?? 0);
  const totals = rows.map((r) => r.followers_total).filter((v): v is number => v !== null);
  if (totals.length >= 2) return totals[totals.length - 1] - totals[0];
  return null;
}

function carryForward(values: (number | null)[]): number[] {
  const firstKnown = values.find((v) => v !== null) ?? 0;
  let last = firstKnown;
  return values.map((v) => {
    if (v !== null) last = v;
    return round(last, 2);
  });
}

// ── Channel dashboard ──────────────────────────────────────────────────

export interface ChannelInput {
  page: { id: string; name: string; role: string; mainKpi: string; followers: number | null; timezone: string; pillars: FbPillar[] };
  now: number;
  days: number;
  /** Published posts of the Page covering at least the current and previous period. */
  posts: readonly PostFact[];
  metrics: readonly MetricFact[];
  /** Page daily rows covering at least the current and previous period. */
  daily: readonly DailyFact[];
  insight: { summary: string[]; actions: string[]; createdAt: number } | null;
  lastSnapshotAt: number | null;
  /** ER median over the last 28 days, when `days` is not 28. Omit to reuse the computed one. */
  er28d?: number | null;
  /** Earliest instant posts were imported back to; a previous period starting before it is not comparable. Omit = assume covered. */
  historyStart?: number | null;
}

export function buildChannelDashboard(input: ChannelInput): ChannelDashboardDto {
  const tz = input.page.timezone;
  const days = input.days;
  const curDays = lastNDays(input.now, tz, days);
  const prevDays = previousDays(curDays);
  const curSet = new Set(curDays);
  const prevSet = new Set(prevDays);

  const byPost = groupMetricsByPost(input.metrics);
  const all = measure(input.posts, byPost, tz);
  const cur = all.filter((r) => curSet.has(r.day));
  const prev = all.filter((r) => prevSet.has(r.day));

  const dailyMap = new Map(input.daily.map((r) => [r.day, r] as const));
  const curRows = curDays.map((d) => dailyMap.get(d));

  // The previous period only counts when it was measured: snapshots exist for
  // at least half of its posts, daily numbers for at least half of its days,
  // and its posts were imported that far back.
  const prevKnown = input.historyStart == null || localDayStartSec(prevDays[0], tz) >= input.historyStart;
  const prevSnapshots = prevKnown && enoughCoverage(prev.filter((r) => r.metric).length, prev.length);
  const prevDaily = prevKnown && enoughCoverage(prevDays.filter((d) => dailyMap.has(d)).length, prevDays.length);
  const ifSnap = <T,>(v: T | null): T | null => (prevSnapshots ? v : null);
  const ifDaily = <T,>(v: T | null): T | null => (prevDaily ? v : null);

  // KPI building blocks
  const reachCur = sumNullable(curDays.map((d) => dailyMap.get(d)?.reach ?? null));
  const reachPrev = ifDaily(sumNullable(prevDays.map((d) => dailyMap.get(d)?.reach ?? null)));
  const erCur = medianEr(cur);
  const erPrev = ifSnap(medianEr(prev));
  const intCur = sumNullable(cur.map((r) => r.interactions));
  const intPrev = ifSnap(sumNullable(prev.map((r) => r.interactions)));
  const clicksCur = sumNullable(curDays.map((d) => dailyMap.get(d)?.link_clicks ?? null));
  const clicksPrev = ifDaily(sumNullable(prevDays.map((d) => dailyMap.get(d)?.link_clicks ?? null)));
  const totalCur = intCur === null && clicksCur === null ? null : (intCur ?? 0) + (clicksCur ?? 0);
  // Total interactions = post interactions + clicks, so both halves of the previous period must be known.
  const totalPrev = prevSnapshots && prevDaily && intPrev !== null ? intPrev + (clicksPrev ?? 0) : null;
  const sharesCur = sumNullable(cur.map((r) => r.metric?.shares ?? null));
  const sharesPrev = ifSnap(sumNullable(prev.map((r) => r.metric?.shares ?? null)));
  const shareRate = (shares: number | null, reach: number | null): number | null =>
    shares === null || reach === null || reach <= 0 ? null : (shares / reach) * 1000;
  const shareRateCur = shareRate(sharesCur, reachCur);
  const shareRatePrev = shareRate(sharesPrev, reachPrev);
  const commentsPerPost = (rows: readonly MeasuredPost[]): number | null => mean(numbers(rows.map((r) => r.metric?.comments ?? null)));
  const cppCur = commentsPerPost(cur);
  const cppPrev = ifSnap(commentsPerPost(prev));

  const netCur = netFollows(curDays, dailyMap);
  const netPrev = ifDaily(netFollows(prevDays, dailyMap));
  const lastFollowers = [...curRows].reverse().find((r) => r && r.followers_total !== null)?.followers_total ?? input.page.followers;

  // Sparks (one value per day of the period)
  const postsOnDay = (day: string) => cur.filter((r) => r.day === day);
  let cum = 0;
  const followersSpark = curDays.map((d) => {
    const r = dailyMap.get(d);
    cum += (r?.new_follows ?? 0) - (r?.unfollows ?? 0);
    return cum;
  });
  const reachSpark = curDays.map((d) => dailyMap.get(d)?.reach ?? 0);
  const erSpark = carryForward(curDays.map((d) => medianEr(postsOnDay(d))));
  const interactionsSpark = curDays.map((d) => sumNullable(postsOnDay(d).map((r) => r.interactions)) ?? 0);
  const shareSpark = curDays.map((d) => {
    const reach = dailyMap.get(d)?.reach ?? null;
    return round(shareRate(sumNullable(postsOnDay(d).map((r) => r.metric?.shares ?? null)), reach) ?? 0, 2);
  });
  const cppSpark = carryForward(curDays.map((d) => commentsPerPost(postsOnDay(d))));

  const kpis: ChannelKpi[] = [
    {
      key: 'followers', label: 'Người theo dõi', value: lastFollowers, unit: 'count',
      delta: pctChange(netCur, netPrev), deltaUnit: 'pct', extra: netCur, spark: followersSpark,
    },
    {
      key: 'reach', label: `Reach ${days} ngày`, value: reachCur, unit: 'count',
      delta: pctChange(reachCur, reachPrev), deltaUnit: 'pct', extra: null, spark: reachSpark,
    },
    {
      key: 'er', label: 'ER trung vị', value: erCur === null ? null : round(erCur, 2), unit: 'pct',
      delta: diff(erCur, erPrev, 2), deltaUnit: 'pt', extra: null, spark: erSpark,
    },
    {
      key: 'interactions', label: 'Tổng tương tác', value: totalCur, unit: 'count',
      delta: pctChange(totalCur, totalPrev), deltaUnit: 'pct', extra: null, spark: interactionsSpark,
    },
    {
      key: 'shareRate', label: 'Tỷ lệ share', value: shareRateCur === null ? null : round(shareRateCur, 2), unit: 'permille',
      delta: diff(shareRateCur, shareRatePrev, 2), deltaUnit: 'pt', extra: null, spark: shareSpark,
    },
    {
      key: 'commentsPerPost', label: 'Comment mỗi bài', value: cppCur === null ? null : round(cppCur, 1), unit: 'count',
      delta: pctChange(cppCur, cppPrev), deltaUnit: 'pct', extra: null, spark: cppSpark,
    },
  ];

  // Funnel and mix
  const dailySum = (pick: (r: DailyFact) => number | null): number | null =>
    sumNullable(curDays.map((d) => { const r = dailyMap.get(d); return r ? pick(r) : null; }));
  const actions = sumNullable([dailySum((r) => r.link_clicks), dailySum((r) => r.messages)]);
  const funnel: ChannelDashboardDto['funnel'] = [
    { key: 'impressions', label: 'Hiển thị', value: dailySum((r) => r.impressions) },
    { key: 'reach', label: 'Reach (người thấy bài)', value: reachCur },
    { key: 'engaged', label: 'Người tương tác', value: dailySum((r) => r.engaged_users) },
    { key: 'actions', label: 'Click link hoặc nhắn tin', value: actions },
  ];
  const mix: ChannelDashboardDto['mix'] = [
    { key: 'reaction', value: sumNullable(cur.map((r) => r.metric?.reactions ?? null)) ?? 0 },
    { key: 'comment', value: sumNullable(cur.map((r) => r.metric?.comments ?? null)) ?? 0 },
    { key: 'share', value: sharesCur ?? 0 },
    { key: 'click', value: clicksCur ?? 0 },
  ];

  // Pillars: only posts with a pillar and collected counts take part, so the
  // post share and interaction share are computed over the same population.
  const pillarPosts = cur.filter((r) => r.post.pillar !== '' && r.interactions !== null);
  const configured = input.page.pillars.map((p) => p.name).filter((n) => n);
  const extra = [...new Set(pillarPosts.map((r) => r.post.pillar))].filter((n) => !configured.includes(n)).sort();
  const pillarNames = [...configured, ...extra];
  const totalPosts = pillarPosts.length;
  const totalInteractions = pillarPosts.reduce((s, r) => s + (r.interactions as number), 0);
  const pillarRaw = pillarNames.map((name) => {
    const rows = pillarPosts.filter((r) => r.post.pillar === name);
    const interactions = rows.reduce((s, r) => s + (r.interactions as number), 0);
    const postShare = totalPosts ? (rows.length / totalPosts) * 100 : 0;
    const interactionShare = totalInteractions ? (interactions / totalInteractions) * 100 : 0;
    return {
      name,
      rows,
      postShare,
      interactionShare,
      index: rows.length && postShare > 0 ? interactionShare / postShare : null,
    };
  });
  const { verdicts, winner } = pillarVerdicts(pillarRaw.map((p) => ({ name: p.name, posts: p.rows.length, index: p.index })));
  const pillars: ChannelDashboardDto['pillars'] = pillarRaw.map((p, i) => ({
    name: p.name,
    posts: p.rows.length,
    postShare: round(p.postShare, 1),
    interactionShare: round(p.interactionShare, 1),
    index: p.index === null ? null : round(p.index, 2),
    erMedian: ((m) => (m === null ? null : round(m, 2)))(medianEr(p.rows)),
    commentsPerPost: ((m) => (m === null ? null : round(m, 1)))(commentsPerPost(p.rows)),
    sharesPerPost: ((m) => (m === null ? null : round(m, 1)))(mean(numbers(p.rows.map((r) => r.metric?.shares ?? null)))),
    verdict: verdicts[i],
  }));

  // Formats
  const formats = FORMATS.map((format) => {
    const rows = cur.filter((r) => r.post.format === format);
    const m = medianEr(rows);
    return { format, posts: rows.length, erMedian: m === null ? null : round(m, 2) };
  });

  // Heat: weekday × slot in the Page timezone, median ER per cell
  const cells = new Map<string, number[]>();
  const counts = new Map<string, number>();
  for (const r of cur) {
    if (r.er === null) continue;
    const p = localParts(r.post.publishedAt, tz);
    const slot = slotOfHour(p.hour);
    if (slot === null) continue;
    const key = `${p.weekday}:${slot}`;
    const list = cells.get(key);
    if (list) list.push(r.er); else cells.set(key, [r.er]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const heat: ChannelDashboardDto['heat'] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let slot = 0; slot < 6; slot++) {
      const key = `${weekday}:${slot}`;
      const m = median(cells.get(key) ?? []);
      heat.push({ weekday, slot, er: m === null ? null : round(m, 2), posts: counts.get(key) ?? 0 });
    }
  }

  // Top and bottom by ER
  const ranked = cur.filter((r) => r.er !== null).sort((a, b) => (b.er as number) - (a.er as number));
  const top = ranked.slice(0, 3);
  const topIds = new Set(top.map((r) => r.post.postId));
  const bottom = [...ranked].reverse().filter((r) => !topIds.has(r.post.postId)).slice(0, 2);

  const er28 = input.er28d !== undefined ? input.er28d : erCur;
  return {
    page: {
      id: input.page.id, name: input.page.name, role: input.page.role, mainKpi: input.page.mainKpi,
      followers: lastFollowers, er28d: er28 === null || er28 === undefined ? null : round(er28, 2),
    },
    days,
    posts: cur.length,
    kpis,
    reachDaily: curDays.map((day) => ({ day, reach: dailyMap.get(day)?.reach ?? null })),
    followsDaily: curDays.map((day) => ({
      day, newFollows: dailyMap.get(day)?.new_follows ?? null, unfollows: dailyMap.get(day)?.unfollows ?? null,
    })),
    funnel,
    mix,
    pillars,
    winner,
    formats,
    heat,
    top: top.map(toRef),
    bottom: bottom.map(toRef),
    insight: input.insight,
    lastSnapshotAt: input.lastSnapshotAt,
  };
}

/** Median ER of the posts published in the last `days` local days (for FbPageDto.stats.er28d). */
export function medianErForPeriod(
  posts: readonly PostFact[], metrics: readonly MetricFact[], now: number, tz: string, days: number,
): number | null {
  const set = new Set(lastNDays(now, tz, days));
  const rows = measure(posts, groupMetricsByPost(metrics), tz).filter((r) => set.has(r.day));
  const m = medianEr(rows);
  return m === null ? null : round(m, 2);
}

// ── Posts dashboard ────────────────────────────────────────────────────

export type PostsMilestone = PostsDashboardDto['milestone'];

export interface PostsInput {
  page: { id: string; name: string; timezone: string };
  now: number;
  days: number;
  milestone: PostsMilestone;
  posts: readonly PostFact[];
  metrics: readonly MetricFact[];
  daily: readonly DailyFact[];
  /** Comments from other people that needed an answer, and how many were answered, over the period. */
  comments: { needed: number; answered: number };
  limit?: number;
  /** See ChannelInput.historyStart. */
  historyStart?: number | null;
}

export function buildPostsDashboard(input: PostsInput): PostsDashboardDto {
  const tz = input.page.timezone;
  const curDays = lastNDays(input.now, tz, input.days);
  const prevDays = previousDays(curDays);
  const curSet = new Set(curDays);
  const prevSet = new Set(prevDays);

  const byPost = groupMetricsByPost(input.metrics);
  const dailyMap = new Map(input.daily.map((r) => [r.day, r] as const));

  interface Row extends MeasuredPost { at: MetricFact | undefined; erAt: number | null }
  const rowsOf = (posts: readonly PostFact[]): Row[] =>
    measure(posts, byPost, tz).map((r) => {
      // 'latest' = numbers to date (freshest snapshot); milestones are strict.
      const rows = byPost.get(r.post.postId);
      const at = input.milestone === 'latest' ? latestMetric(rows) : rows?.find((m) => m.milestone === input.milestone);
      return { ...r, at, erAt: at ? erOf(at) : null };
    });
  const all = rowsOf(input.posts);
  const cur = all.filter((r) => curSet.has(r.day));
  const prev = all.filter((r) => prevSet.has(r.day));

  const prevKnown = input.historyStart == null || localDayStartSec(prevDays[0], tz) >= input.historyStart;
  const prevSnapshots = prevKnown && enoughCoverage(prev.filter((r) => r.at).length, prev.length);
  const prevDaily = prevKnown && enoughCoverage(prevDays.filter((d) => dailyMap.has(d)).length, prevDays.length);
  const erMedianCur = median(numbers(cur.map((r) => r.erAt)));
  const erMedianPrev = prevSnapshots ? median(numbers(prev.map((r) => r.erAt))) : null;
  const reachCur = sumNullable(curDays.map((d) => dailyMap.get(d)?.reach ?? null));
  const reachPrev = prevDaily ? sumNullable(prevDays.map((d) => dailyMap.get(d)?.reach ?? null)) : null;
  const commentsCur = sumNullable(cur.map((r) => r.metric?.comments ?? null));
  const prevMeasured = prevKnown && enoughCoverage(prev.filter((r) => r.metric).length, prev.length);
  const commentsPrev = prevMeasured ? sumNullable(prev.map((r) => r.metric?.comments ?? null)) : null;

  const rows = cur.map((r) => ({
    postId: r.post.postId,
    contentId: r.post.contentId,
    title: r.post.title,
    format: r.post.format,
    pillar: r.post.pillar,
    source: r.post.source,
    publishedAt: r.post.publishedAt as number | null,
    reach: r.at?.reach ?? null,
    er: r.erAt === null ? null : round(r.erAt, 2),
    index: r.erAt !== null && erMedianCur !== null && erMedianCur > 0 ? round(r.erAt / erMedianCur, 2) : null,
    comments: r.at?.comments ?? null,
    shares: r.at?.shares ?? null,
    avgWatchS: r.at?.avg_watch_s === null || r.at?.avg_watch_s === undefined ? null : round(r.at.avg_watch_s, 1),
  }));
  rows.sort((a, b) => {
    if (a.index === null && b.index !== null) return 1;
    if (b.index === null && a.index !== null) return -1;
    if (a.index !== null && b.index !== null && a.index !== b.index) return b.index - a.index;
    return (b.publishedAt ?? 0) - (a.publishedAt ?? 0);
  });

  const postsPerDay = new Map<string, number>();
  for (const r of cur) postsPerDay.set(r.day, (postsPerDay.get(r.day) ?? 0) + 1);

  return {
    page: { id: input.page.id, name: input.page.name },
    days: input.days,
    milestone: input.milestone,
    kpis: {
      posts: cur.length,
      postsDelta: prevKnown ? cur.length - prev.length : null,
      reach: reachCur,
      reachDeltaPct: pctChange(reachCur, reachPrev),
      erMedian: erMedianCur === null ? null : round(erMedianCur, 2),
      erDeltaPt: diff(erMedianCur, erMedianPrev, 2),
      comments: commentsCur,
      commentsDeltaPct: pctChange(commentsCur, commentsPrev),
      aiReplyRate: input.comments.needed > 0 ? round((input.comments.answered / input.comments.needed) * 100, 0) : null,
    },
    reachDaily: curDays.map((day) => ({ day, reach: dailyMap.get(day)?.reach ?? null, posts: postsPerDay.get(day) ?? 0 })),
    rows: rows.slice(0, input.limit ?? 300),
  };
}

// ── Post detail ────────────────────────────────────────────────────────

export interface PostDetailInput {
  post: PostFact;
  /** Snapshots of this post. */
  metrics: readonly MetricFact[];
  /** Snapshots of the Page's posts, all formats (for the median curve). */
  peerMetrics: readonly MetricFact[];
  comments: { total: number; answered: number };
  note: string | null;
}

export function buildPostDetail(input: PostDetailInput): PostDetailDto {
  const curve = MILESTONE_KEYS.map((milestone: Milestone) => ({
    milestone,
    reach: input.metrics.find((m) => m.milestone === milestone)?.reach ?? null,
  }));
  const medianCurve = MILESTONE_KEYS.map((milestone: Milestone) => {
    const m = median(numbers(input.peerMetrics.filter((p) => p.milestone === milestone).map((p) => p.reach)));
    return { milestone, reach: m === null ? null : Math.round(m) };
  });
  const latest = latestMetric(input.metrics);
  return {
    postId: input.post.postId,
    title: input.post.title,
    format: input.post.format,
    pillar: input.post.pillar,
    publishedAt: input.post.publishedAt,
    permalink: input.post.permalink,
    curve,
    medianCurve,
    stats: {
      views3s: latest?.video_views_3s ?? null,
      avgWatchS: latest?.avg_watch_s ?? null,
      videoLengthS: latest?.video_length_s ?? null,
      follows: latest?.follows ?? null,
      comments: latest?.comments ?? null,
      commentsReplied: input.comments.total > 0 ? input.comments.answered : null,
      shares: latest?.shares ?? null,
    },
    note: input.note,
  };
}
