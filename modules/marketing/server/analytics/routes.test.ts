import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../_lib/composio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../_lib/composio.js')>();
  return { ...actual, execute: vi.fn(async () => ({ data: [] })), graphAsPage: vi.fn(async () => ({ status: 200, data: {} })), hasComposioKey: vi.fn(() => true) };
});
vi.mock('../settings.js', () => ({ isFbStudioEnabled: vi.fn(() => true) }));
vi.mock('../notify.js', () => ({ notifyOwner: vi.fn(async () => {}) }));

import { insertFbInsight, upsertFbPageDaily, upsertFbPostMetrics } from '../store.js';
import { execute } from '../../../_lib/composio.js';
import type { ChannelDashboardDto, PostDetailDto, PostsDashboardDto } from '../types.js';
import { registerAnalyticsRoutes } from './routes.js';
import { insertComment, insertPage, insertStudioPost, setupAnalyticsDb, type AnalyticsTestDb } from './test-helpers.js';

const mockExecute = vi.mocked(execute);
const D = 86400;

let t: AnalyticsTestDb;
let app: Hono;

function snapshot(postId: string, milestone: string, reach: number, reactions: number, capturedAt: number) {
  upsertFbPostMetrics({
    post_id: postId, page_id: 'P1', milestone, captured_at: capturedAt, reach, impressions: null, reactions, comments: 3, shares: 2,
    clicks: null, video_views_3s: null, avg_watch_s: 14, video_length_s: null, follows: null, saves: null, raw_json: '{}',
  });
}

beforeEach(() => {
  t = setupAnalyticsDb();
  mockExecute.mockClear();
  app = new Hono();
  registerAnalyticsRoutes(app);
  insertPage(t.raw, { id: 'P1', name: 'Page Một', pillars: ['Kiến thức'], followers: 900 });
});

afterEach(() => t.cleanup());

const get = (path: string) => app.request(path);
const post = (path: string, body: unknown) => app.request(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

function seed() {
  const now = Math.floor(Date.now() / 1000);
  for (const [id, daysAgo, reach, reactions] of [['1_a', 1, 1000, 80], ['1_b', 2, 2000, 60], ['1_c', 3, 500, 5]] as const) {
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: id, publishedAt: now - daysAgo * D - 3600, pillar: 'Kiến thức', title: `Bài ${id}` });
    snapshot(id, 'latest', reach, reactions, now - 100);
    snapshot(id, '24h', reach / 2, reactions / 2, now - 200);
  }
  upsertFbPageDaily({
    page_id: 'P1', day: new Date().toISOString().slice(0, 10), reach: 321, impressions: 500, engaged_users: 20, new_follows: 3, unfollows: 1,
    followers_total: 950, link_clicks: 4, messages: null, raw_json: '{}', captured_at: now,
  });
}

