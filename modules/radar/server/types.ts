/**
 * Radar — daily market-research scans of communities (Facebook groups and
 * pages, Meta Ad Library, X via the grok CLI, Reddit, Hacker News, YouTube,
 * TikTok, Threads, news) turned into "only what is new" reports.
 *
 * Shared contract between the four parts of the module:
 *   collectors/  RawItem[]            (fetch, no LLM)
 *   pipeline     RawItem[] → ReportPayload (ledger, keyword tags, LLM analysis)
 *   render/      ReportPayload → standalone HTML documents
 *   routes/web   JSON + HTML over /api/radar/*
 *
 * Everything the owner reads is Vietnamese. Dates are local (Asia/Ho_Chi_Minh by default).
 */

// ── Layers ──────────────────────────────────────────────────────────────

/** vn = AI trong nước (07:00), world = Thế giới (12:00), nganh = Ngành nghề (20:00). */
export type LayerKey = 'vn' | 'world' | 'nganh';
export const LAYER_KEYS: readonly LayerKey[] = ['vn', 'world', 'nganh'];

export type SourceKind =
  | 'fb_group' | 'fb_page' | 'ad' | 'instagram'
  | 'x' | 'reddit' | 'hn' | 'youtube' | 'tiktok' | 'threads' | 'github' | 'news';

/** How a source was read; shown in data notes and the settings screen. */
export type SourceVia = 'apify' | 'grok' | 'browser' | 'rss' | 'api' | 'rsshub';

// ── Config (stored as JSON in dashboard_settings 'radar.config') ────────

export interface TopicDef {
  key: string;
  /** Row label in the heatmap, e.g. "Chi phí, mua tài khoản". */
  label: string;
  /** Lowercase keywords matched against title + text (accent-insensitive). */
  keywords: string[];
}

export interface FbGroupSource {
  name: string;
  url: string;
  members?: number;
  /** nganh layer: which profession the group stands for ("Giáo viên"). */
  profession?: string;
  /** auto = RSSHub first (when running), then Apify, then the logged-in browser (private group). */
  mode?: 'auto' | 'rsshub' | 'apify' | 'browser';
  enabled?: boolean;
}

export interface FbPageSource { name: string; url: string; enabled?: boolean }

export interface LayerConfig {
  key: LayerKey;
  label: string;
  /** Local HH:MM the daily scan starts. */
  time: string;
  enabled: boolean;
  /** Card description on the index page. */
  description: string;
  fbGroups: FbGroupSource[];
  /** Competitor fanpages. */
  fbPages: FbPageSource[];
  /** Instagram handles without @ (competitors, creators). */
  instagram: string[];
  /** Meta Ad Library: active ads in `country` for each query and each page URL. */
  adLibrary: { enabled: boolean; country: string; queries: string[]; pageUrls: string[] };
  /** X through the grok CLI: recent posts of these accounts and searches. */
  x: { enabled: boolean; accounts: string[]; queries: string[]; /** world: also ask what Vietnamese X already discusses. */ vnCheck: boolean };
  reddit: { enabled: boolean; subreddits: string[] };
  hackerNews: { enabled: boolean; minPoints: number };
  youtube: { enabled: boolean; channels: { name: string; channelId: string }[] };
  /** queries: keyword search (Apify); accounts: usernames read through RSSHub. */
  tiktok: { enabled: boolean; queries: string[]; accounts: string[] };
  /** queries: keyword search (RSSHub, Apify fallback); accounts: usernames read through RSSHub. */
  threads: { enabled: boolean; queries: string[]; accounts: string[] };
  github: { enabled: boolean; queries: string[] };
  news: { enabled: boolean; rss: string[] };
  /** nganh: the professions shown on the profession map (also "Chưa thấy bài về AI ở: …"). */
  professions: string[];
  /** nganh: keep only posts whose title/text/comments mention an AI keyword. */
  aiOnly: boolean;
  topics: TopicDef[];
  /** Scan window; the first scan of a layer (empty ledger) uses firstWindowHours. */
  windowHours: number;
  firstWindowHours: number;
  /** Cap per source (posts per group, ads per query, …). */
  maxPerSource: number;
  /** How many of the most-commented posts get their comments read. */
  commentPosts: number;
}

