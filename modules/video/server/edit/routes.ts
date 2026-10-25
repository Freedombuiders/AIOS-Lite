import type { RocketFlowService } from '../studio/service.js';
import { createCreationService } from '../create/service.js';
import { bindCreationService } from '../create/runtime.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { STORE_DIR } from '../paths.js';
import { VIDEO_STYLES } from './catalog/styles.js';
import { runDoctor } from './doctor.js';
import { emitVideoEvent, subscribeVideoEvents } from './events.js';
import { registerVideoLibraryRoutes } from './library/routes.js';
import { formatSize, ingestSummary, makeThumbnail, probeMedia } from './media.js';
import { createPipeline, type PipelineTools } from './pipeline/runner.js';
import { registerEditorRoutes } from './routes-editor.js';
import { registerPlanV2Routes } from './routes-plan-v2.js';
import { registerProductionRoutes, type ProductionKit } from './production/routes.js';
import { serveFile } from './serve.js';
import { createVideoEditStore, StoreError, type VideoEditStore } from './store.js';
import { registerTemplateRoutes } from './templates/routes.js';
import { listVideoAgents, resolveDefaultAgentId } from './turn.js';
import {
  STEP_DEFS, STYLE_GROUPS,
  type MediaInfo, type StepKey, type VideoMessage, type VideoProfile, type VideoProject,
} from './types.js';

const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'];
const DEFAULT_MAX_UPLOAD = 4 * 1024 ** 3;
const SSE_PING_MS = 15_000;

const aspectSchema = z.enum(['9:16', '16:9', '1:1', '4:5']);
const platformSchema = z.enum(['tiktok', 'facebook', 'youtube', 'instagram', 'linkedin', 'other']);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const stepKeys = STEP_DEFS.map((d) => d.key) as [StepKey, ...StepKey[]];

const fontRef = z.string().max(200);
const profileShape = {
  name: z.string().trim().min(1).max(80),
  handle: z.string().trim().max(80),
  platform: platformSchema,
  color: colorSchema,
  defaultStyleId: z.string().max(40).nullable(),
  defaultAspect: aspectSchema,
  brand: z.object({
    primary: z.string().max(40).optional(), accent: z.string().max(40).optional(),
    text: z.string().max(40).optional(), cardBg: z.string().max(60).optional(),
    light: z.string().max(40).optional(), dark: z.string().max(40).optional(),
    fontHeading: fontRef.optional(), fontBody: fontRef.optional(),
    fontCaption: fontRef.optional(), fontCover: fontRef.optional(),
    logoAssetId: fontRef.optional(),
  }).strict(),
  seriesName: z.string().trim().max(80).nullable(),
  audio: z.object({
    speechRate: z.number().min(0.5).max(2),
    voiceLufs: z.number().min(-40).max(-5),
    musicLufs: z.number().min(-60).max(-10),
    finalLufs: z.number().min(-30).max(-8),
  }).strict(),
  keepWords: z.array(z.string().trim().min(1).max(80)).max(80),
  coverStyle: z.string().trim().max(60).nullable(),
  deliverDir: z.string().trim().max(500).nullable(),
  starter: z.enum(['blank', 'editorial', 'neon', 'energetic']).nullable(),
  taste: z.string().max(20000),
  onboarding: z.record(z.string().max(40), z.string().max(4000)).refine((o) => Object.keys(o).length <= 20),
  referenceChannels: z.array(z.string().trim().url().max(500)).max(10),
  brainVaultId: z.string().trim().min(1).max(80).nullable(),
  autoApprovePlan: z.boolean(),
};
const profilePatchSchema = z.object(profileShape).partial().strict();
const profileCreateSchema = z.object(profileShape).partial().extend({ name: profileShape.name }).strict();

const STARTER_BRANDS: Record<string, Record<string, string>> = {
  blank: {},
  editorial: { primary: '#1F2937', accent: '#D4A24C', text: '#F8F5EE', dark: '#111827', light: '#F8F5EE', cardBg: '#1F2937', fontHeading: 'Playfair Display', fontCaption: 'Be Vietnam Pro' },
  neon: { primary: '#0B1020', accent: '#22D3EE', text: '#E2E8F0', dark: '#05060F', light: '#E2E8F0', cardBg: '#0B1020', fontHeading: 'Saira Condensed', fontCaption: 'Be Vietnam Pro' },
  energetic: { primary: '#111111', accent: '#FACC15', text: '#FFFFFF', dark: '#111111', light: '#FFFFFF', cardBg: '#1A1A1A', fontHeading: 'Anton', fontCaption: 'Be Vietnam Pro' },
};


