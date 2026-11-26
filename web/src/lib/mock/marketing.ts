// Mock of the Facebook analytics API (/api/m/marketing/*) for reviewing the "Mạng xã hội" screens without the
// backend. Deterministic numbers; a few values are left null on purpose so the "absent, not 0" states show.
// Registered in mock/index.ts.
type Handler = (params: string[], query: URLSearchParams, body: any) => unknown;
export type MockRoute = [method: string, pattern: string, fn: Handler];

class Fail extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
export { Fail as MarketingMockError };

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
const dayKey = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
let lastRefreshAt = 0;

const RAW = [820, 760, 910, 1180, 990, 870, 1320, 1010, 940, 880, 1460, 1120, 980, 900, 1250, 1090, 1380, 1210, 1040, 960, 1520, 1300, 1150, 1080, 1010, 2140, 1680, 1390];

function days(n: number): { day: string; reach: number | null }[] {
  return Array.from({ length: n }, (_, i) => {
    const age = n - 1 - i;
    // the oldest days of a long range predate the first import: no number rather than 0
    const reach = age >= 60 ? null : RAW[(i * 7 + 3) % RAW.length]! + (i % 5) * 31;
    return { day: dayKey(now() - age * DAY), reach };
  });
}

const kpi = (key: string, label: string, value: number | null, unit: 'count' | 'pct' | 'permille', delta: number | null, deltaUnit: 'pct' | 'pt' | 'count', extra: number | null = null) =>
  ({ key, label, value, unit, delta, deltaUnit, extra, spark: [] as number[] });

function channel(n: number) {
  return {
    page: { id: 'mock-page', name: 'Trà Sen Việt', role: 'Bán lẻ', mainKpi: 'Tin nhắn', followers: 4280, er28d: 4.2 },
    days: n,
    posts: Math.max(1, Math.round((n / 28) * 9)),
    kpis: [
      kpi('followers', 'Người theo dõi', 4280, 'count', 96, 'count', 96),
      kpi('reach', `Reach ${n} ngày`, Math.round((n / 28) * 38400), 'count', 18, 'pct'),
      kpi('er', 'ER trung vị', 4.2, 'pct', 0.6, 'pt'),
      kpi('interactions', 'Tổng tương tác', Math.round((n / 28) * 1930), 'count', -4, 'pct'),
      kpi('shareRate', 'Tỷ lệ chia sẻ', 3.1, 'permille', 0, 'pt'),
      kpi('commentsPerPost', 'Bình luận mỗi bài', 6, 'count', null, 'count'),
    ],
    reachDaily: days(n),
    followsDaily: [],
    funnel: [
      { key: 'impressions', label: 'Hiển thị', value: 52300 },
      { key: 'reach', label: 'Reach', value: 38400 },
      { key: 'engaged', label: 'Có tương tác', value: 1930 },
      { key: 'actions', label: 'Click link hoặc nhắn tin', value: 384 },
    ],
    mix: [],
    pillars: [
      { name: 'Cách pha và ướp trà', posts: 4, postShare: 0.44, interactionShare: 0.55, index: 1.4, erMedian: 6.3, commentsPerPost: 7, sharesPerPost: 2, verdict: 'win' },
      { name: 'Chính sách đại lý', posts: 3, postShare: 0.33, interactionShare: 0.2, index: 0.8, erMedian: 2.9, commentsPerPost: 3, sharesPerPost: 0, verdict: 'keep' },
    ],
    winner: 'Cách pha và ướp trà',
    formats: [
      { format: 'reel', posts: 3, erMedian: 6.1 },
      { format: 'video', posts: 0, erMedian: null },
      { format: 'photo', posts: 4, erMedian: 3.4 },
      { format: 'album', posts: 0, erMedian: null },
      { format: 'text', posts: 1, erMedian: 2.2 },
      { format: 'link', posts: 1, erMedian: 9.9 },
    ],
    heat: [
      { weekday: 1, slot: 4, er: 6.8, posts: 2 }, { weekday: 3, slot: 4, er: 6.3, posts: 2 },
      { weekday: 0, slot: 4, er: 4.1, posts: 1 }, { weekday: 2, slot: 3, er: 2.8, posts: 1 },
      { weekday: 4, slot: 1, er: 2.6, posts: 1 }, { weekday: 5, slot: 2, er: 2.9, posts: 1 },
    ],
    top: [], bottom: [],
    insight: {
      summary: ['Video hướng dẫn kéo reach gấp đôi bài ảnh sản phẩm.', 'Bài đăng 19 giờ thứ Ba và thứ Năm có ER cao nhất.', 'Bài chính sách đại lý ít người thấy nhưng nhiều người nhắn Zalo.'],
      actions: [], createdAt: now() - 6 * 3600,
    },
    lastSnapshotAt: now() - 3 * 3600,
  };
}

