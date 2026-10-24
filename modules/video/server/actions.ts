/** Agent-callable actions of the video module (<aios-action module="video" name="...">). */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ModuleAction } from '../../../src/modules/sdk.js';
import type { Hono } from 'hono';
import type { VideoEditStore } from './edit/store.js';
import type { Pipeline } from './edit/pipeline/runner.js';
import { creationServiceFor, parseCreationArgs } from './create/runtime.js';
import { executeProduceTool, parseProduceArgs } from './edit/production/tools.js';
import { productionServiceFor } from './edit/production/runtime.js';

export interface ActionRuntime {
  root: string;
  inner: Hono;
  store: VideoEditStore;
  pipeline: Pipeline;
}

type Runtimes = (ctx: unknown) => ActionRuntime | undefined;

const toolCall = z.object({ projectId: z.string().uuid(), tool: z.string().min(1).max(60), args: z.record(z.string(), z.unknown()).default({}) }).strict();

const jobCreate = z.object({
  mode: z.enum(['produce', 'create']).default('produce'),
  brief: z.string().trim().min(3).max(6000),
  title: z.string().trim().max(90).optional(),
  aspect: z.enum(['9:16', '16:9', '1:1', '4:5']).optional(),
  targetSec: z.number().int().min(5).max(180).optional(),
  /** produce: KOL handles/ids called in the video (needs the KOL module). */
  cast: z.array(z.string().min(1).max(80)).max(6).optional(),
}).strict();

const projectRef = z.object({ projectId: z.string().uuid() }).strict();

async function viaApp(rt: ActionRuntime, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await rt.inner.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const need = (rt: ActionRuntime | undefined): ActionRuntime => {
  if (!rt) throw new Error('Module video chưa chạy.');
  return rt;
};

export function createVideoActions(runtime: Runtimes): Record<string, ModuleAction> {
  return {
    'job.create': {
      scope: 'studio.write',
      description: 'Tạo một video mới trong Video Studio. mode "produce": kịch bản + phân cảnh cùng KOL (cần module KOL, truyền cast). mode "create": tạo cảnh bằng Google Flow qua RocketFlow. Đạo diễn AI sẽ làm tiếp; chi phí luôn chờ chủ duyệt.',
      example: { mode: 'produce', brief: 'Video 45 giây giới thiệu sản phẩm mới', cast: ['tonytrieu'], aspect: '9:16', targetSec: 45 },
      async handler(payload, _call, ctx) {
        const rt = need(runtime(ctx));
        const b = jobCreate.parse(payload);
        if (b.mode === 'create') {
          const r = await viaApp(rt, '/edit/creation/projects', { requestId: randomUUID(), text: b.brief });
          if (r.status >= 400) throw new Error(String(r.json.error ?? 'Không tạo được dự án.'));
          const project = r.json.project as { id: string; title: string };
          return { projectId: project.id, title: project.title, mode: 'create', link: '/m/video' };
        }
        const r = await viaApp(rt, '/edit/productions', { brief: b.brief, cast: b.cast ?? [], aspect: b.aspect ?? '9:16', targetSec: b.targetSec ?? 45, ...(b.title ? { title: b.title } : {}), agent: true });
        if (r.status >= 400) throw new Error(String(r.json.error ?? 'Không tạo được video.'));
        const production = r.json.production as { id: string; projectId?: string; title: string };
        return { productionId: production.id, projectId: production.projectId, title: production.title, mode: 'produce', link: '/m/video' };
      },
    },
    'job.status': {
      scope: 'studio.read',
      description: 'Xem trạng thái một việc dựng: bước đang chạy, tiến độ và các job nền.',
      example: { projectId: '00000000-0000-4000-8000-000000000000' },
      handler(payload, _call, ctx) {
        const rt = need(runtime(ctx));
        const { projectId } = projectRef.parse(payload);
        const p = rt.store.loadProject(projectId);
        if (!p) throw new Error('Không tìm thấy việc dựng này.');
        return {
          id: p.id, title: p.title, mode: p.mode ?? 'edit', status: p.status, busy: p.busy, planVersion: p.planVersion, planStatus: p.planStatus ?? null,
          steps: p.steps.map((s) => ({ key: s.key, status: s.status, progress: s.progress ?? null })),
          jobs: rt.pipeline.queue.list(projectId).slice(-6).map((j) => ({ kind: j.kind, status: j.status, progress: j.progress ?? null, message: j.message ?? null })),
          final: Boolean(p.outputs?.final),
        };
      },
    },
    'job.cancel': {
      scope: 'studio.write',
      description: 'Dừng lượt đạo diễn và các job nền (cắt, xuất video) của một việc dựng.',
      example: { projectId: '00000000-0000-4000-8000-000000000000' },
      handler(payload, _call, ctx) {
        const rt = need(runtime(ctx));
        const { projectId } = projectRef.parse(payload);
        if (!rt.store.loadProject(projectId)) throw new Error('Không tìm thấy việc dựng này.');
        rt.pipeline.abort(projectId);
        return { cancelled: true };
      },
    },
    'create.call': {
      scope: 'studio.write',
      description: 'Dành cho đạo diễn mode create: gọi một công cụ tạo video (create_brief, create_plan, create_cancel...). Dùng đúng khối hướng dẫn trong prompt.',
      example: { projectId: '00000000-0000-4000-8000-000000000000', tool: 'create_brief', args: {} },
      async handler(payload, call, ctx) {
        const rt = need(runtime(ctx));
        const b = toolCall.parse(payload);
        const project = rt.store.loadProject(b.projectId);
        if (!project || project.mode !== 'create') throw new Error('Dự án này không phải dự án tạo mới.');
        if (project.agentId !== call.agentId) throw new Error('Agent không phải đạo diễn của dự án này.');
        const service = creationServiceFor(rt.root);
        if (!service) throw new Error('Dịch vụ tạo video chưa chạy.');
        const args = parseCreationArgs(b.tool, b.args);
        return service.execute(project.id, call.agentId, b.tool, args);
      },
    },
    'produce.call': {
      scope: 'studio.write',
      description: 'Dành cho đạo diễn mode produce: sửa kịch bản/phân cảnh hoặc xin duyệt chi phí (produce_update_scene, produce_request_generation...). Không công cụ nào tự tốn tiền.',
      example: { projectId: '00000000-0000-4000-8000-000000000000', tool: 'produce_estimate', args: {} },
      async handler(payload, call, ctx) {
        const rt = need(runtime(ctx));
        const b = toolCall.parse(payload);
        const project = rt.store.loadProject(b.projectId);
        if (!project || project.mode !== 'produce' || !project.productionId) throw new Error('Dự án này không phải video sản xuất.');
        if (project.agentId !== call.agentId) throw new Error('Agent không phải đạo diễn của video này.');
        const service = productionServiceFor(rt.root);
        if (!service) throw new Error('Dịch vụ sản xuất chưa chạy.');
        const args = parseProduceArgs(b.tool, b.args);
        return executeProduceTool(service, project.productionId, b.tool, args);
      },
    },
  };
}
