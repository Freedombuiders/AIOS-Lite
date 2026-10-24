/**
 * KOL Studio — pure view helpers: Vietnamese labels, formatters, composer,
 * calendar and post-workflow logic. No DOM, no fetch, so it is unit-tested
 * in node (kol-view.test.ts). web/src/lib/kol.ts re-exports everything here.
 */
import type {
  AccountDto, Appearance, Aspect, AssetKind, AssetStatus, AutopilotConfig, ConsistencyVerdict, GenerationDto,
  GenerationMode, GenerationRequest, GenerationStatus, IdentitySource, KolStatusDto, LibraryGender, LibraryItemDto, LibraryKind,
  ModelInfo, ModelKind, PersonaDto, PersonaStatus, Personality, Pillar, Platform, PostDto, PostFormat, PostSource,
  PostStatus, ProviderId, Quality, RealismPreset, RefDto, RefKind, RefRoleDto, Selection, TargetStatus, TemplateDto,
  TemplateKind,
} from './kol';

/** Same tones as components/Pill.tsx. */
export type KolTone = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'high' | 'medium' | 'low' | 'neutral' | 'accent';

// ── Formatters (Vietnamese: "." thousands, "," decimals) ──────────────

const groupThousands = (int: string) => int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const isNum = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/** USD with a Vietnamese decimal comma: $0,06 · $0,039 · $0,0004 · $12,50 · $1.234,50 · $10 (whole caps). */
export function fmtUsd(n: number | null | undefined): string {
  if (!isNum(n)) return '–';
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a === 0) return '$0';
  if (a < 0.0001) return `${sign}<$0,0001`;
  if (a >= 1 && Number.isInteger(a)) return `${sign}$${groupThousands(String(a))}`;
  const digits = a < 0.01 ? 4 : a < 0.1 ? 3 : 2;
  const [int, frac0 = ''] = a.toFixed(digits).split('.');
  let frac = frac0;
  while (frac.length > 2 && frac.endsWith('0')) frac = frac.slice(0, -1);
  return `${sign}$${groupThousands(int)},${frac}`;
}

/** "≈ $0,04" for pre-priced estimates. */
export const fmtEstimate = (n: number | null | undefined): string => `≈ ${fmtUsd(n)}`;

export function fmtInt(n: number | null | undefined): string {
  if (!isNum(n)) return '–';
  const r = Math.round(n);
  return `${r < 0 ? '-' : ''}${groupThousands(String(Math.abs(r)))}`;
}

export function fmtDec(n: number | null | undefined, digits = 1): string {
  if (!isNum(n)) return '–';
  return n.toFixed(digits).replace('.', ',');
}

/** Percent value (already ×100): 4,3%. */
export function fmtPct(n: number | null | undefined, digits = 1): string {
  return isNum(n) ? `${fmtDec(n, digits)}%` : '–';
}

/** Engagement ratio from the server (0.0578) as a percent: 5,8%. */
export function fmtRate(r: number | null | undefined, digits = 1): string {
  return isNum(r) ? fmtPct(r * 100, digits) : '–';
}

