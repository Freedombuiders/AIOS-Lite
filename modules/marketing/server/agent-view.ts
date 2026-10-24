/**
 * The Facebook analytics screens as data an agent can read: the same DTOs the
 * dashboard renders (Hiệu quả kênh, Hiệu quả bài đăng, a post's detail,
 * trimmed for a prompt. Feeds the analyst's and the content
 * agent's module context, so "what the owner sees" and "what the agent can read"
 * come from one loader.
 *
 * Read-only and offline: it reads the stored snapshots and never calls Meta.
 * Unix-second timestamps (`publishedAt`, `createdAt`, `lastSnapshotAt`…)
 * become "YYYY-MM-DD HH:MM" in the Page's (or ad account's) timezone;
 * sparkline arrays are dropped because the daily series carry the same numbers.
 */

import { getFbAnalyticsPage, getFbAnalyticsPostByFbId } from './store.js';
import { clampDays, loadChannelDashboard, loadPostDetail, loadPostsDashboard } from './analytics/service.js';
import { safeTimezone } from './analytics/time.js';
import { formatLocal } from './core/time.js';
import type { PostsDashboardDto } from './types.js';

export const POST_MILESTONES = ['24h', '7d', '28d', 'latest'] as const;
type PostsMilestone = PostsDashboardDto['milestone'];

const MAX_POST_ROWS = 60;

/** Units the numbers use, so the agent reads 2.7 as 2.7 % rather than 270 %. */
export const FB_UNITS_NOTE = 'Đơn vị: er, erMedian, ctr, hookRate, holdRate, *Pct là phần trăm (2.7 = 2,7%); '
  + 'KPI kênh có trường unit (pct = %, permille = ‰, count = số đếm) và deltaUnit (pct = % thay đổi, pt = điểm %); '
  + 'index = ER bài ÷ ER trung vị của Page (1 = ngang trung vị); tiền theo currency của tài khoản; null = chưa có số.';

function isUnixSeconds(v: unknown): v is number {
  return typeof v === 'number' && v > 1e9 && v < 1e11;
}

/** Drops sparklines and turns unix-second *At fields into local times in `tz`, recursively. */
export function forAgent(value: unknown, tz: string): unknown {
  if (Array.isArray(value)) return value.map((v) => forAgent(v, tz));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'spark') continue;
    out[key] = /At$/.test(key) && isUnixSeconds(v) ? formatLocal(v, tz) : forAgent(v, tz);
  }
  return out;
}

function pageTz(pageId: string): string {
  return safeTimezone(getFbAnalyticsPage(pageId)?.timezone);
}

function capList<T>(rows: T[], max: number): { rows: T[]; omitted?: number } {
  return rows.length > max ? { rows: rows.slice(0, max), omitted: rows.length - max } : { rows };
}

/** Hiệu quả kênh for one Page; null when the Page has no analytics yet. */
export function channelView(pageId: string, days?: number) {
  const dto = loadChannelDashboard(pageId, clampDays(days));
  return dto ? forAgent(dto, pageTz(pageId)) as Record<string, unknown> : null;
}

export function parsePostsMilestone(raw: string | undefined): PostsMilestone {
  return (POST_MILESTONES as readonly string[]).includes(raw ?? '') ? raw as PostsMilestone : 'latest';
}

/** Hiệu quả bài đăng for one Page, best posts first by index. */
export function postsView(pageId: string, days?: number, milestone?: string) {
  const dto = loadPostsDashboard(pageId, clampDays(days), parsePostsMilestone(milestone));
  if (!dto) return null;
  const sorted = [...dto.rows].sort((a, b) => (b.index ?? -1) - (a.index ?? -1));
  const { rows, omitted } = capList(sorted, MAX_POST_ROWS);
  return forAgent({ ...dto, rows, ...(omitted ? { rowsOmitted: omitted } : {}) }, pageTz(pageId)) as Record<string, unknown>;
}

/** One post: reach curve against the Page median, video stats and the Analyst note. */
export function postView(postId: string) {
  const dto = loadPostDetail(postId);
  if (!dto) return null;
  const pageId = getFbAnalyticsPostByFbId(postId)?.page_id;
  return forAgent(dto, pageId ? pageTz(pageId) : safeTimezone(undefined)) as Record<string, unknown>;
}
