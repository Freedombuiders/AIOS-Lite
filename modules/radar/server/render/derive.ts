/** Aggregates the report views compute from a SessionView (heatmap, community stats, profession stats, positioning grid). */

import type {
  AdView, CommunityView, CompetitorView, ItemView, LayerKey, Metrics, PainView, ProfessionView, SessionView, SourceKind, TopicDef,
} from '../types.js';
import { fmtCompact, fmtInt, heatLevel } from '../util.js';

const num = (n: number | undefined): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

// ── Item classification ─────────────────────────────────────────────────

export interface ItemGroups {
  /** Items that belong to a community block (a community of the session has the same name). */
  community: ItemView[];
  pages: ItemView[];
  ads: ItemView[];
  x: ItemView[];
  /** Hacker News and Reddit. */
  hn: ItemView[];
  /** YouTube, GitHub, news and the rest of the web. */
  web: ItemView[];
}

export function groupItems(layer: LayerKey, s: SessionView): ItemGroups {
  const names = new Set(s.communities.map((c) => c.name));
  const out: ItemGroups = { community: [], pages: [], ads: [], x: [], hn: [], web: [] };
  for (const it of s.items) {
    if (names.has(it.sourceName) && it.kind !== 'ad' && it.kind !== 'x' && it.kind !== 'hn') out.community.push(it);
    else if (it.kind === 'fb_group') out.community.push(it);
    else if (it.kind === 'fb_page' || it.kind === 'instagram') out.pages.push(it);
    else if (it.kind === 'ad') out.ads.push(it);
    else if (it.kind === 'x') out.x.push(it);
    else if (it.kind === 'hn' || it.kind === 'reddit') out.hn.push(it);
    else if (layer === 'nganh' && (it.kind === 'tiktok' || it.kind === 'threads' || it.kind === 'news')) out.community.push(it);
    else out.web.push(it);
  }
  return out;
}

export function itemComments(it: ItemView): number {
  return num(it.metrics.comments);
}

/** Comment heat of an item/community: Chưa rõ (0 comments) or Yên/Ấm/Nóng/Rất nóng. */
export function heatClass(maxComments: number): { cls: string; label: string; bars: number } {
  if (maxComments <= 0) return { cls: 'h0', label: 'Chưa rõ', bars: 0 };
  const h = heatLevel(maxComments);
  return { cls: `h${h.level + 1}`, label: h.label, bars: h.level + 1 };
}

// ── Dates ───────────────────────────────────────────────────────────────

const VN_OFFSET_MS = 7 * 3600 * 1000;
const p2 = (n: number): string => String(n).padStart(2, '0');

/** "16/10 23:21" in UTC+7 (the report's time zone). */
export function fmtStamp(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + VN_OFFSET_MS);
  return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

/** "dd/mm" in UTC+7. */
export function fmtDayMonth(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso.length <= 10 ? `${iso}T00:00:00+07:00` : iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + VN_OFFSET_MS);
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}

/** "Đăng 6 ngày trước" relative to the report time, else the platform's own text. */
export function fmtPosted(it: Pick<ItemView, 'postedAt' | 'postedText'>, generatedAt: string): string {
  const at = it.postedAt ? Date.parse(it.postedAt) : NaN;
  const now = Date.parse(generatedAt);
  if (Number.isFinite(at) && Number.isFinite(now)) {
    const mins = Math.max(0, Math.round((now - at) / 60000));
    if (mins < 60) return `Đăng ${Math.max(1, mins)} phút trước`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `Đăng ${hours} giờ trước`;
    return `Đăng ${Math.floor(hours / 24)} ngày trước`;
  }
  const text = (it.postedText ?? '').trim();
  if (!text) return '';
  return /^\d+\s*(phút|giờ|ngày|tuần|tháng)/i.test(text) && !/trước/.test(text) ? `Đăng ${text} trước` : `Đăng ${text}`;
}

// ── Metrics ─────────────────────────────────────────────────────────────

export interface MetricDef { key: keyof Metrics; icon: 'chat' | 'heart' | 'share' | 'eye' | 'repost' | 'bookmark' | 'up' | 'star'; label: string }

