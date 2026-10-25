// Video Studio — raw-footage editing. Shared contract between the API (src/video-edit),
// the UI (web/src/lib/video-edit/types.ts is a verbatim copy) and, from phase 1, the
// video-editor agent (via video-cli). Architecture: docs/plans/video-studio-edit.md.
// Keep the two copies identical; change this file first.

export type VideoAspect = '9:16' | '16:9' | '1:1' | '4:5';
export type VideoPlatform = 'tiktok' | 'facebook' | 'youtube' | 'instagram' | 'linkedin' | 'other';

// ── Edit ticket ("phiếu dựng"): 12 steps ──────────────────────────────────────

export type StepKey =
  | 'ingest' | 'transcribe' | 'analyze' | 'direct' | 'approve' | 'cut'
  | 'captions' | 'effects' | 'audio' | 'render' | 'cover' | 'deliver';

/** unavailable = the engine for this step is not built yet (shown muted in the UI). */
export type StepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped' | 'unavailable';

/** Who does the work: deterministic local tools, the AI agent, or the owner. */
export type StepActor = 'machine' | 'ai' | 'owner';

export interface StepDef {
  key: StepKey;
  label: string;
  actor: StepActor;
  /** Roadmap phase that implements it (0 = shell, built now). */
  phase: 0 | 1 | 2 | 3;
  tools: string;
}

export const STEP_DEFS: readonly StepDef[] = [
  { key: 'ingest', label: 'Nhận video', actor: 'machine', phase: 1, tools: 'ffprobe, chuẩn hoá 1080p CFR + bản xem nhẹ' },
  { key: 'transcribe', label: 'Chép lời tiếng Việt', actor: 'machine', phase: 1, tools: 'whisper-cli large-v3-turbo, mốc từng từ, từ cần giữ nguyên' },
  { key: 'analyze', label: 'Soi chỗ lặng & vấp', actor: 'machine', phase: 1, tools: 'silencedetect, từ đệm, câu nói lại, scdet, khung hình' },
  { key: 'direct', label: 'Lên kế hoạch dựng', actor: 'ai', phase: 1, tools: 'agent đọc lời + hồ sơ + bài học + vài khung hình → kế hoạch' },
  { key: 'approve', label: 'Bạn duyệt kế hoạch', actor: 'owner', phase: 1, tools: 'Cần tôi / nút duyệt trong phiếu' },
  { key: 'cut', label: 'Cắt ghép', actor: 'machine', phase: 1, tools: 'composition HyperFrames, mỗi đoạn một clip, fade 30ms' },
  { key: 'captions', label: 'Phụ đề tô từ khoá', actor: 'machine', phase: 1, tools: 'chữ HTML theo hồ sơ + phong cách' },
  { key: 'effects', label: 'Hook, hiệu ứng, B-roll', actor: 'ai', phase: 1, tools: '6 hiệu ứng cơ bản + hook + B-roll; khối HyperFrames thêm ở GĐ2' },
  { key: 'audio', label: 'Nhạc & tiếng động', actor: 'machine', phase: 1, tools: 'kho nhạc/SFX, mức âm theo hồ sơ, chuẩn hoá LUFS' },
  { key: 'render', label: 'Xuất video & tự kiểm', actor: 'machine', phase: 1, tools: 'hyperframes render + chụp 6 khung để soát' },
  { key: 'cover', label: 'Ảnh bìa 3 phương án', actor: 'machine', phase: 1, tools: 'khung đẹp + chữ trong vùng an toàn' },
  { key: 'deliver', label: 'Giao & đăng', actor: 'owner', phase: 1, tools: 'tải xuống, chép vào thư mục giao; đăng bài ở GĐ3' },
] as const;

export interface ProjectStep {
  key: StepKey;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  /** One short Vietnamese line, e.g. "118.5s → 87.0s, bỏ 14 chỗ lặng". */
  summary?: string;
  error?: string;
  /** 0..1 while running. */
  progress?: number;
  /** Evidence lines shown under the step on the ticket ("12:57 · đã cắt 86.0s → đọc lại lời"). */
  log?: { at: string; text: string }[];
}

