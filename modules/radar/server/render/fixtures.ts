/**
 * Hand-built fixtures from the original 17/10/2026 data: used by the render tests and the visual check.
 * `nganhFixture`, `vnFixture`, `worldFixture` are ReportPayloads; `indexFixture` an IndexPayload.
 */

import type {
  AdView, BuySignalView, CommunityView, CompetitorView, IndexPayload, ItemView, LayerKey, Metrics, PainView, ReportPayload, SessionView,
  SourceKind, TopicDef, TrendView,
} from '../types.js';
import { foldVi, initials, itemIdFor } from '../util.js';
import { NG_DATA, VN_DATA, type RawFeed, type RawPost } from './fixtures-data.js';

const NOW = '2026-10-17T13:20:00Z';
const NOW_MS = Date.parse(NOW);
const OWNER = 'Minh';

const topicDefs = (m: Record<string, string>): TopicDef[] => Object.entries(m).map(([key, label]) => ({ key, label, keywords: [] }));

/** "Đăng 6 ngày trước" → ISO time relative to NOW; other texts stay as postedText. */
function postedFrom(time: string | null): { postedAt?: string; postedText?: string } {
  if (!time) return {};
  const d = time.match(/(\d+) ngày trước/);
  if (d) return { postedAt: new Date(NOW_MS - Number(d[1]) * 86400000).toISOString() };
  const h = time.match(/(\d+) giờ trước/);
  if (h) return { postedAt: new Date(NOW_MS - Number(h[1]) * 3600000).toISOString() };
  const mi = time.match(/(\d+) phút trước/);
  if (mi) return { postedAt: new Date(NOW_MS - Number(mi[1]) * 60000).toISOString() };
  return { postedText: time.replace(/^Đăng /, '').replace(/ \(cũ hơn 7 ngày\).*$/, '').replace(/ trước$/, '') };
}

function emptySession(key: string, label: string): SessionView {
  return {
    key, label, scan: { when: '', sources: '', top: '' }, topics: [], communities: [], items: [], pains: [], quotes: [], buySignals: [],
    tools: [], ideas: [], fears: [], professions: [], missingProfessions: [], competitors: [], otherAdvertisers: [], gap: null, trends: [], dataNotes: [],
  };
}

/** A payload with one empty session: every view must still render. */
export function emptyReport(layer: LayerKey = 'nganh'): ReportPayload {
  const labels: Record<LayerKey, [string, string]> = { nganh: ['Ngành nghề', 'phiên 20h'], vn: ['AI trong nước', 'phiên 7h'], world: ['Thế giới', 'phiên 12h'] };
  return {
    version: 1, layer, layerLabel: labels[layer][0], slotLabel: labels[layer][1], date: '2026-10-17', dateLabel: '17/10/2026', weekday: 'Thứ Bảy',
    owner: OWNER, generatedAt: NOW, sessions: [emptySession('all', 'Cả ngày')],
  };
}

// ── Ngành nghề ──────────────────────────────────────────────────────────

const NG_PROFESSION_BY_GROUP: Record<string, string> = {
  'Phụ huynh TP.HCM': 'Phụ huynh', 'Giáo Viên Tiếng Anh': 'Giáo viên', 'Phụ huynh Hà Nội': 'Phụ huynh', HrShare: 'Nhân sự',
  'Cùng Con Học Tiểu Học': 'Phụ huynh', 'Kế Toán Việt Nam': 'Kế toán', 'Agency Việt Nam': 'Marketing', 'Tomorrow Marketers': 'Marketing',
  'SEO Marketing': 'Marketing', 'Nhóm Bán Hàng Online': 'Bán hàng online',
};

function ngProfession(group: string, post: RawPost): string {
  if (NG_PROFESSION_BY_GROUP[group]) return NG_PROFESSION_BY_GROUP[group];
  const t = foldVi(post.title);
  if (/me bim|affiliate/.test(t)) return 'Phụ huynh';
  if (/sep|quan ly|nguoi di lam|co n sot/.test(t) || /con sot/.test(t)) return 'Dân văn phòng';
  return 'Giáo viên';
}

