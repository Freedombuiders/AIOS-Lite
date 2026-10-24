import { describe, expect, it, vi } from 'vitest';
import type { LayerConfig, RadarConfig } from '../types.js';
import { runActor } from './apify.js';
import { collectLayer, type CollectContext } from './index.js';
import { mapAd, mapGroupPost, groupCommentsByPost } from './sources.js';
import { collectVnChatter, collectX, parseGrokOutput } from './x-grok.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function layerConfig(over: Partial<LayerConfig> = {}): LayerConfig {
  return {
    key: 'world', label: 'Thế giới', time: '12:00', enabled: true, description: '', fbGroups: [], fbPages: [], instagram: [],
    adLibrary: { enabled: false, country: 'VN', queries: [], pageUrls: [] }, x: { enabled: false, accounts: [], queries: [], vnCheck: false },
    reddit: { enabled: false, subreddits: [] }, hackerNews: { enabled: false, minPoints: 50 }, youtube: { enabled: false, channels: [] },
    tiktok: { enabled: false, queries: [], accounts: [] }, threads: { enabled: false, queries: [], accounts: [] }, github: { enabled: false, queries: [] },
    news: { enabled: false, rss: [] }, professions: [], aiOnly: false, topics: [], windowHours: 24, firstWindowHours: 168, maxPerSource: 10, commentPosts: 5, ...over,
  };
}

function ctxOf(lc: LayerConfig, deps: CollectContext['deps'], logs: string[] = []): CollectContext {
  return { layer: lc.key, config: { layers: { [lc.key]: lc } } as unknown as RadarConfig, layerConfig: lc, sinceIso: '2026-10-16T00:00:00.000Z', now: new Date('2026-10-17T00:00:00Z'), log: (l) => logs.push(l), deps };
}

describe('runActor', () => {
  it('starts, polls and reads the dataset without leaking the token into urls', async () => {
    const urls: string[] = [];
    let polls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url); urls.push(u);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer SECRET');
      if (u.includes('/acts/apify~facebook-ads-scraper/runs')) return json({ data: { id: 'r1', status: 'RUNNING' } });
      if (u.includes('/actor-runs/r1')) return json({ data: { id: 'r1', status: ++polls < 2 ? 'RUNNING' : 'SUCCEEDED', defaultDatasetId: 'd1', usageTotalUsd: 0.42 } });
      if (u.includes('/datasets/d1/items')) return json([{ a: 1 }, { a: 2 }]);
      return json({}, 404);
    }) as unknown as typeof fetch;
    const r = await runActor('apify/facebook-ads-scraper', { x: 1 }, { token: 'SECRET', fetchImpl, pollMs: 1 });
    expect(r).toEqual({ items: [{ a: 1 }, { a: 2 }], costUsd: 0.42, status: 'SUCCEEDED' });
    expect(urls.every((u) => !u.includes('SECRET'))).toBe(true);
  });
  it('fails on FAILED status with a safe message', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/runs')) return json({ data: { id: 'r', status: 'FAILED' } });
      return json({});
    }) as unknown as typeof fetch;
    await expect(runActor('a/b', {}, { token: 'SECRET', fetchImpl, pollMs: 1 })).rejects.toThrow(/FAILED/);
  });
});