const projectCreateSchema = z.object({
  profileId: z.string(),
  title: z.string().trim().max(120).optional(),
  styleId: z.string().max(40).optional(),
  aspect: aspectSchema.optional(),
  agentId: z.string().max(64).optional(),
}).strict();

const projectPatchSchema = z.object({
  chosenCover: z.number().int().min(1).max(3).nullable(),
  title: z.string().trim().min(1).max(120),
  styleId: z.string().max(40).nullable(),
  aspect: aspectSchema,
  agentId: z.string().max(64),
  targetSeconds: z.number().int().min(5).max(3600).nullable(),
}).partial().strict();

const messageSchema = z.object({
  text: z.string().trim().min(1).max(8000),
  styleId: z.string().max(40).optional(),
  attachments: z.array(z.object({
    kind: z.enum(['video', 'asset']),
    ref: z.string().min(1).max(500),
    label: z.string().min(1).max(200),
  }).strict()).max(10).optional(),
}).strict();

const runSchema = z.object({ step: z.enum(stepKeys) }).strict();

const known = (styleId: string) => VIDEO_STYLES.some((s) => s.id === styleId);

export interface VideoEditRouteOptions {
  /** Video Studio › Sản xuất test seams (HeyGen, KOL bridge, RocketFlow, poll interval). */
  production?: Partial<Pick<ProductionKit, 'heygen' | 'kol' | 'stock' | 'rocket' | 'rocketInstalled' | 'rocketDownloadRoot' | 'pollMs' | 'approvals' | 'writer' | 'agentTurns' | 'publish'>>;
  creationRocket?: RocketFlowService;
  creationDownloadRoot?: string;
  root?: string;
  probe?: typeof probeMedia;
  thumbnail?: typeof makeThumbnail;
  doctor?: typeof runDoctor;
  /** Heavy-step overrides (normalize, transcribe, analyze, render, covers, runDirector, …) for tests. */
  tools?: Partial<PipelineTools>;
  /** Replaces the loopback check of the internal /agent routes (tests). */
  isLocal?: (c: Context) => boolean;
  /** Start queued work immediately. Default true. */
  autoStart?: boolean;
  /** Lessons for the director prompt. */
  lessons?: (query: string) => string[];
}

