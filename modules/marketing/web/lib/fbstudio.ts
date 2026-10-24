import type { SocialPlatform } from '@/lib/social-platforms';
/**
 * Facebook Content Studio — client side of the /api/m/marketing/* contract.
 * The DTO section is a verbatim copy of src/fbstudio/types.ts.
 */

// ── DTO section (verbatim copy of src/fbstudio/types.ts — change both) ──

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
  /** Absent today (all content is Facebook); the calendar reads a missing value as 'facebook'. */
  platform?: SocialPlatform;
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
  ttlMs: number;
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

// ── End of DTO section ─────────────────────────────────────────────────

/** Format identity colours (validated categorical palette, dark surface). Always shown with a text label. */
export const FORMAT_META: Record<FbFormat, { label: string; color: string }> = {
  reel: { label: 'Reel', color: '#3987e5' },
  video: { label: 'Video dài', color: '#d95926' },
  photo: { label: 'Ảnh', color: '#199e70' },
  album: { label: 'Album', color: '#c98500' },
  text: { label: 'Chữ', color: '#d55181' },
  link: { label: 'Link', color: '#008300' },
};

export const STATUS_META: Record<FbContentStatus, { label: string; bg: string; fg: string }> = {
  idea: { label: 'Ý tưởng', bg: 'var(--color-elevated)', fg: 'var(--color-text-muted)' },
  draft: { label: 'Bản nháp', bg: 'rgba(251, 191, 36, 0.14)', fg: '#fcd34d' },
  review: { label: 'Chờ duyệt', bg: 'var(--color-accent-soft)', fg: 'var(--color-accent-hover)' },
  approved: { label: 'Đã duyệt', bg: 'rgba(124, 196, 255, 0.10)', fg: '#a9d8ff' },
  scheduled: { label: 'Đã lên lịch', bg: 'rgba(124, 196, 255, 0.14)', fg: '#a9d8ff' },
  publishing: { label: 'Đang đăng', bg: 'rgba(124, 196, 255, 0.14)', fg: '#a9d8ff' },
  published: { label: 'Đã đăng', bg: 'rgba(74, 222, 128, 0.14)', fg: '#86efac' },
  failed: { label: 'Lỗi', bg: 'rgba(248, 113, 113, 0.14)', fg: '#fca5a5' },
  missed: { label: 'Lỡ giờ', bg: 'rgba(248, 113, 113, 0.14)', fg: '#fca5a5' },
  deleted: { label: 'Đã xóa', bg: 'var(--color-elevated)', fg: 'var(--color-text-faint)' },
};

/** Vietnamese number formatting: 1.284 · 4,3 · 18,2 N · 45,3 tr. */
export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return Math.round(n).toLocaleString('vi-VN');
}

export function fmtDec(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return n.toFixed(digits).replace('.', ',');
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '–' : `${fmtDec(n, digits)}%`;
}

/** Compact count: 312 N for thousands, 1,2 tr for millions. */
export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${fmtDec(n / 1_000_000, a >= 10_000_000 ? 0 : 1)} tr`;
  if (a >= 100_000) return `${Math.round(n / 1000)} N`;
  if (a >= 1000) return `${fmtDec(n / 1000, 1)} N`;
  return fmtInt(n);
}

/** Money in the account currency, compact for VND (45,3 tr ₫ / 110k ₫). */
export function fmtMoney(n: number | null | undefined, currency = 'VND'): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  if (currency === 'VND') {
    if (Math.abs(n) >= 1_000_000) return `${fmtDec(n / 1_000_000, 1)} tr ₫`;
    if (Math.abs(n) >= 1000) return `${Math.round(n / 1000)}k ₫`;
    return `${fmtInt(n)} ₫`;
  }
  return `${fmtDec(n, 2)} ${currency}`;
}

const WEEKDAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

/** "T6 9/10 · 19:30" in the browser timezone. */
export function fmtSlot(sec: number | null | undefined): string {
  if (!sec) return '–';
  const d = new Date(sec * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} · ${hh}:${mm}`;
}
