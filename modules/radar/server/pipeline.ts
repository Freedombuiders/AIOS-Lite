/**
 * One Radar run of one layer: collect → comments → analyse → build the report payload → ledger.
 * Only one run executes at a time (in-process queue); a layer already queued or running refuses a second one.
 */

import { logger } from './log.js';
import {
  collectLayer, collectVnChatter, fetchFacebookComments, type CollectContext,
} from './collectors/index.js';
import { loadConfig } from './config.js';
import {
  analyzeCompetitors, enrichItems, synthesize, type AnalysisItem, type AnalyzeContext, type CompetitorAnalysis, type ItemEnrichment,
  type Synthesis,
} from './analyze.js';
import type { AgentRunner } from './agent-turn.js';
import { runRadarAgent } from './agent-turn.js';
import { classifySeen, recentPains, recordSeen, resolvePains, type ResolvedPain, type SeenInfo } from './ledger.js';
import {
  appendRunLog, createRun, getReport, getRun, hasOkRun, loadDayItems, okRunsOfDay, saveReport, saveSessionItems, updateRun,
  type ItemMeta, type RunInfo, type RunTrigger, type StoredItem,
} from './store.js';
import {
  adFormatLabel, adFunnel, buyCandidates, classifyBuyComment, commentCount, daysRunning, isAboutAI, itemSearchText, landingLabel,
  sellsBook, topicsFor, typeLabel, within24h, type BuyCandidate,
} from './tagging.js';
import { localDay, localParts, safeTimezone, slotSeconds, utcLabel } from './time.js';
import type {
  AdView, BuySignalView, CollectResult, CommunityView, CompetitorView, FearView, IdeaView, ItemView, LayerConfig, LayerKey,
  PainView, ProfessionView, QuoteView, RadarConfig, RawItem, ReportPayload, SessionView, SourceStat, TrendView, VnChatter,
} from './types.js';
import { clip, dayLabels, fmtCompact, fmtInt, foldVi, initials } from './util.js';

export interface PipelineDeps {
  collect?: typeof collectLayer;
  fetchComments?: typeof fetchFacebookComments;
  vnChatter?: typeof collectVnChatter;
  runner?: AgentRunner;
  now?: () => Date;
  collectDeps?: CollectContext['deps'];
}

export interface RunOptions {
  trigger: RunTrigger;
  deps?: PipelineDeps;
}

const TOP_POSTS = 25;
const MIN_COMMENTS_TO_READ = 5;
const COMMENTS_PER_POST = 30;

// ── Queue ───────────────────────────────────────────────────────────────

interface Entry { run: RunInfo; opts: RunOptions; resolve: (run: RunInfo) => void }

const queue: Entry[] = [];
let active: Entry | null = null;

export function isLayerBusy(layer: LayerKey): boolean {
  return active?.run.layer === layer || queue.some((e) => e.run.layer === layer);
}

export function queueState(): { running: RunInfo | null; queue: LayerKey[] } {
  return { running: active ? getRun(active.run.id) : null, queue: queue.map((e) => e.run.layer) };
}

/** Queues a run and returns at once with the queued RunInfo; `done` resolves with the final row. */
export function queueLayer(layer: LayerKey, opts: RunOptions): { run: RunInfo; done: Promise<RunInfo> } {
  const config = loadConfig();
  const now = (opts.deps?.now ?? (() => new Date()))();
  const day = localDay(Math.floor(now.getTime() / 1000), safeTimezone(config.timezone));
  const run = createRun({ layer, day, trigger: opts.trigger, status: 'queued', startedAt: now.toISOString() });
  const done = new Promise<RunInfo>((resolve) => {
    queue.push({ run, opts, resolve });
  });
  setImmediate(pump);
  return { run, done };
}

/** Queues a run and waits for it to finish. */
export function runLayer(layer: LayerKey, opts: RunOptions): Promise<RunInfo> {
  return queueLayer(layer, opts).done;
}

function pump(): void {
  if (active) return;
  const entry = queue.shift();
  if (!entry) return;
  active = entry;
  execute(entry)
    .catch((err) => logger.error({ err }, 'radar run crashed'))
    .finally(() => {
      active = null;
      entry.resolve(getRun(entry.run.id) ?? entry.run);
      setImmediate(pump);
    });
}

