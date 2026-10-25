/**
 * The Video Studio director turn. In AIOS-Lite it is ONE lean agent turn (ctx.agents.runLean): the module
 * hands the agent everything it needs inline (transcript, analysis, plan, marks, profile taste, lessons) and
 * reads the answer back: an EditPlan as a fenced JSON block is validated and submitted by the module; create
 * and produce turns act through <aios-action module="video"> blocks (see ../../actions.ts).
 *
 * The owner's build ran a tool-using turn through a video-cli binary and per-turn MCP gateways; those are gone.
 */

import fs from 'node:fs';
import path from 'node:path';

import { jsonObjectsOf } from '../../kol-port.js';
import { buildShortlist, renderShortlistForPrompt } from '../assets/shortlist.js';
import type { AssetShortlist } from '../assets/types.js';
import { VIDEO_STYLES } from '../catalog/styles.js';
import { assetFilePath, findAsset } from '../library/store.js';
import { extractFrame } from '../pipeline/analyze.js';
import { ELEMENT_LISTS, elementLabel, findElement, planElements } from '../pipeline/plan.js';
import { CUT_LEVEL_LABEL, NO_CUT_GAP_MS, QUICK_GAP_MS } from '../pipeline/runner.js';
import { createVideoEditStore, type VideoEditStore } from '../store.js';
import { templateForPrompt } from '../templates/registry.js';
import {
  MARK_KINDS, ONBOARDING_QUESTIONS,
  type AnalysisResult, type EditPlan, type OverridesDoc, type QuickSettings, type Transcript, type VideoMark, type VideoMessage, type VideoProfile, type VideoProject, type VideoStyle,
} from '../types.js';
import { loadCurrentPlan, requestVideoPlanApproval } from './approval-handler.js';
import { appendTasteRule } from '../routes-editor.js';
import { moduleCtx } from '../../host.js';
import { creationPrompt } from '../../create/prompt.js';
import { buildProducePrompt } from '../production/prompt.js';
import { creationServiceFor } from '../../create/runtime.js';
import { productionServiceFor } from '../production/runtime.js';
import { executeProduceTool } from '../production/tools.js';

/** produce: Video Studio › Sản xuất turn (new video, or scenes finished) for a project with no A-roll yet. */
export type DirectorReason = 'plan' | 'revise' | 'marks' | 'chat' | 'produce';

export interface DirectorTurnInput {
  projectId: string;
  reason: DirectorReason;
  /** revise: the owner's note; chat: the owner's message; marks: optional extra words. */
  note?: string;
  /** chat: what the owner attached to the message (library assets by id). */
  attachments?: VideoMessage['attachments'];
  onDelta?: (accumulatedText: string) => void;
  onActivity?: (label: string, detail?: string) => void;
  abortController: AbortController;
}

export interface DirectorTurnResult {
  text: string;
  durationMs: number;
  activity: { label: string; detail?: string }[];
  error?: string;
}

export interface LeanTurn { agentId: string; title: string; prompt: string; images?: string[]; signal?: AbortSignal; timeoutMs?: number }
export type LeanRun = (turn: LeanTurn) => Promise<{ ok: boolean; output: string; error?: string }>;

export type SubmitPlanResult = { ok: true; plan: EditPlan } | { ok: false; errors: string[] };