export const FB_METRICS: MetricDef[] = [
  { key: 'comments', icon: 'chat', label: 'bình luận' },
  { key: 'reactions', icon: 'heart', label: 'lượt cảm xúc' },
  { key: 'shares', icon: 'share', label: 'lượt chia sẻ' },
  { key: 'views', icon: 'eye', label: 'lượt xem' },
];
export const X_METRICS: MetricDef[] = [
  { key: 'likes', icon: 'heart', label: 'lượt thích' },
  { key: 'reposts', icon: 'repost', label: 'lượt đăng lại' },
  { key: 'saves', icon: 'bookmark', label: 'lượt lưu' },
  { key: 'quotes', icon: 'chat', label: 'lượt trích dẫn' },
  { key: 'replies', icon: 'chat', label: 'lượt trả lời' },
  { key: 'views', icon: 'eye', label: 'lượt xem' },
];

/** Plain-text metrics line for the side panel: "179 bình luận · 443 lượt cảm xúc". */
export function metricsText(m: Metrics): string {
  const defs = [...FB_METRICS.slice(0, 3), ...X_METRICS.slice(0, 3), { key: 'points', label: 'điểm' }, { key: 'stars', label: 'sao' }] as { key: keyof Metrics; label: string }[];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of defs) {
    const key = String(d.key);
    if (seen.has(key)) continue;
    seen.add(key);
    const v = num(m[d.key]);
    if (v > 0) out.push(`${fmtInt(v)} ${d.label}`);
  }
  return out.join(' · ');
}

/** Member totals: "2,9 triệu" (one decimal) above a million, else "434.000". */
export function fmtMembers(n: number): string {
  if (n >= 1_000_000) return `${(Math.round(n / 100_000) / 10).toString().replace('.', ',')} triệu`;
  return fmtInt(n);
}

/** "khoảng 44.000 lượt xem" style for X views. */
export function approxCount(n: number): string {
  return n >= 1_000_000 ? `khoảng ${fmtCompact(n)}` : n >= 10_000 ? `khoảng ${fmtInt(n)}` : fmtInt(n);
}

// ── Communities ─────────────────────────────────────────────────────────

export interface CommunityStat {
  index: number;
  c: CommunityView;
  items: ItemView[];
  posts: number;
  comments24: number;
  buyPosts: number;
  hottest?: ItemView;
  heat: { cls: string; label: string; bars: number };
  pain?: PainView;
  /** Longest comment bar across all communities (for the mini chart). */
  maxComments: number;
}

/** Communities of the session, hottest first (comments in the last 24h), each with its items. */
export function communityStats(layer: LayerKey, s: SessionView): CommunityStat[] {
  const groups = groupItems(layer, s);
  const byName = new Map<string, ItemView[]>();
  for (const it of groups.community) {
    const list = byName.get(it.sourceName) ?? [];
    list.push(it);
    byName.set(it.sourceName, list);
  }
  const comms: CommunityView[] = [...s.communities];
  for (const [name, list] of byName) {
    if (!comms.some((c) => c.name === name)) comms.push({ name, kind: list[0].kind, url: list[0].sourceUrl, summary: '' });
  }
  const painById = new Map(s.pains.map((p) => [p.id, p]));
  const maxComments = Math.max(0, ...groups.community.map(itemComments));
  const stats = comms.map((c, i): CommunityStat => {
    const items = [...(byName.get(c.name) ?? [])].sort((a, b) => Number(b.within24h) - Number(a.within24h) || itemComments(b) - itemComments(a));
    const live = items.filter((x) => x.within24h);
    const comments24 = live.reduce((n, x) => n + itemComments(x), 0);
    const hottest = [...items].sort((a, b) => itemComments(b) - itemComments(a))[0];
    return {
      index: i,
      c,
      items,
      posts: items.length,
      comments24,
      buyPosts: items.filter((x) => x.buy).length,
      hottest: hottest && itemComments(hottest) > 0 ? hottest : hottest,
      heat: heatClass(Math.max(0, ...live.map(itemComments))),
      pain: c.painId ? painById.get(c.painId) : undefined,
      maxComments,
    };
  });
  stats.sort((a, b) => b.comments24 - a.comments24);
  stats.forEach((st, i) => (st.index = i));
  return stats;
}

// ── Heatmap ─────────────────────────────────────────────────────────────

export interface HeatColumn {
  label: string;
  /** Aggregated column (competitors, ads, foreign, TikTok, news) rather than a Facebook community. */
  agg: boolean;
  kinds: SourceKind[];
}

export interface HeatCell { comments: number; posts: number; alpha: number }

export interface HeatRow { topic: TopicDef; total: number; cells: (HeatCell | null)[] }

