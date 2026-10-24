/**
 * Talks to Facebook (through ../composio.ts only) and writes posts, post
 * snapshots and Page daily numbers to SQLite. Orchestrated by worker.ts.
 *
 * Meta renamed several insight metrics in 2025 (impressions → "views"). We
 * ask for the names the Composio tool lists as valid, store whatever comes
 * back, keep nulls for the rest and never fail a whole snapshot on one metric.
 * Typed Composio errors (expired connection, rate limit, budget) always
 * propagate so the caller can stop and back off.
 */

import {
  listFbAnalyticsPosts,
  listFbPostMetrics,
  type FbAnalyticsPostRow,
  setFbAnalyticsPageFollowers,
  upsertFbPageDaily,
  upsertFbPostMetrics,
  upsertImportedFbPost,
  type FbAnalyticsPageRow,
  type FbPostMetricsRow,
} from '../store.js';
import { logger } from '../compat.js';
import {
  ComposioAuthError,
  ComposioConnectionExpiredError,
  ComposioRateLimitError,
  FbBudgetExceeded,
  execute,
  graphAsPage,
  type FbCallTarget,
} from '../../../_lib/composio.js';
import {
  pageInsightsToDaily,
  parsePagePosts,
  parsePostInsights,
  parseVideoId,
  parseVideoInsights,
  titleFromMessage,
  toNumber,
  type PageDailyValues,
  type ParsedPost,
} from './parse.js';
import { MAX_MILESTONE_AGE_SEC, dueMilestone } from './schedule.js';
import { localDay, localDayStartSec, safeTimezone } from './time.js';

/** Fields for a full post read: import (caption, format) and engagement counts in one call. */
export const POST_FIELDS = 'id,message,created_time,permalink_url,status_type,attachments,reactions.summary(true),comments.summary(true),shares';
/** Fields when only the counts are needed. */
export const COUNT_FIELDS = 'id,created_time,reactions.summary(true),comments.summary(true),shares';

export const POST_REACH_METRIC = 'post_total_media_view_unique';
export const POST_VIEWS_METRIC = 'post_media_view';
export const PAGE_METRICS = [
  'page_follows', 'page_daily_follows_unique', 'page_daily_unfollows_unique',
  'page_total_media_view_unique', 'page_media_view', 'page_post_engagements', 'page_total_actions',
];

const PAGE_SIZE = 100;
const MAX_POST_PAGES = 12;
/** Posts younger than this are left to the publisher, which records its own fb_post_id. */
const IMPORT_MIN_AGE_SEC = 600;
const PAGE_DAILY_WINDOW_DAYS = 60;

export function targetOf(page: FbAnalyticsPageRow): FbCallTarget {
  return { area: 'analytics', connectionId: page.connection_id, entityId: page.entity_id };
}

/** Errors that must stop the whole page cycle instead of being absorbed per item. */
export function isStopError(err: unknown): boolean {
  return err instanceof ComposioConnectionExpiredError
    || err instanceof ComposioRateLimitError
    || err instanceof FbBudgetExceeded
    || err instanceof ComposioAuthError;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function looksLikeMetricError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  if (/does not exist|unsupported get|cannot be loaded|not found|permission/.test(msg)) return false;
  return /metric|invalid parameter|#100|deprecated|not supported|unsupported|invalid/.test(msg);
}

// ── Posts ──────────────────────────────────────────────────────────────

/**
 * Reads Page posts from `sinceSec` on. The tool has no cursor input, so a
 * full page (100) is followed by another call with `until` set to the oldest
 * created_time seen; ids are de-duplicated.
 */
export async function fetchPagePosts(
  target: FbCallTarget,
  pageId: string,
  opts: { sinceSec: number; fields: string },
): Promise<ParsedPost[]> {
  const seen = new Map<string, ParsedPost>();
  let until: number | null = null;
  for (let i = 0; i < MAX_POST_PAGES; i++) {
    const raw = await execute('FACEBOOK_GET_PAGE_POSTS', {
      page_id: pageId,
      limit: PAGE_SIZE,
      fields: opts.fields,
      since: String(opts.sinceSec),
      ...(until !== null ? { until: String(until) } : {}),
    }, target);
    const batch = parsePagePosts(raw);
    let added = 0;
    for (const p of batch) {
      if (!seen.has(p.id)) { seen.set(p.id, p); added++; }
    }
    if (batch.length < PAGE_SIZE || added === 0) break;
    const oldest = Math.min(...batch.map((p) => p.createdAt ?? Infinity));
    if (!Number.isFinite(oldest) || (until !== null && oldest >= until)) break;
    until = oldest;
  }
  return [...seen.values()];
}

export interface PostInsightValues {
  reach: number | null;
  impressions: number | null;
  raw: Record<string, number | null>;
}