export function buildNganh(): ReportPayload {
  const d = NG_DATA;
  const items: ItemView[] = [];
  const communities: CommunityView[] = [];
  const painIdByRank = new Map(d.pains.map((p) => [String(p.rank), p.id]));
  for (const g of d.groups) {
    const kind: SourceKind = g.name === 'TikTok' ? 'tiktok' : g.name === 'Báo chí, web' ? 'news' : 'fb_group';
    communities.push({
      name: g.name, url: g.url ?? undefined, kind, members: g.members ?? undefined, summary: g.summary, painId: g.pain ? painIdByRank.get(g.pain) : undefined,
      profession: NG_PROFESSION_BY_GROUP[g.name],
    });
    for (const p of g.posts) {
      const metrics: Metrics = {};
      if (p.comments) metrics.comments = p.comments;
      if (p.reactions) metrics.reactions = p.reactions;
      items.push({
        id: itemIdFor(p.url), kind, sourceName: g.name, sourceUrl: g.url ?? undefined, url: p.url, title: p.title, note: p.note ?? undefined, typeLabel: p.type, metrics,
        ...postedFrom(p.time), within24h: !/\bout\b/.test(p.cls), topics: p.topics ?? [], profession: ngProfession(g.name, p), buy: p.buy, top: p.top, isNew: p.new, sessionKey: 'all',
      });
    }
  }
  const idOf = (url: string | null | undefined): string | undefined => (url ? items.find((i) => i.url.replace(/\/$/, '') === url.replace(/\/$/, ''))?.id : undefined);
  const pains: PainView[] = d.pains.map((p) => ({
    id: p.id, rank: p.rank, title: p.title, detail: p.detail, professions: p.professions, topics: p.topics,
    itemIds: p.itemUrls.map((u) => idOf(u)).filter((x): x is string => !!x), isNew: true, times: 1, firstSeen: '2026-10-17',
  }));
  const buySignals: BuySignalView[] = d.buys.map((b) => ({ type: b.type, text: b.text, context: b.context, itemId: idOf(b.url), url: b.url }));
  const session: SessionView = {
    key: 'all', label: 'Cả ngày',
    scan: {
      when: 'Phiên 20h (chạy bù tối 17/10, UTC+7). Lần quét đầu của lớp này nên lấy bài AI trong 7 ngày gần đây.',
      sources: '12 cộng đồng (2,9 triệu thành viên)', top: '21 bài, 494 bình luận, 6 bài có tín hiệu mua',
    },
    topics: topicDefs(d.topics), communities, items, pains,
    quotes: d.quotes.map((q) => ({ text: q.text, tag: q.tag, topics: q.topics })),
    buySignals, sellerNote: d.seller, tools: [],
    ideas: d.ideas.map((i) => ({ channel: i.channel, title: i.title, evidence: i.evidence, status: 'todo' as const })),
    fears: d.fears.map((f) => ({ text: f.text, profession: f.profession, context: f.context, url: f.url ?? undefined })),
    professions: d.profs.map((p) => ({
      name: p.name, initials: p.initials || initials(p.name), summary: p.summary, quote: p.quote ?? undefined,
      painIds: p.pains.map((t) => d.pains.find((x) => x.title === t)?.id).filter((x): x is string => !!x),
    })),
    missingProfessions: ['Công chức, viên chức', 'Học sinh, sinh viên'],
    competitors: [], otherAdvertisers: [], gap: null, trends: [], dataNotes: d.notes,
  };
  return {
    version: 1, layer: 'nganh', layerLabel: 'Ngành nghề', slotLabel: 'phiên 20h', date: '2026-10-17', dateLabel: '17/10/2026', weekday: 'Thứ Bảy',
    owner: OWNER, generatedAt: NOW, sessions: [session],
  };
}

// ── AI trong nước ───────────────────────────────────────────────────────