export interface DirectorDeps {
  store?: VideoEditStore;
  /** Absolute module dir (skills live in <dir>/skills). */
  projectRoot?: string;
  /** One lean agent turn. Default: the module's ctx.agents.runLean. */
  run?: LeanRun;
  /** Validates and saves an agent plan as waiting for approval (pipeline.submitAgentPlan). */
  submitPlan?: (projectId: string, plan: unknown, note?: string) => SubmitPlanResult;
  /** Vault-style lessons for the prompt (ctx.brain.search). */
  lessons?: (query: string) => string[];
  /** Dựng nhanh: the chosen template for the prompt. Default: templates/registry.ts templateForPrompt. */
  templatePrompt?: (templateId: string) => string;
  /** Dựng nhanh: the Asset Hub shortlist. Default: assets/shortlist.ts buildShortlist. */
  shortlist?: (projectId: string) => Promise<AssetShortlist>;
  /** Dựng nhanh: a small still of the owner's footage (video at `at` seconds, or an image) for the agent to look at. */
  frameOf?: (file: string, dest: string, at: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const HISTORY_MESSAGES = 8;
const HISTORY_MESSAGE_CHARS = 1500;
const TASTE_MAX_CHARS = 4000;
const TRANSCRIPT_MAX_CHARS = 30_000;
const PLAN_MAX_CHARS = 24_000;
const MAX_FRAMES = 4;
/** Dựng nhanh: stills of the owner's footage attached on top of the analysis frames. */
const MAX_ASSET_IMAGES = 6;
const ASSET_STILL_WIDTH = 480;

function turnTimeoutMs(): number {
  const raw = Number(process.env.VIDEO_EDIT_TURN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1000 ? raw : DEFAULT_TIMEOUT_MS;
}

// ── Context ──

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
}

function fmt(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export interface DirectorContext {
  project: VideoProject;
  profile: VideoProfile | null;
  style: VideoStyle | null;
  brief: Record<string, string | string[]> | null;
  plan: EditPlan | null;
  analysis: AnalysisResult | null;
  wordCount: number | null;
  openMarks: VideoMark[];
  history: VideoMessage[];
}

export function loadDirectorContext(store: VideoEditStore, projectId: string): DirectorContext | null {
  const project = store.loadProject(projectId);
  if (!project) return null;
  const dir = store.projectDir(projectId);
  const marks = readJson<VideoMark[] | { marks: VideoMark[] }>(path.join(dir, 'marks.json'));
  const markList = Array.isArray(marks) ? marks : marks?.marks ?? [];
  const transcript = readJson<{ words?: unknown[] }>(path.join(dir, 'transcript.json'));
  return {
    project,
    profile: store.getProfile(project.profileId),
    style: VIDEO_STYLES.find((s) => s.id === project.styleId) ?? null,
    brief: project.brief ?? readJson<Record<string, string | string[]>>(path.join(dir, 'brief.json')),
    plan: project.planVersion > 0 ? loadCurrentPlan(store, project) : null,
    analysis: readJson<AnalysisResult>(path.join(dir, 'analysis.json')),
    wordCount: Array.isArray(transcript?.words) ? transcript!.words!.length : null,
    openMarks: markList.filter((m) => m.status === 'draft' || m.status === 'sent'),
    history: store.readMessages(projectId),
  };
}

const MARK_LABEL = new Map(MARK_KINDS.map((m) => [m.kind, m.label]));

function briefLines(brief: DirectorContext['brief']): string[] {
  if (!brief) return [];
  return Object.entries(brief)
    .filter(([, v]) => (Array.isArray(v) ? v.length : String(v ?? '').trim()))
    .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
}

function contextBlock(ctx: DirectorContext): string {
  const { project, profile, style } = ctx;
  const out: string[] = [];
  out.push(`VIỆC: ${project.code} "${project.title}" · tỉ lệ ${project.aspect}${project.targetSeconds ? ` · mục tiêu ${project.targetSeconds}s` : ''} · hồ sơ thương hiệu: ${profile?.name ?? '(không rõ)'}`);
  if (project.source) {
    out.push(`Video gốc: ${fmt(project.source.durationSec)} (${project.source.durationSec.toFixed(1)}s), ${project.source.width}×${project.source.height}, ${project.source.fps} fps${project.source.hasAudio ? '' : ', KHÔNG có tiếng'}.`);
  }
  if (ctx.wordCount !== null) out.push(`Lời chép: ${ctx.wordCount} từ (chỉ số từ 0 đến ${Math.max(0, ctx.wordCount - 1)}).`);
  if (project.quick) {
    // Dựng nhanh: the template replaces the style; its rules come in the MẪU EDIT section.
    out.push(`MẪU EDIT: chủ kênh đã chọn mẫu "${project.quick.templateId}". Luật, component và hiệu ứng của mẫu ở mục MẪU EDIT bên dưới; không đổi sang phong cách hay mẫu khác.`);
  } else if (style) {
    out.push(`PHONG CÁCH: ${style.name} (${style.command}) · nhịp cắt ${style.cutPace} · tiếng động ${style.sfxDensity} · nhạc ${style.musicMoods.join(', ')} · caption ${style.captionStyle}\nGhi chú phong cách: ${style.promptNotes}`);
  } else {
    out.push('PHONG CÁCH: chưa chọn. Chọn 1 phong cách hợp nhất trong danh sách PHONG CÁCH CÓ SẴN bên dưới và nói lý do trong summary.');
  }
  const brief = briefLines(ctx.brief);
  if (brief.length) out.push(`THÔNG TIN CHỦ KÊNH ĐIỀN (nguồn duy nhất cho giá, tên, ưu đãi; không bịa thêm):\n${brief.join('\n')}`);

  if (profile) {
    const brand = [
      profile.brand.primary && `chính ${profile.brand.primary}`,
      profile.brand.accent && `nhấn ${profile.brand.accent}`,
      profile.brand.light && `sáng ${profile.brand.light}`,
      profile.brand.dark && `tối ${profile.brand.dark}`,
      profile.brand.cardBg && `nền thẻ ${profile.brand.cardBg}`,
    ].filter(Boolean).join(', ');
    const fonts = [
      profile.brand.fontCaption && `phụ đề ${profile.brand.fontCaption}`,
      profile.brand.fontHeading && `tiêu đề ${profile.brand.fontHeading}`,
      profile.brand.fontCover && `bìa ${profile.brand.fontCover}`,
    ].filter(Boolean).join(', ');
    out.push([
      `HỒ SƠ THƯƠNG HIỆU: ${profile.name}${profile.seriesName ? ` · series "${profile.seriesName}"` : ''}. Có thể dùng cùng video cho nhiều kênh mạng xã hội; không suy diễn nền tảng đăng từ hồ sơ.`,
      `Âm thanh đích: tốc độ nói ×${profile.audio.speechRate}, giọng ${profile.audio.voiceLufs} LUFS, nhạc ${profile.audio.musicLufs} LUFS, cuối ${profile.audio.finalLufs} LUFS.`,
      brand ? `Màu: ${brand}.` : '',
      fonts ? `Font: ${fonts}.` : '',
      profile.coverStyle ? `Kiểu bìa: ${profile.coverStyle}.` : '',
      profile.keepWords.length
        ? `TỪ CẦN GIỮ NGUYÊN (tên sản phẩm, thương hiệu): ${profile.keepWords.join(' · ')}. KHÔNG "sửa chính tả", không đổi hoa/thường, không bỏ khỏi phụ đề và hiệu ứng chữ.`
        : '',
      project.quick
        ? 'Dựng nhanh: kế hoạch vào thẳng editor, chủ kênh chỉnh tay rồi bấm Xuất.'
        : `Tự duyệt kế hoạch: ${profile.autoApprovePlan ? 'có' : 'không (chủ kênh duyệt)'}.`,
    ].filter(Boolean).join('\n'));
    const answers = ONBOARDING_QUESTIONS
      .map((q) => ({ q: q.question, a: profile.onboarding[q.id]?.trim() }))
      .filter((x) => x.a);
    if (answers.length) out.push(`Chủ kênh đã trả lời:\n${answers.map((x) => `- ${x.q} ${x.a}`).join('\n')}`);
    out.push(profile.taste.trim()
      ? `GU VÀ LUẬT ĐÃ GHI NHỚ (luật cứng, theo đúng):\n${profile.taste.trim().slice(0, TASTE_MAX_CHARS)}`
      : 'GU VÀ LUẬT ĐÃ GHI NHỚ: chưa có. Dựa vào phong cách và bài học chung.');
  }

  const a = ctx.analysis;
  if (a) {
    out.push(`MÁY ĐÃ SOI: ${a.silences.length} chỗ lặng, ${a.fillers.length} từ đệm, ${a.retakes.length} câu nói lại, ${a.scenes.length} lần đổi cảnh${a.loudnessLufs !== undefined ? `, âm lượng gốc ${a.loudnessLufs.toFixed(1)} LUFS` : ''}.`);
  } else {
    out.push('MÁY ĐÃ SOI: chưa có analysis.json. Báo chủ kênh rằng bước soi chưa chạy.');
  }

  const plan = ctx.plan;
  if (plan) {
    const chosen = plan.hook?.options.find((o) => o.id === plan.hook?.chosen);
    out.push([
      `KẾ HOẠCH HIỆN TẠI: v${ctx.project.planVersion} (${ctx.project.planStatus ?? 'draft'}, tác giả ${plan.author}) · ${fmt(plan.sourceDurationSec)} → ${fmt(plan.outputDurationSec)} · ${plan.cutWords.length} từ bị cắt · gapMs ${plan.gapMs}`,
      chosen ? `Hook đang chọn: "${chosen.text}" (${chosen.mode})` : '',
      `${plan.brolls.length} B-roll, ${plan.overlays.length} hiệu ứng chữ, ${plan.zooms.length} zoom, ${plan.sfx.length} SFX${plan.music ? ', có nhạc' : ''}.`,
      plan.summary ? `Ý tưởng: ${plan.summary}` : '',
    ].filter(Boolean).join('\n'));
  } else {
    out.push('KẾ HOẠCH HIỆN TẠI: chưa có. (Bước tự động v1 chưa chạy hoặc chưa có kế hoạch.)');
  }
  return out.join('\n\n');
}

function renderMarks(marks: VideoMark[]): string {
  return marks.map((m) => {
    const range = m.end !== undefined ? `${m.start.toFixed(1)}s–${m.end.toFixed(1)}s` : `${m.start.toFixed(1)}s`;
    return `- [mark:${m.id}] ${range} (thời gian của bản v${m.planVersion}) · ${MARK_LABEL.get(m.kind) ?? m.kind}: ${m.note || '(không ghi chú)'}`;
  }).join('\n');
}

function renderHistory(history: VideoMessage[]): string {
  return history
    .filter((m) => m.role !== 'system' && m.text.trim())
    .slice(-HISTORY_MESSAGES)
    .map((m) => {
      const attached = m.attachments?.length ? ` [đính kèm: ${m.attachments.map((a) => `${a.label} (${a.ref})`).join(', ')}]` : '';
      return `${m.role === 'user' ? 'Chủ kênh' : 'Bạn'}: ${m.text.trim().slice(0, HISTORY_MESSAGE_CHARS)}${attached}`;
    })
    .join('\n');
}

/** A message attachment resolved against the asset library: absolute file path, or null when gone. */
export interface DirectorAttachment {
  ref: string;
  kind: string;
  name: string;
  file: string | null;
}

export function resolveAttachments(libraryRoot: string, list: VideoMessage['attachments'] = []): DirectorAttachment[] {
  return list.map((a) => {
    const asset = a.kind === 'asset' ? findAsset(libraryRoot, a.ref) : undefined;
    return { ref: a.ref, kind: asset?.kind ?? a.kind, name: asset?.name ?? a.label, file: asset ? assetFilePath(libraryRoot, asset) : null };
  });
}

function renderAttachments(list: DirectorAttachment[], canRead = true): string {
  const rows = list.map((a) => `- ${a.kind} "${a.name}" (assetId ${a.ref})${canRead ? `: ${a.file ?? 'không còn file trong kho'}` : ''}`);
  return [
    `Chủ kênh đính kèm từ Kho:\n${rows.join('\n')}`,
    canRead ? 'Muốn đưa tệp vào kế hoạch thì dùng assetId.' : '',
  ].filter(Boolean).join('\n');
}

/** Data the agent used to fetch through video-cli, now inlined into the prompt. */
export interface DirectorData {
  transcript: string | null;
  analysis: string | null;
  planJson: string | null;
  styles: string;
  lessons: string[];
  schemaRef: string;
  /** Dựng nhanh: skills/video-edit/references/templates.md. */
  templatesRef?: string;
  /** Dựng nhanh: what the owner set up for this video (project.quick present). */
  quick?: QuickBrief;
}

/** Dựng nhanh: the owner's setup, inlined into the prompt. */
export interface QuickBrief {
  settings: QuickSettings;
  /** templateForPrompt: rules.md + components, props and entrance presets of the chosen template. */
  template: string;
  /** renderShortlistForPrompt of the Asset Hub shortlist ('' when nothing is shortlisted). */
  shortlist: string;
  /** The owner's footage ("tư liệu") with the description sent along. */
  assets: { assetId: string; kind: string; name: string; hint?: string }[];
  /** Which attached images are stills of which footage (they come before the analysis frames). */
  assetImages: string[];
  /** Elements the owner edited by hand or added: read-only for the director. */
  ownerEdits: string[];
}

/** Synthetic words (a voiced sound with no word) are shown as this, never as text the speaker said. */
const SOUND_MARK = '(tiếng)';

function renderTranscript(t: Transcript): string {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const lines: string[] = [];
  let cur: Transcript['words'] = [];
  const flush = () => {
    if (!cur.length) return;
    lines.push(`@${cur[0].i}-${cur[cur.length - 1].i} ${r2(cur[0].start)}s-${r2(cur[cur.length - 1].end)}s | ${cur.map((w) => `${w.synthetic ? SOUND_MARK : w.text.trim()}[${w.i}]`).join(' ')}`);
    cur = [];
  };
  for (const w of t.words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end >= 0.45 || cur.length >= 14)) flush();
    cur.push(w);
  }
  flush();
  const sounds = t.words.some((w) => w.synthetic)
    ? [`${SOUND_MARK}[n] = tiếng không thành lời (máy đoán là từ đệm, không phải lời nói): cắt khi tự cắt bật, không đưa vào chữ hay phụ đề.`]
    : [];
  const text = [`# ${t.language} · ${r2(t.durationSec)}s · ${t.words.length} từ (@đầu-cuối = chỉ số từ; mốc là giây trong video gốc)`, ...sounds, ...lines].join('\n');
  return text.length > TRANSCRIPT_MAX_CHARS ? `${text.slice(0, TRANSCRIPT_MAX_CHARS)}\n… (đã rút gọn, còn tiếp)` : text;
}

function renderAnalysis(a: AnalysisResult): string {
  const top = <T,>(list: T[], n: number) => list.slice(0, n);
  return JSON.stringify({
    silences: top(a.silences, 40), fillers: top(a.fillers, 60), retakes: top(a.retakes, 30), scenes: top(a.scenes, 30),
    ...(a.loudnessLufs !== undefined ? { loudnessLufs: a.loudnessLufs } : {}),
  });
}

/** Everything the turn needs from the project folder and the skill references. */
export function loadDirectorData(store: VideoEditStore, ctx: DirectorContext, root: string, lessons: string[] = []): DirectorData {
  const transcript = store.readTranscript(ctx.project.id);
  const refs = path.join(root, 'skills', 'video-edit', 'references');
  let schemaRef = '';
  try { schemaRef = fs.readFileSync(path.join(refs, 'plan-schema.md'), 'utf8'); } catch { /* skill missing: the prompt still names the fields */ }
  let templatesRef = '';
  if (ctx.project.quick) {
    try { templatesRef = fs.readFileSync(path.join(refs, 'templates.md'), 'utf8'); } catch { /* the template section still lists components */ }
  }
  const planJson = ctx.plan ? JSON.stringify(ctx.plan) : null;
  return {
    transcript: transcript ? renderTranscript(transcript) : null,
    analysis: ctx.analysis ? renderAnalysis(ctx.analysis) : null,
    planJson: planJson && planJson.length > PLAN_MAX_CHARS ? `${planJson.slice(0, PLAN_MAX_CHARS)}…` : planJson,
    styles: VIDEO_STYLES.map((s) => `${s.id} (${s.command}): ${s.name} · nhịp ${s.cutPace} · SFX ${s.sfxDensity}`).join('\n'),
    lessons,
    schemaRef,
    ...(templatesRef ? { templatesRef } : {}),
  };
}

const KIND_LABEL = new Map(ELEMENT_LISTS.map((l) => [l.kind, l.label]));

/** Elements the owner added (origin owner) or edited by hand (overrides.json), one line each. */
export function ownerEditLines(plan: EditPlan | null, overrides: OverridesDoc | null): string[] {
  const out: string[] = [];
  const name = (id: string) => {
    const found = plan ? findElement(plan, id) : null;
    return found ? ` (${KIND_LABEL.get(found.kind)} «${elementLabel(found.kind, found.el)}»)` : '';
  };
  for (const { el } of plan ? planElements(plan) : []) if (el.origin === 'owner') out.push(`- ${el.id}${name(el.id!)}: chủ kênh tự thêm`);
  for (const [id, o] of Object.entries(overrides?.elements ?? {})) {
    const what = [
      o.hidden && 'chủ kênh đã xoá (ẩn), không thêm lại',
      o.text && 'sửa chữ',
      o.props && 'sửa nội dung',
      (o.t || o.s !== undefined) && 'đổi vị trí hoặc cỡ',
      o.animIn && `hiệu ứng vào ${o.animIn}`,
      o.sound && 'đổi âm thanh',
      (o.at !== undefined || o.duration !== undefined) && 'đổi thời điểm',
    ].filter(Boolean).join(', ');
    out.push(`- ${id}${name(id)}: ${what || 'đã chỉnh tay'}`);
  }
  return out;
}

const safeName = (id: string) => id.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80);