export interface Heat {
  columns: HeatColumn[];
  rows: HeatRow[];
  ranking: { topic: TopicDef; total: number; pct: number }[];
  /** The topic with most comments (first one shown in the side panel). */
  first: string;
  /** Aggregated cells read "N mục" (teal) instead of "N bài". */
  tealAgg: boolean;
}

const WORLD_COLS: { label: string; kinds: SourceKind[] }[] = [
  { label: 'X', kinds: ['x'] },
  { label: 'Reddit', kinds: ['reddit'] },
  { label: 'Hacker News', kinds: ['hn'] },
  { label: 'YouTube', kinds: ['youtube'] },
  { label: 'GitHub', kinds: ['github'] },
  { label: 'Threads', kinds: ['threads'] },
  { label: 'TikTok', kinds: ['tiktok'] },
  { label: 'Báo chí, web', kinds: ['news'] },
];
const NGANH_COLS: { label: string; kinds: SourceKind[] }[] = [
  { label: 'TikTok', kinds: ['tiktok'] },
  { label: 'Threads', kinds: ['threads'] },
  { label: 'Báo chí, web', kinds: ['news'] },
];
const VN_COLS: { label: string; kinds: SourceKind[] }[] = [
  { label: 'Fanpage đối thủ', kinds: ['fb_page', 'instagram'] },
  { label: 'Quảng cáo', kinds: ['ad'] },
  { label: 'Nước ngoài', kinds: ['x', 'reddit', 'hn', 'youtube', 'github', 'threads', 'tiktok'] },
];

export function heatColumns(layer: LayerKey, s: SessionView): HeatColumn[] {
  const cols: HeatColumn[] = [];
  const fbNames = new Set<string>();
  for (const c of s.communities) if (c.kind === 'fb_group') { fbNames.add(c.name); cols.push({ label: c.name, agg: false, kinds: ['fb_group'] }); }
  for (const it of s.items) if (it.kind === 'fb_group' && !fbNames.has(it.sourceName)) { fbNames.add(it.sourceName); cols.push({ label: it.sourceName, agg: false, kinds: ['fb_group'] }); }
  const defs = layer === 'nganh' ? NGANH_COLS : layer === 'world' ? WORLD_COLS : VN_COLS;
  for (const d of defs) {
    if (s.items.some((it) => d.kinds.includes(it.kind))) cols.push({ label: d.label, agg: true, kinds: d.kinds });
  }
  return cols;
}

function itemColumn(it: ItemView, columns: HeatColumn[]): number {
  if (it.kind === 'fb_group') return columns.findIndex((c) => !c.agg && c.label === it.sourceName);
  return columns.findIndex((c) => c.agg && c.kinds.includes(it.kind));
}

/** Column label an item sits in (for the side panel). */
export function itemColumnLabel(it: ItemView, columns: HeatColumn[]): string {
  const i = itemColumn(it, columns);
  return i >= 0 ? columns[i].label : it.sourceName;
}

export function buildHeat(layer: LayerKey, s: SessionView): Heat {
  const columns = heatColumns(layer, s);
  const tealAgg = layer !== 'nganh';
  const raw: { topic: TopicDef; cells: ({ comments: number; posts: number } | null)[] }[] = s.topics.map((topic) => ({
    topic,
    cells: columns.map(() => null),
  }));
  for (const it of s.items) {
    const ci = itemColumn(it, columns);
    if (ci < 0) continue;
    for (const key of it.topics) {
      const row = raw.find((r) => r.topic.key === key);
      if (!row) continue;
      const cell = row.cells[ci] ?? { comments: 0, posts: 0 };
      cell.posts += 1;
      if (!columns[ci].agg && it.within24h) cell.comments += itemComments(it);
      row.cells[ci] = cell;
    }
  }
  const maxC = Math.max(0, ...raw.flatMap((r) => r.cells.map((c, i) => (c && !columns[i].agg ? c.comments : 0))));
  const rows: HeatRow[] = raw.map((r) => ({
    topic: r.topic,
    total: r.cells.reduce((n, c, i) => n + (c && !columns[i].agg ? c.comments : 0), 0),
    cells: r.cells.map((c, i) => {
      if (!c) return null;
      let alpha: number;
      if (columns[i].agg) alpha = tealAgg ? Math.min(1, 0.12 + 0.06 * Math.pow(c.posts, 0.75)) : 0.12;
      else alpha = maxC > 0 ? 0.12 + 0.88 * Math.pow(c.comments / maxC, 0.6) : 0.12;
      return { comments: c.comments, posts: c.posts, alpha: Math.round(alpha * 100) / 100 };
    }),
  }));
  const ranked = rows.filter((r) => r.total > 0).sort((a, b) => b.total - a.total);
  const top = ranked[0]?.total ?? 0;
  return {
    columns,
    rows,
    ranking: ranked.map((r) => ({ topic: r.topic, total: r.total, pct: top > 0 ? Math.round((r.total / top) * 100) : 0 })),
    first: ranked[0]?.topic.key ?? rows.find((r) => r.cells.some(Boolean))?.topic.key ?? '',
    tealAgg,
  };
}

