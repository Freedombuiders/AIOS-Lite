/**
 * Collectors: fetch raw items for one layer. No LLM here.
 * OWNER: collectors agent. Stub signatures — the implementation replaces the bodies.
 */

import { existsSync } from 'fs';
import { logger } from '../log.js';
import type { CollectResult, FbGroupSource, LayerConfig, LayerKey, RadarConfig, RawComment, SourceStat, VnChatter } from '../types.js';
import { canonicalUrl } from '../util.js';
import { apifyComments, collectAds, collectFbGroup, collectFbPages, collectGithub, collectHn, collectInstagram, collectNews, collectReddit, collectThreads, collectTiktok, collectYoutube, safeError, type Outcome } from './sources.js';
import { browserAvailable, openBrowserSession, profileDir, profileExists, type BrowserSession } from './fb-browser.js';
import { getApifyToken, getApifyTokens, type RotationStore } from './apify.js';
import { collectRsshubGroup, collectRsshubInstagram, collectRsshubPages, collectRsshubThreadsAccounts, collectRsshubThreadsQueries, collectRsshubTiktokAccounts, resolveRsshub, rsshubGroupPath, rsshubReachable, type RsshubOutcome, type RsshubTarget } from './rsshub.js';
import { analystAgent, collectVnChatter as grokVnChatter, collectX } from './x-grok.js';

export { openBrowserLogin } from './fb-browser.js';

export interface CollectContext {
  layer: LayerKey;
  config: RadarConfig;
  layerConfig: LayerConfig;
  /** Items older than this are skipped (ISO). */
  sinceIso: string;
  now: Date;
  signal?: AbortSignal;
  /** Progress line for the run log (Vietnamese). */
  log: (line: string) => void;
  /** Injectable for tests. */
  deps?: CollectDeps;
}

export interface CollectDeps {
  fetchImpl?: typeof fetch;
  /** Runs the X reader (analyst agent); resolves with its text. */
  execGrok?: (args: string[], opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<string>;
  /** RSSHub base url for tests; null = RSSHub off. Unset: integration, then localhost. */
  rsshubBase?: string | null;
  apifyToken?: string | null;
  /** Several Apify tokens, taken in turn (tests; the app reads them from Kết nối › Apify). */
  apifyTokens?: string[];
  /** Rotation cursor and resting tokens (tests: memory). */
  apifyStore?: RotationStore;
  /** Apify run poll interval, ms (tests). */
  pollMs?: number;
}

/** What the missing Apify token really cost this run (only the sources that were skipped). */
export const noTokenNote = (skipped: string[]) => `Chưa có Apify token — bỏ qua ${skipped.join(', ')}. Thêm ở Kết nối › Apify.`;

function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try { return await fn(); } finally { active--; waiting.shift()?.(); }
  };
}

