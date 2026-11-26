import { defineModule } from '../../../src/modules/sdk.js';
import { registerCareRoutes } from './api/index.js';
import { createCareSchema } from './persistence/schema.js';
import { careState, startCare, stopCare } from './module-runtime.js';
import { parseHandoffKeywords, parseHandoffPauseMinutes } from './policy/handoff.js';

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
      botSettings: () => {
        const all = ctx.settings.all();
        const num = (v: unknown, d: number): number => (Number.isFinite(Number(v)) ? Number(v) : d);
        return {
          aiEnabled: ctx.settings.get<boolean>('aiEnabled', true),
          autoSendEnabled: ctx.settings.get<boolean>('autoSendEnabled', false),
          handoffKeywords: parseHandoffKeywords(all.handoffKeywords),
          handoffPauseMinutes: parseHandoffPauseMinutes(all.handoffPauseMinutes),
          turnDebounceSeconds: num(ctx.settings.get<number>('turnDebounceSeconds', 0), 0),
          quietHoursStart: ctx.settings.get<string>('quietHoursStart', '22:00'),
          quietHoursEnd: ctx.settings.get<string>('quietHoursEnd', '07:00'),
        };
      },
      onError: (err) => ctx.log.error({ err }, 'care api error'),
    });
  },

  migrate(ctx) {
    // additive and idempotent: also lays the tables that are created in code (outbox, workflow, audit...)
    createCareSchema(ctx.db);
  },

  start: (ctx) => startCare(ctx),
  stop: (ctx) => stopCare(ctx),

  provides: (ctx) => ({
    get careChannels() {
      return careState(ctx).channels;
    },
  }),
});
