/**
 * Facebook Content Studio — the API contract between src/fbstudio/* and the
 * dashboard pages. web/src/lib/fbstudio.ts carries an identical copy of the
 * DTO section; change both together.
 *
 * Conventions: times are unix SECONDS; money is in the ad account currency
 * (plain number, no minor units); percentages are 0–100 numbers (4.3 = 4,3%);
 * per-mille share rate is 0–1000; a value Facebook did not return is null.
 *
 * Endpoints (all behind the dashboard token, mounted by registerFbStudioRoutes):
 *   core      GET  /api/fb/status                         → FbStatusDto
 *             GET  /api/fb/pages                          → { pages: FbPageDto[] }
 *             POST /api/fb/pages/sync                     → { pages: FbPageDto[] }
 *             PATCH /api/fb/pages/:id   FbPageUpdate      → FbPageDto
 *             GET  /api/fb/content?status&page&format&pillar&q&limit&offset → FbContentListDto
 *             POST /api/fb/content      FbContentInput    → FbContentDto
 *             GET  /api/fb/content/:id                    → FbContentDto & { log: FbPublishLogDto[] }
 *             PATCH /api/fb/content/:id FbContentInput    → FbContentDto
 *             DELETE /api/fb/content/:id                  → { ok: true }   (local only; not allowed while publishing)
 *             POST /api/fb/content/:id/approve { scheduledAt?: number } → FbContentDto
 *             POST /api/fb/content/:id/return  { feedback: string }    → FbContentDto
 *             POST /api/fb/content/:id/unschedule         → FbContentDto  (back to 'approved')
 *             POST /api/fb/content/:id/publish-now        → FbContentDto
 *             POST /api/fb/content/:id/delete-remote      → FbContentDto  (FACEBOOK_DELETE_POST, then status 'deleted')
 *             GET  /api/fb/calendar?month=YYYY-MM&page    → { items: FbContentDto[] }
 *             POST /api/fb/agent-chat { message: string; contentIds?: number[] } → { ok: true }
 *                  (forwards to the main agent chat; replies stream on /api/chat/stream)
 *             GET  /api/fb/settings                       → FbSettingsDto
 *             PUT  /api/fb/settings  FbSettingsUpdate     → FbSettingsDto
 *   comments  GET  /api/fb/comments/log?page&kind&limit   → CommentLogDto
 *             GET  /api/fb/comments/rules?page&post       → ReplyRulesDto
 *             PUT  /api/fb/comments/rules { pageId, postId?, config: Partial<ReplyRuleConfig> } → ReplyRulesDto
 *             DELETE /api/fb/comments/rules?page&post     → ReplyRulesDto  (drop a post override)
 *             POST /api/fb/comments/templates  ReplyTemplateInput → ReplyTemplateDto
 *             PATCH /api/fb/comments/templates/:id ReplyTemplateInput → ReplyTemplateDto
 *             DELETE /api/fb/comments/templates/:id       → { ok: true }
 *             POST /api/fb/comments/test { pageId, postId?, text } → RuleTestResult
 *             POST /api/fb/comments/poll-now { pageId }   → { ok: true; fetched: number }
 *             POST /api/fb/comments/:id/retry | /hide | /unhide | /send → CommentLogRowDto
 *                  (/send = send a 'draft' row now)
 *   analytics GET  /api/fb/analytics/channel?page&days=28 → ChannelDashboardDto
 *             GET  /api/fb/analytics/posts?page&days=28&milestone=latest → PostsDashboardDto
 *             GET  /api/fb/analytics/post/:postId         → PostDetailDto
 *             POST /api/fb/analytics/refresh { pageId }   → { ok: true }
 *   ads       GET  /api/fb/ads/accounts                   → { accounts: AdAccountDto[]; connection: ConnStatus }
 *             POST /api/fb/ads/accounts/sync              → { accounts: AdAccountDto[]; connection: ConnStatus }
 *             PATCH /api/fb/ads/accounts/:id AdAccountUpdate → AdAccountDto
 *             GET  /api/fb/ads/dashboard?account&days=7   → AdsDashboardDto
 *             POST /api/fb/ads/recommendations/:id { state: 'done' | 'snoozed' } → { ok: true }
 *             POST /api/fb/ads/refresh { accountId }      → { ok: true }
 *             POST /api/fb/ads/reconnect                  → { redirectUrl: string }  (re-link an EXPIRED metaads connection)
 *             GET  /api/fb/ads/connect                    → { hasAuthConfig, redirectUri, scopes }
 *             POST /api/fb/ads/connect { appId?, appSecret? } → { redirectUrl: string }  (new Meta login)
 *             GET  /api/fb/ads/overview?days=7&fresh=1   → AdsOverviewDto  (every ad account, live)
 *             POST /api/fb/ads/accounts/enable-all { enabled, ids?, resultTypes? } → { accounts: AdAccountDto[] }
 *             GET  /api/fb/ads/breakdowns?account&days     → AdsBreakdownsDto  (age × gender, hour of day; live)
 *             GET  /api/fb/ads/campaigns?days              → AdsCampaignsDto   (campaigns of every tracked account)
 *
 * Errors: { error: string } with 4xx/5xx. 409 for a state conflict (e.g.
 * approving a published post), 503 when Composio is not configured.
 */