const EMPTY_INSIGHTS: PostInsightValues = { reach: null, impressions: null, raw: {} };

/**
 * Metric sets tried in order; the next one is used only when the tool rejects
 * the metrics. The tool silently ignores every other metric name (it answers
 * with post_media_view), so nothing else is requested.
 */
const POST_METRIC_ATTEMPTS = [
  [POST_REACH_METRIC, POST_VIEWS_METRIC],
  [POST_REACH_METRIC],
  [POST_VIEWS_METRIC],
];

export async function captureInsights(target: FbCallTarget, postId: string): Promise<PostInsightValues> {
  for (const metrics of POST_METRIC_ATTEMPTS) {
    try {
      const raw = await execute('FACEBOOK_GET_POST_INSIGHTS', { post_id: postId, metrics: metrics.join(',') }, target);
      const values = parsePostInsights(raw);
      return {
        reach: values[POST_REACH_METRIC] ?? values.post_impressions_unique ?? null,
        impressions: values[POST_VIEWS_METRIC] ?? values.post_impressions ?? null,
        raw: values,
      };
    } catch (err) {
      if (isStopError(err)) throw err;
      if (!looksLikeMetricError(err)) {
        logger.warn({ postId: postId.replace(/\d{6,}/g, ':id'), err: String((err as Error)?.message ?? err).slice(0, 120) }, 'fbstudio post insights failed');
        return EMPTY_INSIGHTS;
      }
    }
  }
  return EMPTY_INSIGHTS;
}

// ── Video / Reel details ───────────────────────────────────────────────

/** What we remember about a post's video so later snapshots cost one call, not three. id null = checked, no video. */
export interface VideoRef {
  id: string | null;
  lengthS: number | null;
}

export interface VideoValues {
  ref: VideoRef;
  plays: number | null;
  avgWatchS: number | null;
  follows: number | null;
}

/** post_id → video reference, read back from the raw_json of earlier snapshots. */
export function videoRefsFromMetrics(rows: readonly { post_id: string; raw_json: string }[]): Map<string, VideoRef> {
  const out = new Map<string, VideoRef>();
  for (const r of rows) {
    try {
      const v = (JSON.parse(r.raw_json) as { video?: { id?: unknown; lengthS?: unknown } }).video;
      if (!v || (v.id !== null && typeof v.id !== 'string')) continue;
      const prev = out.get(r.post_id);
      const lengthS = typeof v.lengthS === 'number' ? v.lengthS : null;
      if (!prev || (prev.lengthS === null && lengthS !== null)) out.set(r.post_id, { id: v.id as string | null, lengthS });
    } catch { /* unreadable raw_json: no cached reference */ }
  }
  return out;
}

/**
 * Plays, average watch time, followers and length of a Reel / video post.
 * Needs the post → video id mapping (one GET as the Page), then
 * /{video}/video_insights (every time) and /{video}?fields=length (once).
 * Failures other than typed ones leave the video fields null.
 */
export async function captureVideo(
  page: FbAnalyticsPageRow,
  postId: string,
  cached: VideoRef | undefined,
): Promise<VideoValues> {
  const target = targetOf(page);
  const empty: VideoValues = { ref: cached ?? { id: null, lengthS: null }, plays: null, avgWatchS: null, follows: null };
  try {
    let ref = cached;
    if (!ref) {
      const res = await graphAsPage(page.id, {
        method: 'GET',
        path: `/${postId}`,
        query: { fields: 'attachments{media_type,target{id},type},permalink_url' },
      }, target);
      ref = { id: parseVideoId(res.data), lengthS: null };
    }
    if (!ref.id) return { ...empty, ref };
    const insights = await graphAsPage(page.id, { method: 'GET', path: `/${ref.id}/video_insights` }, target);
    const parsed = parseVideoInsights(insights.data);
    if (ref.lengthS === null) {
      try {
        const info = await graphAsPage<{ length?: unknown }>(page.id, { method: 'GET', path: `/${ref.id}`, query: { fields: 'length' } }, target);
        ref = { ...ref, lengthS: toNumber(info.data?.length) };
      } catch (err) {
        if (isStopError(err)) throw err;
      }
    }
    return { ref, plays: parsed.plays, avgWatchS: parsed.avgWatchS, follows: parsed.follows };
  } catch (err) {
    if (isStopError(err)) throw err;
    logger.warn({ postId: postId.replace(/\d{6,}/g, ':id'), err: String((err as Error)?.message ?? err).slice(0, 120) }, 'fbstudio video insights failed');
    return empty;
  }
}

export function isVideoFormat(format: string): boolean {
  return format === 'reel' || format === 'video';
}

