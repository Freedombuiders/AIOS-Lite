/**
 * KOL Studio — web side of the /api/m/kol contract.
 *
 * The DTO section below MIRRORS src/kol/types.ts verbatim (types only). When the
 * contract changes, copy the section from "── Enums" to just before
 * "── Endpoints" again. Times are unix SECONDS, money is USD.
 *
 * After the DTOs: typed API helpers for every endpoint, the raw-body upload
 * helper, media() for tokenized <img>/<video> URLs, and (re-exported from
 * kol-view.ts) formatters and Vietnamese label maps.
 */
import { apiDelete, apiFetch, apiGet, apiPatch, apiPost, apiPut, tokenizedSseUrl } from '@/lib/api';

export * from './kol-view';

// ── Enums ────────────────────────────────────────────────────────────

export type PersonaStatus = 'draft' | 'active' | 'paused' | 'archived';
export type IdentitySource = 'synthetic' | 'licensed';
export type RefKind = 'anchor' | 'sheet' | 'angle' | 'body' | 'expression' | 'other';
export type LibraryKind = 'outfit' | 'expression' | 'hair' | 'scene' | 'pose' | 'look' | 'effect' | 'camera';
/** Who a library item suits: everyone, or women / men only (the pickers hide the other gender's items). */
export type LibraryGender = 'all' | 'female' | 'male';
export type TemplateKind = 'single' | 'carousel';
export type Aspect = '1:1' | '4:5' | '3:4' | '2:3' | '9:16' | '16:9' | '5:4' | '4:3' | '3:2';
export type Quality = 'draft' | 'standard' | 'high' | 'ultra';
/** Prompt preset for how "real" the photo should look. */
export type RealismPreset = 'iphone-candid' | 'pro-photo' | 'editorial' | 'film-35mm' | 'studio-clean' | 'none';

/** chatgpt = OpenAI image generation through Codex, signed in with the owner's ChatGPT plan (or OPENAI_API_KEY). */
export type ProviderId = 'gemini' | 'chatgpt' | 'fal' | 'higgsfield';
export type ModelKind = 'image' | 'video' | 'lipsync';

export type GenerationKind = 'image' | 'video' | 'speech' | 'lipsync';
/**
 * compose   persona + library slots (+ optional template for composition)
 * recreate  persona placed into a template image (pose/framing/light of the template, never its person)
 * sheet     a 360° character sheet built from the persona's anchors
 * bootstrap first face candidates from the written appearance only (no reference images)
 * freeform  persona refs + the owner's own prompt
 * animate   image asset → video
 * talking   image asset + script → voice (ElevenLabs) → lip-synced video
 */
export type GenerationMode = 'compose' | 'recreate' | 'sheet' | 'bootstrap' | 'freeform' | 'animate' | 'talking';
export type GenerationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export type AssetKind = 'image' | 'video' | 'audio';
export type AssetStatus = 'new' | 'approved' | 'rejected';
export type ConsistencyVerdict = 'pass' | 'warn' | 'fail' | 'skipped';

export type Platform = 'facebook' | 'instagram' | 'tiktok' | 'youtube';
export type PostFormat = 'photo' | 'carousel' | 'reel' | 'video' | 'text';
export type PostStatus =
  | 'idea' | 'draft' | 'review' | 'approved' | 'scheduled'
  | 'publishing' | 'published' | 'partial' | 'failed' | 'cancelled';
export type TargetStatus =
  | 'pending' | 'scheduled' | 'publishing' | 'processing' | 'published' | 'failed' | 'missed' | 'skipped';
export type PostSource = 'owner' | 'autopilot' | 'radar' | 'agent';

// ── Persona ──────────────────────────────────────────────────────────

/** The written identity. It is the text half of the identity lock; the reference images are the other half. */
export interface Appearance {
  gender: string;
  ageRange: string;
  ethnicity: string;
  /** Face shape, jaw, nose, lips, cheekbones. */
  face: string;
  eyes: string;
  skin: string;
  /** Default hair when no hair slot is chosen. */
  hair: string;
  body: string;
  /** Moles, freckles, dimples, tattoos, glasses… things that must always be there. */
  marks: string;
  styleKeywords: string[];
  /** The look the audience recognises (e.g. round glasses + gold hoops). */
  signatureLook: string;
}