const VN_TOPICS: TopicDef[] = [
  { key: 'goi', label: 'Gói, hạn mức, token', keywords: [] }, { key: 'tien', label: 'Tài khoản, tiền, bán lại', keywords: [] },
  { key: 'congcu', label: 'Chọn công cụ theo nghề', keywords: [] }, { key: 'lead', label: 'Lead magnet, tài liệu, prompt free', keywords: [] },
  { key: 'hoc', label: 'Học prompt, workshop, khóa học', keywords: [] }, { key: 'app', label: 'Tự làm app, agent, automation', keywords: [] },
  { key: 'video', label: 'Video AI', keywords: [] }, { key: 'edu', label: 'AI cho giáo dục', keywords: [] }, { key: 'tin', label: 'Tin, model mới, cập nhật', keywords: [] },
];

const VN_TOPIC_RULES: [string, RegExp][] = [
  ['goi', /han muc|goi |token|gioi han|het han/], ['tien', /tai khoan|ban |mua |gia /], ['congcu', /chon|cong cu|nghe/],
  ['lead', /comment|tai lieu|loop|prompt|workflow/], ['hoc', /hoc|khoa|workshop/], ['app', /app|agent|automation|web/],
  ['video', /video|veo|flow/], ['edu', /giao vien|hoc sinh|giao duc/], ['tin', /moi|ra mat|cap nhat|gemini|model/],
];
const topicsOf = (title: string): string[] => {
  const t = ` ${foldVi(title)} `;
  return VN_TOPIC_RULES.filter(([, re]) => re.test(t)).map(([k]) => k).slice(0, 3);
};

const AD_POSITION: Record<string, [AdView['segment'], AdView['priceModel']]> = {
  'AI Automation (Unica affiliate)': ['enterprise', 'free'], 'Agent-X AI': ['enterprise', 'free'], 'Học Viện MCI': ['enterprise', 'hidden'],
  'Nguyễn Tất Kiểm, AI Coaching': ['mass', 'free'], 'Nguyễn Phương': ['mass', 'hidden'], 'USB AI, AI Cho Người Mới': ['mass', 'hidden'], 'Đạt Bá, Thực Chiến Đa Kênh': ['mass', 'public'],
};
const FUNNEL: Record<string, AdView['funnel']> = { 'Zoom free': 'zoom', 'Google Form': 'form', Messenger: 'messenger', Comment: 'comment', Web: 'web' };

