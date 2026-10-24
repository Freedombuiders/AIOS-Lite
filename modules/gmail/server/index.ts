import path from 'node:path';
import { defineModule, type ModuleContext } from '../../../src/modules/sdk.js';
import { configureComposio } from '../../_lib/composio.js';
import { createEmailStore } from './store.js';
import { createGmailApi } from './gmail.js';
import { createEmailSync, type CareProvides } from './sync.js';
import { registerEmailRoutes } from './routes.js';

export function createGmailServices(ctx: ModuleContext) {
  const store = createEmailStore(ctx.db, ctx.crypto);
  const api = createGmailApi(ctx, store);
  return { store, api, sync: createEmailSync(ctx, store, api) };
}
type Services = ReturnType<typeof createGmailServices>;
const instances = new WeakMap<ModuleContext, Services & { stop?: () => void }>();
function services(ctx: ModuleContext) {
  let service = instances.get(ctx);
  if (!service) { service = createGmailServices(ctx); instances.set(ctx, service); }
  return service;
}
export default defineModule({
  routes(app, ctx) { const { store, api, sync } = services(ctx); registerEmailRoutes(app, ctx, store, api, sync); },
  start(ctx) {
    configureComposio({ getApiKey: () => ctx.connections.secret('COMPOSIO_API_KEY'), mediaDir: path.join(ctx.dataDir, 'media'), log: ctx.log });
    const s = services(ctx);
    if (s.stop) return;
    if (ctx.modules.isEnabled('care')) ctx.modules.get<CareProvides>('care')?.careChannels.register(s.sync.connector);
    s.stop = ctx.schedule.every('gmail-sync', 120_000, s.sync.poll);
  },
  async stop(ctx) {
    const s = instances.get(ctx);
    if (!s) return;
    s.stop?.();
    ctx.modules.get<CareProvides>('care')?.careChannels.unregister(s.sync.connector.kind);
    await s.sync.connector.close(); instances.delete(ctx);
  },
});
