/**
 * Birthday greetings — pure date logic (no DB, no I/O).
 *
 * Ported from ZaloCRM's birthday-schedule.ts. All three occasions share one
 * send time of day, so everything reduces to: from the *send day* derive the
 * *birthday date* to look for (before N → today+N, on_day → today,
 * after N → today−N) and match it by 'MM-DD' only.
 *
 * 29 Feb: in a non-leap year that date does not exist, so the lookup for
 * 28 Feb also matches '02-29'. Without this those customers would never be
 * greeted in 3 of every 4 years.
 */

import { DEFAULT_TIMEZONE } from './marketing-deps.js';

const MS_PER_DAY = 86_400_000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type BirthdayOccasion = 'before' | 'on_day' | 'after';
export const BIRTHDAY_OCCASIONS: BirthdayOccasion[] = ['before', 'on_day', 'after'];

export const OCCASION_LABEL: Record<BirthdayOccasion, string> = {
  before: 'Trước sinh nhật',
  on_day: 'Đúng ngày sinh nhật',
  after: 'Sau sinh nhật',
};

export const MIN_OFFSET_DAYS = 1;
export const MAX_OFFSET_DAYS = 30;
/** Past 24 h a catch-up greeting is no longer a greeting. */
export const MAX_LATE_TOLERANCE_MINUTES = 1440;
export const MIN_DELAY_FLOOR_SEC = 5;
export const MAX_DELAY_CAP_SEC = 600;

export interface BirthdayScheduleSpec {
  timezone: string;
  /** 'HH:mm' wall clock in `timezone`. */
  sendTime: string;
  lateToleranceMinutes: number;
  beforeEnabled: boolean;
  beforeDays: number;
  onDayEnabled: boolean;
  afterEnabled: boolean;
  afterDays: number;
}

// ── Timezone helpers (Intl only) ─────────────────────────────────────

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function minutesOfDay(hhmm: string): number | null {
  const m = TIME_RE.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Offset (minutes) of `timeZone` at instant `at`, e.g. Asia/Ho_Chi_Minh → 420. */
function tzOffsetMinutes(at: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? '');
  if (!m) return 0; // plain 'GMT' = UTC
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** Wall-clock moment in `timeZone` → UTC instant. Two passes converge across DST changes. */
export function zonedWallClockToUtc(
  year: number, month: number, day: number, hour: number, minute: number, timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let utc = naive;
  for (let i = 0; i < 2; i++) utc = naive - tzOffsetMinutes(new Date(utc), timeZone) * 60_000;
  return new Date(utc);
}

export interface CalendarDay { year: number; month: number; day: number }

/** Calendar date of instant `at` as seen in `timeZone`. */
export function zonedDateParts(at: Date, timeZone: string): CalendarDay {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** Start/end (UTC) of the calendar day containing `at` in `timeZone`. */
export function dayBoundsUtc(timeZone: string, at: Date): { start: Date; end: Date } {
  const d = zonedDateParts(at, timeZone);
  const start = zonedWallClockToUtc(d.year, d.month, d.day, 0, 0, timeZone);
  const next = new Date(Date.UTC(d.year, d.month - 1, d.day + 1));
  const end = zonedWallClockToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone);
  return { start, end };
}

// ── Calendar arithmetic (UTC midnight = a pure calendar date) ────────

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function formatCalendarDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * MS_PER_DAY);
}

export function calendarDateUtc(c: CalendarDay): Date {
  return new Date(Date.UTC(c.year, c.month - 1, c.day));
}

/** 'MM-DD' values stored birth dates must match for a given calendar date. */
export function monthDaysFor(date: Date): string[] {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const out = [`${pad2(month)}-${pad2(day)}`];
  if (month === 2 && day === 28 && !isLeapYear(date.getUTCFullYear())) out.push('02-29');
  return out;
}

/**
 * The date a stored birth date is celebrated in `year`. 29 Feb moves to
 * 28 Feb in non-leap years (same rule as `monthDaysFor`).
 */
export function celebratedOn(birthDate: string, year: number): string {
  const mmdd = birthDate.slice(5);
  if (mmdd === '02-29' && !isLeapYear(year)) return `${year}-02-28`;
  return `${year}-${mmdd}`;
}

// ── Birth date parsing / validation ──────────────────────────────────

