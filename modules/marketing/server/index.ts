import type { FbAdsOrganicRow } from '../../_lib/fb-types.js';
/**
 * Facebook Content Studio (module marketing): publisher, comment poller/sender and analytics
 * workers, started from start(). Each worker checks the module settings (master `enabled`,
 * `publish`, `autoreply`) on every tick, so the owner can flip them without a restart.
 */
import { defineModule } from '../../../src/modules/sdk.js';
import { configureComposio } from '../../_lib/composio.js';
import path from 'node:path';
import fs from 'node:fs';

import { startAnalyticsWorker, stopAnalyticsWorker } from './analytics/worker.js';
import { startCommentsWorker, stopCommentsWorker } from './comments/worker.js';
import { startPublisher, stopPublisher } from './core/publisher.js';
import { createKolBridge } from './kol-bridge.js';
import { buildAgentContext } from './agent-context.js';
import { marketingActions } from './actions.js';
import { registerFbStudioRoutes } from './routes.js';
import { setRuntime } from './runtime.js';
import { configuredBudgetPerHour } from './settings.js';
import { countFbApiCallsSince, getFbPage, listFbAdsOrganicRows, recordFbApiCall } from './store.js';

const DAY = 86400;

export default defineModule({
  actions: marketingActions,

  agentContext: ({ scopes }) => buildAgentContext(scopes),

  routes(app, ctx) {
    setRuntime(ctx);
    registerFbStudioRoutes(app);
  },

  start(ctx) {
    setRuntime(ctx);
    const mediaDir = path.join(ctx.dataDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    configureComposio({
      getApiKey: () => ctx.connections.secret('COMPOSIO_API_KEY'),
      mediaDir,
      log: ctx.log,
      budget: {
        perHour: configuredBudgetPerHour,
        countSince: (epochSec) => countFbApiCallsSince(epochSec),
        record: (area, ok) => recordFbApiCall(area, ok),
      },
    });
    for (const [name, start] of [
      ['publisher', startPublisher],
      ['comments', startCommentsWorker],
      ['analytics', startAnalyticsWorker],
    ] as const) {
      try {
        start();
      } catch (err) {
        ctx.log.error({ err, worker: name }, 'marketing worker failed to start');
      }
    }
    ctx.log.info('Facebook Content Studio workers started');
  },

  stop() {
    stopPublisher();
    stopCommentsWorker();
    stopAnalyticsWorker();
    setRuntime(null);
  },

  // Read by the ads module (ctx.modules.get('marketing')): organic posts and Page info.
  provides: () => ({
    // Used by KOL Studio to hand a post to the Fanpage queue (contract: modules/_lib/kol-bridge.ts).
    kolBridge: createKolBridge(),
    // Returns the shared FbAdsOrganicRow shape (modules/_lib/fb-types.ts) the ads module reads.
    topPosts(pageId?: string, days = 28): FbAdsOrganicRow[] {
      const since = Math.floor(Date.now() / 1000) - days * DAY;
      const pageName = pageId ? getFbPage(pageId)?.name : undefined;
      return listFbAdsOrganicRows(since)
        .filter((r) => !pageName || r.page_name === pageName)
        .sort((a, b) => (b.reach ?? 0) - (a.reach ?? 0));
    },
    pageInfo(pageId: string) {
      const page = getFbPage(pageId);
      return page ? { id: page.id, name: page.name, timezone: page.timezone, status: page.status } : undefined;
    },
  }),
});
