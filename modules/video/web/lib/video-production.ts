/**
 * Video Studio › Sản xuất: types (mirror of src/video-edit/production/types.ts) and pure helpers.
 * No DOM and no API here (see video-production-api.ts), so this runs under the node vitest environment.
 */

export type VideoAspect = '9:16' | '16:9' | '1:1' | '4:5';
export type SceneKind = 'talking' | 'broll' | 'clip';
export type SceneEngine = 'heygen' | 'veo' | 'fal' | 'rocketflow' | 'stock' | 'clip';
export type SceneStatus = 'draft' | 'queued' | 'running' | 'done' | 'failed';
export type ProductionState = 'brief' | 'storyboard' | 'generating' | 'ready' | 'assembling' | 'finishing' | 'failed';

export interface ProductionScene {
  id: string;
  kind: SceneKind;
  kolId: string | null;
  text: string;
  visual: string;
  engine: SceneEngine;
  model: string | null;
  sourceAssetId: string | null;
  clipAssetId: string | null;
  durationSec: number;
  /** Trim point inside the take (seconds). */
  trimStart?: number;
  /** Approved takes so far. */
  take?: number;
  /** Provider overloaded: retries by itself at `at` (no new approval). */
  retry?: { n: number; at: string } | null;
  status: SceneStatus;
  job: { provider: string; ref: string; startedAt: string } | null;
  /** durationSec: what plays (after trim); sourceSec: the whole file. */
  output: { file: string; durationSec: number; sourceSec?: number; subtitles: string | null; thumb: string | null; credit?: string } | null;
  error: string | null;
  updatedAt: string;
  /** Why the scene cannot start yet, or null. */
  problem: string | null;
}

export interface ProductionScript { title: string; hook: string; caption: string; hashtags: string[] }

export interface CostLine { sceneId: string; engine: SceneEngine; seconds: number; usd: number | null; credits: number | null; note: string }
export interface CostEstimate { usd: number; unpriced: number; heygenCredits: number; flowScenes: number; freeScenes: number; lines: CostLine[] }
export interface PendingApproval { approvalId: string; sceneIds: string[]; fingerprint: string; estimate: CostEstimate; createdAt: string }
export interface SeriesInfo { id: string; index: number; total: number; angle: string }