/** The owner's footage, shortlist, template and hand edits for a Dựng nhanh turn, plus stills of the footage. */
export async function loadQuickBrief(
  store: VideoEditStore,
  ctx: DirectorContext,
  deps: Pick<DirectorDeps, 'templatePrompt' | 'shortlist' | 'frameOf'> = {},
): Promise<{ brief: QuickBrief; images: string[] }> {
  const { project } = ctx;
  const settings = project.quick!;
  let template = '';
  try { template = (deps.templatePrompt ?? templateForPrompt)(settings.templateId); }
  catch { template = `(Không đọc được mẫu "${settings.templateId}" trên máy: dựng theo luật chung, chỉ dùng component text-beat.)`; }
  let shortlist = '';
  try { shortlist = renderShortlistForPrompt(await (deps.shortlist ?? buildShortlist)(project.id)).trim(); }
  catch { /* the prompt says nothing is shortlisted */ }

  const frameOf = deps.frameOf ?? ((file: string, dest: string, at: number) => extractFrame(file, at, dest, ASSET_STILL_WIDTH));
  const images: string[] = [];
  const assetImages: string[] = [];
  const assets: QuickBrief['assets'] = [];
  for (const item of settings.assets) {
    const asset = findAsset(store.root, item.assetId);
    assets.push({ assetId: item.assetId, kind: asset?.kind ?? 'không còn trong kho', name: asset?.name ?? item.assetId, ...(item.hint ? { hint: item.hint } : {}) });
    const file = asset ? assetFilePath(store.root, asset) : null;
    if (!file || images.length >= MAX_ASSET_IMAGES || (asset!.kind !== 'video' && asset!.kind !== 'image')) continue;
    // A small still, so a 4K photo or a whole clip never goes to the model.
    const dest = path.join(store.projectDir(project.id), 'drafts', `asset-${safeName(item.assetId)}.jpg`);
    try {
      if (!fs.existsSync(dest)) await frameOf(file, dest, asset!.kind === 'video' ? Math.min(1, (asset!.durationSec ?? 2) / 2) : 0);
    } catch { /* fall back below */ }
    const still = fs.existsSync(dest) ? dest : asset!.kind === 'image' ? file : null;
    if (!still) continue;
    images.push(still);
    assetImages.push(item.assetId);
  }
  return {
    brief: { settings, template, shortlist, assets, assetImages, ownerEdits: ownerEditLines(ctx.plan, store.readOverrides(project.id)) },
    images,
  };
}

