/** One function per source: fetch, map to RawItem, report a SourceStat. Failures never throw out of here. */

import { socialHandle } from '../channels.js';
import type { AdDetails, FbGroupSource, FbPageSource, LayerKey, RawComment, RawItem, SourceStat } from '../types.js';
import { canonicalUrl, clip } from '../util.js';
import { ApifyError, getApifyTokens, memoryRotationStore, runActorRotating } from './apify.js';
import { profileExists, type BrowserSession } from './fb-browser.js';
import type { CollectContext } from './index.js';
import { collapse, hostOf, makeItem, mapComments, num, obj, parseFeed, pick, str, stripHtml, toIso, windowDays } from './parse.js';

/** Apify documents topReactionsCount ambiguously (count of reaction types on some actors): take the larger of the two. */
function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

export const ACTORS = {
  fbGroups: 'apify/facebook-groups-scraper',
  fbComments: 'apify/facebook-comments-scraper',
  fbPosts: 'apify/facebook-posts-scraper',
  fbPages: 'apify/facebook-pages-scraper',
  ads: 'apify/facebook-ads-scraper',
  instagram: 'apify/instagram-scraper',
  tiktok: 'clockworks/tiktok-scraper',
  threads: 'futurizerush/meta-threads-scraper',
  reddit: 'trudax/reddit-scraper-lite',
} as const;

export interface Outcome { items: RawItem[]; sources: SourceStat[]; notes: string[]; costUsd: number }
const empty = (): Outcome => ({ items: [], sources: [], notes: [], costUsd: 0 });

const UA = 'FreedomOS-Radar/1.0 (+https://github.com)';

export function safeError(e: unknown): string {
  if (e instanceof ApifyError) return e.message;
  return clip(e instanceof Error ? e.message.replace(/https?:\/\/\S+/g, '[url]') : 'lỗi không xác định', 160);
}

/** Injected tokens (tests) rotate in memory; the app keeps its cursor in dashboard settings. */
const testRotation = memoryRotationStore();

/** One actor run on the next Apify token in turn (falls back to `token` when no list is stored). */
async function actor(ctx: CollectContext, token: string, id: string, input: Record<string, unknown>, limit: number) {
  const tokens = getApifyTokens(ctx.deps);
  const injected = !!ctx.deps && ('apifyToken' in ctx.deps || 'apifyTokens' in ctx.deps);
  return runActorRotating(id, input, {
    tokens: tokens.length ? tokens : [token],
    store: ctx.deps?.apifyStore ?? (injected ? testRotation : undefined),
    fetchImpl: ctx.deps?.fetchImpl, signal: ctx.signal, limit, pollMs: ctx.deps?.pollMs,
    onSwitch: (line) => ctx.log(line),
  });
}

