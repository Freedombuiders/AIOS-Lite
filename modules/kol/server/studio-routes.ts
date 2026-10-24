/**
 * HTTP API of KOL Studio, studio side (see the endpoint list in types.ts):
 * status, settings, personas, identity pack, media, library, templates,
 * preview, generations and assets. JSON in and out; errors are { error } in
 * Vietnamese. Uploads stream the raw body (header x-file-name), are size-capped
 * and sniffed by magic bytes.
 */

import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';

import { isEnabled } from './compat.js';
import { logger } from './compat.js';
import { serveFile } from './serve-file.js';
import { deleteAsset, getAsset, getAssetFile, getAssetThumbFile, importAssetFromUpload, listAssets, patchAsset, assetsForGeneration } from './assets.js';
import { radarEnabled } from './radar-ideas.js';
import { CODEX_LOGIN_HINT, codexAccountModels, codexAuthMode } from './codex.js';
import { checkAssetConsistency, judgeIsConfigured, queueConsistencyCheck, resolveJudge } from './consistency.js';
import { KolError, loadSettings, saveSettings } from './core.js';
import { MAX_IMAGE_UPLOAD, MAX_VIDEO_UPLOAD, readUploadToTemp, removeQuiet } from './files.js';
import {
  cancelGeneration, chatgptImagesToday, getGeneration, listGenerations, previewGeneration, queueCounts, requestGeneration, parseGenerationRequest,
} from './generations.js';
import { createLibraryItem, deleteLibraryItem, getLibraryFile, getLibraryPreviewFile, listLibrary, patchLibraryItem, setLibraryImage } from './library.js';
import { previewJobStatus, setAutoPlan, startPreviewJob, stopPreviewJob } from './library-previews.js';
import { archivePersona, createPersona, listPersonaSummaries, requirePersona, updatePersona } from './personas.js';
import { JUDGE_ESTIMATE_USD } from './pricing.js';
import { findModel, providerStatuses } from './providers/index.js';
import { addRefFromAsset, addRefFromUpload, deleteRef, getRefFile, parseRefKind, patchRef } from './refs.js';
import { admission, spendSummary } from './spend.js';
import { createTemplate, deleteTemplate, getTemplateFile, listTemplates, patchTemplate } from './templates.js';
import type { ChatgptStatusDto, KolSettingsDto, KolStatusDto } from './types.js';
import { voiceConfigured } from './voice.js';

const MAX_JSON_BYTES = 1024 * 1024;

type Handler = (c: Context) => Response | Promise<Response>;

function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof KolError) {
    return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status as ContentfulStatusCode);
  }
  logger.error({ err: err instanceof Error ? err.message : String(err), path: c.req.path }, 'KOL studio route failed');
  return c.json({ error: 'Lỗi máy chủ KOL Studio. Thử lại sau.' }, 500);
}

const guard = (fn: Handler): Handler => async (c) => {
  try {
    return await fn(c);
  } catch (err) {
    return errorResponse(c, err);
  }
};

/** JSON body with a size cap. Empty body → {}. */
async function readJson(c: Context): Promise<unknown> {
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new KolError(413, 'Nội dung quá lớn.');
  const text = await c.req.text();
  if (text.length > MAX_JSON_BYTES) throw new KolError(413, 'Nội dung quá lớn.');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new KolError(400, 'Nội dung phải là JSON hợp lệ.');
  }
}

async function readObject(c: Context): Promise<Record<string, unknown>> {
  const body = await readJson(c);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new KolError(400, 'Nội dung phải là một đối tượng JSON.');
  return body as Record<string, unknown>;
}

const param = (c: Context, name: string): string => {
  const v = c.req.param(name) ?? '';
  if (!v || v.length > 100) throw new KolError(400, 'Mã không hợp lệ.');
  return v;
};