export interface Production {
  id: string;
  projectId: string | null;
  pendingApproval: PendingApproval | null;
  series?: SeriesInfo | null;
  title: string;
  /** The owner named the video; the writer keeps it. */
  titleLocked?: boolean;
  cast: string[];
  brief: string;
  aspect: VideoAspect;
  targetSec: number;
  script: ProductionScript | null;
  scenes: ProductionScene[];
  state: ProductionState;
  finishProjectId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductionSummary {
  id: string; title: string; cast: string[]; aspect: VideoAspect; targetSec: number; state: ProductionState;
  finishProjectId: string | null; projectId: string | null; series: SeriesInfo | null; pendingApproval: boolean;
  createdAt: string; updatedAt: string; scenes: number; scenesDone: number; thumb: string | null;
}

export interface KolBrand { styleId: string | null; cta: string; intro: string; outro: string; captionNote: string; music: 'auto' | 'none' }

export interface EngineStatus { id: string; label: string; role: string; ready: boolean; detail: string; fix: string | null }

export interface KolVoice { provider: 'heygen'; voiceId: string; name: string }

export interface CastMember {
  id: string; name: string; handle: string; avatarUrl: string | null; tagline: string; status: string;
  images: { id: string; url: string; thumbUrl: string | null; width: number | null; height: number | null }[];
  videos: { id: string; url: string; thumbUrl: string | null; durationSec: number | null }[];
  voice: KolVoice | null;
  brand?: KolBrand;
  /** A real, licensed person: Veo cannot render them. */
  realPerson?: boolean;
}

export interface HeygenVoice { voiceId: string; name: string; language: string; gender: string; previewUrl: string | null; type: 'public' | 'private' }

// ── Labels ───────────────────────────────────────────────────────────

export const KIND_LABEL: Record<SceneKind, string> = { talking: 'KOL nói', broll: 'B-roll', clip: 'Clip có sẵn' };
export const ENGINE_LABEL: Record<SceneEngine, string> = { heygen: 'HeyGen', veo: 'Veo 3.1', fal: 'fal.ai', rocketflow: 'RocketFlow', stock: 'Pexels', clip: 'Clip' };
export const ENGINES_FOR: Record<SceneKind, SceneEngine[]> = { talking: ['heygen', 'veo', 'rocketflow'], broll: ['veo', 'stock', 'fal', 'rocketflow'], clip: ['clip'] };
export const STATUS_LABEL: Record<SceneStatus, string> = { draft: 'Chưa tạo', queued: 'Đang chờ', running: 'Đang tạo', done: 'Xong', failed: 'Lỗi' };
export const STATE_LABEL: Record<ProductionState, string> = {
  brief: 'Ý tưởng', storyboard: 'Phân cảnh', generating: 'Đang tạo cảnh', ready: 'Sẵn sàng hoàn thiện',
  assembling: 'Đang ghép', finishing: 'Đang hoàn thiện', failed: 'Có lỗi',
};
export const ASPECTS: { id: VideoAspect; label: string; hint: string }[] = [
  { id: '9:16', label: '9:16', hint: 'TikTok · Reels · Shorts' },
  { id: '16:9', label: '16:9', hint: 'YouTube · Web' },
  { id: '1:1', label: '1:1', hint: 'Feed vuông' },
  { id: '4:5', label: '4:5', hint: 'Feed Instagram' },
];
export const DURATIONS = [15, 30, 45, 60, 90];

export const IDEA_STARTERS: { label: string; text: string }[] = [
  { label: 'Giới thiệu sản phẩm', text: 'giới thiệu sản phẩm [tên sản phẩm]: vấn đề khách gặp, sản phẩm giải quyết thế nào, kêu gọi dùng thử' },
  { label: 'Build in public', text: 'kể hậu trường tuần này đang xây gì, cái gì hỏng, cái gì chạy, bài học rút ra' },
  { label: 'Mẹo nhanh 30 giây', text: 'một mẹo dùng AI cho chủ doanh nghiệp nhỏ, làm được ngay hôm nay' },
  { label: 'Câu chuyện founder', text: 'kể một bài học thất bại thật và điều đã thay đổi sau đó' },
  { label: 'Mời tham gia', text: 'mời tham gia chương trình / sự kiện [tên], lợi ích chính và cách đăng ký' },
];

/** Production stage on the 4-step rail: 0 idea, 1 storyboard, 2 scenes, 3 finishing. */
export function stageOf(state: ProductionState): 0 | 1 | 2 | 3 {
  if (state === 'brief') return 0;
  if (state === 'storyboard' || state === 'failed') return 1;
  if (state === 'generating' || state === 'ready') return 2;
  return 3;
}

export function fmtSec(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return s < 60 ? `${s} giây` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Planned length: finished clips count their real length, the rest their target. */
export function totalSec(scenes: { durationSec: number; output: { durationSec: number } | null }[]): number {
  return Math.round(scenes.reduce((s, x) => s + (x.output?.durationSec ?? x.durationSec), 0) * 10) / 10;
}

export function sceneCounts(scenes: Pick<ProductionScene, 'status'>[]): { done: number; running: number; failed: number; draft: number; total: number } {
  const c = { done: 0, running: 0, failed: 0, draft: 0, total: scenes.length };
  for (const s of scenes) {
    if (s.status === 'done') c.done++;
    else if (s.status === 'running' || s.status === 'queued') c.running++;
    else if (s.status === 'failed') c.failed++;
    else c.draft++;
  }
  return c;
}

/**
 * Rough spend of the scenes that are not done yet: Veo through Google is about $0.15 per second;
 * HeyGen uses plan credits (no USD); fal depends on the model; RocketFlow uses the Google Flow plan.
 */
export function spendHint(scenes: Pick<ProductionScene, 'engine' | 'durationSec' | 'status'>[]): { usd: number; heygenScenes: number; other: number } {
  let usd = 0, heygenScenes = 0, other = 0;
  for (const s of scenes) {
    if (s.status === 'done') continue;
    if (s.engine === 'veo') usd += 0.15 * Math.min(8, s.durationSec);
    else if (s.engine === 'heygen') heygenScenes++;
    else if (s.engine !== 'clip') other++;
  }
  return { usd: Math.round(usd * 100) / 100, heygenScenes, other };
}

// ── @mentions ────────────────────────────────────────────────────────

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

/** The mention being typed just before the caret ("@ton" → "ton"), or null. */
export function activeMention(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([\p{L}\p{N}._-]{0,30})$/u.exec(before);
  return m ? { query: m[2], start: before.length - m[2].length - 1 } : null;
}

/** Cast matching a typed query by handle or name (accent-insensitive). */
export function matchCast<T extends Pick<CastMember, 'name' | 'handle'>>(cast: T[], query: string): T[] {
  const q = fold(query);
  return cast.filter((c) => !q || fold(c.handle).includes(q) || fold(c.name).replace(/\s+/g, '').includes(q.replace(/\s+/g, '')) || fold(c.name).includes(q)).slice(0, 8);
}

/** Replaces the typed mention with "@handle ". Returns the new text and caret. */
export function insertMention(text: string, mention: { start: number; query: string }, handle: string): { text: string; caret: number } {
  const token = `@${handle} `;
  const next = text.slice(0, mention.start) + token + text.slice(mention.start + 1 + mention.query.length);
  return { text: next, caret: mention.start + token.length };
}

/** KOL ids mentioned in the text (by @handle or @name without spaces), in order of first mention. */
export function mentionedIds<T extends Pick<CastMember, 'id' | 'name' | 'handle'>>(text: string, cast: T[]): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/@([\p{L}\p{N}._-]+)/gu)) {
    const tag = fold(m[1]);
    const hit = cast.find((c) => fold(c.handle) === tag || fold(c.name).replace(/\s+/g, '') === tag);
    if (hit && !out.includes(hit.id)) out.push(hit.id);
  }
  return out;
}