/** Every enabled source of the layer, in parallel where safe. Never throws for a single source: failures go to sources[].error and notes. */
export async function collectLayer(ctx: CollectContext): Promise<CollectResult> {
  const lc = ctx.layerConfig;
  const token = getApifyToken(ctx.deps);
  const result: CollectResult = { items: [], sources: [], notes: [], costUsd: 0 };
  const apifyLimit = limiter(3);
  const browserLimit = limiter(1);

  let browserPromise: Promise<BrowserSession | null> | null = null;
  const getBrowser = () => (browserPromise ??= openBrowserSession(ctx.signal).catch((e) => {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'radar: browser unavailable');
    return null;
  }));

  const tasks: Promise<Outcome | null>[] = [];
  const add = (name: string, fn: () => Promise<Outcome>) => {
    tasks.push((async () => {
      if (ctx.signal?.aborted) return null;
      try { return await fn(); } catch (e) {
        ctx.log(`${name}: lỗi (${safeError(e)}).`);
        result.notes.push(`${name}: không đọc được (${safeError(e)}).`);
        return null;
      }
    })());
  };

  const groups = lc.fbGroups.filter((g) => g.enabled !== false && g.url);
  const pages = lc.fbPages.filter((p) => p.enabled !== false && p.url);
  const handles = lc.instagram.filter((h) => h.trim());
  const adsOn = lc.adLibrary.enabled && (lc.adLibrary.queries.some((q) => q.trim()) || lc.adLibrary.pageUrls.some((u) => u.trim()));
  const tiktokQueries = lc.tiktok.enabled ? lc.tiktok.queries.filter((q) => q.trim()) : [];
  const tiktokAccounts = lc.tiktok.enabled ? lc.tiktok.accounts.filter((a) => a.trim()) : [];
  const threadsQueries = lc.threads.enabled ? lc.threads.queries.filter((q) => q.trim()) : [];
  const threadsAccounts = lc.threads.enabled ? lc.threads.accounts.filter((a) => a.trim()) : [];

  // RSSHub: probed once per run; every RSSHub-capable source falls back to the old path when it is down.
  const rsWanted = groups.some((g) => (g.mode ?? 'auto') === 'auto' || g.mode === 'rsshub') || pages.length > 0 || handles.length > 0
    || threadsQueries.length > 0 || threadsAccounts.length > 0 || tiktokAccounts.length > 0;
  const target = rsWanted ? resolveRsshub(ctx.deps) : null;
  let rs: RsshubTarget | null = null;
  if (target) {
    if (await rsshubReachable(target.base, ctx.deps?.fetchImpl, ctx.signal)) rs = target;
    else ctx.log(`Không thấy RSSHub ở ${target.base}: dùng Apify hoặc Chrome cho các nguồn xã hội (chạy \`docker start rsshub\` để đọc miễn phí).`);
  }
  const rsLimit = limiter(2);
  /** What Apify would have read but there is no token for (named in the note). */
  const skipped = new Set<string>();

  /** Facebook group through Apify or the browser, as before RSSHub existed. */
  const legacyGroup = async (g: FbGroupSource): Promise<Outcome> => {
    const skip = (): Outcome => {
      skipped.add('nhóm Facebook');
      return { items: [], notes: [], costUsd: 0, sources: [{ kind: 'fb_group', name: g.name, url: g.url, via: 'apify', ok: false, count: 0, error: 'Chưa có Apify token.', ...(g.members ? { members: g.members } : {}) }] };
    };
    if (!token && (g.mode ?? 'auto') === 'apify') return skip();
    if (!token && !profileExists()) return skip();
    const run = () => collectFbGroup(ctx, token, g, getBrowser);
    return (g.mode ?? 'auto') === 'browser' || !token ? browserLimit(run) : apifyLimit(run);
  };

  for (const g of groups) {
    const mode = g.mode ?? 'auto';
    if (mode === 'rsshub' || (mode === 'auto' && rs && rsshubGroupPath(g.url))) {
      add(`Nhóm ${g.name}`, async () => {
        const failed = (error: string): Outcome => ({ items: [], notes: [], costUsd: 0, sources: [{ kind: 'fb_group', name: g.name, url: g.url, via: 'rsshub', ok: false, count: 0, error, ...(g.members ? { members: g.members } : {}) }] });
        if (!rs) return failed('RSSHub chưa chạy.');
        const r = await rsLimit(() => collectRsshubGroup(ctx, rs as RsshubTarget, g));
        if (!r) return failed('Link nhóm dạng chia sẻ (share/g) không đọc được qua RSSHub. Dùng link groups/<id>.');
        if (r.items.length || mode === 'rsshub') return r;
        const old = await legacyGroup(g);
        // The old path explains itself; keep RSSHub's reason only when it skipped.
        return old.sources[0]?.error === 'Chưa có Apify token.' ? { ...old, sources: r.sources.map((s) => ({ ...s, error: s.error ?? 'RSSHub không trả bài nào.' })) } : old;
      });
      continue;
    }
    add(`Nhóm ${g.name}`, () => legacyGroup(g));
  }

  /** RSSHub first, then Apify for what it could not read (when a token exists). */
  const withFallback = async (
    r: RsshubOutcome, label: string, apifyFn: (names: Set<string>) => Promise<Outcome>, wanted: (names: Set<string>) => boolean = (n) => n.size > 0,
  ): Promise<Outcome> => {
    if (!r.retry.size || !wanted(r.retry)) return r;
    if (!token) { skipped.add(label); return r; }
    const keep = r.sources.filter((s) => !r.retry.has(s.name) && !r.retry.has(s.name.replace(/^Threads: /, '')));
    const fb = await apifyLimit(() => apifyFn(r.retry));
    return { items: [...r.items, ...fb.items], sources: [...keep, ...fb.sources], notes: [...r.notes, ...fb.notes], costUsd: r.costUsd + fb.costUsd };
  };

  if (pages.length) {
    if (rs) {
      add('Fanpage đối thủ', async () => withFallback(await collectRsshubPages(ctx, rs as RsshubTarget, pages, rsLimit), 'fanpage chưa đọc được qua RSSHub',
        (names) => collectFbPages(ctx, token as string, pages.filter((p) => names.has(p.name)))));
    } else if (token) add('Fanpage đối thủ', () => apifyLimit(() => collectFbPages(ctx, token, pages)));
    else skipped.add('fanpage');
  }
  if (adsOn) { if (token) add('Meta Ad Library', () => apifyLimit(() => collectAds(ctx, token))); else skipped.add('Meta Ad Library'); }
  if (handles.length) {
    if (rs) {
      add('Instagram', async () => withFallback(await collectRsshubInstagram(ctx, rs as RsshubTarget, handles, rsLimit), 'Instagram chưa đọc được qua RSSHub',
        (names) => collectInstagram(ctx, token as string, [...names].map((n) => n.replace(/^@/, '')))));
    } else if (token) add('Instagram', () => apifyLimit(() => collectInstagram(ctx, token, handles)));
    else skipped.add('Instagram');
  }
  if (threadsAccounts.length) {
    if (rs) add('Threads (tài khoản)', () => collectRsshubThreadsAccounts(ctx, rs as RsshubTarget, threadsAccounts, rsLimit));
    else ctx.log('Threads: tài khoản theo dõi cần RSSHub, đang chưa chạy nên bỏ qua.');
  }
  if (threadsQueries.length) {
    if (rs) {
      add('Threads', async () => withFallback(await collectRsshubThreadsQueries(ctx, rs as RsshubTarget, threadsQueries, rsLimit), 'tìm kiếm Threads chưa đọc được qua RSSHub',
        (names) => collectThreads(ctx, token as string, [...names])));
    } else if (token) add('Threads', () => apifyLimit(() => collectThreads(ctx, token, threadsQueries)));
    else skipped.add('tìm kiếm Threads');
  }
  if (tiktokAccounts.length) {
    if (rs) add('TikTok (tài khoản)', () => collectRsshubTiktokAccounts(ctx, rs as RsshubTarget, tiktokAccounts, rsLimit));
    else ctx.log('TikTok: tài khoản theo dõi cần RSSHub, đang chưa chạy nên bỏ qua.');
  }
  if (tiktokQueries.length) { if (token) add('TikTok', () => apifyLimit(() => collectTiktok(ctx, token, tiktokQueries))); else skipped.add('tìm kiếm TikTok theo từ khoá'); }
  if (lc.reddit.enabled && lc.reddit.subreddits.length) add('Reddit', () => collectReddit(ctx, token, lc.reddit.subreddits));
  if (lc.hackerNews.enabled) add('Hacker News', () => collectHn(ctx, lc.hackerNews.minPoints));
  if (lc.youtube.enabled && lc.youtube.channels.length) add('YouTube', () => collectYoutube(ctx, lc.youtube.channels));
  if (lc.github.enabled && lc.github.queries.length) add('GitHub', () => collectGithub(ctx, lc.github.queries));
  if (lc.news.enabled && lc.news.rss.length) add('Báo chí', () => collectNews(ctx, lc.news.rss));
  if (lc.x.enabled && (lc.x.accounts.length || lc.x.queries.length)) {
    add('X', async () => {
      const r = await collectX(ctx, lc.x.accounts, lc.x.queries);
      return { ...r, costUsd: 0 };
    });
  }

  try {
    const outcomes = await Promise.all(tasks);
    for (const o of outcomes) {
      if (!o) continue;
      result.items.push(...o.items);
      result.sources.push(...o.sources);
      result.notes.push(...o.notes);
      result.costUsd += o.costUsd;
    }
  } finally {
    if (browserPromise) await (await browserPromise)?.close().catch(() => undefined);
  }

  if (!token && skipped.size) {
    const note = noTokenNote([...skipped]);
    result.notes.unshift(note);
    ctx.log('Chưa có Apify token: bỏ qua các nguồn cần Apify.');
  }

  // Window filter: undated items stay; TikTok keeps older videos (the pipeline says "cũ hơn N ngày"); ads and GitHub are "currently active" lists.
  const since = ctx.sinceIso;
  const seen = new Set<string>();
  result.items = result.items.filter((it) => {
    if (seen.has(it.id)) return false;
    seen.add(it.id);
    if (it.kind === 'tiktok' || it.kind === 'ad' || it.kind === 'github') return true;
    return !it.postedAt || it.postedAt >= since;
  });
  for (const s of result.sources) {
    if (s.members === undefined) {
      const g = groups.find((x) => x.name === s.name);
      if (g?.members) s.members = g.members;
    }
  }
  result.notes.push(...failureNotes(result.sources, result.notes));
  result.notes = [...new Set(result.notes)];
  ctx.log(`Thu thập xong: ${result.items.length} mục từ ${result.sources.filter((s) => s.ok).length}/${result.sources.length} nguồn.`);
  return result;
}