export interface RadarConfig {
  version: 1;
  /** Master switch for the scheduler. Off until the owner turns it on. Manual runs work either way. */
  enabled: boolean;
  timezone: string;
  owner: {
    /** Short name used in "Ý tưởng cho …", "Khoảng trống cho …". */
    name: string;
    /** Products/channels an idea can be filed under ("Ebook AI Thực Chiến", "Kênh TikTok", "Mọi kênh"). */
    channels: string[];
    /** One paragraph about what the owner sells and to whom; given to the analyst. */
    about: string;
  };
  /** Agent whose provider/model runs the analysis turns ('main' by default). */
  analysisAgentId: string;
  aiKeywords: string[];
  /** Comment keywords → buy-signal type. */
  buyKeywords: { intent: string[]; price: string[]; material: string[] };
  layers: Record<LayerKey, LayerConfig>;
}

// ── Collected data ──────────────────────────────────────────────────────

export interface Metrics {
  comments?: number;
  reactions?: number;
  shares?: number;
  views?: number;
  likes?: number;
  reposts?: number;
  quotes?: number;
  replies?: number;
  saves?: number;
  /** Hacker News points / Reddit upvotes. */
  points?: number;
  stars?: number;
}

export interface RawComment {
  text: string;
  author?: string;
  url?: string;
  likes?: number;
  postedAt?: string;
}

export interface AdDetails {
  adArchiveId: string;
  pageName: string;
  pageUrl?: string;
  pageId?: string;
  /** ISO dates. */
  startDate?: string;
  endDate?: string;
  isActive?: boolean;
  /** Ad Library "N ads use this creative" (collationCount). */
  versions?: number;
  ctaText?: string;
  ctaType?: string;
  landingUrl?: string;
  /** IMAGE | VIDEO | CAROUSEL | DCO | … as Apify reports it. */
  displayFormat?: string;
  bodyText?: string;
  title?: string;
  linkDescription?: string;
  /** https://www.facebook.com/ads/library/?id=<adArchiveId> */
  libraryUrl: string;
}

export interface RawItem {
  /** Stable id: first 16 hex chars of sha1(canonical url). Use itemIdFor(). */
  id: string;
  layer: LayerKey;
  kind: SourceKind;
  /** Column/community name: group or page name, "r/LocalLLaMA", "@bcherny", "Hacker News", "TikTok", "Báo chí, web". */
  sourceName: string;
  sourceUrl?: string;
  url: string;
  author?: string;
  /** Native title when the platform has one (HN, Reddit, YouTube, news). */
  title?: string;
  /** Native body, whitespace-collapsed, at most 4000 chars. */
  text: string;
  /** ISO 8601 when known. */
  postedAt?: string;
  /** What the platform showed when no exact time is known ("1 ngày", "6 giờ"). */
  postedText?: string;
  metrics: Metrics;
  /** Top comments (as many as the source returned, at most ~50). */
  comments: RawComment[];
  media?: 'text' | 'image' | 'video' | 'album' | 'link';
  ad?: AdDetails;
  via: SourceVia;
}

export interface SourceStat {
  kind: SourceKind;
  name: string;
  url?: string;
  via: SourceVia;
  ok: boolean;
  count: number;
  /** Safe to show (never contains tokens). */
  error?: string;
  members?: number;
  followers?: number;
  activeAds?: number;
}

export interface CollectResult {
  items: RawItem[];
  sources: SourceStat[];
  /** Vietnamese, one line each, for "Ghi chú về dữ liệu". */
  notes: string[];
  /** Apify cost reported by the runs, when known. */
  costUsd: number;
}

/** What Vietnamese X already talks about (world layer, grok CLI). */
export interface VnChatter {
  topics: { topic: string; posts: number; examples: string[] }[];
  note?: string;
}

// ── Report payload (pipeline → renderer) ────────────────────────────────

/** Buy-signal comment type: Ý định mua / Hỏi giá / Xin tài liệu. */
export type BuyType = 'intent' | 'price' | 'material';

