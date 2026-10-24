import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  countFbCommentsAnswered, countFbPostCommentsAnswered, getFbAnalyticsPostByFbId, getLastFbSnapshotAt, getLatestFbInsight,
  insertFbInsight, listFbAnalyticsPages, listFbAnalyticsPosts, listFbPageDaily, listFbPostMetrics, listFbPostMetricsForPost,
  listFbUnclassifiedImportedPosts, setFbAnalyticsPageFollowers, setFbAnalyticsPageStatus, setFbImportedClassification,
  upsertFbPageDaily, upsertFbPostMetrics, upsertImportedFbPost,
} from '../store.js';
import { insertComment, insertPage, insertStudioPost, setupAnalyticsDb, type AnalyticsTestDb } from './test-helpers.js';

let t: AnalyticsTestDb;
beforeEach(() => {
  t = setupAnalyticsDb();
  insertPage(t.raw, { id: 'P1', name: 'B Page' });
  insertPage(t.raw, { id: 'P2', name: 'A Page', enabled: 0 });
});
afterEach(() => t.cleanup());

const imp = (over: Partial<Parameters<typeof upsertImportedFbPost>[0]> = {}) => upsertImportedFbPost({
  pageId: 'P1', fbPostId: '1_a', title: 'Tiêu đề', caption: 'Nội dung', format: 'photo', publishedAt: 1000, permalink: 'https://fb/1_a', ...over,
});

const metricRow = (over: Partial<Parameters<typeof upsertFbPostMetrics>[0]> = {}) => ({
  post_id: '1_a', page_id: 'P1', milestone: 'latest', captured_at: 100, reach: 10, impressions: null, reactions: 1, comments: 1, shares: 0,
  clicks: null, video_views_3s: null, avg_watch_s: null, video_length_s: null, follows: null, saves: null, raw_json: '{}', ...over,
});

describe('Pages', () => {
  it('lists Pages, optionally only the enabled ones', () => {
    expect(listFbAnalyticsPages().map((p) => p.id)).toEqual(['P2', 'P1']);
    expect(listFbAnalyticsPages({ enabledOnly: true }).map((p) => p.id)).toEqual(['P1']);
  });

  it('updates status and follower count', () => {
    setFbAnalyticsPageStatus('P1', 'EXPIRED');
    setFbAnalyticsPageFollowers('P1', 4321);
    const p = listFbAnalyticsPages({ enabledOnly: true })[0];
    expect(p).toMatchObject({ status: 'EXPIRED', followers: 4321 });
  });
});

describe('upsertImportedFbPost', () => {
  it('inserts an imported, published post', () => {
    const r = imp();
    expect(r.created).toBe(true);
    expect(getFbAnalyticsPostByFbId('1_a')).toMatchObject({
      content_id: r.id, page_id: 'P1', origin: 'imported', format: 'photo', source: 'facebook', published_at: 1000, permalink: 'https://fb/1_a', pillar: '',
    });
  });

  it('never duplicates a known fb_post_id and refreshes the imported row', () => {
    const first = imp();
    const second = imp({ title: 'Đã sửa', caption: 'Nội dung mới', format: 'video' });
    expect(second).toEqual({ id: first.id, created: false });
    expect(listFbAnalyticsPosts('P1', 0)).toHaveLength(1);
    expect(getFbAnalyticsPostByFbId('1_a')).toMatchObject({ title: 'Đã sửa', caption: 'Nội dung mới', format: 'video' });
  });

  it('leaves a studio post alone, only filling a missing permalink', () => {
    const id = insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_s', publishedAt: 500, title: 'Của studio', format: 'reel', pillar: 'Kiến thức' });
    const r = imp({ fbPostId: '1_s', title: 'Từ Facebook', format: 'text', permalink: 'https://fb/1_s' });
    expect(r).toEqual({ id, created: false });
    expect(getFbAnalyticsPostByFbId('1_s')).toMatchObject({ origin: 'studio', title: 'Của studio', format: 'reel', pillar: 'Kiến thức', permalink: 'https://fb/1_s', published_at: 500 });
  });

  it('only lists published posts with an id, at or after the cut-off, oldest first', () => {
    imp({ fbPostId: '1_new', publishedAt: 3000 });
    imp({ fbPostId: '1_old', publishedAt: 1000 });
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_draft', publishedAt: 2000, status: 'deleted' }); // deleted on Facebook: not an active post
    insertStudioPost(t.raw, { pageId: 'P2', fbPostId: '2_x', publishedAt: 2000 });
    expect(listFbAnalyticsPosts('P1', 0).map((p) => p.fb_post_id)).toEqual(['1_old', '1_new']);
    expect(listFbAnalyticsPosts('P1', 2000).map((p) => p.fb_post_id)).toEqual(['1_new']);
    expect(getFbAnalyticsPostByFbId('1_draft')).toBeUndefined();
  });
});

