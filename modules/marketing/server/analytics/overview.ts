/**
 * Tổng quan "Hiệu quả nội dung": one cross-Page summary for a date range and
 * the range before it. Read-only, SQLite only. Metric definitions follow
 * metrics.ts: reach = people who saw the post, interactions = reactions +
 * comments + shares, rate = interactions ÷ reach. Per-post numbers are the
 * 'latest' snapshot (numbers to date), so a post's figures are attributed to
 * its publish day. Unknown is null, never 0.
 */

import {
  countFbOverviewComments,
  getFbOverviewLastFetchAt,
  listFbOverviewPages,
  listFbOverviewPosts,
  type FbOverviewPostRow,
} from '../store.js';

export const OVERVIEW_MAX_DAYS = 366;
const TZ_OFFSET_SEC = 7 * 3600; // Asia/Ho_Chi_Minh has no DST
const DAY = 86400;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface OverviewPeriod {
  posts: number;
  /** sum of reach over posts that have a snapshot; null when none has */
  reach: number | null;
  interactions: number | null;
  /** interactions ÷ reach over the posts that have both; null when none */
  engagementRate: number | null;
  clicks: number | null;
  commentsReceived: number | null;
  commentsReplied: number | null;
  /** posts of the period that have a metrics snapshot */
  postsWithMetrics: number;
}

export interface OverviewDayPoint {
  day: string;
  posts: number;
  reach: number | null;
  interactions: number | null;
}

export interface OverviewTopPost {
  postId: string;
  pageId: string;
  pageName: string;
  snippet: string;
  publishedAt: number;
  reach: number | null;
  interactions: number;
  permalink: string;
}

export interface OverviewPageRow {
  pageId: string;
  pageName: string;
  posts: number;
  reach: number | null;
  interactions: number | null;
}

export interface MarketingOverviewDto {
  range: { from: string; to: string; prevFrom: string; prevTo: string; days: number };
  current: OverviewPeriod;
  previous: OverviewPeriod;
  /** how `daily` is built: each post's latest numbers sit on the day it was published */
  dailyBasis: 'post-publish-day';
  daily: OverviewDayPoint[];
  topPosts: OverviewTopPost[];
  pages: OverviewPageRow[];
  /** latest time any metric snapshot was stored (unix s); null = never fetched */
  metricsFetchedAt: number | null;
  /** at least one connected Page exists */
  hasPages: boolean;
}

export function parseDay(s: string): number | null {
  if (!DAY_RE.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== s) return null;
  return t / 1000;
}

function dayStartSec(day: string): number { return (parseDay(day) as number) - TZ_OFFSET_SEC; }
function dayKey(sec: number): string { return new Date((sec + TZ_OFFSET_SEC) * 1000).toISOString().slice(0, 10); }
function addDays(day: string, n: number): string { return new Date(((parseDay(day) as number) + n * DAY) * 1000).toISOString().slice(0, 10); }

function sumOrNull(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
}

function interactionsOf(r: FbOverviewPostRow): number | null {
  return sumOrNull([r.reactions, r.comments, r.shares]);
}

function summarize(rows: FbOverviewPostRow[], fromSec: number, toSec: number): OverviewPeriod {
  const withReach = rows.filter((r) => r.reach !== null && r.reach > 0 && interactionsOf(r) !== null);
  const rateReach = sumOrNull(withReach.map((r) => r.reach));
  const rateInter = sumOrNull(withReach.map(interactionsOf));
  const c = countFbOverviewComments(fromSec, toSec);
  return {
    posts: rows.length,
    reach: sumOrNull(rows.map((r) => r.reach)),
    interactions: sumOrNull(rows.map(interactionsOf)),
    engagementRate: rateReach !== null && rateReach > 0 && rateInter !== null ? rateInter / rateReach : null,
    clicks: sumOrNull(rows.map((r) => r.clicks)),
    commentsReceived: c.synced ? c.received : null,
    commentsReplied: c.synced ? c.replied : null,
    postsWithMetrics: rows.filter((r) => r.captured_at !== null).length,
  };
}