/** "@handle" mentions are for the UI; the writer gets the plain brief with names. */
export function briefWithNames<T extends Pick<CastMember, 'name' | 'handle'>>(text: string, cast: T[]): string {
  return text.replace(/@([\p{L}\p{N}._-]+)/gu, (all, tag: string) => {
    const hit = cast.find((c) => fold(c.handle) === fold(tag) || fold(c.name).replace(/\s+/g, '') === fold(tag));
    return hit ? hit.name : all;
  }).trim();
}

/** "≈ $2,40 (Veo/fal) · ≈ 18 credit HeyGen · 1 cảnh Flow · 2 cảnh miễn phí" — same wording as the server card. */
export function describeEstimate(e: Pick<CostEstimate, 'usd' | 'unpriced' | 'heygenCredits' | 'flowScenes' | 'freeScenes'>): string {
  const parts: string[] = [];
  if (e.usd > 0) parts.push(`≈ $${e.usd.toFixed(2).replace('.', ',')} (Veo/fal)`);
  if (e.unpriced) parts.push(`${e.unpriced} cảnh chưa có giá`);
  if (e.heygenCredits) parts.push(`≈ ${e.heygenCredits} credit HeyGen`);
  if (e.flowScenes) parts.push(`${e.flowScenes} cảnh dùng credit Google Flow`);
  if (e.freeScenes) parts.push(`${e.freeScenes} cảnh miễn phí`);
  return parts.join(' · ') || 'Không tốn chi phí';
}

/** start: where the scene begins in the whole video; trimStart: where it begins inside its own file. */
export interface PlaylistItem { sceneId: string; index: number; start: number; durationSec: number; trimStart: number }

/** Finished scenes in order, with their start time in the whole video (for the sequential preview). */
export function previewPlaylist(scenes: Pick<ProductionScene, 'id' | 'status' | 'output' | 'trimStart'>[]): { items: PlaylistItem[]; total: number } {
  const items: PlaylistItem[] = [];
  let t = 0;
  scenes.forEach((s, index) => {
    if (s.status !== 'done' || !s.output) return;
    items.push({ sceneId: s.id, index, start: t, durationSec: s.output.durationSec, trimStart: s.trimStart ?? 0 });
    t += s.output.durationSec;
  });
  return { items, total: Math.round(t * 1000) / 1000 };
}

