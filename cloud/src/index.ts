/** Cloudflare Workers entry point: HTTP requests and the daily cron. */
import { createApp } from './app';
import { workersEnv, type WorkerBindings } from './platform/workers';
import { runMaintenance } from './services/maintenance';
import { ApiError } from './http/errors';
import { devPresigner, r2S3Presigner, type Presigner } from './storage/presign';
import { readConfig } from './config';

export type { WorkerBindings };

const app = createApp();

const notConfigured: Presigner = {
  presignPut: () => { throw new ApiError(503, 'not_configured', 'Máy chủ chưa cấu hình khoá R2 để ký đường dẫn.'); },
  presignGet: () => { throw new ApiError(503, 'not_configured', 'Máy chủ chưa cấu hình khoá R2 để ký đường dẫn.'); },
};

/** R2's S3 endpoint when keys are set; the local stand-in under `wrangler dev`; otherwise a clear error. */
function presignerFor(b: WorkerBindings, origin: string | undefined): Presigner {
  if (b.R2_ACCOUNT_ID && b.R2_ACCESS_KEY_ID && b.R2_SECRET_ACCESS_KEY) {
    return r2S3Presigner({
      accountId: b.R2_ACCOUNT_ID,
      bucket: b.R2_BUCKET_NAME || 'agenticos-cloud',
      accessKeyId: b.R2_ACCESS_KEY_ID,
      secretAccessKey: b.R2_SECRET_ACCESS_KEY,
    }, () => Date.now());
  }
  if (origin && readConfig(b).devMode) {
    const host = new URL(origin).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return devPresigner(origin, () => Date.now());
  }
  return notConfigured;
}

export default {
  fetch(request, bindings, ctx) {
    return app.fetch(request, workersEnv(bindings, presignerFor(bindings, new URL(request.url).origin)), ctx);
  },
  async scheduled(_controller, bindings, ctx) {
    ctx.waitUntil(runMaintenance(workersEnv(bindings, presignerFor(bindings, undefined))));
  },
} satisfies ExportedHandler<WorkerBindings>;
