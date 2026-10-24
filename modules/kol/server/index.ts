/**
 * KOL Studio (module kol): virtual influencers with a locked identity, image/video generation,
 * multi-platform publishing and an autopilot planner. Workers start once in start(); every tick checks
 * the kill switches (module settings) and the studio settings, so the owner can switch things off live.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { defineModule } from '../../../src/modules/sdk.js';
import { configureComposio } from '../../_lib/composio.js';
import { kolActions } from './actions.js';
import { falIntegration, higgsfieldIntegration } from './integrations.js';
import { setPublishNotifier } from './accounts.js';
import { startGenerationWorker, stopGenerationWorker } from './generations.js';
import { startPreviewScheduler, stopPreviewScheduler } from './library-previews.js';
import { listPersonaSummaries } from './personas.js';
import { startPublishWorkers, stopPublishWorkers } from './publish-index.js';
import { createVideoHost } from './video-host.js';
import { registerKolRoutes } from './routes.js';
import videoRoutes from './video-routes.js';

const PREFIX = '/api/kol';

export default defineModule({
  actions: kolActions,

  // Listed on Kết nối › Integrations while the module is enabled; generation reads the stored keys.
  integrations: [falIntegration, higgsfieldIntegration],

  routes(app) {
    // The copied routes are written against /api/kol/*; the host mounts this app at /api/m/kol.
    const inner = new Hono();
    registerKolRoutes(inner);
    inner.route(`${PREFIX}/videos`, videoRoutes);
    app.all('/*', (c) => {
      const url = new URL(c.req.url);
      url.pathname = PREFIX + url.pathname.replace(/^\/api\/m\/kol/, '');
      return inner.fetch(new Request(url, c.req.raw));
    });
  },

  start(ctx) {
    const mediaDir = path.join(ctx.dataDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
    configureComposio({ getApiKey: () => ctx.connections.secret('COMPOSIO_API_KEY'), mediaDir, log: ctx.log });
    for (const [name, start] of [
      ['generation worker', startGenerationWorker],
      ['preview scheduler', startPreviewScheduler],
      ['publish workers', () => startPublishWorkers(async (text) => {
        ctx.attention.raise({ key: `kol:notice:${createHash('sha1').update(text).digest('hex').slice(0, 12)}`, title: text.split('\n')[0].slice(0, 120), detail: text, link: '/m/kol', severity: 'info' });
      })],
    ] as const) {
      try { start(); } catch (err) { ctx.log.error({ err, worker: name }, 'kol worker failed to start'); }
    }
    ctx.log.info('KOL Studio workers started');
  },

  stop() {
    stopGenerationWorker();
    stopPreviewScheduler();
    stopPublishWorkers();
    setPublishNotifier(null);
  },

  agentContext({ scopes }) {
    if (!scopes.includes('kol.read')) return undefined;
    const rows = listPersonaSummaries().filter((s) => s.status !== 'archived').slice(0, 20);
    if (!rows.length) return 'KOL Studio: chưa có KOL nào.';
    return ['KOL Studio, các KOL hiện có (dùng action "read" để xem chi tiết):',
      ...rows.map((s) => `- ${s.name} (@${s.handle}) · ${s.status} · ${s.niche || 'chưa có lĩnh vực'} · ${s.postsScheduled} bài đã lên lịch`)].join('\n');
  },

  provides: () => ({
    // Used by the Video module (structural interface in modules/video/server/kol-port.ts).
    videoHost: createVideoHost(),
    personas: () => listPersonaSummaries().filter((s) => s.status !== 'archived').map((s) => ({ id: s.id, name: s.name, handle: s.handle })),
  }),
});
