import { randomUUID } from 'crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  personas: new Map<string, unknown>(),
  assets: new Map<string, unknown>(),
  hasKey: true,
  spend: [] as { day: string; usd: number }[],
}));

vi.mock('./personas.js', async () => {
  const { KolError } = await import('./core.js');
  return {
    getPersona: (id: string) => h.personas.get(id) ?? null,
    requirePersona: (id: string) => {
      const p = h.personas.get(id);
      if (!p) throw new KolError(404, 'Không tìm thấy KOL.');
      return p;
    },
    listPersonaIds: () => [...h.personas.keys()],
  };
});
vi.mock('./assets.js', () => ({
  listAssetsByIds: (ids: string[]) => ids.map((id) => h.assets.get(id)).filter(Boolean),
  getAsset: (id: string) => h.assets.get(id) ?? null,
  getAssetFile: () => null,
  patchAsset: () => null,
}));
vi.mock('./spend.js', () => ({ spendByDay: () => h.spend, personaSpendSince: () => 0 }));
vi.mock('../../_lib/composio.js', async (orig) => ({ ...(await orig<typeof import('../../_lib/composio.js')>()), hasComposioKey: () => h.hasKey }));

import { _initTestDatabase, upsertFbPostMetrics } from './test-db.js';
import { setPublishNotifier } from './accounts.js';
import { _setToolExecutor, type ToolExecutor } from './composio-exec.js';
import { kolDb, saveSettings } from './core.js';
import {
  aggregateGrowth,
  computeGrowth,
  engagementOf,
  parseInsights,
  snapshotDue,
  snapshotFollowers,
  snapshotInterval,
  snapshotMetrics,
  type GrowthRow,
} from './metrics.js';
import type { PersonaDto, Platform } from './types.js';

const T0 = Date.UTC(2026, 9, 20, 5, 0, 0) / 1000; // 12:00 Vietnam
const HOUR = 3600;
const DAY = 86_400;

let calls: { slug: string; args: Record<string, unknown> }[];
let notes: string[];

function script(map: Record<string, (args: Record<string, unknown>) => unknown>): void {
  const exec: ToolExecutor = async (slug, args) => {
    calls.push({ slug, args });
    const fn = map[slug];
    if (!fn) throw new Error(`unexpected tool ${slug}`);
    return fn(args);
  };
  _setToolExecutor(exec);
}

function insert(table: string, row: Record<string, unknown>): void {
  const keys = Object.keys(row);
  kolDb().prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
}

function account(platform: Platform, over: Record<string, unknown> = {}): string {
  const id = randomUUID();
  insert('kol_accounts', {
    id, persona_id: 'p1', platform, connection_id: 'ca', entity_id: 'u', external_id: platform === 'facebook' ? 'page1' : `${platform}-1`,
    handle: `@mai.${platform}`, timezone: 'Asia/Ho_Chi_Minh', status: 'ACTIVE', created_at: T0, updated_at: T0, ...over,
  });
  return id;
}

function publishedTarget(accountId: string, platform: Platform, externalId: string, publishedAt: number, post: Record<string, unknown> = {}): string {
  const postId = randomUUID();
  insert('kol_posts', { id: postId, persona_id: 'p1', title: `Bài ${externalId}`, status: 'published', published_at: publishedAt, created_at: publishedAt, updated_at: publishedAt, ...post });
  const id = randomUUID();
  insert('kol_post_targets', { id, post_id: postId, account_id: accountId, platform, status: 'published', external_id: externalId, published_at: publishedAt, updated_at: publishedAt });
  return id;
}

const metricsOf = (targetId: string) => kolDb().prepare('SELECT * FROM kol_metrics WHERE target_id = ? ORDER BY captured_at').all(targetId) as Record<string, number | null>[];

beforeEach(() => {
  _initTestDatabase();
  h.personas.clear();
  h.assets.clear();
  h.hasKey = true;
  h.spend = [];
  h.personas.set('p1', { id: 'p1', name: 'Mai', pillars: [{ id: 'pl1', name: 'Du lịch', description: '', share: 50 }] } as unknown as PersonaDto);
  calls = [];
  notes = [];
  setPublishNotifier(async (t) => { notes.push(t); });
  saveSettings({ enabled: true });
});

afterEach(() => {
  _setToolExecutor(null);
  setPublishNotifier(null);
});

