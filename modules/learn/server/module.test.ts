// learn through the real module manager, next to the real marketing module: migration, the cursor kept across a
// Remove/Add (restart), the routes, and ER taken from marketing's metric function.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import { createModuleManager } from '../../../src/modules/manager.js';
import { createTestHarness, type TestHarness } from '../../../src/modules/test-deps.js';
import { makePage } from '../../marketing/server/core/test-fixtures.js';
import { insertFbContent, markFbContentPublished, upsertFbPostMetrics, type FbPostMetricsRow } from '../../marketing/server/store.js';
import type { SyncResult } from './post-notes.js';

const MODULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let h: TestHarness | undefined;
let brainDir = '';
afterEach(() => h?.cleanup());

function boot() {
  h = createTestHarness({ modulesDir: MODULES_DIR });
  brainDir = path.join(h.root, 'brain');
  fs.mkdirSync(brainDir);
  (h.deps.brain as { folders: () => unknown[] }).folders = () => [{ id: 'b1', name: 'Trà sen', path: brainDir }];
  h.fakes.connections.set('composio', { id: 'composio', type: 'composio' } as never);
  const mgr = createModuleManager(h.deps, { fromDist: false });
  (h.deps as { modules: unknown }).modules = mgr;
  return mgr;
}

const count = (sql: string) => (h!.deps.db.prepare(sql).get() as { n: number }).n;
const noteFiles = () => {
  const dir = path.join(brainDir, 'noi-dung', 'bai');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
};

function metric(postId: string, milestone: string, over: Partial<FbPostMetricsRow> = {}): FbPostMetricsRow {
  return {
    post_id: postId, page_id: 'P1', milestone, captured_at: Math.floor(Date.now() / 1000), reach: 400, impressions: 600, reactions: 16, comments: 2, shares: 2,
    clicks: null, video_views_3s: null, avg_watch_s: null, video_length_s: null, follows: null, saves: null, raw_json: '{}', ...over,
  };
}

/** A studio post going through the publisher's success path (which writes the 'published' feed event). */
function publish(caption: string, postId: string, publishedAt = Math.floor(Date.now() / 1000) - 3600): number {
  const id = insertFbContent({ page_id: 'P1', title: '', caption, format: 'photo', pillar: 'Sản phẩm', hook_type: 'con số', status: 'publishing', idea_id: 'idea-1', formula_slug: 'cong-thuc-a', formula_version: 1 });
  markFbContentPublished(id, { published_at: publishedAt, fb_post_id: postId, permalink: `https://facebook.com/${postId}`, published_as: 'photo', last_error: '' });
  return id;
}

describe('learn with the module manager', () => {
  it('writes notes from the marketing feed, resumes after a restart, and serves the content lab', async () => {
    const mgr = boot();
    await mgr.add('marketing', { installAgents: false });
    makePage('P1');
    await mgr.add('learn', { installAgents: false });
    for (const t of mgr.get('learn')!.manifest.tables) expect(h!.deps.db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(t), t).toBeTruthy();
    const learn = () => mgr.provides<{ postNotes: { syncNow(): Promise<SyncResult>; status(): { state: string } } }>('learn')!.postNotes;
    const app = new Hono();
    mgr.mount(app);

    // no folder chosen yet: nothing happens and the state says why
    const a = publish('Ảnh hộp trà sen 2 lạng', '10_1');
    expect(await learn().syncNow()).toMatchObject({ state: 'no-folder', created: 0 });
    expect(await (await app.request('/api/m/learn/status')).json()).toMatchObject({ state: 'no-folder', folder: '' });
    expect(noteFiles()).toEqual([]);

    mgr.updateSettings('learn', { folder: 'b1' });
    expect(await learn().syncNow()).toMatchObject({ state: 'ok', created: 1, backfilled: true });
    upsertFbPostMetrics(metric('10_1', '24h'));
    await learn().syncNow();
    const [name] = noteFiles();
    const text = fs.readFileSync(path.join(brainDir, 'noi-dung', 'bai', name!), 'utf8');
    expect(text).toContain('cong_thuc: "[[cong-thuc-a]]"');
    expect(text).toMatch(/so_do:\n {2}- moc: 24h\n.*\n {4}reach: 400\n {4}er: 5\n/); // (16 + 2 + 2) ÷ 400 × 100, from marketing's erOf

    // restart: Remove then Add; events written while learn was off are read from the stored cursor
    await mgr.remove('learn');
    const b = publish('Bài thứ hai', '10_2');
    upsertFbPostMetrics(metric('10_1', '7d', { reach: 1000, reactions: 30, comments: 0, shares: 0 }));
    await mgr.add('learn', { installAgents: false }); // start() catches up
    expect(noteFiles()).toHaveLength(2);
    expect(count('SELECT COUNT(*) AS n FROM learn_post_index')).toBe(2);
    expect(fs.readFileSync(path.join(brainDir, 'noi-dung', 'bai', name!), 'utf8')).toMatch(/- moc: 7d\n.*\n {4}reach: 1000\n {4}er: 3\n/);

    const lab = await (await app.request('/api/m/learn/content-lab?days=90&moc=24h')).json() as { status: { state: string; notes: number }; stats: { totals: { posts: number; measured: number }; posts: Array<{ path: string; er: number | null }> } };
    expect(lab.status).toMatchObject({ state: 'ok', notes: 2 });
    expect(lab.stats.totals).toEqual({ posts: 2, measured: 1 });
    const one = await (await app.request(`/api/m/learn/posts/${encodeURIComponent(`noi-dung/bai/${name}`)}`)).json() as { data: { id: number }; comparison: { moc: string; er: number } };
    expect(one.data.id).toBe(a);
    expect(one.comparison).toMatchObject({ moc: '7d', er: 3 });
    expect((await app.request('/api/m/learn/content-lab?moc=2h')).status).toBe(400);
    expect((await app.request('/api/m/learn/posts/khac%2Fx.md')).status).toBe(400);
    expect((await app.request(`/api/m/learn/posts/${encodeURIComponent('noi-dung/bai/khong-co.md')}`)).status).toBe(404);
    expect(b).toBeGreaterThan(a);

    await mgr.remove('learn');
    await mgr.remove('marketing');
    await mgr.stop();
  });
});