/** The playlist item playing at time `t` (seconds into the whole video) and the offset inside it (from its trim point). */
export function locateAt(items: PlaylistItem[], t: number): { item: PlaylistItem; offset: number } | null {
  if (!items.length) return null;
  const clamped = Math.max(0, t);
  const item = items.find((x) => clamped < x.start + x.durationSec) ?? items[items.length - 1];
  return { item, offset: Math.min(item.durationSec, Math.max(0, clamped - item.start)) };
}

/** The director's tool calls as the owner reads them. */
const TOOL_LABEL: Record<string, string> = {
  produce_context: 'Đọc phân cảnh', produce_status: 'Xem tiến độ', produce_update_brief: 'Cập nhật ý tưởng',
  produce_write_storyboard: 'Bộ não KOL viết kịch bản', produce_set_storyboard: 'Dựng lại phân cảnh', produce_update_scene: 'Sửa cảnh',
  produce_add_scene: 'Thêm cảnh', produce_move_scene: 'Đổi thứ tự cảnh', produce_remove_scene: 'Xoá cảnh', produce_estimate: 'Ước tính chi phí',
  produce_request_generation: 'Gửi thẻ duyệt chi phí', produce_finish: 'Ghép và chuyển sang hoàn thiện', produce_list_media: 'Xem ảnh và clip của KOL',
  produce_inspect_scene: 'Xem lại cảnh vừa tạo', produce_trim_scene: 'Cắt gọn cảnh',
};

/**
 * Engine activity rows → what the owner sees: one row per step (a "started" row and its "completed"
 * row merge), tool names in Vietnamese, completion as a flag.
 */
export function activitySteps(rows: { label: string; detail?: string }[]): { label: string; done: boolean; detail?: string }[] {
  const out: { label: string; raw: string; done: boolean; detail?: string }[] = [];
  for (const r of rows) {
    const tool = /^(?:mcp__)?video-produce(?::|__)\s*(\w+)/.exec(r.label)?.[1];
    const label = tool ? TOOL_LABEL[tool] ?? tool : r.label;
    const done = r.detail === 'completed';
    const prev = out[out.length - 1];
    if (done && prev && prev.raw === r.label && !prev.done) { prev.done = true; continue; }
    out.push({ label, raw: r.label, done, ...(r.detail && !done ? { detail: r.detail } : {}) });
  }
  return out.map(({ raw: _raw, ...x }) => x);
}

export type StudioItem =
  | { type: 'production'; id: string; title: string; updatedAt: string; state: ProductionState; pendingApproval: boolean; thumb: string | null; cast: string[]; series: SeriesInfo | null; scenes: number; scenesDone: number }
  | { type: 'footage'; id: string; title: string; updatedAt: string; status: string; hasSource: boolean };

/** One list for the rail: productions and recorded-footage projects, newest first. Hosts never show twice. */
export function mergeStudioItems(
  productions: ProductionSummary[],
  footage: { id: string; title: string; updatedAt: string; status: string; hasSource: boolean; mode?: string }[],
): StudioItem[] {
  const hosts = new Set(productions.flatMap((p) => [p.projectId, p.finishProjectId].filter((x): x is string => Boolean(x))));
  const items: StudioItem[] = [
    ...productions.map((p) => ({ type: 'production' as const, id: p.id, title: p.title, updatedAt: p.updatedAt, state: p.state, pendingApproval: p.pendingApproval, thumb: p.thumb, cast: p.cast, series: p.series, scenes: p.scenes, scenesDone: p.scenesDone })),
    ...footage.filter((f) => !hosts.has(f.id) && f.mode !== 'create' && f.mode !== 'produce').map((f) => ({ type: 'footage' as const, id: f.id, title: f.title, updatedAt: f.updatedAt, status: f.status, hasSource: f.hasSource })),
  ];
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