export function registerVideoEditRoutes(app: Hono, options: VideoEditRouteOptions = {}) {
  const root = options.root ?? path.join(STORE_DIR, 'video-edit');
  const probe = options.probe ?? probeMedia;
  const thumbnail = options.thumbnail ?? makeThumbnail;
  const doctor = options.doctor ?? runDoctor;
  const store: VideoEditStore = createVideoEditStore(root);
  const pipe = createPipeline({ store, root, tools: options.tools, autoStart: options.autoStart, ...(options.lessons ? { lessons: options.lessons } : {}) });
  const creation = createCreationService({ store, pipeline: pipe, rocket: options.creationRocket, downloadRoot: options.creationDownloadRoot });
  bindCreationService(root, creation);
  const uploading = new Set<string>();
  const P = '/edit';

  const fail = (c: Context, status: 400 | 403 | 404 | 409 | 413 | 415 | 422 | 500 | 501, error: string, code?: string) =>
    c.json({ error, ...(code ? { code } : {}) }, status);

  // Only JSON routes get the small cap; the upload route streams a file and has none.
  const small = bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) => fail(c, 413, 'Nội dung gửi lên quá lớn.', 'too_large'),
  });

  const guard = (fn: (c: Context) => Response | Promise<Response>) => async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof StoreError) return fail(c, err.status, err.message, err.code);
      if (err instanceof z.ZodError) return fail(c, 400, 'Dữ liệu chưa hợp lệ. Kiểm tra lại các trường đã nhập.', 'invalid');
      return fail(c, 500, 'Có lỗi ở máy chủ. Thử lại sau ít giây.');
    }
  };

  async function parse<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
    return schema.parse(await c.req.json().catch(() => null));
  }

  const idOf = (c: Context) => c.req.param('id') ?? '';
  const requireProject = (id: string): VideoProject => {
    const project = store.loadProject(id);
    if (!project) throw new StoreError(404, 'Không tìm thấy việc dựng này.');
    return project;
  };

  const emitProject = (project: VideoProject) => emitVideoEvent(project.id, { type: 'project', project });

  app.get(`${P}/creation/projects`, guard(c => c.json({ projects: store.listProjects().filter(p => p.mode === 'create') })));
  app.post(`${P}/creation/projects`, small, guard(async c => {
    const body = await parse(c, z.object({ requestId: z.string().uuid(), text: z.string().trim().min(1).max(12000), agentId: z.string().optional() }).strict());
    const agentId = body.agentId ?? resolveDefaultAgentId();
    if (!listVideoAgents().some(a => a.id === agentId && ['claude', 'anthropic-compatible', 'openai'].includes(a.provider))) return fail(c, 400, 'Chọn agent Claude hoặc Codex đã cấu hình.');
    const requestDir = path.join(root, 'creation-requests'); fs.mkdirSync(requestDir, { recursive: true, mode: 0o700 });
    const requestFile = path.join(requestDir, `${body.requestId}.json`), payload = JSON.stringify({ ...body, agentId });
    if (fs.existsSync(requestFile)) {
      const previous = JSON.parse(fs.readFileSync(requestFile, 'utf8')) as { payload: string; projectId?: string };
      if (previous.payload !== payload) return fail(c, 409, 'Tin nhắn ID đã dùng với nội dung khác.');
      if (!previous.projectId) return fail(c, 409, 'Lần tạo dự án bị gián đoạn. Kiểm tra danh sách trước khi tạo việc khác.');
      return c.json({ project: requireProject(previous.projectId) });
    }
    fs.writeFileSync(requestFile, JSON.stringify({ payload }), { flag: 'wx', mode: 0o600 });
    let p: VideoProject;
    try {
      // A neutral profile supplies renderer defaults; owners do not need a brand form to chat.
      const profile = store.listProfiles()[0] ?? store.createProfile({ name: 'Video mới' });
      p = store.createProject({ profileId: profile.id, title: body.text.slice(0, 80), agentId, aspect: '9:16' });
      store.updateProject(p.id, p => { p.mode = 'create'; p.creation = { brief: { idea: body.text, visuals: 'auto', targetSeconds: 16, audio: 'native', generationAuthorized: false }, state: 'brief', scenes: [], chatRequest: { id: body.requestId, text: body.text } }; p.steps = p.steps.map(s => ['direct', 'render'].includes(s.key) ? s : { ...s, status: 'skipped' }); });
      try { creation.authorize(p.id, agentId); } catch (error) { store.deleteProject(p.id); throw error; }
    } catch (error) { fs.unlinkSync(requestFile); throw error; }
    const temp = `${requestFile}.tmp`; fs.writeFileSync(temp, JSON.stringify({ payload, projectId: p.id }), { mode: 0o600 }); fs.renameSync(temp, requestFile);
    pipe.appendMessage(p.id, { id: body.requestId, role: 'user', text: body.text });
    pipe.beginTurn(p.id, 'chat', body.text);
    return c.json({ project: store.loadProject(p.id) });
  }));
  app.get(`${P}/creation/projects/:id`, guard(c => {
    const project = creation.project(idOf(c));
    return c.json({ project, messages: store.readMessages(project.id), jobs: pipe.queue.list(project.id) });
  }));
  app.post(`${P}/creation/projects/:id/messages`, small, guard(async c => {
    const p = creation.project(idOf(c)); creation.authorize(p.id, p.agentId);
    const { requestId, text } = await parse(c, z.object({ requestId: z.string().uuid(), text: z.string().trim().min(1).max(12000) }).strict());
    const previous = store.readMessages(p.id).find(m => m.id === requestId);
    if (previous) { if (previous.text !== text || previous.role !== 'user') return fail(c, 409, 'ID tin nhắn đã dùng.'); return c.json({ project: store.loadProject(p.id) }); }
    if (p.busy) return fail(c, 409, 'Agent đang xử lý. Chờ hoặc dừng trước khi gửi.');
    creation.beginRequest(p.id, p.agentId, requestId, text);
    pipe.appendMessage(p.id, { id: requestId, role: 'user', text });
    pipe.beginTurn(p.id, 'chat', text);
    return c.json({ project: store.loadProject(p.id) });
  }));
  // Compatibility for old resume clients: an empty resume only reads existing work, never grants generation.
  app.post(`${P}/creation/projects/:id/start`, small, guard(async c => {
    const p = creation.project(idOf(c)); creation.authorize(p.id, p.agentId);
    const { note } = await parse(c, z.object({ note: z.string().max(8000).optional() }).strict());
    if (p.busy) return fail(c, 409, 'Agent đang xử lý.');
    const text = note?.trim() || 'Đọc tiến độ các job đã gửi và nhập/xuất các file đã có. Không gửi lượt tạo mới.';
    const requestId = randomUUID(); creation.beginRequest(p.id, p.agentId, requestId, text);
    pipe.appendMessage(p.id, { id: requestId, role: 'user', text }); pipe.beginTurn(p.id, 'chat', text);
    return c.json({ project: store.loadProject(p.id) });
  }));
  app.get(`${P}/creation/projects/:id/scenes/:sceneId`, guard(c => {
    const p = creation.project(idOf(c));
    const scene = p.creation.scenes.find(s => s.id === c.req.param('sceneId'));
    if (scene?.state !== 'imported' || !scene.mediaFile || !/^generated\/scene-\d+\.(png|jpg|jpeg|webp|mp4|webm|mov)$/.test(scene.mediaFile)) return fail(c, 404, 'Chưa có file cảnh.');
    return serveFile(c, path.join(store.projectDir(p.id), scene.mediaFile));
  }));

  // ── Read-only catalogs ──
  app.get(`${P}/doctor`, guard(async (c) => c.json(await doctor(root))));
  app.get(`${P}/agents`, guard((c) => c.json({ agents: listVideoAgents(), defaultAgentId: resolveDefaultAgentId() })));
  app.get(`${P}/styles`, (c) => c.json({ groups: STYLE_GROUPS, styles: VIDEO_STYLES }));
  app.get(`${P}/brains`, guard((c) => c.json({ enabled: true, activeVaultId: 'default', vaults: [{ id: 'default', name: 'Kho tri thức' }] })));
  registerVideoLibraryRoutes(app, { root });
  registerTemplateRoutes(app, { root });

  // ── Profiles ──
  app.get(`${P}/profiles`, guard((c) => c.json({ profiles: store.listProfiles() })));

  type ProfileBody = z.infer<typeof profilePatchSchema>;

  function applyProfileFields(current: VideoProfile, body: ProfileBody): VideoProfile {
    const { defaultStyleId, brainVaultId, handle, seriesName, coverStyle, deliverDir, starter, ...rest } = body;
    const next: VideoProfile = { ...current, ...rest } as VideoProfile;
    if (defaultStyleId !== undefined) { if (defaultStyleId === null) delete next.defaultStyleId; else next.defaultStyleId = defaultStyleId; }
    if (brainVaultId !== undefined) { if (brainVaultId === null) delete next.brainVaultId; else next.brainVaultId = brainVaultId; }
    if (handle !== undefined) { if (handle) next.handle = handle; else delete next.handle; }
    if (seriesName !== undefined) { if (seriesName) next.seriesName = seriesName; else delete next.seriesName; }
    if (coverStyle !== undefined) { if (coverStyle) next.coverStyle = coverStyle; else delete next.coverStyle; }
    if (deliverDir !== undefined) { if (deliverDir) next.deliverDir = deliverDir; else delete next.deliverDir; }
    if (starter !== undefined) { if (starter) next.starter = starter; else delete next.starter; }
    return next;
  }

  const checkProfileBody = (c: Context, body: ProfileBody): Response | null => {
    if (body.defaultStyleId && !known(body.defaultStyleId)) return fail(c, 400, 'Phong cách không tồn tại.');
    if (body.brainVaultId && body.brainVaultId !== 'default') return fail(c, 400, 'Second Brain không tồn tại.');
    if (body.deliverDir && !path.isAbsolute(body.deliverDir)) return fail(c, 400, 'Thư mục giao phải là đường dẫn đầy đủ (bắt đầu bằng /).', 'bad_deliver_dir');
    return null;
  };

  app.post(`${P}/profiles`, small, guard(async (c) => {
    const body = await parse(c, profileCreateSchema);
    const bad = checkProfileBody(c, body);
    if (bad) return bad;
    const created = store.createProfile({
      name: body.name, handle: body.handle, platform: body.platform, defaultAspect: body.defaultAspect,
      defaultStyleId: body.defaultStyleId ?? undefined, color: body.color,
    });
    const { name: _n, handle: _h, platform: _p, defaultAspect: _a, defaultStyleId: _d, color: _c, ...extra } = body;
    void [_n, _h, _p, _a, _d, _c];
    if (!extra.brand && extra.starter && STARTER_BRANDS[extra.starter]) extra.brand = STARTER_BRANDS[extra.starter];
    const profile = Object.keys(extra).length ? store.saveProfile(applyProfileFields(created, extra)) : created;
    return c.json({ profile: { ...profile, projectCount: 0 } });
  }));

  app.patch(`${P}/profiles/:id`, small, guard(async (c) => {
    const body = await parse(c, profilePatchSchema);
    const current = store.getProfile(idOf(c));
    if (!current) return fail(c, 404, 'Không tìm thấy hồ sơ kênh.');
    const bad = checkProfileBody(c, body);
    if (bad) return bad;
    return c.json({ profile: store.saveProfile(applyProfileFields(current, body)) });
  }));

  app.delete(`${P}/profiles/:id`, guard((c) => {
    store.deleteProfile(idOf(c));
    return c.json({ ok: true });
  }));

  // ── Projects ──
  // Legacy create chats and Sản xuất hosts have their own lists (/creation/projects, /productions).
  app.get(`${P}/projects`, guard((c) => c.json({ projects: store.listProjects(c.req.query('profileId') || undefined).filter(p => p.mode !== 'create' && p.mode !== 'produce') })));

  app.post(`${P}/projects`, small, guard(async (c) => {
    const body = await parse(c, projectCreateSchema);
    if (body.styleId && !known(body.styleId)) return fail(c, 400, 'Phong cách không tồn tại.');
    if (body.agentId) {
      if (!listVideoAgents().some((a) => a.id === body.agentId)) return fail(c, 400, 'Agent không tồn tại.');
    }
    const project = store.createProject({ ...body, agentId: body.agentId ?? resolveDefaultAgentId() });
    return c.json({ project });
  }));

  app.get(`${P}/projects/:id`, guard((c) => {
    const project = requireProject(idOf(c));
    return c.json({ project, messages: store.readMessages(project.id) });
  }));

  app.patch(`${P}/projects/:id`, small, guard(async (c) => {
    const body = await parse(c, projectPatchSchema);
    const current = requireProject(idOf(c));
    if (current.mode === 'create' && Object.keys(body).some(k => k !== 'title')) return fail(c, 409, 'Dự án tạo mới giữ cố định agent, tỉ lệ và brief.');
    const changesBrain = (body.agentId !== undefined && body.agentId !== current.agentId);
    if (changesBrain && current.busy) return fail(c, 409, 'Dừng lượt hiện tại trước khi chuyển model.', 'busy');
    if (body.styleId && !known(body.styleId)) return fail(c, 400, 'Phong cách không tồn tại.');
    if (body.agentId) {
      if (!listVideoAgents().some((a) => a.id === body.agentId)) return fail(c, 400, 'Agent không tồn tại.');
    }
    const project = store.updateProject(current.id, (p) => {
      if (body.title !== undefined) p.title = body.title;
      if (body.aspect !== undefined) p.aspect = body.aspect;
      if (body.chosenCover !== undefined) { if (body.chosenCover === null) delete p.chosenCover; else p.chosenCover = body.chosenCover; }
      if (body.agentId !== undefined) p.agentId = body.agentId;
      if (changesBrain) delete p.engineSessionId;
      if (body.styleId !== undefined) { if (body.styleId === null) delete p.styleId; else p.styleId = body.styleId; }
      if (body.targetSeconds !== undefined) { if (body.targetSeconds === null) delete p.targetSeconds; else p.targetSeconds = body.targetSeconds; }
    })!;
    emitProject(project);
    return c.json({ project });
  }));

  app.delete(`${P}/projects/:id`, guard((c) => {
    const project = requireProject(idOf(c));
    if (project.busy) return fail(c, 409, 'Agent đang xử lý việc này. Dừng lại trước khi xoá.', 'busy');
    pipe.queue.cancelProject(project.id);
    store.deleteProject(project.id);
    return c.json({ ok: true });
  }));

  // ── Ingest, step 1: probe + thumbnail right after upload; normalisation runs as a queued job ──
  async function probeUpload(projectId: string, file: string): Promise<{ info: MediaInfo } | { error: string }> {
    const before = requireProject(projectId);
    const startedAt = new Date().toISOString();
    const running = store.updateProject(projectId, (p) => {
      p.steps = p.steps.map((s) => (s.key === 'ingest' ? { key: 'ingest', status: 'running', startedAt } : s));
    })!;
    emitVideoEvent(projectId, { type: 'step', step: running.steps.find((s) => s.key === 'ingest')! });
    try {
      return { info: await probe(file) };
    } catch {
      const failed = store.updateProject(projectId, (p) => {
        // A failed replacement leaves the earlier video and its ticket state alone.
        const previous = before.steps.find((s) => s.key === 'ingest')!;
        p.steps = p.steps.map((s) => (s.key === 'ingest'
          ? (before.source ? previous : { key: 'ingest', status: 'failed', startedAt, finishedAt: new Date().toISOString(), error: 'Không đọc được video này.' })
          : s));
      })!;
      emitVideoEvent(projectId, { type: 'step', step: failed.steps.find((s) => s.key === 'ingest')! });
      emitProject(failed);
      return { error: 'Không đọc được video này. Kiểm tra lại tệp rồi tải lên lần nữa.' };
    }
  }

  async function adoptSource(projectId: string, file: string, probed: MediaInfo, meta: { fileName?: string; sizeBytes?: number }): Promise<VideoProject> {
    const info: MediaInfo = { ...probed, ...(meta.fileName ? { fileName: meta.fileName } : {}), ...(meta.sizeBytes ? { sizeBytes: meta.sizeBytes } : {}) };
    const thumb = store.thumbFile(projectId);
    try {
      await thumbnail(file, thumb, info.durationSec);
    } catch {
      fs.rmSync(thumb, { force: true });
    }
    const project = store.updateProject(projectId, (p) => {
      p.source = info;
      p.steps = p.steps.map((s) => (s.key === 'ingest'
        ? { key: 'ingest', status: 'running', startedAt: s.startedAt, summary: ingestSummary(info), progress: 0 }
        : s));
    })!;
    emitVideoEvent(projectId, { type: 'step', step: project.steps.find((s) => s.key === 'ingest')! });
    emitProject(project);
    return project;
  }

  app.post(`${P}/projects/:id/upload`, guard(async (c) => {
    const project = requireProject(idOf(c));
    if (project.mode === 'create') return fail(c, 409, 'Dùng luồng agent tạo mới cho dự án này.');
    if (project.mode === 'produce') return fail(c, 409, 'Video sản xuất lấy hình từ các cảnh đã tạo, không tải video lên.');
    let originalName = '';
    try { originalName = decodeURIComponent(c.req.header('x-file-name') ?? ''); } catch { /* keep empty */ }
    originalName = path.basename(originalName.replace(/\\/g, '/'));
    const ext = path.extname(originalName).slice(1).toLowerCase();
    if (!VIDEO_EXTS.includes(ext)) return fail(c, 415, 'Chỉ nhận video mp4, mov, m4v, webm hoặc mkv.', 'bad_extension');

    const max = Number(process.env.VIDEO_EDIT_MAX_UPLOAD_BYTES) || DEFAULT_MAX_UPLOAD;
    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > max) return fail(c, 413, `Video quá lớn (tối đa ${formatSize(max)}).`, 'too_large');
    const body = c.req.raw.body;
    if (!body) return fail(c, 400, 'Chưa có dữ liệu video.');
    if (uploading.has(project.id)) return fail(c, 409, 'Đang tải một video lên việc này.', 'busy');

    uploading.add(project.id);
    const dir = store.sourceDir(project.id);
    store.ensureDir(dir);
    const temp = path.join(dir, `.upload-${randomUUID()}.tmp`);
    let bytes = 0;
    try {
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          if (bytes > max) cb(new Error('too_large'));
          else cb(null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(body as never), counter, fs.createWriteStream(temp, { mode: 0o600 }));
      } catch (err) {
        fs.rmSync(temp, { force: true });
        if ((err as Error).message === 'too_large') return fail(c, 413, `Video quá lớn (tối đa ${formatSize(max)}).`, 'too_large');
        return fail(c, 400, 'Tải video lên bị gián đoạn. Thử lại.');
      }
      if (bytes === 0) { fs.rmSync(temp, { force: true }); return fail(c, 400, 'Tệp video trống.'); }

      // Probe before touching the previous source, so a bad file never destroys a good one.
      const probed = await probeUpload(project.id, temp);
      if ('error' in probed) {
        fs.rmSync(temp, { force: true });
        return fail(c, 422, probed.error, 'probe_failed');
      }
      for (const name of fs.readdirSync(dir)) if (/^raw\.[a-z0-9]+$/i.test(name)) fs.rmSync(path.join(dir, name), { force: true });
      fs.renameSync(temp, path.join(dir, `raw.${ext}`));
      // A new video makes everything derived from the old one meaningless.
      if (project.source || project.planVersion > 0) pipe.resetForNewSource(project.id);
      const next = await adoptSource(project.id, store.sourceFile(project.id)!, probed.info, { fileName: originalName, sizeBytes: bytes });
      const job = pipe.startChain(project.id);
      return c.json({ project: next, job });
    } finally {
      fs.rmSync(temp, { force: true });
      uploading.delete(project.id);
    }
  }));

  // ── Media (Range) ──
  app.get(`${P}/projects/:id/media/:kind{.+}`, guard((c) => {
    const project = requireProject(idOf(c));
    const kind = c.req.param('kind') ?? '';
    let file: string | null = null;
    let m: RegExpExecArray | null;
    if (kind === 'source') file = store.sourceFile(project.id);
    else if (kind === 'thumb') file = store.thumbFile(project.id);
    else if (kind === 'proxy') file = store.proxyFile(project.id);
    else if (kind === 'master') file = store.masterFile(project.id);
    else if (kind === 'final') file = store.finalFile(project.id);
    else if ((m = /^final-v(\d+)$/.exec(kind))) file = store.finalFile(project.id, Number(m[1]));
    else if (kind === 'cover-1' || kind === 'cover-2' || kind === 'cover-3') file = store.coverFile(project.id, Number(kind.slice(-1)) as 1 | 2 | 3);
    else if ((m = /^frame\/([A-Za-z0-9._-]+\.jpg)$/.exec(kind))) file = path.join(store.framesDir(project.id), m[1]);
    else return fail(c, 404, 'Không có loại tệp này.');
    if (!file || !fs.existsSync(file)) return fail(c, 404, 'Chưa có tệp này.');
    return serveFile(c, file);
  }));

  // ── Chat: a director turn (reason "chat"), the reply arrives over SSE ──
  app.post(`${P}/projects/:id/messages`, small, guard(async (c) => {
    const body = await parse(c, messageSchema);
    const project = requireProject(idOf(c));
    if (project.busy) return fail(c, 409, 'Agent đang trả lời. Chờ xong hoặc bấm dừng.', 'busy');
    if (project.mode === 'create') {
      const requestId = randomUUID(); creation.beginRequest(project.id, project.agentId, requestId, body.text);
      const message = pipe.appendMessage(project.id, { id: requestId, role: 'user', text: body.text, ...(body.attachments?.length ? { attachments: body.attachments } : {}) });
      const { agentMessageId } = pipe.beginTurn(project.id, 'chat', body.text, body.attachments);
      return c.json({ message, agentMessageId });
    }


    let styleId = body.styleId;
    if (styleId && !known(styleId)) return fail(c, 400, 'Phong cách không tồn tại.');
    if (!styleId) {
      const command = /^\/[a-z0-9-]+(?=\s|$)/i.exec(body.text)?.[0]?.toLowerCase();
      styleId = VIDEO_STYLES.find((s) => s.command.toLowerCase() === command)?.id;
    }
    if (styleId) {
      const next = store.updateProject(project.id, (p) => { p.styleId = styleId; })!;
      emitProject(next);
    }

    // busy flips synchronously inside beginTurn, so a second request cannot slip in. The turn reads
    // the chat history when it starts, so the new message is stored right after: the director gets it
    // as the "new message" instead of seeing it twice.
    const { agentMessageId } = pipe.beginTurn(project.id, 'chat', body.text, body.attachments);
    const message: VideoMessage = {
      id: randomUUID(),
      projectId: project.id,
      role: 'user',
      text: body.text,
      createdAt: new Date().toISOString(),
      ...(styleId ? { styleId } : {}),
      ...(body.attachments?.length ? { attachments: body.attachments } : {}),
    };
    store.appendMessage(message);
    emitVideoEvent(project.id, { type: 'message', message });
    return c.json({ message, agentMessageId });
  }));

  app.post(`${P}/projects/:id/abort`, guard((c) => {
    const project = requireProject(idOf(c));
    pipe.abort(project.id);
    return c.json({ ok: true });
  }));

  // ── Events (SSE) ──
  app.get(`${P}/projects/:id/events`, guard((c) => {
    const project = requireProject(idOf(c));
    return streamSSE(c, async (stream) => {
      let closed = false;
      let queue: Promise<unknown> = Promise.resolve();
      const write = (data: string, event?: string) => {
        queue = queue
          .then(() => (closed ? undefined : stream.writeSSE({ data, ...(event ? { event } : {}) })))
          .catch(() => { closed = true; });
      };
      write(JSON.stringify({ type: 'project', project }));
      const unsubscribe = subscribeVideoEvents(project.id, (evt) => write(JSON.stringify(evt)));
      // A named event is invisible to EventSource.onmessage, so pings never reach the UI handler.
      const ping = setInterval(() => write('', 'ping'), SSE_PING_MS);
      await new Promise<void>((resolve) => stream.onAbort(() => {
        closed = true;
        clearInterval(ping);
        unsubscribe();
        resolve();
      }));
    });
  }));

  // ── Pipeline steps ──
  app.post(`${P}/projects/:id/run`, small, guard(async (c) => {
    const { step } = await parse(c, runSchema);
    const project = requireProject(idOf(c));
    if (project.mode === 'create') return fail(c, 409, 'Dùng luồng agent tạo mới cho dự án này.');
    const needSource = () => {
      if (!store.sourceFile(project.id) || !project.source) throw new StoreError(409, 'Chưa có video để nhận. Tải video lên trước.', 'no_source');
    };
    switch (step) {
      case 'ingest':
        needSource();
        return c.json({ project, job: pipe.runStep(project.id, 'ingest') });
      case 'transcribe':
        if (!fs.existsSync(store.audioFile(project.id))) return fail(c, 409, 'Video chưa được chuẩn hoá xong. Chạy bước Nhận video trước.', 'not_ingested');
        return c.json({ project, job: pipe.runStep(project.id, 'transcribe') });
      case 'analyze':
        if (!store.readTranscript(project.id)) return fail(c, 409, 'Chưa có bản chép lời. Chạy bước Chép lời trước.', 'no_transcript');
        return c.json({ project, job: pipe.runStep(project.id, 'analyze') });
      case 'direct':
        if (!store.readTranscript(project.id)) return fail(c, 409, 'Chưa có bản chép lời. Chạy các bước trước đó trước.', 'no_transcript');
        if (project.busy) return fail(c, 409, 'Agent đang trả lời. Chờ xong hoặc bấm dừng.', 'busy');


        return c.json({ project, job: pipe.runStep(project.id, 'direct') });
      case 'approve':
        return c.json(await pipe.decide(project.id, 'approve'));
      case 'render':
      case 'cover':
        if (project.planVersion < 1) return fail(c, 409, 'Chưa có kế hoạch.', 'no_plan');
        if (!fs.existsSync(store.masterFile(project.id))) return fail(c, 409, 'Video chưa được chuẩn hoá xong.', 'not_ingested');
        return c.json({ project, job: pipe.runStep(project.id, step) });
      case 'deliver': {
        const profile = store.getProfile(project.profileId);
        const plan = project.planVersion > 0 ? store.loadPlan(project.id, project.planVersion) : null;
        const version = project.renders?.at(-1)?.version;
        if (!profile || !plan || version === undefined) return fail(c, 409, 'Chưa có video đã xuất để giao.', 'no_render');
        const out = pipe.tools.deliver(store, project, profile, plan, version);
        if (!out) return fail(c, 409, 'Hồ sơ kênh chưa đặt thư mục giao.', 'no_deliver_dir');
        pipe.logStep(project.id, 'deliver', `đã chép ${out.files.length} tệp vào ${out.dir}`);
        pipe.setStep(project.id, 'deliver', { status: 'done', summary: `Đã chép vào ${out.dir}` });
        return c.json({ project: requireProject(project.id), delivered: out });
      }
      default:
        return fail(c, 400, 'Bước này chạy cùng bước xuất video, không chạy riêng.', 'not_a_step');
    }
  }));

  registerEditorRoutes(app, { P, root, store, pipeline: pipe, fail, small, guard, parse, idOf, requireProject, emitProject, isLocal: options.isLocal });
  registerPlanV2Routes(app, { P, root, store, pipeline: pipe, fail, small, guard, parse, idOf, requireProject, emitProject });
  const production = registerProductionRoutes(app, {
    P, root, editStore: store, pipeline: pipe, small, probe, thumbnail, emitProject, doctor, defaultAgentId: resolveDefaultAgentId,
    ...(options.autoStart === false ? { pollMs: 0, agentTurns: false } : {}),
    ...(options.production ?? {}),
  });

  // ── Voice (phase 3) ──
  app.get(`${P}/voice`, (c) => c.json({ configured: false, provider: null, voices: [] }));
  app.post(`${P}/voice/tts`, (c) => fail(c, 501, 'Chưa cấu hình giọng AI (giai đoạn 3).', 'voice_not_configured'));

  const stop = () => { pipe.queue.stop(); production.stopPolling(); void creation; };
  return { pipeline: pipe, store, production, creation, stop };
}