export interface MediaInfo {
  fileName: string;
  sizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec?: string;
  hasAudio: boolean;
  /** Display rotation in degrees from the container (phones often store 90/270). */
  rotation?: number;
}

// ── Transcript + analysis (phase 1) ───────────────────────────────────────────

export interface TranscriptWord {
  /** Index in `Transcript.words`; plans reference words by this. */
  i: number;
  text: string;
  /** Source seconds. */
  start: number;
  end: number;
  prob?: number;
}

export interface Transcript {
  language: string;
  model: string;
  durationSec: number;
  words: TranscriptWord[];
  createdAt: string;
}

export interface AnalysisResult {
  silences: { start: number; end: number }[];
  /** Standalone filler words ("ờ", "ừm", "à"…). */
  fillers: { wordIndex: number; text: string }[];
  /** An earlier take of a phrase the speaker restarted; these words are cut by default. */
  retakes: { fromWord: number; toWord: number; text: string }[];
  /** Scene-change times (source seconds). */
  scenes: number[];
  /** Keyframes extracted for the agent to look at; `file` is relative to the project folder. */
  frames: { at: number; file: string }[];
  loudnessLufs?: number;
  createdAt: string;
}

// ── Edit plan: what the agent decides, what the renderer executes ──────────────
// Times in `keep`/`removed`/`covers.frameAt` are SOURCE seconds; overlay/zoom/sfx `at` are
// OUTPUT seconds. `anchorWord` (index into transcript words) lets the renderer re-time an
// overlay after the cut list changes.

export type RemovedKind = 'silence' | 'filler' | 'retake' | 'offtopic';

export interface HookOption {
  id: string;
  kind: 'question' | 'warning' | 'number' | 'story' | 'other';
  /** Big on-screen text for the first ~2 s. */
  text: string;
  subtext?: string;
  /** overlay = text over the original opening; moved = play words moveFromWord..moveToWord first. */
  mode: 'overlay' | 'moved';
  moveFromWord?: number;
  moveToWord?: number;
}

// ── Plan v2 elements (Dựng nhanh): every element has an id that overrides.json keys on ──

/** ai = the director wrote it; owner = the owner added it in the editor (kept when the AI revises). */
export type ElementOrigin = 'ai' | 'owner';

export interface ElementSound {
  /** auto = the template's sound rules; none = silent; asset = an SFX from the library. */
  mode: 'auto' | 'none' | 'asset';
  assetId?: string;
  /** 0..2, 1 = the template's default level. */
  volume: number;
}

export interface ElementBase {
  /** Unique in the plan: beat 'b1'.., scene 's1'.., graphic 'g1'.., broll keeps its id, zoom 'z1'.. */
  id: string;
  /** Transcript word index; `at` is re-timed from it when the cut list changes. */
  anchorWord?: number;
  /** Output seconds. */
  at: number;
  duration: number;
  /** Entrance preset id of the template ('typewriter' | 'slide-short' | 'slide-up' | 'pop' | 'fade' …). */
  animIn?: string;
  sound?: ElementSound;
  /** Default 'ai'. */
  origin?: ElementOrigin;
}

export type ElementProps = Record<string, string | number | string[]>;

export interface TextBeat extends ElementBase {
  /** Component id in the template, default 'text-beat'. */
  component: string;
  /** Small label, e.g. "BƯỚC 1". */
  kicker?: string;
  /** Markup: *word* = highlighted, | = line break; 2–6 words, at most 2 lines. */
  title: string;
  sub?: string;
}

export interface SceneItem extends ElementBase {
  /** e.g. 'scene-steps' | 'scene-before-after'. */
  component: string;
  /** Per the component's props schema. */
  props: ElementProps;
}

export interface GraphicItem extends ElementBase {
  /** e.g. 'logo-end'. */
  component: string;
  assetId?: string;
  props?: ElementProps;
}

/** The kinds of plan element the editor and POST /plan/ops address by id. */
export type PlanElementKind = 'beat' | 'scene' | 'graphic' | 'broll' | 'zoom';