describe('GET /analytics/channel', () => {
  it('requires a page and 404s for an unknown one', async () => {
    expect((await get('/analytics/channel')).status).toBe(400);
    const res = await get('/analytics/channel?page=nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it('answers with an empty-but-valid dashboard before any snapshot exists', async () => {
    const res = await get('/analytics/channel?page=P1');
    expect(res.status).toBe(200);
    const dto = await res.json() as ChannelDashboardDto;
    expect(dto).toMatchObject({ days: 28, posts: 0, lastSnapshotAt: null, insight: null, winner: null });
    expect(dto.kpis).toHaveLength(6);
    expect(dto.kpis.map((k) => k.key)).toEqual(['followers', 'reach', 'er', 'interactions', 'shareRate', 'commentsPerPost']);
    expect(dto.reachDaily).toHaveLength(28);
    expect(dto.heat).toHaveLength(42);
    expect(dto.page).toMatchObject({ id: 'P1', name: 'Page Một', followers: 900, er28d: null });
  });

  it('serves computed numbers and the stored Analyst insight', async () => {
    seed();
    insertFbInsight({ pageId: 'P1', kind: 'channel', periodDays: 28, model: 'm', body: { summary: ['a', 'b', 'c'], actions: ['x', 'y', 'z'] } });
    const dto = await (await get('/analytics/channel?page=P1&days=7')).json() as ChannelDashboardDto;
    expect(dto.days).toBe(7);
    expect(dto.posts).toBe(3);
    expect(dto.top[0].postId).toBe('1_a'); // ER (80+3+2)/1000 = 8.5
    expect(dto.top[0].er).toBe(8.5);
    expect(dto.insight).toMatchObject({ summary: ['a', 'b', 'c'], actions: ['x', 'y', 'z'] });
    expect(dto.lastSnapshotAt).not.toBeNull();
    expect(dto.kpis.find((k) => k.key === 'reach')?.value).toBe(321);
    expect(dto.funnel.find((f) => f.key === 'actions')?.value).toBe(4);
    expect(dto.pillars[0]).toMatchObject({ name: 'Kiến thức', posts: 3, verdict: 'win' });
  });

  it('clamps days to 1–90 and defaults junk to 28', async () => {
    expect(((await (await get('/analytics/channel?page=P1&days=500')).json()) as ChannelDashboardDto).days).toBe(90);
    expect(((await (await get('/analytics/channel?page=P1&days=abc')).json()) as ChannelDashboardDto).days).toBe(28);
    expect(((await (await get('/analytics/channel?page=P1&days=0')).json()) as ChannelDashboardDto).days).toBe(28);
  });
});

describe('GET /analytics/posts', () => {
  it('validates the milestone and the page', async () => {
    expect((await get('/analytics/posts')).status).toBe(400);
    expect((await get('/analytics/posts?page=nope')).status).toBe(404);
  });

  it('lists posts with the milestone numbers and AI reply rate', async () => {
    seed();
    const now = Math.floor(Date.now() / 1000);
    insertComment(t.raw, { id: 'c1', pageId: 'P1', postId: '1_a', status: 'sent', createdTime: now - 100 });
    insertComment(t.raw, { id: 'c2', pageId: 'P1', postId: '1_a', status: 'human', createdTime: now - 100 });
    insertComment(t.raw, { id: 'c3', pageId: 'P1', postId: '1_a', status: 'skipped', createdTime: now - 100 });
    insertComment(t.raw, { id: 'c4', pageId: 'P1', postId: '1_a', status: 'new', createdTime: now - 100, fromPage: 1 });
    const dto = await (await get('/analytics/posts?page=P1&milestone=24h')).json() as PostsDashboardDto;
    expect(dto.milestone).toBe('24h');
    expect(dto.rows).toHaveLength(3);
    expect(dto.rows[0]).toMatchObject({ postId: '1_a', reach: 500, avgWatchS: 14, contentId: expect.any(Number) });
    expect(dto.kpis.posts).toBe(3);
    expect(dto.kpis.aiReplyRate).toBe(50); // 1 sent of 2 that needed an answer
    expect(dto.reachDaily).toHaveLength(28);
  });
});

describe('posts milestone default', () => {
  it("defaults to 'latest' when the milestone is absent or invalid", async () => {
    seed();
    for (const q of ['', '&milestone=1h', '&milestone=', '&milestone=junk']) {
      const dto = await (await get(`/analytics/posts?page=P1${q}`)).json() as PostsDashboardDto;
      expect(dto.milestone).toBe('latest');
      expect(dto.rows[0]).toMatchObject({ postId: '1_a', reach: 1000 }); // latest snapshot, not the 24h one (500)
    }
    for (const m of ['24h', '7d', '28d', 'latest']) {
      expect(((await (await get(`/analytics/posts?page=P1&milestone=${m}`)).json()) as PostsDashboardDto).milestone).toBe(m);
    }
  });
});

describe('GET /analytics/post/:postId', () => {
  it('404s for an unknown post', async () => {
    expect((await get('/analytics/post/nope')).status).toBe(404);
  });

  it('returns the curve, stats and the Analyst note', async () => {
    seed();
    insertFbInsight({ pageId: 'P1', kind: 'post', subjectId: '1_a', periodDays: 28, model: 'm', body: { note: 'Hook tốt.' } });
    const now = Math.floor(Date.now() / 1000);
    insertComment(t.raw, { id: 'c1', pageId: 'P1', postId: '1_a', status: 'sent', createdTime: now });
    insertComment(t.raw, { id: 'c2', pageId: 'P1', postId: '1_a', status: 'human', createdTime: now });
    const dto = await (await get('/analytics/post/1_a')).json() as PostDetailDto;
    expect(dto).toMatchObject({ postId: '1_a', title: 'Bài 1_a', note: 'Hook tốt.' });
    expect(dto.curve).toHaveLength(6);
    expect(dto.curve.find((c) => c.milestone === '24h')?.reach).toBe(500);
    expect(dto.curve.find((c) => c.milestone === '7d')?.reach).toBeNull();
    expect(dto.medianCurve.find((c) => c.milestone === '24h')?.reach).toBe(500); // peers: same-format posts' median (500, 1000, 250), all formats
    expect(dto.stats).toMatchObject({ comments: 3, shares: 2, commentsReplied: 1, avgWatchS: 14 });
  });
});

describe('POST /analytics/refresh', () => {
  it('validates the body and the Page', async () => {
    expect((await post('/analytics/refresh', {})).status).toBe(400);
    expect((await app.request('/analytics/refresh', { method: 'POST', body: 'junk' })).status).toBe(400);
    expect((await post('/analytics/refresh', { pageId: 'nope' })).status).toBe(404);
  });

  it('starts a refresh, then answers 429 with Retry-After inside 10 minutes', async () => {
    const res = await post('/analytics/refresh', { pageId: 'P1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // The background run finishes quickly against the empty fake; until then a second request is a 409.
    await vi.waitFor(async () => {
      const again = await post('/analytics/refresh', { pageId: 'P1' });
      expect(again.status).toBe(429);
      expect(again.headers.get('Retry-After')).toBe('600');
      expect(((await again.json()) as { error: string }).error).toContain('10');
    });
  });
});
