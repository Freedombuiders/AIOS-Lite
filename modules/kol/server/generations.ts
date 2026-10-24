/**
 * Generation queue and worker.
 *
 * requestGeneration() validates, composes the prompt, pre-prices, runs admission
 * and queues one row. The worker (one setInterval, 2 s) starts queued jobs up to
 * settings.concurrency (video and talking jobs weigh 2), and polls running video
 * jobs every 10 s up to 15 minutes.
 *
 *   image   provider call → store files + thumbnails → spend → identity QA (not bootstrap/sheet)
 *           → sheet mode adds the result to the identity pack
 *   video   submit → provider_request_id stored → poll → store → spend
 *   talking ElevenLabs speech (audio asset, spend) → lipsync submit → poll → video asset
 *
 * Restart: running jobs without a provider request id (images, speech) become
 * 'unknown' and are never resubmitted; video/talking jobs with a request id are
 * polled again. Nothing here ever replays a paid request.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { checkBudgetAdmission } from './budget.js';
import { readBytes, send } from './media-http.js';
import { isEnabled } from './compat.js';
import { logger } from './compat.js';
import { getAsset, getAssetFile, insertAsset, setAssetCost } from './assets.js';
import { activeJudgeModel, checkAssetConsistency, judgeIsConfigured } from './consistency.js';
import { ensureKolDir, KolError, kolDb, kolPaths, loadSettings, monthKey, nowSec, parseJson, toKolRel } from './core.js';
import { imageDims, makeThumbnail, probeMedia, sniffMedia } from './files.js';
import { MAX_CAMERA_PICKS, getLibraryFile, resolveCameraSetup, resolveLibraryItems } from './library.js';
import { requirePersona } from './personas.js';
import { actualCostUsd, estimateGeneration, NO_PRICE_MESSAGE, speechCostUsd, speechSecondsFor, type Estimate } from './pricing.js';
import { closestAspect, composePrompt, isImageMode, providerLabel, type ComposeResult } from './prompt.js';
import { defaultModel, findModel, getAdapter, isProviderConfigured } from './providers/index.js';
import { ProviderError, providerErrorVi, wrapHttpError, type InputFile, type MediaOut } from './providers/types.js';
import { addRefFromAsset, getRefFile } from './refs.js';
import { admission, generationSpend, LIBRARY_SPEND_ID, recordSpend, type SpendKind } from './spend.js';
import { getTemplate, getTemplateFile } from './templates.js';
import type {
  Aspect, AssetDto, GenerationDto, GenerationKind, GenerationMode, GenerationParams, GenerationRequest, GenerationStatus, LibraryItemDto,
  LibraryKind, ModelInfo, ModelKind, PersonaDto, PromptPreviewDto, Quality, RefRoleDto, Selection,
} from './types.js';
import { MAX_SCRIPT_CHARS, requireVoiceKey, synthesizeSpeech, TTS_MODEL } from './voice.js';

export const TICK_MS = 2_000;
export const POLL_MS = 10_000;
export const VIDEO_TIMEOUT_SEC = 15 * 60;
const IMAGE_CALL_TIMEOUT_MS = 12 * 60_000;
const MAX_IMAGE_BYTES = 60 * 1024 * 1024;
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

export const UNKNOWN_NOTE = 'Máy chủ khởi động lại khi việc này đang chạy. Không gửi lại để tránh trả tiền hai lần: xem thư viện ảnh hoặc trang của nhà cung cấp, rồi tạo lại nếu cần.';

const ASPECTS: Aspect[] = ['1:1', '4:5', '3:4', '2:3', '9:16', '16:9', '5:4', '4:3', '3:2'];
const QUALITIES: Quality[] = ['draft', 'standard', 'high', 'ultra'];
const MODES: GenerationMode[] = ['compose', 'recreate', 'sheet', 'bootstrap', 'freeform', 'animate', 'talking'];

// ── Rows & DTOs ──────────────────────────────────────────────────────

export interface GenerationRow {
  id: string;
  persona_id: string;
  kind: GenerationKind;
  mode: GenerationMode;
  status: GenerationStatus;
  provider: ModelInfo['provider'];
  model: string;
  params_json: string;
  selection_json: string;
  prompt: string;
  refs_json: string;
  estimate_usd: number;
  cost_usd: number;
  cost_status: string;
  provider_request_id: string | null;
  error: string;
  attempts: number;
  requested_by: string;
  post_id: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function assetIdsOf(generationId: string): string[] {
  return (kolDb().prepare('SELECT id FROM kol_assets WHERE generation_id = ? ORDER BY created_at, rowid').all(generationId) as { id: string }[]).map((r) => r.id);
}

export function generationToDto(row: GenerationRow): GenerationDto {
  return {
    id: row.id,
    personaId: row.persona_id,
    kind: row.kind,
    mode: row.mode,
    status: row.status,
    provider: row.provider,
    model: row.model,
    params: parseJson<GenerationParams>(row.params_json, {}),
    selection: parseJson<Selection>(row.selection_json, {}),
    prompt: row.prompt,
    refs: parseJson<RefRoleDto[]>(row.refs_json, []),
    estimateUsd: row.estimate_usd,
    costUsd: row.cost_usd,
    error: row.error,
    requestedBy: row.requested_by,
    postId: row.post_id,
    assetIds: assetIdsOf(row.id),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function getRow(id: string): GenerationRow | null {
  return (kolDb().prepare('SELECT * FROM kol_generations WHERE id = ?').get(id) as GenerationRow | undefined) ?? null;
}

export function getGeneration(id: string): GenerationDto | null {
  const row = getRow(id);
  return row ? generationToDto(row) : null;
}

export function listGenerations(f: { personaId?: string; status?: string; limit?: number } = {}): GenerationDto[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.personaId) { where.push('persona_id = ?'); params.push(f.personaId); }
  if (f.status) {
    const list = f.status.split(',').map((s) => s.trim()).filter(Boolean);
    const ok: GenerationStatus[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'];
    if (list.some((s) => !(ok as string[]).includes(s))) throw new KolError(400, 'Trạng thái không hợp lệ.');
    where.push(`status IN (${list.map(() => '?').join(',')})`); params.push(...list);
  }
  const limit = Math.min(Math.max(Math.floor(f.limit ?? 50) || 50, 1), 200);
  const rows = kolDb().prepare(`SELECT * FROM kol_generations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...params, limit) as GenerationRow[];
  return rows.map(generationToDto);
}

export function listGenerationsForPost(postId: string): GenerationDto[] {
  const rows = kolDb().prepare('SELECT * FROM kol_generations WHERE post_id = ? ORDER BY created_at DESC, rowid DESC').all(postId) as GenerationRow[];
  return rows.map(generationToDto);
}

// ── Request validation & planning ────────────────────────────────────

const id = z.string().min(1).max(100);
const selectionSchema = z.object({
  outfitId: id, expressionId: id, hairId: id, sceneId: id, poseId: id, lookId: id, effectId: id, cameraId: id,
  cameraIds: z.array(id).max(MAX_CAMERA_PICKS, `Tối đa ${MAX_CAMERA_PICKS} thiết lập máy cho một lần tạo.`),
  templateId: id, sourceAssetId: id,
  realism: z.enum(['iphone-candid', 'pro-photo', 'editorial', 'film-35mm', 'studio-clean', 'none'], { message: 'Kiểu ảnh thật không hợp lệ.' }),
}).partial();

const paramsSchema = z.object({
  model: z.string().max(200, 'Tên model quá dài.'),
  aspect: z.enum(ASPECTS as [Aspect, ...Aspect[]], { message: 'Tỉ lệ khung hình không hợp lệ.' }),
  quality: z.enum(QUALITIES as [Quality, ...Quality[]], { message: 'Chất lượng phải là draft, standard, high hoặc ultra.' }),
  count: z.number({ message: 'Số ảnh phải là số.' }).int('Số ảnh phải là số nguyên.').min(1, 'Số ảnh từ 1 đến 4.').max(4, 'Số ảnh từ 1 đến 4.'),
  seed: z.number().int().min(0).max(2_147_483_647, 'Seed không hợp lệ.'),
  extraPrompt: z.string().max(2000, 'Chỉ dẫn thêm tối đa 2000 ký tự.'),
  durationSec: z.number({ message: 'Thời lượng phải là số.' }).int().min(1).max(60, 'Thời lượng tối đa 60 giây.'),
  audio: z.boolean(),
  script: z.string().max(MAX_SCRIPT_CHARS, `Lời thoại tối đa ${MAX_SCRIPT_CHARS} ký tự.`),
}).partial();

export const generationRequestSchema = z.object({
  personaId: z.string({ message: 'Thiếu personaId.' }).min(1, 'Thiếu personaId.').max(100),
  mode: z.enum(MODES as [GenerationMode, ...GenerationMode[]], { message: 'Chế độ tạo không hợp lệ.' }),
  selection: selectionSchema.optional(),
  params: paramsSchema.optional(),
  promptOverride: z.string().max(8000, 'Prompt tự viết tối đa 8000 ký tự.').optional(),
  postId: z.string().max(100).optional(),
});

export function parseGenerationRequest(input: unknown): GenerationRequest {
  const r = generationRequestSchema.safeParse(input);
  if (!r.success) throw new KolError(400, r.error.issues[0]?.message ?? 'Yêu cầu tạo không hợp lệ.');
  return r.data as GenerationRequest;
}

export function kindForMode(mode: GenerationMode): GenerationKind {
  return mode === 'animate' ? 'video' : mode === 'talking' ? 'lipsync' : 'image';
}

const modelKindFor = (kind: GenerationKind): ModelKind => (kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'lipsync');
/** Video and talking jobs weigh 2 against settings.concurrency. ChatGPT jobs have their own limit (settings.chatgptParallel). */
const weightOf = (kind: GenerationKind): number => (kind === 'video' || kind === 'lipsync' ? 2 : 1);

