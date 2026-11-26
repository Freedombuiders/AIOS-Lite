// provides.contentFeed: the durable feed of published posts and changed metric snapshots, and a read of
// one post with its lineage and every snapshot. Contract: modules/_lib/content-feed.ts.
import type { ContentFeed, ContentFeedPage, ContentWithLineage } from '../../_lib/content-feed.js';
import { getFbContent, listFbContentFeedSince, listFbPostMetricsForPost, listPublishedFbContentIds } from './store.js';
import { lineageOf } from './core/dto.js';
import { erOf } from './analytics/metrics.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function since(cursor: number, limit: number = DEFAULT_LIMIT): ContentFeedPage {
  if (!Number.isInteger(cursor) || cursor < 0) throw new Error('Con trỏ của luồng nội dung phải là số nguyên không âm.');
  const n = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_LIMIT) : DEFAULT_LIMIT;
  const rows = listFbContentFeedSince(cursor, n);
  return {
    events: rows.map((r) => ({ id: r.id, kind: r.kind, contentId: r.content_id, postId: r.post_id, milestone: r.milestone, at: r.at })),
    cursor: rows.length ? rows[rows.length - 1].id : cursor,
  };
}

function get(contentId: number): ContentWithLineage | undefined {
  const row = Number.isInteger(contentId) ? getFbContent(contentId) : undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    pageId: row.page_id,
    status: row.status,
    format: row.format,
    title: row.title,
    caption: row.caption,
    pillar: row.pillar,
    hookType: row.hook_type,
    source: row.source,
    origin: row.origin,
    fbPostId: row.fb_post_id,
    permalink: row.permalink,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    lineage: lineageOf(row),
    snapshots: row.fb_post_id
      ? listFbPostMetricsForPost(row.fb_post_id).map((m) => ({
        milestone: m.milestone,
        capturedAt: m.captured_at,
        reach: m.reach,
        impressions: m.impressions,
        reactions: m.reactions,
        comments: m.comments,
        shares: m.shares,
        clicks: m.clicks,
        videoViews3s: m.video_views_3s,
        avgWatchS: m.avg_watch_s,
        videoLengthS: m.video_length_s,
        follows: m.follows,
        saves: m.saves,
        er: erOf(m),
      }))
      : [],
  };
}

function publishedSince(sinceSec: number, afterId = 0, limit: number = DEFAULT_LIMIT): number[] {
  if (!Number.isFinite(sinceSec)) throw new Error('Mốc thời gian phải là số giây.');
  if (!Number.isInteger(afterId) || afterId < 0) throw new Error('Mã bài bắt đầu phải là số nguyên không âm.');
  const n = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_LIMIT) : DEFAULT_LIMIT;
  return listPublishedFbContentIds(Math.floor(sinceSec), afterId, n);
}

export function createContentFeed(): ContentFeed {
  return { since, get, publishedSince };
}