// ── DTO section (copied verbatim to web/src/lib/fbstudio.ts) ───────────

export type FbFormat = 'reel' | 'video' | 'photo' | 'album' | 'text' | 'link';
export type FbContentStatus =
  | 'idea' | 'draft' | 'review' | 'approved' | 'scheduled'
  | 'publishing' | 'published' | 'failed' | 'missed' | 'deleted';
export type ConnStatus = 'ACTIVE' | 'EXPIRED' | 'MISSING' | 'UNKNOWN';

export interface FbPillar { name: string; targetPct: number }

export interface FbPageDto {
  id: string;
  name: string;
  enabled: boolean;
  role: string;
  mainKpi: string;
  timezone: string;
  approvalRequired: boolean;
  maxPostsPerDay: number;
  minGapMinutes: number;
  windowStart: string; // 'HH:MM'
  windowEnd: string;
  graceMinutes: number;
  brandVoice: string;
  pillars: FbPillar[];
  writerAgent: string;
  videoAgent: string;
  status: ConnStatus;
  pictureUrl: string;
  followers: number | null;
  syncedAt: number | null;
  stats: {
    postsThisWeek: number;
    scheduledThisWeek: number;
    er28d: number | null;
    aiReplies24h: number;
  };
}

export type FbPageUpdate = Partial<Pick<FbPageDto,
  'enabled' | 'role' | 'mainKpi' | 'timezone' | 'approvalRequired' | 'maxPostsPerDay' | 'minGapMinutes'
  | 'windowStart' | 'windowEnd' | 'graceMinutes' | 'brandVoice' | 'pillars' | 'writerAgent' | 'videoAgent'>>;

export interface FbStatusDto {
  composio: { keyConfigured: boolean; facebook: ConnStatus; metaads: ConnStatus; checkedAt: number | null };
  publisher: { running: boolean; lastTickAt: number | null; next: { contentId: number; title: string; pageName: string; scheduledAt: number } | null };
  comments: { running: boolean; lastPollAt: number | null };
  apiCallsThisHour: number;
  apiBudgetPerHour: number;
}

export interface FbMedia {
  /** Absolute path under the studio media dir. */
  path: string;
  kind: 'video' | 'image';
  durationS?: number;
  width?: number;
  height?: number;
}

export interface FbContentDto {
  id: number;
  pageId: string | null;
  pageName: string | null;
  title: string;
  caption: string;
  format: FbFormat;
  pillar: string;
  hookType: string;
  cta: string;
  campaign: string;
  hooks: string[];
  linkUrl: string;
  media: FbMedia[];
  status: FbContentStatus;
  scheduledAt: number | null;
  publishedAt: number | null;
  fbPostId: string | null;
  permalink: string;
  publishedAs: string;
  attempts: number;
  lastError: string;
  feedback: string;
  /** 'user' or an agent id. */
  source: string;
  origin: 'studio' | 'imported';
  createdAt: number;
  updatedAt: number;
  /** Latest snapshot for published posts. */
  metrics: { reach: number | null; er: number | null; comments: number | null } | null;
}

export interface FbContentListDto {
  items: FbContentDto[];
  total: number;
  counts: Record<FbContentStatus | 'all', number>;
}