/** Compact counts like the Facebook dashboards: 312 · 1,2 N · 312 N · 1,2 tr. */
export function fmtCompact(n: number | null | undefined): string {
  if (!isNum(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${fmtDec(n / 1_000_000, a >= 10_000_000 ? 0 : 1).replace(/,0$/, '')} tr`;
  if (a >= 100_000) return `${Math.round(n / 1000)} N`;
  if (a >= 1000) return `${fmtDec(n / 1000, 1).replace(/,0$/, '')} N`;
  return fmtInt(n);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** unix seconds → "20/10/2026" (browser timezone). */
export function fmtDate(sec: number | null | undefined): string {
  if (!sec) return '–';
  const d = new Date(sec * 1000);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** unix seconds → "20/10 14:30" (adds the year when it is not this year). */
export function fmtDateTime(sec: number | null | undefined, now = Date.now()): string {
  if (!sec) return '–';
  const d = new Date(sec * 1000);
  const year = d.getFullYear() !== new Date(now).getFullYear() ? `/${d.getFullYear()}` : '';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}${year} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const WEEKDAY_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
/** "T6 24/10 · 19:30". */
export function fmtSlot(sec: number | null | undefined): string {
  if (!sec) return '–';
  const d = new Date(sec * 1000);
  return `${WEEKDAY_SHORT[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "vừa xong" · "5 phút trước" · "3 giờ trước" · "2 ngày trước" · date. */
export function fmtAgo(sec: number | null | undefined, now = Date.now()): string {
  if (!sec) return '–';
  const diff = Math.floor(now / 1000) - sec;
  if (diff < 0) return fmtDateTime(sec, now);
  if (diff < 45) return 'vừa xong';
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))} phút trước`;
  if (diff < 86400) return `${Math.round(diff / 3600)} giờ trước`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)} ngày trước`;
  return fmtDate(sec);
}

export function fmtBytes(n: number | null | undefined): string {
  if (!isNum(n) || n <= 0) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${fmtDec(n / 1024, 0)} KB`;
  return `${fmtDec(n / 1024 / 1024, 1)} MB`;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (!isNum(sec)) return '–';
  const s = Math.round(sec);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

// ── Vietnamese labels ────────────────────────────────────────────────

export const PERSONA_STATUS: Record<PersonaStatus, { label: string; tone: KolTone }> = {
  draft: { label: 'Nháp', tone: 'neutral' },
  active: { label: 'Đang hoạt động', tone: 'done' },
  paused: { label: 'Tạm dừng', tone: 'medium' },
  archived: { label: 'Lưu trữ', tone: 'cancelled' },
};

export const IDENTITY_SOURCE_LABEL: Record<IdentitySource, string> = {
  synthetic: 'Nhân vật ảo (AI tạo hoàn toàn)',
  licensed: 'Người thật (có giấy đồng ý)',
};

export const REF_KIND_LABEL: Record<RefKind, string> = {
  anchor: 'Khuôn mặt chính',
  sheet: 'Bảng 360°',
  angle: 'Góc mặt',
  body: 'Toàn thân',
  expression: 'Biểu cảm',
  other: 'Khác',
};
export const REF_KINDS: RefKind[] = ['anchor', 'sheet', 'angle', 'body', 'expression', 'other'];

export const LIBRARY_KIND_LABEL: Record<LibraryKind, string> = {
  outfit: 'Trang phục',
  expression: 'Biểu cảm',
  hair: 'Kiểu tóc',
  scene: 'Bối cảnh',
  pose: 'Dáng',
  look: 'Look điện ảnh',
  effect: 'Hiệu ứng',
  camera: 'Máy ảnh',
};
export const LIBRARY_KINDS: LibraryKind[] = ['outfit', 'expression', 'hair', 'scene', 'pose', 'look', 'effect', 'camera'];

export const LIBRARY_GENDER_LABEL: Record<LibraryGender, string> = { all: 'Mọi giới', female: 'Nữ', male: 'Nam' };

/** 'female' / 'male' from a persona's written gender ("female", "Nữ", "nam"…), else null. Mirrors src/kol/library.ts genderOfText. */
export function genderOfText(gender: string | null | undefined): 'female' | 'male' | null {
  const g = (gender ?? '').trim().toLowerCase();
  const word = (w: string) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(g);
  if (/female|woman|girl|lady|nữ|con gái/.test(g) || word('f') || word('she')) return 'female';
  if (word('male') || word('man') || word('boy') || word('m') || word('he') || /(^|\s)nam(\s|$)|con trai|đàn ông|nam giới/.test(g)) return 'male';
  return null;
}

/** Does an item suit a KOL of this gender? A KOL's own items and items for everyone always do. */
export function fitsGender(item: Pick<LibraryItemDto, 'gender' | 'personaId'>, gender: 'female' | 'male' | null): boolean {
  return !gender || !!item.personaId || !item.gender || item.gender === 'all' || item.gender === gender;
}

export const TEMPLATE_KIND_LABEL: Record<TemplateKind, string> = { single: 'Ảnh đơn', carousel: 'Carousel' };

export const ASPECT_LABEL: Record<Aspect, string> = {
  '1:1': '1:1 · Vuông',
  '4:5': '4:5 · Dọc (feed Instagram)',
  '3:4': '3:4 · Dọc',
  '2:3': '2:3 · Dọc',
  '9:16': '9:16 · Reels, TikTok, Shorts',
  '16:9': '16:9 · Ngang (YouTube)',
  '5:4': '5:4 · Ngang nhẹ',
  '4:3': '4:3 · Ngang',
  '3:2': '3:2 · Ngang',
};
export const ASPECTS: Aspect[] = ['4:5', '1:1', '9:16', '3:4', '2:3', '16:9', '5:4', '4:3', '3:2'];

/** Instagram feed accepts 4:5 … 1.91:1. */
export function isInstagramFeedAspect(a: Aspect): boolean {
  const [w, h] = a.split(':').map(Number);
  const r = w / h;
  return r >= 0.8 - 1e-9 && r <= 1.91 + 1e-9;
}

export const QUALITY_LABEL: Record<Quality, string> = { draft: 'Nháp (rẻ, nhanh)', standard: 'Tiêu chuẩn', high: 'Cao', ultra: 'Tối đa' };

export const REALISM_LABEL: Record<RealismPreset, string> = {
  'iphone-candid': 'Ảnh iPhone tự nhiên',
  'pro-photo': 'Ảnh chụp chuyên nghiệp',
  editorial: 'Ảnh tạp chí',
  'film-35mm': 'Phim 35mm',
  'studio-clean': 'Studio sạch',
  none: 'Không áp dụng',
};
export const REALISM_PRESETS: RealismPreset[] = ['iphone-candid', 'pro-photo', 'editorial', 'film-35mm', 'studio-clean', 'none'];

export const PROVIDER_LABEL: Record<ProviderId, string> = { gemini: 'Gemini', chatgpt: 'ChatGPT', fal: 'fal.ai', higgsfield: 'Higgsfield' };
export const MODEL_KIND_LABEL: Record<ModelKind, string> = { image: 'Ảnh', video: 'Video', lipsync: 'Nhép miệng' };

export const GENERATION_MODE_LABEL: Record<GenerationMode, string> = {
  compose: 'Phối đồ',
  recreate: 'Tái tạo mẫu',
  sheet: 'Bảng 360°',
  bootstrap: 'Tạo khuôn mặt',
  freeform: 'Prompt tự do',
  animate: 'Ảnh → video',
  talking: 'Video nói chuyện',
};

export const GENERATION_STATUS: Record<GenerationStatus, { label: string; tone: KolTone }> = {
  queued: { label: 'Đang chờ', tone: 'queued' },
  running: { label: 'Đang tạo', tone: 'running' },
  succeeded: { label: 'Xong', tone: 'done' },
  failed: { label: 'Lỗi', tone: 'failed' },
  cancelled: { label: 'Đã huỷ', tone: 'cancelled' },
  unknown: { label: 'Không rõ (bị gián đoạn)', tone: 'medium' },
};

export const isActiveGeneration = (g: Pick<GenerationDto, 'status'>): boolean => g.status === 'queued' || g.status === 'running';

export const ASSET_KIND_LABEL: Record<AssetKind, string> = { image: 'Ảnh', video: 'Video', audio: 'Âm thanh' };
export const ASSET_STATUS: Record<AssetStatus, { label: string; tone: KolTone }> = {
  new: { label: 'Mới', tone: 'accent' },
  approved: { label: 'Đã duyệt', tone: 'done' },
  rejected: { label: 'Đã loại', tone: 'cancelled' },
};

export const VERDICT: Record<ConsistencyVerdict, { label: string; color: string }> = {
  pass: { label: 'Giống khuôn mặt', color: 'var(--color-status-done)' },
  warn: { label: 'Hơi lệch', color: 'var(--color-priority-medium)' },
  fail: { label: 'Lệch khuôn mặt', color: 'var(--color-status-failed)' },
  skipped: { label: 'Không chấm', color: 'var(--color-text-faint)' },
};

/** Mirror of the server rule (spec decision 5): ≥ threshold pass, ≥ threshold−15 warn, else fail. */
export function verdictFor(score: number, threshold: number): Exclude<ConsistencyVerdict, 'skipped'> {
  if (score >= threshold) return 'pass';
  if (score >= threshold - 15) return 'warn';
  return 'fail';
}

export const PLATFORMS: Platform[] = ['facebook', 'instagram', 'tiktok', 'youtube'];
export const PLATFORM_META: Record<Platform, { name: string; color: string }> = {
  facebook: { name: 'Facebook', color: '#4c8dff' },
  instagram: { name: 'Instagram', color: '#c77dff' },
  tiktok: { name: 'TikTok', color: '#2ee6c8' },
  youtube: { name: 'YouTube', color: '#ff5a4f' },
};

export const POST_FORMAT_LABEL: Record<PostFormat, string> = { photo: 'Ảnh', carousel: 'Carousel', reel: 'Reel', video: 'Video', text: 'Chỉ chữ' };
export const POST_FORMATS: PostFormat[] = ['photo', 'carousel', 'reel', 'video', 'text'];

export const POST_STATUS: Record<PostStatus, { label: string; tone: KolTone }> = {
  idea: { label: 'Ý tưởng', tone: 'neutral' },
  draft: { label: 'Bản nháp', tone: 'neutral' },
  review: { label: 'Chờ duyệt', tone: 'medium' },
  approved: { label: 'Đã duyệt', tone: 'accent' },
  scheduled: { label: 'Đã lên lịch', tone: 'running' },
  publishing: { label: 'Đang đăng', tone: 'running' },
  published: { label: 'Đã đăng', tone: 'done' },
  partial: { label: 'Đăng một phần', tone: 'high' },
  failed: { label: 'Lỗi', tone: 'failed' },
  cancelled: { label: 'Đã huỷ', tone: 'cancelled' },
};
export const POST_STATUSES: PostStatus[] = ['idea', 'draft', 'review', 'approved', 'scheduled', 'publishing', 'published', 'partial', 'failed', 'cancelled'];

export const TARGET_STATUS: Record<TargetStatus, { label: string; tone: KolTone }> = {
  pending: { label: 'Chờ', tone: 'neutral' },
  scheduled: { label: 'Đã lên lịch', tone: 'running' },
  publishing: { label: 'Đang đăng', tone: 'running' },
  processing: { label: 'Nền tảng đang xử lý', tone: 'running' },
  published: { label: 'Đã đăng', tone: 'done' },
  failed: { label: 'Lỗi', tone: 'failed' },
  missed: { label: 'Lỡ giờ', tone: 'failed' },
  skipped: { label: 'Bỏ qua', tone: 'cancelled' },
};

export const POST_SOURCE_LABEL: Record<PostSource, string> = { owner: 'Bạn', autopilot: 'Autopilot', radar: 'Radar', agent: 'Agent' };

export const REF_ROLE_LABEL: Record<RefRoleDto['role'], string> = {
  composition: 'Bố cục',
  identity: 'Khuôn mặt',
  sheet: 'Bảng 360°',
  outfit: 'Trang phục',
  hair: 'Kiểu tóc',
  scene: 'Bối cảnh',
  source: 'Ảnh nguồn',
};

export const ACCOUNT_STATUS: Record<AccountDto['status'], { label: string; tone: KolTone }> = {
  ACTIVE: { label: 'Đang kết nối', tone: 'done' },
  EXPIRED: { label: 'Hết hạn, cần kết nối lại', tone: 'failed' },
  ERROR: { label: 'Lỗi kết nối', tone: 'failed' },
};

export const TIKTOK_PRIVACY: { value: string; label: string }[] = [
  { value: 'SELF_ONLY', label: 'Chỉ mình tôi' },
  { value: 'MUTUAL_FOLLOW_FRIENDS', label: 'Bạn bè (theo dõi nhau)' },
  { value: 'FOLLOWER_OF_CREATOR', label: 'Người theo dõi' },
  { value: 'PUBLIC_TO_EVERYONE', label: 'Công khai' },
];

export const YOUTUBE_PRIVACY: { value: AccountDto['youtubePrivacy']; label: string }[] = [
  { value: 'public', label: 'Công khai' },
  { value: 'unlisted', label: 'Không công khai (có link mới xem được)' },
  { value: 'private', label: 'Riêng tư' },
];

export const YOUTUBE_CATEGORIES: { value: string; label: string }[] = [
  { value: '22', label: 'Mọi người & Blog' },
  { value: '24', label: 'Giải trí' },
  { value: '26', label: 'Hướng dẫn & Phong cách' },
  { value: '10', label: 'Âm nhạc' },
  { value: '19', label: 'Du lịch & Sự kiện' },
  { value: '27', label: 'Giáo dục' },
  { value: '28', label: 'Khoa học & Công nghệ' },
  { value: '17', label: 'Thể thao' },
  { value: '23', label: 'Hài' },
  { value: '1', label: 'Phim & Hoạt hình' },
];

export const LANGUAGE_LABEL: Record<string, string> = { vi: 'Tiếng Việt', en: 'English', ko: '한국어', ja: '日本語', zh: '中文', th: 'ไทย' };

// ── Persona defaults ─────────────────────────────────────────────────

export function emptyAppearance(): Appearance {
  return { gender: '', ageRange: '', ethnicity: '', face: '', eyes: '', skin: '', hair: '', body: '', marks: '', styleKeywords: [], signatureLook: '' };
}

export function emptyPersonality(): Personality {
  return { traits: [], values: [], backstory: '', voiceTone: '', writingStyle: '', catchphrases: [], do: [], dont: [] };
}

export function defaultAutopilot(): AutopilotConfig {
  return { enabled: false, postsPerWeek: {}, leadDays: 3, requireApproval: true, imagesPerPost: 2, generateMedia: false, weeklyBudgetUsd: 5 };
}

/** Diacritic-free lowercase text for search and handles ("Đà Lạt" → "da lat"). */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

/** "Linh Chi Nguyễn" → "linhchi.nguyen"-like handle (letters, digits, dots, underscores; ≤ 24). */
export function suggestHandle(name: string): string {
  const words = fold(name).replace(/[^a-z0-9\s._]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const head = words.length > 1 ? `${words.slice(0, -1).join('')}.${words[words.length - 1]}` : words[0];
  return head.slice(0, 24).replace(/\.$/, '');
}

export function newId(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// ── Pillars ──────────────────────────────────────────────────────────

export const pillarShareTotal = (pillars: Pillar[]): number => pillars.reduce((s, p) => s + (Number.isFinite(p.share) ? p.share : 0), 0);

/** Split 100% evenly; the first pillars take the remainder. */
export function evenShares(pillars: Pillar[]): Pillar[] {
  if (!pillars.length) return pillars;
  const base = Math.floor(100 / pillars.length);
  let rest = 100 - base * pillars.length;
  return pillars.map((p) => {
    const extra = rest > 0 ? 1 : 0;
    rest -= extra;
    return { ...p, share: base + extra };
  });
}

// ── Identity pack ────────────────────────────────────────────────────

export const hasAnchor = (persona: Pick<PersonaDto, 'refs'> | null | undefined): boolean =>
  !!persona?.refs.some((r) => r.kind === 'anchor');

export function sortRefs(refs: RefDto[]): RefDto[] {
  return [...refs].sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt);
}

/**
 * Move one ref up (-1) or down (+1) in the displayed order. Returns the sort
 * patches to send (only refs whose position changed), renumbered 0..n-1.
 */
export function moveRefPatches(refs: RefDto[], id: string, dir: -1 | 1): { id: string; sort: number }[] {
  const order = sortRefs(refs);
  const i = order.findIndex((r) => r.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return [];
  [order[i], order[j]] = [order[j], order[i]];
  return order.map((r, k) => ({ id: r.id, sort: k })).filter((p) => refs.find((r) => r.id === p.id)?.sort !== p.sort);
}

// ── Models ───────────────────────────────────────────────────────────

export interface ModelOption {
  model: ModelInfo;
  configured: boolean;
  providerLabel: string;
}

/** Models of one kind across providers: recommended first, then configured, then by label. */
export function modelOptions(status: KolStatusDto | null | undefined, kind: ModelKind): ModelOption[] {
  if (!status) return [];
  const out: ModelOption[] = [];
  for (const p of status.providers) {
    for (const m of p.models) if (m.kind === kind) out.push({ model: m, configured: p.configured, providerLabel: p.label });
  }
  return out.sort((a, b) =>
    Number(b.configured) - Number(a.configured)
    || Number(!!b.model.recommended) - Number(!!a.model.recommended)
    || a.model.label.localeCompare(b.model.label));
}

export function findModel(status: KolStatusDto | null | undefined, id: string): ModelOption | null {
  if (!status || !id) return null;
  for (const p of status.providers) {
    const m = p.models.find((x) => x.id === id);
    if (m) return { model: m, configured: p.configured, providerLabel: p.label };
  }
  return null;
}

/** First configured model among the preferred ids, else the recommended configured one, else any configured. */
export function pickModel(status: KolStatusDto | null | undefined, kind: ModelKind, preferred: (string | null | undefined)[] = []): string {
  const opts = modelOptions(status, kind).filter((o) => o.configured);
  for (const id of preferred) if (id && opts.some((o) => o.model.id === id)) return id;
  return (opts.find((o) => o.model.recommended) ?? opts[0])?.model.id ?? '';
}

// ── Composer ─────────────────────────────────────────────────────────

export type SlotKey = 'outfitId' | 'expressionId' | 'hairId' | 'sceneId' | 'poseId' | 'lookId' | 'effectId' | 'cameraId';
export const SLOTS: { kind: LibraryKind; key: SlotKey }[] = [
  { kind: 'outfit', key: 'outfitId' },
  { kind: 'expression', key: 'expressionId' },
  { kind: 'hair', key: 'hairId' },
  { kind: 'scene', key: 'sceneId' },
  { kind: 'pose', key: 'poseId' },
  { kind: 'look', key: 'lookId' },
  { kind: 'effect', key: 'effectId' },
  { kind: 'camera', key: 'cameraId' },
];

/** Freeform wins; a template means recreate; otherwise compose. */
export function composerMode(templateId: string | null | undefined, freeform: boolean): GenerationMode {
  if (freeform) return 'freeform';
  return templateId ? 'recreate' : 'compose';
}

export interface ComposerState {
  selection: Selection;
  freeform: boolean;
  model: string;
  aspect: Aspect;
  quality: Quality;
  count: number;
  /** Text box value; empty = random. */
  seed: string;
  extraPrompt: string;
  realism: RealismPreset;
  /** null = use the composed prompt. */
  promptOverride: string | null;
}

/** GenerationRequest for the image composer. Empty picks are left out; freeform keeps only realism. */
export function buildImageRequest(personaId: string, s: ComposerState): GenerationRequest {
  const mode = composerMode(s.selection.templateId, s.freeform);
  const selection: Selection = {};
  if (mode !== 'freeform') {
    for (const { key } of SLOTS) if (s.selection[key]) selection[key] = s.selection[key];
    if (s.selection.cameraIds?.length) selection.cameraIds = [...s.selection.cameraIds];
    if (mode === 'recreate' && s.selection.templateId) selection.templateId = s.selection.templateId;
  }
  selection.realism = s.realism;
  const seed = s.seed.trim() === '' ? NaN : Number(s.seed);
  const req: GenerationRequest = {
    personaId,
    mode,
    selection,
    params: {
      ...(s.model ? { model: s.model } : {}),
      aspect: s.aspect,
      quality: s.quality,
      count: Math.min(4, Math.max(1, Math.round(s.count) || 1)),
      ...(Number.isInteger(seed) && seed >= 0 ? { seed } : {}),
      ...(s.extraPrompt.trim() ? { extraPrompt: s.extraPrompt.trim() } : {}),
    },
  };
  if (s.promptOverride !== null && s.promptOverride.trim()) req.promptOverride = s.promptOverride;
  return req;
}

/** Modes that attach the identity pack (animate/talking start from an existing image instead). */
const NEEDS_ANCHOR = new Set<GenerationMode>(['compose', 'recreate', 'sheet', 'freeform']);

/**
 * Why the generate button is disabled (Vietnamese), or null when it may run.
 * Caps are not checked here: the server answers 402 with the exact reason.
 */
export function generateBlocker(o: {
  status: KolStatusDto | null | undefined;
  persona: Pick<PersonaDto, 'refs'> | null | undefined;
  mode: GenerationMode;
  model: string;
}): string | null {
  if (!o.status) return 'Đang tải trạng thái studio…';
  if (!o.status.killSwitches.generate) return 'Công tắc an toàn KOL_GENERATE_ENABLED đang tắt nên không thể tạo.';
  if (!o.status.enabled) return 'Studio đang tắt. Bật lại ở KOL Studio › Cài đặt.';
  if (NEEDS_ANCHOR.has(o.mode) && !hasAnchor(o.persona)) return 'Chưa có ảnh khuôn mặt chính. Thêm ở tab Hồ sơ trước khi tạo.';
  if (!o.model) return 'Chưa có mô hình nào dùng được. Thêm API key ở Kết nối.';
  const m = findModel(o.status, o.model);
  if (m && !m.configured) return `${m.providerLabel} chưa có API key. Thêm ở Kết nối.`;
  return null;
}

/**
 * Rough wall-clock for drawing `count` library catalog photos: ChatGPT ≈ 2 min each on its 3-turn pool,
 * Nano Banana ≈ 8 s each on 3 lanes (measured; src/kol/library-previews.ts).
 */
export function previewEtaSeconds(count: number, provider: ProviderId | null | undefined, persona = false): number {
  const chat = provider === 'chatgpt';
  // A KOL's own photo carries its identity images and goes through the face check: slower.
  return Math.ceil(Math.max(0, count) / 3) * (chat ? (persona ? 150 : 115) : persona ? 20 : 8);
}

export const QUALITY_SHORT: Record<Quality, string> = { draft: 'Nháp', standard: 'Tiêu chuẩn', high: 'Cao', ultra: 'Tối đa' };

/** ChatGPT's image_gen takes no seed; Gemini, fal and Higgsfield do. */
export const supportsSeed = (m: Pick<ModelInfo, 'provider'> | null | undefined): boolean => !!m && m.provider !== 'chatgpt';

/** Library picks in a selection; a camera setup (several axes) counts as one. */
export function pickCount(sel: Selection): number {
  let n = 0;
  for (const { key } of SLOTS) if (key !== 'cameraId' && sel[key]) n++;
  return n + (sel.cameraId || sel.cameraIds?.length ? 1 : 0);
}

/**
 * The requests one click sends. ChatGPT makes the images of a request one after another
 * inside a single Codex turn (about 2 minutes each), so N images go out as N one-image
 * requests that the worker runs side by side (settings.chatgptParallel). Other providers
 * return the whole batch from one call.
 */
export function splitForParallel(req: GenerationRequest, provider: ProviderId | null | undefined): GenerationRequest[] {
  const n = req.params?.count ?? 1;
  if (provider !== 'chatgpt' || n <= 1) return [req];
  return Array.from({ length: n }, () => ({ ...req, params: { ...req.params, count: 1 } }));
}

/** Seconds per image when there is no history yet: a ChatGPT turn takes about 2 minutes, the API providers well under one. */
const DEFAULT_SECONDS_PER_IMAGE: Partial<Record<ProviderId, number>> = { chatgpt: 120 };

/** Median seconds per image (identity check included) of the model's recent successful runs, else a provider default. */
export function secondsPerImage(
  gens: Pick<GenerationDto, 'model' | 'status' | 'startedAt' | 'finishedAt' | 'params'>[],
  model: Pick<ModelInfo, 'id' | 'provider'>,
): number {
  const xs = gens
    .filter((g) => g.model === model.id && g.status === 'succeeded' && g.startedAt && g.finishedAt && g.finishedAt > g.startedAt)
    .slice(0, 12)
    .map((g) => (g.finishedAt! - g.startedAt!) / Math.max(1, g.params.count ?? 1))
    .sort((a, b) => a - b);
  if (!xs.length) return DEFAULT_SECONDS_PER_IMAGE[model.provider] ?? 40;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** Wall-clock estimate for `count` images: ChatGPT runs `parallel` one-image jobs at once, the others make a batch in sequence. */
export function etaSeconds(perImage: number, count: number, provider: ProviderId | null | undefined, parallel = 3): number {
  const n = Math.max(1, count);
  const rounds = provider === 'chatgpt' ? Math.ceil(n / Math.max(1, parallel)) : n;
  return perImage * rounds;
}

/** "~40 giây" · "~2 phút" · "~1 giờ". */
export function fmtEta(sec: number | null | undefined): string {
  if (!isNum(sec) || sec <= 0) return '';
  if (sec < 50) return `~${Math.max(5, Math.round(sec / 5) * 5)} giây`;
  if (sec < 3300) return `~${Math.max(1, Math.round(sec / 60))} phút`;
  return `~${Math.round(sec / 3600)} giờ`;
}

/** "0:42" running clock. */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/**
 * Composer state that reproduces a past image generation: its picks, template, format, model,
 * seed and direction. The image count stays as it is (ChatGPT batches are stored as one-image
 * jobs), and a hand-edited prompt is not stored apart from the composed one, so the composer
 * goes back to the automatic prompt.
 */
export function composerFromGeneration(g: Pick<GenerationDto, 'mode' | 'model' | 'params' | 'selection'>, current: ComposerState): ComposerState {
  const picks = g.selection;
  const selection: Selection = {};
  for (const { key } of SLOTS) if (picks[key]) selection[key] = picks[key];
  if (picks.cameraIds?.length) selection.cameraIds = [...picks.cameraIds];
  if (g.mode === 'recreate' && picks.templateId) selection.templateId = picks.templateId;
  const freeform = g.mode === 'freeform';
  return {
    ...current,
    selection: freeform ? current.selection : selection,
    freeform,
    model: g.model || current.model,
    aspect: g.params.aspect ?? current.aspect,
    quality: g.params.quality ?? current.quality,
    seed: Number.isInteger(g.params.seed) ? String(g.params.seed) : '',
    extraPrompt: g.params.extraPrompt ?? '',
    realism: picks.realism ?? current.realism,
    promptOverride: null,
  };
}

// ── Library & templates ──────────────────────────────────────────────

/** Group chips with counts, in the order the groups first appear (a KOL's own items first, then by `sort`). */
/** A KOL's own items (her wardrobe, her places) come before the shared library, then library order. */
const ownFirst = (a: Pick<LibraryItemDto, 'personaId' | 'sort'>, b: Pick<LibraryItemDto, 'personaId' | 'sort'>): number =>
  Number(!a.personaId) - Number(!b.personaId) || a.sort - b.sort;

export function groupCounts(items: LibraryItemDto[]): { group: string; count: number }[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const it of [...items].sort(ownFirst)) {
    const g = it.group || 'Khác';
    if (!counts.has(g)) order.push(g);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return order.map((group) => ({ group, count: counts.get(group) ?? 0 }));
}

/** Vietnamese search words (diacritics folded) and the English/loan words the library uses for them. */
const SEARCH_SYNONYMS: Record<string, string[]> = {
  'ca phe': ['cafe', 'coffee'], 'quan': ['cafe', 'restaurant', 'bar'], 'bien': ['beach', 'sea', 'ocean'], 'nui': ['mountain', 'hill'],
  'pho': ['street'], 'mua': ['rain'], 'tuyet': ['snow'], 'hoa': ['flower', 'floral'], 'dem': ['night'], 'nang': ['sun', 'sunlight'],
  'cuoi': ['smile', 'laugh'], 'buon': ['sad'], 'gian': ['angry'], 'ngac nhien': ['surprise'], 'nhay mat': ['wink'],
  'toc': ['hair'], 'vay': ['dress', 'skirt'], 'ao khoac': ['jacket', 'coat'], 'giay': ['shoes', 'sneakers'], 'kinh': ['glasses'],
  'phong ngu': ['bedroom'], 'nha bep': ['kitchen'], 'van phong': ['office'], 'phong gym': ['gym'], 'ho boi': ['pool'],
  'selfie': ['selfie', 'front camera'], 'guong': ['mirror'], 'phim': ['film'], 'dien anh': ['cinematic', 'film'],
};

function queryVariants(q: string): string[] {
  const out = new Set([q]);
  for (const [vi, en] of Object.entries(SEARCH_SYNONYMS)) {
    if (q.includes(vi)) for (const w of en) out.add(q.replace(vi, w));
  }
  return [...out];
}

/**
 * Filter by group chip and a query over name, group, prompt and tags: diacritic-insensitive,
 * every word must match (in any order), and common Vietnamese words also find their English
 * equivalents ("cà phê" finds "Café tối giản").
 */
export function filterLibrary(items: LibraryItemDto[], group: string, query: string): LibraryItemDto[] {
  const q = fold(query.trim()).replace(/\s+/g, ' ');
  const variants = q ? queryVariants(q).map((v) => v.split(' ').filter(Boolean)) : [];
  return [...items]
    .sort(ownFirst)
    .filter((it) => !group || (it.group || 'Khác') === group)
    .filter((it) => {
      if (!variants.length) return true;
      const hay = fold(`${it.name} ${it.group} ${it.prompt} ${it.tags.join(' ')}`);
      return variants.some((words) => words.every((w) => hay.includes(w)));
    });
}

export interface TemplateGroup {
  key: string;
  kind: TemplateKind;
  items: TemplateDto[];
  cover: TemplateDto;
  createdAt: number;
}

/** Singles stay alone; carousel templates are grouped by setId and ordered by position. Newest first. */
export function templateGroups(templates: TemplateDto[]): TemplateGroup[] {
  const sets = new Map<string, TemplateDto[]>();
  const out: TemplateGroup[] = [];
  for (const t of templates) {
    if (t.kind === 'carousel' && t.setId) {
      (sets.get(t.setId) ?? sets.set(t.setId, []).get(t.setId)!).push(t);
    } else {
      out.push({ key: t.id, kind: 'single', items: [t], cover: t, createdAt: t.createdAt });
    }
  }
  for (const [setId, list] of sets) {
    const items = [...list].sort((a, b) => a.position - b.position);
    out.push({ key: setId, kind: 'carousel', items, cover: items[0], createdAt: Math.max(...items.map((i) => i.createdAt)) });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** "beach-day_01.JPG" → "beach-day_01". */
export function fileBaseName(name: string): string {
  const base = name.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).trim() || 'Ảnh';
}

// ── Posts ────────────────────────────────────────────────────────────

export type PostAction = 'save' | 'submit' | 'approve' | 'publishNow' | 'return' | 'cancel';

/** Buttons the post editor shows for a status (null = a new, unsaved post). */
export function postActions(status: PostStatus | null): PostAction[] {
  switch (status) {
    case null: return ['save', 'submit', 'approve'];
    case 'idea':
    case 'draft': return ['save', 'submit', 'approve', 'publishNow', 'cancel'];
    case 'review': return ['save', 'approve', 'return', 'publishNow', 'cancel'];
    case 'approved': return ['save', 'approve', 'return', 'publishNow', 'cancel'];
    case 'scheduled': return ['save', 'return', 'publishNow', 'cancel'];
    case 'failed': return ['cancel'];
    default: return [];
  }
}

/** Fields can change only before publishing starts. */
export const postEditable = (status: PostStatus | null): boolean =>
  status === null || status === 'idea' || status === 'draft' || status === 'review' || status === 'approved' || status === 'scheduled';

/** "#a, b  #c" → ["a", "b", "c"] (unique, no '#'). */
export function parseHashtags(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const tag = raw.replace(/^#+/, '').trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

export const formatHashtags = (tags: string[]): string => tags.map((t) => `#${t}`).join(' ');

/** The moment a post sits on the calendar. */
export function postSlot(p: Pick<PostDto, 'status' | 'scheduledAt' | 'publishedAt'>): number | null {
  return (p.status === 'published' || p.status === 'partial' ? p.publishedAt ?? p.scheduledAt : p.scheduledAt ?? p.publishedAt) ?? null;
}

/** Platforms of the selected accounts, in the canonical order. */
export function platformsOf(accounts: Pick<AccountDto, 'id' | 'platform'>[], ids: string[]): Platform[] {
  const set = new Set(accounts.filter((a) => ids.includes(a.id)).map((a) => a.platform));
  return PLATFORMS.filter((p) => set.has(p));
}

/**
 * Format problems the publisher will refuse (Vietnamese), checked before
 * approval so the owner sees them early. The server is still the authority.
 */
export function formatWarnings(format: PostFormat, platforms: Platform[], assets: { kind: AssetKind }[]): string[] {
  const out: string[] = [];
  const videos = assets.filter((a) => a.kind === 'video').length;
  const images = assets.filter((a) => a.kind === 'image').length;
  if ((platforms.includes('tiktok') || platforms.includes('youtube')) && videos === 0) out.push('TikTok và YouTube chỉ nhận video. Thêm một video hoặc bỏ chọn hai kênh này.');
  if (format === 'carousel' && (images < 2 || images > 10)) out.push('Carousel cần 2–10 ảnh.');
  if ((format === 'photo') && images === 0) out.push('Bài ảnh cần ít nhất một ảnh.');
  if ((format === 'reel' || format === 'video') && videos === 0) out.push('Bài video/reel cần một video.');
  return out;
}

// ── Calendar (local time, Monday-first) ──────────────────────────────

export function startOfWeek(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  return out;
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
}

export const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function weekDays(start: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** "20/10 – 26/10/2026". */
export function weekLabel(start: Date): string {
  const end = addDays(start, 6);
  return `${start.getDate()}/${start.getMonth() + 1} – ${end.getDate()}/${end.getMonth() + 1}/${end.getFullYear()}`;
}

/** Posts of the week keyed by local day, each day sorted by time. */
export function postsByDay<T extends Pick<PostDto, 'status' | 'scheduledAt' | 'publishedAt'>>(posts: T[], weekStart: Date): Map<string, T[]> {
  const from = weekStart.getTime() / 1000;
  const to = addDays(weekStart, 7).getTime() / 1000;
  const map = new Map<string, T[]>();
  for (const p of posts) {
    const s = postSlot(p);
    if (s === null || s < from || s >= to) continue;
    const k = dayKey(new Date(s * 1000));
    (map.get(k) ?? map.set(k, []).get(k)!).push(p);
  }
  for (const list of map.values()) list.sort((a, b) => (postSlot(a) ?? 0) - (postSlot(b) ?? 0));
  return map;
}

// ── Meters & growth ──────────────────────────────────────────────────

export function meterPercent(used: number, cap: number | null | undefined): number {
  if (!cap || cap <= 0 || !Number.isFinite(used)) return 0;
  return Math.max(0, Math.min(100, (used / cap) * 100));
}

export function meterColor(pct: number): string {
  if (pct >= 100) return 'var(--color-status-failed)';
  if (pct >= 80) return 'var(--color-priority-medium)';
  return 'var(--color-accent)';
}

/** 0..1 intensity per hour (0–23) from average engagement; hours without posts are null. */
export function hourIntensity(hours: { hour: number; posts: number; avgEngagement: number | null }[]): (number | null)[] {
  const out: (number | null)[] = Array.from({ length: 24 }, () => null);
  const max = Math.max(0, ...hours.map((h) => (h.posts > 0 && isNum(h.avgEngagement) ? h.avgEngagement : 0)));
  for (const h of hours) {
    if (h.hour < 0 || h.hour > 23 || h.posts <= 0 || !isNum(h.avgEngagement)) continue;
    out[h.hour] = max > 0 ? h.avgEngagement / max : 0;
  }
  return out;
}

export const sumFollowers = (accounts: { followers: number | null }[]): number | null =>
  accounts.some((a) => isNum(a.followers)) ? accounts.reduce((s, a) => s + (a.followers ?? 0), 0) : null;

/** Face shown for a persona: primary anchor, else the first anchor, else any ref. */
export function personaAvatar(persona: Pick<PersonaDto, 'refs'> | null | undefined): string | null {
  if (!persona) return null;
  const refs = sortRefs(persona.refs);
  return (refs.find((r) => r.isPrimary && r.kind === 'anchor') ?? refs.find((r) => r.kind === 'anchor') ?? refs.find((r) => r.isPrimary) ?? refs[0])?.url ?? null;
}