/** Start of the server's local day, unix seconds. */
function localDayStartSec(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** Images asked of ChatGPT today (queued, running, done or unknown), for settings.chatgptDailyLimit. */
export function chatgptImagesToday(now = Date.now()): number {
  const rows = kolDb().prepare(
    `SELECT params_json FROM kol_generations WHERE provider = 'chatgpt' AND kind = 'image'
       AND status IN ('queued', 'running', 'succeeded', 'unknown') AND created_at >= ?`,
  ).all(localDayStartSec(now)) as { params_json: string }[];
  // Library catalog photos made through ChatGPT use the same plan.
  const previews = kolDb().prepare(
    "SELECT COUNT(*) AS n FROM kol_spend WHERE persona_id = ? AND provider = 'chatgpt' AND kind = 'image' AND created_at >= ?",
  ).get(LIBRARY_SPEND_ID, localDayStartSec(now)) as { n: number };
  return rows.reduce((sum, r) => sum + Math.max(1, Number(parseJson<GenerationParams>(r.params_json, {}).count) || 1), 0) + previews.n;
}
const judgeApplies = (mode: GenerationMode): boolean => mode === 'compose' || mode === 'recreate' || mode === 'freeform';

export interface GenerationPlan {
  persona: PersonaDto;
  mode: GenerationMode;
  kind: GenerationKind;
  model: ModelInfo | null;
  params: GenerationParams;
  selection: Selection;
  composed: ComposeResult;
  estimate: Estimate | null;
  /** Problems that block a real request (the preview shows them as warnings). */
  problems: KolError[];
}

function pickModel(req: GenerationRequest, persona: PersonaDto, kind: GenerationKind, problems: KolError[]): ModelInfo | null {
  const mk = modelKindFor(kind);
  const requested = req.params?.model?.trim();
  if (requested) {
    const m = findModel(requested);
    if (!m) { problems.push(new KolError(400, `Không có model "${requested}".`)); return null; }
    if (m.kind !== mk) { problems.push(new KolError(400, `Model ${m.label} không dùng được cho chế độ này.`)); return null; }
    return m;
  }
  const personal = mk === 'image' ? persona.imageModel : mk === 'video' ? persona.videoModel : '';
  if (personal) {
    const m = findModel(personal);
    if (m && m.kind === mk) return m;
  }
  const d = defaultModel(mk);
  if (!d) problems.push(new KolError(412, 'Chưa có model nào dùng được cho chế độ này.'));
  return d;
}

function defaultAspect(mode: GenerationMode, model: ModelInfo | null, source: { width: number | null; height: number | null } | null): Aspect {
  const allowed = model?.aspects.length ? model.aspects : ASPECTS;
  if ((mode === 'animate' || mode === 'talking') && source?.width && source.height) {
    return closestAspect(source.width, source.height, allowed) ?? allowed[0];
  }
  const wanted: Aspect = mode === 'sheet' ? '16:9' : mode === 'animate' || mode === 'talking' ? '9:16' : '4:5';
  if (allowed.includes(wanted)) return wanted;
  const [a, b] = wanted.split(':').map(Number);
  return closestAspect(a, b, allowed) ?? allowed[0];
}

function defaultDuration(model: ModelInfo): number {
  const d = model.durations ?? [];
  if (d.includes(5)) return 5;
  if (d.includes(6)) return 6;
  return d[0] ?? 5;
}

/** Everything a request implies, without spending. Throws only when nothing can be planned (bad body, unknown persona). */
export function planGeneration(input: unknown): GenerationPlan {
  const req = parseGenerationRequest(input);
  const persona = requirePersona(req.personaId);
  const problems: KolError[] = [];
  const mode = req.mode;
  const kind = kindForMode(mode);
  if (persona.status === 'archived') problems.push(new KolError(409, 'KOL này đã lưu trữ. Khôi phục trước khi tạo ảnh mới.'));
  const selection: Selection = { ...(req.selection ?? {}) };
  const raw = req.params ?? {};
  const model = pickModel(req, persona, kind, problems);
  if (model && !isProviderConfigured(model.provider)) {
    const a = getAdapter(model.provider);
    problems.push(new KolError(412, `${a.label} chưa được cấu hình. ${a.hint}`, 'provider_not_configured'));
  }

  // Library slots, template, source.
  let slots: Partial<Record<LibraryKind, LibraryItemDto>> = {};
  try {
    slots = resolveLibraryItems({
      outfit: selection.outfitId, expression: selection.expressionId, hair: selection.hairId, scene: selection.sceneId,
      pose: selection.poseId, look: selection.lookId, effect: selection.effectId,
    }, persona.id);
    const camera = resolveCameraSetup([selection.cameraId, ...(selection.cameraIds ?? [])], persona.id);
    if (camera) slots.camera = camera;
  } catch (err) {
    if (err instanceof KolError) problems.push(err); else throw err;
  }
  let template: ReturnType<typeof getTemplate> = null;
  if (selection.templateId) {
    template = getTemplate(selection.templateId);
    if (!template) problems.push(new KolError(404, 'Không tìm thấy ảnh mẫu.'));
  }
  if (mode === 'recreate' && !selection.templateId) problems.push(new KolError(400, 'Chế độ tái tạo cần chọn một ảnh mẫu.'));
  let source: AssetDto | null = null;
  if (mode === 'animate' || mode === 'talking') {
    if (!selection.sourceAssetId) problems.push(new KolError(400, 'Cần chọn một ảnh nguồn trong thư viện.'));
    else {
      source = getAsset(selection.sourceAssetId);
      if (!source) problems.push(new KolError(404, 'Không tìm thấy ảnh nguồn.'));
      else if (source.personaId !== persona.id) { problems.push(new KolError(400, 'Ảnh nguồn thuộc KOL khác.')); source = null; }
      else if (source.kind !== 'image') { problems.push(new KolError(400, 'Ảnh nguồn phải là ảnh, không phải video hay âm thanh.')); source = null; }
    }
  }

  // Params.
  const params: GenerationParams = { ...raw };
  if (model) {
    params.model = model.id;
    const q = raw.quality ?? (model.qualities.includes('standard') ? 'standard' : model.qualities[0]);
    if (!model.qualities.includes(q)) problems.push(new KolError(400, `Model ${model.label} không có chất lượng "${q}" (chọn: ${model.qualities.join(', ')}).`));
    params.quality = q;
    const aspect = raw.aspect ?? defaultAspect(mode, model, source);
    if (raw.aspect && model.aspects.length && !model.aspects.includes(raw.aspect)) {
      problems.push(new KolError(400, `Model ${model.label} không hỗ trợ tỉ lệ ${raw.aspect} (chọn: ${model.aspects.join(', ')}).`));
    }
    params.aspect = aspect;
    if (kind === 'image') {
      params.count = raw.count ?? (mode === 'bootstrap' ? 4 : 1);
      delete params.durationSec; delete params.audio; delete params.script;
    } else {
      params.count = 1;
      if (kind === 'video') {
        const d = raw.durationSec ?? defaultDuration(model);
        if (model.durations?.length && !model.durations.includes(d)) problems.push(new KolError(400, `Thời lượng phải là một trong: ${model.durations.join(', ')} giây.`));
        params.durationSec = d;
        params.audio = model.audio ? (raw.audio ?? true) : false;
        // An optional spoken line: models with native audio (Veo 3.x) voice and lip-sync it themselves.
        const line = (raw.script ?? '').trim();
        if (line && !model.audio) problems.push(new KolError(400, `Model ${model.label} không tạo được tiếng nói. Chọn model có âm thanh (ví dụ Veo 3.1) hoặc dùng chế độ Video nói chuyện.`));
        if (line.length > 220) problems.push(new KolError(400, 'Lời thoại cho video ngắn tối đa 220 ký tự (khoảng 8 giây nói).'));
        if (line && model.audio) params.audio = true;
        if (line) params.script = line; else delete params.script;
      } else {
        const script = (raw.script ?? '').trim();
        params.script = script;
        params.durationSec = speechSecondsFor(script);
        delete params.audio;
        if (!script) problems.push(new KolError(400, 'Cần nhập lời thoại cho video nói chuyện.'));
        if (!persona.voiceId.trim()) problems.push(new KolError(400, 'KOL chưa có giọng đọc: chọn voiceId ElevenLabs ở tab Hồ sơ.'));
        try { requireVoiceKey(); } catch (err) { if (err instanceof KolError) problems.push(err); }
      }
    }
  }

  const composed = composePrompt({
    persona, mode, slots, template,
    refs: persona.refs, source: source ? { id: source.id, url: source.url, kind: source.kind, width: source.width, height: source.height } : null,
    params, realism: selection.realism, model, promptOverride: req.promptOverride,
  });
  const identityCount = composed.refs.filter((r) => r.role === 'identity' || r.role === 'sheet').length;
  if ((mode === 'compose' || mode === 'recreate' || mode === 'sheet') && identityCount === 0) {
    problems.push(new KolError(400, 'Cần ít nhất một ảnh gốc (anchor) của KOL. Tải ảnh lên hoặc tạo ảnh gốc (bootstrap) trước.', 'no_anchor'));
  }

  let estimate: Estimate | null = null;
  if (model) {
    const settings = loadSettings();
    const hasAnchor = persona.refs.some((r) => r.kind === 'anchor' || r.kind === 'angle');
    estimate = estimateGeneration({
      model, mode, quality: params.quality ?? 'standard', count: params.count ?? 1, durationSec: params.durationSec, audio: params.audio,
      script: params.script, refsCount: composed.refs.length, judge: judgeApplies(mode) && hasAnchor && judgeIsConfigured(),
      judgeModel: activeJudgeModel(), overrides: settings.priceOverrides,
    });
    if (!estimate.priced) problems.push(new KolError(412, NO_PRICE_MESSAGE, 'no_price'));
    if (model.provider === 'chatgpt' && settings.chatgptDailyLimit > 0) {
      const used = chatgptImagesToday();
      const asked = params.count ?? 1;
      if (used + asked > settings.chatgptDailyLimit) {
        problems.push(new KolError(409, `Hôm nay đã dùng ${used}/${settings.chatgptDailyLimit} ảnh ChatGPT. Giới hạn này giữ hạn mức gói ChatGPT cho việc khác; tăng ở KOL Studio › Cài đặt hoặc chọn model khác.`, 'chatgpt_daily_limit'));
      }
    }
  }
  return { persona, mode, kind, model, params, selection, composed, estimate, problems };
}

/** POST /api/kol/preview: the composed prompt, images, price and warnings. Never spends. */
export function previewGeneration(input: unknown): PromptPreviewDto {
  const plan = planGeneration(input);
  const warnings = [...plan.composed.warnings];
  for (const p of plan.problems) if (!warnings.includes(p.message)) warnings.push(p.message);
  return {
    prompt: plan.composed.prompt,
    refs: plan.composed.refs,
    model: plan.model,
    estimateUsd: plan.estimate?.totalUsd ?? 0,
    warnings,
    notes: plan.composed.notes,
  };
}

/** Validates, prices, admits and queues a generation. Throws KolError 400/402/404/409/412. */
export function requestGeneration(req: GenerationRequest, requestedBy: string): GenerationDto {
  const plan = planGeneration(req);
  if (plan.problems.length) throw plan.problems[0];
  const model = plan.model!;
  const estimate = plan.estimate!;
  admission(plan.persona.id, estimate.totalUsd);
  const genId = randomUUID();
  const who = (requestedBy || 'owner').slice(0, 60);
  kolDb().prepare(
    `INSERT INTO kol_generations (id, persona_id, kind, mode, status, provider, model, params_json, selection_json, prompt, refs_json,
       estimate_usd, cost_usd, cost_status, provider_request_id, error, attempts, requested_by, post_id, created_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, 0, 'estimated', NULL, '', 0, ?, ?, ?)`,
  ).run(genId, plan.persona.id, plan.kind, plan.mode, model.provider, model.id, JSON.stringify(plan.params), JSON.stringify(plan.selection),
    plan.composed.prompt, JSON.stringify(plan.composed.refs), estimate.totalUsd, who, req.postId ?? null, nowSec());
  kick();
  return getGeneration(genId)!;
}

export function cancelGeneration(genId: string): GenerationDto {
  const row = getRow(genId);
  if (!row) throw new KolError(404, 'Không tìm thấy việc tạo này.');
  const r = kolDb().prepare("UPDATE kol_generations SET status = 'cancelled', finished_at = ?, error = 'Đã hủy.' WHERE id = ? AND status = 'queued'").run(nowSec(), genId);
  if (r.changes === 0) throw new KolError(409, 'Chỉ hủy được việc đang chờ. Việc đang chạy sẽ chạy đến hết.');
  return getGeneration(genId)!;
}

export function queueCounts(): { running: number; queued: number } {
  const rows = kolDb().prepare("SELECT status, COUNT(*) AS n FROM kol_generations WHERE status IN ('running', 'queued') GROUP BY status").all() as { status: string; n: number }[];
  return { running: rows.find((r) => r.status === 'running')?.n ?? 0, queued: rows.find((r) => r.status === 'queued')?.n ?? 0 };
}

// ── Job helpers ──────────────────────────────────────────────────────

function viError(err: unknown): string {
  if (err instanceof KolError) return err.message;
  if (err instanceof ProviderError) return providerErrorVi(err);
  return providerErrorVi(err);
}

/** Marks a job failed. Whatever it already spent (speech before a failed lipsync, images before a failed save) stays on it. */
function failJob(genId: string, message: string): void {
  kolDb().prepare("UPDATE kol_generations SET status = 'failed', error = ?, cost_usd = ?, finished_at = ? WHERE id = ? AND status IN ('queued', 'running')")
    .run(message.slice(0, 800), generationSpend(genId), nowSec(), genId);
}

function succeedJob(genId: string, reported: boolean): void {
  kolDb().prepare("UPDATE kol_generations SET status = 'succeeded', error = '', cost_usd = ?, cost_status = ?, finished_at = ? WHERE id = ? AND status = 'running'")
    .run(generationSpend(genId), reported ? 'reported' : 'estimated', nowSec(), genId);
}

/** Local file behind a RefRoleDto url (/api/kol/media/<area>/<id>). */
export function inputForRef(ref: RefRoleDto, personaName: string): InputFile {
  const m = /^\/api\/kol\/media\/(ref|asset|library|template)\/([^/?#]+)$/.exec(ref.url ?? '');
  if (!m) throw new KolError(400, `Ảnh tham chiếu "${ref.label}" không hợp lệ.`);
  const area = m[1];
  const refId = decodeURIComponent(m[2]);
  const file = area === 'ref' ? getRefFile(refId)
    : area === 'asset' ? getAssetFile(refId)
      : area === 'library' ? getLibraryFile(refId)
        : getTemplateFile(refId);
  if (!file) throw new KolError(410, `Ảnh tham chiếu "${ref.label}" đã bị xóa. Tạo lại yêu cầu.`);
  return { path: file.abs, mime: file.mime, role: ref.role, label: providerLabel(ref.role, personaName) };
}

type Downloader = (url: string, maxBytes: number) => Promise<Buffer>;

const httpsDownload: Downloader = async (url, maxBytes) => {
  const res = await send({ service: 'download', secret: '', url, headers: { Accept: '*/*' } }, { timeoutMs: 300_000 });
  return readBytes(res, maxBytes, 'download');
};
let downloader: Downloader = httpsDownload;

/** @internal tests only: replace the https downloader for provider output urls. */
export function _setDownloaderForTests(fn: Downloader | null): void {
  downloader = fn ?? httpsDownload;
}

async function bytesOf(out: MediaOut, maxBytes: number): Promise<Buffer> {
  if (out.bytes) {
    if (out.bytes.length > maxBytes) throw new ProviderError('rejected', 'output file too large');
    return out.bytes;
  }
  const url = out.url ?? '';
  const data = /^data:[^;,]+;base64,(.*)$/s.exec(url);
  if (data) return Buffer.from(data[1], 'base64');
  if (!/^https:\/\//i.test(url)) throw new ProviderError('unknown', 'output has no downloadable url');
  try {
    return await downloader(url, maxBytes);
  } catch (err) {
    throw err instanceof ProviderError ? err : wrapHttpError(err, 'download');
  }
}

const MAX_BYTES: Record<'image' | 'video' | 'audio', number> = { image: MAX_IMAGE_BYTES, video: MAX_VIDEO_BYTES, audio: MAX_AUDIO_BYTES };

interface Downloaded { bytes: Buffer; ext: string; mime: string; kind: 'image' | 'video' | 'audio' }

/** Output bytes, checked to be the expected media type. */
export async function downloadOutput(out: MediaOut, expected: 'image' | 'video' | 'audio'): Promise<Downloaded> {
  const bytes = await bytesOf(out, MAX_BYTES[expected]);
  const sniffed = sniffMedia(bytes.subarray(0, 4096));
  if (!sniffed || sniffed.kind !== expected) throw new ProviderError('unknown', `provider returned an unexpected file type (wanted ${expected})`);
  return { bytes, ext: sniffed.ext, mime: sniffed.mime, kind: expected };
}

/** Writes one output under assets/<persona>/<YYYY-MM>/, with thumbnail and probe, and inserts the asset row. */
async function storeOutput(row: GenerationRow, out: MediaOut | Downloaded, expected: 'image' | 'video' | 'audio', extra: { model?: string; provider?: string } = {}): Promise<AssetDto> {
  const d = 'kind' in out && 'ext' in out ? out : await downloadOutput(out, expected);
  const { bytes } = d;
  const sniffed = { ext: d.ext, mime: d.mime };
  const assetId = randomUUID();
  const dir = ensureKolDir(kolPaths.assets(row.persona_id, monthKey()));
  const abs = path.join(dir, `${assetId}.${sniffed.ext}`);
  fs.writeFileSync(abs, bytes, { mode: 0o600 });
  let width: number | null = null;
  let height: number | null = null;
  let durationSec: number | null = null;
  if (expected === 'image') {
    ({ width, height } = imageDims(abs));
  } else {
    const probe = await probeMedia(abs);
    if (probe) ({ width, height, durationSec } = probe);
  }
  let thumbRel: string | null = null;
  if (expected !== 'audio') {
    const thumbAbs = path.join(dir, `${assetId}.thumb.jpg`);
    if (await makeThumbnail(abs, thumbAbs, expected)) thumbRel = toKolRel(thumbAbs);
  }
  return insertAsset({
    id: assetId, personaId: row.persona_id, generationId: row.id, kind: expected, file: toKolRel(abs), thumb: thumbRel, mime: sniffed.mime,
    width, height, durationSec, bytes: bytes.length, model: extra.model ?? row.model, provider: extra.provider ?? row.provider, costUsd: 0,
    prompt: expected === 'audio' ? '' : row.prompt,
  });
}

function shareCost(assets: AssetDto[], total: number): void {
  if (!assets.length) return;
  const each = Math.round((total / assets.length) * 1e6) / 1e6;
  for (const a of assets) setAssetCost(a.id, each);
}

function overrides(): Record<string, number> {
  try { return loadSettings().priceOverrides; } catch { return {}; }
}

// ── Job runners ──────────────────────────────────────────────────────

async function runImageJob(row: GenerationRow): Promise<void> {
  const persona = requirePersona(row.persona_id);
  const model = findModel(row.model);
  if (!model) throw new KolError(400, `Model "${row.model}" không còn trong danh sách.`);
  const params = parseJson<GenerationParams>(row.params_json, {});
  const refs = parseJson<RefRoleDto[]>(row.refs_json, []);
  const inputs = refs.map((r) => inputForRef(r, persona.name));
  const quality = params.quality ?? 'standard';
  const count = params.count ?? 1;
  const res = await getAdapter(model.provider).generateImage({
    model, prompt: row.prompt, refs: inputs, aspect: params.aspect ?? '4:5', quality, count, seed: params.seed,
    idempotencyKey: row.id, signal: AbortSignal.timeout(IMAGE_CALL_TIMEOUT_MS),
  });
  const outputs = res.outputs.slice(0, Math.max(count, 1));
  if (outputs.length === 0) throw new ProviderError('rejected', 'no image returned');

  // The provider has charged: record spend before anything local can fail.
  const reported = typeof res.reportedCostUsd === 'number' && Number.isFinite(res.reportedCostUsd);
  const cost = reported ? res.reportedCostUsd! : actualCostUsd(model, { quality, units: outputs.length, refsCount: inputs.length }, overrides()) ?? row.estimate_usd;
  recordSpend({ personaId: row.persona_id, generationId: row.id, provider: model.provider, model: model.id, kind: 'image', costUsd: cost, costStatus: reported ? 'reported' : 'estimated', requestedBy: row.requested_by });

  const assets: AssetDto[] = [];
  let storeError: unknown = null;
  for (const out of outputs) {
    try { assets.push(await storeOutput(row, out, 'image')); } catch (err) { storeError ??= err; }
  }
  if (assets.length === 0) throw storeError ?? new ProviderError('unknown', 'could not store any image');
  shareCost(assets, cost);

  if (judgeApplies(row.mode)) {
    for (const a of assets) await checkAssetConsistency(a.id, { generationId: row.id, requestedBy: row.requested_by });
  } else {
    for (const a of assets) kolDb().prepare("UPDATE kol_assets SET consistency_verdict = 'skipped', consistency_notes = ? WHERE id = ?")
      .run(row.mode === 'bootstrap' ? 'Ảnh gốc mới: chưa có gì để so sánh.' : 'Bảng nhân vật: không chấm.', a.id);
  }
  if (row.mode === 'sheet') {
    try {
      await addRefFromAsset(row.persona_id, assets[0].id, 'sheet', { source: 'generated', label: 'Bảng nhân vật 360° (tạo tự động)' });
    } catch (err) {
      logger.warn({ err: (err as Error).message, generationId: row.id }, 'KOL: could not add the generated sheet to the identity pack');
    }
  }
  succeedJob(row.id, reported);
}

function sourceInput(row: GenerationRow, personaName: string): InputFile {
  const refs = parseJson<RefRoleDto[]>(row.refs_json, []);
  const src = refs.find((r) => r.role === 'source');
  if (!src) throw new KolError(400, 'Thiếu ảnh nguồn.');
  return inputForRef(src, personaName);
}

async function submitAnimateJob(row: GenerationRow): Promise<void> {
  const persona = requirePersona(row.persona_id);
  const model = findModel(row.model);
  if (!model) throw new KolError(400, `Model "${row.model}" không còn trong danh sách.`);
  const params = parseJson<GenerationParams>(row.params_json, {});
  const { handle } = await getAdapter(model.provider).submitVideo({
    model, prompt: row.prompt, startFrame: sourceInput(row, persona.name), refs: [], audioFile: null,
    aspect: params.aspect ?? '9:16', quality: params.quality ?? 'standard', durationSec: params.durationSec ?? 5, audio: Boolean(params.audio),
    seed: params.seed, idempotencyKey: row.id,
  });
  kolDb().prepare('UPDATE kol_generations SET provider_request_id = ? WHERE id = ?').run(handle, row.id);
}

async function submitTalkingJob(row: GenerationRow): Promise<void> {
  const persona = requirePersona(row.persona_id);
  const model = findModel(row.model);
  if (!model) throw new KolError(400, `Model "${row.model}" không còn trong danh sách.`);
  const params = parseJson<GenerationParams>(row.params_json, {});
  const script = (params.script ?? '').trim();
  if (!script) throw new KolError(400, 'Thiếu lời thoại.');
  const startFrame = sourceInput(row, persona.name);

  const mp3 = await synthesizeSpeech(persona.voiceId, script, AbortSignal.timeout(180_000));
  const speechCost = speechCostUsd(script, overrides());
  recordSpend({ personaId: row.persona_id, generationId: row.id, provider: 'elevenlabs', model: TTS_MODEL, kind: 'speech', costUsd: speechCost, costStatus: 'estimated', requestedBy: row.requested_by });
  const audio = await storeOutput(row, { bytes: mp3, mime: 'audio/mpeg' }, 'audio', { model: TTS_MODEL, provider: 'elevenlabs' });
  setAssetCost(audio.id, speechCost);
  const audioFile = getAssetFile(audio.id);
  if (!audioFile) throw new KolError(500, 'Không lưu được tệp giọng nói.');
  const seconds = Math.max(1, Math.ceil(audio.durationSec ?? params.durationSec ?? speechSecondsFor(script)));
  if (seconds !== params.durationSec) {
    kolDb().prepare('UPDATE kol_generations SET params_json = ? WHERE id = ?').run(JSON.stringify({ ...params, durationSec: seconds }), row.id);
  }

  const { handle } = await getAdapter(model.provider).submitVideo({
    model, prompt: row.prompt, startFrame, refs: [], audioFile: { path: audioFile.abs, mime: audioFile.mime, role: 'audio', label: 'speech audio' },
    aspect: params.aspect ?? '9:16', quality: params.quality ?? 'standard', durationSec: seconds, audio: true, seed: params.seed, idempotencyKey: row.id,
  });
  kolDb().prepare('UPDATE kol_generations SET provider_request_id = ? WHERE id = ?').run(handle, row.id);
}

/**
 * A finished video: download first (a failed download is retried on the next poll),
 * then record the spend, then store. After the spend is recorded the job never
 * polls again, so the cost is never counted twice.
 */
async function finishVideo(row: GenerationRow, outputs: MediaOut[], reportedCostUsd: number | null | undefined): Promise<void> {
  const model = findModel(row.model);
  const params = parseJson<GenerationParams>(row.params_json, {});
  const out = outputs[0];
  if (!out) { failJob(row.id, providerErrorVi(new ProviderError('rejected', 'no video returned'))); return; }
  let video: Downloaded;
  try {
    video = await downloadOutput(out, 'video');
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'unknown') { failJob(row.id, viError(err)); return; }
    throw err;
  }
  const reported = typeof reportedCostUsd === 'number' && Number.isFinite(reportedCostUsd);
  // Paid: record before storing. Talking jobs are billed by output length (≈ the audio); videos by the requested duration.
  const units = Math.max(1, params.durationSec ?? 5);
  const already = generationSpend(row.id);
  const fallback = Math.max(0, row.estimate_usd - already);
  const cost = reported ? reportedCostUsd! : (model ? actualCostUsd(model, { quality: params.quality ?? 'standard', audio: params.audio, units }, overrides()) : null) ?? fallback;
  const kind: SpendKind = row.kind === 'lipsync' ? 'lipsync' : 'video';
  recordSpend({ personaId: row.persona_id, generationId: row.id, provider: row.provider, model: row.model, kind, costUsd: cost, costStatus: reported ? 'reported' : 'estimated', requestedBy: row.requested_by });
  try {
    const asset = await storeOutput(row, video, 'video');
    setAssetCost(asset.id, cost);
    succeedJob(row.id, reported);
  } catch (err) {
    failJob(row.id, `Video đã tạo (đã tính tiền) nhưng không lưu được trên máy: ${viError(err)}`);
  }
}

// ── Worker ───────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
const polling = new Set<string>();
const lastPoll = new Map<string, number>();
const pending = new Set<Promise<void>>();

function track(p: Promise<void>): void {
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/** Startup: interrupted jobs that cannot be resumed become 'unknown' (never resubmitted). */
export function recoverInterruptedGenerations(): number {
  const r = kolDb().prepare(
    `UPDATE kol_generations SET status = 'unknown', error = ?, finished_at = ?
     WHERE status = 'running' AND (kind IN ('image', 'speech') OR provider_request_id IS NULL OR provider_request_id = '')`,
  ).run(UNKNOWN_NOTE, nowSec());
  return r.changes;
}

function launch(row: GenerationRow): void {
  const job = (async () => {
    try {
      const budget = checkBudgetAdmission('kol-studio');
      if (!budget.allowed) throw new KolError(402, `Ngân sách (Budgets) đang chặn KOL Studio. ${budget.error.message}`);
      if (row.kind === 'image') await runImageJob(row);
      else if (row.kind === 'video') await submitAnimateJob(row);
      else if (row.kind === 'lipsync') await submitTalkingJob(row);
      else throw new KolError(400, `Loại việc "${row.kind}" chưa hỗ trợ.`);
    } catch (err) {
      if (requeueForRetry(row, err)) {
        logger.info({ generationId: row.id, attempt: row.attempts }, 'KOL ChatGPT generation hit a network error; retrying later');
        return;
      }
      failJob(row.id, viError(err));
      logger.warn({ generationId: row.id, kind: row.kind, err: err instanceof Error ? err.message.slice(0, 300) : String(err) }, 'KOL generation failed');
    }
  })();
  track(job);
}

/** Total tries for a ChatGPT image job that keeps losing its connection (first try included). */
export const CHATGPT_MAX_ATTEMPTS = 3;
/** Wait before a ChatGPT retry, so a short outage on OpenAI's side can pass. */
export const CHATGPT_RETRY_DELAY_MS = 90_000;
/** Generation id → earliest time (ms) it may start again. In memory: after a restart a retry simply starts at once. */
const retryNotBefore = new Map<string, number>();

/**
 * ChatGPT (Codex on the owner's plan) has no per-image price and a dropped stream produces no image, so a
 * network failure is safe to try again — unlike the paid providers, which are never resubmitted. Returns true
 * when the job went back to the queue.
 */
function requeueForRetry(row: GenerationRow, err: unknown): boolean {
  if (row.provider !== 'chatgpt' || row.kind !== 'image') return false;
  if (!(err instanceof ProviderError) || (err.kind !== 'network' && err.kind !== 'timeout')) return false;
  if ((row.attempts ?? 0) >= CHATGPT_MAX_ATTEMPTS) return false;
  const r = kolDb().prepare("UPDATE kol_generations SET status = 'queued', error = ?, started_at = NULL WHERE id = ? AND status = 'running'")
    .run(`Mất kết nối tới ChatGPT, tự thử lại (lần ${row.attempts + 1}/${CHATGPT_MAX_ATTEMPTS}).`, row.id);
  if (r.changes !== 1) return false;
  retryNotBefore.set(row.id, Date.now() + CHATGPT_RETRY_DELAY_MS);
  return true;
}

/** @internal tests only. */
export function _clearRetryDelaysForTests(): void {
  retryNotBefore.clear();
}

/** ChatGPT image turns running outside the queue (library catalog photos). They share settings.chatgptParallel. */
let externalChatgptTurns = 0;

/**
 * Asks for one ChatGPT turn outside the queue. Granted only when no ChatGPT generation is waiting
 * (the owner's own images go first) and the pool has room; then release it with releaseChatgptTurn().
 */
export function claimChatgptTurn(): boolean {
  const rows = kolDb().prepare("SELECT status, COUNT(*) AS n FROM kol_generations WHERE provider = 'chatgpt' AND status IN ('running', 'queued') GROUP BY status").all() as { status: string; n: number }[];
  const running = rows.find((r) => r.status === 'running')?.n ?? 0;
  const queued = rows.find((r) => r.status === 'queued')?.n ?? 0;
  if (queued > 0 || running + externalChatgptTurns >= loadSettings().chatgptParallel) return false;
  externalChatgptTurns += 1;
  return true;
}

export function releaseChatgptTurn(): void {
  externalChatgptTurns = Math.max(0, externalChatgptTurns - 1);
  kick();
}

function startQueued(): void {
  if (!isEnabled('KOL_GENERATE_ENABLED')) return;
  const settings = loadSettings();
  if (!settings.enabled) return;
  const db = kolDb();
  const running = db.prepare("SELECT kind, provider FROM kol_generations WHERE status = 'running'").all() as { kind: GenerationKind; provider: string }[];
  // Two independent pools: ChatGPT (Codex on the owner's plan) and the API providers. Each is FIFO on its own,
  // so a full ChatGPT pool never holds back a Gemini job and the reverse.
  let chatgptRunning = running.filter((r) => r.provider === 'chatgpt').length + externalChatgptTurns;
  let load = running.filter((r) => r.provider !== 'chatgpt').reduce((sum, r) => sum + weightOf(r.kind), 0);
  let apiFull = false;
  const queued = db.prepare("SELECT * FROM kol_generations WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 50").all() as GenerationRow[];
  for (const q of queued) {
    const isChatgpt = q.provider === 'chatgpt';
    if (isChatgpt) {
      if (chatgptRunning >= settings.chatgptParallel) continue;
      const notBefore = retryNotBefore.get(q.id);
      if (notBefore && notBefore > Date.now()) continue;
      retryNotBefore.delete(q.id);
    } else {
      if (apiFull) continue;
      const w = weightOf(q.kind);
      if (load > 0 && load + w > settings.concurrency) { apiFull = true; continue; }
    }
    const claimed = db.prepare("UPDATE kol_generations SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'queued'").run(nowSec(), q.id);
    if (claimed.changes !== 1) continue;
    if (isChatgpt) chatgptRunning++;
    else load += weightOf(q.kind);
    launch({ ...q, status: 'running', attempts: q.attempts + 1 });
  }
}

async function pollOne(row: GenerationRow): Promise<void> {
  const overdue = row.started_at !== null && nowSec() - row.started_at > VIDEO_TIMEOUT_SEC;
  const model = findModel(row.model);
  if (!model) { failJob(row.id, `Model "${row.model}" không còn trong danh sách.`); return; }
  try {
    const res = await getAdapter(row.provider).pollVideo(row.provider_request_id!, model);
    if (res.state === 'pending') {
      if (overdue) failJob(row.id, 'Quá 15 phút nhà cung cấp chưa trả video. Kiểm tra trang của nhà cung cấp trước khi tạo lại để tránh trả tiền hai lần.');
      return;
    }
    if (res.state === 'failed') {
      const safety = /nsfw|safety|blocked|moderation/i.test(res.error);
      failJob(row.id, providerErrorVi(new ProviderError(safety ? 'safety' : 'rejected', res.error)));
      return;
    }
    await finishVideo(row, res.outputs, res.reportedCostUsd);
  } catch (err) {
    if (overdue) failJob(row.id, `Quá 15 phút không lấy được video: ${viError(err)}`);
    else logger.warn({ generationId: row.id, err: err instanceof Error ? err.message.slice(0, 300) : String(err) }, 'KOL video poll failed; retrying');
  }
}

function pollRunning(): void {
  const rows = kolDb().prepare("SELECT * FROM kol_generations WHERE status = 'running' AND provider_request_id IS NOT NULL AND provider_request_id != ''").all() as GenerationRow[];
  const now = Date.now();
  for (const row of rows) {
    if (polling.has(row.id)) continue;
    if (now - (lastPoll.get(row.id) ?? 0) < POLL_MS) continue;
    polling.add(row.id);
    lastPoll.set(row.id, now);
    track(pollOne(row).finally(() => {
      polling.delete(row.id);
      const after = getRow(row.id);
      if (!after || after.status !== 'running') lastPoll.delete(row.id);
    }));
  }
}

function tick(): void {
  if (ticking) return;
  ticking = true;
  try {
    pollRunning();
    startQueued();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'KOL generation worker tick failed');
  } finally {
    ticking = false;
  }
}

function kick(): void {
  if (timer) setImmediate(tick);
}

export function startGenerationWorker(): void {
  if (timer) return;
  try {
    const n = recoverInterruptedGenerations();
    if (n > 0) logger.warn({ count: n }, 'KOL: interrupted generations marked unknown (never resubmitted)');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'KOL: restart recovery failed');
  }
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  setImmediate(tick);
}

export function stopGenerationWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** @internal tests only: one tick, then wait for every job and poll it started. */
export async function _runWorkerOnceForTests(opts: { ignorePollInterval?: boolean } = {}): Promise<void> {
  if (opts.ignorePollInterval) lastPoll.clear();
  tick();
  while (pending.size) await Promise.allSettled([...pending]);
}

/** @internal tests only. */
export function _resetWorkerForTests(): void {
  stopGenerationWorker();
  polling.clear();
  lastPoll.clear();
  pending.clear();
  ticking = false;
}