export interface FbContentInput {
  pageId?: string | null;
  title?: string;
  caption?: string;
  format?: FbFormat;
  pillar?: string;
  hookType?: string;
  cta?: string;
  campaign?: string;
  hooks?: string[];
  linkUrl?: string;
  media?: FbMedia[];
  status?: FbContentStatus;
  scheduledAt?: number | null;
}

export interface FbPublishLogDto {
  id: number;
  action: string;
  tool: string;
  ok: boolean;
  detail: string;
  durationMs: number;
  createdAt: number;
}

export interface FbSettingsDto {
  composioKeyConfigured: boolean;
  apiBudgetPerHour: number;
  mediaDir: string;
  enabled: boolean;
}

export interface FbSettingsUpdate {
  /** Written to .env; never returned. */
  composioApiKey?: string;
  apiBudgetPerHour?: number;
  enabled?: boolean;
}

// Comments

export type CommentStep = 'spam' | 'complaint' | 'template' | 'agent' | 'skip';
export type CommentStatus = 'new' | 'queued' | 'sent' | 'hidden' | 'human' | 'skipped' | 'reacted' | 'failed' | 'draft';

export interface ReplyRuleConfig {
  enabled: boolean;
  minWords: number;
  questionMark: boolean;
  /** Only call the agent when this person got no reply on the post within N hours; null = always. */
  onlyIfNotRepliedHours: number | null;
  agentId: string;
  skill: string;
  contextPost: boolean;
  contextVoice: boolean;
  /** Path to a FAQ/product file the agent may read; '' = none. */
  contextFaqPath: string;
  /** Number of earlier comments in the thread to include. */
  contextThread: number;
  instructions: string;
  sendMode: 'auto' | 'delay' | 'draft';
  /** For sendMode 'delay': minutes to wait before sending. */
  delayBeforeSendMinutes: number;
  maxPerHour: number;
  delayMinMinutes: number;
  delayMaxMinutes: number;
  maxPerUserPerPost: number;
  hideLinks: boolean;
  spamKeywords: string[];
  complaintKeywords: string[];
  notify: 'telegram' | 'zalo' | 'none';
  pollMinutes: number;
  maxPostAgeDays: number;
}

export interface ReplyTemplateDto {
  id: number;
  pageId: string;
  postId: string | null;
  name: string;
  keywords: string[];
  matchMode: 'exact' | 'contains';
  /** Public reply variants, rotated. {ten} = commenter name. */
  variants: string[];
  /** '' = no private reply. */
  privateText: string;
  enabled: boolean;
  sort: number;
  uses: number;
}

export type ReplyTemplateInput = Partial<Omit<ReplyTemplateDto, 'id' | 'uses'>>;

export interface ReplyRulesDto {
  pageId: string;
  postId: string | null;
  effective: ReplyRuleConfig;
  /** Present when viewing a post: its overrides (null = inherits everything). */
  overrides: Partial<ReplyRuleConfig> | null;
  templates: ReplyTemplateDto[];
  /** Recent posts of the Page, for the per-post picker. */
  posts: { postId: string; title: string; publishedAt: number | null; hasOverride: boolean }[];
  agents: string[];
  skills: string[];
}

export interface RuleTestResult {
  step: CommentStep;
  head: string;
  body: string;
  templateId?: number;
  words: number;
}

export interface CommentLogRowDto {
  id: string;
  pageId: string;
  postId: string;
  postTitle: string;
  authorName: string;
  message: string;
  words: number;
  createdTime: number;
  step: CommentStep | '';
  /** Human label: 'Mẫu "AI"', 'Agent main', 'Lọc spam', 'Chuyển người', 'Bỏ qua'. */
  ruleLabel: string;
  reason: string;
  replyText: string;
  privateText: string;
  privateSent: boolean;
  status: CommentStatus;
  sentAt: number | null;
  error: string;
  permalink: string;
}

export interface CommentLogDto {
  pageId: string;
  autoReplyEnabled: boolean;
  pollMinutes: number;
  lastPollAt: number | null;
  kpis: {
    new24h: number;
    autoReplied24h: number;
    byTemplate24h: number;
    byAgent24h: number;
    hidden24h: number;
    human24h: number;
    medianResponseS: number | null;
  };
  /** 24 hourly buckets, oldest first; hour = hour of day 0–23 in the Page timezone. */
  hourly: { hour: number; template: number; agent: number; other: number }[];
  /** Top topics of the last 7 days. */
  topics: { topic: string; count: number }[];
  counts: { all: number; template: number; agent: number; other: number };
  rows: CommentLogRowDto[];
}

