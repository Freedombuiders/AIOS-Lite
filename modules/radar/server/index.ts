import { defineModule, type ModuleContext } from '../../../src/modules/sdk.js';
import { apifyIntegration } from './apify-integration.js';
import { rsshubIntegration } from './rsshub-integration.js';
import { setAmbientContext, withContext } from './context.js';
import { registerRadarRoutes } from './routes.js';
import { failStaleRuns } from './store.js';
import { latestSummary, summaryForAgent } from './summary.js';
import { startRadarWorker } from './worker.js';

export function createRadarModule() {
  const stops = new WeakMap<ModuleContext, () => void>();
  return defineModule({
    integrations: [apifyIntegration, rsshubIntegration],
    routes(app, ctx) {
      app.use('*', (_c, next) => withContext(ctx, next));
      app.use('*', async (c, next) => {
        await next();
        if (c.req.method !== 'GET' && c.res.ok) ctx.events.emit('changed', { path: c.req.path });
      });
      app.get('/latest', (c) => c.json({ latest: latestSummary() }));
      registerRadarRoutes(app);
    },
    start(ctx) {
      setAmbientContext(ctx);
      withContext(ctx, () => {
        try {
          const stale = failStaleRuns();
          if (stale) ctx.log.warn({ stale }, 'radar: marked interrupted runs as failed');
        } catch (err) {
          ctx.log.warn({ err }, 'radar: could not clean stale runs');
        }
      });
      stops.get(ctx)?.();
      stops.set(ctx, startRadarWorker(ctx, (text) => {
        ctx.attention.raise({ key: 'radar:report', title: 'Radar có báo cáo mới', detail: text, link: '/m/radar', severity: 'info' });
        ctx.events.emit('report', {});
      }));
    },
    stop(ctx) {
      stops.get(ctx)?.();
      stops.delete(ctx);
      setAmbientContext(undefined);
    },
    agentContext(_input, ctx) {
      return withContext(ctx, summaryForAgent);
    },
    provides(ctx) {
      return { latest: () => withContext(ctx, latestSummary) };
    },
  });
}
export default createRadarModule();