describe('pure helpers', () => {
  it('engagement = (likes + comments + shares + saves) / max(views, reach)', () => {
    expect(engagementOf({ views: 1000, reach: 400, likes: 50, comments: 10, shares: 5, saves: 35 })).toBe(0.1);
    expect(engagementOf({ views: null, reach: 200, likes: 20, comments: null, shares: null, saves: null })).toBe(0.1);
    expect(engagementOf({ views: null, reach: null, likes: 20, comments: 1, shares: null, saves: null })).toBeNull();
    expect(engagementOf({ views: 100, reach: null, likes: null, comments: null, shares: null, saves: null })).toBeNull();
    expect(engagementOf(null)).toBeNull();
  });

  it('snapshot cadence by post age', () => {
    expect(snapshotInterval(HOUR)).toBe(HOUR);
    expect(snapshotInterval(3 * DAY)).toBe(6 * HOUR);
    expect(snapshotInterval(10 * DAY)).toBe(DAY);
    expect(snapshotDue(T0 - HOUR, null, T0)).toBe(true);
    expect(snapshotDue(T0 - HOUR, T0 - 30 * 60, T0)).toBe(false);
    expect(snapshotDue(T0 - 3 * HOUR, T0 - HOUR, T0)).toBe(true);
    expect(snapshotDue(T0 - 31 * DAY, null, T0)).toBe(false);
  });

  it('parses Instagram insights in both shapes', () => {
    expect(parseInsights({ data: [{ name: 'views', values: [{ value: 120 }] }, { name: 'reach', total_value: { value: '90' } }] })).toEqual({ views: 120, reach: 90 });
    expect(parseInsights({ data: { data: [{ name: 'saved', values: [{ value: 3 }] }] } })).toEqual({ saved: 3 });
    expect(parseInsights({})).toEqual({});
  });

  it('aggregates totals, top posts, pillars and local-hour buckets', () => {
    const row = (postId: string, platform: Platform, hourUtc: number, m: Partial<GrowthRow['metrics']> | null, pillar = 'Du lịch'): GrowthRow => ({
      postId, title: postId, pillar, platform, permalink: `https://x/${postId}`, publishedAt: Date.UTC(2026, 9, 19, hourUtc) / 1000,
      timezone: 'Asia/Ho_Chi_Minh', thumbUrl: null,
      metrics: m ? { capturedAt: T0, views: null, likes: null, comments: null, shares: null, saves: null, reach: null, ...m } : null,
    });
    const g = aggregateGrowth([
      row('a', 'instagram', 2, { views: 1000, likes: 80, comments: 10, shares: 5, saves: 5 }), // 09:00 local, ER 0.1
      row('a', 'tiktok', 2, { views: 3000, likes: 100, comments: 20, shares: 30 }), // same post, ER 0.05
      row('b', 'youtube', 13, { views: 500, likes: 10 }, ''), // 20:00 local, ER 0.02
      row('c', 'facebook', 13, null, 'Ẩm thực'),
    ]);
    expect(g.totals).toEqual({ posts: 3, views: 4500, likes: 190, comments: 30, shares: 35, engagementRate: 0.0578 });
    expect(g.topPosts.map((p) => [p.postId, p.platform])).toEqual([['a', 'tiktok'], ['a', 'instagram'], ['b', 'youtube'], ['c', 'facebook']]);
    expect(g.pillars).toEqual([
      { pillar: 'Du lịch', posts: 1, avgEngagement: 0.075 },
      { pillar: 'Khác', posts: 1, avgEngagement: 0.02 },
      { pillar: 'Ẩm thực', posts: 1, avgEngagement: null },
    ]);
    expect(g.hours).toHaveLength(24);
    expect(g.hours[9]).toEqual({ hour: 9, posts: 2, avgEngagement: 0.075 });
    expect(g.hours[20]).toEqual({ hour: 20, posts: 2, avgEngagement: 0.02 });
    expect(aggregateGrowth([]).totals.engagementRate).toBeNull();
  });
});