/** A short message with nothing token-like in it. */
export function safeMessage(err: unknown): string {
  const msg = String((err as Error)?.message ?? err ?? 'Lỗi không rõ');
  return clip(msg.replace(/[A-Za-z0-9_\-]{32,}/g, '…').replace(/(token|key|secret|password)=\S+/gi, '$1=…'), 200);
}

async function execute(entry: Entry): Promise<void> {
  const id = entry.run.id;
  updateRun(id, { status: 'running', phase: 'collect' });
  try {
    await runInner(entry.run, entry.opts);
    updateRun(id, { status: 'ok', phase: 'done', finishedAt: new Date().toISOString() });
  } catch (err) {
    const msg = safeMessage(err);
    logger.warn({ layer: entry.run.layer, err: msg }, 'radar run failed');
    appendRunLog(id, `Lỗi: ${msg}`);
    updateRun(id, { status: 'error', error: msg, finishedAt: new Date().toISOString() });
  }
}

// ── Run ─────────────────────────────────────────────────────────────────

interface Enrich {
  title: string;
  note?: string;
  profession?: string;
  theme?: string;
}

/** An item together with everything the views need. */
interface Pooled { raw: StoredItem; meta: ItemMeta }

function sessionNumber(key: string): number {
  const m = key.match(/^s(\d+)$/);
  return m ? Number(m[1]) : 0;
}

function nextSessionKey(layer: LayerKey, day: string): string {
  const keys = [
    ...okRunsOfDay(layer, day).map((r) => r.sessionKey ?? ''),
    ...loadDayItems(day, layer).map((x) => x.sessionKey),
    ...(getReport(day, layer)?.payload.sessions.map((s) => s.key) ?? []),
  ];
  return `s${Math.max(0, ...keys.map(sessionNumber)) + 1}`;
}

function hourLabel(hour: number): string {
  return `${hour}h`;
}