export function buildMetricRow(
  pageId: string,
  postId: string,
  milestone: string,
  capturedAt: number,
  counts: ParsedPost | undefined,
  ins: PostInsightValues,
  video?: VideoValues | null,
): FbPostMetricsRow {
  return {
    post_id: postId,
    page_id: pageId,
    milestone,
    captured_at: capturedAt,
    reach: ins.reach,
    impressions: ins.impressions,
    reactions: counts?.reactions ?? null,
    comments: counts?.comments ?? null,
    shares: counts ? counts.shares : null,
    clicks: null,
    video_views_3s: video?.plays ?? null,
    avg_watch_s: video?.avgWatchS ?? null,
    video_length_s: video?.ref.lengthS ?? null,
    follows: video?.follows ?? null,
    saves: null,
    raw_json: JSON.stringify({ insights: ins.raw, ...(video ? { video: video.ref } : {}) }),
  };
}

/** Insights plus, for Reels and videos, the video details; one snapshot row for a post. */
async function snapshotRow(
  page: FbAnalyticsPageRow,
  post: FbAnalyticsPostRow,
  milestone: string,
  now: number,
  counts: ParsedPost | undefined,
  refs: Map<string, VideoRef>,
): Promise<FbPostMetricsRow> {
  const ins = await captureInsights(targetOf(page), post.fb_post_id);
  let video: VideoValues | null = null;
  if (isVideoFormat(post.format)) {
    video = await captureVideo(page, post.fb_post_id, refs.get(post.fb_post_id));
    refs.set(post.fb_post_id, video.ref);
  }
  return buildMetricRow(page.id, post.fb_post_id, milestone, now, counts, ins, video);
}

// ── Page daily ─────────────────────────────────────────────────────────

/** Reads the last ~60 days of daily Page insights and merges them into fb_page_daily. Returns days written. */
export async function syncPageDaily(page: FbAnalyticsPageRow, now: number): Promise<number> {
  const target = targetOf(page);
  const base = { page_id: page.id, period: 'day', since: String(now - PAGE_DAILY_WINDOW_DAYS * 86400), until: String(now) };
  const merged = new Map<string, PageDailyValues>();
  const fold = (raw: unknown) => {
    for (const [day, values] of pageInsightsToDaily(raw)) merged.set(day, { ...merged.get(day), ...values });
  };

  try {
    fold(await execute('FACEBOOK_GET_PAGE_INSIGHTS', { ...base, metrics: PAGE_METRICS.join(',') }, target));
  } catch (err) {
    if (isStopError(err)) throw err;
    // Not every metric/period combination is valid and one bad name fails the call: ask one by one.
    logger.warn({ pageId: page.id }, 'fbstudio page insights rejected as a set, retrying per metric');
    for (const metric of PAGE_METRICS) {
      try {
        fold(await execute('FACEBOOK_GET_PAGE_INSIGHTS', { ...base, metrics: metric }, target));
      } catch (inner) {
        if (isStopError(inner)) throw inner;
        logger.warn({ pageId: page.id, metric }, 'fbstudio page insight metric unavailable');
      }
    }
  }

  let latestDay = '';
  let latestFollowers: number | null = null;
  for (const [day, v] of merged) {
    upsertFbPageDaily({
      page_id: page.id,
      day,
      reach: v.reach ?? null,
      impressions: v.impressions ?? null,
      engaged_users: v.engaged_users ?? null,
      new_follows: v.new_follows ?? null,
      unfollows: v.unfollows ?? null,
      followers_total: v.followers_total ?? null,
      link_clicks: v.link_clicks ?? null,
      messages: null,
      raw_json: JSON.stringify(v),
      captured_at: now,
    });
    if (v.followers_total !== undefined && day > latestDay) { latestDay = day; latestFollowers = v.followers_total; }
  }
  if (latestFollowers !== null) setFbAnalyticsPageFollowers(page.id, Math.round(latestFollowers));
  return merged.size;
}

// ── Import + latest snapshot ───────────────────────────────────────────

export interface SyncOptions {
  now: number;
  /** Import posts created within this many days. */
  importDays: number;
  /** Take a 'latest' snapshot of published posts younger than this many days. */
  snapshotDays: number;
  /**
   * Posts older than snapshotDays and up to this many days old that have no
   * snapshot at all get one too, so the previous period of a 28 day view is
   * not empty. Cheap once covered: posts that already have a row are skipped.
   */
  backfillDays?: number;
  /** Re-snapshot posts already captured today (manual refresh). */
  force?: boolean;
  /** Pause between per-post calls. */
  pauseMs?: number;
}

export interface SyncResult {
  fetched: number;
  imported: number;
  snapshots: number;
  dailyDays: number;
}