function isoFromDm(dm: string | null): string | undefined {
  if (!dm) return undefined;
  const [d, m] = dm.split('/').map(Number);
  return `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function feedItem(f: RawFeed, kind: SourceKind, _layer: LayerKey, sessionKey: string): ItemView {
  const url = (kind === 'hn' ? f.urls.find((u) => u.includes('ycombinator.com')) : undefined) ?? f.urls[0];
  const hnUrl = kind !== 'hn' ? f.urls.find((u) => u.includes('ycombinator.com')) : undefined;
  const handle = url.match(/x\.com\/([^/]+)\//)?.[1];
  const source = kind === 'x' ? `@${handle ?? 'x'}` : kind === 'hn' ? 'Hacker News' : kind === 'youtube' ? 'YouTube' : kind === 'github' ? 'GitHub' : new URL(url).hostname.replace(/^www\./, '');
  let postedAt: string | undefined;
  const m = f.date?.match(/^(\d+)\/(\d+) (\d+):(\d+)$/);
  if (m) postedAt = new Date(Date.UTC(2026, Number(m[2]) - 1, Number(m[1]), Number(m[3]) - 7, Number(m[4]))).toISOString();
  return {
    id: itemIdFor(url), kind, sourceName: source, url, title: f.title, note: f.note ?? undefined, quote: f.quote ?? undefined, typeLabel: 'Tin', metrics: f.metrics as Metrics,
    postedAt, postedText: postedAt ? undefined : f.date ?? undefined, within24h: true, topics: topicsOf(`${f.title} ${f.note ?? ''}`), buy: false, top: false, isNew: true,
    sessionKey, theme: f.theme ?? undefined, hnUrl,
  };
}

function vnItemsAndMeta(): { items: ItemView[]; communities: CommunityView[]; competitors: CompetitorView[]; ads: AdView[] } {
  const d = VN_DATA;
  const items: ItemView[] = [];
  const communities: CommunityView[] = [];
  d.groups.forEach((g, gi) => {
    communities.push({ name: g.name, url: g.url ?? undefined, kind: 'fb_group', members: g.members ?? undefined, summary: g.summary });
    g.posts.forEach((p, pi) => {
      const metrics: Metrics = {};
      if (p.comments) metrics.comments = p.comments;
      if (p.reactions) metrics.reactions = p.reactions;
      items.push({
        id: itemIdFor(p.url), kind: 'fb_group', sourceName: g.name, sourceUrl: g.url ?? undefined, url: p.url, title: p.title, note: p.note ?? undefined, typeLabel: p.type, metrics,
        ...postedFrom(p.time), within24h: !/\bout\b/.test(p.cls), topics: topicsOf(p.title), buy: p.buy, top: p.top, isNew: p.new, sessionKey: (gi + pi) % 2 === 0 ? 's1' : 's2',
      });
    });
  });
  const competitors: CompetitorView[] = d.comps.map((c) => {
    const posts = [c.top, ...c.others.map((o, i) => ({ ...o, url: `${c.url.replace(/\/$/, '')}/posts/${100 + i}` }))].filter((x): x is { title: string; metrics: Record<string, number>; url: string } => !!x);
    for (const p of posts) {
      items.push({
        id: itemIdFor(p.url), kind: 'fb_page', sourceName: c.name, sourceUrl: c.url, url: p.url, title: p.title, typeLabel: 'Bài viết', metrics: p.metrics as Metrics, within24h: true,
        topics: topicsOf(p.title), buy: false, top: false, isNew: true, sessionKey: 's1',
      });
    }
    return {
      name: c.name, url: c.url, initials: c.initials, followers: c.followers ?? undefined, activeAds: c.ads, posts: c.posts, sells: c.sells, price: c.price,
      topPostId: c.top ? itemIdFor(c.top.url) : undefined, postIds: posts.map((p) => itemIdFor(p.url)),
    };
  });
  const ads: AdView[] = d.ads.map((a) => {
    const [segment, priceModel] = AD_POSITION[a.advertiser] ?? (a.audience ? (['profession', 'hidden'] as const) : (['mass', 'hidden'] as const));
    const libraryUrl = `https://www.facebook.com/ads/library/?id=${a.id}`;
    return {
      adArchiveId: a.id, advertiser: a.advertiser, libraryUrl, product: a.product, headline: a.headline, funnel: FUNNEL[a.funnel] ?? 'unknown', funnelLabel: a.funnel,
      format: a.format, audience: a.audience ?? undefined, startDate: isoFromDm(a.start), daysRunning: a.days, versions: a.versions && /^\d+$/.test(a.versions) ? Number(a.versions) : undefined,
      price: a.price ?? 'Không công khai', cta: a.cta ?? 'Không ghi', landing: a.landing ?? 'Messenger', segment, priceModel, sellsBook: a.sellsBook, otherAdIds: a.other,
    };
  });
  for (const ad of ads) {
    items.push({
      id: itemIdFor(ad.libraryUrl), kind: 'ad', sourceName: ad.advertiser, url: ad.libraryUrl, title: ad.product, typeLabel: 'Quảng cáo', metrics: {}, within24h: true,
      topics: topicsOf(`${ad.product} ${ad.headline}`), buy: false, top: false, isNew: true, sessionKey: 's2', ad,
    });
  }
  d.x.filter((f) => f.urls.length).slice(0, 6).forEach((f) => items.push(feedItem(f, 'x', 'vn', 's1')));
  d.hn.filter((f) => f.urls.length).slice(0, 3).forEach((f) => items.push(feedItem(f, 'hn', 'vn', 's2')));
  d.yt.filter((f) => f.urls.length).slice(0, 3).forEach((f) => items.push(feedItem(f, f.plats[0] === 'GitHub' ? 'github' : f.plats[0] === 'YouTube' ? 'youtube' : 'news', 'vn', 's2')));
  const unique = items.filter((it, i, all) => all.findIndex((o) => o.id === it.id) === i);
  return { items: unique, communities, competitors, ads };
}