// Analytics

export type PillarVerdict = 'win' | 'promising' | 'good' | 'keep' | 'fix' | 'cut';

export interface ChannelKpi {
  key: 'followers' | 'reach' | 'er' | 'interactions' | 'shareRate' | 'commentsPerPost';
  label: string;
  value: number | null;
  unit: 'count' | 'pct' | 'permille';
  /** Change vs the previous period; unit given by deltaUnit. */
  delta: number | null;
  deltaUnit: 'pct' | 'pt' | 'count';
  /** Net follower change for 'followers', else null. */
  extra: number | null;
  spark: number[];
}

export interface PostRef {
  postId: string;
  title: string;
  format: FbFormat;
  pillar: string;
  publishedAt: number | null;
  er: number | null;
}

export interface ChannelDashboardDto {
  page: { id: string; name: string; role: string; mainKpi: string; followers: number | null; er28d: number | null };
  days: number;
  posts: number;
  kpis: ChannelKpi[];
  reachDaily: { day: string; reach: number | null }[];
  followsDaily: { day: string; newFollows: number | null; unfollows: number | null }[];
  funnel: { key: 'impressions' | 'reach' | 'engaged' | 'actions'; label: string; value: number | null }[];
  mix: { key: 'reaction' | 'comment' | 'share' | 'click'; value: number }[];
  pillars: {
    name: string;
    posts: number;
    postShare: number;
    interactionShare: number;
    index: number | null;
    erMedian: number | null;
    commentsPerPost: number | null;
    sharesPerPost: number | null;
    verdict: PillarVerdict;
  }[];
  winner: string | null;
  formats: { format: FbFormat; posts: number; erMedian: number | null }[];
  /** weekday 0 = Monday … 6 = Sunday; slot 0..5 = 06–09, 09–12, 12–14, 14–18, 18–21, 21–24. */
  heat: { weekday: number; slot: number; er: number | null; posts: number }[];
  top: PostRef[];
  bottom: PostRef[];
  insight: { summary: string[]; actions: string[]; createdAt: number } | null;
  lastSnapshotAt: number | null;
}

export type Milestone = '1h' | '6h' | '24h' | '3d' | '7d' | '28d';

export interface PostsDashboardDto {
  page: { id: string; name: string };
  days: number;
  /** 'latest' = numbers to date (mixed post ages; default, works for imported history). */
  milestone: '24h' | '7d' | '28d' | 'latest';
  kpis: {
    posts: number; postsDelta: number | null;
    reach: number | null; reachDeltaPct: number | null;
    erMedian: number | null; erDeltaPt: number | null;
    comments: number | null; commentsDeltaPct: number | null;
    aiReplyRate: number | null;
  };
  reachDaily: { day: string; reach: number | null; posts: number }[];
  rows: {
    postId: string;
    contentId: number | null;
    title: string;
    format: FbFormat;
    pillar: string;
    source: string;
    publishedAt: number | null;
    reach: number | null;
    er: number | null;
    /** ER ÷ Page median ER at the same milestone. */
    index: number | null;
    comments: number | null;
    shares: number | null;
    avgWatchS: number | null;
  }[];
}

export interface PostDetailDto {
  postId: string;
  title: string;
  format: FbFormat;
  pillar: string;
  publishedAt: number | null;
  permalink: string;
  curve: { milestone: Milestone; reach: number | null }[];
  medianCurve: { milestone: Milestone; reach: number | null }[];
  stats: {
    views3s: number | null;
    avgWatchS: number | null;
    videoLengthS: number | null;
    follows: number | null;
    comments: number | null;
    commentsReplied: number | null;
    shares: number | null;
  };
  note: string | null;
}

// Ads (read-only: the app never changes anything in Meta)

export type AdsAction = 'off_now' | 'off' | 'down' | 'refresh' | 'watch' | 'keep' | 'up' | 'clone';
export type AdsResultType = 'lead' | 'message' | 'purchase' | 'registration';

