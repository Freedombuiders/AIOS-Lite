// T14a: lineage of a post (idea → published post → metrics), the reconciliation between a studio post
// and the same post imported by analytics, and the durable feed other modules read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  graph: vi.fn(),
  notify: vi.fn(async () => {}),
}));

vi.mock('../../_lib/composio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../_lib/composio.js')>();
  return { ...actual, execute: mocks.execute, graphAsPage: mocks.graph, hasComposioKey: () => true };
});
vi.mock('./settings.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./settings.js')>()), isEnabled: () => true }));
vi.mock('./notify.js', () => ({ notifyOwner: mocks.notify }));

import {
  _initTestDatabase,
  getFbAnalyticsPage,
  getFbContent,
  insertFbContent,
  insertFbPublishLog,
  listFbPostMetricsForPost,
  repairUnlinkedFbPublishes,
  setFbSetting,
  updateFbContentFields,
  upsertFbPostMetrics,
  upsertImportedFbPost,
  type FbPostMetricsRow,
} from './store.js';
import { getDb } from '../../../src/modules/compat/index.js';
import { approveContent, createContent, updateContent } from './core/content.js';
import { _resetPublisher, publisherTick } from './core/publisher.js';
import { registerCoreRoutes } from './core/routes.js';
import { CliUsageError, runCommand } from './core/agent-commands.js';
import { marketingActions } from './actions.js';
import { captureDueMilestones, syncPage } from './analytics/sync.js';
import { createContentFeed } from './feed.js';
import { createKolBridge } from './kol-bridge.js';
import { makePage } from './core/test-fixtures.js';
import type { FbContentLineage } from './types.js';

const T0 = Date.UTC(2026, 9, 20, 5, 0, 0) / 1000; // 12:00 Vietnam time
const PUBLISH_AT = T0 + 3600; // 13:00
const POST_ID = '111_222';

const LINEAGE: FbContentLineage = {
  ideaId: 'idea-42',
  formulaSlug: 'hook-cau-hoi',
  formulaVersion: 3,
  sourceVideoSlug: 'video-ban-hang-01',
  expectedRatio: 1.25,
};

const iso = (sec: number) => new Date(sec * 1000).toISOString().replace('.000Z', '+0000');
const feed = createContentFeed();
let dbDir = '';

function metric(over: Partial<FbPostMetricsRow> = {}): FbPostMetricsRow {
  return {
    post_id: POST_ID, page_id: 'p1', milestone: '24h', captured_at: 100, reach: 100, impressions: 150, reactions: 5, comments: 1, shares: 0,
    clicks: null, video_views_3s: null, avg_watch_s: null, video_length_s: null, follows: null, saves: null, raw_json: '{}', ...over,
  };
}

function contentCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM fb_content').get() as { n: number }).n;
}

/** A scheduled text post with lineage, due at PUBLISH_AT. */
function scheduledWithLineage(lineage: FbContentLineage = LINEAGE): number {
  const created = createContent({ pageId: 'p1', title: 'Bài từ ý tưởng', caption: 'Nội dung', format: 'text', status: 'review', lineage }, { kind: 'user' });
  approveContent(created.id, PUBLISH_AT, T0);
  return created.id;
}