async function runInner(run: RunInfo, opts: RunOptions): Promise<void> {
  const deps = opts.deps ?? {};
  const layer = run.layer;
  const day = run.day;
  const config = loadConfig();
  const lc = config.layers[layer];
  const tz = safeTimezone(config.timezone);
  const log = (line: string) => appendRunLog(run.id, line, tz);
  const now = (deps.now ?? (() => new Date()))();
  const nowSec = Math.floor(now.getTime() / 1000);
  const runner = deps.runner ?? runRadarAgent;

  const sessionKey = nextSessionKey(layer, day);
  const p = localParts(nowSec, tz);
  const slotHour = Number(lc.time.split(':')[0]) || p.hour;
  const label = `Phiên ${hourLabel(opts.trigger === 'schedule' ? slotHour : p.hour)}`;
  const firstScan = !hasOkRun(layer);
  const windowHours = firstScan ? lc.firstWindowHours : lc.windowHours;
  updateRun(run.id, { sessionKey, label, startedAt: run.startedAt });
  log(`Bắt đầu quét lớp ${lc.label}, lấy bài trong ${windowHours} giờ gần đây${firstScan ? ' (lần quét đầu)' : ''}.`);

  // 1. Collect
  const ctx: CollectContext = {
    layer, config, layerConfig: lc, sinceIso: new Date(now.getTime() - windowHours * 3_600_000).toISOString(), now, log,
    ...(deps.collectDeps ? { deps: deps.collectDeps } : {}),
  };
  const collected: CollectResult = await (deps.collect ?? collectLayer)(ctx);
  log(`Thu được ${collected.items.length} mục từ ${collected.sources.length} nguồn.`);

  let vnChatter: VnChatter | null = null;
  if (layer === 'world' && lc.x.enabled && lc.x.vnCheck) {
    try {
      vnChatter = await (deps.vnChatter ?? collectVnChatter)(ctx, 3);
      if (vnChatter) log(`X tiếng Việt: ${vnChatter.topics.length} chủ đề đang được bàn.`);
    } catch (err) {
      log(`Không kiểm tra được X tiếng Việt: ${safeMessage(err)}`);
    }
  }

  // 2. Merge duplicates, keyword filter, top posts
  const byId = new Map<string, StoredItem>();
  for (const it of collected.items) {
    const prev = byId.get(it.id);
    if (!prev || commentCount(it) > commentCount(prev) || it.comments.length > prev.comments.length) byId.set(it.id, { ...it });
  }
  let items = [...byId.values()];
  if (lc.aiOnly) {
    const before = items.length;
    items = items.filter((it) => isAboutAI(itemSearchText(it), config.aiKeywords));
    log(`Lọc từ khóa AI: giữ ${items.length}/${before} mục.`);
  }

  updateRun(run.id, { phase: 'comments' });
  const posts = items.filter((it) => it.kind !== 'ad');
  const rankedPosts = [...posts].sort((a, b) => commentCount(b) - commentCount(a));
  const toRead = rankedPosts
    .filter((it) => (it.kind === 'fb_group' || it.kind === 'fb_page') && commentCount(it) >= MIN_COMMENTS_TO_READ)
    .slice(0, lc.commentPosts);
  const commentNotes: string[] = [];
  if (toRead.length > 0 && lc.commentPosts > 0) {
    try {
      const map = await (deps.fetchComments ?? fetchFacebookComments)(ctx, toRead.map((it) => it.url), COMMENTS_PER_POST);
      let got = 0;
      for (const it of toRead) {
        const cs = map.get(it.url) ?? map.get(canonicalKey(it.url));
        if (cs && cs.length > it.comments.length) {
          it.comments = cs;
          got++;
        }
      }
      log(`Đọc bình luận: ${got}/${toRead.length} bài.`);
      if (got < toRead.length) commentNotes.push(`Chỉ đọc được bình luận của ${got}/${toRead.length} bài nhiều bình luận nhất.`);
    } catch (err) {
      log(`Không đọc được bình luận: ${safeMessage(err)}`);
      commentNotes.push('Không đọc được bình luận của các bài nhiều bình luận nhất.');
    }
  }

  // 3. Analyse
  updateRun(run.id, { phase: 'analyze' });
  const actx: AnalyzeContext = { layer, config, layerConfig: lc, runner, costUsd: 0, notes: [], log };
  const enrich = items.length ? await enrichItems(actx, items) : { items: new Map<string, ItemEnrichment>(), communities: new Map<string, string>() };
  const kept = items.filter((it) => enrich.items.get(it.id)?.keep !== false);
  log(`Phân tích AI: giữ ${kept.length}/${items.length} mục.`);

  const seen = classifySeen(layer, day, kept.map((it) => ({ id: it.id, url: it.url, title: enrich.items.get(it.id)?.title ?? '', comments: commentCount(it) })));
  const pool: Pooled[] = kept.map((raw) => toPooled(raw, enrich.items.get(raw.id)!, seen.get(raw.id) ?? { isNew: true }, lc, config, sessionKey));

  const own = await analyzePool(actx, pool, collected, vnChatter, day, lc);
  updateRun(run.id, { phase: 'render-data' });

  const ownSession = assembleSession({
    key: sessionKey, label,
    when: whenText({ lc, trigger: opts.trigger, now, tz, slotHour, firstScan, startedAt: run.startedAt }),
    pool, enrichCommunities: enrich.communities, collected, config, lc, now, day, layer, own,
    notes: [...collected.notes, ...commentNotes, ...actx.notes],
  });

  // 4. Persist items, then merge with other sessions of the day
  for (const pl of pool) pl.raw.meta = pl.meta;
  saveSessionItems(day, layer, sessionKey, pool.map((pl) => pl.raw));
  recordSeen(layer, day, pool.map((pl) => ({ id: pl.raw.id, url: pl.raw.url, title: pl.meta.title, comments: commentCount(pl.raw) })));

  const existing = getReport(day, layer)?.payload;
  const earlier = (existing?.sessions ?? []).filter((s) => s.key !== 'all' && s.key !== sessionKey);
  const sessions: SessionView[] = [...earlier, ownSession].sort((a, b) => sessionNumber(a.key) - sessionNumber(b.key));
  let allSession: SessionView | null = null;
  if (sessions.length > 1) {
    const union = new Map<string, Pooled>();
    for (const x of loadDayItems(day, layer)) {
      if (!x.item.meta) continue;
      const prev = union.get(x.item.id);
      if (!prev || commentCount(x.item) >= commentCount(prev.raw)) union.set(x.item.id, { raw: x.item, meta: x.item.meta });
    }
    const unionPool = [...union.values()];
    const all = await analyzePool(actx, unionPool, collected, vnChatter, day, lc);
    allSession = assembleSession({
      key: 'all', label: 'Cả ngày', when: `Cả ngày: gộp ${sessions.length} phiên quét.`,
      pool: unionPool, enrichCommunities: enrich.communities, collected, config, lc, now, day, layer, own: all,
      notes: [...new Set([...sessions.flatMap((s) => s.dataNotes), ...actx.notes])],
    });
    const prevAll = existing?.sessions.find((s) => s.key === 'all');
    if (prevAll) carryIdeaStatus(allSession.ideas, prevAll.ideas);
  }

  const dl = dayLabels(day);
  const payload: ReportPayload = {
    version: 1, layer, layerLabel: lc.label, slotLabel: `phiên ${hourLabel(slotHour)}`, date: day, dateLabel: dl.dateLabel,
    weekday: dl.weekday, owner: config.owner.name, generatedAt: new Date().toISOString(),
    sessions: allSession ? [allSession, ...sessions] : sessions,
  };
  saveReport(payload);

  const cost = (collected.costUsd || 0) + actx.costUsd;
  updateRun(run.id, { itemCount: pool.length, costUsd: Math.round(cost * 10000) / 10000 });
  log(`Xong: ${pool.length} mục, ${ownSession.pains.length} nỗi đau.`);
}