export interface Personality {
  traits: string[];
  values: string[];
  backstory: string;
  /** How the persona sounds: e.g. "thân thiện, hài hước, nói như bạn thân". */
  voiceTone: string;
  /** Sentence length, slang, emoji use, pronouns ("mình/bạn"). */
  writingStyle: string;
  catchphrases: string[];
  do: string[];
  dont: string[];
}

export interface Pillar {
  id: string;
  name: string;
  description: string;
  /** Target share of posts, 0–100. */
  share: number;
}

export interface AutopilotConfig {
  enabled: boolean;
  /** Posts per week per platform the planner aims for. */
  postsPerWeek: Partial<Record<Platform, number>>;
  /** How many days ahead the planner keeps filled. 1–14. */
  leadDays: number;
  /** When true (default), autopilot posts stop at 'review' for the owner. When false they go straight to 'scheduled'. */
  requireApproval: boolean;
  /** Images generated per planned post (best one is picked by consistency score). 1–4. */
  imagesPerPost: number;
  /** Generate media automatically for planned posts (spends money). */
  generateMedia: boolean;
  /** Max USD autopilot may spend per week for this persona. */
  weeklyBudgetUsd: number;
}

export interface PersonaSummaryDto {
  id: string;
  name: string;
  handle: string;
  status: PersonaStatus;
  tagline: string;
  niche: string;
  /** Media URL of the primary anchor (or cover asset), null when none yet. */
  avatarUrl: string | null;
  refCount: number;
  assetCount: number;
  platforms: Platform[];
  followers: number | null;
  postsScheduled: number;
  postsPublished30d: number;
  spendMonthUsd: number;
  avgConsistency: number | null;
  autopilot: boolean;
  updatedAt: number;
}

export interface PersonaDto {
  id: string;
  name: string;
  handle: string;
  status: PersonaStatus;
  tagline: string;
  niche: string;
  languages: string[];
  bio: string;
  appearance: Appearance;
  personality: Personality;
  audience: string;
  pillars: Pillar[];
  identitySource: IdentitySource;
  /** Required when identitySource = 'licensed': who the real person is and where their written consent is. */
  consentNote: string;
  /** Appended to every caption (AI disclosure). Never empty for an active persona. */
  disclosureText: string;
  voiceId: string;
  /** Agent id that writes captions and plans ('main', any configured agent), or '@chatgpt' for Codex on the ChatGPT plan. */
  brainAgent: string;
  imageModel: string;
  videoModel: string;
  realismPreset: RealismPreset;
  /** 0–100. Images scoring below are 'fail'; within 15 points below are 'warn'. */
  consistencyThreshold: number;
  autoRejectDrift: boolean;
  monthlyCapUsd: number | null;
  autopilot: AutopilotConfig;
  coverAssetId: string | null;
  refs: RefDto[];
  createdAt: number;
  updatedAt: number;
}

export type PersonaInput = Partial<Omit<PersonaDto, 'id' | 'refs' | 'createdAt' | 'updatedAt'>>;

export interface RefDto {
  id: string;
  personaId: string;
  kind: RefKind;
  label: string;
  url: string;
  width: number | null;
  height: number | null;
  sort: number;
  isPrimary: boolean;
  source: 'upload' | 'generated' | 'asset';
  assetId: string | null;
  createdAt: number;
}

// ── Library & templates ──────────────────────────────────────────────

export interface LibraryItemDto {
  id: string;
  /** null = shared by every persona. */
  personaId: string | null;
  kind: LibraryKind;
  /** Group chip in the picker, e.g. "Gestos & reacciones" → "Cử chỉ & phản ứng". */
  group: string;
  name: string;
  /** English prompt fragment inserted into the generation prompt. */
  prompt: string;
  /** Optional reference image (e.g. a photo of the outfit). Sent to the model with the prompt. */
  imageUrl: string | null;
  /**
   * Display-only catalog photo for the pickers; never sent to a model. Person-based items of every
   * gender have a woman's and a man's version: the list resolves the one for the viewing KOL.
   */
  previewUrl: string | null;
  /** True when previewUrl shows the viewing KOL itself (drawn from its identity pack), not a catalog model. */
  previewIsPersona: boolean;
  gender: LibraryGender;
  tags: string[];
  builtin: boolean;
  sort: number;
}

