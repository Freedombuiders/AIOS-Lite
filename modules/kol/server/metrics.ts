/**
 * Metrics: every 30 minutes, snapshots of targets published in the last 30
 * days (kol_metrics) and one follower count per account per local day
 * (kol_account_daily). Instagram: media fields + media insights; YouTube:
 * video statistics; TikTok: the account's video list; Facebook: Content
 * Studio's own snapshots (fb_post_metrics). All reads, never writes.
 *
 * Growth (GrowthDto) is aggregated here from those tables.
 */

import { localDayKey, localParts, isValidTimezone } from './time.js';
import { listFbPostMetricsForPost } from './fb-bridge.js';
import { logger } from './compat.js';
import {
  DEFAULT_TIMEZONE,
  execTargetOf,
  fetchFollowers,
  hasFollowersToday,
  markAccountExpired,
  recordFollowers,
  type AccountRow,
} from './accounts.js';
import { listAssetsByIds } from './assets.js';
import {
  ComposioConnectionExpiredError,
  asArr,
  asNum,
  asObj,
  asStr,
  executeTool,
  findRecord,
  hasComposioKey,
} from './composio-exec.js';
import { kolDb, loadSettings, nowSec, parseJson } from './core.js';
import { getPersona, requirePersona } from './personas.js';
import { latestTargetMetrics } from './posts.js';
import { spendByDay } from './spend.js';
import type { GrowthDto, Platform, PostMetricsDto } from './types.js';

const TICK_MS = 30 * 60_000;
const WINDOW_SEC = 30 * 86_400;
const MAX_SNAPSHOTS_PER_TICK = 60;
const DAY = 86_400;

export interface MetricValues {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reach: number | null;
}

const EMPTY: MetricValues = { views: null, likes: null, comments: null, shares: null, saves: null, reach: null };

// ── Cadence (pure) ───────────────────────────────────────────────────

/** Seconds between snapshots for a post of this age: hourly the first 2 days, every 6 h the first week, then daily. */
export function snapshotInterval(ageSec: number): number {
  if (ageSec < 2 * DAY) return 3600;
  if (ageSec < 7 * DAY) return 6 * 3600;
  return DAY;
}

export function snapshotDue(publishedAt: number, lastCapturedAt: number | null, now: number): boolean {
  if (now - publishedAt > WINDOW_SEC) return false;
  if (lastCapturedAt === null) return true;
  return now - lastCapturedAt >= snapshotInterval(now - publishedAt) - 60;
}

// ── Platform readers ─────────────────────────────────────────────────

/** Instagram insights arrive as a list of {name, values: [{value}]} or {name, total_value: {value}}. */
export function parseInsights(data: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  let level: unknown[] = [data];
  for (let depth = 0; depth < 5 && level.length; depth++) {
    const next: unknown[] = [];
    for (const v of level) {
      if (Array.isArray(v) && v.some((x) => asStr(asObj(x).name))) {
        for (const item of v) {
          const o = asObj(item);
          const name = asStr(o.name);
          if (!name) continue;
          const value = asNum(asObj(asArr(o.values)[0]).value) ?? asNum(asObj(o.total_value).value) ?? asNum(o.value);
          if (value !== null) out[name] = value;
        }
        return out;
      }
      const o = asObj(v);
      for (const k of ['data', 'response_data', 'insights']) if (o[k] !== undefined) next.push(o[k]);
    }
    level = next;
  }
  return out;
}

async function instagramMetrics(account: AccountRow, mediaId: string): Promise<MetricValues> {
  const target = execTargetOf(account);
  const media = findRecord(await executeTool('INSTAGRAM_GET_IG_MEDIA', { ig_media_id: mediaId, fields: 'id,like_count,comments_count,media_product_type' }, target), ['like_count', 'comments_count', 'id']) ?? {};
  const out: MetricValues = { ...EMPTY, likes: asNum(media.like_count), comments: asNum(media.comments_count) };
  try {
    const ins = parseInsights(await executeTool('INSTAGRAM_GET_IG_MEDIA_INSIGHTS', { ig_media_id: mediaId, metric: ['views', 'reach', 'saved', 'shares', 'likes', 'comments'] }, target));
    out.views = ins.views ?? null;
    out.reach = ins.reach ?? null;
    out.saves = ins.saved ?? null;
    out.shares = ins.shares ?? null;
    out.likes = ins.likes ?? out.likes;
    out.comments = ins.comments ?? out.comments;
  } catch (err) {
    if (err instanceof ComposioConnectionExpiredError) throw err;
    // Insights can be unavailable for some media: keep the counters.
  }
  return out;
}