export interface BrollItem {
  id: string;
  /** Transcript word the cut-in starts on; re-timed automatically when cuts change. */
  anchorWord: number;
  duration: number;
  title: string;
  /** Why it is there ("khi nói 'sạc 100W'"). */
  reason: string;
  source: 'product' | 'library' | 'ai' | 'upload' | 'pexels';
  /** Library asset id (source library/product/upload) when a file exists. */
  assetId?: string;
  /** Prompt for an AI-generated clip (source ai). */
  prompt?: string;
  layout: 'full' | 'card' | 'cutout';
  /** Percent of the video frame, used to keep a cutout above the speaker. */
  box?: { x: number; y: number; w: number; h: number };
  enabled: boolean;
  /** The owner's description sent with their own footage. */
  hint?: string;
  /** What the director wants found for a filler shot (keywords in English, 2–4). */
  query?: { description: string; keywords: string[] };
  animIn?: string;
  sound?: ElementSound;
  origin?: ElementOrigin;
}

export interface ZoomItem {
  /** 'z1'.. in plan v2; legacy plans have none. */
  id?: string;
  anchorWord?: number;
  /** Output seconds. */
  at: number;
  duration: number;
  scale: number;
  origin?: ElementOrigin;
}

export interface EditPlan {
  version: number;
  /** In-place edits of an owner draft (POST /plan/ops) bump this instead of `version`. */
  rev?: number;
  createdAt: string;
  styleId: string;
  aspect: VideoAspect;
  targetSeconds?: number;
  /** One paragraph for the owner, Vietnamese. */
  summary: string;
  sourceDurationSec: number;
  outputDurationSec: number;
  /** Source of truth for cuts: transcript word indexes removed. `keep` is derived from it + `gapMs`. */
  cutWords: number[];
  /** Longest pause kept between two kept words (ms); longer gaps are cut. */
  gapMs: number;
  /** Derived (computeKeep) — cached for display and the renderer. */
  keep: { start: number; end: number }[];
  removed: { start: number; end: number; kind: RemovedKind; text?: string }[];
  hook?: { options: HookOption[]; chosen: string };
  brolls: BrollItem[];
  captions: {
    styleId: string;
    position: 'bottom' | 'middle' | 'behind';
    highlight: string[];
    maxWordsPerChunk: number;
  };
  overlays: {
    id: string;
    effect: string;
    anchorWord?: number;
    at: number;
    duration: number;
    props: Record<string, string | number | string[]>;
  }[];
  zooms: ZoomItem[];
  music?: { assetId: string; mood: string; gainDb: number; duck: boolean };
  sfx: { at: number; assetId: string; gainDb?: number }[];
  covers: { frameAt: number; title: string; subtitle?: string }[];
  meta: { title: string; caption: string; hashtags: string[]; hook?: string };
  /** Who produced this version. */
  author: 'auto' | 'agent' | 'owner';
  /** Owner-visible list of what changed vs the previous version. */
  changes?: string[];
  // Plan v2 (Dựng nhanh): all optional, so a plan without them is a legacy plan and still valid.
  planFormat?: 2;
  templateId?: string;
  autoCut?: boolean;
  /** Track "Chữ". */
  beats?: TextBeat[];
  /** Track "Minh hoạ". */
  scenes?: SceneItem[];
  /** Track "Đồ hoạ". */
  graphics?: GraphicItem[];
}

// ── Owner overrides (overrides.json next to project.json) ──
// The owner's hand edits by element id, applied over the plan by the composition. The AI never writes
// this file; when a new AI plan drops an element that has an override, GET /overrides lists it in `dropped`.

export interface ElementOverride {
  /** Offset, percent of the frame (x, y). */
  t?: [number, number];
  /** Size multiplier, 1 = unchanged. */
  s?: number;
  text?: { kicker?: string; title?: string; sub?: string };
  props?: ElementProps;
  animIn?: string;
  sound?: ElementSound;
  at?: number;
  duration?: number;
  /** The owner deleted an AI element. */
  hidden?: boolean;
  /** The owner swapped the file of a B-roll or graphic element (library asset id). */
  assetId?: string;
  updatedAt: string;
}