describe('classification storage', () => {
  it('lists unclassified imported posts with a caption and classifies each once', () => {
    const a = imp({ fbPostId: '1_a', publishedAt: 100 }).id;
    imp({ fbPostId: '1_b', caption: '', publishedAt: 200 }); // nothing to classify from
    insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_s', publishedAt: 300 });
    expect(listFbUnclassifiedImportedPosts('P1', 10).map((p) => p.content_id)).toEqual([a]);
    setFbImportedClassification(a, 'Kiến thức', 'câu hỏi');
    expect(listFbUnclassifiedImportedPosts('P1', 10)).toEqual([]);
    setFbImportedClassification(a, 'Khác', 'con số'); // second write is ignored
    expect(getFbAnalyticsPostByFbId('1_a')).toMatchObject({ pillar: 'Kiến thức', hook_type: 'câu hỏi' });
  });

  it('never classifies a studio row', () => {
    const id = insertStudioPost(t.raw, { pageId: 'P1', fbPostId: '1_s', publishedAt: 300 });
    setFbImportedClassification(id, 'Kiến thức', 'câu hỏi');
    expect(getFbAnalyticsPostByFbId('1_s')?.pillar).toBe('');
  });
});

describe('post metrics', () => {
  it('keeps one row per post and milestone, replacing on a new capture', () => {
    imp();
    upsertFbPostMetrics(metricRow());
    upsertFbPostMetrics(metricRow({ captured_at: 200, reach: 20 }));
    upsertFbPostMetrics(metricRow({ milestone: '24h', captured_at: 150 }));
    const rows = listFbPostMetricsForPost('1_a');
    expect(rows.map((r) => [r.milestone, r.reach])).toEqual([['24h', 10], ['latest', 20]]);
  });

  it('lists metrics of a Page by the post publish time', () => {
    imp({ fbPostId: '1_a', publishedAt: 1000 });
    imp({ fbPostId: '1_b', publishedAt: 5000 });
    upsertFbPostMetrics(metricRow({ post_id: '1_a' }));
    upsertFbPostMetrics(metricRow({ post_id: '1_b' }));
    expect(listFbPostMetrics('P1', 0)).toHaveLength(2);
    expect(listFbPostMetrics('P1', 2000).map((m) => m.post_id)).toEqual(['1_b']);
    expect(listFbPostMetrics('P2', 0)).toEqual([]);
  });

  it('reports the latest snapshot time across posts and Page daily', () => {
    expect(getLastFbSnapshotAt('P1')).toBeNull();
    upsertFbPostMetrics(metricRow({ captured_at: 300 }));
    expect(getLastFbSnapshotAt('P1')).toBe(300);
    upsertFbPageDaily({ page_id: 'P1', day: '2026-10-07', reach: 1, impressions: null, engaged_users: null, new_follows: null, unfollows: null, followers_total: null, link_clicks: null, messages: null, raw_json: '{}', captured_at: 900 });
    expect(getLastFbSnapshotAt('P1')).toBe(900);
  });
});

describe('page daily', () => {
  const row = (day: string, over = {}) => ({
    page_id: 'P1', day, reach: null, impressions: null, engaged_users: null, new_follows: null, unfollows: null, followers_total: null,
    link_clicks: null, messages: null, raw_json: '{}', captured_at: 1, ...over,
  });

  it('keeps earlier values when a later write does not carry the column', () => {
    upsertFbPageDaily(row('2026-10-07', { reach: 10, impressions: 20 }));
    upsertFbPageDaily(row('2026-10-07', { reach: 11, captured_at: 2 }));
    expect(listFbPageDaily('P1', '2026-10-07', '2026-10-07')[0]).toMatchObject({ reach: 11, impressions: 20, captured_at: 2 });
  });

  it('lists a day range in order', () => {
    for (const d of ['2026-10-09', '2026-10-07', '2026-10-08']) upsertFbPageDaily(row(d));
    expect(listFbPageDaily('P1', '2026-10-07', '2026-10-08').map((r) => r.day)).toEqual(['2026-10-07', '2026-10-08']);
  });
});

describe('insights', () => {
  it('returns the newest insight per kind and subject', () => {
    insertFbInsight({ pageId: 'P1', kind: 'channel', periodDays: 28, model: 'm', body: { summary: ['old'] } });
    const id = insertFbInsight({ pageId: 'P1', kind: 'channel', periodDays: 28, model: 'm', body: { summary: ['new'] } });
    insertFbInsight({ pageId: 'P1', kind: 'post', subjectId: '1_a', periodDays: 28, model: 'm', body: { note: 'n' } });
    expect(getLatestFbInsight('P1', 'channel')?.id).toBe(id);
    expect(JSON.parse(getLatestFbInsight('P1', 'post', '1_a')!.body_json)).toEqual({ note: 'n' });
    expect(getLatestFbInsight('P1', 'post', '1_zzz')).toBeUndefined();
    expect(getLatestFbInsight('P2', 'channel')).toBeUndefined();
  });
});

describe('comment counts', () => {
  it('counts answered comments among those that needed an answer, ignoring the Page itself', () => {
    const rows: [string, string, number?][] = [['a', 'sent'], ['b', 'sent'], ['c', 'queued'], ['d', 'human'], ['e', 'skipped'], ['f', 'hidden'], ['g', 'sent', 1]];
    for (const [id, status, fromPage] of rows) insertComment(t.raw, { id, pageId: 'P1', postId: '1_a', status, createdTime: 1000, fromPage });
    insertComment(t.raw, { id: 'old', pageId: 'P1', postId: '1_a', status: 'sent', createdTime: 10 });
    expect(countFbCommentsAnswered('P1', 500)).toEqual({ needed: 4, answered: 2 });
    expect(countFbCommentsAnswered('P2', 0)).toEqual({ needed: 0, answered: 0 });
    expect(countFbPostCommentsAnswered('1_a')).toEqual({ total: 7, answered: 3 });
  });
});