const trendsFrom = (items: ItemView[], count: number): TrendView[] =>
  VN_DATA.trends.slice(0, count).map((t, i) => ({
    rank: t.rank, metricLabel: t.metric, sourceLine: t.src, title: t.title, subtitle: t.sub, description: t.desc, vnAngle: t.why,
    itemIds: items.filter((it) => (it.kind === 'x' || it.kind === 'hn') && !!it.theme).slice(i * 2, i * 2 + 2).map((it) => it.id),
  }));

export function buildVn(): ReportPayload {
  const { items, communities, competitors } = vnItemsAndMeta();
  const trends = trendsFrom(items, 3);
  const pains: PainView[] = [
    { id: 'P001', rank: 1, title: 'Chọn công cụ theo nghề', detail: 'AI nào hợp nghề mình: Word, PLC, UI/UX, chatbot, giáo viên mầm non, viết tiểu thuyết, video BĐS.', professions: [], topics: ['congcu'], itemIds: items.filter((i) => i.topics.includes('congcu')).slice(0, 3).map((i) => i.id), isNew: false, times: 3, firstSeen: '2026-10-14' },
    { id: 'P002', rank: 2, title: 'Gói, hạn mức, tiền', detail: 'Tốc độ gói, giờ reset, hết token, share seat gia đình; người bán tài khoản tràn lan.', professions: [], topics: ['goi', 'tien'], itemIds: items.filter((i) => i.topics.includes('goi')).slice(0, 3).map((i) => i.id), isNew: false, times: 2, firstSeen: '2026-10-15' },
    { id: 'P017', rank: 3, title: 'Người ngoài ngành muốn tự làm app', detail: 'Không biết code muốn làm app desktop, phần mềm quản lý công trình.', professions: [], topics: ['app'], itemIds: items.filter((i) => i.topics.includes('app')).slice(0, 2).map((i) => i.id), isNew: true, times: 1, firstSeen: '2026-10-17' },
  ];
  const mk = (key: string, label: string, subset: ItemView[]): SessionView => {
    const ids = new Set(subset.map((i) => i.id));
    return {
      key, label,
      scan: { when: 'Phiên sáng quét lúc khoảng 11h, phiên tối quét lúc khoảng 19h20 (UTC+7)', sources: '7 nhóm FB (2,9 triệu thành viên), 4 fanpage, 16 quảng cáo, 37 tin X, HN, YouTube', top: '31 bài, 1016 bình luận, 11 bài có tín hiệu mua' },
      topics: VN_TOPICS, communities, items: subset,
      pains: pains.map((p) => ({ ...p, itemIds: p.itemIds.filter((id) => ids.has(id)) })),
      quotes: [
        { text: 'mua từng tháng thôi đen dên nó ban còn đớ tiếc mua năm nó ban thì tiếc', tag: 'Gói, hạn mức', topics: ['goi'] },
        { text: 'gói này chạy một lúc là hết hạn mức tuần', tag: 'Hạn mức Codex', topics: ['goi'] },
      ],
      buySignals: [
        { type: 'material', text: 'Cho mình xin ad + hàng loạt "Loop"', context: 'Cơm AI lo, bài tài liệu LOOP', itemId: subset.find((i) => i.sourceName === 'Cơm AI lo')?.id, url: subset.find((i) => i.sourceName === 'Cơm AI lo')?.url },
        { type: 'price', text: 'Giá bao nhiêu b.mình đag cần', context: 'Cộng đồng Claude AI VN, bài bán API credit', itemId: subset.find((i) => i.sourceName === 'Claude VN')?.id },
      ],
      sellerNote: 'Bình luận toàn người bán tài khoản 350k đến 3 triệu/năm, người mua sợ bị ban.',
      tools: [
        { rank: 1, names: ['Claude'], note: 'Vượt trội: Pro/Max, API, Opus' }, { rank: 2, names: ['ChatGPT', 'Codex'] }, { rank: 3, names: ['Gemini', 'Antigravity'] },
        { rank: 4, names: ['Google Flow', 'Copilot', 'n8n', 'Muse AI', 'Veo', 'Seedance'], note: 'Ít được nhắc hơn' },
      ],
      ideas: [
        { channel: 'Ebook AI Thực Chiến', title: 'Ebook "Chọn AI theo nghề" + mẹo tiết kiệm token', evidence: ['Nỗi đau #1 và #2 trong bình luận', 'Chỉ 3/16 quảng cáo bán sách, ebook'], status: 'todo' },
        { channel: 'Linh', title: 'Bài Claude Slides cho giáo viên; Gemini 4 Argon trong Antigravity bằng gói Pro', evidence: ['@bcherny 2.750 lượt thích, X tiếng Việt chưa có bài'], status: 'doing' },
        { channel: 'Chiến Lược Từ Vote', title: 'Zoom "Tự làm app nội bộ cho công ty bằng AI, làm sao để sếp trả tiền"', evidence: ['Bài webapp 98 bình luận (Cộng đồng Claude AI VN)'], status: 'todo' },
      ],
      fears: [], professions: [], missingProfessions: [],
      competitors, otherAdvertisers: VN_DATA.others,
      gap: {
        title: 'Ebook "Chọn AI theo nghề" + mẹo tiết kiệm token', segment: 'profession', priceModel: 'public',
        bullets: ['Nỗi đau #1 và #2 trong bình luận', 'Chỉ 3/16 quảng cáo bán sách, ebook (Nguyễn Phương, USB AI, Agent-X)', 'Giveaway "18 SÁCH CLAUDE" 1,1 nghìn bình luận', 'Ô “giá công khai × theo nghề” trên bản đồ đang trống'],
      },
      trends, dataNotes: VN_DATA.notes,
    };
  };
  const allSession = mk('all', 'Cả ngày', items);
  return {
    version: 1, layer: 'vn', layerLabel: 'AI trong nước', slotLabel: 'phiên 7h', date: '2026-10-17', dateLabel: '17/10/2026', weekday: 'Thứ Bảy', owner: OWNER, generatedAt: NOW,
    sessions: [allSession, mk('s1', 'Sáng', items.filter((i) => i.sessionKey === 's1')), mk('s2', 'Tối', items.filter((i) => i.sessionKey === 's2'))],
  };
}

