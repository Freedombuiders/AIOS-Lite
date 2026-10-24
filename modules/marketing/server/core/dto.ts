/** Row → DTO mappers for the core endpoints. */

import {
  countFbSentReplies,
  getFbLatestPostMetrics,
  getFbPage,
  getFbPageWeekCounts,
  type FbContentRow,
  type FbPageRow,
} from '../store.js';
import { pageEr28d } from '../analytics/service.js';
import type { ConnStatus, FbContentDto, FbContentStatus, FbFormat, FbMedia, FbPageDto, FbPillar } from '../types.js';
import { startOfLocalWeek } from './time.js';

const nowSec = (): number => Math.floor(Date.now() / 1000);

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    const v = JSON.parse(text) as T;
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export function parsePillars(text: string): FbPillar[] {
  const raw = parseJson<unknown>(text, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is { name: unknown; targetPct?: unknown } => !!p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string')
    .map((p) => ({ name: String(p.name), targetPct: Number.isFinite(Number(p.targetPct)) ? Number(p.targetPct) : 0 }));
}

/** ER (%) = (reactions + comments + shares) / reach * 100; null without reach. */
export function engagementRate(m: { reach: number | null; reactions: number | null; comments: number | null; shares: number | null }): number | null {
  if (!m.reach || m.reach <= 0) return null;
  return ((m.reactions ?? 0) + (m.comments ?? 0) + (m.shares ?? 0)) / m.reach * 100;
}

export function pageToDto(row: FbPageRow, now: number = nowSec()): FbPageDto {
  const weekStart = startOfLocalWeek(now, row.timezone);
  const week = getFbPageWeekCounts(row.id, weekStart, weekStart + 7 * 86400);
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    role: row.role,
    mainKpi: row.main_kpi,
    timezone: row.timezone,
    approvalRequired: row.approval_required === 1,
    maxPostsPerDay: row.max_posts_per_day,
    minGapMinutes: row.min_gap_minutes,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    graceMinutes: row.grace_minutes,
    brandVoice: row.brand_voice,
    pillars: parsePillars(row.pillars_json),
    writerAgent: row.writer_agent,
    videoAgent: row.video_agent,
    status: (['ACTIVE', 'EXPIRED', 'MISSING', 'UNKNOWN'].includes(row.status) ? row.status : 'UNKNOWN') as ConnStatus,
    pictureUrl: row.picture_url,
    followers: row.followers,
    syncedAt: row.synced_at,
    stats: {
      postsThisWeek: week.posted,
      scheduledThisWeek: week.scheduled,
      er28d: pageEr28d(row.id, now),
      aiReplies24h: countFbSentReplies(row.id, now - 86400),
    },
  };
}

export function contentToDto(row: FbContentRow, pageNames?: Map<string, string>): FbContentDto {
  let pageName: string | null = null;
  if (row.page_id) pageName = pageNames?.get(row.page_id) ?? getFbPage(row.page_id)?.name ?? null;

  let metrics: FbContentDto['metrics'] = null;
  if (row.fb_post_id) {
    const m = getFbLatestPostMetrics(row.fb_post_id);
    if (m) metrics = { reach: m.reach, er: engagementRate(m), comments: m.comments };
  }

  return {
    id: row.id,
    pageId: row.page_id,
    pageName,
    title: row.title,
    caption: row.caption,
    format: row.format as FbFormat,
    pillar: row.pillar,
    hookType: row.hook_type,
    cta: row.cta,
    campaign: row.campaign,
    hooks: parseJson<string[]>(row.hooks_json, []),
    linkUrl: row.link_url,
    media: parseJson<FbMedia[]>(row.media_json, []),
    status: row.status as FbContentStatus,
    scheduledAt: row.scheduled_at,
    publishedAt: row.published_at,
    fbPostId: row.fb_post_id,
    permalink: row.permalink,
    publishedAs: row.published_as,
    attempts: row.attempts,
    lastError: row.last_error,
    feedback: row.feedback,
    source: row.source,
    origin: row.origin === 'imported' ? 'imported' : 'studio',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metrics,
  };
}
