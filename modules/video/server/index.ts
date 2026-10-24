import path from 'node:path';
import { Hono } from 'hono';
import { defineModule, type ModuleContext } from '../../../src/modules/sdk.js';
import { bindModuleCtx } from './host.js';
import { bindPaths } from './paths.js';
import { bindKol, kolAvailable } from './kol-port.js';
import { bindApprovals, registerApprovalRoutes } from './approvals.js';
import { findBin, FFMPEG_HINT } from './bin.js';
import { createVideoActions, type ActionRuntime } from './actions.js';
import { advanceCreations } from './creation-worker.js';
import { lessonsFor } from './lessons-lite.js';
import { registerVideoEditRoutes } from './edit/routes.js';
import { registerVideoEditApprovalHandlers } from './edit/agent/approval-handler.js';
import { registerVideoStudioRoutes } from './studio/routes.js';
import { rocketFlowService } from './studio/service.js';
import { heygenIntegration } from './edit/production/heygen.js';
import { setActivePipeline } from './edit/pipeline/jobs.js';
import { ffmpegBin, ffprobeBin } from './edit/pipeline/tools.js';

interface Runtime extends ActionRuntime {
  stop(): void;
}

export function createVideoModule() {
  const runtimes = new WeakMap<ModuleContext, Runtime>();
  const runtimeOf = (ctx: unknown) => runtimes.get(ctx as ModuleContext);

  return defineModule({
    integrations: [heygenIntegration],

    actions: createVideoActions(runtimeOf),

    routes(app, ctx) {
      const rt = runtimes.get(ctx);
      if (!rt) { app.all('*', (c) => c.json({ error: 'Module video chưa chạy.' }, 503)); return; }
      app.get('/health', (c) => c.json({
        ffmpeg: Boolean(findBin('ffmpeg')) || ffmpegBin() !== 'ffmpeg',
        ffprobe: Boolean(findBin('ffprobe')) || ffprobeBin() !== 'ffprobe',
        hint: findBin('ffmpeg') ? null : FFMPEG_HINT,
        kol: kolAvailable(),
      }));
      app.route('/', rt.inner);
    },

    start(ctx) {
      runtimes.get(ctx)?.stop();
      bindModuleCtx(ctx);
      bindPaths({ rootDir: path.resolve(ctx.dir, '..', '..'), dataDir: ctx.dataDir });
      bindKol(ctx);
      bindApprovals(path.join(ctx.dataDir, 'video-edit'), {
        onCreated: (a) => ctx.attention.raise({ key: `video:approval:${a.id}`, title: a.title, detail: a.summary.slice(0, 300), link: '/m/video', severity: 'info' }),
        onSettled: (a) => ctx.attention.resolve(`video:approval:${a.id}`),
      });
      registerVideoEditApprovalHandlers();

      const inner = new Hono();
      const edit = registerVideoEditRoutes(inner, { lessons: lessonsFor });
      registerVideoStudioRoutes(inner);
      registerApprovalRoutes(inner);

      let advancing = false;
      const stopTick = ctx.schedule.every('create-advance', 10_000, async () => {
        if (advancing || !ctx.settings.get<boolean>('auto_advance_create', true)) return;
        advancing = true;
        try { await advanceCreations(edit.store, edit.creation); }
        catch (err) { ctx.log.warn({ err }, 'video: create tick failed'); }
        finally { advancing = false; }
      });

      const rt: Runtime = {
        root: path.join(ctx.dataDir, 'video-edit'),
        inner,
        store: edit.store,
        pipeline: edit.pipeline,
        stop() {
          stopTick();
          edit.stop();
          void rocketFlowService.close().catch(() => undefined);
          setActivePipeline(null);
        },
      };
      runtimes.set(ctx, rt);
    },

    stop(ctx) {
      runtimes.get(ctx)?.stop();
      runtimes.delete(ctx);
      bindApprovals(null);
      bindKol(null);
      bindModuleCtx(undefined);
    },

    provides(ctx) {
      return {
        /** Is ffmpeg installed? (marketing, kol can warn before queuing a render) */
        ffmpegReady: () => Boolean(findBin('ffmpeg') && findBin('ffprobe')),
        /** Active and queued Video Studio jobs of one project. */
        jobs: (projectId: string) => runtimes.get(ctx)?.pipeline.queue.list(projectId) ?? [],
      };
    },

    agentContext({ scopes }, ctx) {
      if (!scopes.length) return undefined;
      const rt = runtimes.get(ctx);
      if (!rt) return undefined;
      const projects = rt.store.listProjects();
      if (!projects.length) return 'Video Studio: chưa có việc dựng nào.';
      const busy = projects.filter((p) => p.busy).length;
      const recent = projects.slice(0, 5).map((p) => `- ${p.title} (${p.mode ?? 'edit'}, ${p.status})`).join('\n');
      return `Video Studio: ${projects.length} việc dựng${busy ? `, ${busy} đang chạy` : ''}.\n${recent}`;
    },
  });
}

export default createVideoModule();
