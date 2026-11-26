import { defineModule } from '../../../src/modules/sdk.js';
import { registerCareRoutes } from './api/index.js';
import { createCareSchema } from './persistence/schema.js';
import { createCustomersApi, type CareCustomersApi } from './customers-service.js';
import { careState, startCare, stopCare } from './module-runtime.js';

export default defineModule({
  routes(app, ctx) {
    const state = careState(ctx);
    const { runtime, stores } = state;
    registerCareRoutes(app, {
      stores,
      db: ctx.db,
      outboxService: runtime.service,
      reconcileIntent: async (intentId) => (await runtime.dispatcher.reconcile(intentId)).intent,
      backlogSources: [runtime.backlogSource],
      media: state.media,
      connectors: state.registry,
      onError: (err) => ctx.log.error({ err }, 'care api error'),
    });
  },

  migrate(ctx) {
    // additive and idempotent: also lays the tables that are created in code (outbox, workflow, audit...)
    createCareSchema(ctx.db);
  },

  start: (ctx) => startCare(ctx),
  stop: (ctx) => stopCare(ctx),

  provides: (ctx) => {
    let customers: CareCustomersApi | undefined;
    return {
      get careChannels() {
        return careState(ctx).channels;
      },
      /** read-only, decrypted customer data + the durable change feed (customers-service.ts); modules only, no HTTP */
      get customers(): CareCustomersApi {
        customers ??= createCustomersApi(ctx.db, () => careState(ctx).stores);
        return customers;
      },
    };
  },
});
