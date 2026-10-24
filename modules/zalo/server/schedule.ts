/**
 * Schedule math for scheduled group broadcasts. Pure functions, Intl only (no
 * date library, no DB).
 *
 * Ported from ZaloCRM's group-broadcast-schedule.ts. Times of day are wall
 * clock in the campaign timezone; start/end dates are 'YYYY-MM-DD' wall dates
 * in that same timezone (inclusive on both ends), so a campaign "until 31/10"
 * still fires on the evening of the 31st whatever the server timezone is.
 */

import { DEFAULT_TIMEZONE } from './marketing-deps.js';

export type ScheduleKind = 'now' | 'daily' | 'weekly' | 'monthly';

export interface ScheduleSpec {
  scheduleKind: ScheduleKind;
  /** ['08:00', '20:00'] — HH:mm 24h, wall clock in `timezone`. */
  timesOfDay: string[];
  /** 0 = Sunday .. 6 = Saturday; weekly only. */
  daysOfWeek: number[];
  /** 1..31; monthly only. */
  daysOfMonth: number[];
  timezone: string;
  /** 'YYYY-MM-DD' in `timezone`, inclusive. */
  startDate: string | null;
  endDate: string | null;
}

/** More send times per day than this is a misconfiguration, not a real need. */
export const MAX_TIMES_PER_DAY = 12;
/** How far ahead nextRunAt looks before declaring the schedule over. */
const MAX_LOOKAHEAD_DAYS = 400;
const MS_PER_DAY = 86_400_000;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const SCHEDULE_KINDS: readonly ScheduleKind[] = ['now', 'daily', 'weekly', 'monthly'];

// ── Timezone helpers (Intl only) ─────────────────────────────────────

/** Offset in minutes of `timeZone` at instant `at`. Asia/Ho_Chi_Minh → 420. */
function tzOffsetMinutes(at: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? '');
  if (!m) return 0; // plain "GMT" = UTC
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * Wall clock in `timeZone` → UTC instant. Two passes: the first compensates
 * with an estimated offset, the second converges when the offset changes (DST).
 */
export function zonedWallClockToUtc(
  year: number, month: number, day: number, hour: number, minute: number, timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let utc = naive;
  for (let i = 0; i < 2; i++) {
    utc = naive - tzOffsetMinutes(new Date(utc), timeZone) * 60_000;
  }
  return new Date(utc);
}

export interface ZonedDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  weekday: number; // 0 = Sunday
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Calendar date and weekday of instant `at` as seen in `timeZone`. */
export function zonedDateParts(at: Date, timeZone: string): ZonedDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  };
}

/** Comparable integer for a calendar day: 20260803. */
function dayKey(d: { year: number; month: number; day: number }): number {
  return d.year * 10000 + d.month * 100 + d.day;
}

/** 'YYYY-MM-DD' → comparable day key, or null when malformed. */
function dateKeyOf(date: string | null): number | null {
  if (!date) return null;
  const m = DATE_RE.exec(date);
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : null;
}

