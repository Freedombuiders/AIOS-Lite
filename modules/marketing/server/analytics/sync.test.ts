import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../_lib/composio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../_lib/composio.js')>();
  return { ...actual, execute: vi.fn(), graphAsPage: vi.fn() };
});

import {
  getFbAnalyticsPage, listFbAnalyticsPosts, listFbPageDaily, listFbPostMetrics, upsertFbPostMetrics,
} from '../store.js';
import { ComposioConnectionExpiredError, ComposioRateLimitError, execute, graphAsPage } from '../../../_lib/composio.js';
import {
  buildMetricRow, captureDueMilestones, captureInsights, captureVideo, fetchPagePosts, syncPage, syncPageDaily, videoRefsFromMetrics,
} from './sync.js';
import { insertPage, insertStudioPost, setupAnalyticsDb, type AnalyticsTestDb } from './test-helpers.js';

const mockExecute = vi.mocked(execute);
const mockGraph = vi.mocked(graphAsPage);
const NOW = Date.parse('2026-10-07T05:00:00Z') / 1000;
const H = 3600;
const D = 86400;
const iso = (sec: number) => new Date(sec * 1000).toISOString().replace('.000Z', '+0000');

function fbPost(id: string, createdAt: number, over: Record<string, unknown> = {}) {
  return {
    id, message: `Caption ${id}`, created_time: iso(createdAt), permalink_url: `https://facebook.com/${id}`,
    reactions: { summary: { total_count: 10 } }, comments: { summary: { total_count: 2 } }, shares: { count: 1 },
    ...over,
  };
}

function insightsResponse(reach: number | null, views: number | null) {
  const data: unknown[] = [];
  if (views !== null) data.push({ name: 'post_media_view', values: [{ value: views }] });
  if (reach !== null) data.push({ name: 'post_total_media_view_unique', values: [{ value: reach }] });
  return { data };
}

let t: AnalyticsTestDb;

beforeEach(() => {
  t = setupAnalyticsDb();
  mockExecute.mockReset();
  mockGraph.mockReset();
  mockGraph.mockResolvedValue({ status: 200, data: {} });
  insertPage(t.raw, { id: 'P1', pillars: ['Kiến thức'] });
});

afterEach(() => t.cleanup());

const page = () => getFbAnalyticsPage('P1')!;
const callsOf = (slug: string) => mockExecute.mock.calls.filter((c) => c[0] === slug);

