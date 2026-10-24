/**
 * Daily sending window for list (1-1) broadcasts — pure functions, no DB.
 *
 * A list campaign does not fire at fixed times; it drips messages during a
 * window ([windowStart, windowEnd) on the chosen weekdays) until the daily
 * quota is reached. All calendar maths goes through Intl in the campaign's
 * timezone so "today" resets at local midnight, not at 07:00 (UTC midnight).
 */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;
/** Look-ahead cap when searching the next open window (a year of days). */
const MAX_LOOKAHEAD_DAYS = 400;
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface WindowSpec {
  /** 'HH:mm' wall clock in `timezone`. */
  windowStart: string;
  windowEnd: string;
  /** 0 = Sunday .. 6 = Saturday. Empty = every day. */
  daysOfWeek: number[];
  timezone: string;
  /** 'YYYY-MM-DD' calendar dates in `timezone`, both inclusive. */
  startDate: string | null;
  endDate: string | null;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'short', hour: '2-digit', minute: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Calendar date + wall clock of `at` as seen in `timeZone`. */
export function zonedParts(at: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
  };
}

/**
 * The UTC instant at which the wall clock in `timeZone` reads the given time.
 * Offset is solved by iteration so it stays correct across DST changes.
 */
export function zonedWallClockToUtc(
  year: number, month: number, day: number, hour: number, minute: number, timeZone: string,
): Date {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = wanted - seen;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

/** 'HH:mm' → minutes since midnight, or null when malformed. */
export function minutesOfDay(hhmm: string): number | null {
  const m = TIME_RE.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Comparable integer for a calendar day: 20261007. */
function dayKey(d: { year: number; month: number; day: number }): number {
  return d.year * 10000 + d.month * 100 + d.day;
}

function dateStringKey(s: string): number {
  return Number(s.replace(/-/g, ''));
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Overnight window: end at or before start (22:00 → 02:00). */
function isOvernight(start: number, end: number): boolean {
  return end <= start;
}

/**
 * The calendar day a moment "belongs" to for weekday/date-range checks.
 * The after-midnight tail of an overnight window belongs to the day it began.
 */
function sessionDay(spec: WindowSpec, at: Date, start: number, end: number): ZonedParts {
  const p = zonedParts(at, spec.timezone);
  if (isOvernight(start, end) && p.hour * 60 + p.minute < end) {
    return zonedParts(new Date(at.getTime() - MS_PER_DAY), spec.timezone);
  }
  return p;
}

function dayAllowed(spec: WindowSpec, day: { year: number; month: number; day: number; weekday: number }): boolean {
  if (spec.daysOfWeek.length > 0 && !spec.daysOfWeek.includes(day.weekday)) return false;
  const key = dayKey(day);
  if (spec.startDate && key < dateStringKey(spec.startDate)) return false;
  if (spec.endDate && key > dateStringKey(spec.endDate)) return false;
  return true;
}

/** True when `now` is inside the window of an allowed day. */
export function isWithinWindow(now: Date, spec: WindowSpec): boolean {
  const start = minutesOfDay(spec.windowStart);
  const end = minutesOfDay(spec.windowEnd);
  if (start === null || end === null || start === end) return false;

  if (!dayAllowed(spec, sessionDay(spec, now, start, end))) return false;

  const p = zonedParts(now, spec.timezone);
  const minutes = p.hour * 60 + p.minute;
  return isOvernight(start, end) ? minutes >= start || minutes < end : minutes >= start && minutes < end;
}

/**
 * Bounds of the local calendar day containing `at` (end exclusive), in epoch
 * ms. Daily quotas are counted against these so they reset at local midnight.
 */
export function dayBounds(timezone: string, at: Date): { startMs: number; endMs: number } {
  const p = zonedParts(at, timezone);
  const start = zonedWallClockToUtc(p.year, p.month, p.day, 0, 0, timezone);
  // Next midnight computed from the calendar (a DST day is not always 24 h).
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day) + MS_PER_DAY);
  const end = zonedWallClockToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timezone);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

/** Daily window length in minutes (overnight windows wrap past midnight). */
export function windowLengthMinutes(spec: Pick<WindowSpec, 'windowStart' | 'windowEnd'>): number {
  const start = minutesOfDay(spec.windowStart);
  const end = minutesOfDay(spec.windowEnd);
  if (start === null || end === null || start === end) return 0;
  return end > start ? end - start : 24 * 60 - start + end;
}

/** Days per week the campaign sends (empty list = all 7). */
export function sendingDaysPerWeek(spec: Pick<WindowSpec, 'daysOfWeek'>): number {
  return spec.daysOfWeek.length === 0 ? 7 : new Set(spec.daysOfWeek).size;
}

/**
 * When the window next opens, starting from `from`. Returns `from` itself when
 * already inside the window, null when the end date has passed or nothing
 * opens within a year. For display only — sending is gated by isWithinWindow.
 */
export function nextWindowOpen(from: Date, spec: WindowSpec): Date | null {
  const start = minutesOfDay(spec.windowStart);
  const end = minutesOfDay(spec.windowEnd);
  if (start === null || end === null || start === end) return null;
  if (isWithinWindow(from, spec)) return from;

  const base = zonedParts(from, spec.timezone);
  for (let i = 0; i <= MAX_LOOKAHEAD_DAYS; i++) {
    // Walk calendar days, not 24 h steps, so DST never skips or repeats a day.
    const cal = new Date(Date.UTC(base.year, base.month - 1, base.day) + i * MS_PER_DAY);
    const day = {
      year: cal.getUTCFullYear(), month: cal.getUTCMonth() + 1, day: cal.getUTCDate(), weekday: cal.getUTCDay(),
    };
    if (spec.endDate && dayKey(day) > dateStringKey(spec.endDate)) return null;
    if (!dayAllowed(spec, day)) continue;
    const open = zonedWallClockToUtc(day.year, day.month, day.day, Math.floor(start / 60), start % 60, spec.timezone);
    if (open.getTime() > from.getTime()) return open;
  }
  return null;
}

/** Vietnamese validation errors for a window spec; empty array when valid. */
export function validateWindow(spec: WindowSpec): string[] {
  const errors: string[] = [];
  if (!isValidTimezone(spec.timezone)) errors.push('Múi giờ không hợp lệ');
  const start = minutesOfDay(spec.windowStart);
  const end = minutesOfDay(spec.windowEnd);
  if (start === null || end === null) errors.push('Giờ bắt đầu/kết thúc phải có dạng HH:mm');
  else if (start === end) errors.push('Giờ bắt đầu và kết thúc không được trùng nhau');
  if (spec.daysOfWeek.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) errors.push('Ngày trong tuần không hợp lệ');
  if (spec.startDate && !DATE_RE.test(spec.startDate)) errors.push('Ngày bắt đầu không hợp lệ');
  if (spec.endDate && !DATE_RE.test(spec.endDate)) errors.push('Ngày kết thúc không hợp lệ');
  if (spec.startDate && spec.endDate && DATE_RE.test(spec.startDate) && DATE_RE.test(spec.endDate)
    && spec.endDate < spec.startDate) errors.push('Ngày kết thúc phải sau ngày bắt đầu');
  return errors;
}