export interface AdAccountDto {
  id: string;
  name: string;
  currency: string;
  enabled: boolean;
  resultType: AdsResultType;
  targetCpa: number | null;
  monthlyBudget: number | null;
  status: ConnStatus;
  syncedAt: number | null;
}

export type AdAccountUpdate = Partial<Pick<AdAccountDto, 'enabled' | 'resultType' | 'targetCpa' | 'monthlyBudget'>>;

export interface AdsRecommendationDto {
  id: number;
  level: 'campaign' | 'adset' | 'ad';
  objectId: string;
  objectName: string;
  action: AdsAction;
  rule: string;
  reason: string;
  state: 'open' | 'done' | 'snoozed';
}

export interface AdsDashboardDto {
  account: AdAccountDto;
  connection: ConnStatus;
  days: number;
  /** The window shown, account time zone, today included. */
  range: { from: string; to: string };
  /** Offered as a first target when none is set (last 14 days' cost per result); null otherwise. */
  suggestedTargetCpa: number | null;
  lastSnapshotAt: number | null;
  queue: AdsRecommendationDto[];
  /** Money saved per day and results gained per day if the open queue is followed; null when not computable. */
  impact: { savingsPerDay: number | null; extraResultsPerDay: number | null };
  kpis: {
    spend: number; spendPrev: number | null;
    results: number; resultsPrev: number | null;
    cpa: number | null; cpaPrev: number | null;
    purchases: number | null;
    roas: number | null;
    ctr: number | null; ctrPrev: number | null;
    cpm: number | null; cpmPrev: number | null;
    /** Share of monthly budget spent vs share of month elapsed, both 0–100. */
    pacing: { spentPct: number; elapsedPct: number } | null;
    spendToday: number;
    /** Month to date, account time zone. */
    spendMonth: number;
  };
  /** 14 days, oldest first. */
  daily: { day: string; spend: number; cpa: number | null }[];
  tree: {
    level: 'campaign' | 'adset';
    id: string;
    parentId: string | null;
    name: string;
    status: string;
    dailyBudget: number | null;
    spend: number;
    spendToday: number;
    results: number;
    cpa: number | null;
    ctr: number | null;
    cpm: number | null;
    frequency: number | null;
    recommendation: { action: AdsAction; reason: string } | null;
  }[];
  funnel: { key: 'impressions' | 'link_clicks' | 'lp_views' | 'results' | 'purchases'; label: string; value: number | null; note: string }[];
  creatives: {
    adId: string;
    name: string;
    format: string;
    status: string;
    /** Meta CDN thumbnail (expires after a while). */
    thumbnailUrl: string | null;
    spend: number;
    results: number;
    campaignName: string;
    hookRate: number | null;
    holdRate: number | null;
    ctr: number | null;
    ctrChangePct: number | null;
    cpa: number | null;
    frequency: number | null;
    recommendation: { action: AdsAction; reason: string } | null;
  }[];
  placements: { placement: string; spend: number; results: number; cpa: number | null; spendShare: number }[];
  organicCandidates: { postId: string; pageName: string; title: string; format: FbFormat; er: number | null; shares: number | null }[];
}

/** One ad account in the all-accounts overview (live from Meta, cached a few minutes). */
export interface AdsOverviewAccountDto {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  business: { id: string; name: string } | null;
  /** Meta account_status: 1 active, 2 disabled, 3 unsettled, 7 risk review, 8 pending settlement, 9 grace period, 100/101 closing/closed. */
  accountStatus: number | null;
  disableReason: number | null;
  /** Lifetime spend, balance owed and spend cap, in the account currency (null when Meta did not say). */
  amountSpent: number | null;
  balance: number | null;
  spendCap: number | null;
  /** Tracked in depth (hourly snapshot, rules) — the per-account dashboard. */
  enabled: boolean;
  resultType: AdsResultType;
  /** True when the result type was picked from the data because the owner has not set one. */
  resultTypeGuessed: boolean;
  targetCpa: number | null;
  spend: number; spendPrev: number;
  spendToday: number;
  /** Month to date (today included) and the owner's monthly budget, if set. */
  spendMonth: number;
  monthlyBudget: number | null;
  results: number; resultsPrev: number;
  cpa: number | null; cpaPrev: number | null;
  impressions: number;
  linkClicks: number;
  ctr: number | null; ctrPrev: number | null;
  cpm: number | null;
  purchases: number;
  revenue: number;
  roas: number | null;
  /** Daily spend over the window, oldest first (aligned with AdsOverviewDto.days). */
  spark: number[];
  lastSpendDay: string | null;
}

