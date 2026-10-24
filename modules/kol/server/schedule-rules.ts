/**
 * Pure rules of the KOL publishing flow: the post state machine, the status a
 * post derives from its targets, format checks per platform, the per-account
 * scheduling rules (timezone-aware) and the publish retry policy. No I/O here:
 * posts.ts and publisher.ts apply the results.
 */

import { formatLocalShort, localDayKey, localParts, parseHm } from './time.js';
import type { AssetKind, Platform, PostFormat, PostStatus, TargetStatus } from './types.js';

export const PLATFORMS: Platform[] = ['facebook', 'instagram', 'tiktok', 'youtube'];
export const POST_FORMATS: PostFormat[] = ['photo', 'carousel', 'reel', 'video', 'text'];

export const PLATFORM_LABEL: Record<Platform, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

// ── State machine ────────────────────────────────────────────────────
//
//   idea → draft → review → approved → scheduled → publishing → published | partial | failed
//   (any but publishing) → cancelled;  review/approved/scheduled/failed → draft (return)

/** Statuses whose content may still be edited (PATCH). */
export const EDITABLE_FROM: PostStatus[] = ['idea', 'draft', 'review', 'approved', 'scheduled'];
export const SUBMIT_FROM: PostStatus[] = ['idea', 'draft'];
/** 'failed' is approvable so the owner can pick a new time for a post that failed everywhere. */
export const APPROVE_FROM: PostStatus[] = ['idea', 'draft', 'review', 'approved', 'scheduled', 'failed'];
export const RETURN_FROM: PostStatus[] = ['review', 'approved', 'scheduled', 'failed'];
export const PUBLISH_NOW_FROM: PostStatus[] = ['approved', 'scheduled', 'failed', 'partial'];

export const canEdit = (s: PostStatus): boolean => EDITABLE_FROM.includes(s);
export const canSubmit = (s: PostStatus): boolean => SUBMIT_FROM.includes(s);
export const canApprove = (s: PostStatus): boolean => APPROVE_FROM.includes(s);
export const canReturn = (s: PostStatus): boolean => RETURN_FROM.includes(s);
export const canPublishNow = (s: PostStatus): boolean => PUBLISH_NOW_FROM.includes(s);
export const canCancel = (s: PostStatus): boolean => s !== 'publishing' && s !== 'cancelled';

const PRE_SCHEDULE: PostStatus[] = ['idea', 'draft', 'review', 'approved'];
const ACTIVE_TARGET: TargetStatus[] = ['publishing', 'processing'];
const FINAL_TARGET: TargetStatus[] = ['published', 'failed', 'missed'];

export const isFinalTarget = (s: TargetStatus): boolean => FINAL_TARGET.includes(s);

/**
 * The post status implied by its targets. Skipped targets do not count.
 * Any target at work → publishing; scheduled targets → scheduled (or
 * publishing when others already finished); all finished → published,
 * partial (some published) or failed. Authoring statuses are kept while every
 * target is still pending.
 */
export function derivePostStatus(current: PostStatus, targets: TargetStatus[]): PostStatus {
  if (current === 'cancelled') return 'cancelled';
  const live = targets.filter((t) => t !== 'skipped');
  if (live.length === 0) return current;
  if (live.some((t) => ACTIVE_TARGET.includes(t))) return 'publishing';
  const finals = live.filter((t) => FINAL_TARGET.includes(t));
  if (live.some((t) => t === 'scheduled')) return finals.length ? 'publishing' : 'scheduled';
  if (finals.length === 0) return PRE_SCHEDULE.includes(current) ? current : 'draft';
  const published = finals.filter((t) => t === 'published').length;
  if (published === finals.length && finals.length === live.length) return 'published';
  if (published > 0) return 'partial';
  return 'failed';
}

// ── Format checks ────────────────────────────────────────────────────

export interface MediaFacts {
  kind: AssetKind;
  width: number | null;
  height: number | null;
  durationSec: number | null;
}

