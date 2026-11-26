/** Cloudflare Workers entry point: HTTP requests and the daily cron. */
import { createApp } from './app';
import { workersEnv, type WorkerBindings } from './platform/workers';
import { runMaintenance } from './services/maintenance';
import { ApiError } from './http/errors';

export type { WorkerBindings };

const app = createApp();

const notConfigured = () => { throw new ApiError(503, 'not_configured', 'Chưa cấu hình kho tệp.'); };

function envFor(bindings: WorkerBindings) {
  return workersEnv(bindings, { presignPut: notConfigured, presignGet: notConfigured });
}

export default {
  fetch(request, bindings, ctx) {
    return app.fetch(request, envFor(bindings), ctx);
  },
  async scheduled(_controller, bindings, ctx) {
    ctx.waitUntil(runMaintenance(envFor(bindings)));
  },
} satisfies ExportedHandler<WorkerBindings>;