export type LibraryItemInput = Pick<LibraryItemDto, 'kind' | 'group' | 'name' | 'prompt'> & Partial<Pick<LibraryItemDto, 'personaId' | 'tags' | 'sort' | 'gender'>>;

/** GET/POST /api/m/kol/library/previews: the catalog-photo job (src/kol/library-previews.ts). */
export interface PreviewJobDto {
  running: boolean;
  /** Model of the current or last run. */
  model: string | null;
  total: number;
  done: number;
  failed: number;
  costUsd: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Why the last run stopped early (cap reached, stopped by the owner…), Vietnamese. */
  stopReason: string;
  /** Last few failures: item name and reason, Vietnamese. */
  errors: { name: string; error: string }[];
  /** Items with a catalog photo (or an uploaded reference image) per kind. */
  coverage: Record<string, { withPreview: number; total: number }>;
  /** Missing photos and their price with `model` (when asked). */
  estimate: { model: string; count: number; usd: number | null } | null;
  /** Automatic continuation: at night or when the owner is away, leaving `reserve` ChatGPT images a day. */
  auto: { enabled: boolean; model: string; reserve: number; personaId: string | null; queue: string[] } | null;
  /** The KOL these numbers are about (its own photos), or null for the shared catalog. */
  personaId: string | null;
  /** The KOL the current or last run drew for, or null for the shared catalog. */
  runPersonaId: string | null;
  /** A KOL's items that failed in two runs: automatic runs skip them (they keep the shared photo). */
  gaveUp: { id: string; name: string; error: string }[];
}

export interface TemplateDto {
  id: string;
  name: string;
  kind: TemplateKind;
  /** Carousel templates share a setId and are ordered by position. */
  setId: string | null;
  position: number;
  url: string;
  width: number | null;
  height: number | null;
  notes: string;
  source: 'upload' | 'url' | 'radar';
  sourceUrl: string;
  tags: string[];
  createdAt: number;
}

// ── Providers & generation ───────────────────────────────────────────

export interface ModelInfo {
  id: string;
  provider: ProviderId;
  kind: ModelKind;
  label: string;
  /** Max reference images the model accepts in one call. */
  maxRefs: number;
  aspects: Aspect[];
  qualities: Quality[];
  /** Video only: allowed durations in seconds. */
  durations?: number[];
  /** Video only: can generate native audio. */
  audio?: boolean;
  /** Short Vietnamese price note, e.g. "≈ $0,04/ảnh". */
  priceNote: string;
  /** Best pick for this kind (shown first, used as default). */
  recommended?: boolean;
}

export interface ProviderStatusDto {
  id: ProviderId;
  label: string;
  configured: boolean;
  /** Vietnamese hint when not configured: where to put the key. */
  hint: string;
  models: ModelInfo[];
}

export interface SpendSummaryDto {
  todayUsd: number;
  monthUsd: number;
  dailyCapUsd: number;
  monthlyCapUsd: number;
}

export interface KolStatusDto {
  enabled: boolean;
  providers: ProviderStatusDto[];
  spend: SpendSummaryDto;
  killSwitches: { generate: boolean; publish: boolean };
  queue: { running: number; queued: number };
  composio: boolean;
  /** The identity judge actually in use: settings.judgeModel resolved ('auto' → Gemini when a key exists, else ChatGPT). */
  judge: { configured: boolean; model: string; provider: 'gemini' | 'chatgpt' | null };
  voice: { configured: boolean };
  chatgpt: ChatgptStatusDto;
  /** The Radar module is enabled (ideas panel and link are shown only then). */
  radar: boolean;
}

