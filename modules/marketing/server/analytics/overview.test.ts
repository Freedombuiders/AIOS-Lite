import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../_lib/composio.js', async (importOriginal) => ({ ...(await importOriginal<object>()) }));
vi.mock('../settings.js', () => ({ isFbStudioEnabled: vi.fn(() => true) }));
vi.mock('../notify.js', () => ({ notifyOwner: vi.fn(async () => {}) }));

import { upsertFbPostMetrics } from '../store.js';
import type { MarketingOverviewDto } from './overview.js';
import { registerAnalyticsRoutes } from './routes.js';
import { insertComment, insertPage, insertStudioPost, setupAnalyticsDb, type AnalyticsTestDb } from './test-helpers.js';

let t: AnalyticsTestDb;
let app: Hono;
const ts = (iso: string) => Date.parse(`${iso}+07:00`) / 1000;

function metric(postId: string, pageId: string, reach: number | null, reactions: number | null, comments: number | null, shares: number | null, clicks: number | null = null) {
  upsertFbPostMetrics({
    post_id: postId, page_id: pageId, milestone: 'latest', captured_at: 1_800_000_000, reach, impressions: null, reactions, comments, shares,
    clicks, video_views_3s: null, avg_watch_s: null, video_length_s: null, follows: null, saves: null, raw_json: '{}',
  });
}

const URL = '/overview?from=2026-10-20&to=2026-10-22&prevFrom=2026-10-17&prevTo=2026-10-19';

beforeEach(() => {
  t = setupAnalyticsDb();
  app = new Hono();
  registerAnalyticsRoutes(app);
});
afterEach(() => t.cleanup());

describe('GET /overview', () => {
  it('validates the range', async () => {
    expect((await app.request('/overview')).status).toBe(400);
    expect((await app.request('/overview?from=2026-10-22&to=2026-10-20')).status).toBe(400);
    expect((await app.request('/overview?from=2025-01-01&to=2026-10-20')).status).toBe(400);
  });

  it('is empty-valid with no pages and no posts (unknown stays null)', async () => {
    const dto = await (await app.request(URL)).json() as MarketingOverviewDto;
    expect(dto.hasPages).toBe(false);
    expect(dto.current).toMatchObject({ posts: 0, reach: null, interactions: null, engagementRate: null, commentsReceived: null });
    expect(dto.daily).toHaveLength(3);
    expect(dto.topPosts).toEqual([]);
    expect(dto.metricsFetchedAt).toBeNull();
  });

  it('sums reach and interactions, compares the previous period and orders top posts', async () => {
    insertPage(t.raw, { id: 'P1', name: 'Page Một' });
    insertPage(t.raw, { id: 'P2', name: 'Page Hai' });
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: 'a', publishedAt: ts('2026-10-20T09:00:00'), title: 'Bài A' });
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: 'b', publishedAt: ts('2026-10-21T23:30:00'), title: 'Bài B' });
    insertStudioPost(t.raw, { pageId: 'P2', fbPostId: 'c', publishedAt: ts('2026-10-22T10:00:00'), title: 'Bài C' });
    insertStudioPost(t.raw, { pageId: 'P2', fbPostId: 'd', publishedAt: ts('2026-10-22T11:00:00'), title: 'Bài D chưa có số liệu' });
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: 'p', publishedAt: ts('2026-10-18T10:00:00'), title: 'Bài kỳ trước' });
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: 'x', publishedAt: ts('2026-10-21T10:00:00'), title: 'Nháp', status: 'draft' });
    metric('a', 'P1', 1000, 50, 5, 5, 7); // 60
    metric('b', 'P1', 2000, 100, 20, 30, 3); // 150
    metric('c', 'P2', 500, 10, 0, 0); // 10
    metric('p', 'P1', 1000, 20, 0, 0); // 20
    insertComment(t.raw, { id: 'c1', pageId: 'P1', postId: 'a', status: 'sent', createdTime: ts('2026-10-21T10:00:00') });
    insertComment(t.raw, { id: 'c2', pageId: 'P1', postId: 'a', status: 'new', createdTime: ts('2026-10-21T11:00:00') });
    insertComment(t.raw, { id: 'c3', pageId: 'P1', postId: 'a', status: 'sent', createdTime: ts('2026-10-21T12:00:00'), fromPage: 1 });
    insertComment(t.raw, { id: 'c4', pageId: 'P1', postId: 'p', status: 'sent', createdTime: ts('2026-10-18T12:00:00') });

    const dto = await (await app.request(URL)).json() as MarketingOverviewDto;
    expect(dto.hasPages).toBe(true);
    expect(dto.current).toMatchObject({ posts: 4, reach: 3500, interactions: 220, clicks: 10, postsWithMetrics: 3, commentsReceived: 2, commentsReplied: 1 });
    expect(dto.current.engagementRate).toBeCloseTo(220 / 3500);
    expect(dto.previous).toMatchObject({ posts: 1, reach: 1000, interactions: 20, commentsReceived: 1, commentsReplied: 1 });
    expect(dto.daily.map((d) => [d.day, d.posts, d.reach])).toEqual([['2026-10-20', 1, 1000], ['2026-10-21', 1, 2000], ['2026-10-22', 2, 500]]);
    expect(dto.dailyBasis).toBe('post-publish-day');
    expect(dto.topPosts.map((p) => [p.postId, p.interactions])).toEqual([['b', 150], ['a', 60], ['c', 10]]);
    expect(dto.topPosts[0]).toMatchObject({ pageName: 'Page Một', snippet: 'Bài B', reach: 2000 });
    expect(dto.pages.map((p) => [p.pageId, p.posts, p.reach, p.interactions])).toEqual([['P1', 2, 3000, 210], ['P2', 2, 500, 10]]);
    expect(dto.metricsFetchedAt).toBe(1_800_000_000);
  });

  it('keeps unknown numbers null for a post without a snapshot', async () => {
    insertPage(t.raw, { id: 'P1' });
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: 'a', publishedAt: ts('2026-10-21T10:00:00') });
    const dto = await (await app.request(URL)).json() as MarketingOverviewDto;
    expect(dto.current).toMatchObject({ posts: 1, reach: null, interactions: null, engagementRate: null, postsWithMetrics: 0 });
    expect(dto.topPosts).toEqual([]);
    expect(dto.pages[0]).toMatchObject({ posts: 1, reach: null, interactions: null });
  });
});
