import { describe, expect, it } from 'vitest';
import type { LayerConfig, RadarConfig } from '../types.js';
import { collectLayer, toolStatus, type CollectContext } from './index.js';
import { mapFeedItem, rsshubErrorMessage, rsshubReachable } from './rsshub.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const BASE = 'http://rs.test';

function layerConfig(over: Partial<LayerConfig> = {}): LayerConfig {
  return {
    key: 'world', label: 'Thế giới', time: '12:00', enabled: true, description: '', fbGroups: [], fbPages: [], instagram: [],
    adLibrary: { enabled: false, country: 'VN', queries: [], pageUrls: [] }, x: { enabled: false, accounts: [], queries: [], vnCheck: false },
    reddit: { enabled: false, subreddits: [] }, hackerNews: { enabled: false, minPoints: 50 }, youtube: { enabled: false, channels: [] },
    tiktok: { enabled: false, queries: [], accounts: [] }, threads: { enabled: false, queries: [], accounts: [] }, github: { enabled: false, queries: [] },
    news: { enabled: false, rss: [] }, professions: [], aiOnly: false, topics: [], windowHours: 24, firstWindowHours: 168, maxPerSource: 10, commentPosts: 5, ...over,
  };
}
function ctxOf(lc: LayerConfig, deps: CollectContext['deps']): CollectContext {
  return { layer: lc.key, config: { layers: { [lc.key]: lc } } as unknown as RadarConfig, layerConfig: lc, sinceIso: '2020-01-01T00:00:00.000Z', now: new Date('2026-10-17T00:00:00Z'), log: () => undefined, deps };
}
const feed = (n: number, prefix = 'https://www.facebook.com/p/') => ({
  items: Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, url: `${prefix}${i}`, title: 't', content_html: `<p>Bài ${i}</p>`, date_published: '2026-10-16T10:00:00Z', authors: [{ name: '@ann' }] })),
});

describe('mapping', () => {
  it('maps a feed item and drops the Threads @user: prefix', () => {
    const it = mapFeedItem({ id: 'x', url: 'https://www.threads.net/@a/post/1', content_html: '<p>@a: học <b>AI</b></p><img src="u">', date_published: '2026-10-16T10:00:00Z', authors: [{ name: '@a' }] }, 'vn', 'threads', '@a')!;
    expect(it).toMatchObject({ kind: 'threads', via: 'rsshub', sourceName: '@a', author: 'a', text: 'học AI', media: 'image', postedAt: '2026-10-16T10:00:00.000Z' });
    expect(mapFeedItem({ id: 'v', title: 'Only title', content_html: '<video src="a.mp4"></video>' }, 'vn', 'tiktok', '@t')).toBeNull();
    expect(mapFeedItem({ id: 'https://x.test/1', title: 'Only title' }, 'vn', 'fb_page', 'P')).toMatchObject({ text: 'Only title', media: 'text', url: 'https://x.test/1' });
  });
  it('extracts a Vietnamese reason from RSSHub error bodies', () => {
    expect(rsshubErrorMessage(503, 'Error: Instagram GraphQL ... Rate limit exceeded')).toContain('giới hạn tần suất');
    expect(rsshubErrorMessage(503, 'ConfigNotFoundError: Twitter API is not configured')).toContain('chưa cấu hình cookie/token');
    expect(rsshubErrorMessage(500, 'boom')).toBe('RSSHub HTTP 500');
    expect(rsshubErrorMessage(500, 'FetchError: bad at https://secret.example/?k=1')).not.toContain('secret.example');
  });
  it('probes /healthz without throwing', async () => {
    expect(await rsshubReachable(BASE, (async () => new Response('OK')) as unknown as typeof fetch)).toBe(true);
    expect(await rsshubReachable(BASE, (async () => { throw new Error('down'); }) as unknown as typeof fetch)).toBe(false);
  });
});