async function getText(ctx: CollectContext, url: string): Promise<string> {
  const f = ctx.deps?.fetchImpl ?? fetch;
  const res = await f(url, { signal: ctx.signal, headers: { 'User-Agent': UA, Accept: '*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const day = (iso: string) => iso.slice(0, 10);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ── Facebook groups ─────────────────────────────────────────────────────

export function mapGroupPost(raw: unknown, layer: LayerKey, group: FbGroupSource): RawItem | null {
  const o = obj(raw);
  const url = str(pick(o, 'url', 'topLevelUrl', 'postUrl'));
  if (!url) return null;
  const att = arr(o.attachments ?? o.media);
  const isVideo = att.some((a) => /video/i.test(String(obj(a).__typename ?? obj(a).type ?? '')));
  return makeItem({
    layer, kind: 'fb_group', via: 'apify', sourceName: group.name, sourceUrl: group.url, url,
    author: str(obj(o.user).name), text: str(o.text) ?? '', postedAt: toIso(pick(o, 'time', 'timestamp')),
    metrics: { comments: num(o.commentsCount), reactions: maxDefined(num(o.likesCount), num(o.topReactionsCount)), shares: num(o.sharesCount) },
    comments: mapComments(o.topComments),
    media: isVideo ? 'video' : att.length > 1 ? 'album' : att.length === 1 ? 'image' : 'text',
  });
}

export const GROUP_PRIVATE_NOTE = (name: string) =>
  `Nhóm ${name}: không đọc được qua Apify (có thể là nhóm riêng tư). Đăng nhập Facebook trong Chrome của Radar để đọc nhóm riêng tư.`;

export async function collectFbGroup(
  ctx: CollectContext, token: string | null, group: FbGroupSource, getBrowser: () => Promise<BrowserSession | null>,
): Promise<Outcome> {
  const out = empty();
  const mode = group.mode ?? 'auto';
  const max = ctx.layerConfig.maxPerSource;
  const stat: SourceStat = { kind: 'fb_group', name: group.name, url: group.url, via: 'apify', ok: false, count: 0, ...(group.members ? { members: group.members } : {}) };
  let apifyFailed = false;
  if (mode !== 'browser') {
    if (!token) { apifyFailed = true; stat.error = 'Chưa có Apify token.'; }
    else {
      try {
        ctx.log(`Nhóm ${group.name}: đọc qua Apify…`);
        const r = await actor(ctx, token, ACTORS.fbGroups, {
          startUrls: [{ url: group.url }], resultsLimit: max, viewOption: 'CHRONOLOGICAL', onlyPostsNewerThan: day(ctx.sinceIso),
        }, max);
        out.costUsd += r.costUsd;
        out.items = r.items.map((x) => mapGroupPost(x, ctx.layer, group)).filter((x): x is RawItem => !!x);
        if (out.items.length) { stat.ok = true; stat.count = out.items.length; out.sources.push(stat); return out; }
        apifyFailed = true;
        stat.error = 'Apify không trả bài nào.';
      } catch (e) { apifyFailed = true; stat.error = safeError(e); }
    }
  }
  if (mode === 'apify' || (mode === 'auto' && !apifyFailed)) { out.sources.push(stat); return out; }
  // Browser: explicit browser mode, or auto after Apify came back empty / failed.
  if (profileExists()) {
    const browser = await getBrowser();
    if (browser) {
      ctx.log(`Nhóm ${group.name}: đọc bằng Chrome của Radar…`);
      const r = await browser.readGroup(group, ctx.layer, ctx.now, max);
      stat.via = 'browser';
      if (r.error) { stat.error = r.error; out.notes.push(`Nhóm ${group.name}: ${r.error}`); }
      else { stat.ok = true; stat.count = r.items.length; delete stat.error; out.items = r.items; if (r.members) stat.members = r.members; }
      out.sources.push(stat);
      return out;
    }
  }
  if (mode === 'browser') { stat.via = 'browser'; stat.error = 'Chưa dùng được Chrome của Radar (cần playwright và phiên đăng nhập Facebook).'; out.notes.push(`Nhóm ${group.name}: ${stat.error}`); }
  else out.notes.push(GROUP_PRIVATE_NOTE(group.name));
  out.sources.push(stat);
  return out;
}

// ── Facebook comments ───────────────────────────────────────────────────

export function groupCommentsByPost(rows: unknown[], requested: string[]): Map<string, RawComment[]> {
  const wanted = new Set(requested.map(canonicalUrl));
  const out = new Map<string, RawComment[]>();
  for (const r of rows) {
    const o = obj(r);
    const post = str(pick(o, 'facebookUrl', 'postUrl', 'inputUrl'));
    let key = post ? canonicalUrl(post) : '';
    if (!wanted.has(key)) key = requested.length === 1 ? canonicalUrl(requested[0]) : '';
    if (!key) continue;
    const c = mapComments([o])[0];
    if (!c) continue;
    const list = out.get(key) ?? [];
    list.push(c);
    out.set(key, list);
  }
  return out;
}

export async function apifyComments(ctx: CollectContext, token: string, urls: string[], perPost: number): Promise<{ map: Map<string, RawComment[]>; costUsd: number }> {
  const r = await actor(ctx, token, ACTORS.fbComments, {
    startUrls: urls.map((url) => ({ url })), resultsLimit: perPost * urls.length, includeNestedComments: false,
  }, Math.min(perPost * urls.length, 1000));
  const map = groupCommentsByPost(r.items, urls);
  for (const [k, v] of map) map.set(k, v.slice(0, perPost));
  return { map, costUsd: r.costUsd };
}

// ── Facebook pages (competitor fanpages) ────────────────────────────────

export async function collectFbPages(ctx: CollectContext, token: string, pages: FbPageSource[]): Promise<Outcome> {
  const out = empty();
  if (!pages.length) return out;
  const max = ctx.layerConfig.maxPerSource;
  const byKey = new Map(pages.map((p) => [canonicalUrl(p.url).toLowerCase(), p]));
  const stats = new Map<string, SourceStat>(pages.map((p) => [p.name, { kind: 'fb_page', name: p.name, url: p.url, via: 'apify', ok: false, count: 0 }]));
  try {
    ctx.log(`Fanpage đối thủ: đọc ${pages.length} trang qua Apify…`);
    const r = await actor(ctx, token, ACTORS.fbPosts, { startUrls: pages.map((p) => ({ url: p.url })), resultsLimit: max, onlyPostsNewerThan: day(ctx.sinceIso) }, max * pages.length);
    out.costUsd += r.costUsd;
    for (const row of r.items) {
      const o = obj(row);
      const url = str(pick(o, 'url', 'postUrl'));
      if (!url) continue;
      const pageUrl = str(pick(o, 'facebookUrl', 'inputUrl', 'pageUrl'));
      const pageName = str(o.pageName);
      const page = (pageUrl && byKey.get(canonicalUrl(pageUrl).toLowerCase()))
        || pages.find((p) => pageName && p.name.toLowerCase() === pageName.toLowerCase())
        || (pages.length === 1 ? pages[0] : undefined);
      if (!page) continue;
      out.items.push(makeItem({
        layer: ctx.layer, kind: 'fb_page', via: 'apify', sourceName: page.name, sourceUrl: page.url, url,
        author: pageName ?? page.name, text: str(o.text) ?? '', postedAt: toIso(pick(o, 'time', 'timestamp')),
        metrics: { comments: num(o.comments) ?? num(o.commentsCount), reactions: maxDefined(num(o.likes) ?? num(o.likesCount), num(o.topReactionsCount)), shares: num(o.shares) ?? num(o.sharesCount), views: num(pick(o, 'viewsCount', 'playCount')) },
        comments: mapComments(o.topComments),
        media: arr(o.media).length ? (arr(o.media).some((m) => /video/i.test(String(obj(m).__typename ?? obj(m).type ?? ''))) ? 'video' : 'image') : 'text',
      }));
    }
    for (const it of out.items) { const s = stats.get(it.sourceName); if (s) { s.ok = true; s.count++; } }
    for (const s of stats.values()) if (!s.count) { s.ok = true; }
  } catch (e) {
    for (const s of stats.values()) s.error = safeError(e);
  }
  // Followers: nice to have, never fails the source.
  try {
    const r = await actor(ctx, token, ACTORS.fbPages, { startUrls: pages.map((p) => ({ url: p.url })) }, pages.length * 2);
    out.costUsd += r.costUsd;
    for (const row of r.items) {
      const o = obj(row);
      const u = str(pick(o, 'pageUrl', 'facebookUrl', 'url'));
      const p = (u && byKey.get(canonicalUrl(u).toLowerCase())) || pages.find((x) => str(o.title)?.toLowerCase() === x.name.toLowerCase());
      const followers = num(o.followers) ?? num(o.likes);
      const s = p ? stats.get(p.name) : undefined;
      if (s && followers !== undefined) s.followers = followers;
    }
  } catch { /* followers are optional */ }
  out.sources.push(...stats.values());
  return out;
}

// ── Meta Ad Library ─────────────────────────────────────────────────────

export function adLibraryUrl(country: string, query: string): string {
  return `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${encodeURIComponent(country)}&q=${encodeURIComponent(query)}&search_type=keyword_unordered&media_type=all`;
}

export function mapAd(raw: unknown, layer: LayerKey): RawItem | null {
  const o = obj(raw);
  const adArchiveId = str(pick(o, 'adArchiveId', 'ad_archive_id', 'adArchiveID', 'id'));
  if (!adArchiveId) return null;
  const snap = obj(o.snapshot);
  const cards = arr(snap.cards).map(obj);
  const bodyText = str(obj(snap.body).text) ?? str(snap.body) ?? str(cards[0]?.body) ?? '';
  const pageName = str(pick(o, 'pageName', 'page_name')) ?? str(snap.page_name) ?? str(snap.pageName) ?? 'Không rõ';
  const pageId = str(pick(o, 'pageId', 'page_id'));
  const pageUrl = str(pick(snap, 'pageProfileUri', 'page_profile_uri')) ?? (pageId ? `https://www.facebook.com/${pageId}` : undefined);
  const libraryUrl = `https://www.facebook.com/ads/library/?id=${adArchiveId}`;
  const ad: AdDetails = {
    adArchiveId, pageName, libraryUrl,
    ...(pageUrl ? { pageUrl } : {}), ...(pageId ? { pageId } : {}),
    ...(toIso(pick(o, 'startDate', 'start_date', 'startDateFormatted')) ? { startDate: toIso(pick(o, 'startDate', 'start_date', 'startDateFormatted')) } : {}),
    ...(toIso(pick(o, 'endDate', 'end_date', 'endDateFormatted')) ? { endDate: toIso(pick(o, 'endDate', 'end_date', 'endDateFormatted')) } : {}),
    ...(typeof (o.isActive ?? o.is_active) === 'boolean' ? { isActive: (o.isActive ?? o.is_active) as boolean } : {}),
    ...(num(pick(o, 'collationCount', 'collation_count')) !== undefined ? { versions: num(pick(o, 'collationCount', 'collation_count')) } : {}),
    ...(str(pick(snap, 'ctaText', 'cta_text')) ? { ctaText: str(pick(snap, 'ctaText', 'cta_text')) } : {}),
    ...(str(pick(snap, 'ctaType', 'cta_type')) ? { ctaType: str(pick(snap, 'ctaType', 'cta_type')) } : {}),
    ...((str(pick(snap, 'linkUrl', 'link_url')) ?? str(cards[0]?.linkUrl ?? cards[0]?.link_url)) ? { landingUrl: str(pick(snap, 'linkUrl', 'link_url')) ?? str(cards[0]?.linkUrl ?? cards[0]?.link_url) } : {}),
    ...(str(pick(snap, 'displayFormat', 'display_format')) ? { displayFormat: str(pick(snap, 'displayFormat', 'display_format')) } : {}),
    ...(bodyText ? { bodyText: collapse(bodyText, 2000) } : {}),
    ...(str(snap.title) ?? str(cards[0]?.title) ? { title: str(snap.title) ?? str(cards[0]?.title) } : {}),
    ...(str(pick(snap, 'linkDescription', 'link_description')) ? { linkDescription: str(pick(snap, 'linkDescription', 'link_description')) } : {}),
  };
  return makeItem({
    layer, kind: 'ad', via: 'apify', sourceName: pageName, sourceUrl: pageUrl, url: libraryUrl, author: pageName,
    title: ad.title, text: bodyText, postedAt: ad.startDate, ad,
    media: /video/i.test(ad.displayFormat ?? '') ? 'video' : cards.length > 1 ? 'album' : 'image',
  });
}

export async function collectAds(ctx: CollectContext, token: string): Promise<Outcome> {
  const out = empty();
  const cfg = ctx.layerConfig.adLibrary;
  const urls = [...cfg.queries.filter((q) => q.trim()).map((q) => adLibraryUrl(cfg.country || 'VN', q.trim())), ...cfg.pageUrls.filter((u) => u.trim())];
  const stat: SourceStat = { kind: 'ad', name: 'Meta Ad Library', via: 'apify', ok: false, count: 0 };
  if (!urls.length) return out;
  const limit = Math.min(ctx.layerConfig.maxPerSource * urls.length, 500);
  try {
    ctx.log(`Meta Ad Library: đọc ${urls.length} đường dẫn qua Apify…`);
    const r = await actor(ctx, token, ACTORS.ads, { startUrls: urls.map((url) => ({ url })), resultsLimit: limit, activeStatus: 'active', isDetailsPerAd: false }, limit);
    out.costUsd += r.costUsd;
    const seen = new Set<string>();
    for (const row of r.items) {
      const it = mapAd(row, ctx.layer);
      if (!it?.ad || seen.has(it.ad.adArchiveId)) continue;
      seen.add(it.ad.adArchiveId);
      out.items.push(it);
    }
    stat.ok = true; stat.count = out.items.length; stat.activeAds = out.items.filter((i) => i.ad?.isActive !== false).length;
  } catch (e) { stat.error = safeError(e); }
  out.sources.push(stat);
  return out;
}

// ── Instagram / TikTok / Threads ────────────────────────────────────────

export async function collectInstagram(ctx: CollectContext, token: string, handles: string[]): Promise<Outcome> {
  const out = empty();
  const list = handles.map((h) => socialHandle(h, 'instagram')).filter(Boolean);
  if (!list.length) return out;
  const max = ctx.layerConfig.maxPerSource;
  const stats = new Map<string, SourceStat>(list.map((h) => [h.toLowerCase(), { kind: 'instagram', name: `@${h}`, url: `https://www.instagram.com/${h}/`, via: 'apify', ok: false, count: 0 }]));
  try {
    ctx.log(`Instagram: đọc ${list.length} tài khoản qua Apify…`);
    const r = await actor(ctx, token, ACTORS.instagram, { directUrls: list.map((h) => `https://www.instagram.com/${h}/`), resultsType: 'posts', resultsLimit: max, onlyPostsNewerThan: day(ctx.sinceIso) }, max * list.length);
    out.costUsd += r.costUsd;
    for (const row of r.items) {
      const o = obj(row);
      const url = str(o.url);
      if (!url) continue;
      const owner = str(o.ownerUsername) ?? '';
      const type = String(o.type ?? '');
      out.items.push(makeItem({
        layer: ctx.layer, kind: 'instagram', via: 'apify', sourceName: `@${owner || 'instagram'}`, sourceUrl: owner ? `https://www.instagram.com/${owner}/` : undefined,
        url, author: owner || undefined, text: str(o.caption) ?? '', postedAt: toIso(o.timestamp),
        metrics: { likes: num(o.likesCount), comments: num(o.commentsCount), views: num(o.videoViewCount) ?? num(o.videoPlayCount) },
        comments: mapComments(o.latestComments),
        media: /video/i.test(type) ? 'video' : /sidecar/i.test(type) ? 'album' : 'image',
      }));
    }
    for (const it of out.items) { const s = stats.get((it.author ?? '').toLowerCase()); if (s) s.count++; }
    for (const s of stats.values()) s.ok = true;
  } catch (e) { for (const s of stats.values()) s.error = safeError(e); }
  out.sources.push(...stats.values());
  return out;
}

export async function collectTiktok(ctx: CollectContext, token: string, queries: string[]): Promise<Outcome> {
  const out = empty();
  const qs = queries.map((q) => q.trim()).filter(Boolean);
  if (!qs.length) return out;
  const max = ctx.layerConfig.maxPerSource;
  const stat: SourceStat = { kind: 'tiktok', name: 'TikTok', via: 'apify', ok: false, count: 0 };
  try {
    ctx.log(`TikTok: tìm ${qs.length} từ khoá qua Apify…`);
    const r = await actor(ctx, token, ACTORS.tiktok, {
      searchQueries: qs, searchSection: '/video', resultsPerPage: max, oldestPostDateUnified: `${windowDays(ctx.sinceIso, ctx.now)} days`,
    }, max * qs.length);
    out.costUsd += r.costUsd;
    for (const row of r.items) {
      const o = obj(row);
      const url = str(pick(o, 'webVideoUrl', 'url'));
      if (!url) continue;
      const author = str(obj(o.authorMeta).name);
      out.items.push(makeItem({
        layer: ctx.layer, kind: 'tiktok', via: 'apify', sourceName: 'TikTok', url, author, text: str(o.text) ?? '',
        postedAt: toIso(pick(o, 'createTimeISO', 'createTime')),
        metrics: { views: num(o.playCount), likes: num(o.diggCount), comments: num(o.commentCount), shares: num(o.shareCount), saves: num(o.collectCount) },
        media: 'video',
      }));
    }
    stat.ok = true; stat.count = out.items.length;
  } catch (e) { stat.error = safeError(e); }
  out.sources.push(stat);
  return out;
}

export async function collectThreads(ctx: CollectContext, token: string, queries: string[]): Promise<Outcome> {
  const out = empty();
  const qs = queries.map((q) => q.trim()).filter(Boolean).slice(0, 20);
  if (!qs.length) return out;
  const max = Math.max(10, ctx.layerConfig.maxPerSource);
  const stat: SourceStat = { kind: 'threads', name: 'Threads', via: 'apify', ok: false, count: 0 };
  try {
    ctx.log(`Threads: tìm ${qs.length} từ khoá qua Apify…`);
    const r = await actor(ctx, token, ACTORS.threads, { mode: 'search', keywords: qs, search_filter: 'recent', start_date: `${windowDays(ctx.sinceIso, ctx.now)} days`, max_posts: max }, max * qs.length);
    out.costUsd += r.costUsd;
    for (const row of r.items) {
      const o = obj(row);
      const url = str(pick(o, 'post_url', 'url'));
      if (!url) continue;
      out.items.push(makeItem({
        layer: ctx.layer, kind: 'threads', via: 'apify', sourceName: 'Threads', url, author: str(o.username), text: str(pick(o, 'text_content', 'text')) ?? '',
        postedAt: toIso(pick(o, 'created_at', 'created_at_timestamp')),
        metrics: { likes: num(o.like_count), replies: num(o.reply_count), reposts: num(o.repost_count), quotes: num(o.quote_count), views: num(o.view_count) },
      }));
    }
    stat.ok = true; stat.count = out.items.length;
  } catch (e) { stat.error = safeError(e); }
  out.sources.push(stat);
  return out;
}

// ── Reddit / Hacker News / YouTube / GitHub / News ──────────────────────

export async function collectReddit(ctx: CollectContext, token: string | null, subs: string[]): Promise<Outcome> {
  const out = empty();
  const list = subs.map((s) => s.replace(/^\/?r\//, '').trim()).filter(Boolean);
  if (!list.length) return out;
  const max = ctx.layerConfig.maxPerSource;
  const stats = new Map<string, SourceStat>(list.map((s) => [s, { kind: 'reddit', name: `r/${s}`, url: `https://www.reddit.com/r/${s}/`, via: token ? 'apify' : 'rss', ok: false, count: 0 }]));
  if (token) {
    try {
      ctx.log(`Reddit: đọc ${list.length} subreddit qua Apify…`);
      const r = await actor(ctx, token, ACTORS.reddit, {
        startUrls: list.map((s) => ({ url: `https://www.reddit.com/r/${s}/top/?t=day` })), maxItems: max * list.length, skipComments: true, includeMediaLinks: true,
      }, max * list.length);
      out.costUsd += r.costUsd;
      for (const row of r.items) {
        const o = obj(row);
        if (String(o.dataType ?? 'post') === 'comment') continue;
        const url = str(o.url);
        if (!url) continue;
        const sub = (str(o.communityName) ?? '').replace(/^r\//, '') || list[0];
        out.items.push(makeItem({
          layer: ctx.layer, kind: 'reddit', via: 'apify', sourceName: `r/${sub}`, sourceUrl: `https://www.reddit.com/r/${sub}/`, url,
          author: str(o.username), title: str(o.title), text: str(o.body) ?? str(o.title) ?? '', postedAt: toIso(o.createdAt),
          metrics: { points: num(o.upVotes), comments: num(o.numberOfComments) },
        }));
      }
      for (const it of out.items) { const s = stats.get(it.sourceName.slice(2)); if (s) s.count++; }
      for (const s of stats.values()) s.ok = true;
      out.sources.push(...stats.values());
      return out;
    } catch (e) { out.notes.push(`Reddit: Apify lỗi (${safeError(e)}), chuyển sang RSS miễn phí.`); }
  }
  let rssOk = false;
  for (const sub of list) {
    const s = stats.get(sub)!;
    s.via = 'rss';
    try {
      const xml = await getText(ctx, `https://www.reddit.com/r/${sub}/top/.rss?t=day`);
      for (const e of parseFeed(xml).slice(0, max)) {
        if (!e.link) continue;
        out.items.push(makeItem({
          layer: ctx.layer, kind: 'reddit', via: 'rss', sourceName: `r/${sub}`, sourceUrl: `https://www.reddit.com/r/${sub}/`, url: e.link,
          author: e.author?.replace(/^\/?u\//, ''), title: e.title, text: e.description || e.title, postedAt: e.published, metrics: {},
        }));
        s.count++;
      }
      s.ok = true; rssOk = true;
    } catch (e) { s.error = safeError(e); }
  }
  if (rssOk) out.notes.push('Reddit đọc qua RSS miễn phí nên không có điểm (upvote) và số bình luận. Thêm Apify token để có số liệu.');
  out.sources.push(...stats.values());
  return out;
}

export async function collectHn(ctx: CollectContext, minPoints: number): Promise<Outcome> {
  const out = empty();
  const stat: SourceStat = { kind: 'hn', name: 'Hacker News', url: 'https://news.ycombinator.com/', via: 'api', ok: false, count: 0 };
  try {
    const raw = JSON.parse(await getText(ctx, 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=60')) as { hits?: unknown[] };
    const since = Math.floor(new Date(ctx.sinceIso).getTime() / 1000);
    for (const h of raw.hits ?? []) {
      const o = obj(h);
      const at = num(o.created_at_i) ?? 0;
      const points = num(o.points) ?? 0;
      const id = str(o.objectID);
      if (!id || at < since || points < minPoints) continue;
      const hnUrl = `https://news.ycombinator.com/item?id=${id}`;
      out.items.push(makeItem({
        layer: ctx.layer, kind: 'hn', via: 'api', sourceName: 'Hacker News', sourceUrl: hnUrl, url: str(o.url) ?? hnUrl, author: str(o.author),
        title: str(o.title), text: str(o.title) ?? '', postedAt: new Date(at * 1000).toISOString(), metrics: { points, comments: num(o.num_comments) },
      }));
    }
    out.items = out.items.slice(0, ctx.layerConfig.maxPerSource);
    stat.ok = true; stat.count = out.items.length;
  } catch (e) { stat.error = safeError(e); }
  out.sources.push(stat);
  return out;
}

const YT_ID = /^UC[A-Za-z0-9_-]{22}$/;

/**
 * The owner may paste a channel id, an @handle or any channel link. Returns the id when the input already
 * holds one, else the page url to read it from, else null.
 */
export function parseYoutubeChannelInput(input: string): { id: string } | { pageUrl: string } | null {
  const v = input.trim();
  if (!v) return null;
  if (YT_ID.test(v)) return { id: v };
  const inUrl = v.match(/\/channel\/(UC[A-Za-z0-9_-]{22})/);
  if (inUrl) return { id: inUrl[1] };
  if (/^@[\w.-]+$/.test(v)) return { pageUrl: `https://www.youtube.com/${v}` };
  if (/^(https?:\/\/)?(www\.|m\.)?youtube\.com\/(@[\w.-]+|c\/[\w.-]+|user\/[\w.-]+)/i.test(v)) {
    return { pageUrl: v.startsWith('http') ? v : `https://${v}` };
  }
  return null;
}

/** Channel id read from a channel page ("externalId" or the canonical link). */
export function youtubeIdFromPage(html: string): string | null {
  const m = html.match(/"externalId":"(UC[A-Za-z0-9_-]{22})"/) ?? html.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/);
  return m ? m[1] : null;
}

async function resolveYoutubeChannelId(ctx: CollectContext, input: string): Promise<string | null> {
  const parsed = parseYoutubeChannelInput(input);
  if (!parsed) return null;
  if ('id' in parsed) return parsed.id;
  const f = ctx.deps?.fetchImpl ?? fetch;
  // A browser user agent: YouTube serves a consent page to unknown agents.
  const res = await f(parsed.pageUrl, {
    signal: ctx.signal,
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', 'Accept-Language': 'en-US' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return youtubeIdFromPage(await res.text());
}

export async function collectYoutube(ctx: CollectContext, channels: { name: string; channelId: string }[]): Promise<Outcome> {
  const out = empty();
  for (const ch of channels) {
    if (!ch.channelId?.trim()) { out.notes.push(`YouTube ${ch.name}: chưa có link kênh, @handle hoặc Channel ID nên bỏ qua.`); continue; }
    const stat: SourceStat = { kind: 'youtube', name: ch.name, url: `https://www.youtube.com/channel/${ch.channelId}`, via: 'rss', ok: false, count: 0 };
    try {
      const channelId = await resolveYoutubeChannelId(ctx, ch.channelId);
      if (!channelId) throw new Error('không tìm ra Channel ID từ giá trị đã nhập');
      stat.url = `https://www.youtube.com/channel/${channelId}`;
      const xml = await getText(ctx, `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`);
      for (const e of parseFeed(xml).slice(0, ctx.layerConfig.maxPerSource)) {
        if (!e.link) continue;
        out.items.push(makeItem({
          layer: ctx.layer, kind: 'youtube', via: 'rss', sourceName: ch.name, sourceUrl: stat.url, url: e.link, author: ch.name, title: e.title,
          text: e.description || e.title, postedAt: e.published, metrics: { views: e.views }, media: 'video',
        }));
        stat.count++;
      }
      stat.ok = true;
    } catch (e) { stat.error = safeError(e); }
    out.sources.push(stat);
  }
  return out;
}

export async function collectGithub(ctx: CollectContext, queries: string[]): Promise<Outcome> {
  const out = empty();
  const seen = new Set<string>();
  for (const q of queries.map((x) => x.trim()).filter(Boolean)) {
    const stat: SourceStat = { kind: 'github', name: `GitHub: ${q}`, via: 'api', ok: false, count: 0 };
    try {
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(`${q} created:>${day(ctx.sinceIso)}`)}&sort=stars&order=desc&per_page=10`;
      const raw = JSON.parse(await getText(ctx, url)) as { items?: unknown[] };
      for (const r of raw.items ?? []) {
        const o = obj(r);
        const link = str(o.html_url);
        if (!link || seen.has(link)) continue;
        seen.add(link);
        out.items.push(makeItem({
          layer: ctx.layer, kind: 'github', via: 'api', sourceName: 'GitHub', sourceUrl: 'https://github.com', url: link, author: str(obj(o.owner).login),
          title: str(o.full_name), text: str(o.description) ?? str(o.full_name) ?? '', postedAt: toIso(o.created_at), metrics: { stars: num(o.stargazers_count), comments: num(o.open_issues_count) },
        }));
        stat.count++;
      }
      stat.ok = true;
    } catch (e) { stat.error = safeError(e); }
    out.sources.push(stat);
  }
  return out;
}

export async function collectNews(ctx: CollectContext, feeds: string[]): Promise<Outcome> {
  const out = empty();
  for (const feed of feeds.map((x) => x.trim()).filter(Boolean)) {
    const stat: SourceStat = { kind: 'news', name: hostOf(feed) || feed, url: feed, via: 'rss', ok: false, count: 0 };
    try {
      const xml = await getText(ctx, feed);
      for (const e of parseFeed(xml).slice(0, ctx.layerConfig.maxPerSource)) {
        if (!e.link) continue;
        out.items.push(makeItem({
          layer: ctx.layer, kind: 'news', via: 'rss', sourceName: 'Báo chí, web', sourceUrl: feed, url: e.link, author: hostOf(e.link) || hostOf(feed),
          title: e.title, text: stripHtml(e.description) || e.title, postedAt: e.published, metrics: {}, media: 'link',
        }));
        stat.count++;
      }
      stat.ok = true;
    } catch (e) { stat.error = safeError(e); }
    out.sources.push(stat);
  }
  return out;
}