async function youtubeMetrics(account: AccountRow, videoIds: string[]): Promise<Map<string, MetricValues>> {
  const out = new Map<string, MetricValues>();
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const res = await executeTool('YOUTUBE_GET_VIDEO_DETAILS_BATCH', { id: chunk, parts: ['statistics'] }, execTargetOf(account));
    const holder = findRecord(res, ['items']) ?? {};
    for (const raw of asArr(holder.items)) {
      const v = asObj(raw);
      const id = asStr(v.id);
      if (!id) continue;
      const s = asObj(v.statistics);
      out.set(id, { ...EMPTY, views: asNum(s.viewCount), likes: asNum(s.likeCount), comments: asNum(s.commentCount) });
    }
  }
  return out;
}

async function tiktokMetrics(account: AccountRow, videoIds: string[]): Promise<Map<string, MetricValues>> {
  const want = new Set(videoIds);
  const out = new Map<string, MetricValues>();
  let cursor: number | undefined;
  for (let page = 0; page < 5 && out.size < want.size; page++) {
    const res = await executeTool('TIKTOK_LIST_VIDEOS', { max_count: 20, ...(cursor !== undefined ? { cursor } : {}) }, execTargetOf(account));
    const holder = findRecord(res, ['videos']) ?? {};
    for (const raw of asArr(holder.videos)) {
      const v = asObj(raw);
      const id = typeof v.id === 'string' ? v.id : typeof v.id === 'number' && Number.isSafeInteger(v.id) ? String(v.id) : null;
      if (!id || !want.has(id)) continue;
      out.set(id, { ...EMPTY, views: asNum(v.view_count), likes: asNum(v.like_count), comments: asNum(v.comment_count), shares: asNum(v.share_count) });
    }
    const next = asNum(holder.cursor);
    if (!holder.has_more || next === null) break;
    cursor = next;
  }
  return out;
}

/** Content Studio's latest snapshot of a Facebook post, mapped to KOL metrics. */
export function facebookMetrics(fbPostId: string): (MetricValues & { capturedAt: number }) | null {
  const rows = listFbPostMetricsForPost(fbPostId);
  const m = rows[rows.length - 1];
  if (!m) return null;
  return {
    capturedAt: m.capturedAt,
    views: m.videoViews3s ?? m.impressions,
    likes: m.reactions,
    comments: m.comments,
    shares: m.shares,
    saves: m.saves,
    reach: m.reach,
  };
}

// ── Snapshots ────────────────────────────────────────────────────────

interface PublishedTarget {
  id: string;
  account_id: string;
  platform: string;
  external_id: string;
  published_at: number;
  last_at: number | null;
}