function canonicalKey(url: string): string {
  return url.replace(/\/+$/, '');
}

function carryIdeaStatus(next: IdeaView[], prev: IdeaView[]): void {
  for (const i of next) {
    const m = prev.find((p) => p.channel === i.channel && foldVi(p.title) === foldVi(i.title));
    if (m) i.status = m.status;
  }
}

function toPooled(raw: StoredItem, e: ItemEnrichment, seen: SeenInfo, lc: LayerConfig, config: RadarConfig, sessionKey: string): Pooled {
  const cands = raw.comments.some((c) => classifyBuyComment(c.text, config.buyKeywords));
  const groupProfession = lc.fbGroups.find((g) => g.name === raw.sourceName)?.profession;
  return {
    raw,
    meta: {
      title: e.title, note: e.note, profession: e.profession || groupProfession, theme: e.theme,
      topics: topicsFor(`${raw.title ?? ''} ${raw.text}`, lc.topics), buy: cands, isNew: seen.isNew, rising: seen.rising, sessionKey,
    },
  };
}

function whenText(a: { lc: LayerConfig; trigger: RunTrigger; now: Date; tz: string; slotHour: number; firstScan: boolean; startedAt: string }): string {
  const nowSec = Math.floor(a.now.getTime() / 1000);
  const p = localParts(nowSec, a.tz);
  const utc = utcLabel(a.now, a.tz);
  const dl = dayLabels(localDay(nowSec, a.tz));
  let head: string;
  if (a.trigger === 'schedule') {
    const slotAt = nowSec - (p.hour * 3600 + p.minute * 60) + slotSeconds(a.lc.time);
    const late = nowSec - slotAt > 60 * 60;
    const part = p.hour < 12 ? 'sáng' : p.hour < 18 ? 'chiều' : 'tối';
    head = late ? `Phiên ${a.slotHour}h (chạy bù ${part} ${dl.short}, ${utc}).` : `Phiên ${a.slotHour}h (${utc}).`;
  } else {
    head = `Phiên ${p.hour}h (chạy tay lúc ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}, ${utc}).`;
  }
  const first = a.firstScan
    ? ` Lần quét đầu của lớp này nên lấy bài${a.lc.key === 'nganh' ? ' AI' : ''} trong ${Math.round(a.lc.firstWindowHours / 24)} ngày gần đây.`
    : '';
  return head + first;
}

// ── Analysis over a pool ────────────────────────────────────────────────