describe('mapping', () => {
  it('maps ads with unix-seconds and ISO dates and collationCount', () => {
    const a = mapAd({ adArchiveId: '111', pageName: 'Acme', pageId: '9', startDate: 1760000000, isActive: true, collationCount: 4, snapshot: { body: { text: 'Học AI  miễn phí' }, linkUrl: 'https://acme.vn/x', ctaText: 'Đăng ký', displayFormat: 'VIDEO' } }, 'vn')!;
    expect(a.url).toBe('https://www.facebook.com/ads/library/?id=111');
    expect(a.ad).toMatchObject({ versions: 4, startDate: '2025-10-09T08:53:20.000Z', landingUrl: 'https://acme.vn/x', ctaText: 'Đăng ký' });
    expect(a.text).toBe('Học AI miễn phí');
    const b = mapAd({ ad_archive_id: '222', page_name: 'B', start_date: '2026-10-01T00:00:00Z', snapshot: { cards: [{ body: 'card body' }, { body: 'two' }] } }, 'vn')!;
    expect(b.ad?.startDate).toBe('2026-10-01T00:00:00.000Z');
    expect(b.text).toBe('card body');
    expect(mapAd({ pageName: 'x' }, 'vn')).toBeNull();
  });
  it('maps group posts', () => {
    const it = mapGroupPost({ url: 'https://www.facebook.com/groups/1/posts/2', text: 'hi', time: '2026-10-16T10:00:00Z', likesCount: 5, topReactionsCount: 9, commentsCount: 3, sharesCount: 1, user: { name: 'A' }, topComments: [{ text: 'c', profileName: 'B', likesCount: 2 }] }, 'vn', { name: 'Nhóm X', url: 'https://www.facebook.com/groups/1' })!;
    expect(it).toMatchObject({ kind: 'fb_group', sourceName: 'Nhóm X', metrics: { comments: 3, reactions: 9, shares: 1 }, author: 'A' });
    expect(it.comments[0]).toMatchObject({ text: 'c', author: 'B', likes: 2 });
  });
  it('groups comments by canonical post url', () => {
    const m = groupCommentsByPost([{ text: 'a', facebookUrl: 'https://m.facebook.com/groups/1/posts/2/?utm_source=x' }, { text: 'b', inputUrl: 'https://www.facebook.com/groups/1/posts/3' }], ['https://www.facebook.com/groups/1/posts/2', 'https://www.facebook.com/groups/1/posts/3']);
    expect(m.get('https://www.facebook.com/groups/1/posts/2')?.[0].text).toBe('a');
    expect(m.get('https://www.facebook.com/groups/1/posts/3')?.[0].text).toBe('b');
  });
});

const POST = { author: 'bcherny', text: 'hello', url: 'https://x.com/bcherny/status/1', posted_at: '2026-10-16T10:00:00Z', likes: 10, reposts: 2, quotes: null, replies: 1, bookmarks: 3, views: null };

describe('grok', () => {
  it('parses several envelope shapes', () => {
    const inner = { posts: [POST] };
    expect(parseGrokOutput(JSON.stringify(inner), 'posts')).toEqual(inner);
    expect(parseGrokOutput(JSON.stringify({ structured_output: inner }), 'posts')).toEqual(inner);
    expect(parseGrokOutput(JSON.stringify({ result: JSON.stringify(inner) }), 'posts')).toEqual(inner);
    expect(parseGrokOutput(JSON.stringify({ result: 'Here you go:\n```json\n' + JSON.stringify(inner) + '\n```' }), 'posts')).toEqual(inner);
    expect(parseGrokOutput(`log line\n${JSON.stringify({ type: 'result', output: inner })}`, 'posts')).toEqual(inner);
    expect(parseGrokOutput('nothing', 'posts')).toBeNull();
  });
  it('collects X posts, drops ones without status url, dedupes', async () => {
    const execGrok = vi.fn(async () => JSON.stringify({ structured_output: { posts: [POST, POST, { ...POST, url: 'https://x.com/bcherny' }] } }));
    const r = await collectX(ctxOf(layerConfig(), { execGrok }), ['bcherny'], []);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ kind: 'x', via: 'grok', sourceName: '@bcherny', metrics: { likes: 10, reposts: 2, saves: 3, replies: 1 } });
    expect(r.sources[0]).toMatchObject({ name: '@bcherny', ok: true, count: 1 });
  });
  it('batches accounts by six', async () => {
    const execGrok = vi.fn(async () => JSON.stringify({ posts: [] }));
    await collectX(ctxOf(layerConfig(), { execGrok }), Array.from({ length: 13 }, (_, i) => `a${i}`), ['ai']);
    expect(execGrok).toHaveBeenCalledTimes(4);
  });
  it('stops on Not signed in without retrying', async () => {
    const execGrok = vi.fn(async () => { throw new Error('Not signed in'); });
    const r = await collectX(ctxOf(layerConfig(), { execGrok }), Array.from({ length: 13 }, (_, i) => `a${i}`), []);
    expect(execGrok).toHaveBeenCalledTimes(1);
    expect(r.items).toEqual([]);
    expect(r.sources.every((s) => !s.ok && s.error?.includes('Grok chưa đăng nhập'))).toBe(true);
    expect(r.notes[0]).toContain('Grok chưa đăng nhập');
  });
  it('reads VN chatter', async () => {
    const execGrok = async () => JSON.stringify({ result: JSON.stringify({ topics: [{ topic: 'Claude Code', posts: 12, examples: ['a'] }] }) });
    expect(await collectVnChatter(ctxOf(layerConfig(), { execGrok }), 3)).toEqual({ topics: [{ topic: 'Claude Code', posts: 12, examples: ['a'] }] });
    expect(await collectVnChatter(ctxOf(layerConfig(), { execGrok: async () => { throw new Error('Not signed in'); } }), 3)).toBeNull();
  });
});