/** Fake Facebook: posting returns POST_ID; the Page feed lists that post; insights return fixed numbers. */
function fakeFacebook(onCreate: () => Promise<void> = async () => {}): void {
  mocks.execute.mockImplementation(async (slug: string) => {
    if (slug === 'FACEBOOK_CREATE_POST') {
      await onCreate();
      return { id: POST_ID };
    }
    if (slug === 'FACEBOOK_GET_PAGE_POSTS') {
      return { data: [{
        id: POST_ID, message: 'Nội dung', created_time: iso(PUBLISH_AT), permalink_url: `https://facebook.com/${POST_ID}`,
        reactions: { summary: { total_count: 10 } }, comments: { summary: { total_count: 2 } }, shares: { count: 1 },
      }] };
    }
    if (slug === 'FACEBOOK_GET_POST_INSIGHTS') {
      return { data: [{ name: 'post_total_media_view_unique', values: [{ value: 900 }] }, { name: 'post_media_view', values: [{ value: 1500 }] }] };
    }
    if (slug === 'FACEBOOK_GET_PAGE_INSIGHTS') return { data: [] };
    throw new Error(`unexpected ${slug}`);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0 * 1000);
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-lineage-'));
  _initTestDatabase(path.join(dbDir, 'test.db'));
  _resetPublisher();
  mocks.execute.mockReset();
  mocks.graph.mockReset();
  mocks.graph.mockResolvedValue({ status: 200, data: {} });
  setFbSetting('enabled', '1');
  makePage('p1');
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe('chain: idea → published post → metrics', () => {
  it('keeps one row with lineage, the native id and the metrics when analytics imports the post before the publisher stores its id', async () => {
    const id = scheduledWithLineage();
    fakeFacebook(async () => {
      // The upload is slow: analytics runs in between, imports the post and snapshots it.
      const page = getFbAnalyticsPage('p1')!;
      const sync = await syncPage(page, { now: PUBLISH_AT + 700, importDays: 7, snapshotDays: 7, pauseMs: 0 });
      expect(sync.imported).toBe(1);
      expect(await captureDueMilestones(page, PUBLISH_AT + 3700, { pauseMs: 0 })).toBe(1);
      expect(contentCount()).toBe(2); // the race: the imported duplicate exists right now
    });

    vi.setSystemTime(PUBLISH_AT * 1000);
    await publisherTick(PUBLISH_AT);

    expect(contentCount()).toBe(1);
    const row = getFbContent(id)!;
    expect(row).toMatchObject({
      status: 'published', fb_post_id: POST_ID, origin: 'studio', source: 'user',
      idea_id: 'idea-42', formula_slug: 'hook-cau-hoi', formula_version: 3, source_video_slug: 'video-ban-hang-01', expected_ratio: 1.25,
    });
    expect(listFbPostMetricsForPost(POST_ID).map((m) => m.milestone).sort()).toEqual(['1h', 'latest']);

    const read = feed.get(id)!;
    expect(read.lineage).toEqual(LINEAGE);
    expect(read.fbPostId).toBe(POST_ID);
    expect(read.snapshots.map((s) => s.milestone).sort()).toEqual(['1h', 'latest']);
    expect(read.snapshots.find((s) => s.milestone === 'latest')?.reach).toBe(900);

    // The feed points consumers at the surviving row: published plus each snapshot already recorded.
    const forOriginal = feed.since(0, 100).events.filter((e) => e.contentId === id);
    expect(forOriginal.map((e) => `${e.kind}:${e.milestone ?? ''}`).sort()).toEqual(['published:', 'snapshot:1h', 'snapshot:latest']);
  });

  it('later imports and snapshots keep attaching to the original row', async () => {
    const id = scheduledWithLineage();
    fakeFacebook();
    vi.setSystemTime(PUBLISH_AT * 1000);
    await publisherTick(PUBLISH_AT);
    expect(getFbContent(id)?.fb_post_id).toBe(POST_ID);

    const page = getFbAnalyticsPage('p1')!;
    await syncPage(page, { now: PUBLISH_AT + 700, importDays: 7, snapshotDays: 7, pauseMs: 0 });
    expect(contentCount()).toBe(1);
    expect(feed.get(id)?.snapshots.map((s) => s.milestone)).toEqual(['latest']);
  });
});

describe('reconciliation in the store', () => {
  it('a duplicate left by an older version is merged into the original on repair', () => {
    // Before T14a: the original row was published with fb_post_id = null, the imported row kept the id and the metrics.
    const original = insertFbContent({
      page_id: 'p1', title: 'Gốc', caption: 'x', format: 'text', status: 'published', published_at: T0, permalink: '', source: 'main',
      idea_id: 'idea-7', formula_slug: 'f', formula_version: 1,
    });
    insertFbPublishLog({ content_id: original, page_id: 'p1', action: 'publish', tool: 'FACEBOOK_CREATE_POST', ok: true, detail: POST_ID });
    const imported = upsertImportedFbPost({ pageId: 'p1', fbPostId: POST_ID, title: 'Gốc', caption: 'x', format: 'text', publishedAt: T0, permalink: 'https://fb/p' });
    upsertFbPostMetrics(metric({ milestone: '24h' }));
    upsertFbPostMetrics(metric({ milestone: '7d', reach: 300 }));

    expect(repairUnlinkedFbPublishes()).toEqual([{ contentId: original, postId: POST_ID, mergedFrom: imported.id }]);
    expect(contentCount()).toBe(1);
    expect(getFbContent(original)).toMatchObject({ fb_post_id: POST_ID, idea_id: 'idea-7', permalink: 'https://fb/p', source: 'main', origin: 'studio' });
    expect(feed.get(original)?.snapshots.map((s) => s.milestone).sort()).toEqual(['24h', '7d']);
    expect(feed.get(imported.id)).toBeUndefined();
    // Idempotent: a second run finds nothing to do.
    expect(repairUnlinkedFbPublishes()).toEqual([]);
  });

  it('never takes the id from another studio row', () => {
    insertFbContent({ page_id: 'p1', caption: 'a', status: 'published', fb_post_id: POST_ID });
    const other = insertFbContent({ page_id: 'p1', caption: 'b', status: 'published' });
    insertFbPublishLog({ content_id: other, page_id: 'p1', action: 'publish', ok: true, detail: POST_ID });
    expect(repairUnlinkedFbPublishes()).toEqual([]);
    expect(getFbContent(other)?.fb_post_id).toBeNull();
    expect(contentCount()).toBe(2);
  });
});

describe('content feed', () => {
  it('emits exactly one published event per publish', async () => {
    const a = scheduledWithLineage();
    fakeFacebook();
    vi.setSystemTime(PUBLISH_AT * 1000);
    await publisherTick(PUBLISH_AT);
    await publisherTick(PUBLISH_AT + 60);
    const published = feed.since(0, 100).events.filter((e) => e.kind === 'published');
    expect(published).toEqual([{ id: expect.any(Number), kind: 'published', contentId: a, postId: POST_ID, milestone: null, at: PUBLISH_AT }]);
  });

  it('emits one snapshot event per changed upsert and none for an upsert that changed nothing', () => {
    const id = insertFbContent({ page_id: 'p1', caption: 'x', status: 'published', fb_post_id: POST_ID, published_at: T0 });
    expect(upsertFbPostMetrics(metric())).toBe(true);
    expect(upsertFbPostMetrics(metric({ captured_at: 200 }))).toBe(false); // same numbers, later capture
    expect(upsertFbPostMetrics(metric({ captured_at: 300, reach: 120 }))).toBe(true);
    expect(upsertFbPostMetrics(metric({ milestone: '7d' }))).toBe(true);
    const events = feed.since(0, 100).events;
    expect(events.map((e) => [e.kind, e.contentId, e.milestone])).toEqual([
      ['snapshot', id, '24h'], ['snapshot', id, '24h'], ['snapshot', id, '7d'],
    ]);
    expect(listFbPostMetricsForPost(POST_ID).find((m) => m.milestone === '24h')).toMatchObject({ reach: 120, captured_at: 300 });
  });

  it('pages with a cursor that resumes after a restart', () => {
    insertFbContent({ page_id: 'p1', caption: 'x', status: 'published', fb_post_id: POST_ID, published_at: T0 });
    for (const [i, m] of ['1h', '6h', '24h'].entries()) upsertFbPostMetrics(metric({ milestone: m, reach: 10 + i }));

    const first = feed.since(0, 2);
    expect(first.events.map((e) => e.milestone)).toEqual(['1h', '6h']);
    const saved = first.cursor;

    // Restart: a new connection to the same database file; in-memory state is gone.
    _initTestDatabase(path.join(dbDir, 'test.db'));
    upsertFbPostMetrics(metric({ milestone: '3d' }));
    const rest = createContentFeed().since(saved, 10);
    expect(rest.events.map((e) => e.milestone)).toEqual(['24h', '3d']);
    expect(createContentFeed().since(rest.cursor, 10)).toEqual({ events: [], cursor: rest.cursor });
  });

  it('is ordered and validates the cursor', () => {
    insertFbContent({ page_id: 'p1', caption: 'x', status: 'published', fb_post_id: POST_ID, published_at: T0 });
    upsertFbPostMetrics(metric({ milestone: '1h' }));
    upsertFbPostMetrics(metric({ milestone: '6h' }));
    const { events } = feed.since(0, 10);
    expect(events[0].id).toBeLessThan(events[1].id);
    expect(() => feed.since(-1, 10)).toThrow();
    expect(feed.get(999)).toBeUndefined();
  });

  it('carries the ER of each snapshot from the metrics function, null when it cannot be known', () => {
    const id = insertFbContent({ page_id: 'p1', caption: 'x', status: 'published', fb_post_id: POST_ID, published_at: T0 });
    upsertFbPostMetrics(metric({ milestone: '24h', reach: 200, reactions: 8, comments: 1, shares: 1 }));
    upsertFbPostMetrics(metric({ milestone: '7d', reach: null }));
    const snaps = feed.get(id)!.snapshots;
    expect(snaps.find((s) => s.milestone === '24h')?.er).toBe(5);
    expect(snaps.find((s) => s.milestone === '7d')?.er).toBeNull();
  });

  it('lists published rows since a time, by id, for a first catch-up', () => {
    const old = insertFbContent({ page_id: 'p1', caption: 'cũ', status: 'published', published_at: T0 - 100 * 86400 });
    const a = insertFbContent({ page_id: 'p1', caption: 'a', status: 'published', published_at: T0 - 10 });
    insertFbContent({ page_id: 'p1', caption: 'nháp', status: 'draft' });
    const b = insertFbContent({ page_id: 'p1', caption: 'b', status: 'published', published_at: T0 });
    expect(feed.publishedSince(T0 - 90 * 86400)).toEqual([a, b]);
    expect(feed.publishedSince(T0 - 90 * 86400, a)).toEqual([b]);
    expect(feed.publishedSince(0, 0, 1)).toEqual([old]);
    expect(() => feed.publishedSince(0, -1)).toThrow();
  });
});

describe('lineage is set once', () => {
  it('survives edits, approval and publishing', async () => {
    const created = createContent({ pageId: 'p1', title: 'A', caption: 'Nội dung', format: 'text', status: 'draft', lineage: LINEAGE }, { kind: 'user' });
    expect(created.lineage).toEqual(LINEAGE);
    updateContent(created.id, { caption: 'Nội dung mới', title: 'B', status: 'review' }, { kind: 'user' });
    approveContent(created.id, PUBLISH_AT, T0);
    expect(getFbContent(created.id)?.status).toBe('scheduled');
    expect(feed.get(created.id)?.lineage).toEqual(LINEAGE);
  });

  it('partial lineage keeps the missing parts null; none at all is null', () => {
    const partial = createContent({ pageId: 'p1', caption: 'x', lineage: { ideaId: 'i1' } }, { kind: 'user' });
    expect(partial.lineage).toEqual({ ideaId: 'i1', formulaSlug: null, formulaVersion: null, sourceVideoSlug: null, expectedRatio: null });
    expect(createContent({ pageId: 'p1', caption: 'x' }, { kind: 'user' }).lineage).toBeNull();
  });

  it('rejects bad lineage values at creation', () => {
    expect(() => createContent({ pageId: 'p1', caption: 'x', lineage: { formulaVersion: 1.5 } }, { kind: 'user' })).toThrow(/Phiên bản công thức/);
    expect(() => createContent({ pageId: 'p1', caption: 'x', lineage: { expectedRatio: Number.NaN } }, { kind: 'user' })).toThrow(/Kỳ vọng/);
    expect(() => createContent({ pageId: 'p1', caption: 'x', lineage: { ideaId: 'x'.repeat(201) } }, { kind: 'user' })).toThrow(/quá dài/);
  });

  it('cannot be changed by an update, by the store writer, or by an agent', () => {
    const id = createContent({ pageId: 'p1', caption: 'x', lineage: LINEAGE }, { kind: 'user' }).id;
    expect(() => updateContent(id, { lineage: { ideaId: 'other' } }, { kind: 'user' })).toThrow(/chỉ đặt lúc tạo/);
    expect(() => updateContent(id, { lineage: { ideaId: 'other' } }, { kind: 'agent', id: 'main' })).toThrow(/chỉ đặt lúc tạo/);
    updateFbContentFields(id, { idea_id: 'other', formula_slug: 'other', caption: 'y' });
    expect(() => runCommand(['update', String(id), '--idea-id', 'other'], 'main')).toThrow(CliUsageError);
    void marketingActions['content.update'].handler({ id, title: 'Mới', ideaId: 'other', lineage: { ideaId: 'other' } }, { agentId: 'main' } as never);
    expect(getFbContent(id)).toMatchObject({ caption: 'y', title: 'Mới', idea_id: 'idea-42', formula_slug: 'hook-cau-hoi' });
  });

  it('agents creating posts cannot set lineage', () => {
    const out = marketingActions['content.add'].handler(
      { page: 'p1', format: 'text', title: 'Agent', caption: 'x', ideaId: 'forged', lineage: LINEAGE }, { agentId: 'main' } as never,
    ) as { content: { id: number } };
    expect(feed.get(out.content.id)?.lineage).toBeNull();
  });

  it('the create API stores lineage and the patch API cannot change it', async () => {
    const app = new Hono();
    registerCoreRoutes(app);
    const send = (method: string, url: string, body: unknown) =>
      app.request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const res = await send('POST', '/content', { pageId: 'p1', caption: 'x', lineage: LINEAGE });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: number; lineage: FbContentLineage };
    expect(created.lineage).toEqual(LINEAGE);
    const patched = await send('PATCH', `/content/${created.id}`, { caption: 'y', lineage: { ideaId: 'other' } });
    expect(patched.status).toBe(409);
    expect(getFbContent(created.id)).toMatchObject({ caption: 'x', idea_id: 'idea-42' });
    expect((await send('POST', '/content', { pageId: 'p1', caption: 'x', lineage: { formulaVersion: 'v3' } })).status).toBe(400);
  });

  it('KOL Studio hand-offs carry lineage', () => {
    const id = createKolBridge().createContent({ pageId: 'p1', title: 'K', caption: 'x', format: 'text', pillar: '', media: [], lineage: { sourceVideoSlug: 'kol-video-9' } });
    expect(feed.get(id)?.lineage).toMatchObject({ sourceVideoSlug: 'kol-video-9', ideaId: null });
  });
});