/** Codex signed in with ChatGPT: images, the identity judge and the '@chatgpt' brain run on the owner's plan. */
export interface ChatgptStatusDto {
  /** chatgpt = `codex login` with a ChatGPT plan (no per-image cost); api-key = OPENAI_API_KEY (billed by OpenAI); none = not signed in. */
  mode: 'chatgpt' | 'api-key' | 'none';
  configured: boolean;
  /** Images generated through ChatGPT today (local day), against settings.chatgptDailyLimit. */
  imagesToday: number;
  dailyLimit: number;
  /** Model that drives Codex for images, judging and '@chatgpt' captions. */
  model: string;
  /** Models the signed-in account advertises (from the Codex model cache), best first. */
  models: string[];
  /** Vietnamese hint when not configured. */
  hint: string;
}

export interface KolSettingsDto {
  enabled: boolean;
  dailyCapUsd: number;
  monthlyCapUsd: number;
  defaultImageModel: string;
  defaultVideoModel: string;
  /** 'auto' (Gemini when GOOGLE_API_KEY exists, else ChatGPT), 'chatgpt', or a Gemini model id such as 'gemini-2.5-flash'. */
  judgeModel: string;
  /** Model id → USD per unit (image, or per second for video). Overrides the built-in table. */
  priceOverrides: Record<string, number>;
  publishEnabled: boolean;
  autopilotEnabled: boolean;
  /** API-provider generations running at once (Gemini, fal, Higgsfield), 1–4; video weighs 2. */
  concurrency: number;
  /** Max images per local day through ChatGPT (protects the plan's usage limits). 0 = no limit. */
  chatgptDailyLimit: number;
  /** ChatGPT image turns running at once, 1–6 (separate from `concurrency`, which covers the API providers). */
  chatgptParallel: number;
  /** Codex model for ChatGPT images, the ChatGPT judge and the '@chatgpt' brain (e.g. 'gpt-5.6-luna'). */
  codexModel: string;
}

/** The library picks of a compose/recreate request. Every field is optional. */
export interface Selection {
  outfitId?: string;
  expressionId?: string;
  hairId?: string;
  sceneId?: string;
  poseId?: string;
  lookId?: string;
  effectId?: string;
  cameraId?: string;
  /** Camera setup: one item per axis (lens, shot size, angle, movement), joined in this order. Combined with cameraId. */
  cameraIds?: string[];
  templateId?: string;
  /** animate / talking: the source image asset. */
  sourceAssetId?: string;
  realism?: RealismPreset;
}

export interface GenerationParams {
  model?: string;
  aspect?: Aspect;
  quality?: Quality;
  /** Images per request, 1–4. */
  count?: number;
  seed?: number;
  /** Extra direction in the owner's words (any language). */
  extraPrompt?: string;
  /** Video */
  durationSec?: number;
  audio?: boolean;
  /** Talking: the script to speak. */
  script?: string;
}

export interface GenerationRequest {
  personaId: string;
  mode: GenerationMode;
  selection?: Selection;
  params?: GenerationParams;
  /** Replaces the composed prompt entirely (advanced). The identity refs are still attached. */
  promptOverride?: string;
  /** Link to the post this media is for. */
  postId?: string;
}

export interface RefRoleDto {
  /** 1-based position in the request, as the prompt names it ("image 2"). */
  index: number;
  role: 'composition' | 'identity' | 'sheet' | 'outfit' | 'hair' | 'scene' | 'source';
  label: string;
  url: string | null;
}

export interface PromptPreviewDto {
  prompt: string;
  refs: RefRoleDto[];
  model: ModelInfo | null;
  estimateUsd: number;
  /** Vietnamese warnings: too many refs for the model, no anchor yet, aspect not allowed on Instagram feed… */
  warnings: string[];
  /** Vietnamese notes on expected behaviour (which identity images were sent, how a template is used). */
  notes: string[];
}