describe('collectLayer', () => {
  it('without a token notes the skip, never throws, and still reads free sources', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('hn.algolia.com')) return json({ hits: [
        { objectID: '1', title: 'Big', url: 'https://a.dev', points: 200, num_comments: 50, created_at_i: 1792200000 },
        { objectID: '2', title: 'Small', points: 5, num_comments: 1, created_at_i: 1792200000 },
        { objectID: '3', title: 'Old', points: 500, num_comments: 1, created_at_i: 1000 },
      ] });
      if (u.includes('/top/.rss')) return new Response('<feed><entry><title>R</title><link href="https://reddit.com/r/x/comments/1/a"/><updated>2026-10-16T12:00:00Z</updated></entry></feed>');
      return new Response('boom', { status: 500 });
    }) as unknown as typeof fetch;
    const lc = layerConfig({
      fbGroups: [{ name: 'G', url: 'https://www.facebook.com/groups/1', members: 500 }], tiktok: { enabled: true, queries: ['ai'], accounts: [] },
      hackerNews: { enabled: true, minPoints: 50 }, reddit: { enabled: true, subreddits: ['x'] },
      youtube: { enabled: true, channels: [{ name: 'NoId', channelId: '' }] },
    });
    // sinceIso in unix seconds ≈ 1792108800 (2026-10-16)
    const r = await collectLayer(ctxOf(lc, { fetchImpl, apifyToken: null }));
    expect(r.notes[0]).toContain('Chưa có Apify token');
    expect(r.items.filter((i) => i.kind === 'hn').map((i) => i.title)).toEqual(['Big']);
    expect(r.items.find((i) => i.kind === 'hn')?.sourceUrl).toBe('https://news.ycombinator.com/item?id=1');
    expect(r.items.some((i) => i.kind === 'reddit')).toBe(true);
    expect(r.notes.some((n) => n.includes('YouTube NoId'))).toBe(true);
    expect(r.notes.some((n) => n.includes('RSS'))).toBe(true);
    expect(r.sources.find((s) => s.name === 'G')).toMatchObject({ ok: false, members: 500 });
  });
});

describe('failureNotes', () => {
  it('groups failed sources by kind and skips errors an earlier note already explains', async () => {
    const { failureNotes } = await import('./index.js');
    const notes = failureNotes([
      { kind: 'reddit', name: 'r/A', via: 'rss', ok: false, count: 0, error: 'fetch failed' },
      { kind: 'reddit', name: 'r/B', via: 'rss', ok: false, count: 0, error: 'fetch failed' },
      { kind: 'x', name: '@a', via: 'grok', ok: false, count: 0, error: 'Grok CLI chưa đăng nhập' },
      { kind: 'hn', name: 'Hacker News', via: 'api', ok: true, count: 3 },
      { kind: 'fb_group', name: 'Nhóm A', via: 'apify', ok: false, count: 0, error: 'Chưa có Apify token.' },
    ], ['Grok CLI chưa đăng nhập. Bỏ qua X.', 'Chưa có Apify token — bỏ qua Facebook.']);
    expect(notes).toEqual(['Reddit: không đọc được r/A, r/B (fetch failed).']);
  });
});