export interface OverridesDoc {
  version: 1;
  /** Key = element id. */
  elements: Record<string, ElementOverride>;
  /** Caption style the owner changed (CaptionStyle: see the template contract). */
  captions?: Partial<CaptionStyle>;
  updatedAt: string;
}

/** An AI element with an override that the current plan no longer has; the editor offers to restore it. */
export interface DroppedElement {
  id: string;
  kind: PlanElementKind;
  label: string;
  /** Latest plan version that still had it (POST /plan/ops `restore`). */
  fromVersion: number;
}

/**
 * POST /projects/:id/plan/ops body `{ baseVersion, ops }`: structural owner edits by element id. They gather
 * into one working draft (an owner draft is edited in place, `rev` bumped); 409 when baseVersion is stale.
 */
export type PlanOp =
  /** The machine assigns the id; origin 'owner'. */
  | { op: 'add'; kind: PlanElementKind; element: object }
  /** Owner elements only; an AI element is hidden with an override instead. */
  | { op: 'remove'; id: string }
  /** Split a timed element at `at` (output seconds). */
  | { op: 'split'; id: string; at: number }
  /** Cut / keep words, as PATCH /plan toggleWords. */
  | { op: 'toggleWords'; words: number[] }
  | { op: 'restore'; id: string; fromVersion: number };

/** Caption look of a template (templates/types.ts re-exports it). */
export interface CaptionStyle {
  /** 0..1 from the top. */
  pos: number;
  maxWidthPct: number;
  align: 'center' | 'left';
  font: { family: string; sizePct: number; weight: number; upper?: boolean };
  fill: string;
  stroke?: { color: string; width: number };
  shadow?: string;
  box?: { color: string; padding: number; radius: number };
  highlight: { color: string; mode: 'color' | 'box' | 'pop' };
  maxWordsPerChunk: number;
}

/** Review marks the owner pins on the timeline/transcript, sent to the agent in one batch. */
export type MarkKind = 'remove' | 'keep' | 'text' | 'broll' | 'effect' | 'other';

export interface VideoMark {
  id: string;
  projectId: string;
  planVersion: number;
  /** Output seconds of the plan version it was made on. */
  start: number;
  end?: number;
  kind: MarkKind;
  note: string;
  status: 'draft' | 'sent' | 'resolved';
  createdAt: string;
}

export const MARK_KINDS: readonly { kind: MarkKind; label: string }[] = [
  { kind: 'remove', label: 'Bỏ đoạn này' },
  { kind: 'keep', label: 'Giữ lại' },
  { kind: 'text', label: 'Sửa chữ' },
  { kind: 'broll', label: 'Thêm B-roll' },
  { kind: 'effect', label: 'Đổi hiệu ứng' },
  { kind: 'other', label: 'Khác' },
] as const;

/** Quick replies offered after delivery. */
export type QuickFeedback = 'ok' | 'fix' | 'less-effects';

export interface RenderRecord {
  version: number;
  /** Relative to the project folder. */
  file: string;
  durationSec: number;
  sizeBytes: number;
  createdAt: string;
}

export interface VideoJob {
  id: string;
  projectId: string;
  kind: 'ingest' | 'transcribe' | 'analyze' | 'direct' | 'render' | 'cover' | 'seed' | 'create-render';
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress?: number;
  message?: string;
  createdAt: string;
  finishedAt?: string;
}

// ── Channel profiles ("hồ sơ kênh") ───────────────────────────────────────────