export async function syncPage(page: FbAnalyticsPageRow, opts: SyncOptions): Promise<SyncResult> {
  const { now } = opts;
  const target = targetOf(page);
  const pauseMs = opts.pauseMs ?? 150;
  const tz = safeTimezone(page.timezone);
  const result: SyncResult = { fetched: 0, imported: 0, snapshots: 0, dailyDays: 0 };

  // 1. Posts: import new ones and keep the engagement counts of all of them.
  const backfillDays = Math.max(opts.backfillDays ?? 0, opts.snapshotDays);
  const windowDays = Math.max(opts.importDays, backfillDays);
  const posts = await fetchPagePosts(target, page.id, { sinceSec: now - windowDays * 86400, fields: POST_FIELDS });
  result.fetched = posts.length;
  const importFrom = now - opts.importDays * 86400;
  for (const p of posts) {
    if (p.createdAt === null || p.createdAt < importFrom || now - p.createdAt < IMPORT_MIN_AGE_SEC) continue;
    const { created } = upsertImportedFbPost({
      pageId: page.id,
      fbPostId: p.id,
      title: titleFromMessage(p.message),
      caption: p.message,
      format: p.format,
      publishedAt: p.createdAt,
      permalink: p.permalink,
      linkUrl: p.linkUrl,
    });
    if (created) result.imported++;
  }

  // 2. Page daily numbers.
  result.dailyDays = await syncPageDaily(page, now);

  // 3. 'latest' snapshot for every published post in the window, plus a one-off
  // backfill for older posts that have never been captured.
  const counts = new Map(posts.map((p) => [p.id, p] as const));
  const todayStart = localDayStartSec(localDay(now, tz), tz);
  const existing = listFbPostMetrics(page.id, now - backfillDays * 86400);
  const refs = videoRefsFromMetrics(existing);
  const hasAnyRow = new Set(existing.map((m) => m.post_id));
  const alreadyToday = new Set(
    opts.force ? [] : existing.filter((m) => m.milestone === 'latest' && m.captured_at >= todayStart).map((m) => m.post_id),
  );
  const recentFrom = now - opts.snapshotDays * 86400;
  const targets = listFbAnalyticsPosts(page.id, now - backfillDays * 86400);
  for (const post of targets) {
    const recent = (post.published_at as number) >= recentFrom;
    if (recent ? alreadyToday.has(post.fb_post_id) : hasAnyRow.has(post.fb_post_id)) continue;
    const c = counts.get(post.fb_post_id);
    if (!c) continue; // not on the Page any more (deleted on Facebook)
    upsertFbPostMetrics(await snapshotRow(page, post, 'latest', now, c, refs));
    result.snapshots++;
    await sleep(pauseMs);
  }
  return result;
}

// ── Milestones ─────────────────────────────────────────────────────────

/** Captures every milestone that is due now (1h … 28d, skipped when over 2× late). Returns snapshots written. */
export async function captureDueMilestones(
  page: FbAnalyticsPageRow,
  now: number,
  opts: { pauseMs?: number } = {},
): Promise<number> {
  const since = now - MAX_MILESTONE_AGE_SEC;
  const posts = listFbAnalyticsPosts(page.id, since);
  if (posts.length === 0) return 0;
  const captured = new Map<string, Set<string>>();
  for (const m of listFbPostMetrics(page.id, since)) {
    const set = captured.get(m.post_id);
    if (set) set.add(m.milestone); else captured.set(m.post_id, new Set([m.milestone]));
  }
  const due = posts
    .map((post) => ({ post, milestone: dueMilestone(post.published_at as number, now, captured.get(post.fb_post_id) ?? new Set()) }))
    .filter((d): d is { post: typeof d.post; milestone: NonNullable<typeof d.milestone> } => d.milestone !== null);
  if (due.length === 0) return 0;

  const target = targetOf(page);
  const oldest = Math.min(...due.map((d) => d.post.published_at as number));
  let counts = new Map<string, ParsedPost>();
  try {
    const list = await fetchPagePosts(target, page.id, { sinceSec: oldest - 3600, fields: COUNT_FIELDS });
    counts = new Map(list.map((p) => [p.id, p] as const));
  } catch (err) {
    if (isStopError(err)) throw err;
    logger.warn({ pageId: page.id }, 'fbstudio engagement counts unavailable for milestone capture');
  }

  const refs = videoRefsFromMetrics(listFbPostMetrics(page.id, since));
  let written = 0;
  for (const d of due) {
    const c = counts.get(d.post.fb_post_id);
    if (!c && counts.size > 0) continue; // gone from the Page
    upsertFbPostMetrics(await snapshotRow(page, d.post, d.milestone, now, c, refs));
    written++;
    await sleep(opts.pauseMs ?? 150);
  }
  return written;
}