/** Vietnamese reasons why `format` with this media cannot go to `platform`; empty when fine. */
export function formatProblems(platform: Platform, format: PostFormat, media: MediaFacts[], caption = ''): string[] {
  const label = PLATFORM_LABEL[platform];
  const images = media.filter((m) => m.kind === 'image').length;
  const videos = media.filter((m) => m.kind === 'video').length;
  const audio = media.filter((m) => m.kind === 'audio').length;
  const out: string[] = [];
  if (audio) out.push(`${label} không đăng được tệp âm thanh riêng, hãy bỏ tệp âm thanh khỏi bài.`);

  switch (platform) {
    case 'tiktok':
    case 'youtube':
      if (format !== 'reel' && format !== 'video') out.push(`${label} chỉ đăng video (chọn định dạng Reel hoặc Video).`);
      else if (videos !== 1 || images > 0) out.push(`${label} cần đúng 1 video và không kèm ảnh.`);
      break;
    case 'instagram':
      if (format === 'text') out.push('Instagram không đăng bài chỉ có chữ, hãy thêm ảnh hoặc video.');
      else if (format === 'photo' && (images !== 1 || videos > 0)) out.push('Bài ảnh Instagram cần đúng 1 ảnh (nhiều ảnh thì chọn Carousel).');
      else if (format === 'carousel' && (images < 2 || images > 10 || videos > 0)) out.push('Carousel Instagram cần từ 2 đến 10 ảnh (không kèm video).');
      else if ((format === 'reel' || format === 'video') && (videos !== 1 || images > 0)) out.push('Reel Instagram cần đúng 1 video và không kèm ảnh.');
      else if ((format === 'reel' || format === 'video')) {
        const d = media.find((m) => m.kind === 'video')?.durationSec;
        if (d !== null && d !== undefined && d < 3) out.push('Reel Instagram phải dài ít nhất 3 giây.');
      }
      break;
    case 'facebook':
      if (format === 'text' && !caption.trim()) out.push('Bài chữ trên Facebook cần có nội dung.');
      else if (format === 'photo' && (images < 1 || videos > 0)) out.push('Bài ảnh Facebook cần ít nhất 1 ảnh và không kèm video.');
      else if (format === 'carousel' && (images < 2 || videos > 0)) out.push('Album Facebook cần ít nhất 2 ảnh.');
      else if ((format === 'reel' || format === 'video') && (videos !== 1 || images > 0)) out.push('Video Facebook cần đúng 1 video và không kèm ảnh.');
      break;
  }
  return out;
}

/** True for a vertical clip of at most 3 minutes (YouTube treats it as a Short). */
export function isShort(m: { width: number | null; height: number | null; durationSec: number | null } | undefined): boolean {
  if (!m || !m.width || !m.height) return false;
  return m.height > m.width && (m.durationSec === null || m.durationSec <= 180);
}

// ── Scheduling rules ─────────────────────────────────────────────────

export interface AccountRules {
  /** How the account is named in messages, e.g. "Instagram @mai.ai". */
  label: string;
  timezone: string;
  maxPostsPerDay: number;
  minGapMinutes: number;
  windowStart: string;
  windowEnd: string;
}

export interface ScheduleVerdict {
  ok: boolean;
  /** Vietnamese reason naming the account when not ok. */
  reason: string;
}

export interface ScheduleCheckOptions {
  /** publish-now: the time is "now", the window and the gap do not apply (the daily cap still does). */
  publishNow?: boolean;
}

/** True when the local wall-clock time of `at` falls inside the window (an overnight window wraps). */
export function insideWindow(rules: Pick<AccountRules, 'timezone' | 'windowStart' | 'windowEnd'>, at: number): boolean {
  const start = parseHm(rules.windowStart);
  const end = parseHm(rules.windowEnd);
  if (start === null || end === null) return true;
  const p = localParts(at, rules.timezone);
  const minutes = p.hour * 60 + p.minute;
  return start <= end ? minutes >= start && minutes <= end : minutes >= start || minutes <= end;
}

/**
 * Checks a publish time for one account. `others` are the times of the
 * account's other scheduled / publishing / published targets (this post's
 * own targets excluded).
 */
