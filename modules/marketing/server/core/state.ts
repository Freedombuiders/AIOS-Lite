/**
 * Pure rules of Content Studio: the content state machine, the Page
 * scheduling rules and the publish retry policy. No I/O here so the logic can
 * be tested hard; content.ts and publisher.ts apply the results.
 */

import type { FbContentStatus, FbFormat } from '../types.js';
import { formatLocalShort, localDayKey, localParts, parseHm } from './time.js';

export const ALL_STATUSES: FbContentStatus[] = [
  'idea', 'draft', 'review', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'missed', 'deleted',
];

export const FORMATS: FbFormat[] = ['reel', 'video', 'photo', 'album', 'text', 'link'];

/** Statuses a person works in before a post is approved. */
export const AUTHORING: FbContentStatus[] = ['idea', 'draft', 'review'];

/** Statuses `approve` accepts. */
const APPROVABLE: FbContentStatus[] = ['idea', 'draft', 'review', 'approved', 'scheduled', 'failed', 'missed'];

/** Statuses `publish-now` accepts. */
export const PUBLISH_NOW_FROM: FbContentStatus[] = ['approved', 'scheduled', 'failed', 'missed'];

/** Targets a plain PATCH may move a row to: idea → draft → review only (approve, return, schedule and publish have their own endpoints). */
const PATCH_TARGETS: Record<FbContentStatus, FbContentStatus[]> = {
  idea: ['draft'],
  draft: ['review'],
  review: [],
  approved: [],
  scheduled: [],
  publishing: [],
  published: [],
  failed: [],
  missed: [],
  deleted: [],
};

/** Fields that may still change after a post is live (tags only, the Facebook post itself is not edited). */
export const TAG_FIELDS = ['title', 'pillar', 'hookType', 'cta', 'campaign'] as const;

export function canApprove(from: FbContentStatus): boolean {
  return APPROVABLE.includes(from);
}

export function canPatchStatus(from: FbContentStatus, to: FbContentStatus): boolean {
  return from === to || PATCH_TARGETS[from].includes(to);
}

/** True when the row's content may be edited at all (published rows only take tag edits). */
export function isEditable(status: FbContentStatus): 'full' | 'tags' | 'none' {
  if (status === 'publishing' || status === 'deleted') return 'none';
  if (status === 'published') return 'tags';
  return 'full';
}

export function canUnschedule(from: FbContentStatus): boolean {
  return from === 'scheduled';
}

export function canReturn(from: FbContentStatus): boolean {
  return from === 'review' || from === 'approved' || from === 'scheduled' || from === 'failed' || from === 'missed';
}

export function canDeleteLocal(from: FbContentStatus): boolean {
  return from !== 'publishing';
}

export function canDeleteRemote(from: FbContentStatus): boolean {
  return from === 'published';
}

// ── Completeness ─────────────────────────────────────────────────────

export interface PublishableContent {
  pageId: string | null;
  format: FbFormat;
  caption: string;
  linkUrl: string;
  media: Array<{ kind: 'video' | 'image' }>;
}