const POSTS = [
  { postId: 'p1', contentId: 1, title: 'Video ướp trà sen 3 bước', format: 'reel', pillar: 'Cách pha và ướp trà', source: 'user', reach: 2140, er: 6.3, index: 1.5, comments: 12, shares: 5, avgWatchS: 14, ageDays: 2 },
  { postId: 'p2', contentId: 2, title: 'Ảnh hộp quà trà sen dịp cuối năm', format: 'photo', pillar: 'Sản phẩm', source: 'user', reach: 1280, er: 3.6, index: 0.9, comments: 4, shares: 1, avgWatchS: null, ageDays: 5 },
  { postId: 'p3', contentId: null, title: 'Chính sách đại lý mới 2027', format: 'text', pillar: '', source: 'import', reach: null, er: null, index: null, comments: null, shares: null, avgWatchS: null, ageDays: 9 },
  { postId: 'p4', contentId: 3, title: 'Cách pha trà sen lạnh', format: 'reel', pillar: 'Cách pha và ướp trà', source: 'agent', reach: 1710, er: 5.4, index: 1.3, comments: 9, shares: 3, avgWatchS: 11, ageDays: 12 },
];

function posts(n: number, milestone: string) {
  const rows = POSTS.filter((p) => p.ageDays <= n).map(({ ageDays, ...p }) => ({
    ...p,
    publishedAt: now() - ageDays * DAY,
    // old posts have no 24 h / 7 d measurement: absent, not 0
    reach: milestone === 'latest' || p.contentId !== null ? p.reach : null,
    er: milestone === 'latest' || p.contentId !== null ? p.er : null,
    index: milestone === 'latest' || p.contentId !== null ? p.index : null,
  }));
  return {
    page: { id: 'mock-page', name: 'Trà Sen Việt' }, days: n,
    milestone: ['latest', '24h', '7d', '28d'].includes(milestone) ? milestone : 'latest',
    kpis: { posts: rows.length, postsDelta: 1, reach: 5130, reachDeltaPct: 12, erMedian: 4.2, erDeltaPt: 0.6, comments: 25, commentsDeltaPct: 8, aiReplyRate: null },
    reachDaily: [], rows,
  };
}

export const marketingMockRoutes: MockRoute[] = [
  ['GET', '/m/marketing/settings', () => ({ composioKeyConfigured: true, enabled: true })],
  ['GET', '/m/marketing/pages', () => ({
    pages: [{ id: 'mock-page', name: 'Trà Sen Việt', enabled: true, role: 'Bán lẻ', mainKpi: 'Tin nhắn', timezone: 'Asia/Ho_Chi_Minh', status: 'ACTIVE', followers: 4280, syncedAt: now() - 3600, pillars: [], stats: { postsThisWeek: 2, scheduledThisWeek: 1, er28d: 4.2, aiReplies24h: 3 } }],
  })],
  ['GET', '/m/marketing/analytics/channel', (_p, q) => channel(Math.min(90, Math.max(1, Number(q.get('days') ?? 28))))],
  ['GET', '/m/marketing/analytics/posts', (_p, q) => posts(Math.min(90, Math.max(1, Number(q.get('days') ?? 28))), q.get('milestone') ?? 'latest')],
  // the real server allows one refresh per Page every 10 minutes
  ['POST', '/m/marketing/analytics/refresh', () => {
    const wait = lastRefreshAt + 600 - now();
    if (wait > 0) throw new Fail(429, 'rate_limited', `Vừa lấy số liệu xong, thử lại sau ${Math.ceil(wait / 60)} phút`);
    lastRefreshAt = now();
    return { ok: true };
  }],
];