export interface AdView {
  adArchiveId: string;
  advertiser: string;
  pageUrl?: string;
  libraryUrl: string;
  /** "Khóa AI tài chính kế toán". */
  product: string;
  /** Short quote of the ad's hook ("DỪNG NGAY VIỆC LÀM THỦ CÔNG!"). */
  headline: string;
  funnel: 'zoom' | 'form' | 'messenger' | 'comment' | 'web' | 'unknown';
  /** "Zoom free" | "Google Form" | "Messenger" | "Comment" | "Web" | "Không rõ". */
  funnelLabel: string;
  /** "Ảnh, carousel" | "Video" | "Không ghi". */
  format: string;
  /** Target profession/audience tag when clear ("Kế toán, tài chính"). */
  audience?: string;
  startDate?: string;
  daysRunning: number;
  versions?: number;
  /** "Không công khai" | "Miễn phí" | "1 triệu". */
  price: string;
  /** CTA as shown, or "Không ghi". */
  cta: string;
  /** Landing page host(s) or "Messenger". */
  landing: string;
  segment: 'enterprise' | 'profession' | 'mass';
  priceModel: 'free' | 'hidden' | 'public';
  sellsBook: boolean;
  /** Other ad ids of the same advertiser seen in this scan. */
  otherAdIds: string[];
}

export interface ItemView {
  id: string;
  kind: SourceKind;
  sourceName: string;
  sourceUrl?: string;
  url: string;
  /** Vietnamese one-line headline written by the analyst, may end with "(82 chia sẻ)". */
  title: string;
  /** One-line context under the title ("Bình luận gần như 1 chữ 'Loop'"). */
  note?: string;
  /** X/Threads: snippet of the original text, shown in italics. */
  quote?: string;
  /** "Bài viết" | "Bài nhóm" | "Bài viết tặng tài liệu" | "Bài viết dài" | "Video" | "Tin" | "Quảng cáo". */
  typeLabel: string;
  metrics: Metrics;
  postedAt?: string;
  postedText?: string;
  /** Posted within the last 24h of the scan (older posts do not count toward comment totals). */
  within24h: boolean;
  topics: string[];
  profession?: string;
  /** Has at least one buy-signal comment. */
  buy: boolean;
  /** In the session's top table. */
  top: boolean;
  /** First time the ledger sees this url. */
  isNew: boolean;
  /** Seen in an earlier report and still growing. */
  rising?: { times: number; prevComments: number };
  sessionKey: string;
  /** World/X: "Chủ đề 1: Agent trên laptop RTX Spark". */
  theme?: string;
  /** Same story on Hacker News. */
  hnUrl?: string;
  ad?: AdView;
}

export interface CommunityView {
  name: string;
  url?: string;
  kind: SourceKind;
  members?: number;
  followers?: number;
  profession?: string;
  /** One line by the analyst ("Rủ nhau mua chung ChatGPT Plus; lo học viên…"). */
  summary: string;
  /** Best-matching pain id for the community. */
  painId?: string;
}

export interface PainView {
  /** Stable ledger id "P011". */
  id: string;
  /** 1 = most important in this session. */
  rank: number;
  title: string;
  detail: string;
  professions: string[];
  topics: string[];
  itemIds: string[];
  /** First time in the ledger. */
  isNew: boolean;
  /** Reports this pain appeared in, today included. */
  times: number;
  firstSeen: string;
}

export interface QuoteView {
  text: string;
  /** "Giáo viên, mua chung". */
  tag: string;
  topics: string[];
  itemId?: string;
  profession?: string;
}

export interface BuySignalView {
  type: BuyType;
  text: string;
  /** "Giáo Viên Tiếng Anh, ChatGPT Plus dùng chung 150k/tháng (140 bình luận)". */
  context: string;
  itemId?: string;
  url?: string;
}

export interface ToolRank { rank: 1 | 2 | 3 | 4; names: string[]; note?: string }

export interface IdeaView {
  /** One of config.owner.channels, or "Mọi kênh". */
  channel: string;
  title: string;
  evidence: string[];
  status: 'todo' | 'doing' | 'done';
  painIds?: string[];
}

export interface FearView { text: string; profession: string; context: string; url?: string }