function snippetOf(r: FbOverviewPostRow): string {
  const text = (r.title.trim() || r.caption.trim()).replace(/\s+/g, ' ');
  return text.length > 90 ? `${text.slice(0, 89)}…` : text || '(không có nội dung)';
}

/** null = invalid input (message in `error`). */
export function buildMarketingOverview(q: { from: string; to: string; prevFrom?: string; prevTo?: string }): MarketingOverviewDto | { error: string } {
  const f = parseDay(q.from);
  const t = parseDay(q.to);
  if (f === null || t === null) return { error: 'from và to phải có dạng YYYY-MM-DD' };
  if (t < f) return { error: 'to phải sau hoặc bằng from' };
  const days = Math.round((t - f) / DAY) + 1;
  if (days > OVERVIEW_MAX_DAYS) return { error: `Tối đa ${OVERVIEW_MAX_DAYS} ngày` };
  const prevTo = q.prevTo ?? addDays(q.from, -1);
  const prevFrom = q.prevFrom ?? addDays(prevTo, -(days - 1));
  const pf = parseDay(prevFrom);
  const pt = parseDay(prevTo);
  if (pf === null || pt === null || pt < pf) return { error: 'prevFrom và prevTo không hợp lệ' };
  if (Math.round((pt - pf) / DAY) + 1 > OVERVIEW_MAX_DAYS) return { error: `Tối đa ${OVERVIEW_MAX_DAYS} ngày` };

  const curFrom = dayStartSec(q.from);
  const curTo = dayStartSec(q.to) + DAY;
  const prvFrom = dayStartSec(prevFrom);
  const prvTo = dayStartSec(prevTo) + DAY;
  const cur = listFbOverviewPosts(curFrom, curTo);
  const prev = listFbOverviewPosts(prvFrom, prvTo);

  const daily: OverviewDayPoint[] = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(q.from, i);
    const rows = cur.filter((r) => dayKey(r.published_at) === day);
    daily.push({ day, posts: rows.length, reach: sumOrNull(rows.map((r) => r.reach)), interactions: sumOrNull(rows.map(interactionsOf)) });
  }

  const topPosts = cur
    .map((r) => ({ r, inter: interactionsOf(r) }))
    .filter((x): x is { r: FbOverviewPostRow; inter: number } => x.inter !== null)
    .sort((a, b) => b.inter - a.inter || b.r.published_at - a.r.published_at)
    .slice(0, 5)
    .map(({ r, inter }): OverviewTopPost => ({
      postId: r.fb_post_id, pageId: r.page_id, pageName: r.page_name ?? r.page_id, snippet: snippetOf(r),
      publishedAt: r.published_at, reach: r.reach, interactions: inter, permalink: r.permalink,
    }));

  const pageList = listFbOverviewPages();
  const byPage = new Map<string, FbOverviewPostRow[]>();
  for (const r of cur) byPage.set(r.page_id, [...(byPage.get(r.page_id) ?? []), r]);
  const pages: OverviewPageRow[] = pageList
    .filter((p) => p.enabled === 1 || byPage.has(p.id))
    .map((p) => {
      const rows = byPage.get(p.id) ?? [];
      return { pageId: p.id, pageName: p.name, posts: rows.length, reach: sumOrNull(rows.map((r) => r.reach)), interactions: sumOrNull(rows.map(interactionsOf)) };
    })
    .sort((a, b) => (b.interactions ?? -1) - (a.interactions ?? -1) || b.posts - a.posts);

  return {
    range: { from: q.from, to: q.to, prevFrom, prevTo, days },
    current: summarize(cur, curFrom, curTo),
    previous: summarize(prev, prvFrom, prvTo),
    dailyBasis: 'post-publish-day',
    daily,
    topPosts,
    pages,
    metricsFetchedAt: getFbOverviewLastFetchAt(),
    hasPages: pageList.some((p) => p.enabled === 1),
  };
}