/** Comments of the given Facebook post urls (Apify facebook-comments-scraper, browser fallback). Keyed by canonical url. */
export async function fetchFacebookComments(ctx: CollectContext, postUrls: string[], perPost: number): Promise<Map<string, RawComment[]>> {
  const result = new Map<string, RawComment[]>();
  const urls = [...new Set(postUrls.filter(Boolean))];
  if (!urls.length) return result;
  const token = getApifyToken(ctx.deps);
  const browserGroups = ctx.layerConfig.fbGroups.filter((g: FbGroupSource) => (g.mode ?? 'auto') === 'browser');
  const groupId = (u: string) => /groups\/([^/?#]+)/.exec(u)?.[1]?.toLowerCase();
  const browserIds = new Set(browserGroups.map((g) => groupId(g.url)).filter((x): x is string => !!x));
  const forBrowser = urls.filter((u) => !token || browserIds.has(groupId(u) ?? '\0'));
  const forApify = token ? urls.filter((u) => !forBrowser.includes(u)) : [];

  if (forApify.length) {
    try {
      ctx.log(`Đọc bình luận ${forApify.length} bài qua Apify…`);
      const r = await apifyComments(ctx, token as string, forApify, perPost);
      for (const [k, v] of r.map) result.set(k, v);
    } catch (e) { ctx.log(`Bình luận qua Apify lỗi: ${safeError(e)}.`); }
  }
  if (forBrowser.length && profileExists()) {
    const session = await openBrowserSession(ctx.signal).catch(() => null);
    if (session) {
      try {
        for (const u of forBrowser) {
          if (ctx.signal?.aborted) break;
          const c = await session.readComments(u, perPost);
          if (c.length) result.set(canonicalUrl(u), c);
        }
      } finally { await session.close(); }
    }
  }
  return result;
}

/** world layer: what Vietnamese X discussed about AI in the last N days (agent radar-analyst). */
export async function collectVnChatter(ctx: CollectContext, days: number): Promise<VnChatter | null> {
  return grokVnChatter(ctx, days);
}

/** Readiness of the external tools, for the settings screen. Cheap; never throws. */
export async function toolStatus(deps?: CollectDeps): Promise<{
  apify: { configured: boolean; keys: number };
  grok: { installed: boolean; path: string | null; loggedIn: boolean | null; detail: string };
  browser: { available: boolean; profileDir: string; detail: string };
  rsshub: { url: string; reachable: boolean; detail: string };
}> {
  let keys = 0;
  try { keys = getApifyTokens(deps).length; } catch { /* not configured */ }
  const configured = keys > 0;
  const agent = analystAgent();
  const grokDetail = agent ? `Agent ${agent} (runtime Grok) đọc X.` : 'Chưa có agent radar-analyst, nên chưa đọc được X. Thêm agent từ mẫu của module Radar.';
  const available = await browserAvailable();
  const dir = profileDir();
  const hasProfile = existsSync(dir);
  const browserDetail = !available ? 'Chưa cài playwright, chưa đọc được nhóm Facebook riêng tư.'
    : hasProfile ? 'Chrome của Radar sẵn sàng (đã có hồ sơ đăng nhập).' : 'Chưa đăng nhập Facebook trong Chrome của Radar. Bấm "Đăng nhập Facebook".';
  const rsTarget = resolveRsshub(deps);
  const rsUrl = rsTarget?.base ?? '';
  const rsReachable = rsTarget ? await rsshubReachable(rsTarget.base, deps?.fetchImpl) : false;
  const rsDetail = !rsTarget ? 'RSSHub đang tắt.' : rsReachable ? `RSSHub đang chạy ở ${rsUrl}.` : `Không thấy RSSHub ở ${rsUrl} — chạy \`docker start rsshub\`.`;
  return { apify: { configured, keys }, grok: { installed: !!agent, path: agent, loggedIn: null, detail: grokDetail }, browser: { available, profileDir: dir, detail: browserDetail }, rsshub: { url: rsUrl, reachable: rsReachable, detail: rsDetail } };
}

const KIND_LABEL: Record<string, string> = {
  fb_group: 'Nhóm Facebook', fb_page: 'Fanpage', ad: 'Ad Library', instagram: 'Instagram', x: 'X', reddit: 'Reddit',
  hn: 'Hacker News', youtube: 'YouTube', tiktok: 'TikTok', threads: 'Threads', github: 'GitHub', news: 'Báo chí, web',
};

/** One note per kind for failed sources whose error no earlier note already mentions (e.g. "Reddit: không đọc được r/A, r/B (fetch failed)."). */
export function failureNotes(sources: SourceStat[], existing: string[]): string[] {
  const byKind = new Map<string, { names: string[]; errors: Set<string> }>();
  for (const s of sources) {
    if (s.ok || !s.error) continue;
    const error = s.error.trim().replace(/[.。]+$/, '');
    if (existing.some((n) => n.includes(error))) continue;
    const e = byKind.get(s.kind) ?? { names: [], errors: new Set<string>() };
    e.names.push(s.name);
    e.errors.add(error);
    byKind.set(s.kind, e);
  }
  return [...byKind].map(([kind, e]) => {
    const names = e.names.length > 4 ? `${e.names.slice(0, 4).join(', ')} và ${e.names.length - 4} nguồn khác` : e.names.join(', ');
    return `${KIND_LABEL[kind] ?? kind}: không đọc được ${names} (${[...e.errors].slice(0, 2).join('; ')}).`;
  });
}