const OUTPUT_RULES = [
  'CÁCH TRẢ LỜI (bắt buộc): bạn không có công cụ nào chạm vào dự án. Máy sẽ đọc câu trả lời của bạn:',
  '- Khi cần lập hoặc sửa kế hoạch: viết lời nhắn tiếng Việt ngắn cho chủ kênh, rồi MỘT khối ```json chứa đúng EditPlan (các trường theo tài liệu EditPlan bên dưới; không điền trường máy tự tính). Máy sẽ kiểm tra và nộp; nếu lỗi sẽ báo lại.',
  '- Không bịa số liệu, giá, tên. Không "sửa" từ cần giữ nguyên. Không nói đã dựng xong khi mới có kế hoạch: máy chỉ xuất video sau khi chủ kênh duyệt (hoặc bấm Xuất).',
  '- Tin nhắn gửi chủ kênh là văn bản thuần, không bảng.',
].join('\n');

// Rough cut, sentence by sentence (ideas from OpenStoryline prompts/tasks/speech_rough_cut and video-use's
// take selection; rewritten in Vietnamese, no text copied).
const ROUGH_CUT_RULES = [
  'LUẬT CẮT THÔ (đi lần lượt từng câu trong LỜI CHÉP, đọc cả câu trước và câu sau):',
  '1. Câu chỉ toàn từ đệm, câu vô nghĩa, hoặc lặp lại đúng ý đã nói: cắt cả câu.',
  '2. Trong câu: cắt từ đệm, từ lặp ("mình mình"), chỗ vấp; giữ nguyên nghĩa và từ cần giữ nguyên. Cắt ở đầu hay cuối câu chỉ làm câu ngắn lại; cắt ở giữa câu thì phần còn lại vẫn phải đọc liền mạch.',
  '3. Một ý nói nhiều lần (nói hỏng rồi nói lại): giữ lần nói tốt nhất, thường là lần cuối, trọn câu, không vấp; cắt các lần trước. Lần cuối hỏng hơn thì giữ lần tốt hơn và nói lý do trong summary.',
  '4. Câu có thông tin thì KHÔNG cắt. Cẩn thận: cắt nhầm một câu có ý còn tệ hơn sót một từ đệm.',
  '5. Sau khi cắt, câu trước và câu sau phải nối liền, tự nhiên như người nói một mạch.',
  `6. ${SOUND_MARK} là tiếng không thành lời máy đoán là từ đệm: cắt khi tự cắt bật.`,
  '7. Mép từ đã được máy khớp theo âm thanh thật: chỗ cắt nằm ở khoảng ngừng giữa hai từ, không cắt giữa một cụm đang nói liền.',
  '8. Ghi chú của chủ kênh đứng trên mọi luật ở đây.',
].join('\n');