export interface ProfessionView {
  name: string;
  /** Two letters for the avatar ("GV"). */
  initials: string;
  summary: string;
  painIds: string[];
  quote?: string;
}

export interface CompetitorView {
  name: string;
  url: string;
  initials: string;
  followers?: number;
  activeAds: number;
  /** Đăng gì. */
  posts: string;
  /** Bán gì. */
  sells: string;
  /** Giá ("Không công khai"). */
  price: string;
  topPostId?: string;
  postIds: string[];
}

export interface OtherAdvertiserView { name: string; note: string; since: string }

export interface GapView {
  title: string;
  bullets: string[];
  segment: AdView['segment'];
  priceModel: AdView['priceModel'];
}

export interface TrendView {
  rank: number;
  /** "14.556 lượt thích" | "250 điểm". */
  metricLabel: string;
  /** "@antigravity, khoảng 1,29 triệu lượt xem". */
  sourceLine: string;
  title: string;
  /** Purple line under the title. */
  subtitle: string;
  description: string;
  /** 💡 why it matters in Vietnam / the gap. */
  vnAngle: string;
  itemIds: string[];
}

export interface SessionView {
  /** 'all' for the merged day view when there are several sessions, else 's1', 's2', … */
  key: string;
  /** "Cả ngày" | "Phiên 7h" | "Phiên 14h". */
  label: string;
  scan: {
    /** "Phiên 20h (chạy bù tối 17/10, UTC+7). Lần quét đầu của lớp này nên lấy bài AI trong 7 ngày gần đây." */
    when: string;
    /** "12 cộng đồng (2,9 triệu thành viên)". */
    sources: string;
    /** "21 bài, 494 bình luận, 6 bài có tín hiệu mua". */
    top: string;
  };
  topics: TopicDef[];
  communities: CommunityView[];
  items: ItemView[];
  pains: PainView[];
  quotes: QuoteView[];
  buySignals: BuySignalView[];
  /** "Người bán tài khoản" note (competition on price), when sellers show up in comments. */
  sellerNote?: string;
  tools: ToolRank[];
  ideas: IdeaView[];
  fears: FearView[];
  professions: ProfessionView[];
  /** nganh: configured professions with no AI post this session. */
  missingProfessions: string[];
  competitors: CompetitorView[];
  otherAdvertisers: OtherAdvertiserView[];
  gap: GapView | null;
  trends: TrendView[];
  dataNotes: string[];
}

export interface ReportPayload {
  version: 1;
  layer: LayerKey;
  /** "Ngành nghề". */
  layerLabel: string;
  /** "phiên 20h". */
  slotLabel: string;
  /** YYYY-MM-DD (local). */
  date: string;
  /** "17/10/2026". */
  dateLabel: string;
  /** "Thứ Bảy". */
  weekday: string;
  /** config.owner.name, e.g. "Minh". */
  owner: string;
  generatedAt: string;
  /** One entry when the layer ran once that day; otherwise 'all' first, then each run. */
  sessions: SessionView[];
}

// ── Index page ──────────────────────────────────────────────────────────

export interface IndexLayerCard {
  key: LayerKey;
  label: string;
  /** "07:00". */
  time: string;
  description: string;
  latest: null | {
    date: string;
    /** "Thứ Bảy, 17/10/2026". */
    dateLabel: string;
    sources: number;
    posts: number;
    comments: number;
    newPosts: number;
    newPains: number;
    recurringPains: number;
    topPains: { title: string; isNew: boolean; times: number }[];
  };
}

export interface IndexArchiveDay {
  date: string;
  /** "17". */
  day: string;
  /** "Thứ Bảy". */
  weekday: string;
  /** "tháng 10/2026". */
  monthLabel: string;
  layers: { key: LayerKey; label: string; time: string; newPosts: number | null }[];
}

export interface IndexPayload {
  owner: string;
  /** "Thứ Bảy, 17/10/2026" or null before the first report. */
  updatedLabel: string | null;
  layers: IndexLayerCard[];
  archive: IndexArchiveDay[];
}

/** Links inside rendered pages. The dashboard maps them to its own routes; a static export to folders. */
export interface RenderLinks {
  report(date: string, layer: LayerKey): string;
  index(): string;
}
