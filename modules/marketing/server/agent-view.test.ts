import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../_lib/composio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../_lib/composio.js')>();
  return { ...actual, execute: vi.fn(async () => ({ data: [] })), hasComposioKey: vi.fn(() => true) };
});

import { insertFbInsight, upsertFbPageDaily, upsertFbPostMetrics } from './store.js';
import { channelView, postsView, postView } from './agent-view.js';
import { insertPage, insertStudioPost, setupAnalyticsDb, type AnalyticsTestDb } from './analytics/test-helpers.js';

const D = 86400;
let t: AnalyticsTestDb;

function snapshot(postId: string, milestone: string, reach: number, reactions: number, capturedAt: number) {
  upsertFbPostMetrics({
    post_id: postId, page_id: 'P1', milestone, captured_at: capturedAt, reach, impressions: null, reactions, comments: 3, shares: 2,
    clicks: null, video_views_3s: null, avg_watch_s: 14, video_length_s: null, follows: null, saves: null, raw_json: '{}',
  });
}

beforeEach(() => {
  t = setupAnalyticsDb();
  insertPage(t.raw, { id: 'P1', name: 'Page Một', pillars: ['Kiến thức'], followers: 900 });
  const now = Math.floor(Date.now() / 1000);
  for (const [id, daysAgo, reach, reactions] of [['1_a', 1, 1000, 80], ['1_b', 2, 2000, 60], ['1_c', 3, 500, 5]] as const) {
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: id, publishedAt: now - daysAgo * D - 3600, pillar: 'Kiến thức', title: `Bài ${id}` });
    snapshot(id, 'latest', reach, reactions, now - 100);
  }
  upsertFbPageDaily({
    page_id: 'P1', day: new Date().toISOString().slice(0, 10), reach: 321, impressions: 500, engaged_users: 20, new_follows: 3, unfollows: 1,
    followers_total: 950, link_clicks: 4, messages: null, raw_json: '{}', captured_at: now,
  });
  insertFbInsight({ pageId: 'P1', kind: 'channel', periodDays: 28, model: 'm', body: { summary: ['Reel thắng'], actions: ['Đăng thêm Reel'] } });
});
afterEach(() => t.cleanup());

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

describe('views', () => {
  it('channel: the dashboard DTO without sparklines and with local times', () => {
    const view = channelView('P1', 28) as any;
    expect(view.page).toMatchObject({ id: 'P1', name: 'Page Một' });
    expect(view.kpis).toHaveLength(6);
    expect(view.kpis.every((k: any) => !('spark' in k))).toBe(true);
    expect(view.top[0].publishedAt).toMatch(LOCAL_TIME);
    expect(view.insight).toMatchObject({ summary: ['Reel thắng'], actions: ['Đăng thêm Reel'] });
    expect(view.insight.createdAt).toMatch(LOCAL_TIME);
    expect(channelView('nope')).toBeNull();
  });

  it('posts: best index first, unknown milestone falls back to latest', () => {
    const view = postsView('P1', 28, 'bogus') as any;
    expect(view.milestone).toBe('latest');
    expect(view.rows.map((r: any) => r.postId)).toEqual(['1_a', '1_b', '1_c']);
    expect(view.rows[0].publishedAt).toMatch(LOCAL_TIME);
  });

  it('post: null when there is nothing stored', () => {
    expect((postView('1_a') as any).postId).toBe('1_a');
    expect(postView('missing')).toBeNull();
  });
});