describe('collectLayer routing', () => {
  const group = { name: 'G', url: 'https://www.facebook.com/groups/123' };
  it('reads a group through RSSHub and never touches Apify', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: string | URL | Request) => {
      const s = String(u); urls.push(s);
      if (s.endsWith('/healthz')) return new Response('OK');
      return json(feed(2));
    }) as unknown as typeof fetch;
    const r = await collectLayer(ctxOf(layerConfig({ fbGroups: [group] }), { fetchImpl, rsshubBase: BASE, apifyToken: 'T' }));
    expect(r.items).toHaveLength(2);
    expect(r.sources[0]).toMatchObject({ via: 'rsshub', ok: true, count: 2 });
    expect(urls.some((u) => u.includes('/facebook/group/123?format=json'))).toBe(true);
    expect(urls.some((u) => u.includes('apify'))).toBe(false);
  });
  it('auto mode falls back to Apify when RSSHub is empty', async () => {
    const fetchImpl = (async (u: string | URL | Request) => {
      const s = String(u);
      if (s.endsWith('/healthz')) return new Response('OK');
      if (s.startsWith(BASE)) return json({ items: [] });
      if (s.includes('/runs')) return json({ data: { id: 'r', status: 'SUCCEEDED', defaultDatasetId: 'd' } });
      if (s.includes('/actor-runs/')) return json({ data: { id: 'r', status: 'SUCCEEDED', defaultDatasetId: 'd' } });
      if (s.includes('/datasets/')) return json([{ url: 'https://www.facebook.com/groups/123/posts/9', text: 'từ apify', time: '2026-10-16T10:00:00Z' }]);
      return json({}, 404);
    }) as unknown as typeof fetch;
    const r = await collectLayer(ctxOf(layerConfig({ fbGroups: [group] }), { fetchImpl, rsshubBase: BASE, apifyToken: 'T', pollMs: 1 }));
    expect(r.items.map((i) => i.via)).toEqual(['apify']);
    expect(r.sources[0]).toMatchObject({ via: 'apify', ok: true });
  });
  it('mode rsshub never falls back and reports the reason', async () => {
    const fetchImpl = (async (u: string | URL | Request) => String(u).endsWith('/healthz') ? new Response('OK') : new Response('Error: Rate limit exceeded', { status: 503 })) as unknown as typeof fetch;
    const r = await collectLayer(ctxOf(layerConfig({ fbGroups: [{ ...group, mode: 'rsshub' }] }), { fetchImpl, rsshubBase: BASE, apifyToken: 'T' }));
    expect(r.items).toEqual([]);
    expect(r.sources[0]).toMatchObject({ via: 'rsshub', ok: false });
    expect(r.sources[0].error).toContain('giới hạn tần suất');
  });
  it('Threads: accounts via RSSHub, failed queries fall back to Apify', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: string | URL | Request) => {
      const s = String(u); urls.push(s);
      if (s.endsWith('/healthz')) return new Response('OK');
      if (s.includes('/threads/search/bad')) return new Response('Error: boom', { status: 500 });
      if (s.includes('/threads/search/')) return json(feed(1, 'https://www.threads.net/@q/post/'));
      if (s.startsWith(`${BASE}/threads/`)) return json(feed(1, 'https://www.threads.net/@o/post/'));
      if (s.includes('/runs') || s.includes('/actor-runs/')) return json({ data: { id: 'r', status: 'SUCCEEDED', defaultDatasetId: 'd' } });
      if (s.includes('/datasets/')) return json([{ post_url: 'https://www.threads.net/@z/post/1', text_content: 'apify', username: 'z' }]);
      return json({}, 404);
    }) as unknown as typeof fetch;
    const lc = layerConfig({ threads: { enabled: true, queries: ['good', 'bad'], accounts: ['openai'] } });
    const r = await collectLayer(ctxOf(lc, { fetchImpl, rsshubBase: BASE, apifyToken: 'T', pollMs: 1 }));
    expect(urls.some((u) => u.startsWith(`${BASE}/threads/openai?`))).toBe(true);
    expect(r.items.map((i) => i.via).sort()).toEqual(['apify', 'rsshub', 'rsshub']);
    expect(r.sources.find((s) => s.name === 'Threads: good')).toMatchObject({ via: 'rsshub', ok: true });
    expect(r.sources.find((s) => s.name === 'Threads: bad')).toBeUndefined();
  });
  it('RSSHub unreachable behaves as before and the note names only what was skipped', async () => {
    const fetchImpl = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    const lc = layerConfig({ fbPages: [{ name: 'P', url: 'https://www.facebook.com/p1' }], tiktok: { enabled: true, queries: ['ai'], accounts: [] } });
    const r = await collectLayer(ctxOf(lc, { fetchImpl, rsshubBase: BASE, apifyToken: null }));
    expect(r.items).toEqual([]);
    expect(r.notes[0]).toMatch(/Chưa có Apify token — bỏ qua .*fanpage.*TikTok/);
    expect(r.notes[0]).not.toContain('Threads');
  });
  it('rsshubBase null disables RSSHub entirely', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response('OK'); }) as unknown as typeof fetch;
    await collectLayer(ctxOf(layerConfig({ fbGroups: [{ ...group, mode: 'apify' }], fbPages: [{ name: 'P', url: 'https://www.facebook.com/p1' }] }), { fetchImpl, rsshubBase: null, apifyToken: null }));
    expect(called).toBe(false);
  });
});

describe('toolStatus', () => {
  it('reports RSSHub reachability', async () => {
    const up = await toolStatus({ rsshubBase: BASE, fetchImpl: (async () => new Response('OK')) as unknown as typeof fetch, apifyToken: null });
    expect(up.rsshub).toMatchObject({ url: BASE, reachable: true });
    const down = await toolStatus({ rsshubBase: BASE, fetchImpl: (async () => { throw new Error('x'); }) as unknown as typeof fetch, apifyToken: null });
    expect(down.rsshub.reachable).toBe(false);
    expect(down.rsshub.detail).toContain('docker start rsshub');
  });
});