export function checkSchedule(rules: AccountRules, at: number, now: number, others: number[], opts: ScheduleCheckOptions = {}): ScheduleVerdict {
  const tz = rules.timezone;
  const who = `Tài khoản ${rules.label}`;
  if (!Number.isFinite(at)) return { ok: false, reason: 'Thời gian đăng không hợp lệ.' };
  if (!opts.publishNow && at <= now) return { ok: false, reason: 'Thời gian đăng đã qua, hãy chọn một thời điểm trong tương lai.' };

  if (!opts.publishNow && !insideWindow(rules, at)) {
    return {
      ok: false,
      reason: `${who}: giờ đăng ${formatLocalShort(at, tz).slice(0, 5)} nằm ngoài khung ${rules.windowStart}–${rules.windowEnd} (múi giờ ${tz}).`,
    };
  }

  const gap = Math.max(0, rules.minGapMinutes) * 60;
  if (!opts.publishNow && gap > 0) {
    const near = others.find((t) => Math.abs(t - at) < gap);
    if (near !== undefined) {
      const minutes = Math.round(Math.abs(near - at) / 60);
      return {
        ok: false,
        reason: `${who}: cách bài khác lúc ${formatLocalShort(near, tz)} chỉ ${minutes} phút, cần tối thiểu ${rules.minGapMinutes} phút.`,
      };
    }
  }

  if (rules.maxPostsPerDay > 0) {
    const day = localDayKey(at, tz);
    const sameDay = others.filter((t) => localDayKey(t, tz) === day).length;
    if (sameDay >= rules.maxPostsPerDay) {
      return { ok: false, reason: `${who}: ngày ${formatLocalShort(at, tz).slice(6)} đã đủ ${rules.maxPostsPerDay} bài, không thể thêm.` };
    }
  }
  return { ok: true, reason: '' };
}

/**
 * The earliest time ≥ `from` (rounded up to `stepMin`) and < `to` that passes
 * checkSchedule for every account, or null. `preferred` is tried first when it
 * lies in range.
 */
export function proposeSlot(
  accounts: { rules: AccountRules; others: number[] }[],
  from: number,
  to: number,
  now: number,
  preferred?: number | null,
  stepMin = 15,
): number | null {
  const fits = (t: number) => accounts.every((a) => checkSchedule(a.rules, t, now, a.others).ok);
  if (preferred && preferred >= from && preferred < to && fits(preferred)) return preferred;
  const step = stepMin * 60;
  let t = Math.ceil(Math.max(from, now + 60) / step) * step;
  for (let i = 0; t < to && i < 2000; i++, t += step) if (fits(t)) return t;
  return null;
}

// ── Publish attempts ─────────────────────────────────────────────────

/** A first attempt may not start later than this after its due time (never post late). */
export const GRACE_SEC = 30 * 60;
/** 'publishing' targets older than this that this process does not own were interrupted. */
export const STUCK_AFTER_SEC = 15 * 60;
/** Instagram / TikTok processing that has not finished by then is given up (and never re-posted). */
export const PROCESSING_TIMEOUT_SEC = 60 * 60;
/** Total attempts for transient failures (rate limit, 5xx): the first plus two retries. */
export const MAX_ATTEMPTS = 3;
/** Minutes to wait after failed attempt 1 and 2. */
export const RETRY_DELAYS_MIN = [2, 5];

export const UNCERTAIN_MESSAGE = 'Không rõ đã đăng hay chưa — kiểm tra trên nền tảng trước khi thử lại';

export type AttemptOutcome = { kind: 'retry'; delayMin: number } | { kind: 'failed' };

/** What to do after attempt number `attempts` (1-based, already counted) failed with a transient error. */
export function nextAfterTransientFailure(attempts: number): AttemptOutcome {
  if (attempts >= MAX_ATTEMPTS) return { kind: 'failed' };
  const delay = RETRY_DELAYS_MIN[Math.max(0, attempts - 1)] ?? RETRY_DELAYS_MIN[RETRY_DELAYS_MIN.length - 1];
  return { kind: 'retry', delayMin: delay };
}

export function isPastGrace(dueAt: number, now: number, graceSec = GRACE_SEC): boolean {
  return now > dueAt + graceSec;
}

/** Plain server errors that mean "nothing happened, try again later". */
export function isTransientMessage(message: string): boolean {
  return /\b(?:500|502|503)\b|service unavailable|bad gateway|internal server error|temporarily unavailable|try again later/i.test(message);
}

/**
 * Errors after which the post may or may not exist on the platform
 * (timeouts, dropped connections, gateway timeouts). Never retried.
 */
export function isUncertainMessage(message: string): boolean {
  return /timed? ?out|timeout|ETIMEDOUT|ECONNRESET|ECONNABORTED|EPIPE|socket hang up|network error|fetch failed|\b504\b|gateway time-?out|\baborted\b/i.test(message);
}