/** Year bounds a *known* birth year must fall in. */
const MIN_BIRTH_YEAR = 1900;

function validMonthDay(month: number, day: number, year: number | null): boolean {
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1) return false;
  // Unknown year: allow 29 Feb. Known year: must be a real date.
  const max = year === null && month === 2 ? 29 : daysInMonth(year ?? 2000, month);
  return day <= max;
}

function compose(year: number | null, month: number, day: number, nowYear: number): string | null {
  // An implausible year with a plausible day/month still tells us the birthday.
  const y = year !== null && year >= MIN_BIRTH_YEAR && year <= nowYear ? year : null;
  if (!validMonthDay(month, day, y)) return null;
  return `${y === null ? '0000' : String(y).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Parse a zca-js profile into the stored form: 'YYYY-MM-DD', or
 * '0000-MM-DD' when the year is unknown. `sdob` ('DD/MM/YYYY' | 'YYYY-MM-DD' |
 * 'DD/MM') wins; `dob` (unix seconds, ms tolerated, 0 = unset) is the fallback.
 */
export function parseProfileBirthDate(sdob: unknown, dob: unknown, now: Date = new Date()): string | null {
  const nowYear = now.getUTCFullYear();
  const s = String(sdob ?? '').trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const r = compose(Number(m[3]), Number(m[2]), Number(m[1]), nowYear);
    if (r) return r;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const r = compose(Number(m[1]), Number(m[2]), Number(m[3]), nowYear);
    if (r) return r;
  }
  m = /^(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m) {
    const r = compose(null, Number(m[2]), Number(m[1]), nowYear);
    if (r) return r;
  }
  const ts = Number(dob ?? 0);
  // A stamp within two days of the epoch is a placeholder, not a birthday.
  if (ts > 172_800 && Number.isFinite(ts)) {
    const ms = ts > 10_000_000_000 ? ts : ts * 1000;
    // Zalo stores local (UTC+7) midnight; reading it at +7 gives the right day
    // for both that and a UTC-midnight stamp.
    const d = new Date(ms + 7 * 3_600_000);
    const y = d.getUTCFullYear();
    if (y >= MIN_BIRTH_YEAR && y <= nowYear) return compose(y, d.getUTCMonth() + 1, d.getUTCDate(), nowYear);
  }
  return null;
}

/** Operator input: 'YYYY-MM-DD' or 'MM-DD'. Returns the stored form or null when invalid. */
export function normalizeBirthDateInput(raw: unknown, now: Date = new Date()): string | null {
  const s = String(raw ?? '').trim();
  const nowYear = now.getUTCFullYear();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const year = Number(m[1]);
    // '0000-MM-DD' is the stored "year unknown" form and is accepted as such.
    if (year === 0) return compose(null, Number(m[2]), Number(m[3]), nowYear);
    if (year < MIN_BIRTH_YEAR || year > nowYear) return null;
    return compose(year, Number(m[2]), Number(m[3]), nowYear);
  }
  m = /^(\d{2})-(\d{2})$/.exec(s);
  if (m) return compose(null, Number(m[1]), Number(m[2]), nowYear);
  return null;
}

/** Age the customer turns in the year of `birthdayOn`, or null when the year is unknown/implausible. */
export function ageOnBirthday(birthDate: string, birthdayOn: string): number | null {
  if (birthDate.startsWith('0000')) return null;
  const age = Number(birthdayOn.slice(0, 4)) - Number(birthDate.slice(0, 4));
  return age >= 0 && age <= 120 ? age : null;
}

// ── Planning ─────────────────────────────────────────────────────────

export function isOccasionEnabled(spec: BirthdayScheduleSpec, occasion: BirthdayOccasion): boolean {
  if (occasion === 'before') return spec.beforeEnabled;
  if (occasion === 'after') return spec.afterEnabled;
  return spec.onDayEnabled;
}

/** Days from the send day to the birthday. Positive = birthday still ahead. */
export function occasionOffsetDays(spec: BirthdayScheduleSpec, occasion: BirthdayOccasion): number {
  if (occasion === 'before') return spec.beforeDays;
  if (occasion === 'after') return -spec.afterDays;
  return 0;
}

export interface PlannedOccasion {
  occasion: BirthdayOccasion;
  /** 'YYYY-MM-DD' of the birthday this occasion greets (idempotency key). */
  birthdayOn: string;
  monthDays: string[];
  /** Unix seconds when the greeting becomes due. */
  dueAt: number;
}

/** Occasions to plan for the calendar day containing `now` in the spec's timezone. */
export function plannedOccasionsFor(spec: BirthdayScheduleSpec, now: Date): PlannedOccasion[] {
  const minutes = minutesOfDay(spec.sendTime);
  if (minutes === null) return [];
  const sendDay = zonedDateParts(now, spec.timezone);
  const dueAt = Math.floor(zonedWallClockToUtc(
    sendDay.year, sendDay.month, sendDay.day, Math.floor(minutes / 60), minutes % 60, spec.timezone,
  ).getTime() / 1000);
  const base = calendarDateUtc(sendDay);
  const out: PlannedOccasion[] = [];
  for (const occasion of BIRTHDAY_OCCASIONS) {
    if (!isOccasionEnabled(spec, occasion)) continue;
    const birthday = addDays(base, occasionOffsetDays(spec, occasion));
    out.push({ occasion, birthdayOn: formatCalendarDate(birthday), monthDays: monthDaysFor(birthday), dueAt });
  }
  return out;
}

/** Past the grace window → skip instead of firing a pile of greetings at 3 am after an outage. */
export function isTooLate(lateToleranceMinutes: number, dueAtSec: number, now: Date): boolean {
  return now.getTime() > dueAtSec * 1000 + lateToleranceMinutes * 60_000;
}

/** True when `hhmm` falls in the quiet window [start, end) (which may wrap midnight). */
export function timeInQuietWindow(hhmm: string, start: string, end: string): boolean {
  const t = minutesOfDay(hhmm);
  const s = minutesOfDay(start);
  const e = minutesOfDay(end);
  if (t === null || s === null || e === null || s === e) return false;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

export interface BirthdayConfigInput extends BirthdayScheduleSpec {
  perNickDailyQuota: number;
  minDelaySec: number;
  maxDelaySec: number;
}

/** Vietnamese validation errors for a (normalised) config; empty = valid. */
export function validateBirthdayConfig(c: BirthdayConfigInput): string[] {
  const errors: string[] = [];
  if (!isValidTimezone(c.timezone)) errors.push('Múi giờ không hợp lệ');
  if (minutesOfDay(c.sendTime) === null) errors.push('Giờ gửi phải có dạng HH:mm (00:00–23:59)');
  if (!Number.isInteger(c.lateToleranceMinutes) || c.lateToleranceMinutes < 0 || c.lateToleranceMinutes > MAX_LATE_TOLERANCE_MINUTES) {
    errors.push(`Thời gian trễ tối đa phải từ 0 đến ${MAX_LATE_TOLERANCE_MINUTES} phút`);
  }
  const badOffset = (n: number) => !Number.isInteger(n) || n < MIN_OFFSET_DAYS || n > MAX_OFFSET_DAYS;
  if (c.beforeEnabled && badOffset(c.beforeDays)) errors.push(`Số ngày chúc trước phải từ ${MIN_OFFSET_DAYS} đến ${MAX_OFFSET_DAYS}`);
  if (c.afterEnabled && badOffset(c.afterDays)) errors.push(`Số ngày chúc sau phải từ ${MIN_OFFSET_DAYS} đến ${MAX_OFFSET_DAYS}`);
  if (!Number.isInteger(c.perNickDailyQuota) || c.perNickDailyQuota < 1 || c.perNickDailyQuota > 500) {
    errors.push('Hạn mức mỗi nick/ngày phải từ 1 đến 500');
  }
  if (!Number.isInteger(c.minDelaySec) || c.minDelaySec < MIN_DELAY_FLOOR_SEC || c.minDelaySec > MAX_DELAY_CAP_SEC) {
    errors.push(`Khoảng nghỉ tối thiểu phải từ ${MIN_DELAY_FLOOR_SEC} đến ${MAX_DELAY_CAP_SEC} giây`);
  }
  if (!Number.isInteger(c.maxDelaySec) || c.maxDelaySec < c.minDelaySec || c.maxDelaySec > MAX_DELAY_CAP_SEC) {
    errors.push('Khoảng nghỉ tối đa phải lớn hơn hoặc bằng tối thiểu và không quá 600 giây');
  }
  return errors;
}

export { DEFAULT_TIMEZONE };
