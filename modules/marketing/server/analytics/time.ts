/**
 * Timezone helpers for analytics: every "day" in the dashboards is a calendar
 * day in the Page's own timezone. Pure, no I/O.
 */

export const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Returns `tz` when Intl accepts it, else the default timezone. */
export function safeTimezone(tz: string | null | undefined): string {
  const candidate = (tz ?? '').trim() || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
}

export function localParts(tsSec: number, tzInput: string): LocalParts {
  const tz = safeTimezone(tzInput);
  const parts: Record<string, string> = {};
  for (const p of formatterFor(tz).formatToParts(new Date(tsSec * 1000))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
  };
}

function pad(n: number): string { return String(n).padStart(2, '0'); }

/** 'YYYY-MM-DD' of the instant in the Page timezone. */
export function localDay(tsSec: number, tz: string): string {
  const p = localParts(tsSec, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Calendar arithmetic on a 'YYYY-MM-DD' string (no timezone involved). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** The `n` calendar days ending on the local day of `nowSec`, oldest first. */
export function lastNDays(nowSec: number, tz: string, n: number): string[] {
  const today = localDay(nowSec, tz);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(today, -i));
  return out;
}

function offsetSec(tsSec: number, tz: string): number {
  const p = localParts(tsSec, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) / 1000 - Math.floor(tsSec / 60) * 60;
}

/** Unix seconds of 00:00 local on `day` in the Page timezone. */
export function localDayStartSec(day: string, tzInput: string): number {
  const tz = safeTimezone(tzInput);
  const [y, m, d] = day.split('-').map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d) / 1000;
  let guess = utcMidnight - offsetSec(utcMidnight, tz);
  guess = utcMidnight - offsetSec(guess, tz);
  return guess;
}

/** Heat-map slots: 0 = 06–09, 1 = 09–12, 2 = 12–14, 3 = 14–18, 4 = 18–21, 5 = 21–24; null before 06:00. */
export function slotOfHour(hour: number): number | null {
  if (hour < 6) return null;
  if (hour < 9) return 0;
  if (hour < 12) return 1;
  if (hour < 14) return 2;
  if (hour < 18) return 3;
  if (hour < 21) return 4;
  return 5;
}

/**
 * Meta's daily insight value carries `end_time`, the end of the day it
 * covers (midnight Pacific, so 07:00 or 08:00 UTC). The day it describes is
 * the Pacific calendar day that ended at that instant.
 */
export function dayFromEndTime(endTimeSec: number): string {
  const t = new Date((endTimeSec - 8 * 3600 - 1) * 1000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
