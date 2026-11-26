/**
 * Module learn (T14, part 1: Facebook). Each post published through marketing becomes a `bai-dang` note in
 * noi-dung/bai/ of the brain folder chosen in the settings, with one `so_do` entry per measured milestone.
 * Marketing's contentFeed is read with a cursor stored in learn_state: on start it catches up from that cursor,
 * then a 5-second timer reads what is new. With no folder chosen, nothing is read or written.
 */
import type { ContentFeed } from '../../_lib/content-feed.js';
import { defineModule, type ModuleContext } from '../../../src/modules/sdk.js';
import { DEFAULT_TZ } from './note-format.js';
import { createPostNoteSync, type PostNoteSync } from './post-notes.js';
import { registerRoutes } from './routes.js';

interface MarketingProvides {
  contentFeed?: ContentFeed;
  pageInfo?(pageId: string): { timezone?: string } | undefined;
}

const POLL_MS = 5_000;

let sync: PostNoteSync | null = null;

function createSync(ctx: ModuleContext): PostNoteSync {
  const marketing = () => ctx.modules.get<MarketingProvides>('marketing');
  return createPostNoteSync({
    db: ctx.db,
    notes: ctx.brain.notes,
    feed: () => marketing()?.contentFeed,
    folder: () => String(ctx.settings.get<string>('folder', '') ?? ''),
    timezone: (pageId) => (pageId ? marketing()?.pageInfo?.(pageId)?.timezone : undefined) || DEFAULT_TZ,
    log: ctx.log,
  });
}

export default defineModule({
  routes(app, ctx) {
    sync ??= createSync(ctx);
    registerRoutes(app, ctx, () => sync);
  },

  async start(ctx) {
    sync = createSync(ctx);
    const s = sync;
    // catch up from the stored cursor before anything else
    try {
      await s.run();
    } catch (err) {
      ctx.log.error({ err }, 'learn: đọc bù bài đăng lúc khởi động lỗi');
    }
    ctx.schedule.every('post-notes', POLL_MS, () => s.run().then(() => undefined));
  },

  stop() {
    sync = null;
  },

  provides: () => ({
    /** Run one pass now (also what the timer does) and read the state the page shows. */
    postNotes: {
      syncNow: () => sync?.run(),
      status: () => sync?.status(),
    },
  }),
});