/** Today's 'YYYY-MM-DD' in `timeZone` (for UI defaults and validation). */
export function todayInZone(timeZone: string = DEFAULT_TIMEZONE, now: Date = new Date()): string {
  const d = zonedDateParts(now, timeZone);
  return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

// ── Day matching ─────────────────────────────────────────────────────

function dayMatchesSpec(spec: ScheduleSpec, day: ZonedDate): boolean {
  if (spec.scheduleKind === 'daily') return true;
  if (spec.scheduleKind === 'weekly') return spec.daysOfWeek.includes(day.weekday);
  // The 31st in a 30-day month is skipped, not rolled to the 1st: rolling over
  // would send on a day the operator never picked.
  if (spec.scheduleKind === 'monthly') return spec.daysOfMonth.includes(day.day);
  return false;
}

function withinDateRange(spec: ScheduleSpec, day: ZonedDate): boolean {
  const key = dayKey(day);
  const start = dateKeyOf(spec.startDate);
  const end = dateKeyOf(spec.endDate);
  if (start !== null && key < start) return false;
  if (end !== null && key > end) return false;
  return true;
}

/** The send instants of ONE calendar day, ascending. */
function occurrencesOnDay(spec: ScheduleSpec, day: ZonedDate): Date[] {
  if (!dayMatchesSpec(spec, day) || !withinDateRange(spec, day)) return [];
  const out: Date[] = [];
  for (const t of spec.timesOfDay) {
    const m = TIME_RE.exec(t);
    if (!m) continue;
    out.push(zonedWallClockToUtc(day.year, day.month, day.day, Number(m[1]), Number(m[2]), spec.timezone));
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Send instants in `(after, until]` — the catch-up window. Walks one extra day
 * on each side because a wall-clock time can land on a different UTC day.
 */
export function occurrencesBetween(spec: ScheduleSpec, after: Date, until: Date): Date[] {
  if (spec.scheduleKind === 'now' || spec.timesOfDay.length === 0) return [];
  if (until.getTime() <= after.getTime()) return [];

  const out: number[] = [];
  for (let t = after.getTime() - MS_PER_DAY; t <= until.getTime() + MS_PER_DAY; t += MS_PER_DAY) {
    for (const at of occurrencesOnDay(spec, zonedDateParts(new Date(t), spec.timezone))) {
      if (at.getTime() > after.getTime() && at.getTime() <= until.getTime()) out.push(at.getTime());
    }
  }
  return [...new Set(out)].sort((a, b) => a - b).map((ms) => new Date(ms));
}

/** First send instant strictly after `from`, or null when the schedule is over. */
export function nextRunAt(spec: ScheduleSpec, from: Date): Date | null {
  if (spec.scheduleKind === 'now' || spec.timesOfDay.length === 0) return null;

  const endKey = dateKeyOf(spec.endDate);
  for (let i = 0; i <= MAX_LOOKAHEAD_DAYS; i++) {
    const day = zonedDateParts(new Date(from.getTime() + i * MS_PER_DAY), spec.timezone);
    if (endKey !== null && dayKey(day) > endKey) return null;
    for (const at of occurrencesOnDay(spec, day)) {
      if (at.getTime() > from.getTime()) return at;
    }
  }
  return null;
}

// ── Validation ───────────────────────────────────────────────────────

export type ScheduleErrorCode =
  | 'INVALID_TIMEZONE' | 'TIMES_REQUIRED' | 'INVALID_TIME' | 'TOO_MANY_TIMES'
  | 'INVALID_DAYS_OF_WEEK' | 'INVALID_DAYS_OF_MONTH' | 'INVALID_DATE' | 'INVALID_DATE_RANGE';

export const SCHEDULE_ERROR_MESSAGE: Record<ScheduleErrorCode, string> = {
  INVALID_TIMEZONE: 'Múi giờ không hợp lệ',
  TIMES_REQUIRED: 'Chọn ít nhất 1 mốc giờ gửi',
  INVALID_TIME: 'Mốc giờ phải có dạng HH:mm (ví dụ 08:30)',
  TOO_MANY_TIMES: `Tối đa ${MAX_TIMES_PER_DAY} mốc giờ mỗi ngày`,
  INVALID_DAYS_OF_WEEK: 'Chọn ít nhất 1 thứ trong tuần',
  INVALID_DAYS_OF_MONTH: 'Chọn ít nhất 1 ngày trong tháng (1–31)',
  INVALID_DATE: 'Ngày bắt đầu/kết thúc không hợp lệ (dạng YYYY-MM-DD)',
  INVALID_DATE_RANGE: 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu',
};

export interface ScheduleValidation {
  ok: boolean;
  errors: ScheduleErrorCode[];
}

function isRealDate(date: string): boolean {
  const m = DATE_RE.exec(date);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

export function validateSchedule(spec: ScheduleSpec): ScheduleValidation {
  const errors: ScheduleErrorCode[] = [];

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: spec.timezone });
  } catch {
    errors.push('INVALID_TIMEZONE');
  }

  if (spec.scheduleKind !== 'now') {
    if (spec.timesOfDay.length === 0) errors.push('TIMES_REQUIRED');
    if (spec.timesOfDay.some((t) => !TIME_RE.test(t))) errors.push('INVALID_TIME');
    if (spec.timesOfDay.length > MAX_TIMES_PER_DAY) errors.push('TOO_MANY_TIMES');
  }

  if (spec.scheduleKind === 'weekly') {
    if (spec.daysOfWeek.length === 0 || spec.daysOfWeek.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      errors.push('INVALID_DAYS_OF_WEEK');
    }
  }

  if (spec.scheduleKind === 'monthly') {
    if (spec.daysOfMonth.length === 0 || spec.daysOfMonth.some((d) => !Number.isInteger(d) || d < 1 || d > 31)) {
      errors.push('INVALID_DAYS_OF_MONTH');
    }
  }

  const badDate = (spec.startDate !== null && !isRealDate(spec.startDate))
    || (spec.endDate !== null && !isRealDate(spec.endDate));
  if (badDate) errors.push('INVALID_DATE');
  else if (spec.startDate && spec.endDate && spec.endDate < spec.startDate) errors.push('INVALID_DATE_RANGE');

  return { ok: errors.length === 0, errors };
}

/** Unique + ascending times, weekdays and month days. */
export function normalizeSchedule<T extends { timesOfDay?: string[]; daysOfWeek?: number[]; daysOfMonth?: number[] }>(
  input: T,
): T & { timesOfDay: string[]; daysOfWeek: number[]; daysOfMonth: number[] } {
  return {
    ...input,
    timesOfDay: [...new Set(input.timesOfDay ?? [])].sort(),
    daysOfWeek: [...new Set(input.daysOfWeek ?? [])].sort((a, b) => a - b),
    daysOfMonth: [...new Set(input.daysOfMonth ?? [])].sort((a, b) => a - b),
  };
}

/**
 * Smallest gap in minutes between two neighbouring send times, wrapping past
 * midnight (23:00 → 01:00 is 120). Infinity with fewer than two valid times.
 */
export function minGapMinutes(timesOfDay: string[]): number {
  const mins = [...new Set(timesOfDay)]
    .map((t) => TIME_RE.exec(t))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]) * 60 + Number(m[2]))
    .sort((a, b) => a - b);
  if (mins.length < 2) return Infinity;

  let smallest = 24 * 60 - mins[mins.length - 1] + mins[0];
  for (let i = 1; i < mins.length; i++) smallest = Math.min(smallest, mins[i] - mins[i - 1]);
  return smallest;
}