function insertSnapshot(targetId: string, capturedAt: number, m: MetricValues): void {
  kolDb().prepare(
    `INSERT INTO kol_metrics (target_id, captured_at, views, likes, comments, shares, saves, reach, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
  ).run(targetId, capturedAt, m.views, m.likes, m.comments, m.shares, m.saves, m.reach);
}

function hasAny(m: MetricValues): boolean {
  return Object.values(m).some((v) => v !== null);
}

/** Snapshots of due targets, at most MAX_SNAPSHOTS_PER_TICK remote reads. Returns how many were stored. */
export async function snapshotMetrics(now = nowSec()): Promise<number> {
  const rows = kolDb().prepare(
    `SELECT t.id, t.account_id, t.platform, t.external_id, t.published_at,
       (SELECT MAX(captured_at) FROM kol_metrics m WHERE m.target_id = t.id) AS last_at
     FROM kol_post_targets t
     WHERE t.status = 'published' AND t.external_id IS NOT NULL AND t.external_id <> '' AND t.published_at >= ?`,
  ).all(now - WINDOW_SEC) as PublishedTarget[];

  let stored = 0;
  const byAccount = new Map<string, PublishedTarget[]>();
  for (const r of rows) {
    if (r.platform === 'facebook') {
      const fb = facebookMetrics(r.external_id);
      if (fb && (r.last_at === null || fb.capturedAt > r.last_at)) {
        insertSnapshot(r.id, fb.capturedAt, fb);
        stored++;
      }
      continue;
    }
    if (!snapshotDue(r.published_at, r.last_at, now)) continue;
    byAccount.set(r.account_id, [...(byAccount.get(r.account_id) ?? []), r]);
  }
  if (!byAccount.size || !hasComposioKey()) return stored;

  let budget = MAX_SNAPSHOTS_PER_TICK;
  for (const [accountId, targets] of byAccount) {
    if (budget <= 0) break;
    const account = kolDb().prepare('SELECT * FROM kol_accounts WHERE id = ?').get(accountId) as AccountRow | undefined;
    if (!account || account.status === 'EXPIRED') continue;
    try {
      const platform = account.platform as Platform;
      if (platform === 'instagram') {
        for (const t of targets) {
          if (budget-- <= 0) break;
          const m = await instagramMetrics(account, t.external_id);
          if (hasAny(m)) { insertSnapshot(t.id, now, m); stored++; }
        }
      } else if (platform === 'youtube' || platform === 'tiktok') {
        budget -= Math.ceil(targets.length / (platform === 'youtube' ? 50 : 20));
        const ids = targets.map((t) => t.external_id);
        const map = platform === 'youtube' ? await youtubeMetrics(account, ids) : await tiktokMetrics(account, ids);
        for (const t of targets) {
          const m = map.get(t.external_id);
          if (m && hasAny(m)) { insertSnapshot(t.id, now, m); stored++; }
        }
      }
    } catch (err) {
      if (err instanceof ComposioConnectionExpiredError) await markAccountExpired(accountId);
      else logger.warn({ accountId, err: String(err).slice(0, 200) }, 'kol metrics snapshot failed');
    }
  }
  return stored;
}

/** One follower count per account per local day. */
export async function snapshotFollowers(now = nowSec()): Promise<number> {
  const accounts = kolDb().prepare(`SELECT * FROM kol_accounts WHERE status = 'ACTIVE'`).all() as AccountRow[];
  let n = 0;
  for (const a of accounts) {
    if (hasFollowersToday(a.id, a.timezone, now)) continue;
    if (a.platform !== 'facebook' && !hasComposioKey()) continue;
    try {
      const followers = await fetchFollowers(a);
      if (followers !== null) {
        recordFollowers(a.id, followers, a.timezone, now);
        n++;
      }
    } catch (err) {
      if (err instanceof ComposioConnectionExpiredError) await markAccountExpired(a.id);
      else logger.warn({ accountId: a.id, err: String(err).slice(0, 200) }, 'kol followers snapshot failed');
    }
  }
  return n;
}

// ── Worker ───────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export async function metricsTick(now = nowSec()): Promise<void> {
  if (ticking) return;
  if (!loadSettings().enabled) return;
  ticking = true;
  try {
    await snapshotMetrics(now);
    await snapshotFollowers(now);
  } catch (err) {
    logger.error({ err: String(err) }, 'kol metrics tick failed');
  } finally {
    ticking = false;
  }
}

export function startMetrics(): void {
  if (timer) return;
  timer = setInterval(() => void metricsTick(), TICK_MS);
  timer.unref?.();
  const first = setTimeout(() => void metricsTick(), 2 * 60_000);
  first.unref?.();
}

export function stopMetrics(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ── Growth (pure aggregation) ────────────────────────────────────────

/** (likes + comments + shares + saves) ÷ max(views, reach); null when there is no audience number or no interaction. */
export function engagementOf(m: Pick<PostMetricsDto, 'views' | 'likes' | 'comments' | 'shares' | 'saves' | 'reach'> | null): number | null {
  if (!m) return null;
  const parts = [m.likes, m.comments, m.shares, m.saves].filter((v): v is number => v !== null);
  const denom = Math.max(m.views ?? 0, m.reach ?? 0);
  if (!parts.length || denom <= 0) return null;
  return parts.reduce((a, b) => a + b, 0) / denom;
}

export interface GrowthRow {
  postId: string;
  title: string;
  pillar: string;
  platform: Platform;
  permalink: string;
  publishedAt: number;
  timezone: string;
  thumbUrl: string | null;
  metrics: PostMetricsDto | null;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round4 = (x: number | null): number | null => (x === null ? null : Math.round(x * 10_000) / 10_000);

export function aggregateGrowth(rows: GrowthRow[]): Pick<GrowthDto, 'totals' | 'topPosts' | 'pillars' | 'hours'> {
  let views = 0;
  let likes = 0;
  let comments = 0;
  let shares = 0;
  let interactions = 0;
  let audience = 0;
  for (const r of rows) {
    const m = r.metrics;
    if (!m) continue;
    views += m.views ?? 0;
    likes += m.likes ?? 0;
    comments += m.comments ?? 0;
    shares += m.shares ?? 0;
    if (engagementOf(m) !== null) {
      interactions += (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.saves ?? 0);
      audience += Math.max(m.views ?? 0, m.reach ?? 0);
    }
  }

  const topPosts = [...rows]
    .sort((a, b) => (b.metrics?.views ?? -1) - (a.metrics?.views ?? -1) || (b.metrics?.likes ?? -1) - (a.metrics?.likes ?? -1) || b.publishedAt - a.publishedAt)
    .slice(0, 10)
    .map((r) => ({
      postId: r.postId,
      title: r.title,
      platform: r.platform,
      permalink: r.permalink,
      views: r.metrics?.views ?? null,
      likes: r.metrics?.likes ?? null,
      comments: r.metrics?.comments ?? null,
      thumbUrl: r.thumbUrl,
    }));

  const pillarMap = new Map<string, { posts: Set<string>; eng: number[] }>();
  for (const r of rows) {
    const key = r.pillar.trim() || 'Khác';
    const p = pillarMap.get(key) ?? { posts: new Set<string>(), eng: [] };
    p.posts.add(r.postId);
    const e = engagementOf(r.metrics);
    if (e !== null) p.eng.push(e);
    pillarMap.set(key, p);
  }
  const pillars = [...pillarMap.entries()]
    .map(([pillar, p]) => ({ pillar, posts: p.posts.size, avgEngagement: round4(mean(p.eng)) }))
    .sort((a, b) => b.posts - a.posts || (b.avgEngagement ?? -1) - (a.avgEngagement ?? -1));

  const hourBuckets = Array.from({ length: 24 }, () => ({ posts: 0, eng: [] as number[] }));
  for (const r of rows) {
    const tz = isValidTimezone(r.timezone) ? r.timezone : DEFAULT_TIMEZONE;
    const h = localParts(r.publishedAt, tz).hour;
    hourBuckets[h].posts++;
    const e = engagementOf(r.metrics);
    if (e !== null) hourBuckets[h].eng.push(e);
  }
  const hours = hourBuckets.map((b, hour) => ({ hour, posts: b.posts, avgEngagement: round4(mean(b.eng)) }));

  return {
    totals: {
      posts: new Set(rows.map((r) => r.postId)).size,
      views,
      likes,
      comments,
      shares,
      engagementRate: audience > 0 ? round4(interactions / audience) : null,
    },
    topPosts,
    pillars,
    hours,
  };
}

interface GrowthTargetRow {
  post_id: string;
  target_id: string;
  title: string;
  pillar: string;
  platform: string;
  permalink: string;
  published_at: number;
  timezone: string | null;
  asset_ids_json: string;
}

/** Published targets of a persona since `since`, with their latest metrics. */
export function growthRows(personaId: string, since: number): GrowthRow[] {
  const persona = getPersona(personaId);
  const pillarName = new Map((persona?.pillars ?? []).map((p) => [p.id, p.name]));
  const rows = kolDb().prepare(
    `SELECT p.id AS post_id, t.id AS target_id, p.title, p.pillar, t.platform, t.permalink, t.published_at, a.timezone, p.asset_ids_json
     FROM kol_post_targets t
     JOIN kol_posts p ON p.id = t.post_id
     LEFT JOIN kol_accounts a ON a.id = t.account_id
     WHERE p.persona_id = ? AND t.status = 'published' AND t.published_at >= ?
     ORDER BY t.published_at`,
  ).all(personaId, since) as GrowthTargetRow[];
  const metrics = latestTargetMetrics(rows.map((r) => r.target_id));
  const firstAsset = new Map(rows.map((r) => [r.post_id, parseJson<string[]>(r.asset_ids_json, [])[0]]));
  const assetIds = [...new Set([...firstAsset.values()].filter((x): x is string => typeof x === 'string'))];
  const assets = new Map(assetIds.length ? listAssetsByIds(assetIds).map((a) => [a.id, a]) : []);
  return rows.map((r) => {
    const asset = assets.get(firstAsset.get(r.post_id) ?? '');
    return {
      postId: r.post_id,
      title: r.title,
      pillar: pillarName.get(r.pillar) ?? r.pillar,
      platform: r.platform as Platform,
      permalink: r.permalink,
      publishedAt: r.published_at,
      timezone: r.timezone ?? DEFAULT_TIMEZONE,
      thumbUrl: asset ? asset.thumbUrl ?? (asset.kind === 'image' ? asset.url : null) : null,
      metrics: metrics.get(r.target_id) ?? null,
    };
  });
}

/** GET /personas/:id/growth. */
export function computeGrowth(personaId: string, daysIn = 30, now = nowSec()): GrowthDto {
  requirePersona(personaId);
  const days = Math.min(365, Math.max(1, Math.round(daysIn) || 30));
  const since = now - days * DAY;
  const accounts = kolDb().prepare('SELECT * FROM kol_accounts WHERE persona_id = ? ORDER BY platform, created_at').all(personaId) as AccountRow[];
  const seriesStmt = kolDb().prepare('SELECT day, followers FROM kol_account_daily WHERE account_id = ? AND day >= ? ORDER BY day');
  return {
    days,
    accounts: accounts.map((a) => {
      const tz = isValidTimezone(a.timezone) ? a.timezone : DEFAULT_TIMEZONE;
      return {
        id: a.id,
        platform: a.platform as Platform,
        handle: a.handle || a.display_name,
        followers: a.followers,
        series: seriesStmt.all(a.id, localDayKey(now - (days - 1) * DAY, tz)) as { day: string; followers: number }[],
      };
    }),
    ...aggregateGrowth(growthRows(personaId, since)),
    spend: spendByDay(personaId, days),
  };
}