// ── Thế giới ────────────────────────────────────────────────────────────

const WORLD_TOPICS: TopicDef[] = [
  { key: 'agent', label: 'Agent, tự động hóa', keywords: [] }, { key: 'model', label: 'Model mới, benchmark', keywords: [] }, { key: 'hw', label: 'Phần cứng, chạy local', keywords: [] },
  { key: 'tool', label: 'Công cụ cho người mới', keywords: [] }, { key: 'edu', label: 'Giáo dục, slide, bài giảng', keywords: [] },
];
const WORLD_RULES: [string, RegExp][] = [
  ['agent', /agent|openclaw|hermes|dot/], ['model', /model|deepseek|gemini|benchmark|argon/], ['hw', /laptop|rtx|local|mac studio|offline/],
  ['tool', /claude|code|slides|antigravity/], ['edu', /slides|giao duc|giao vien/],
];

export function buildWorld(): ReportPayload {
  const d = VN_DATA;
  const items: ItemView[] = [
    ...d.x.filter((f) => f.urls.length).map((f) => feedItem(f, 'x', 'world', 'all')),
    ...d.hn.filter((f) => f.urls.length).map((f) => feedItem(f, 'hn', 'world', 'all')),
    ...d.yt.filter((f) => f.urls.length).map((f) => feedItem(f, f.plats[0] === 'GitHub' ? 'github' : f.plats[0] === 'YouTube' ? 'youtube' : 'news', 'world', 'all')),
  ].filter((it, i, all) => all.findIndex((o) => o.id === it.id) === i).map((it) => ({ ...it, topics: WORLD_RULES.filter(([, re]) => re.test(` ${foldVi(it.title)} `)).map(([k]) => k) }));
  const trends: TrendView[] = d.trends.map((t, i) => ({
    rank: t.rank, metricLabel: t.metric, sourceLine: t.src, title: t.title, subtitle: t.sub, description: t.desc, vnAngle: t.why,
    itemIds: items.filter((it) => it.theme).slice(i * 2, i * 2 + 2).map((it) => it.id),
  }));
  const session: SessionView = {
    ...emptySession('all', 'Cả ngày'),
    scan: { when: 'Phiên 12h (UTC+7). Chỉ giữ chủ đề chưa phổ biến ở Việt Nam.', sources: 'X, Hacker News, YouTube, GitHub', top: `${items.length} tin, ${trends.length} xu hướng chính` },
    topics: WORLD_TOPICS, items, trends, dataNotes: d.notes.slice(0, 5),
    ideas: [{ channel: 'Linh', title: 'Bài "Agent chạy ngay trên laptop, không cần gõ lệnh"', evidence: ['Hermes Agent, OpenClaw trên laptop RTX Spark', 'X tiếng Việt chưa ai nói góc agent'], status: 'todo' }],
  };
  return {
    version: 1, layer: 'world', layerLabel: 'Thế giới', slotLabel: 'phiên 12h', date: '2026-10-17', dateLabel: '17/10/2026', weekday: 'Thứ Bảy', owner: OWNER, generatedAt: NOW, sessions: [session],
  };
}

