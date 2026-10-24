import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { emitVideoEvent } from '../edit/events.js';
import { addFile } from '../edit/library/store.js';
import { matchesExtension } from '../edit/library/sniff.js';
import { probeMedia } from '../edit/media.js';
import { StoreError, type VideoEditStore } from '../edit/store.js';
import type { CreationScene, VideoProject } from '../edit/types.js';
import type { Pipeline } from '../edit/pipeline/runner.js';
import { rocketFlowService, type RocketFlowService } from '../studio/service.js';
import { chatBriefSchema, createPlanSchema, flowCapabilitiesSchema, type FlowCapabilities } from './schema.js';

/** Conservative permission guard only: the agent still interprets storyboard/model/duration.
 * A quote must come from the host-owned user message and be an explicit instruction, not a question. */
export function explicitCreationPermission(quote: string): boolean {
  const text = quote.toLocaleLowerCase().trim();
  if (/[?？]/.test(text) || /^(?:can you|could you|how |why |có nên|có thể|liệu )/i.test(text) || /(?:được không|bao nhiêu|thế nào)/i.test(text) || /(?:chưa|đừng|không|chỉ|only|don't|do not)\s+(?:tạo|generate|create|lập|plan)/i.test(text)) return false;
  if (/^(?:tạo|generate|create)[.!]?$/.test(text)) return true;
  return /(?:(?:tạo|làm|dựng)\s+(?:đi|luôn|ngay|video|clip|ảnh|cho tôi|cho mình)|(?:hãy|rồi)\s+tạo|generate\s+(?:it|now|the|a|two|2)|create\s+(?:it|now|the|a|two|2)|make\s+(?:it|the|a|two|2))/i.test(text);
}
const sceneArg = z.object({ sceneId: z.string().regex(/^scene-\d+$/) }).strict();
const empty = z.object({}).strict();
const detailsSchema = z.object({ ok: z.literal(true), batchId: z.string(), done: z.boolean(), paused: z.boolean().optional(), items: z.array(z.object({
  batchId: z.string(), provider: z.literal('flow'), type: z.enum(['image', 'video']), prompt: z.string(), status: z.string(),
  error: z.string().nullish(), results: z.array(z.object({ kind: z.enum(['image', 'video']), path: z.string().nullish(), filename: z.string().nullish() }).passthrough()),
}).passthrough()) }).passthrough();
export interface CreationServiceOptions {
  store: VideoEditStore; pipeline: Pipeline; rocket?: RocketFlowService; downloadRoot?: string;
}
export function createCreationService({ store, pipeline, rocket = rocketFlowService, downloadRoot = process.env.ROCKETFLOW_DOWNLOAD_ROOT || path.join(os.homedir(), 'Downloads', 'RocketFlow') }: CreationServiceOptions) {
  const locks = new Map<string, Promise<unknown>>();
  function project(id: string, agentId?: string) {
    const p = store.loadProject(id);
    if (p?.mode !== 'create' || !p.creation) throw new StoreError(404, 'Không có dự án tạo mới.');
    if (agentId && p.agentId !== agentId) throw new StoreError(403, 'Agent không sở hữu dự án này.');
    return p as VideoProject & { creation: NonNullable<VideoProject['creation']> };
  }
  function authorize(id: string, agentId: string) {
    const p = project(id, agentId);
    return p;
  }
  function update(id: string, change: (p: ReturnType<typeof project>) => void) {
    const p = store.updateProject(id, raw => change(raw as ReturnType<typeof project>))!;
    emitVideoEvent(id, { type: 'project', project: p }); return p;
  }
  async function capabilities(id: string) {
    const parsed = JSON.parse(await rocket.call('list_capabilities', {}));
    const caps = flowCapabilitiesSchema.parse(parsed.flow);
    update(id, p => { p.creation.capabilities = caps; }); return caps;
  }
  function validateScene(p: ReturnType<typeof project>, scene: z.infer<typeof createPlanSchema>['scenes'][number], caps: FlowCapabilities) {
    if (p.creation.brief.sceneSeconds && (Math.abs(scene.durationSec - p.creation.brief.sceneSeconds) > .01 || (scene.kind === 'video' && scene.generationDuration !== `${p.creation.brief.sceneSeconds}s`))) throw new Error('Thời lượng từng clip phải đúng brief, không tự tạo dài rồi cắt.');
    if (!caps.types.includes(scene.kind) || !caps.models[scene.kind]?.includes(scene.model)) throw new Error(`Flow không công bố model ${scene.model} cho ${scene.kind}.`);
    if (!caps.ratios[scene.kind]?.includes(p.aspect)) throw new Error(`Flow ${scene.kind} không hỗ trợ tỉ lệ ${p.aspect}.`);
    if (p.creation.brief.model && scene.model !== p.creation.brief.model) throw new Error('Không tự thay model chủ kênh đã chỉ định.');
    if (p.creation.brief.visuals !== 'auto' && scene.kind !== p.creation.brief.visuals) throw new Error('Loại cảnh không khớp brief.');
    if (scene.kind === 'video' && (!scene.generationDuration || !caps.durations?.video?.includes(scene.generationDuration) || scene.durationSec > Number(scene.generationDuration.slice(0, -1)))) throw new Error('Thời lượng cảnh/video chưa được Flow hỗ trợ.');
    if (scene.kind === 'image' && scene.generationDuration) throw new Error('Cảnh ảnh không có thời lượng tạo video.');
  }
  async function details(id: string, scene: CreationScene, agentId: string) {
    const job = rocket.read(scene.requestId, agentId);
    if (job.project !== id) throw new Error('Job không thuộc dự án.');
    if (!job.jobId) return null;
    const result = detailsSchema.parse(JSON.parse(await rocket.call('get_job_details', { job_id: job.jobId })));
    if (result.batchId !== job.jobId || result.items.length !== 1 || result.items.some(i => i.batchId !== job.jobId || i.type !== scene.kind || i.prompt !== scene.prompt)) throw new Error('Kết quả không khớp job đã gửi.');
    return result;
  }
  async function operation(id: string, agentId: string, name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted(); let p = authorize(id, agentId);
    if (name === 'create_context' || name === 'create_status') { empty.parse(args); return { project: p, profile: store.getProfile(p.profileId), jobs: pipeline.queue.list(id), final: p.outputs.final ? `/api/m/video/edit/projects/${id}/media/final` : null }; }
    if (name === 'create_brief') {
      const brief = chatBriefSchema.parse(args);
      const request = p.creation.chatRequest;
      if (!request) throw new Error('Lượt này không có yêu cầu chat để xác lập brief.');
      const immutable = p.creation.scenes.some(s => s.state !== 'planned');
      if (immutable && (brief.targetSeconds !== p.creation.brief.targetSeconds || brief.aspect !== p.aspect || brief.visuals !== p.creation.brief.visuals || brief.model !== p.creation.brief.model || brief.sceneCount !== p.creation.brief.sceneCount || brief.audio !== p.creation.brief.audio || brief.sceneSeconds !== p.creation.brief.sceneSeconds)) throw new Error('Cảnh đã gửi: giữ metadata cũ, tiếp tục poll/import/render; không đổi brief hoặc tạo lại.');
      if (brief.intent === 'generate') {
        const quote = brief.authorizationQuote;
        if (!quote || !request.text.includes(quote) || !explicitCreationPermission(quote) || !explicitCreationPermission(request.text)) throw new StoreError(403, 'Tin nhắn chưa yêu cầu thực hiện tạo. Chỉ lập storyboard/trả lời; chờ chủ kênh nói tạo đi.');
      }
      if (immutable) return update(id, p => { p.creation.brief.generationAuthorized = brief.intent === 'generate'; p.creation.briefRequestId = request.id; }).creation;
      return update(id, p => {
        const previous = p.creation.brief;
        const next = { idea: p.creation.scenes.length ? previous.idea : request.text, visuals: brief.visuals, targetSeconds: brief.targetSeconds, audio: brief.audio, generationAuthorized: brief.intent === 'generate', ...(brief.model ? { model: brief.model } : {}), ...(brief.sceneCount ? { sceneCount: brief.sceneCount } : {}), ...(brief.sceneSeconds ? { sceneSeconds: brief.sceneSeconds } : {}) };
        if (JSON.stringify({ ...previous, generationAuthorized: false }) !== JSON.stringify({ ...next, generationAuthorized: false }) || p.aspect !== brief.aspect) { p.creation.scenes = []; delete p.creation.script; }
        p.title = brief.title; p.aspect = brief.aspect; p.creation.brief = next;
        p.creation.briefRequestId = request.id; p.creation.state = 'planning'; delete p.creation.error;
      }).creation;
    }
    if (name === 'flow_capabilities') { empty.parse(args); return await capabilities(id); }
    if (name === 'create_plan') {
      if (p.creation.chatRequest && p.creation.briefRequestId !== p.creation.chatRequest.id) throw new Error('Gọi create_brief để xác lập yêu cầu chat hiện tại trước khi lập cảnh.');
      const plan = createPlanSchema.parse(args);
      if (!p.creation.capabilities) throw new Error('Đọc flow_capabilities trước khi lập kế hoạch.');
      const caps = flowCapabilitiesSchema.parse(p.creation.capabilities);
      for (const scene of plan.scenes) validateScene(p, scene, caps);
      const total = plan.scenes.reduce((n,s) => n + s.durationSec, 0);
      if (Math.abs(total - p.creation.brief.targetSeconds) > .01) throw new Error('Tổng thời lượng phải đúng thời lượng trong brief.');
      if (p.creation.brief.sceneCount && plan.scenes.length !== p.creation.brief.sceneCount) throw new Error('Số cảnh phải đúng yêu cầu trong brief.');
      const previous = p.creation.scenes.map(({ id: _id, requestId: _requestId, state: _state, assetId: _asset, mediaFile: _file, mediaSha256: _hash, error: _error, ...scene }) => scene);
      if (JSON.stringify(previous) === JSON.stringify(plan.scenes) && p.creation.script === plan.script) return p.creation;
      if (p.creation.scenes.some(s => s.state !== 'planned')) {
        throw new Error('Đã gửi cảnh tạo. Kế hoạch được giữ cố định để không phát sinh lượt tạo ngoài ý muốn.');
      }
      return update(id, p => {
        p.creation.script = plan.script;
        p.creation.scenes = plan.scenes.map((s,i) => ({ ...s, id: `scene-${i+1}`, requestId: randomUUID(), state: 'planned' }));
        p.creation.state = 'planning'; delete p.creation.error;
      }).creation;
    }
    if (name === 'create_render') {
      empty.parse(args);
      if (p.creation.state === 'done' || pipeline.queue.list(id).some(j => j.kind === 'create-render' && ['queued','running'].includes(j.status))) return p.creation;
      if (!p.creation.scenes.length || p.creation.scenes.some(s => s.state !== 'imported')) throw new Error('Nhận đủ file cảnh trước khi xuất video.');
      update(id, p => { p.status = 'rendering'; p.creation.state = 'rendering'; delete p.creation.error; });
      const job = pipeline.queue.enqueue('create-render', id);
      update(id, p => { p.creation.renderJobId = job.id; }); return { job };
    }
    const pollArgs = name === 'create_poll' ? z.object({ sceneId: z.string().regex(/^scene-\d+$/), waitSeconds: z.number().int().min(0).max(20).default(15) }).strict().parse(args) : null;
    const { sceneId } = pollArgs ?? sceneArg.parse(args);
    if (pollArgs?.waitSeconds) { await delay(pollArgs.waitSeconds * 1000, undefined, { signal }); authorize(id, agentId); }
    const scene = p.creation.scenes.find(s => s.id === sceneId);
    if (!scene) throw new Error('Không có cảnh này.');
    if (name === 'create_generate') {
      if (!p.creation.brief.generationAuthorized || (p.creation.chatRequest && p.creation.briefRequestId !== p.creation.chatRequest.id)) throw new StoreError(403, 'Chưa xác lập yêu cầu tạo qua create_brief. Chỉ lập kế hoạch hoặc trả lời.');
      // The app owns IDs and immutable scene payloads; an agent cannot mint retry IDs.
      if (scene.state === 'cancelled') throw new Error('Cảnh đã huỷ.');
      if (scene.state !== 'planned') {
        try { return { scene, job: rocket.read(scene.requestId, agentId) }; }
        catch { throw new Error('Cảnh đã được giữ chỗ nhưng chưa có kết quả job. Không gửi lại; cần kiểm tra RocketFlow.'); }
      }
      const caps = await capabilities(id);
      signal?.throwIfAborted(); p = authorize(id, agentId); validateScene(p, scene, caps);
      update(id, p => { p.creation.state = 'generating'; p.creation.scenes.find(s => s.id === sceneId)!.state = 'submitted'; });
      const job = await rocket.submit({ requestId: scene.requestId, title: scene.title, kind: scene.kind, prompts: [scene.prompt], model: scene.model, aspect_ratio: p.aspect, ...(scene.kind === 'video' ? { duration: scene.generationDuration } : {}) }, { agentId, project: id });
      update(id, p => { const s = p.creation.scenes.find(s => s.id === sceneId)!; s.state = job.state === 'unknown' ? 'unknown' : 'submitted'; p.creation.state = job.state === 'unknown' ? 'blocked' : 'generating'; if (job.state === 'unknown') p.creation.error = 'Chưa rõ Flow đã nhận yêu cầu. Kiểm tra hàng đợi; không tạo lại cảnh.'; });
      return { sceneId, job };
    }
    if (name === 'create_cancel') {
      if (scene.state === 'planned') return update(id, p => { p.creation.scenes.find(s => s.id === sceneId)!.state = 'cancelled'; }).creation;
      const job = rocket.read(scene.requestId, agentId); if (job.project !== id) throw new Error('Job không thuộc dự án.');
      const result = await rocket.action(scene.requestId, 'cancel', agentId);
      update(id, p => {
        if (result.cancelState === 'confirmed') p.creation.scenes.find(s => s.id === sceneId)!.state = 'cancelled';
        else p.creation.error = 'Chưa rõ kết quả huỷ. Kiểm tra hàng đợi; không gửi lại lệnh huỷ.';
        p.creation.state = 'blocked';
      }); return result;
    }
    if (name !== 'create_poll' && name !== 'create_import') throw new Error('Công cụ không được phép.');
    if (scene.state === 'planned' || scene.state === 'cancelled') throw new Error('Cảnh chưa được gửi hoặc đã huỷ.');
    if (scene.state === 'imported') return { scene };
    const result = await details(id, scene, agentId);
    signal?.throwIfAborted(); authorize(id, agentId);
    if (!result) return { scene, outcome: 'unknown', message: 'Không có mã batch. Không tạo lại.' };
    const item = result.items[0];
    const ready = item.status === 'done';
    update(id, p => { const s = p.creation.scenes.find(s => s.id === sceneId)!; s.state = ready ? 'ready' : ['failed', 'stopped'].includes(item.status) ? 'failed' : 'submitted'; if (item.error) s.error = item.error; });
    if (name === 'create_poll' || !ready) return { sceneId, status: item.status, paused: result.paused, ready, error: item.error, waitSeconds: ready ? 0 : 15 };
    const output = item.results.find(r => r.kind === scene.kind && r.path);
    if (!output?.path || !path.isAbsolute(output.path)) throw new Error('Chưa có file tải về; không nhập URL hoặc đường dẫn do agent cung cấp.');
    const base = fs.realpathSync(downloadRoot);
    const source = fs.realpathSync(output.path);
    if (!source.startsWith(base + path.sep) || !path.relative(base, source).startsWith(`studio-${scene.requestId}${path.sep}`)) throw new Error('File không nằm trong thư mục tải riêng của job. Kiểm tra ROCKETFLOW_DOWNLOAD_ROOT.');
    const ext = path.extname(source).slice(1).toLowerCase();
    if (!(scene.kind === 'image' ? ['png','jpg','jpeg','webp'] : ['mp4','webm','mov']).includes(ext) || !matchesExtension(source, ext)) throw new Error('Định dạng file không hợp lệ.');
    const stat = fs.statSync(source); if (!stat.isFile() || stat.size <= 0 || stat.size > 512 * 1024 ** 2) throw new Error('File phải từ 1 byte đến 512 MB.');
    const targetDir = path.join(store.projectDir(id), 'generated'); fs.mkdirSync(targetDir, { recursive: true });
    const rel = `generated/${scene.id}.${ext}`; const target = path.join(store.projectDir(id), rel);
    fs.copyFileSync(source, target);
    const media = await probeMedia(target);
    signal?.throwIfAborted(); authorize(id, agentId);
    if (!media.width || !media.height || (scene.kind === 'video' && media.durationSec + .1 < scene.durationSec)) throw new Error('File tải về thiếu hình hoặc ngắn hơn cảnh.');
    const mediaSha256 = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    const asset = await addFile(store.root, { kind: scene.kind, tempPath: target, fileName: `${id}-${scene.id}.${ext}`, move: false, meta: { name: scene.title, tags: ['flow', `project:${id}`, `job:${scene.requestId}`] } });
    return update(id, p => {
      Object.assign(p.creation.scenes.find(s => s.id === sceneId)!, { state: 'imported', mediaFile: rel, mediaSha256, assetId: asset.id });
      delete p.creation.error;
      if (p.creation.scenes.every(s => s.state === 'imported')) p.creation.state = 'ready';
    }).creation;
  }
  return { authorize, project,
    beginRequest(id: string, agentId: string, requestId: string, text: string) {
      authorize(id, agentId);
      return update(id, p => { p.creation.chatRequest = { id: requestId, text }; p.creation.brief.generationAuthorized = false; delete p.creation.briefRequestId; delete p.creation.error; });
    },
    execute(id: string, agentId: string, name: string, args: unknown, signal?: AbortSignal) {
      const prior = locks.get(id) ?? Promise.resolve();
      const next = prior.catch(() => {}).then(() => operation(id, agentId, name, args, signal)).catch(error => {
        try { const p = project(id, agentId); if (!['done','rendering'].includes(p.creation.state)) update(id, p => { p.creation.error = error instanceof Error ? error.message : String(error); p.creation.state = 'blocked'; }); } catch { /* absent or foreign project */ }
        throw error;
      });
      locks.set(id, next);
      void next.finally(() => { if (locks.get(id) === next) locks.delete(id); }).catch(() => {});
      return next;
    },
  };
}
export type CreationService = ReturnType<typeof createCreationService>;
