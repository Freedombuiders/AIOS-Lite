import path from 'node:path';
import { defineModule, type ModuleContext } from '../../../src/modules/sdk.js';
import { configureComposio } from '../../_lib/composio.js';
import { withContext } from './context.js';
import { registerAdsRoutes } from './routes.js';
import { runAdsTick } from './worker.js';
import { listFbAdAccounts } from './store.js';
import { loadAdsDashboard } from './dashboard.js';
import { analyzeAccount } from './analyst.js';

export function createAdsModule() {
  const stops = new WeakMap<ModuleContext, () => void>();
  return defineModule({
    routes(app, ctx) {
      app.use('*', (_c, next) => withContext(ctx, next));
      app.use('*', async (c, next) => {
        await next();
        if (c.req.method !== 'GET' && c.res.ok) ctx.events.emit('changed', { path: c.req.path });
      });
      registerAdsRoutes(app);
      app.post('/evaluate', async (c) => {
        const body = await c.req.json().catch(() => null);
        if (!body || typeof body.accountId !== 'string') return c.json({ error: 'Thiếu tài khoản quảng cáo.' }, 400);
        try { return c.json(await analyzeAccount(ctx, body.accountId)); }
        catch { return c.json({ error: 'Không thể đánh giá. Kiểm tra tài khoản, quyền agent và kết quả JSON.' }, 422); }
      });
    },
    start(ctx) {
      configureComposio({ getApiKey: () => ctx.connections.secret('COMPOSIO_API_KEY'), mediaDir: path.join(ctx.dataDir, 'media'), log: ctx.log });
      stops.get(ctx)?.();
      stops.set(ctx, ctx.schedule.every('snapshot', 60 * 60_000, () => withContext(ctx, async () => {
        await runAdsTick();
        ctx.events.emit('snapshot', {});
      })));
    },
    stop(ctx) { stops.get(ctx)?.(); stops.delete(ctx); },
    provides(ctx) {
      return { summary: (accountId?: string) => withContext(ctx, () => {
        const account = listFbAdAccounts().find(a => accountId ? a.id === accountId : a.enabled === 1);
        return account ? loadAdsDashboard(account, account.status === 'ACTIVE' ? 'ACTIVE' : 'EXPIRED', 7, Math.floor(Date.now() / 1000)).kpis : null;
      }) };
    },
  });
}
export default createAdsModule();