interface OwnAnalysis {
  synth: Synthesis;
  comp: CompetitorAnalysis | null;
  candidates: BuyCandidate[];
  resolved: ResolvedPain[];
}

async function analyzePool(
  actx: AnalyzeContext, pool: Pooled[], collected: CollectResult, vnChatter: VnChatter | null, day: string, lc: LayerConfig,
): Promise<OwnAnalysis> {
  const raws = pool.map((p) => p.raw);
  const candidates = buyCandidates(raws, actx.config.buyKeywords);
  const analysisItems: AnalysisItem[] = pool.map((p) => ({
    raw: p.raw, title: p.meta.title, note: p.meta.note, profession: p.meta.profession, theme: p.meta.theme, topics: p.meta.topics,
  }));
  const synth = await synthesize(actx, {
    items: analysisItems, candidates, existingPains: recentPains(day, 30), vnChatter, collectorNotes: collected.notes,
  });
  let comp: CompetitorAnalysis | null = null;
  if (actx.layer === 'vn') {
    const pages = lc.fbPages.filter((pg) => pg.enabled !== false).map((pg) => ({
      name: pg.name, url: pg.url, posts: raws.filter((r) => r.kind === 'fb_page' && sameSource(r, pg.name, pg.url)),
    }));
    const ads = raws.filter((r) => r.ad).map((r) => ({ id: r.ad!.adArchiveId, ad: r.ad! }));
    if (pages.some((pg) => pg.posts.length) || ads.length) comp = await analyzeCompetitors(actx, { pages, ads });
  }
  const resolved = resolvePains(actx.layer, day, synth.pains.map((pn) => ({
    title: pn.title, detail: pn.detail, professions: pn.professions, topics: pn.topics, matchId: pn.matchId,
  })));
  return { synth, comp, candidates, resolved };
}

function sameSource(item: RawItem, name: string, url: string): boolean {
  if (foldVi(item.sourceName) === foldVi(name)) return true;
  return !!item.sourceUrl && canonicalKey(item.sourceUrl) === canonicalKey(url);
}

// ── Session assembly ────────────────────────────────────────────────────

interface AssembleArgs {
  key: string;
  label: string;
  when: string;
  pool: Pooled[];
  enrichCommunities: Map<string, string>;
  collected: CollectResult;
  config: RadarConfig;
  lc: LayerConfig;
  now: Date;
  day: string;
  layer: LayerKey;
  own: OwnAnalysis;
  notes: string[];
}

