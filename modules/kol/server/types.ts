/**
 * KOL Studio contract: the HTTP API (all under /api/kol) and its DTOs.
 *
 * web/src/lib/kol.ts copies the DTO section of this file verbatim. Change both
 * together. Times are unix SECONDS. Money is USD. Every user-facing string the
 * server returns (errors, warnings, notes) is Vietnamese.
 *
 * Spec: docs/plans/kol-studio.md
 */

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

/** GET/POST /api/kol/library/previews: the catalog-photo job (src/kol/library-previews.ts). */
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
  /** A KOL's items that failed in MISS_LIMIT runs: automatic runs skip them (they keep the shared photo). */
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
  /** 0–100 "looks like a real photo" score, when the judge gave one (KOL catalog photos use it as a gate). */
  realism?: number | null;
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

// ── Endpoints ────────────────────────────────────────────────────────
// Errors: { error: string } (Vietnamese) with 4xx/5xx. Uploads stream the raw body
// (no multipart): header `x-file-name` (URI-encoded), size cap 25 MB images / 300 MB video.
//
// STUDIO (src/kol/studio-routes.ts)
// GET    /api/kol/status                                  → KolStatusDto
// GET    /api/kol/settings                                → { settings: KolSettingsDto }
// PUT    /api/kol/settings            Partial<KolSettingsDto> → { settings }
// GET    /api/kol/personas                                → { personas: PersonaSummaryDto[] }
// POST   /api/kol/personas            PersonaInput (name required) → { persona: PersonaDto }
// GET    /api/kol/personas/:id                            → { persona }
// PATCH  /api/kol/personas/:id        PersonaInput        → { persona }
// DELETE /api/kol/personas/:id                            → { ok } (status → archived; files kept)
// POST   /api/kol/personas/:id/refs?kind=&label=  raw image body → { ref: RefDto }
// POST   /api/kol/personas/:id/refs/from-asset { assetId, kind } → { ref }
// PATCH  /api/kol/refs/:refId         { kind?, label?, sort?, isPrimary? } → { ref }
// DELETE /api/kol/refs/:refId                             → { ok }
// GET    /api/kol/media/:area/:id     area = ref|asset|thumb|library|template (Range supported)
// GET    /api/kol/library?kind=&personaId=&gender=        → { items: LibraryItemDto[] }  (global + that persona's; previews for that persona's gender or `gender`)
// POST   /api/kol/library             LibraryItemInput     → { item }
// PATCH  /api/kol/library/:id         Partial<LibraryItemInput> → { item }
// DELETE /api/kol/library/:id                             → { ok } (builtin items cannot be deleted)
// POST   /api/kol/library/:id/image   raw image body       → { item }
// GET    /api/kol/library/previews?model=&personaId=      → { job: PreviewJobDto } (coverage; estimate for the missing ones with ?model; a KOL's own photos with ?personaId)
// POST   /api/kol/library/previews { model, personaId?, kinds?, ids?, force?, skipGivenUp?, limit? } → { job } (starts the background job)
// POST   /api/kol/library/previews/stop                   → { job }
// POST   /api/kol/library/previews/auto { enabled, model?, personaId? | personaIds? } → { job } (continue at night / when idle; several KOLs one after another)
// GET    /api/kol/templates                               → { templates: TemplateDto[] }
// POST   /api/kol/templates?name=&kind=&setId=&position=&notes=  raw image body → { template }
// PATCH  /api/kol/templates/:id       { name?, notes?, tags? } → { template }
// DELETE /api/kol/templates/:id                           → { ok }
// POST   /api/kol/preview             GenerationRequest    → PromptPreviewDto (no spend)
// POST   /api/kol/generations         GenerationRequest    → { generation: GenerationDto } (queued; 402 over cap, 409 kill switch/disabled, 412 no key)
// GET    /api/kol/generations?personaId=&status=&limit=   → { generations }
// GET    /api/kol/generations/:id                         → { generation, assets: AssetDto[] }
// POST   /api/kol/generations/:id/cancel                  → { generation } (queued only; running jobs finish)
// GET    /api/kol/assets?personaId=&status=&kind=&favorite=1&before=&limit= → { assets, nextBefore: number | null }
// PATCH  /api/kol/assets/:id          { status?, favorite?, tags? } → { asset }
// DELETE /api/kol/assets/:id                              → { ok } (removes the file; refused when a post uses it)
// POST   /api/kol/assets/:id/recheck                      → { asset } (re-runs the consistency judge)
// POST   /api/kol/personas/:id/assets/import?status=new|approved&tags=a,b  raw image/video body → { asset }
//        (the owner's existing media; images are judged in a background queue, one at a time)
//
// PUBLISH & GROWTH (src/kol/publish-routes.ts)
// GET    /api/kol/connections                             → { composio: boolean, connections: ConnectionDto[] }
// GET    /api/kol/accounts                                → { accounts: AccountDto[] } (all personas; dashboard audience)
// GET    /api/kol/personas/:id/accounts                   → { accounts: AccountDto[] }
// POST   /api/kol/personas/:id/accounts { platform, connectionId, externalId? } → { account } (identity resolved through Composio)
// PATCH  /api/kol/accounts/:id        AccountInput         → { account }
// DELETE /api/kol/accounts/:id                            → { ok }
// POST   /api/kol/accounts/:id/refresh                    → { account } (followers, picture, status)
// GET    /api/kol/posts?personaId=&status=&from=&to=      → { posts: PostDto[] }
// POST   /api/kol/posts               PostInput & { personaId } → { post }
// GET    /api/kol/posts/:id                               → { post }
// PATCH  /api/kol/posts/:id           PostInput            → { post } (only before 'publishing')
// DELETE /api/kol/posts/:id                               → { ok } (status cancelled; published posts are not deleted from platforms)
// POST   /api/kol/posts/:id/captions  { platforms?: Platform[], instructions? } → { post } (persona brain writes variants)
// POST   /api/kol/posts/:id/submit                        → { post } (→ review)
// POST   /api/kol/posts/:id/approve   { scheduledAt? }     → { post } (→ scheduled when a time is given/kept, else approved)
// POST   /api/kol/posts/:id/return    { feedback }         → { post } (→ draft)
// POST   /api/kol/posts/:id/publish-now                   → { post }
// POST   /api/kol/posts/:id/retry     { targetId }         → { post } (failed/missed target → scheduled now)
// GET    /api/kol/personas/:id/growth?days=30             → GrowthDto
// GET    /api/kol/personas/:id/insights                   → { insights: InsightDto[] }
// POST   /api/kol/personas/:id/strategist                 → { insight } (weekly review, no spend on media)
// POST   /api/kol/personas/:id/autopilot/run              → { insight } (plans and creates posts now)
// GET    /api/kol/radar-ideas?limit=                      → { ideas: RadarIdeaDto[] }
