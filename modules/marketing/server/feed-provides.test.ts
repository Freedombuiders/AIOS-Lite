// T14a through the real module manager: the migration, provides.contentFeed, the repair of
// pre-T14a duplicates on start, and Purge dropping the feed table.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createModuleManager } from '../../../src/modules/manager.js';
import { createTestHarness, type TestHarness } from '../../../src/modules/test-deps.js';
import type { ContentFeed } from '../../_lib/content-feed.js';
import { makePage } from './core/test-fixtures.js';
import { getFbContent, insertFbContent, insertFbPublishLog, upsertFbPostMetrics, upsertImportedFbPost } from './store.js';

const MODULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let h: TestHarness | undefined;
afterEach(() => h?.cleanup());

function boot() {
  h = createTestHarness({ modulesDir: MODULES_DIR });
  h.fakes.connections.set('composio', { id: 'composio', type: 'composio' } as never);
  const mgr = createModuleManager(h.deps, { fromDist: false });
  (h.deps as { modules: unknown }).modules = mgr;
  return mgr;
}

const count = (sql: string) => (h!.deps.db.prepare(sql).get() as { n: number }).n;

describe('contentFeed with the module manager', () => {
  it('is provided, repairs old duplicates on start, and is dropped on purge', async () => {
    const mgr = boot();
    await mgr.add('marketing', { installAgents: false });
    makePage('P1');

    // A duplicate as left by the old publisher: original without the id, imported copy with id and metrics.
    const original = insertFbContent({ page_id: 'P1', caption: 'Gốc', status: 'published', published_at: 1000, idea_id: 'idea-1' });
    insertFbPublishLog({ content_id: original, page_id: 'P1', action: 'publish', ok: true, detail: '9_9' });
    upsertImportedFbPost({ pageId: 'P1', fbPostId: '9_9', title: '', caption: 'Gốc', format: 'text', publishedAt: 1000, permalink: '' });
    upsertFbPostMetrics({
      post_id: '9_9', page_id: 'P1', milestone: '24h', captured_at: 2000, reach: 50, impressions: null, reactions: 1, comments: 0, shares: 0,
      clicks: null, video_views_3s: null, avg_watch_s: null, video_length_s: null, follows: null, saves: null, raw_json: '{}',
    });
    expect(count('SELECT COUNT(*) AS n FROM fb_content')).toBe(2);

    // Restart the module: start() repairs.
    await mgr.remove('marketing');
    await mgr.add('marketing', { installAgents: false });
    expect(count('SELECT COUNT(*) AS n FROM fb_content')).toBe(1);
    expect(getFbContent(original)).toMatchObject({ fb_post_id: '9_9', idea_id: 'idea-1' });

    const feed = (mgr.provides('marketing') as { contentFeed: ContentFeed }).contentFeed;
    const events = feed.since(0).events;
    expect(events.at(-1)).toMatchObject({ kind: 'snapshot', contentId: original, postId: '9_9', milestone: '24h' });
    expect(feed.get(original)?.snapshots).toHaveLength(1);

    await mgr.remove('marketing');
    await mgr.purge('marketing', 'marketing');
    expect(h!.deps.db.prepare("SELECT name FROM sqlite_master WHERE name = 'fb_content_feed'").get()).toBeUndefined();
    await mgr.stop();
  });
});