export function assembleSession(a: AssembleArgs): SessionView {
  const { pool, lc, config, now, own } = a;
  const synth = own.synth;

  // Top posts: most commented, within the window.
  const ranked = pool.filter((p) => p.raw.kind !== 'ad').sort((x, y) => commentCount(y.raw) - commentCount(x.raw));
  const topIds = new Set(ranked.slice(0, TOP_POSTS).filter((p) => commentCount(p.raw) > 0 || ranked.length <= TOP_POSTS).map((p) => p.raw.id));

  const adAnalysis = own.comp?.ads;
  const ads = pool.filter((p) => p.raw.ad);
  const adViews = new Map<string, AdView>();
  for (const p of ads) adViews.set(p.raw.id, buildAdView(p.raw, adAnalysis?.get(p.raw.ad!.adArchiveId), ads.map((x) => x.raw), now));

  const items: ItemView[] = pool.map((p) => {
    const raw = p.raw;
    const metrics = { ...raw.metrics };
    if (metrics.comments === undefined && raw.comments.length) metrics.comments = raw.comments.length;
    const view: ItemView = {
      id: raw.id, kind: raw.kind, sourceName: raw.sourceName, sourceUrl: raw.sourceUrl, url: raw.url, title: p.meta.title,
      note: p.meta.note, typeLabel: typeLabel(raw), metrics, postedAt: raw.postedAt, postedText: raw.postedText,
      within24h: within24h(raw.postedAt, raw.postedText, now), topics: p.meta.topics, profession: p.meta.profession,
      buy: p.meta.buy, top: topIds.has(raw.id), isNew: p.meta.isNew, rising: p.meta.rising, sessionKey: p.meta.sessionKey,
      theme: p.meta.theme,
    };
    if (raw.kind === 'x' || raw.kind === 'threads') view.quote = clip(raw.text, 240);
    const adv = adViews.get(raw.id);
    if (adv) view.ad = adv;
    return view;
  });
  const itemById = new Map(items.map((i) => [i.id, i]));
  // The analyst may answer with topic labels; the heatmap and side panel join on keys.
  const topicKeys = (given: string[], itemIds: (string | undefined)[]): string[] => {
    const byFold = new Map<string, string>();
    for (const t of lc.topics) { byFold.set(foldVi(t.key), t.key); byFold.set(foldVi(t.label), t.key); }
    const keys = new Set(given.map((g) => byFold.get(foldVi(g))).filter((k): k is string => !!k));
    if (keys.size === 0) for (const id of itemIds) for (const k of (id ? itemById.get(id)?.topics : undefined) ?? []) keys.add(k);
    return [...keys];
  };
  const strongest = (ids: string[]): string[] => [...new Set(ids)]
    .filter((id) => itemById.has(id))
    .sort((x, y) => (itemById.get(y)!.metrics.comments ?? 0) - (itemById.get(x)!.metrics.comments ?? 0))
    .slice(0, 3);

  // Pains with ledger ids
  const pains: PainView[] = synth.pains.map((pn, i) => {
    const r = own.resolved[i];
    return {
      id: r.id, rank: i + 1, title: pn.title, detail: pn.detail, professions: pn.professions, topics: topicKeys(pn.topics, pn.itemIds),
      itemIds: strongest(pn.itemIds), isNew: r.isNew, times: r.times, firstSeen: r.firstSeen,
    };
  });
  const painIdOfRank = (rank: number): string | undefined => pains[rank - 1]?.id;

  // Quotes
  const quotes: QuoteView[] = synth.quotes.map((q) => ({
    text: q.text, tag: q.tag, topics: topicKeys(q.topics, [q.itemId]), itemId: q.itemId, profession: q.profession ?? (q.itemId ? itemById.get(q.itemId)?.profession : undefined),
  }));

  // Buy signals: the analyst's picks, else the first keyword candidates.
  const cands = own.candidates;
  let buySignals: BuySignalView[] = synth.buySignals.map((b) => {
    const c = cands[b.candidate - 1];
    const view = itemById.get(c.itemId);
    return {
      type: b.type, text: clip(c.text, 300), context: b.context || contextOf(view), itemId: c.itemId, url: c.url,
    };
  });
  if (buySignals.length === 0) {
    buySignals = cands.filter((c) => !c.seller).slice(0, 12).map((c) => ({
      type: c.type, text: clip(c.text, 300), context: contextOf(itemById.get(c.itemId)), itemId: c.itemId, url: c.url,
    }));
  }
  const sellers = cands.filter((c) => c.seller);
  const sellerNote = synth.sellerNote
    ?? (sellers.length ? `Có ${sellers.length} bình luận của người bán tài khoản hoặc dịch vụ dùng chung, kéo khách về Zalo/inbox; đây là mức giá bạn đang cạnh tranh.` : undefined);

  // Ideas, fears, professions
  const ideas: IdeaView[] = synth.ideas.map((i) => ({
    channel: i.channel, title: i.title, evidence: i.evidence, status: 'todo',
    painIds: i.painRanks.map(painIdOfRank).filter((x): x is string => !!x),
  }));
  const fears: FearView[] = synth.fears.map((f) => {
    const v = f.itemId ? itemById.get(f.itemId) : undefined;
    return { text: f.text, profession: f.profession, context: f.context, url: v?.url };
  });
  const professions: ProfessionView[] = synth.professions.map((pr) => ({
    name: pr.name, initials: initials(pr.name), summary: pr.summary, quote: pr.quote,
    painIds: pr.painRanks.map(painIdOfRank).filter((x): x is string => !!x),
  }));
  const withAi = new Set([...professions.map((x) => x.name), ...items.filter((i) => i.profession).map((i) => i.profession!)]);
  const missingProfessions = a.layer === 'nganh' ? lc.professions.filter((x) => !withAi.has(x)) : [];

  // Communities
  const communities = buildCommunities(a, items, synth, painIdOfRank);

  // Competitors
  const competitors = a.layer === 'vn' ? buildCompetitors(a, items, adViews) : [];

  // Trends
  const trends: TrendView[] = synth.trends.map((t, i) => ({ ...t, rank: i + 1 }));

  const topItems = items.filter((i) => i.top);
  const commentsTotal = topItems.filter((i) => i.within24h).reduce((s, i) => s + (i.metrics.comments ?? 0), 0);
  const buyPosts = topItems.filter((i) => i.buy).length;
  const groups = communities.filter((c) => c.kind === 'fb_group');
  const members = groups.reduce((s, c) => s + (c.members ?? 0), 0);
  // "7 nhóm FB (2,9 triệu thành viên), 4 fanpage, 16 quảng cáo, 37 tin X, Hacker News"
  const sourceParts: string[] = [];
  if (groups.length) sourceParts.push(`${groups.length} ${lc.key === 'nganh' ? 'cộng đồng' : 'nhóm FB'}${members ? ` (${fmtCompact(members)} thành viên)` : ''}`);
  const pageCount = new Set(items.filter((i) => i.kind === 'fb_page').map((i) => i.sourceName)).size;
  if (pageCount) sourceParts.push(`${pageCount} fanpage`);
  const adCount = items.filter((i) => i.kind === 'ad').length;
  if (adCount) sourceParts.push(`${adCount} quảng cáo`);
  const KIND_NAME: Partial<Record<ItemView['kind'], string>> = {
    x: 'X', hn: 'Hacker News', reddit: 'Reddit', youtube: 'YouTube', github: 'GitHub',
    tiktok: 'TikTok', threads: 'Threads', instagram: 'Instagram', news: 'báo chí',
  };
  const otherKinds = [...new Set(items.map((i) => i.kind))].filter((k) => KIND_NAME[k]);
  const otherCount = items.filter((i) => KIND_NAME[i.kind]).length;
  if (otherCount) sourceParts.push(`${otherCount} tin ${otherKinds.map((k) => KIND_NAME[k]).join(', ')}`);

  return {
    key: a.key,
    label: a.label,
    scan: {
      when: a.when,
      sources: sourceParts.join(', ') || 'Không có nguồn nào trả dữ liệu',
      top: `${topItems.length} bài, ${fmtInt(commentsTotal)} bình luận, ${buyPosts} bài có tín hiệu mua`,
    },
    topics: lc.topics,
    communities,
    items,
    pains,
    quotes,
    buySignals,
    sellerNote,
    tools: synth.tools,
    ideas,
    fears,
    professions,
    missingProfessions,
    competitors,
    otherAdvertisers: own.comp?.otherAdvertisers ?? [],
    gap: own.comp?.gap ?? null,
    trends,
    dataNotes: [...new Set(a.notes)],
  };
}