/** Dựng nhanh: settings, template, footage, shortlist and hand edits, as prompt sections. */
function quickSections(q: QuickBrief, templatesRef?: string): string[] {
  const s = q.settings;
  const gap = s.autoCut ? QUICK_GAP_MS[s.cutLevel] : NO_CUT_GAP_MS;
  const music = s.music.mode === 'none'
    ? 'không nhạc (không điền music)'
    : s.music.mode === 'pick' ? `chủ kênh chọn bài assetId ${s.music.assetId} (giữ đúng bài này)` : 'bạn chọn một bài trong KHO GỢI Ý theo mood của mẫu';
  const out: string[] = [];
  out.push([
    'DỰNG NHANH: CHỦ KÊNH ĐÃ CÀI ĐẶT (làm đúng, máy sẽ ép lại nếu lệch):',
    s.autoCut
      ? `- Tự cắt: BẬT, mức ${CUT_LEVEL_LABEL[s.cutLevel]} → gapMs gợi ý ${gap}. autoCut true.`
      : `- Tự cắt: TẮT → autoCut false, cutWords [] và gapMs ${gap}: giữ nguyên video, không cắt gì.`,
    `- Nhạc nền: ${music}${s.music.mode === 'none' ? '' : `; giảm nhạc khi nói: ${s.music.duck ? 'có (music.duck true)' : 'không'}`}.`,
    `- Tìm thêm cảnh trám ngoài tư liệu: ${s.stock ? 'được (B-roll source "pexels" kèm query, máy tự tìm)' : 'KHÔNG (chỉ dùng tư liệu và Kho của tôi)'}.`,
    s.note ? `- Ghi chú của chủ kênh (ưu tiên cao nhất): ${s.note}` : '',
  ].filter(Boolean).join('\n'));
  out.push(`MẪU EDIT:\n${q.template}`);
  if (templatesRef) out.push(`TÀI LIỆU MẪU EDIT:\n${templatesRef}`);
  if (q.assets.length) {
    const rows = q.assets.map((a, k) => `- Tư liệu ${k + 1}: ${a.kind} "${a.name}" (assetId ${a.assetId})${a.hint ? `. Chủ kênh mô tả: ${a.hint}` : ''}`);
    out.push([
      'TƯ LIỆU CHỦ KÊNH GỬI (ưu tiên dùng làm B-roll: source "upload", đúng assetId, chép mô tả vào hint, neo vào câu đang nói đúng nội dung):',
      ...rows,
      q.assetImages.length ? `Ảnh đính kèm: ${q.assetImages.length} ảnh đầu là ảnh nhỏ của tư liệu theo thứ tự assetId ${q.assetImages.join(', ')}; các ảnh sau là khung hình của video gốc.` : '',
    ].filter(Boolean).join('\n'));
  }
  out.push(q.shortlist
    ? `KHO GỢI Ý (chỉ dùng assetId có ở đây hoặc ở TƯ LIỆU; không bịa assetId):\n${q.shortlist}`
    : 'KHO GỢI Ý: chưa có. Không bịa assetId: chỗ cần cảnh trám mà không có tư liệu thì ghi query (nếu được tìm thêm), không thì bỏ.');
  if (q.ownerEdits.length) {
    out.push(['PHẦN TỬ CHỦ KÊNH ĐÃ SỬA TAY (chỉ đọc: giữ nguyên id và nội dung, không xoá, không sửa, không thêm lại phần tử đã ẩn):', ...q.ownerEdits].join('\n'));
  }
  out.push(ROUGH_CUT_RULES);
  return out;
}