const settingsSchema = z.object({
  enabled: z.boolean({ message: 'enabled phải là true/false.' }),
  dailyCapUsd: z.number({ message: 'Hạn mức ngày phải là số.' }),
  monthlyCapUsd: z.number({ message: 'Hạn mức tháng phải là số.' }),
  defaultImageModel: z.string().max(200),
  defaultVideoModel: z.string().max(200),
  judgeModel: z.string().trim().min(1, 'Cần chọn model chấm độ giống.').max(80).regex(/^(auto|chatgpt|gemini-[a-z0-9.-]+)$/, 'Model chấm phải là auto, chatgpt hoặc một model Gemini (ví dụ gemini-2.5-flash).'),
  priceOverrides: z.record(z.string().max(200), z.number({ message: 'Giá ghi đè phải là số.' }).min(0, 'Giá ghi đè không được âm.')),
  publishEnabled: z.boolean(),
  autopilotEnabled: z.boolean(),
  concurrency: z.number({ message: 'Số việc chạy cùng lúc phải là số.' }),
  chatgptDailyLimit: z.number({ message: 'Số ảnh ChatGPT mỗi ngày phải là số.' }),
  chatgptParallel: z.number({ message: 'Số ảnh ChatGPT chạy song song phải là số.' }),
  codexModel: z.string().trim().min(2, 'Cần chọn model Codex.').max(64),
}).partial();

function parseSettingsPatch(body: unknown): Partial<KolSettingsDto> {
  const r = settingsSchema.safeParse(body);
  if (!r.success) throw new KolError(400, r.error.issues[0]?.message ?? 'Cài đặt không hợp lệ.');
  const patch = r.data;
  if (patch.defaultImageModel) {
    const m = findModel(patch.defaultImageModel);
    if (!m || m.kind !== 'image') throw new KolError(400, `Model ảnh "${patch.defaultImageModel}" không tồn tại.`);
  }
  if (patch.defaultVideoModel) {
    const m = findModel(patch.defaultVideoModel);
    if (!m || m.kind !== 'video') throw new KolError(400, `Model video "${patch.defaultVideoModel}" không tồn tại.`);
  }
  return patch;
}

function chatgptStatus(settings: KolSettingsDto): ChatgptStatusDto {
  const mode = codexAuthMode();
  let imagesToday = 0;
  try { imagesToday = chatgptImagesToday(); } catch { /* no table yet */ }
  const advertised = codexAccountModels();
  const models = advertised.includes(settings.codexModel) || !settings.codexModel ? advertised : [settings.codexModel, ...advertised];
  return {
    mode,
    configured: mode !== 'none',
    imagesToday,
    dailyLimit: settings.chatgptDailyLimit,
    model: settings.codexModel,
    models,
    hint: mode === 'none' ? CODEX_LOGIN_HINT : mode === 'api-key' ? 'Đang dùng OPENAI_API_KEY: OpenAI tính tiền vào tài khoản API. Bỏ khóa này nếu muốn dùng gói ChatGPT.' : '',
  };
}

async function composioConfigured(): Promise<boolean> {
  try {
    const mod = await import('../../_lib/composio.js');
    return mod.hasComposioKey();
  } catch {
    return false;
  }
}