export interface AdsOverviewDto {
  connection: ConnStatus;
  /** Window length and its days (account time zones, ending today), oldest first. */
  window: number;
  days: string[];
  today: string;
  fetchedAt: number;
  /** Totals are in this currency; accounts in other currencies are listed but not summed. */
  currency: string;
  otherCurrencies: string[];
  totals: {
    spend: number; spendPrev: number; spendToday: number; spendMonth: number;
    impressions: number; impressionsPrev: number;
    linkClicks: number; linkClicksPrev: number;
    purchases: number; revenue: number;
    /** Results summed per result type (types are not added together). */
    resultsByType: Partial<Record<AdsResultType, { results: number; resultsPrev: number; spend: number; spendPrev: number }>>;
    activeAccounts: number;
    spendingAccounts: number;
  };
  /** Daily spend per account in `currency`, aligned with `days`. */
  daily: { day: string; total: number; byAccount: Record<string, number> }[];
  businesses: { id: string; name: string; spend: number; spendPrev: number; accounts: number }[];
  accounts: AdsOverviewAccountDto[];
  /** Connections whose listing failed (expired, rate-limited) — their accounts may be missing. */
  warnings: string[];
}

/** Age × gender and hour-of-day split of one account's results (live, cached half an hour). */
export interface AdsBreakdownsDto {
  accountId: string;
  resultType: AdsResultType;
  from: string;
  to: string;
  fetchedAt: number;
  /** Meta's age buckets ('18-24' … '65+') × 'male' | 'female' | 'unknown'. */
  ageGender: { age: string; gender: string; spend: number; impressions: number; linkClicks: number; results: number; cpa: number | null; ctr: number | null }[];
  /** 24 rows, hour 0–23 in the account's time zone. */
  hours: { hour: number; spend: number; impressions: number; linkClicks: number; results: number; cpa: number | null; ctr: number | null }[];
}

/** Every campaign of the tracked accounts, for the all-accounts campaign table. */
export interface AdsCampaignsDto {
  days: number;
  campaigns: {
    accountId: string;
    accountName: string;
    currency: string;
    resultType: AdsResultType;
    targetCpa: number | null;
    id: string;
    name: string;
    status: string;
    dailyBudget: number | null;
    adsets: number;
    spend: number;
    spendToday: number;
    results: number;
    cpa: number | null;
    ctr: number | null;
    cpm: number | null;
    frequency: number | null;
    recommendation: { action: AdsAction; reason: string } | null;
  }[];
  /** Tracked accounts whose data is older than two hours (or never pulled). */
  staleAccounts: string[];
}

// ── End of DTO section ─────────────────────────────────────────────────

/** Default reply rules for a Page that has none stored yet. */
export const DEFAULT_REPLY_RULES: ReplyRuleConfig = {
  enabled: true,
  minWords: 6,
  questionMark: true,
  onlyIfNotRepliedHours: null,
  agentId: 'content-fb',
  skill: 'fb-comment-reply',
  contextPost: true,
  contextVoice: true,
  contextFaqPath: '',
  contextThread: 5,
  instructions: 'Trả lời dưới 50 từ, xưng "mình – bạn". Không nêu giá nếu tài liệu không có. Không hứa giảm giá. Câu hỏi về học phí thì mời nhắn tin.',
  sendMode: 'auto',
  delayBeforeSendMinutes: 10,
  maxPerHour: 30,
  delayMinMinutes: 1,
  delayMaxMinutes: 4,
  maxPerUserPerPost: 2,
  hideLinks: true,
  spamKeywords: ['kiếm tiền online', 'triệu/ngày', 'inbox mình để nhận'],
  complaintKeywords: ['lỗi', 'không vào được', 'hoàn tiền', 'lừa đảo'],
  notify: 'telegram',
  pollMinutes: 5,
  maxPostAgeDays: 7,
};

/** Organic performance rows exchanged by marketing and ads through provides. */
export interface FbAdsOrganicRow {
  post_id: string;
  page_name: string;
  title: string;
  caption: string;
  format: string;
  published_at: number | null;
  reach: number | null;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
}