describe('snapshots', () => {
  it('Instagram media fields + insights, YouTube batch, TikTok list, Facebook from Content Studio', async () => {
    const ig = account('instagram');
    const yt = account('youtube');
    const tt = account('tiktok');
    const fb = account('facebook');
    const tIg = publishedTarget(ig, 'instagram', 'm1', T0 - 3 * HOUR);
    const tYt = publishedTarget(yt, 'youtube', 'yt1', T0 - 3 * HOUR);
    const tTt = publishedTarget(tt, 'tiktok', '7311', T0 - 3 * HOUR);
    const tFb = publishedTarget(fb, 'facebook', '1_2', T0 - 3 * HOUR);
    upsertFbPostMetrics({
      post_id: '1_2', page_id: 'page1', milestone: '1h', captured_at: T0 - HOUR, reach: 300, impressions: 500, reactions: 30, comments: 3, shares: 2,
      clicks: null, video_views_3s: null, avg_watch_s: null, video_length_s: null, follows: null, saves: null, raw_json: '{}',
    });
    script({
      INSTAGRAM_GET_IG_MEDIA: () => ({ like_count: 40, comments_count: 4 }),
      INSTAGRAM_GET_IG_MEDIA_INSIGHTS: () => ({ data: [{ name: 'views', values: [{ value: 900 }] }, { name: 'reach', values: [{ value: 700 }] }, { name: 'saved', values: [{ value: 9 }] }, { name: 'shares', values: [{ value: 2 }] }] }),
      YOUTUBE_GET_VIDEO_DETAILS_BATCH: () => ({ items: [{ id: 'yt1', statistics: { viewCount: '1200', likeCount: '60', commentCount: '6' } }] }),
      TIKTOK_LIST_VIDEOS: () => ({ data: { videos: [{ id: '999', view_count: 1 }, { id: '7311', view_count: 5000, like_count: 300, comment_count: 12, share_count: 8 }], has_more: false } }),
    });
    expect(await snapshotMetrics(T0)).toBe(4);
    expect(metricsOf(tIg)[0]).toMatchObject({ views: 900, reach: 700, likes: 40, comments: 4, saves: 9, shares: 2 });
    expect(metricsOf(tYt)[0]).toMatchObject({ views: 1200, likes: 60, comments: 6 });
    expect(metricsOf(tTt)[0]).toMatchObject({ views: 5000, likes: 300, comments: 12, shares: 8 });
    expect(metricsOf(tFb)[0]).toMatchObject({ captured_at: T0 - HOUR, views: 500, reach: 300, likes: 30 });
    expect(calls.find((c) => c.slug === 'INSTAGRAM_GET_IG_MEDIA_INSIGHTS')!.args).toEqual({ ig_media_id: 'm1', metric: ['views', 'reach', 'saved', 'shares', 'likes', 'comments'] });
    expect(calls.find((c) => c.slug === 'YOUTUBE_GET_VIDEO_DETAILS_BATCH')!.args).toEqual({ id: ['yt1'], parts: ['statistics'] });

    // Not due again 30 minutes later; Facebook only stores newer Content Studio snapshots.
    calls = [];
    expect(await snapshotMetrics(T0 + 30 * 60)).toBe(0);
    expect(calls).toEqual([]);
  });

  it('insights failing keeps the counters; an expired connection marks the account once', async () => {
    const ig = account('instagram');
    const t = publishedTarget(ig, 'instagram', 'm1', T0 - HOUR);
    script({ INSTAGRAM_GET_IG_MEDIA: () => ({ like_count: 5 }), INSTAGRAM_GET_IG_MEDIA_INSIGHTS: () => { throw new Error('(#10) Not enough viewers'); } });
    await snapshotMetrics(T0);
    expect(metricsOf(t)[0]).toMatchObject({ likes: 5, views: null });

    script({ INSTAGRAM_GET_IG_MEDIA: () => { throw new Error('Error validating access token: Session has expired'); } });
    await snapshotMetrics(T0 + 2 * HOUR);
    expect((kolDb().prepare('SELECT status FROM kol_accounts WHERE id = ?').get(ig) as { status: string }).status).toBe('EXPIRED');
    expect(notes).toHaveLength(1);
  });

  it('followers once per local day per account', async () => {
    const ig = account('instagram');
    script({ INSTAGRAM_GET_USER_INFO: () => ({ id: 'instagram-1', username: 'mai', account_type: 'BUSINESS', followers_count: 1234 }) });
    expect(await snapshotFollowers(T0)).toBe(1);
    expect(await snapshotFollowers(T0 + HOUR)).toBe(0);
    const rows = kolDb().prepare('SELECT * FROM kol_account_daily WHERE account_id = ?').all(ig);
    expect(rows).toEqual([{ account_id: ig, day: '2026-10-20', followers: 1234 }]);
  });
});

describe('computeGrowth', () => {
  it('builds the GrowthDto (followers series, totals, pillars by name, spend)', () => {
    const ig = account('instagram', { followers: 1300 });
    insert('kol_account_daily', { account_id: ig, day: '2026-10-18', followers: 1200 });
    insert('kol_account_daily', { account_id: ig, day: '2026-10-20', followers: 1300 });
    insert('kol_account_daily', { account_id: ig, day: '2026-08-01', followers: 900 });
    const t = publishedTarget(ig, 'instagram', 'm1', T0 - DAY, { pillar: 'pl1', asset_ids_json: '["a1"]' });
    h.assets.set('a1', { id: 'a1', kind: 'image', url: '/api/kol/media/asset/a1', thumbUrl: '/api/kol/media/thumb/a1' });
    insert('kol_metrics', { target_id: t, captured_at: T0 - 2 * HOUR, views: 100, likes: 10 });
    insert('kol_metrics', { target_id: t, captured_at: T0 - HOUR, views: 200, likes: 20, comments: 0, shares: 0, saves: 0 });
    h.spend = [{ day: '2026-10-20', usd: 1.5 }];

    const g = computeGrowth('p1', 30, T0);
    expect(g.days).toBe(30);
    expect(g.accounts[0]).toMatchObject({ id: ig, platform: 'instagram', handle: '@mai.instagram', followers: 1300 });
    expect(g.accounts[0].series).toEqual([{ day: '2026-10-18', followers: 1200 }, { day: '2026-10-20', followers: 1300 }]);
    expect(g.totals).toMatchObject({ posts: 1, views: 200, likes: 20, engagementRate: 0.1 });
    expect(g.topPosts[0]).toMatchObject({ title: 'Bài m1', thumbUrl: '/api/kol/media/thumb/a1' });
    expect(g.pillars[0].pillar).toBe('Du lịch');
    expect(g.spend).toEqual([{ day: '2026-10-20', usd: 1.5 }]);
    expect(() => computeGrowth('nope', 30, T0)).toThrow(/Không tìm thấy KOL/);
  });
});