export interface VideoProfile {
  id: string;
  slug: string;
  name: string;
  handle?: string;
  platform: VideoPlatform;
  /** Two letters for the avatar tile, derived from the name when absent. */
  initials: string;
  /** Avatar tile colour, hex. */
  color: string;
  defaultStyleId?: string;
  defaultAspect: VideoAspect;
  brand: {
    primary?: string;
    accent?: string;
    /** Main text colour, card background, and the light/dark/accent triad. */
    text?: string;
    cardBg?: string;
    light?: string;
    dark?: string;
    fontHeading?: string;
    fontBody?: string;
    /** Font files (library asset ids or file names) per role; must cover Vietnamese. */
    fontCaption?: string;
    fontCover?: string;
    logoAssetId?: string;
  };
  seriesName?: string;
  /** Mix targets: speech-rate multiplier and loudness in LUFS (closer to 0 = louder). */
  audio: { speechRate: number; voiceLufs: number; musicLufs: number; finalLufs: number };
  /** Product/brand terms: passed to whisper as a prompt and never "corrected" by the agent. */
  keepWords: string[];
  coverStyle?: string;
  /** Absolute folder where finished videos are copied; empty = keep in the project only. */
  deliverDir?: string;
  starter?: 'blank' | 'editorial' | 'neon' | 'energetic';
  /** Taste and remembered feedback, Markdown. The agent reads this before every plan. */
  taste: string;
  /** Answers to the 6 onboarding questions, keyed by ONBOARDING_QUESTIONS[].id. */
  onboarding: Record<string, string>;
  referenceChannels: string[];
  /** Configured Second Brain vault used for this channel's editing knowledge. */
  brainVaultId?: string;
  autoApprovePlan: boolean;
  createdAt: string;
  updatedAt: string;
  /** Filled by list endpoints. */
  projectCount?: number;
}

export const ONBOARDING_QUESTIONS: readonly { id: string; question: string; hint: string }[] = [
  { id: 'topic', question: 'Kênh nói về gì, cho ai xem?', hint: 'VD: mẹo dùng AI cho chủ shop online 25–40 tuổi' },
  { id: 'feeling', question: 'Xem xong, người xem nên thấy thế nào?', hint: 'VD: "làm được ngay", tin tưởng, muốn mua' },
  { id: 'tone', question: 'Giọng điệu và nhịp dựng bạn thích?', hint: 'VD: nhanh, gắt, nhiều chữ / chậm, ấm, ít hiệu ứng' },
  { id: 'avoid', question: 'Điều gì tuyệt đối không làm?', hint: 'VD: không nhạc buồn, không chữ đỏ, không cắt mất câu chào' },
  { id: 'reference', question: 'Kênh hoặc video mẫu bạn muốn giống?', hint: 'Dán link TikTok/Facebook/YouTube' },
  { id: 'cta', question: 'Cuối video muốn người xem làm gì?', hint: 'VD: theo dõi kênh, nhắn tin, bấm giỏ hàng' },
] as const;

// ── Projects ("việc" / phiếu dựng) ────────────────────────────────────────────

export type ProjectStatus = 'draft' | 'working' | 'waiting_approval' | 'rendering' | 'done' | 'failed';

export interface CreationBrief {
  idea: string;
  visuals: 'auto' | 'image' | 'video';
  model?: string;
  targetSeconds: number;
  audio: 'silent' | 'native';
  generationAuthorized: boolean;
  sceneCount?: number;
  sceneSeconds?: number;
}
export interface CreationScene {
  id: string;
  requestId: string;
  title: string;
  kind: 'image' | 'video';
  prompt: string;
  model: string;
  durationSec: number;
  generationDuration?: string;
  caption: string;
  state: 'planned' | 'submitted' | 'unknown' | 'ready' | 'imported' | 'failed' | 'cancelled';
  assetId?: string;
  /** Verified copy relative to project directory. Never an agent-selected input path. */
  mediaFile?: string;
  mediaSha256?: string;
  error?: string;
}
export interface VideoCreation {
  brief: CreationBrief;
  state: 'brief' | 'planning' | 'generating' | 'waiting' | 'ready' | 'rendering' | 'done' | 'blocked';
  script?: string;
  scenes: CreationScene[];
  error?: string;
  /** Last advertised Flow capabilities; generation revalidates live capabilities. */
  capabilities?: Record<string, unknown>;
  renderJobId?: string;
  chatRequest?: { id: string; text: string };
  briefRequestId?: string;
}