export interface GenerationDto {
  id: string;
  personaId: string;
  kind: GenerationKind;
  mode: GenerationMode;
  status: GenerationStatus;
  provider: ProviderId;
  model: string;
  params: GenerationParams;
  selection: Selection;
  prompt: string;
  refs: RefRoleDto[];
  estimateUsd: number;
  costUsd: number;
  error: string;
  requestedBy: string;
  postId: string | null;
  assetIds: string[];
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface ConsistencyDto {
  score: number | null;
  verdict: ConsistencyVerdict | null;
  notes: string;
}

export interface AssetDto {
  id: string;
  personaId: string;
  generationId: string | null;
  kind: AssetKind;
  url: string;
  thumbUrl: string | null;
  mime: string;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  bytes: number;
  status: AssetStatus;
  favorite: boolean;
  consistency: ConsistencyDto;
  model: string;
  provider: string;
  costUsd: number;
  prompt: string;
  tags: string[];
  createdAt: number;
}

// ── Channels & posts ─────────────────────────────────────────────────

export interface ConnectionDto {
  id: string;
  toolkit: Platform;
  status: string;
  alias: string | null;
}

export interface AccountDto {
  id: string;
  personaId: string;
  platform: Platform;
  connectionId: string;
  /** Page id, ig_user_id, YouTube channel id or TikTok open_id. */
  externalId: string;
  handle: string;
  displayName: string;
  pictureUrl: string;
  enabled: boolean;
  /** When true, approved posts publish without a second owner check at publish time. */
  autoPublish: boolean;
  maxPostsPerDay: number;
  minGapMinutes: number;
  windowStart: string;
  windowEnd: string;
  timezone: string;
  tiktokPrivacy: string;
  youtubePrivacy: 'public' | 'unlisted' | 'private';
  youtubeCategory: string;
  status: 'ACTIVE' | 'EXPIRED' | 'ERROR';
  followers: number | null;
  followersAt: number | null;
  /** Other KOLs linked to the same channel; posting rules count their posts too. */
  sharedWith: string[];
}

export type AccountInput = Partial<Omit<AccountDto, 'id' | 'personaId' | 'platform' | 'status' | 'followers' | 'followersAt' | 'sharedWith'>>;

export interface PlatformVariant {
  caption: string;
  /** YouTube title (≤ 100 chars). */
  title?: string;
  hashtags?: string[];
}

export interface PostTargetDto {
  id: string;
  accountId: string;
  platform: Platform;
  handle: string;
  status: TargetStatus;
  externalId: string | null;
  permalink: string;
  error: string;
  attempts: number;
  publishedAt: number | null;
  metrics: PostMetricsDto | null;
}

export interface PostMetricsDto {
  capturedAt: number;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reach: number | null;
}

export interface PostDto {
  id: string;
  personaId: string;
  title: string;
  pillar: string;
  format: PostFormat;
  /** Master caption; platform variants override it. The disclosure is appended at publish time, not stored here. */
  caption: string;
  hashtags: string[];
  variants: Partial<Record<Platform, PlatformVariant>>;
  assetIds: string[];
  assets: AssetDto[];
  status: PostStatus;
  scheduledAt: number | null;
  publishedAt: number | null;
  /** What the strategist asked for (for autopilot / radar posts). */
  brief: string;
  source: PostSource;
  sourceRef: string;
  feedback: string;
  targets: PostTargetDto[];
  createdAt: number;
  updatedAt: number;
}

export type PostInput = Partial<Pick<PostDto, 'title' | 'pillar' | 'format' | 'caption' | 'hashtags' | 'variants' | 'assetIds' | 'brief' | 'scheduledAt'>> & {
  /** Accounts this post goes to. Replaces the current target list (published targets are kept). */
  accountIds?: string[];
};

// ── Growth ───────────────────────────────────────────────────────────

export interface GrowthDto {
  days: number;
  accounts: { id: string; platform: Platform; handle: string; followers: number | null; series: { day: string; followers: number }[] }[];
  totals: { posts: number; views: number; likes: number; comments: number; shares: number; engagementRate: number | null };
  topPosts: { postId: string; title: string; platform: Platform; permalink: string; views: number | null; likes: number | null; comments: number | null; thumbUrl: string | null }[];
  pillars: { pillar: string; posts: number; avgEngagement: number | null }[];
  /** Local hour (0–23) → average engagement of posts published then. */
  hours: { hour: number; posts: number; avgEngagement: number | null }[];
  spend: { day: string; usd: number }[];
}

export interface InsightDto {
  id: string;
  personaId: string;
  kind: 'weekly' | 'plan';
  periodStart: number;
  /** Vietnamese Markdown for the owner. */
  summary: string;
  /** Planned ideas (kind 'plan'), already turned into posts when postIds is set. */
  ideas: { title: string; pillar: string; format: PostFormat; platforms: Platform[]; brief: string; caption: string; selection: Selection; when: string }[];
  postIds: string[];
  createdAt: number;
}

export interface RadarIdeaDto {
  key: string;
  day: string;
  layer: string;
  title: string;
  detail: string;
  url: string;
}


// ════════════════════════════════════════════════════════════════════
// Web-only: API helpers (not part of the mirrored contract)
// ════════════════════════════════════════════════════════════════════

type QueryValue = string | number | boolean | null | undefined;

/** "?a=1&b=x" from the defined, non-empty values ('' when nothing is left). */
export function qs(params: Record<string, QueryValue>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    q.set(k, v === true ? '1' : String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;

/** Media URL with the dashboard token, for every <img>/<video> src of /api/kol/media/... */
export function media(url: string | null | undefined): string {
  // The server hands out /api/kol/... urls; the module is mounted at /api/m/kol.
  return url ? tokenizedSseUrl(url.replace(/^\/api\/kol\//, '/api/m/kol/')) : '';
}

/**
 * Raw-body upload (no multipart): header `x-file-name` (URI-encoded), the
 * file's content type, extra fields as query params. Errors throw ApiError
 * with the server's Vietnamese `{ error }`.
 */
export async function kolUpload<T>(path: string, file: File | Blob, params: Record<string, QueryValue> = {}, fileName?: string): Promise<T> {
  const name = fileName ?? (file instanceof File ? file.name : 'upload');
  const res = await apiFetch(`${path}${qs(params)}`, {
    method: 'POST',
    headers: {
      'x-file-name': encodeURIComponent(name),
      'content-type': file.type || 'application/octet-stream',
    },
    body: file,
  });
  return res.json() as Promise<T>;
}

/** GET paths used with useFetch, so cache keys (and invalidateFetchCache prefixes) stay consistent. */
export const KOL = {
  status: '/api/m/kol/status',
  settings: '/api/m/kol/settings',
  personas: '/api/m/kol/personas',
  persona: (id: string) => `/api/m/kol/personas/${enc(id)}`,
  library: (p: { kind?: LibraryKind; personaId?: string; gender?: 'female' | 'male' | '' } = {}) => `/api/m/kol/library${qs(p)}`,
  libraryPreviews: (model?: string, personaId?: string) => `/api/m/kol/library/previews${qs({ model, personaId })}`,
  templates: '/api/m/kol/templates',
  generations: (p: { personaId?: string; status?: string; limit?: number } = {}) => `/api/m/kol/generations${qs(p)}`,
  generation: (id: string) => `/api/m/kol/generations/${enc(id)}`,
  assets: (p: { personaId?: string; status?: AssetStatus | ''; kind?: AssetKind | ''; favorite?: boolean; before?: number | null; limit?: number } = {}) => `/api/m/kol/assets${qs(p)}`,
  connections: '/api/m/kol/connections',
  accounts: (personaId: string) => `/api/m/kol/personas/${enc(personaId)}/accounts`,
  posts: (p: { personaId?: string; status?: string; from?: number; to?: number } = {}) => `/api/m/kol/posts${qs(p)}`,
  post: (id: string) => `/api/m/kol/posts/${enc(id)}`,
  growth: (personaId: string, days: number) => `/api/m/kol/personas/${enc(personaId)}/growth${qs({ days })}`,
  insights: (personaId: string) => `/api/m/kol/personas/${enc(personaId)}/insights`,
  radarIdeas: (limit = 12) => `/api/m/kol/radar-ideas${qs({ limit })}`,
} as const;

type Ok = { ok: boolean };

export const kolApi = {
  // ── Studio
  status: () => apiGet<KolStatusDto>(KOL.status),
  settings: () => apiGet<{ settings: KolSettingsDto }>(KOL.settings),
  saveSettings: (patch: Partial<KolSettingsDto>) => apiPut<{ settings: KolSettingsDto }>(KOL.settings, patch),

  personas: () => apiGet<{ personas: PersonaSummaryDto[] }>(KOL.personas),
  createPersona: (input: PersonaInput) => apiPost<{ persona: PersonaDto }>(KOL.personas, input),
  persona: (id: string) => apiGet<{ persona: PersonaDto }>(KOL.persona(id)),
  updatePersona: (id: string, input: PersonaInput) => apiPatch<{ persona: PersonaDto }>(KOL.persona(id), input),
  archivePersona: (id: string) => apiDelete<Ok>(KOL.persona(id)),

  importAsset: (personaId: string, file: File, p: { status?: 'new' | 'approved'; tags?: string } = {}) =>
    kolUpload<{ asset: AssetDto }>(`/api/m/kol/personas/${enc(personaId)}/assets/import`, file, p),
  uploadRef: (personaId: string, file: File, p: { kind?: RefKind; label?: string } = {}) =>
    kolUpload<{ ref: RefDto }>(`/api/m/kol/personas/${enc(personaId)}/refs`, file, p),
  refFromAsset: (personaId: string, assetId: string, kind: RefKind) =>
    apiPost<{ ref: RefDto }>(`/api/m/kol/personas/${enc(personaId)}/refs/from-asset`, { assetId, kind }),
  updateRef: (refId: string, patch: { kind?: RefKind; label?: string; sort?: number; isPrimary?: boolean }) =>
    apiPatch<{ ref: RefDto }>(`/api/m/kol/refs/${enc(refId)}`, patch),
  deleteRef: (refId: string) => apiDelete<Ok>(`/api/m/kol/refs/${enc(refId)}`),

  library: (p: { kind?: LibraryKind; personaId?: string } = {}) => apiGet<{ items: LibraryItemDto[] }>(KOL.library(p)),
  createLibraryItem: (input: LibraryItemInput) => apiPost<{ item: LibraryItemDto }>('/api/m/kol/library', input),
  updateLibraryItem: (id: string, patch: Partial<LibraryItemInput>) => apiPatch<{ item: LibraryItemDto }>(`/api/m/kol/library/${enc(id)}`, patch),
  deleteLibraryItem: (id: string) => apiDelete<Ok>(`/api/m/kol/library/${enc(id)}`),
  uploadLibraryImage: (id: string, file: File) => kolUpload<{ item: LibraryItemDto }>(`/api/m/kol/library/${enc(id)}/image`, file),
  previewJob: (model?: string, personaId?: string) => apiGet<{ job: PreviewJobDto }>(KOL.libraryPreviews(model, personaId)),
  startPreviews: (body: { model: string; personaId?: string; kinds?: LibraryKind[]; ids?: string[]; force?: boolean; limit?: number }) =>
    apiPost<{ job: PreviewJobDto }>('/api/m/kol/library/previews', body),
  stopPreviews: () => apiPost<{ job: PreviewJobDto }>('/api/m/kol/library/previews/stop'),
  setPreviewAuto: (body: { enabled: boolean; model?: string; personaId?: string | null; personaIds?: string[] }) => apiPost<{ job: PreviewJobDto }>('/api/m/kol/library/previews/auto', body),

  templates: () => apiGet<{ templates: TemplateDto[] }>(KOL.templates),
  uploadTemplate: (file: File, p: { name?: string; kind?: TemplateKind; setId?: string; position?: number; notes?: string } = {}) =>
    kolUpload<{ template: TemplateDto }>('/api/m/kol/templates', file, p),
  updateTemplate: (id: string, patch: { name?: string; notes?: string; tags?: string[] }) =>
    apiPatch<{ template: TemplateDto }>(`/api/m/kol/templates/${enc(id)}`, patch),
  deleteTemplate: (id: string) => apiDelete<Ok>(`/api/m/kol/templates/${enc(id)}`),

  preview: (req: GenerationRequest) => apiPost<PromptPreviewDto>('/api/m/kol/preview', req),
  generate: (req: GenerationRequest) => apiPost<{ generation: GenerationDto }>('/api/m/kol/generations', req),
  generations: (p: { personaId?: string; status?: string; limit?: number } = {}) => apiGet<{ generations: GenerationDto[] }>(KOL.generations(p)),
  generation: (id: string) => apiGet<{ generation: GenerationDto; assets: AssetDto[] }>(KOL.generation(id)),
  cancelGeneration: (id: string) => apiPost<{ generation: GenerationDto }>(`/api/m/kol/generations/${enc(id)}/cancel`),

  assets: (p: Parameters<typeof KOL.assets>[0] = {}) => apiGet<{ assets: AssetDto[]; nextBefore: number | null }>(KOL.assets(p)),
  updateAsset: (id: string, patch: { status?: AssetStatus; favorite?: boolean; tags?: string[] }) =>
    apiPatch<{ asset: AssetDto }>(`/api/m/kol/assets/${enc(id)}`, patch),
  deleteAsset: (id: string) => apiDelete<Ok>(`/api/m/kol/assets/${enc(id)}`),
  recheckAsset: (id: string) => apiPost<{ asset: AssetDto }>(`/api/m/kol/assets/${enc(id)}/recheck`),

  // ── Publish & growth
  connections: () => apiGet<{ composio: boolean; connections: ConnectionDto[] }>(KOL.connections),
  accounts: (personaId: string) => apiGet<{ accounts: AccountDto[] }>(KOL.accounts(personaId)),
  linkAccount: (personaId: string, body: { platform: Platform; connectionId: string; externalId?: string }) =>
    apiPost<{ account: AccountDto }>(KOL.accounts(personaId), body),
  updateAccount: (id: string, patch: AccountInput) => apiPatch<{ account: AccountDto }>(`/api/m/kol/accounts/${enc(id)}`, patch),
  deleteAccount: (id: string) => apiDelete<Ok>(`/api/m/kol/accounts/${enc(id)}`),
  refreshAccount: (id: string) => apiPost<{ account: AccountDto }>(`/api/m/kol/accounts/${enc(id)}/refresh`),

  posts: (p: { personaId?: string; status?: string; from?: number; to?: number } = {}) => apiGet<{ posts: PostDto[] }>(KOL.posts(p)),
  createPost: (personaId: string, input: PostInput) => apiPost<{ post: PostDto }>('/api/m/kol/posts', { ...input, personaId }),
  post: (id: string) => apiGet<{ post: PostDto }>(KOL.post(id)),
  updatePost: (id: string, input: PostInput) => apiPatch<{ post: PostDto }>(KOL.post(id), input),
  cancelPost: (id: string) => apiDelete<Ok>(KOL.post(id)),
  writeCaptions: (id: string, body: { platforms?: Platform[]; instructions?: string } = {}) =>
    apiPost<{ post: PostDto }>(`/api/m/kol/posts/${enc(id)}/captions`, body),
  submitPost: (id: string) => apiPost<{ post: PostDto }>(`/api/m/kol/posts/${enc(id)}/submit`),
  approvePost: (id: string, scheduledAt?: number | null) =>
    apiPost<{ post: PostDto }>(`/api/m/kol/posts/${enc(id)}/approve`, scheduledAt ? { scheduledAt } : {}),
  returnPost: (id: string, feedback: string) => apiPost<{ post: PostDto }>(`/api/m/kol/posts/${enc(id)}/return`, { feedback }),
  publishNow: (id: string) => apiPost<{ post: PostDto }>(`/api/m/kol/posts/${enc(id)}/publish-now`),
  retryTarget: (id: string, targetId: string) => apiPost<{ post: PostDto }>(`/api/m/kol/posts/${enc(id)}/retry`, { targetId }),

  growth: (personaId: string, days: number) => apiGet<GrowthDto>(KOL.growth(personaId, days)),
  insights: (personaId: string) => apiGet<{ insights: InsightDto[] }>(KOL.insights(personaId)),
  runStrategist: (personaId: string) => apiPost<{ insight: InsightDto }>(`/api/m/kol/personas/${enc(personaId)}/strategist`),
  runAutopilot: (personaId: string) => apiPost<{ insight: InsightDto }>(`/api/m/kol/personas/${enc(personaId)}/autopilot/run`),
  radarIdeas: (limit = 12) => apiGet<{ ideas: RadarIdeaDto[] }>(KOL.radarIdeas(limit)),
};
