/**
 * Contract of the marketing module's durable content feed (provides it as `contentFeed`; another module
 * reads it through `ctx.modules.get('marketing')`). Module events are not used for this: the SDK prefixes
 * event names with the listener's own module id, and in-memory events are lost on restart. The feed is a
 * table written in the same transaction as the change, so a consumer that keeps its own cursor and calls
 * `since(cursor)` at start and on each pass sees every event once, in order.
 */
import type { FbContentLineage } from './fb-types.js';

export type ContentFeedKind = 'published' | 'snapshot';

export interface ContentFeedEvent {
  /** Increasing; pass the last one seen (or the returned `cursor`) to the next `since`. */
  id: number;
  /** 'published': the post went live. 'snapshot': a metrics snapshot of the post changed. */
  kind: ContentFeedKind;
  contentId: number;
  /** Facebook post id, when known. */
  postId: string | null;
  /** Metric milestone (1h|6h|24h|3d|7d|28d|latest) for 'snapshot'; null for 'published'. */
  milestone: string | null;
  /** Unix seconds the event was written. */
  at: number;
}

export interface ContentFeedPage {
  events: ContentFeedEvent[];
  /** The id of the last event returned, or the cursor passed in when there was nothing new. */
  cursor: number;
}

export interface ContentSnapshot {
  milestone: string;
  capturedAt: number;
  reach: number | null;
  impressions: number | null;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
  videoViews3s: number | null;
  avgWatchS: number | null;
  videoLengthS: number | null;
  follows: number | null;
  saves: number | null;
  /**
   * Engagement rate in % ((reactions + comments + shares) ÷ reach × 100), computed by marketing's own metric
   * function so every reader uses the same formula. null without reach or counts: never 0 for "unknown".
   */
  er: number | null;
}

/** A content row with its lineage and every per-milestone snapshot of its Facebook post. */
export interface ContentWithLineage {
  id: number;
  pageId: string | null;
  status: string;
  format: string;
  title: string;
  caption: string;
  pillar: string;
  hookType: string;
  /** 'user' or an agent id. */
  source: string;
  origin: string;
  fbPostId: string | null;
  permalink: string;
  publishedAt: number | null;
  createdAt: number;
  /** null when the post has no lineage at all. */
  lineage: FbContentLineage | null;
  /** Oldest capture first. Empty until analytics has measured the post. */
  snapshots: ContentSnapshot[];
}

export interface ContentFeed {
  /** Events after `cursor` (0 = from the start), oldest first, at most `limit` (1–500, default 100). */
  since(cursor: number, limit?: number): ContentFeedPage;
  /**
   * The row now, or undefined when it no longer exists (deleted, or an imported duplicate that was merged
   * into the studio row it duplicated: that row gets its own events).
   */
  get(contentId: number): ContentWithLineage | undefined;
  /**
   * Ids of rows that are published with a publish time at or after `sinceSec` (unix seconds), id > `afterId`,
   * ascending by id, at most `limit` (1–500, default 100). For a reader's first catch-up (backfill) of posts
   * published before it kept a cursor. Includes imported rows: read each with get() and filter on `origin`.
   */
  publishedSince(sinceSec: number, afterId?: number, limit?: number): number[];
}