const QUICK_PLAN_TASK = [
  'NHIỆM VỤ: dựng nhanh theo mẫu (plan v2). Kế hoạch vào thẳng editor, không chờ duyệt.',
  '1. Cắt: theo LUẬT CẮT THÔ và cài đặt tự cắt (cutWords, gapMs).',
  '2. Chữ theo nhịp (beats): mỗi ý chính một beat, component và animIn của mẫu, title 2–6 từ, tối đa 2 dòng, *từ* để tô, | để xuống dòng; anchorWord = từ bắt đầu ý đó (không phải từ bị cắt), duration theo component.',
  '3. Cảnh minh hoạ (scenes): khi người nói kể các bước hoặc so sánh trước–sau, dùng component cảnh của mẫu, props đúng schema.',
  '4. B-roll: tư liệu của chủ kênh trước (assetId thật + hint); chỗ cần cảnh trám mà không có tư liệu: source "pexels", không assetId, query { description tiếng Việt, keywords 2–4 từ tiếng Anh } (chỉ khi được tìm thêm). graphics nếu mẫu có (ví dụ logo cuối).',
  '5. Nhạc, phụ đề (captions.highlight), 3 ảnh bìa, tiêu đề + caption + hashtag như bình thường.',
  '6. Tự kiểm: id không trùng, mọi anchorWord không nằm trong cutWords, component có trong mẫu, phần tử chủ kênh đã sửa giữ nguyên.',
  '7. Trả lời: 2 đến 4 dòng tiếng Việt (dựng thế nào, độ dài ước tính), rồi khối ```json EditPlan với planFormat 2, templateId của mẫu, autoCut, beats, scenes, brolls.',
].join('\n');

