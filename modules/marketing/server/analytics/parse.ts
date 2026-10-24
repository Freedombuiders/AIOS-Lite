/**
 * Defensive parsing of Composio's Facebook responses (posts, post insights,
 * page insights). The envelope varies (`data`, `data.data`, …) and Meta
 * renames metrics, so everything here tolerates missing keys and returns
 * null instead of throwing.
 */

import type { FbFormat } from '../types.js';
import { dayFromEndTime } from './time.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const ENVELOPE_KEYS = ['data', 'response_data', 'items', 'posts', 'insights', 'result'];

/** Finds the record array inside a tool response, whatever the nesting (depth ≤ 3). */
export function unwrapRecords(raw: unknown, depth = 0): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw) || depth > 3) return [];
  for (const key of ENVELOPE_KEYS) {
    const inner = raw[key];
    if (Array.isArray(inner)) return inner;
    if (isRecord(inner)) {
      const found = unwrapRecords(inner, depth + 1);
      if (found.length) return found;
    }
  }
  return [];
}

export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Unix seconds from a Graph timestamp ('2026-10-05T12:30:00+0000'), ISO string or number. */
export function toEpoch(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.floor(v > 1e12 ? v / 1000 : v) : null;
  if (typeof v !== 'string' || !v) return null;
  const normalised = v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(normalised);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

// ── Posts ──────────────────────────────────────────────────────────────

export interface ParsedPost {
  id: string;
  message: string;
  createdAt: number | null;
  permalink: string;
  linkUrl: string;
  format: FbFormat;
  /** null when the field was not returned at all. */
  reactions: number | null;
  comments: number | null;
  /** Facebook omits `shares` when there are none. */
  shares: number;
}

export function deriveFormat(input: {
  permalink: string;
  statusType: string;
  attachmentType: string;
  subattachments: number;
  hasAttachment: boolean;
}): FbFormat {
  const permalink = input.permalink.toLowerCase();
  const type = input.attachmentType.toLowerCase();
  const status = input.statusType.toLowerCase();
  if (/\/reels?\//.test(permalink)) return 'reel';
  if (type.includes('video') || status === 'added_video' || /\/videos?\//.test(permalink)) return 'video';
  if (type === 'album' || input.subattachments > 1) return 'album';
  if (type.includes('photo') || status === 'added_photos') return 'photo';
  if (type === 'share' || type === 'link' || type === 'native_templates' || status === 'shared_story') return 'link';
  if (input.hasAttachment && type) return 'link';
  return 'text';
}

function countOf(node: unknown, ...path: string[]): number | null {
  let cur: unknown = node;
  for (const key of path) {
    if (!isRecord(cur)) return null;
    cur = cur[key];
  }
  return toNumber(cur);
}

export function parsePost(raw: unknown): ParsedPost | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id : typeof raw.id === 'number' ? String(raw.id) : '';
  if (!id) return null;
  const permalink = typeof raw.permalink_url === 'string' ? raw.permalink_url : '';
  const attachmentList = isRecord(raw.attachments) ? (raw.attachments.data as unknown) : undefined;
  const first = Array.isArray(attachmentList) && isRecord(attachmentList[0]) ? attachmentList[0] : undefined;
  const sub = first && isRecord(first.subattachments) && Array.isArray(first.subattachments.data) ? first.subattachments.data.length : 0;
  const attachmentType = first && typeof first.type === 'string' ? first.type : (first && typeof first.media_type === 'string' ? first.media_type : '');
  const linkUrl = first && typeof first.unshimmed_url === 'string' ? first.unshimmed_url : '';
  return {
    id,
    message: typeof raw.message === 'string' ? raw.message : '',
    createdAt: toEpoch(raw.created_time),
    permalink,
    linkUrl,
    format: deriveFormat({
      permalink,
      statusType: typeof raw.status_type === 'string' ? raw.status_type : '',
      attachmentType,
      subattachments: sub,
      hasAttachment: !!first,
    }),
    reactions: countOf(raw, 'reactions', 'summary', 'total_count'),
    comments: countOf(raw, 'comments', 'summary', 'total_count'),
    shares: countOf(raw, 'shares', 'count') ?? 0,
  };
}

export function parsePagePosts(raw: unknown): ParsedPost[] {
  const out: ParsedPost[] = [];
  for (const item of unwrapRecords(raw)) {
    const p = parsePost(item);
    if (p) out.push(p);
  }
  return out;
}

/** First line of the caption as a title, at most 80 characters. */
export function titleFromMessage(message: string): string {
  const line = message.split('\n').map((l) => l.trim()).find((l) => l) ?? '';
  if (!line) return '(Không có nội dung)';
  return line.length > 80 ? `${line.slice(0, 77).trimEnd()}...` : line;
}

// ── Insights ───────────────────────────────────────────────────────────

export interface InsightPoint {
  /** Unix seconds of the value's end_time, when given. */
  endTime: number | null;
  value: number;
}

/** metric name → numeric points in response order. Non-numeric values (breakdown objects) are dropped. */
export function parseInsightSeries(raw: unknown): Map<string, InsightPoint[]> {
  const out = new Map<string, InsightPoint[]>();
  for (const item of unwrapRecords(raw)) {
    if (!isRecord(item) || typeof item.name !== 'string') continue;
    const values = Array.isArray(item.values) ? item.values : [];
    const points: InsightPoint[] = [];
    for (const v of values) {
      if (!isRecord(v)) continue;
      const value = toNumber(v.value);
      if (value === null) continue;
      points.push({ endTime: toEpoch(v.end_time), value });
    }
    const existing = out.get(item.name);
    if (existing) existing.push(...points); else out.set(item.name, points);
  }
  return out;
}

/**
 * One number per post metric. Facebook can return several entries for the
 * same metric name (observed for post_total_media_view_unique: a 'lifetime'
 * entry with the real value next to another period with 0). Prefer the
 * 'lifetime' entry, else the largest value.
 */
export function parsePostInsights(raw: unknown): Record<string, number | null> {
  const entries = new Map<string, { period: string; value: number | null }[]>();
  for (const item of unwrapRecords(raw)) {
    if (!isRecord(item) || typeof item.name !== 'string') continue;
    const values = Array.isArray(item.values) ? item.values : [];
    let value: number | null = null;
    for (const v of values) {
      if (isRecord(v)) value = toNumber(v.value) ?? value;
    }
    const list = entries.get(item.name) ?? [];
    list.push({ period: typeof item.period === 'string' ? item.period : '', value });
    entries.set(item.name, list);
  }
  const out: Record<string, number | null> = {};
  for (const [name, list] of entries) {
    const lifetime = list.find((e) => e.period === 'lifetime' && e.value !== null);
    if (lifetime) { out[name] = lifetime.value; continue; }
    const numeric = list.map((e) => e.value).filter((v): v is number => v !== null);
    out[name] = numeric.length ? Math.max(...numeric) : null;
  }
  return out;
}

// ── Video ──────────────────────────────────────────────────────────────

/** The video id behind a post: attachments.data[0].target.id when its media_type is 'video'; null otherwise. */
export function parseVideoId(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const list = isRecord(raw.attachments) && Array.isArray(raw.attachments.data) ? raw.attachments.data : [];
  for (const a of list) {
    if (!isRecord(a)) continue;
    const mediaType = typeof a.media_type === 'string' ? a.media_type : '';
    const type = typeof a.type === 'string' ? a.type : '';
    if (mediaType !== 'video' && !type.includes('video')) continue;
    const target = isRecord(a.target) ? a.target : undefined;
    const id = target ? (typeof target.id === 'string' ? target.id : typeof target.id === 'number' ? String(target.id) : '') : '';
    if (id) return id;
  }
  return null;
}

export interface VideoInsights {
  /** Plays: blue_reels_play_count, else fb_reels_total_plays. */
  plays: number | null;
  avgWatchS: number | null;
  follows: number | null;
}

/** Reads GET /{video-id}/video_insights. avg time watched arrives in milliseconds. */
export function parseVideoInsights(raw: unknown): VideoInsights {
  const v = parsePostInsights(raw);
  const avgMs = v.post_video_avg_time_watched ?? null;
  return {
    plays: v.blue_reels_play_count ?? v.fb_reels_total_plays ?? null,
    avgWatchS: avgMs === null ? null : avgMs / 1000,
    follows: v.post_video_followers ?? null,
  };
}

/** Page insight metric → fb_page_daily column. Old names stay as aliases for responses that predate the rename. */
export const PAGE_METRIC_COLUMNS: Record<string, PageDailyColumn> = {
  page_total_media_view_unique: 'reach',
  page_impressions_unique: 'reach',
  page_media_view: 'impressions',
  page_impressions: 'impressions',
  page_post_engagements: 'engaged_users',
  page_engaged_users: 'engaged_users',
  page_daily_follows_unique: 'new_follows',
  page_fan_adds: 'new_follows',
  page_daily_unfollows_unique: 'unfollows',
  page_follows: 'followers_total',
  page_fans: 'followers_total',
  page_total_actions: 'link_clicks',
};

export type PageDailyColumn =
  'reach' | 'impressions' | 'engaged_users' | 'new_follows' | 'unfollows' | 'followers_total' | 'link_clicks';

export type PageDailyValues = Partial<Record<PageDailyColumn, number>>;

/** Folds a page insights response into per-day column values (days labelled by Meta's day). */
export function pageInsightsToDaily(raw: unknown): Map<string, PageDailyValues> {
  const days = new Map<string, PageDailyValues>();
  for (const [metric, points] of parseInsightSeries(raw)) {
    const column = PAGE_METRIC_COLUMNS[metric];
    if (!column) continue;
    for (const p of points) {
      if (p.endTime === null) continue;
      const day = dayFromEndTime(p.endTime);
      const row = days.get(day) ?? {};
      row[column] = p.value;
      days.set(day, row);
    }
  }
  return days;
}