function contextOf(view: ItemView | undefined): string {
  if (!view) return '';
  const c = view.metrics.comments;
  return `${view.profession ? `${view.profession}, ` : ''}${clip(view.title, 90)}${c ? ` (${fmtInt(c)} bình luận)` : ''}`;
}

function statFor(stats: SourceStat[], name: string, kind?: string): SourceStat | undefined {
  return stats.find((s) => s.name === name && (!kind || s.kind === kind)) ?? stats.find((s) => foldVi(s.name) === foldVi(name));
}

function buildCommunities(a: AssembleArgs, items: ItemView[], synth: Synthesis, painIdOfRank: (n: number) => string | undefined): CommunityView[] {
  const { lc, collected } = a;
  const bySource = new Map<string, ItemView[]>();
  for (const it of items) {
    if (it.kind === 'ad' || it.kind === 'fb_page') continue;
    const list = bySource.get(it.sourceName) ?? [];
    list.push(it);
    bySource.set(it.sourceName, list);
  }
  const order: string[] = [];
  for (const g of lc.fbGroups) {
    if (g.enabled === false) continue;
    const st = statFor(collected.sources, g.name, 'fb_group');
    if (bySource.has(g.name) || st?.ok) order.push(g.name);
  }
  for (const [name] of [...bySource.entries()].sort((x, y) => y[1].length - x[1].length)) if (!order.includes(name)) order.push(name);

  return order.map((name) => {
    const group = lc.fbGroups.find((g) => g.name === name);
    const list = bySource.get(name) ?? [];
    const st = statFor(collected.sources, name);
    const first = list[0];
    const painRank = synth.communityPains.get(name);
    return {
      name,
      url: group?.url ?? st?.url ?? first?.sourceUrl,
      kind: group ? 'fb_group' : first?.kind ?? st?.kind ?? 'fb_group',
      members: st?.members ?? group?.members,
      followers: st?.followers,
      profession: group?.profession,
      summary: a.enrichCommunities.get(name) ?? '',
      painId: painRank ? painIdOfRank(painRank) : undefined,
    } as CommunityView;
  });
}