/** The turn prompt. Pure: no I/O, so it is unit-tested directly. */
export function buildDirectorPrompt(input: { reason: DirectorReason; note?: string; attachments?: DirectorAttachment[]; ctx: DirectorContext; data: DirectorData }): string {
  const { reason, ctx, data } = input;
  const note = input.note?.trim() ?? '';
  const quick = data.quick && reason !== 'produce' ? data.quick : undefined;
  const parts: string[] = [];

  parts.push([
    'Bạn là đạo diễn dựng video của Video Studio. Máy làm việc nặng (cắt, ghép, phụ đề, nhạc, xuất file); bạn đọc lời + vài khung hình rồi quyết định và ghi ra một EditPlan.',
    OUTPUT_RULES,
  ].join('\n'));

  parts.push(contextBlock(ctx));
  if (!quick) {
    if (ctx.style?.id === 'quyen') {
      parts.push('Phong cách Quyên: chỉ dùng ảnh Pexels đã tách nền trong kho với layout cutout; nếu thiếu assetId thì nói rõ phần còn thiếu, không hứa bản xuất đã có vật thể trên đầu.');
    }
    parts.push(`PHONG CÁCH CÓ SẴN:\n${data.styles}`);
  } else {
    parts.push(...quickSections(quick, data.templatesRef));
  }
  if (data.lessons.length) parts.push(`BÀI HỌC TÌM ĐƯỢC TRONG KHO TRI THỨC (dùng đúng, nêu tên bài trong summary):\n${data.lessons.join('\n---\n')}`);
  if (data.transcript) parts.push(`LỜI CHÉP:\n${data.transcript}`);
  else parts.push('LỜI CHÉP: chưa có. Báo chủ kênh rằng bước chép lời chưa chạy, không lập kế hoạch.');
  if (data.analysis) parts.push(`PHÂN TÍCH MÁY (JSON, mốc giây video gốc):\n${data.analysis}`);
  if (data.planJson && reason !== 'plan') parts.push(`KẾ HOẠCH HIỆN TẠI (JSON):\n${data.planJson}`);
  if (data.schemaRef) parts.push(`TÀI LIỆU EDITPLAN:\n${data.schemaRef}`);

  switch (reason) {
    case 'plan':
      if (quick) { parts.push(QUICK_PLAN_TASK); break; }
      parts.push([
        'NHIỆM VỤ: lên kế hoạch dựng (plan).',
        '1. Đọc kỹ lời chép và phân tích: quyết định cutWords (giữ lời gốc và nhịp thở của người nói, cắt từ đệm, câu nói lại, chỗ lặng), gapMs theo nhịp phong cách, hook (3 phương án khác kiểu nhau, chọn 1), phụ đề (từ nhấn), hiệu ứng chữ đúng lúc nói, B-roll có lý do, nhạc + SFX theo mật độ phong cách, 3 ảnh bìa, tiêu đề + caption + hashtag đăng bài.',
        '2. Tự kiểm 3 lượt (nội dung và cấu trúc; nhịp và độ dài so với mục tiêu; chữ, từ cần giữ, luật của kênh) rồi mới trả lời.',
        '3. Trả lời: 3 đến 6 dòng tiếng Việt (định dựng thế nào, ước tính độ dài, 1 đến 2 điều cần chủ kênh xác nhận), rồi khối ```json EditPlan.',
      ].join('\n'));
      break;
    case 'revise':
      parts.push([
        'NHIỆM VỤ: chỉnh kế hoạch theo góp ý của chủ kênh (revise).',
        `Góp ý của chủ kênh:\n${note || '(trống: hãy đề xuất một phương án khác rõ rệt và nêu rõ đã đổi gì)'}`,
        'Áp đúng góp ý vào kế hoạch hiện tại, giữ nguyên những phần chủ kênh không nhắc tới. Ghi vào "changes" từng thay đổi bằng câu ngắn tiếng Việt (VD: "Hook: đổi sang câu hỏi").',
        'Nếu góp ý mang tính lâu dài (giọng, nhịp, cấm kỵ), thêm một khối ```json riêng dạng {"rule": "<một câu ngắn>"} để máy ghi vào luật của kênh. Nếu góp ý mâu thuẫn luật cứng hoặc từ cần giữ, nói rõ và hỏi lại thay vì làm bừa.',
        'Trả lời tiếng Việt, 2 đến 4 dòng (đã đổi gì, độ dài mới) rồi khối ```json EditPlan.',
      ].join('\n'));
      break;
    case 'marks':
      parts.push([
        'NHIỆM VỤ: xử lý các điểm đánh dấu chủ kênh ghim trên bản xem thử (marks).',
        `Danh sách (thời gian tính theo bản video đã dựng, KHÔNG phải video gốc; đổi sang thời gian gốc bằng kế hoạch hiện tại + lời chép):\n${renderMarks(ctx.openMarks) || '(không có điểm mở)'}`,
        note ? `Chủ kênh nói thêm: ${note}` : '',
        'Với MỖI điểm, sửa kế hoạch hoặc giữ nguyên có lý do. Trong "changes", mỗi điểm một dòng bắt đầu bằng đúng mã [mark:<id>] rồi nói đã làm gì (hoặc giữ vì sao). Máy dựa vào mã đó để đánh dấu điểm đã xử lý.',
        'Trả lời tiếng Việt, mỗi điểm một dòng, rồi khối ```json EditPlan.',
      ].filter(Boolean).join('\n'));
      break;
    case 'chat': {
      const history = renderHistory(ctx.history);
      parts.push([
        'NHIỆM VỤ: trả lời hoặc làm theo tin nhắn mới của chủ kênh (chat).',
        history ? `Cuộc trò chuyện gần đây:\n${history}` : '',
        `Tin nhắn mới của chủ kênh:\n${note}`,
        input.attachments?.length ? renderAttachments(input.attachments) : '',
        'Chỉ đổi kế hoạch khi chủ kênh yêu cầu rõ (khi đó kèm khối ```json EditPlan đầy đủ). Câu hỏi thì trả lời. Ý kiến về gu thì thêm khối ```json {"rule": "<một câu ngắn>"}. Muốn biết điều chưa rõ thì hỏi lại một câu.',
        'Trả lời tiếng Việt, ngắn, văn bản thuần.',
      ].filter(Boolean).join('\n'));
      break;
    }
    case 'produce':
      parts.push('NHIỆM VỤ: video này đang ở chế độ sản xuất; trả lời ngắn gọn bằng tiếng Việt.');
      break;
  }
  if (quick && reason !== 'plan') {
    parts.push('Dựng nhanh: khi gửi kế hoạch, giữ plan v2 (planFormat 2, templateId của mẫu, beats/scenes/graphics theo component của mẫu) và giữ nguyên phần tử chủ kênh đã sửa tay. Kế hoạch vào thẳng editor, chỉ khi chủ kênh bấm Xuất máy mới xuất video.');
  }
  return parts.join('\n\n');
}

// ── Turn ──

const planOf = (objs: unknown[]): unknown | null =>
  objs.find((o) => o && typeof o === 'object' && 'cutWords' in (o as Record<string, unknown>)) ?? null;
const ruleOf = (objs: unknown[]): string | null => {
  const o = objs.find((x) => x && typeof x === 'object' && typeof (x as { rule?: unknown }).rule === 'string') as { rule: string } | undefined;
  return o?.rule.trim() || null;
};