// ── Header numbers ──────────────────────────────────────────────────────

export interface Totals { communities: number; members: number; posts: number; comments: number; ads: number; foreign: number }

export function sessionTotals(layer: LayerKey, s: SessionView): Totals {
  const g = groupItems(layer, s);
  const stats = communityStats(layer, s);
  return {
    communities: stats.length,
    members: stats.reduce((n, st) => n + num(st.c.members), 0),
    posts: g.community.length,
    comments: g.community.reduce((n, it) => n + itemComments(it), 0),
    ads: g.ads.length,
    foreign: g.x.length + g.hn.length + g.web.length,
  };
}

/** "12 cộng đồng · 2,9 triệu thành viên · 21 bài top · 494 bình luận" (+ ads and foreign news for vn/world). */
export function heatSummary(layer: LayerKey, s: SessionView): string {
  const t = sessionTotals(layer, s);
  const parts: string[] = [];
  // World has no communities of its own: its columns are platforms.
  if (t.communities && layer !== 'world') parts.push(`${t.communities} ${layer === 'nganh' ? 'cộng đồng' : 'nhóm'}`);
  if (t.members && layer !== 'world') parts.push(`${fmtMembers(t.members)} thành viên`);
  if (t.posts) parts.push(`${t.posts} bài top`, `${fmtInt(t.comments)} bình luận`);
  if (layer !== 'nganh') {
    if (t.ads) parts.push(`${t.ads} quảng cáo`);
    if (t.foreign) parts.push(`${t.foreign} tin nước ngoài`);
  }
  return parts.join(' · ');
}

// ── Professions ─────────────────────────────────────────────────────────

export interface ProfessionStat {
  p: ProfessionView;
  items: ItemView[];
  comments: number;
  buys: number;
  hottest?: ItemView;
  pains: PainView[];
  /** 0.35 … 1 tile opacity. */
  opacity: number;
}

export function professionStats(s: SessionView): ProfessionStat[] {
  const names = [...s.professions.map((p) => p.name)];
  for (const it of s.items) if (it.profession && !names.includes(it.profession)) names.push(it.profession);
  const itemById = new Map(s.items.map((it) => [it.id, it]));
  const painById = new Map(s.pains.map((p) => [p.id, p]));
  const stats = names.map((name): ProfessionStat => {
    const p = s.professions.find((x) => x.name === name) ?? { name, initials: name.slice(0, 2).toUpperCase(), summary: '', painIds: [] };
    const items = s.items.filter((it) => it.profession === name);
    const buys = s.buySignals.filter((b) => (b.itemId ? itemById.get(b.itemId)?.profession === name : false)).length || items.filter((it) => it.buy).length;
    const hottest = [...items].sort((a, b) => itemComments(b) - itemComments(a))[0];
    return {
      p,
      items,
      comments: items.reduce((n, it) => n + itemComments(it), 0),
      buys,
      hottest,
      pains: p.painIds.map((id) => painById.get(id)).filter((x): x is PainView => !!x),
      opacity: 0,
    };
  });
  const active = stats.filter((st) => st.items.length > 0).sort((a, b) => b.comments - a.comments);
  const max = active[0]?.comments ?? 0;
  for (const st of active) st.opacity = Math.round((0.35 + (max > 0 ? 0.65 * (st.comments / max) : 0)) * 100) / 100;
  return active;
}

/** Pains that several professions share. */
export function sharedPains(s: SessionView): PainView[] {
  return s.pains.filter((p) => new Set(p.professions).size >= 2);
}

// ── "Hôm nay có gì mới?" ────────────────────────────────────────────────

export interface Fresh {
  newPosts: number;
  newPains: number;
  risingPosts: number;
  recurringPains: number;
  newPainList: PainView[];
  newPostList: ItemView[];
  risingPostList: ItemView[];
  recurringList: PainView[];
}