export interface VideoProject {
  /** edit = recorded footage; create = legacy Flow chat; produce = Video Studio › Sản xuất (script-first, agent-directed). */
  mode?: 'edit' | 'create' | 'produce';
  /** produce: the storyboard record this project hosts (production.json). */
  productionId?: string;
  /** produce: KOL posts made from this video with "Đăng" (one per persona and render version). */
  published?: { personaId: string; postId: string; assetId: string; version: number; at: string }[];
  creation?: VideoCreation;
  id: string;
  /** Short human code shown on the ticket, e.g. "VID-0007". */
  code: string;
  profileId: string;
  title: string;
  status: ProjectStatus;
  styleId?: string;
  aspect: VideoAspect;
  targetSeconds?: number;
  /** Agent that directs this project (any agent; default VIDEO_EDIT_AGENT or main). */
  agentId: string;
  /** Project-only brain override. Persona and tool permissions still belong to agentId. */
  directorProvider?: { type: 'openai'; model: string };
  /** Engine session to resume the conversation (Claude session id / Codex thread id). */
  engineSessionId?: string;
  source?: MediaInfo;
  steps: ProjectStep[];
  plan?: EditPlan;
  /** Current plan version (0 = none yet). */
  planVersion: number;
  /** Plan state: draft = edited, not approved; approved = waiting for/after render. */
  planStatus?: 'draft' | 'waiting_approval' | 'approved' | 'rejected';
  /** Answers to the active style's brief form. */
  brief?: Record<string, string | string[]>;
  renders?: RenderRecord[];
  /** Chosen cover (1..3) after delivery. */
  chosenCover?: number;
  outputs: { final?: boolean; covers?: number };
  /** Dựng nhanh settings saved by POST /projects/:id/ai-edit. */
  quick?: QuickSettings;
  /** True while an agent turn is running. */
  busy: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QuickSettings {
  /** manual = "Bỏ qua, tự chỉnh tay": no director turn, the machine makes the plan. */
  mode: 'ai' | 'manual';
  autoCut: boolean;
  /** Suggested gapMs 800 / 400 / 250. */
  cutLevel: 'nhe' | 'vua' | 'sat';
  templateId: string;
  assets: { assetId: string; hint?: string }[];
  music: { mode: 'ai' | 'pick' | 'none'; assetId?: string; duck: boolean; snapToBeat: boolean; endOnFinal: boolean };
  /** Allow searching stock footage for filler shots. */
  stock: boolean;
  note?: string;
  startedAt: string;
}

export type VideoProjectSummary = Pick<
  VideoProject,
  'id' | 'code' | 'profileId' | 'title' | 'status' | 'mode' | 'styleId' | 'aspect' | 'busy' | 'createdAt' | 'updatedAt'
> & { hasSource: boolean; durationSec?: number };

export interface VideoMessage {
  id: string;
  projectId: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  createdAt: string;
  styleId?: string;
  attachments?: { kind: 'video' | 'asset'; ref: string; label: string }[];
  /** Tool/progress rows from the engine, shown collapsed under an agent reply. */
  activity?: { label: string; detail?: string }[];
  durationMs?: number;
  error?: boolean;
  /** An inline action card under the message (Video Studio › Sản xuất). */
  card?: { type: 'generate_approval'; approvalId: string };
}

/** Server → UI events on GET /api/m/video/edit/projects/:id/events (SSE, JSON `data`). */
export type VideoEditEvent =
  | { type: 'project'; project: VideoProject }
  | { type: 'message'; message: VideoMessage }
  | { type: 'message_delta'; messageId: string; text: string }
  | { type: 'activity'; messageId: string; label: string; detail?: string }
  | { type: 'step'; step: ProjectStep }
  | { type: 'plan'; plan: EditPlan; planVersion: number }
  | { type: 'job'; job: VideoJob }
  /** Video Studio › Sản xuất: the production's live state (keyed by production id). */
  | { type: 'production'; production: unknown };

// ── Catalogs ──────────────────────────────────────────────────────────────────

export type StyleGroup = 'teach' | 'sell' | 'life' | 'cinema';

export const STYLE_GROUPS: readonly { id: StyleGroup; label: string }[] = [
  { id: 'teach', label: 'Dạy & kiến thức' },
  { id: 'sell', label: 'Bán hàng' },
  { id: 'life', label: 'Đời sống' },
  { id: 'cinema', label: 'Điện ảnh & giải trí' },
] as const;

export interface VideoStyle {
  id: string;
  /** Slash command typed at the start of a message, e.g. "/sanpham". */
  command: string;
  name: string;
  group: StyleGroup;
  description: string;
  bestFor: string;
  palette: { bg: string; text: string; highlight: string };
  fontHeading: string;
  fontCaption?: string;
  captionStyle: string;
  musicMoods: string[];
  cutPace: 'calm' | 'normal' | 'fast';
  sfxDensity: 'none' | 'low' | 'medium' | 'high';
  /** Effect asset ids this style prefers. */
  effects: string[];
  /** Extra direction appended to the agent prompt when this style is active. */
  promptNotes: string;
  /** Optional per-style information form (e.g. /sanpham: product, price, photos). */
  brief?: BriefField[];
}

export interface BriefField {
  key: string;
  label: string;
  kind: 'text' | 'money' | 'percent' | 'list' | 'media' | 'url' | 'choice';
  options?: string[];
  placeholder?: string;
}

export type AssetKind =
  | 'effect' | 'caption' | 'bgm' | 'sfx' | 'font' | 'background'
  | 'overlay' | 'lut' | 'video' | 'icon' | 'image';

export const ASSET_KINDS: readonly { kind: AssetKind; label: string }[] = [
  { kind: 'effect', label: 'Hiệu ứng' },
  { kind: 'caption', label: 'Kiểu chữ' },
  { kind: 'bgm', label: 'Nhạc nền' },
  { kind: 'sfx', label: 'Tiếng động' },
  { kind: 'font', label: 'Font' },
  { kind: 'background', label: 'Nền' },
  { kind: 'overlay', label: 'Lớp chồng' },
  { kind: 'lut', label: 'LUT màu' },
  { kind: 'video', label: 'Video' },
  { kind: 'icon', label: 'Icon' },
  { kind: 'image', label: 'Ảnh' },
] as const;

export interface VideoAsset {
  id: string;
  kind: AssetKind;
  name: string;
  description?: string;
  tags: string[];
  /** builtin = catalog entry without its own file; seed = file installed by the starter pack;
   *  library = file the owner added (upload or dropped into the library folder). */
  source: 'builtin' | 'seed' | 'library';
  /** False when the entry has no usable file/engine on this machine yet. */
  available: boolean;
  durationSec?: number;
  license?: string;
  /** Credit line required by the licence (CC-BY), added to captions automatically. */
  attribution?: string;
  sourceUrl?: string;
  mood?: string;
  bpm?: number;
  /** Path relative to the library root when a file exists. */
  file?: string;
  sizeBytes?: number;
  /** Disabled assets stay in the library but the agent never picks them. */
  enabled?: boolean;
  /** Fonts: family name and the faces installed (file per weight/style). */
  family?: string;
  faces?: { weight: number; style: 'normal' | 'italic'; file: string }[];
  /** Asset Hub index: Vietnamese description and quality 0..1 written by the AI. */
  caption?: string;
  quality?: number;
  indexedAt?: string;
  /** Music: strong-beat times in seconds, sung or not, genre. */
  beats?: number[];
  vocals?: boolean;
  genre?: string;
  /** Footage the owner added to one project (Dựng nhanh "tư liệu"). */
  projectId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DoctorCheck {
  id: string;
  label: string;
  ok: boolean;
  required: boolean;
  detail: string;
  fix?: string;
}

export interface VideoEditAgent {
  id: string;
  name: string;
  /** Raw provider.type from agent.yaml (claude, openai, …). */
  provider: string;
  /** "Claude" / "Codex" / other, for display. */
  engineLabel: string;
  model?: string;
  isDefault: boolean;
}