function buildCompetitors(a: AssembleArgs, items: ItemView[], adViews: Map<string, AdView>): CompetitorView[] {
  const { lc, own, collected } = a;
  const out: CompetitorView[] = [];
  for (const pg of lc.fbPages) {
    if (pg.enabled === false) continue;
    const posts = items.filter((i) => i.kind === 'fb_page' && (foldVi(i.sourceName) === foldVi(pg.name) || (i.sourceUrl && canonicalKey(i.sourceUrl) === canonicalKey(pg.url))));
    const st = statFor(collected.sources, pg.name, 'fb_page');
    const analysis = own.comp?.pages.get(foldVi(pg.name));
    const activeAds = [...adViews.values()].filter((ad) => ad.pageUrl && canonicalKey(ad.pageUrl) === canonicalKey(pg.url) || foldVi(ad.advertiser) === foldVi(pg.name)).length;
    if (posts.length === 0 && !analysis && !st?.ok) continue;
    const sorted = [...posts].sort((x, y) => (y.metrics.comments ?? 0) - (x.metrics.comments ?? 0));
    out.push({
      name: pg.name, url: pg.url, initials: initials(pg.name), followers: st?.followers, activeAds: st?.activeAds ?? activeAds,
      posts: analysis?.posts ?? (posts.length ? `${posts.length} bài trong cửa sổ quét` : 'Không có bài mới'),
      sells: analysis?.sells ?? 'Chưa rõ', price: analysis?.price ?? 'Không công khai',
      topPostId: sorted[0]?.id, postIds: sorted.map((p) => p.id),
    });
  }
  return out;
}

function hostsOf(ad: NonNullable<RawItem['ad']>, funnel: AdView['funnel']): string {
  return landingLabel(ad, funnel);
}

function buildAdView(raw: RawItem, an: { product: string; headline: string; audience?: string; segment: AdView['segment']; priceModel: AdView['priceModel']; price: string; sellsBook: boolean } | undefined, allAds: RawItem[], now: Date): AdView {
  const ad = raw.ad!;
  const { funnel, label } = adFunnel(ad);
  const body = [ad.title, ad.bodyText, ad.linkDescription].filter(Boolean).join(' ');
  const priceModel = an?.priceModel ?? (funnel === 'zoom' ? 'free' : 'hidden');
  return {
    adArchiveId: ad.adArchiveId,
    advertiser: ad.pageName,
    pageUrl: ad.pageUrl,
    libraryUrl: ad.libraryUrl,
    product: an?.product || clip(ad.title || ad.bodyText || raw.title || raw.text || ad.pageName, 70),
    headline: an?.headline || clip(ad.bodyText || ad.title || raw.text, 120),
    funnel,
    funnelLabel: label,
    format: adFormatLabel(ad.displayFormat),
    audience: an?.audience,
    startDate: ad.startDate,
    daysRunning: daysRunning(ad.startDate, now, ad.endDate),
    versions: ad.versions,
    price: an?.price ?? (priceModel === 'free' ? 'Miễn phí' : 'Không công khai'),
    cta: ad.ctaText || 'Không ghi',
    landing: hostsOf(ad, funnel),
    segment: an?.segment ?? 'mass',
    priceModel,
    sellsBook: an?.sellsBook ?? sellsBook(body),
    otherAdIds: allAds.filter((x) => x.ad && x.ad.adArchiveId !== ad.adArchiveId && foldVi(x.ad.pageName) === foldVi(ad.pageName)).map((x) => x.ad!.adArchiveId),
  };
}