/** The reply without fenced JSON blocks (the plan is shown on its own card). */
export function stripJsonBlocks(text: string): string {
  return text.replace(/```(?:json)?[\s\S]*?```/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** A few analysis frames as images, when the agent's runtime reads images. */
function frameImages(store: VideoEditStore, ctx: DirectorContext): string[] {
  const out: string[] = [];
  for (const f of ctx.analysis?.frames ?? []) {
    const abs = path.isAbsolute(f.file) ? f.file : path.join(store.projectDir(ctx.project.id), f.file);
    if (fs.existsSync(abs)) out.push(abs);
    if (out.length >= MAX_FRAMES) break;
  }
  return out;
}

function defaultRun(): LeanRun {
  const ctx = moduleCtx();
  return async (turn) => {
    if (!ctx) return { ok: false, output: '', error: 'Module video chưa chạy.' };
    return ctx.agents.runLean({ agentId: turn.agentId, title: turn.title, prompt: turn.prompt, ...(turn.images?.length ? { images: turn.images } : {}), ...(turn.signal ? { signal: turn.signal } : {}), ...(turn.timeoutMs ? { timeoutMs: turn.timeoutMs } : {}) });
  };
}

export async function runDirectorTurn(input: DirectorTurnInput, deps: DirectorDeps = {}): Promise<DirectorTurnResult> {
  const started = Date.now();
  const activity: { label: string; detail?: string }[] = [];
  const act = (label: string, detail?: string) => { activity.push({ label, ...(detail ? { detail } : {}) }); input.onActivity?.(label, detail); };
  let text = '';
  let error: string | undefined;
  let timedOut = false;
  const abort = input.abortController;
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, turnTimeoutMs());

  const store = deps.store ?? createVideoEditStore();
  const root = deps.projectRoot ?? moduleCtx()?.dir ?? process.cwd();
  const run = deps.run ?? defaultRun();
  let planned = false;
  let quickProject = false;

  try {
    const ctx = loadDirectorContext(store, input.projectId);
    if (!ctx) throw new Error('Không tìm thấy việc dựng này.');
    const { project } = ctx;
    const agentId = project.agentId || 'main';

    const creating = project.mode === 'create';
    const producing = project.mode === 'produce' && !project.source;
    const produceFinishing = project.mode === 'produce' && Boolean(project.source) && Boolean(project.productionId);
    const reason: DirectorReason = produceFinishing && input.reason === 'produce' ? 'chat' : input.reason;
    const attachments = resolveAttachments(store.root, input.attachments);

    let prompt: string;
    let images: string[] = [];
    if (creating) {
      act('Đọc khả năng của Flow');
      const service = creationServiceFor(store.root);
      let capabilities: unknown;
      try { capabilities = service ? await service.execute(project.id, agentId, 'flow_capabilities', {}, abort.signal) : undefined; } catch { /* RocketFlow not connected: the prompt says so */ }
      prompt = creationPrompt(root, project, [input.note, attachments.length ? renderAttachments(attachments, false) : ''].filter(Boolean).join('\n\n') || undefined, { capabilities });
    } else if (producing) {
      let state: unknown;
      try {
        const service = productionServiceFor(store.root);
        state = service && project.productionId ? await executeProduceTool(service, project.productionId, 'produce_context', {}) : undefined;
      } catch { /* the prompt still carries the brief and history */ }
      prompt = buildProducePrompt({ root, project, history: store.readMessages(project.id), reason: input.reason, ...(input.note ? { note: input.note } : {}), ...(state ? { state } : {}) });
    } else {
      act('Đọc lời chép và phân tích');
      const query = [ctx.style?.name, reason === 'plan' ? 'hook nhịp cắt phụ đề' : input.note].filter(Boolean).join(' ');
      const data = loadDirectorData(store, ctx, root, deps.lessons?.(query) ?? []);
      let assetImages: string[] = [];
      if (project.quick) {
        act('Đọc mẫu edit, tư liệu và kho');
        const loaded = await loadQuickBrief(store, ctx, deps);
        data.quick = loaded.brief;
        assetImages = loaded.images;
      }
      prompt = buildDirectorPrompt({ reason, ...(input.note ? { note: input.note } : {}), attachments, ctx, data });
      images = [...assetImages, ...frameImages(store, ctx)];
      planned = reason !== 'chat' && reason !== 'produce';
      // Dựng nhanh plans go straight to the editor: no "Cần tôi" card.
      quickProject = Boolean(project.quick);
    }

    fs.mkdirSync(path.join(store.projectDir(project.id), 'drafts'), { recursive: true });
    act('Đạo diễn đang làm việc');
    const r = await run({ agentId, title: `Video: ${project.title}`.slice(0, 80), prompt, images, signal: abort.signal, timeoutMs: turnTimeoutMs() });
    if (!r.ok) throw new Error(r.error || 'Agent không hoàn thành lượt này.');
    text = r.output;
    input.onDelta?.(text);

    if (!creating && !producing) {
      const objs = jsonObjectsOf(text);
      const plan = planOf(objs);
      const rule = ruleOf(objs);
      if (rule) {
        const profile = store.getProfile(project.profileId);
        if (profile) {
          const res = appendTasteRule(profile.taste, rule);
          if (res.added) store.saveProfile({ ...profile, taste: res.taste });
          act('Ghi luật mới cho kênh');
        }
      }
      if (plan) {
        if (!deps.submitPlan) throw new Error('Chưa nối bước nộp kế hoạch.');
        const note = stripJsonBlocks(text).split('\n')[0]?.slice(0, 300);
        const res = deps.submitPlan(project.id, plan, note);
        if (!res.ok) throw new Error(`Kế hoạch chưa hợp lệ: ${res.errors.slice(0, 5).join('; ')}`);
        act('Đã nộp kế hoạch', `v${res.plan.version}`);
        text = stripJsonBlocks(text) || 'Đã nộp kế hoạch, chờ chủ kênh duyệt.';
      } else if (planned) {
        throw new Error('Agent không trả kế hoạch dưới dạng khối JSON. Thử lại.');
      } else {
        text = stripJsonBlocks(text) || text;
      }
    }
  } catch (err) {
    error = abort.signal.aborted
      ? (timedOut ? 'Đạo diễn làm quá thời gian cho phép.' : 'Đã dừng theo yêu cầu.')
      : String((err as Error)?.message ?? err);
    planned = false;
  } finally {
    clearTimeout(timer);
  }

  // A plan that is now waiting for the owner becomes a "Cần tôi" card (idempotent per plan version).
  if (planned && !error && !quickProject) {
    try { requestVideoPlanApproval(input.projectId, { store: () => store }); }
    catch { /* the approval card is a convenience; the plan itself is saved */ }
  }

  if (!text.trim() && !error) error = 'Đạo diễn không trả lời. Thử lại sau ít giây.';
  return { text: text.trim(), durationMs: Date.now() - started, activity, ...(error ? { error } : {}) };
}