describe('fetchPagePosts', () => {
  it('pages with until when a full page comes back and de-duplicates ids', async () => {
    const first = Array.from({ length: 100 }, (_, i) => fbPost(`1_${i}`, NOW - 1000 - i * 60));
    const oldest = NOW - 1000 - 99 * 60;
    const second = [fbPost('1_99', oldest), fbPost('1_100', oldest - 60), fbPost('1_101', oldest - 120)];
    mockExecute.mockResolvedValueOnce({ data: first }).mockResolvedValueOnce({ data: second });
    const out = await fetchPagePosts({ area: 'analytics', connectionId: 'c', entityId: 'e' }, 'P1', { sinceSec: NOW - 90 * D, fields: 'id' });
    expect(out).toHaveLength(102);
    expect(mockExecute).toHaveBeenCalledTimes(2);
    const [slug, args] = mockExecute.mock.calls[1];
    expect(slug).toBe('FACEBOOK_GET_PAGE_POSTS');
    expect(args).toMatchObject({ page_id: 'P1', limit: 100, since: String(NOW - 90 * D), until: String(oldest) });
    expect(mockExecute.mock.calls[0][1]).not.toHaveProperty('until');
  });

  it('stops after a short page', async () => {
    mockExecute.mockResolvedValueOnce({ data: { data: [fbPost('1_1', NOW - 5000)] } });
    expect(await fetchPagePosts({ area: 'analytics', connectionId: 'c', entityId: 'e' }, 'P1', { sinceSec: 0, fields: 'id' })).toHaveLength(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('stops when a full page adds nothing new', async () => {
    const same = Array.from({ length: 100 }, (_, i) => fbPost(`1_${i}`, NOW - 1000 - i));
    mockExecute.mockResolvedValue({ data: same });
    const out = await fetchPagePosts({ area: 'analytics', connectionId: 'c', entityId: 'e' }, 'P1', { sinceSec: 0, fields: 'id' });
    expect(out).toHaveLength(100);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });
});

describe('captureInsights', () => {
  const target = { area: 'analytics' as const, connectionId: 'c', entityId: 'e' };

  it('requests reach and views and reads both', async () => {
    mockExecute.mockResolvedValueOnce(insightsResponse(3100, 5400));
    const out = await captureInsights(target, '1_1');
    expect(out).toMatchObject({ reach: 3100, impressions: 5400 });
    expect(mockExecute.mock.calls[0][1]).toEqual({ post_id: '1_1', metrics: 'post_total_media_view_unique,post_media_view' });
  });

  it('falls back to a smaller metric set when the tool rejects the metrics', async () => {
    mockExecute
      .mockRejectedValueOnce(new Error('(#100) The value must be a valid insights metric'))
      .mockRejectedValueOnce(new Error('(#100) The value must be a valid insights metric'))
      .mockResolvedValueOnce(insightsResponse(null, 900));
    const out = await captureInsights(target, '1_1');
    expect(out).toMatchObject({ reach: null, impressions: 900 });
    expect(mockExecute.mock.calls.map((c) => (c[1] as { metrics: string }).metrics)).toEqual([
      'post_total_media_view_unique,post_media_view', 'post_total_media_view_unique', 'post_media_view',
    ]);
  });

  it('accepts a response that only has some of the metrics', async () => {
    mockExecute.mockResolvedValueOnce(insightsResponse(null, 12));
    expect(await captureInsights(target, '1_1')).toMatchObject({ reach: null, impressions: 12 });
  });

  it('reads the lifetime entry when a metric comes back twice (real response shape)', async () => {
    mockExecute.mockResolvedValueOnce({ data: [
      { name: 'post_total_media_view_unique', period: 'lifetime', values: [{ value: 348 }] },
      { name: 'post_total_media_view_unique', period: 'day', values: [{ value: 0 }] },
      { name: 'post_media_view', period: 'lifetime', values: [{ value: 512 }] },
    ] });
    expect(await captureInsights(target, '1_1')).toMatchObject({ reach: 348, impressions: 512 });
    // Order must not matter: a zero entry listed first still loses.
    mockExecute.mockResolvedValueOnce({ data: [
      { name: 'post_total_media_view_unique', period: 'day', values: [{ value: 0 }] },
      { name: 'post_total_media_view_unique', period: 'lifetime', values: [{ value: 348 }] },
    ] });
    expect(await captureInsights(target, '1_1')).toMatchObject({ reach: 348 });
  });

  it('takes the largest value when no entry is lifetime', async () => {
    mockExecute.mockResolvedValueOnce({ data: [
      { name: 'post_total_media_view_unique', period: 'day', values: [{ value: 0 }] },
      { name: 'post_total_media_view_unique', period: 'week', values: [{ value: 40 }] },
    ] });
    expect(await captureInsights(target, '1_1')).toMatchObject({ reach: 40 });
  });

  it('does not rely on other metric names the tool ignores', async () => {
    mockExecute.mockResolvedValueOnce(insightsResponse(10, 20));
    await captureInsights(target, '1_1');
    expect((mockExecute.mock.calls[0][1] as { metrics: string }).metrics).toBe('post_total_media_view_unique,post_media_view');
  });

  it('returns nulls without retrying when the post itself is gone', async () => {
    mockExecute.mockRejectedValueOnce(new Error('Unsupported get request. Object with ID does not exist'));
    expect(await captureInsights(target, '1_1')).toMatchObject({ reach: null, impressions: null });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('lets typed errors through so the caller can back off', async () => {
    mockExecute.mockRejectedValueOnce(new ComposioRateLimitError());
    await expect(captureInsights(target, '1_1')).rejects.toBeInstanceOf(ComposioRateLimitError);
    mockExecute.mockRejectedValueOnce(new ComposioConnectionExpiredError());
    await expect(captureInsights(target, '1_1')).rejects.toBeInstanceOf(ComposioConnectionExpiredError);
  });
});

describe('buildMetricRow', () => {
  it('keeps nulls for what Facebook did not return', () => {
    const row = buildMetricRow('P1', '1_1', '24h', NOW, undefined, { reach: 5, impressions: null, raw: {} });
    expect(row).toMatchObject({ milestone: '24h', reach: 5, impressions: null, reactions: null, comments: null, shares: null, video_views_3s: null });
  });
});

describe('syncPageDaily', () => {
  const end = (d: number) => `2026-10-${String(d).padStart(2, '0')}T07:00:00+0000`;
  const pageInsights = {
    data: [
      { name: 'page_total_media_view_unique', values: [{ value: 100, end_time: end(6) }, { value: 120, end_time: end(7) }] },
      { name: 'page_media_view', values: [{ value: 300, end_time: end(6) }] },
      { name: 'page_follows', values: [{ value: 4990, end_time: end(6) }, { value: 5000, end_time: end(7) }] },
      { name: 'page_daily_follows_unique', values: [{ value: 5, end_time: end(6) }] },
      { name: 'page_daily_unfollows_unique', values: [{ value: 1, end_time: end(6) }] },
    ],
  };

  it('writes one row per day and updates the Page follower count', async () => {
    mockExecute.mockResolvedValueOnce(pageInsights);
    expect(await syncPageDaily(page(), NOW)).toBe(2);
    const rows = listFbPageDaily('P1', '2026-10-01', '2026-10-31');
    expect(rows.map((r) => r.day)).toEqual(['2026-10-05', '2026-10-06']);
    expect(rows[0]).toMatchObject({ reach: 100, impressions: 300, new_follows: 5, unfollows: 1, followers_total: 4990, engaged_users: null });
    expect(getFbAnalyticsPage('P1')?.followers).toBe(5000);
    const args = mockExecute.mock.calls[0][1] as Record<string, string>;
    expect(args).toMatchObject({ page_id: 'P1', period: 'day', until: String(NOW), since: String(NOW - 60 * D) });
    expect(args.metrics.split(',')).toContain('page_total_media_view_unique');
  });

  it('asks metric by metric when the set is rejected, and keeps what works', async () => {
    mockExecute.mockImplementation(async (_slug, args) => {
      const metrics = (args as { metrics: string }).metrics;
      if (metrics.includes(',')) throw new Error('(#100) Invalid metric combination');
      if (metrics === 'page_media_view') throw new Error('(#100) metric not supported');
      return { data: pageInsights.data.filter((m) => m.name === metrics) };
    });
    expect(await syncPageDaily(page(), NOW)).toBe(2);
    const rows = listFbPageDaily('P1', '2026-10-01', '2026-10-31');
    expect(rows[0]).toMatchObject({ reach: 100, impressions: null, new_follows: 5 });
  });

  it('merges per column so a later partial response does not wipe earlier values', async () => {
    mockExecute.mockResolvedValueOnce(pageInsights);
    await syncPageDaily(page(), NOW);
    mockExecute.mockResolvedValueOnce({ data: [{ name: 'page_total_media_view_unique', values: [{ value: 110, end_time: end(6) }] }] });
    await syncPageDaily(page(), NOW + 10);
    const row = listFbPageDaily('P1', '2026-10-05', '2026-10-05')[0];
    expect(row).toMatchObject({ reach: 110, impressions: 300, new_follows: 5 });
  });

  it('propagates an expired connection', async () => {
    mockExecute.mockRejectedValueOnce(new ComposioConnectionExpiredError());
    await expect(syncPageDaily(page(), NOW)).rejects.toBeInstanceOf(ComposioConnectionExpiredError);
  });
});

describe('syncPage', () => {
  function fakeFacebook(posts: ReturnType<typeof fbPost>[], reach: Record<string, number>) {
    mockExecute.mockImplementation(async (slug, args) => {
      if (slug === 'FACEBOOK_GET_PAGE_POSTS') return { data: posts };
      if (slug === 'FACEBOOK_GET_POST_INSIGHTS') {
        const id = (args as { post_id: string }).post_id;
        return insightsResponse(reach[id] ?? null, (reach[id] ?? 0) * 2);
      }
      if (slug === 'FACEBOOK_GET_PAGE_INSIGHTS') return { data: [] };
      throw new Error(`unexpected ${slug}`);
    });
  }

  it('imports posts made outside the app, never duplicates studio posts, and snapshots them', async () => {
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_studio', publishedAt: NOW - 2 * D });
    fakeFacebook([
      fbPost('1_studio', NOW - 2 * D),
      fbPost('1_new', NOW - 1 * D, { attachments: { data: [{ type: 'photo' }] } }),
      fbPost('1_reel', NOW - 3 * D, { permalink_url: 'https://www.facebook.com/reel/777' }),
      fbPost('1_fresh', NOW - 120), // two minutes old: left to the publisher
    ], { '1_studio': 1000, '1_new': 500, '1_reel': 800 });

    const result = await syncPage(page(), { now: NOW, importDays: 90, snapshotDays: 28, pauseMs: 0 });
    expect(result).toMatchObject({ fetched: 4, imported: 2, snapshots: 3 });

    const posts = listFbAnalyticsPosts('P1', 0);
    expect(posts.map((p) => p.fb_post_id).sort()).toEqual(['1_new', '1_reel', '1_studio']);
    const imported = posts.find((p) => p.fb_post_id === '1_new')!;
    expect(imported).toMatchObject({ origin: 'imported', format: 'photo', title: 'Caption 1_new', pillar: '' });
    expect(posts.find((p) => p.fb_post_id === '1_reel')?.format).toBe('reel');
    expect(posts.find((p) => p.fb_post_id === '1_studio')?.origin).toBe('studio');

    const metrics = listFbPostMetrics('P1', 0);
    expect(metrics).toHaveLength(3);
    const m = metrics.find((r) => r.post_id === '1_studio')!;
    expect(m).toMatchObject({ milestone: 'latest', reach: 1000, impressions: 2000, reactions: 10, comments: 2, shares: 1, clicks: null, video_views_3s: null });
  });

  it('is idempotent: a second sweep adds no posts and, the same day, no snapshots', async () => {
    fakeFacebook([fbPost('1_a', NOW - D)], { '1_a': 100 });
    await syncPage(page(), { now: NOW, importDays: 90, snapshotDays: 28, pauseMs: 0 });
    const again = await syncPage(page(), { now: NOW + 600, importDays: 28, snapshotDays: 28, pauseMs: 0 });
    expect(again).toMatchObject({ imported: 0, snapshots: 0 });
    expect(listFbAnalyticsPosts('P1', 0)).toHaveLength(1);
    expect(callsOf('FACEBOOK_GET_POST_INSIGHTS')).toHaveLength(1);
  });

  it('re-snapshots when forced (manual refresh)', async () => {
    fakeFacebook([fbPost('1_a', NOW - D)], { '1_a': 100 });
    await syncPage(page(), { now: NOW, importDays: 90, snapshotDays: 28, pauseMs: 0 });
    const forced = await syncPage(page(), { now: NOW + 600, importDays: 28, snapshotDays: 28, force: true, pauseMs: 0 });
    expect(forced.snapshots).toBe(1);
  });

  it('snapshots only posts inside the snapshot window', async () => {
    fakeFacebook([fbPost('1_old', NOW - 60 * D), fbPost('1_recent', NOW - 5 * D)], { '1_old': 10, '1_recent': 20 });
    const first = await syncPage(page(), { now: NOW, importDays: 90, snapshotDays: 28, pauseMs: 0 });
    expect(first).toMatchObject({ imported: 2, snapshots: 1 });
    expect(listFbPostMetrics('P1', 0).map((m) => m.post_id)).toEqual(['1_recent']);
  });

  it('writes a snapshot with nulls when one post\'s insights fail, without failing the sweep', async () => {
    mockExecute.mockImplementation(async (slug, args) => {
      if (slug === 'FACEBOOK_GET_PAGE_POSTS') return { data: [fbPost('1_a', NOW - D), fbPost('1_b', NOW - D)] };
      if (slug === 'FACEBOOK_GET_POST_INSIGHTS') {
        if ((args as { post_id: string }).post_id === '1_a') throw new Error('Unsupported get request. does not exist');
        return insightsResponse(50, 70);
      }
      return { data: [] };
    });
    const out = await syncPage(page(), { now: NOW, importDays: 90, snapshotDays: 28, pauseMs: 0 });
    expect(out.snapshots).toBe(2);
    const a = listFbPostMetrics('P1', 0).find((m) => m.post_id === '1_a')!;
    expect(a).toMatchObject({ reach: null, impressions: null, reactions: 10 });
  });

  it('skips posts that vanished from the Page', async () => {
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_gone', publishedAt: NOW - D });
    fakeFacebook([fbPost('1_here', NOW - D)], { '1_here': 5 });
    const out = await syncPage(page(), { now: NOW, importDays: 90, snapshotDays: 28, pauseMs: 0 });
    expect(out.snapshots).toBe(1);
    expect(listFbPostMetrics('P1', 0).map((m) => m.post_id)).toEqual(['1_here']);
  });

  it('propagates a rate limit so the worker backs off', async () => {
    mockExecute.mockRejectedValue(new ComposioRateLimitError());
    await expect(syncPage(page(), { now: NOW, importDays: 90, snapshotDays: 28, pauseMs: 0 })).rejects.toBeInstanceOf(ComposioRateLimitError);
  });
});

describe('captureDueMilestones', () => {
  function fakeFacebook() {
    mockExecute.mockImplementation(async (slug, args) => {
      if (slug === 'FACEBOOK_GET_PAGE_POSTS') {
        return { data: listFbAnalyticsPosts('P1', 0).map((p) => fbPost(p.fb_post_id, p.published_at as number)) };
      }
      if (slug === 'FACEBOOK_GET_POST_INSIGHTS') return insightsResponse(100, 200);
      void args;
      return { data: [] };
    });
  }

  it('captures the due milestone of each post and skips the rest', async () => {
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_h1', publishedAt: NOW - 90 * 60 }); // 1h due
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_young', publishedAt: NOW - 30 * 60 }); // nothing yet
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_late', publishedAt: NOW - 20 * H }); // 6h is over 2x late, 24h not yet
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_h24', publishedAt: NOW - 30 * H }); // 24h due
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_d7', publishedAt: NOW - 8 * D }); // 7d due
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_old', publishedAt: NOW - 70 * D }); // out of every window
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_deleted', publishedAt: NOW - 90 * 60, status: 'deleted' });
    fakeFacebook();

    expect(await captureDueMilestones(page(), NOW, { pauseMs: 0 })).toBe(3);
    const rows = listFbPostMetrics('P1', 0).map((m) => `${m.post_id}:${m.milestone}`).sort();
    expect(rows).toEqual(['1_d7:7d', '1_h1:1h', '1_h24:24h']);
    const row = listFbPostMetrics('P1', 0).find((m) => m.post_id === '1_h1')!;
    expect(row).toMatchObject({ reach: 100, impressions: 200, reactions: 10, comments: 2, shares: 1 });
    // One post list covers all due posts; one insight read per post.
    expect(callsOf('FACEBOOK_GET_PAGE_POSTS')).toHaveLength(1);
    expect(callsOf('FACEBOOK_GET_POST_INSIGHTS')).toHaveLength(3);
  });

  it('does not capture a milestone twice', async () => {
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_h1', publishedAt: NOW - 90 * 60 });
    fakeFacebook();
    expect(await captureDueMilestones(page(), NOW, { pauseMs: 0 })).toBe(1);
    mockExecute.mockClear();
    expect(await captureDueMilestones(page(), NOW + 300, { pauseMs: 0 })).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('makes no calls when nothing is due', async () => {
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_x', publishedAt: NOW - 10 * 60 });
    fakeFacebook();
    expect(await captureDueMilestones(page(), NOW, { pauseMs: 0 })).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('still stores insights when the engagement counts are unavailable', async () => {
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_h1', publishedAt: NOW - 90 * 60 });
    mockExecute.mockImplementation(async (slug) => {
      if (slug === 'FACEBOOK_GET_PAGE_POSTS') throw new Error('Invalid fields parameter');
      return insightsResponse(100, 200);
    });
    expect(await captureDueMilestones(page(), NOW, { pauseMs: 0 })).toBe(1);
    expect(listFbPostMetrics('P1', 0)[0]).toMatchObject({ reach: 100, reactions: null, comments: null, shares: null });
  });

  it('keeps an existing latest snapshot untouched (milestones are separate rows)', async () => {
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_h1', publishedAt: NOW - 90 * 60 });
    upsertFbPostMetrics(buildMetricRow('P1', '1_h1', 'latest', NOW - 10, undefined, { reach: 1, impressions: 1, raw: {} }));
    fakeFacebook();
    await captureDueMilestones(page(), NOW, { pauseMs: 0 });
    expect(listFbPostMetrics('P1', 0).map((m) => m.milestone).sort()).toEqual(['1h', 'latest']);
  });

  it('propagates an expired connection', async () => {
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_h1', publishedAt: NOW - 90 * 60 });
    mockExecute.mockRejectedValue(new ComposioConnectionExpiredError());
    await expect(captureDueMilestones(page(), NOW, { pauseMs: 0 })).rejects.toBeInstanceOf(ComposioConnectionExpiredError);
  });
});

describe('video / Reel details', () => {
  const postResponse = { id: '1_9', attachments: { data: [{ media_type: 'video', type: 'video_inline', target: { id: '777' } }] } };
  const videoInsights = { data: [
    { name: 'blue_reels_play_count', values: [{ value: 363 }] },
    { name: 'fb_reels_total_plays', values: [{ value: 393 }] },
    { name: 'post_video_avg_time_watched', values: [{ value: 5999 }] },
    { name: 'post_video_followers', values: [{ value: 4 }] },
  ] };

  function fakeGraph(counts = { post: 0, insights: 0, length: 0 }) {
    mockGraph.mockImplementation(async (_page, req) => {
      if (req.path === '/1_9') { counts.post++; return { status: 200, data: postResponse }; }
      if (req.path === '/777/video_insights') { counts.insights++; return { status: 200, data: videoInsights }; }
      if (req.path === '/777') { counts.length++; return { status: 200, data: { length: 22.4, id: '777' } }; }
      return { status: 200, data: {} };
    });
    return counts;
  }

  it('finds the video, reads its insights and length, and caches the mapping', async () => {
    const counts = fakeGraph();
    const out = await captureVideo(page(), '1_9', undefined);
    expect(out).toMatchObject({ ref: { id: '777', lengthS: 22.4 }, plays: 363, avgWatchS: 5.999, follows: 4 });
    expect(counts).toEqual({ post: 1, insights: 1, length: 1 });
    expect(mockGraph.mock.calls[0][1]).toMatchObject({ method: 'GET', path: '/1_9', query: { fields: 'attachments{media_type,target{id},type},permalink_url' } });
    // With the mapping cached it is one call.
    const again = await captureVideo(page(), '1_9', out.ref);
    expect(again.plays).toBe(363);
    expect(counts).toEqual({ post: 1, insights: 2, length: 1 });
  });

  it('remembers that a post has no video', async () => {
    mockGraph.mockResolvedValueOnce({ status: 200, data: { attachments: { data: [{ media_type: 'photo' }] } } });
    const out = await captureVideo(page(), '1_9', undefined);
    expect(out.ref).toEqual({ id: null, lengthS: null });
    expect(mockGraph).toHaveBeenCalledTimes(1);
    await captureVideo(page(), '1_9', out.ref);
    expect(mockGraph).toHaveBeenCalledTimes(1); // cached "no video": no calls at all
  });

  it('keeps nulls when the video calls fail, without failing the snapshot', async () => {
    mockGraph.mockRejectedValue(new Error('(#10) permission denied'));
    const out = await captureVideo(page(), '1_9', undefined);
    expect(out).toMatchObject({ plays: null, avgWatchS: null, follows: null });
  });

  it('lets typed errors through', async () => {
    mockGraph.mockRejectedValue(new ComposioRateLimitError());
    await expect(captureVideo(page(), '1_9', undefined)).rejects.toBeInstanceOf(ComposioRateLimitError);
  });

  it('reads cached video refs back from earlier snapshot rows', () => {
    const refs = videoRefsFromMetrics([
      { post_id: 'a', raw_json: JSON.stringify({ video: { id: '1', lengthS: null } }) },
      { post_id: 'a', raw_json: JSON.stringify({ video: { id: '1', lengthS: 9 } }) },
      { post_id: 'b', raw_json: JSON.stringify({ video: { id: null, lengthS: null } }) },
      { post_id: 'c', raw_json: '{}' },
      { post_id: 'd', raw_json: 'not json' },
    ]);
    expect(refs.get('a')).toEqual({ id: '1', lengthS: 9 });
    expect(refs.get('b')).toEqual({ id: null, lengthS: null });
    expect(refs.has('c')).toBe(false);
    expect(refs.has('d')).toBe(false);
  });

  it('stores video fields on the snapshot of a Reel and reuses the mapping on the next sweep', async () => {
    const counts = fakeGraph();
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_9', publishedAt: NOW - 2 * D, format: 'reel' });
    mockExecute.mockImplementation(async (slug) => {
      if (slug === 'FACEBOOK_GET_PAGE_POSTS') return { data: [fbPost('1_9', NOW - 2 * D)] };
      if (slug === 'FACEBOOK_GET_POST_INSIGHTS') return insightsResponse(348, 512);
      return { data: [] };
    });
    await syncPage(page(), { now: NOW, importDays: 90, snapshotDays: 28, pauseMs: 0 });
    const row = listFbPostMetrics('P1', 0)[0];
    expect(row).toMatchObject({ reach: 348, video_views_3s: 363, avg_watch_s: 5.999, video_length_s: 22.4, follows: 4 });
    expect(JSON.parse(row.raw_json).video).toEqual({ id: '777', lengthS: 22.4 });

    await syncPage(page(), { now: NOW + 600, importDays: 28, snapshotDays: 28, force: true, pauseMs: 0 });
    expect(counts).toEqual({ post: 1, insights: 2, length: 1 }); // mapping and length cached
  });

  it('does not look for a video on photo or text posts', async () => {
    fakeGraph();
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_p', publishedAt: NOW - 2 * D, format: 'photo' });
    mockExecute.mockImplementation(async (slug) => (slug === 'FACEBOOK_GET_PAGE_POSTS' ? { data: [fbPost('1_p', NOW - 2 * D)] } : insightsResponse(1, 1)));
    await syncPage(page(), { now: NOW, importDays: 90, snapshotDays: 28, pauseMs: 0 });
    expect(mockGraph).not.toHaveBeenCalled();
    expect(JSON.parse(listFbPostMetrics('P1', 0)[0].raw_json).video).toBeUndefined();
  });

  it('captures video details on milestone snapshots too', async () => {
    fakeGraph();
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_9', publishedAt: NOW - 90 * 60, format: 'reel' });
    mockExecute.mockImplementation(async (slug) => (slug === 'FACEBOOK_GET_PAGE_POSTS' ? { data: [fbPost('1_9', NOW - 90 * 60)] } : insightsResponse(10, 20)));
    await captureDueMilestones(page(), NOW, { pauseMs: 0 });
    expect(listFbPostMetrics('P1', 0)[0]).toMatchObject({ milestone: '1h', video_views_3s: 363, video_length_s: 22.4 });
  });
});

describe('backfill of older posts', () => {
  it('snapshots posts between 28 and 56 days old once, then leaves them alone', async () => {
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_mid', publishedAt: NOW - 40 * D, format: 'photo' });
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_older', publishedAt: NOW - 70 * D, format: 'photo' });
    mockExecute.mockImplementation(async (slug) => (slug === 'FACEBOOK_GET_PAGE_POSTS'
      ? { data: [fbPost('1_mid', NOW - 40 * D), fbPost('1_older', NOW - 70 * D)] }
      : insightsResponse(100, 200)));
    const first = await syncPage(page(), { now: NOW, importDays: 28, snapshotDays: 28, backfillDays: 56, pauseMs: 0 });
    expect(first.snapshots).toBe(1);
    expect(listFbPostMetrics('P1', 0).map((m) => m.post_id)).toEqual(['1_mid']);
    const second = await syncPage(page(), { now: NOW + 600, importDays: 28, snapshotDays: 28, backfillDays: 56, force: true, pauseMs: 0 });
    expect(second.snapshots).toBe(0);
  });
});