export function registerStudioRoutes(app: Hono): void {
  // ── Status & settings ──
  app.get('/api/kol/status', guard(async (c) => {
    const settings = loadSettings();
    const status: KolStatusDto = {
      enabled: settings.enabled,
      providers: providerStatuses(),
      spend: spendSummary(),
      killSwitches: { generate: isEnabled('KOL_GENERATE_ENABLED'), publish: isEnabled('KOL_PUBLISH_ENABLED') },
      queue: queueCounts(),
      composio: await composioConfigured(),
      judge: (() => {
        const r = resolveJudge(settings.judgeModel);
        return { configured: r !== null, model: r?.model ?? settings.judgeModel, provider: r?.provider ?? null };
      })(),
      voice: { configured: voiceConfigured() },
      chatgpt: chatgptStatus(settings),
      radar: radarEnabled(),
    };
    return c.json(status);
  }));

  app.get('/api/kol/settings', guard((c) => c.json({ settings: loadSettings() })));

  app.put('/api/kol/settings', guard(async (c) => {
    const patch = parseSettingsPatch(await readObject(c));
    return c.json({ settings: saveSettings(patch) });
  }));

  // ── Personas ──
  app.get('/api/kol/personas', guard((c) => c.json({ personas: listPersonaSummaries() })));

  app.post('/api/kol/personas', guard(async (c) => c.json({ persona: createPersona(await readObject(c)) })));

  app.get('/api/kol/personas/:id', guard((c) => c.json({ persona: requirePersona(param(c, 'id')) })));

  app.patch('/api/kol/personas/:id', guard(async (c) => {
    const id = param(c, 'id');
    return c.json({ persona: updatePersona(id, await readObject(c)) });
  }));

  app.delete('/api/kol/personas/:id', guard((c) => {
    archivePersona(param(c, 'id'));
    return c.json({ ok: true });
  }));

  // ── Identity pack ──
  app.post('/api/kol/personas/:id/refs/from-asset', guard(async (c) => {
    const id = param(c, 'id');
    requirePersona(id);
    const body = await readObject(c);
    if (typeof body.assetId !== 'string' || !body.assetId) throw new KolError(400, 'Thiếu assetId.');
    const label = typeof body.label === 'string' ? body.label : '';
    return c.json({ ref: await addRefFromAsset(id, body.assetId, body.kind ?? 'anchor', { label }) });
  }));

  app.post('/api/kol/personas/:id/refs', guard(async (c) => {
    const id = param(c, 'id');
    requirePersona(id);
    const kind = parseRefKind(c.req.query('kind') || undefined);
    const upload = await readUploadToTemp(c, MAX_IMAGE_UPLOAD);
    try {
      const label = (c.req.query('label') ?? '').slice(0, 120);
      return c.json({ ref: await addRefFromUpload(id, upload.temp, { kind, label }) });
    } finally {
      removeQuiet(upload.temp);
    }
  }));

  // The owner's existing photos/videos of the persona → gallery (no generation, no spend); images are judged in the background.
  app.post('/api/kol/personas/:id/assets/import', guard(async (c) => {
    const id = param(c, 'id');
    requirePersona(id);
    const statusQ = c.req.query('status');
    if (statusQ && statusQ !== 'new' && statusQ !== 'approved') throw new KolError(400, 'status phải là new hoặc approved.');
    const tags = (c.req.query('tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    const upload = await readUploadToTemp(c, MAX_VIDEO_UPLOAD);
    try {
      const asset = await importAssetFromUpload(id, upload.temp, { status: (statusQ as 'new' | 'approved' | undefined) ?? 'new', tags, fileName: upload.fileName });
      if (asset.kind === 'image' && judgeIsConfigured()) queueConsistencyCheck(asset.id, { requestedBy: 'owner' });
      return c.json({ asset });
    } finally {
      removeQuiet(upload.temp);
    }
  }));

  app.patch('/api/kol/refs/:refId', guard(async (c) => c.json({ ref: patchRef(param(c, 'refId'), await readObject(c)) })));

  app.delete('/api/kol/refs/:refId', guard((c) => {
    deleteRef(param(c, 'refId'));
    return c.json({ ok: true });
  }));

  // ── Media (Range supported; never outside KOL_DIR: every path goes through resolveKolFile) ──
  app.get('/api/kol/media/:area/:id', guard((c) => {
    const area = c.req.param('area');
    const id = c.req.param('id') ?? '';
    if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) return c.json({ error: 'Không có tệp này.' }, 404);
    let file: string | null = null;
    if (area === 'ref') file = getRefFile(id)?.abs ?? null;
    else if (area === 'asset') file = getAssetFile(id)?.abs ?? null;
    else if (area === 'thumb') file = getAssetThumbFile(id);
    else if (area === 'library') file = getLibraryFile(id)?.abs ?? null;
    else if (area === 'preview') file = getLibraryPreviewFile(id, c.req.query('variant'), c.req.query('persona'));
    else if (area === 'template') file = getTemplateFile(id)?.abs ?? null;
    else return c.json({ error: 'Không có loại tệp này.' }, 404);
    if (!file) return c.json({ error: 'Không có tệp này.' }, 404);
    return serveFile(c, file);
  }));

  // ── Library ──
  app.get('/api/kol/library', guard((c) => c.json({
    items: listLibrary({ kind: c.req.query('kind') || undefined, personaId: c.req.query('personaId') || undefined, gender: c.req.query('gender') || undefined }),
  })));

  app.post('/api/kol/library', guard(async (c) => c.json({ item: createLibraryItem(await readObject(c)) })));

  // Catalog photos for the pickers (display only). ?model= adds the price of the missing ones.
  app.get('/api/kol/library/previews', guard((c) => c.json({ job: previewJobStatus(c.req.query('model') || undefined, c.req.query('personaId') || undefined) })));
  app.post('/api/kol/library/previews', guard(async (c) => c.json({ job: startPreviewJob(await readObject(c), 'owner') })));
  app.post('/api/kol/library/previews/stop', guard((c) => c.json({ job: stopPreviewJob() })));
  app.post('/api/kol/library/previews/auto', guard(async (c) => c.json({ job: setAutoPlan(await readObject(c)) })));

  app.patch('/api/kol/library/:id', guard(async (c) => c.json({ item: patchLibraryItem(param(c, 'id'), await readObject(c)) })));

  app.delete('/api/kol/library/:id', guard((c) => {
    deleteLibraryItem(param(c, 'id'));
    return c.json({ ok: true });
  }));

  app.post('/api/kol/library/:id/image', guard(async (c) => {
    const id = param(c, 'id');
    const upload = await readUploadToTemp(c, MAX_IMAGE_UPLOAD);
    try {
      return c.json({ item: await setLibraryImage(id, upload.temp) });
    } finally {
      removeQuiet(upload.temp);
    }
  }));

  // ── Templates ──
  app.get('/api/kol/templates', guard((c) => c.json({ templates: listTemplates() })));

  app.post('/api/kol/templates', guard(async (c) => {
    const upload = await readUploadToTemp(c, MAX_IMAGE_UPLOAD);
    try {
      const q = (k: string) => c.req.query(k) ?? undefined;
      const template = await createTemplate(upload.temp, { name: q('name'), kind: q('kind'), setId: q('setId'), position: q('position'), notes: q('notes') }, upload.fileName);
      return c.json({ template });
    } finally {
      removeQuiet(upload.temp);
    }
  }));

  app.patch('/api/kol/templates/:id', guard(async (c) => c.json({ template: patchTemplate(param(c, 'id'), await readObject(c)) })));

  app.delete('/api/kol/templates/:id', guard((c) => {
    deleteTemplate(param(c, 'id'));
    return c.json({ ok: true });
  }));

  // ── Preview & generations ──
  app.post('/api/kol/preview', guard(async (c) => c.json(previewGeneration(await readObject(c)))));

  app.post('/api/kol/generations', guard(async (c) => {
    const req = parseGenerationRequest(await readObject(c));
    return c.json({ generation: requestGeneration(req, 'owner') });
  }));

  app.get('/api/kol/generations', guard((c) => {
    const limit = Number(c.req.query('limit'));
    return c.json({
      generations: listGenerations({
        personaId: c.req.query('personaId') || undefined,
        status: c.req.query('status') || undefined,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      }),
    });
  }));

  app.get('/api/kol/generations/:id', guard((c) => {
    const id = param(c, 'id');
    const generation = getGeneration(id);
    if (!generation) throw new KolError(404, 'Không tìm thấy việc tạo này.');
    return c.json({ generation, assets: assetsForGeneration(id) });
  }));

  app.post('/api/kol/generations/:id/cancel', guard((c) => c.json({ generation: cancelGeneration(param(c, 'id')) })));

  // ── Assets ──
  app.get('/api/kol/assets', guard((c) => {
    const before = Number(c.req.query('before'));
    const limit = Number(c.req.query('limit'));
    return c.json(listAssets({
      personaId: c.req.query('personaId') || undefined,
      status: c.req.query('status') || undefined,
      kind: c.req.query('kind') || undefined,
      favorite: c.req.query('favorite') === '1' || c.req.query('favorite') === 'true',
      before: c.req.query('before') && Number.isFinite(before) ? before : undefined,
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    }));
  }));

  app.patch('/api/kol/assets/:id', guard(async (c) => c.json({ asset: patchAsset(param(c, 'id'), await readObject(c)) })));

  app.delete('/api/kol/assets/:id', guard((c) => {
    deleteAsset(param(c, 'id'));
    return c.json({ ok: true });
  }));

  app.post('/api/kol/assets/:id/recheck', guard(async (c) => {
    const id = param(c, 'id');
    const asset = getAsset(id);
    if (!asset) throw new KolError(404, 'Không tìm thấy tệp trong thư viện.');
    if (asset.kind !== 'image') throw new KolError(400, 'Chỉ chấm lại được ảnh.');
    if (!judgeIsConfigured()) throw new KolError(412, 'Chưa cấu hình model chấm độ giống (cần GOOGLE_API_KEY).');
    admission(asset.personaId, JUDGE_ESTIMATE_USD);
    await checkAssetConsistency(id, { requestedBy: 'owner' });
    return c.json({ asset: getAsset(id) });
  }));
}