// ── Index ───────────────────────────────────────────────────────────────

export function buildIndex(): IndexPayload {
  return {
    owner: OWNER,
    updatedLabel: 'Thứ Bảy, 17/10/2026',
    layers: [
      { key: 'vn', label: 'AI trong nước', time: '07:00', description: 'Nhóm AI Việt Nam, trang đối thủ, Instagram đối thủ và creator AI, Meta Ad Library.', latest: null },
      { key: 'world', label: 'Thế giới', time: '12:00', description: 'X, Reddit, Hacker News, YouTube, LinkedIn, Threads, TikTok, Instagram nước ngoài. Chỉ giữ chủ đề chưa phổ biến ở Việt Nam.', latest: null },
      {
        key: 'nganh', label: 'Ngành nghề', time: '20:00',
        description: 'Cộng đồng không chuyên về AI: giáo viên, phụ huynh, công chức, kế toán, marketing, bán hàng, nhân sự. Chỉ bài và bình luận nói về AI.',
        latest: {
          date: '2026-10-17', dateLabel: 'Thứ Bảy, 17/10/2026', sources: 12, posts: 21, comments: 467, newPosts: 21, newPains: 6, recurringPains: 0,
          topPains: [
            { title: 'Muốn ChatGPT Plus nhưng ngại giá, rủ nhau dùng chung', isNew: true, times: 1 },
            { title: 'Mua ChatGPT cho công ty sao cho đúng luật', isNew: true, times: 1 },
            { title: 'Phụ huynh phản đối con học và dùng AI', isNew: false, times: 2 },
          ],
        },
      },
    ],
    archive: [{
      date: '2026-10-17', day: '17', weekday: 'Thứ Bảy', monthLabel: 'tháng 10/2026',
      layers: [
        { key: 'vn', label: 'AI trong nước', time: '07:00', newPosts: null }, { key: 'world', label: 'Thế giới', time: '12:00', newPosts: null }, { key: 'nganh', label: 'Ngành nghề', time: '20:00', newPosts: 21 },
      ],
    }],
  };
}

export const nganhFixture: ReportPayload = buildNganh();
export const vnFixture: ReportPayload = buildVn();
export const worldFixture: ReportPayload = buildWorld();
export const indexFixture: IndexPayload = buildIndex();