export function freshStats(s: SessionView): Fresh {
  const newPostList = s.items.filter((it) => it.isNew).sort((a, b) => itemComments(b) - itemComments(a));
  const risingPostList = s.items.filter((it) => it.rising);
  return {
    newPosts: newPostList.length,
    newPains: s.pains.filter((p) => p.isNew).length,
    risingPosts: risingPostList.length,
    recurringPains: s.pains.filter((p) => !p.isNew).length,
    newPainList: s.pains.filter((p) => p.isNew),
    newPostList: newPostList.slice(0, 6),
    risingPostList,
    recurringList: s.pains.filter((p) => !p.isNew).sort((a, b) => b.times - a.times),
  };
}

// ── Positioning grid (vn) ───────────────────────────────────────────────

export const SEGMENTS: AdView['segment'][] = ['enterprise', 'profession', 'mass'];
export const PRICE_MODELS: AdView['priceModel'][] = ['free', 'hidden', 'public'];

export interface PositionChip { label: string; kind: 'ad' | 'pg'; size: number; days?: number }

export interface Positioning {
  /** 3 rows (segments) × 3 columns (price models). */
  cells: PositionChip[][][];
  gapCell: { row: number; col: number } | null;
  maxDays: number;
}

/** "TESOL, Simple Education" → "TESOL", "AI Automation (Unica affiliate)" → "AI Automation" (map chips and KPI captions). */
export function shortAdvertiser(name: string): string {
  const head = name.split(',')[0].replace(/\s*\(.*$/, '').trim();
  return head || name;
}

export function positioning(s: SessionView): Positioning {
  const ads = s.items.map((it) => it.ad).filter((a): a is AdView => !!a);
  const maxDays = Math.max(0, ...ads.map((a) => a.daysRunning));
  const cells: PositionChip[][][] = SEGMENTS.map(() => PRICE_MODELS.map(() => [] as PositionChip[]));
  for (const a of ads) {
    const r = SEGMENTS.indexOf(a.segment);
    const c = PRICE_MODELS.indexOf(a.priceModel);
    if (r < 0 || c < 0) continue;
    cells[r][c].push({ label: shortAdvertiser(a.advertiser), kind: 'ad', days: a.daysRunning, size: Math.round((0.75 + (maxDays > 0 ? 0.5 * (a.daysRunning / maxDays) : 0)) * 100) / 100 });
  }
  for (const comp of s.competitors) {
    const own = ads.filter((a) => a.advertiser === comp.name || shortAdvertiser(a.advertiser) === shortAdvertiser(comp.name));
    const seg = own[0]?.segment ?? 'mass';
    const price = own[0]?.priceModel ?? 'hidden';
    cells[SEGMENTS.indexOf(seg)][PRICE_MODELS.indexOf(price)].push({ label: shortAdvertiser(comp.name), kind: 'pg', size: 0.8 });
  }
  for (const row of cells) for (const cell of row) cell.sort((a, b) => (b.days ?? -1) - (a.days ?? -1));
  const gapCell = s.gap ? { row: Math.max(0, SEGMENTS.indexOf(s.gap.segment)), col: Math.max(0, PRICE_MODELS.indexOf(s.gap.priceModel)) } : null;
  return { cells, gapCell, maxDays };
}

export interface AdStats { total: number; maxDays: number; maxDaysName: string; maxVersions: number; maxVersionsName: string; zoom: number; profession: number; books: number }

export function adStats(ads: AdView[]): AdStats {
  const byDays = [...ads].sort((a, b) => b.daysRunning - a.daysRunning)[0];
  const byVer = [...ads].sort((a, b) => num(b.versions) - num(a.versions))[0];
  return {
    total: ads.length,
    maxDays: byDays?.daysRunning ?? 0,
    maxDaysName: byDays ? shortAdvertiser(byDays.advertiser) : '',
    maxVersions: num(byVer?.versions),
    maxVersionsName: byVer ? shortAdvertiser(byVer.advertiser) : '',
    zoom: ads.filter((a) => a.funnel === 'zoom').length,
    profession: ads.filter((a) => a.segment === 'profession').length,
    books: ads.filter((a) => a.sellsBook).length,
  };
}

export function competitorPosts(s: SessionView, comp: CompetitorView): { top?: ItemView; others: ItemView[] } {
  const byId = new Map(s.items.map((it) => [it.id, it]));
  const all = comp.postIds.map((id) => byId.get(id)).filter((x): x is ItemView => !!x);
  const top = (comp.topPostId ? byId.get(comp.topPostId) : undefined) ?? all[0];
  return { top, others: all.filter((x) => x !== top) };
}
