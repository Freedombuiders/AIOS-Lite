/**
 * Loads rows from SQLite and feeds the pure builders in metrics.ts. This is
 * the read side of analytics: dashboards never call Facebook.
 */

import {
  countFbCommentsAnswered,
  countFbPostCommentsAnswered,
  getFbAnalyticsPage,
  getFbAnalyticsPostByFbId,
  getLastFbSnapshotAt,
  getFbSetting,
  getLatestFbInsight,
  listFbAnalyticsPosts,
  listFbPageDaily,
  listFbPostMetrics,
  listFbPostMetricsForPost,
  type FbAnalyticsPageRow,
  type FbAnalyticsPostRow,
} from '../store.js';
import type { ChannelDashboardDto, FbFormat, FbPillar, PostDetailDto, PostsDashboardDto } from '../types.js';
import {
  FORMATS,
  buildChannelDashboard,
  buildPostDetail,
  buildPostsDashboard,
  medianErForPeriod,
  previousDays,
  type PostFact,
} from './metrics.js';
import { IMPORT_DAYS } from './schedule.js';
import { addDays, lastNDays, localDayStartSec, safeTimezone } from './time.js';

export const MAX_DAYS = 90;

function nowSec(): number { return Math.floor(Date.now() / 1000); }

export function clampDays(raw: unknown, fallback = 28): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, MAX_DAYS);
}

function parsePillars(json: string): FbPillar[] {
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter((p): p is { name: string; targetPct?: number } => typeof p === 'object' && p !== null && typeof (p as { name?: unknown }).name === 'string')
      .map((p) => ({ name: p.name, targetPct: Number(p.targetPct) || 0 }));
  } catch {
    return [];
  }
}

export function pillarsOf(page: FbAnalyticsPageRow): FbPillar[] {
  return parsePillars(page.pillars_json);
}

function toFormat(f: string): FbFormat {
  return (FORMATS as string[]).includes(f) ? (f as FbFormat) : 'text';
}

export function toPostFact(r: FbAnalyticsPostRow): PostFact {
  return {
    postId: r.fb_post_id,
    contentId: r.content_id,
    title: r.title,
    format: toFormat(r.format),
    pillar: r.pillar,
    source: r.source,
    publishedAt: r.published_at as number,
    permalink: r.permalink,
  };
}

/** Earliest instant covering the current and the previous period of `days` local days. */
function windowStart(now: number, tz: string, days: number): { sinceSec: number; firstDay: string; today: string } {
  const cur = lastNDays(now, tz, days);
  const firstDay = previousDays(cur)[0];
  return { sinceSec: localDayStartSec(firstDay, tz), firstDay, today: cur[cur.length - 1] };
}

/** The earliest instant imports reached back to, or null when the Page was never imported. */
function historyStartOf(pageId: string): number | null {
  const importedAt = Number(getFbSetting(`analytics.import.${pageId}`));
  return Number.isFinite(importedAt) && importedAt > 0 ? importedAt - IMPORT_DAYS * 86400 : null;
}

function readInsight(pageId: string): ChannelDashboardDto['insight'] {
  const row = getLatestFbInsight(pageId, 'channel');
  if (!row) return null;
  try {
    const body = JSON.parse(row.body_json) as { summary?: unknown; actions?: unknown };
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
    return { summary: strings(body.summary), actions: strings(body.actions), createdAt: row.created_at };
  } catch {
    return null;
  }
}

/** Median ER of the last 28 days (FbPageDto.stats.er28d); null without data. */
export function pageEr28d(pageId: string, now = nowSec()): number | null {
  const page = getFbAnalyticsPage(pageId);
  if (!page) return null;
  const tz = safeTimezone(page.timezone);
  const { sinceSec } = windowStart(now, tz, 28);
  const posts = listFbAnalyticsPosts(pageId, sinceSec).map(toPostFact);
  return medianErForPeriod(posts, listFbPostMetrics(pageId, sinceSec), now, tz, 28);
}

export function loadChannelDashboard(pageId: string, days: number, now = nowSec()): ChannelDashboardDto | null {
  const page = getFbAnalyticsPage(pageId);
  if (!page) return null;
  const tz = safeTimezone(page.timezone);
  const { sinceSec, firstDay, today } = windowStart(now, tz, days);
  const posts = listFbAnalyticsPosts(pageId, sinceSec).map(toPostFact);
  const metrics = listFbPostMetrics(pageId, sinceSec);
  const er28d = days === 28 ? undefined : medianErForPeriod(
    listFbAnalyticsPosts(pageId, windowStart(now, tz, 28).sinceSec).map(toPostFact),
    listFbPostMetrics(pageId, windowStart(now, tz, 28).sinceSec), now, tz, 28,
  );
  return buildChannelDashboard({
    page: { id: page.id, name: page.name, role: page.role, mainKpi: page.main_kpi, followers: page.followers, timezone: tz, pillars: pillarsOf(page) },
    now,
    days,
    posts,
    metrics,
    daily: listFbPageDaily(pageId, firstDay, addDays(today, 1)),
    insight: readInsight(pageId),
    lastSnapshotAt: getLastFbSnapshotAt(pageId),
    historyStart: historyStartOf(pageId),
    ...(er28d !== undefined ? { er28d } : {}),
  });
}

export function loadPostsDashboard(
  pageId: string,
  days: number,
  milestone: PostsDashboardDto['milestone'],
  now = nowSec(),
): PostsDashboardDto | null {
  const page = getFbAnalyticsPage(pageId);
  if (!page) return null;
  const tz = safeTimezone(page.timezone);
  const { sinceSec, firstDay, today } = windowStart(now, tz, days);
  const currentStart = localDayStartSec(lastNDays(now, tz, days)[0], tz);
  return buildPostsDashboard({
    page: { id: page.id, name: page.name, timezone: tz },
    now,
    days,
    milestone,
    posts: listFbAnalyticsPosts(pageId, sinceSec).map(toPostFact),
    metrics: listFbPostMetrics(pageId, sinceSec),
    daily: listFbPageDaily(pageId, firstDay, addDays(today, 1)),
    historyStart: historyStartOf(pageId),
    comments: (() => {
      const c = countFbCommentsAnswered(pageId, currentStart);
      return { needed: c.needed, answered: c.answered };
    })(),
  });
}

export function loadPostDetail(postId: string): PostDetailDto | null {
  const row = getFbAnalyticsPostByFbId(postId);
  if (!row || row.published_at === null) return null;
  const post = toPostFact(row);
  const since = post.publishedAt - 180 * 86400;
  // The median curve is over every post of the Page, whatever the format.
  const peerMetrics = listFbPostMetrics(row.page_id, since);
  const noteRow = getLatestFbInsight(row.page_id, 'post', postId);
  let note: string | null = null;
  if (noteRow) {
    try {
      const body = JSON.parse(noteRow.body_json) as { note?: unknown };
      if (typeof body.note === 'string' && body.note.trim()) note = body.note.trim();
    } catch { /* unreadable note: show none */ }
  }
  const c = countFbPostCommentsAnswered(postId);
  return buildPostDetail({
    post,
    metrics: listFbPostMetricsForPost(postId),
    peerMetrics,
    comments: c,
    note,
  });
}