/** Vietnamese reasons why a post cannot be published as it stands; empty when it is complete. */
export function completenessProblems(c: PublishableContent): string[] {
  const out: string[] = [];
  const images = c.media.filter((m) => m.kind === 'image').length;
  const videos = c.media.filter((m) => m.kind === 'video').length;
  if (!c.pageId) out.push('Chưa chọn Fanpage.');
  switch (c.format) {
    case 'text':
      if (!c.caption.trim()) out.push('Bài văn bản cần có nội dung.');
      break;
    case 'link':
      if (!/^https?:\/\//i.test(c.linkUrl.trim())) out.push('Bài link cần có đường dẫn bắt đầu bằng http:// hoặc https://.');
      break;
    case 'photo':
      if (images < 1) out.push('Bài ảnh cần ít nhất 1 ảnh.');
      break;
    case 'album':
      if (images < 1) out.push('Album cần ít nhất 1 ảnh.');
      break;
    case 'video':
    case 'reel':
      if (videos < 1) out.push('Bài video cần 1 tệp video.');
      break;
  }
  return out;
}

// ── Scheduling rules ─────────────────────────────────────────────────

export interface PageScheduleRules {
  timezone: string;
  maxPostsPerDay: number;
  minGapMinutes: number;
  windowStart: string;
  windowEnd: string;
}

export interface ScheduleVerdict {
  ok: boolean;
  /** Vietnamese reason when not ok. */
  reason: string;
}

/**
 * Checks a proposed publish time against the Page rules. `others` are the
 * times (seconds) of the Page's other scheduled or published posts around it.
 */
export function validateSchedule(rules: PageScheduleRules, at: number, now: number, others: number[]): ScheduleVerdict {
  const tz = rules.timezone;
  if (!Number.isFinite(at) || at <= now) {
    return { ok: false, reason: 'Thời gian đăng đã qua, hãy chọn một thời điểm trong tương lai.' };
  }

  const start = parseHm(rules.windowStart);
  const end = parseHm(rules.windowEnd);
  if (start !== null && end !== null) {
    const p = localParts(at, tz);
    const minutes = p.hour * 60 + p.minute;
    const inside = start <= end ? minutes >= start && minutes <= end : minutes >= start || minutes <= end;
    if (!inside) {
      return {
        ok: false,
        reason: `Giờ đăng ${formatLocalShort(at, tz).slice(0, 5)} nằm ngoài khung ${rules.windowStart}–${rules.windowEnd} của Fanpage (múi giờ ${tz}).`,
      };
    }
  }

  const gap = Math.max(0, rules.minGapMinutes) * 60;
  if (gap > 0) {
    const near = others.find((t) => Math.abs(t - at) < gap);
    if (near !== undefined) {
      const minutes = Math.round(Math.abs(near - at) / 60);
      return {
        ok: false,
        reason: `Cách bài khác lúc ${formatLocalShort(near, tz)} chỉ ${minutes} phút, Fanpage yêu cầu tối thiểu ${rules.minGapMinutes} phút.`,
      };
    }
  }

  if (rules.maxPostsPerDay > 0) {
    const day = localDayKey(at, tz);
    const sameDay = others.filter((t) => localDayKey(t, tz) === day).length;
    if (sameDay >= rules.maxPostsPerDay) {
      const label = formatLocalShort(at, tz).slice(6);
      return { ok: false, reason: `Ngày ${label} Fanpage đã đủ ${rules.maxPostsPerDay} bài, không thể thêm.` };
    }
  }

  return { ok: true, reason: '' };
}

// ── Publish attempts ─────────────────────────────────────────────────

/** Minutes to wait after the 1st, 2nd and 3rd failed attempt. After the 3rd retry fails the row becomes 'failed'. */
export const RETRY_DELAYS_MIN = [2, 5, 15];

/** Rows stuck in 'publishing' for longer than this (and not owned by this process) are failed. */
export const STUCK_AFTER_SEC = 10 * 60;

export const STUCK_MESSAGE = 'Bị gián đoạn — kiểm tra Facebook trước khi đăng lại.';

export type AttemptOutcome =
  | { kind: 'retry'; delayMin: number }
  | { kind: 'failed' };

/** What to do after attempt number `attempts` (1-based, already counted) failed with a retryable error. */
export function nextAfterTransientFailure(attempts: number): AttemptOutcome {
  const delay = RETRY_DELAYS_MIN[attempts - 1];
  return delay === undefined ? { kind: 'failed' } : { kind: 'retry', delayMin: delay };
}

/** The first attempt of a row may not run later than `graceMinutes` after its scheduled time. */
export function isPastGrace(scheduledAt: number, graceMinutes: number, now: number): boolean {
  return now > scheduledAt + Math.max(0, graceMinutes) * 60;
}

/**
 * Whether an error is worth retrying. Only rate limits and 5xx responses:
 * anything ambiguous (timeouts, resets) could have created the post already
 * and a retry would duplicate it.
 */
export function isTransientMessage(message: string): boolean {
  return /\b5\d\d\b|service unavailable|bad gateway|internal server error|temporarily unavailable/i.test(message);
}
