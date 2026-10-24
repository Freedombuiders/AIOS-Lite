/**
 * Time helpers for Content Studio. All timestamps are unix SECONDS; "local"
 * means the wall clock of a Page's IANA timezone.
 */

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: string): boolean {
  if (!tz || typeof tz !== 'string') return false;
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

export function localParts(tsSec: number, tz: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(tz).formatToParts(new Date(tsSec * 1000))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday] ?? 0,
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' of the instant in the zone. */
export function localDayKey(tsSec: number, tz: string): string {
  const p = localParts(tsSec, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** 'HH:MM' of the instant in the zone. */
export function localHm(tsSec: number, tz: string): string {
  const p = localParts(tsSec, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** 'YYYY-MM-DD HH:MM' of the instant in the zone (the format content-cli accepts). */
export function formatLocal(tsSec: number, tz: string): string {
  return `${localDayKey(tsSec, tz)} ${localHm(tsSec, tz)}`;
}

/** 'HH:MM dd/MM' for Vietnamese messages. */
export function formatLocalShort(tsSec: number, tz: string): string {
  const p = localParts(tsSec, tz);
  return `${pad(p.hour)}:${pad(p.minute)} ${pad(p.day)}/${pad(p.month)}`;
}

/** Offset of the zone from UTC at that instant, in seconds. */
function zoneOffsetSec(tsSec: number, tz: string): number {
  const p = localParts(tsSec, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
  return asUtc - tsSec;
}

/** Converts a wall-clock time in `tz` to unix seconds. */
export function zonedTimeToEpoch(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0) / 1000;
  let guess = naive - zoneOffsetSec(naive, tz);
  // A second pass fixes the guess when the offset differs across a DST boundary.
  guess = naive - zoneOffsetSec(guess, tz);
  return guess;
}

/**
 * Parses 'YYYY-MM-DD HH:MM' (or with a 'T') as a wall-clock time in `tz`.
 * Returns null when the text is not that shape or the date does not exist.
 */
export function parseLocalDateTime(text: string, tz: string): number | null {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return zonedTimeToEpoch(year, month, day, hour, minute, tz);
}

/** Minutes after midnight for 'HH:MM', or null. */
export function parseHm(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Unix seconds of Monday 00:00 (zone time) of the week containing the instant. */
export function startOfLocalWeek(tsSec: number, tz: string): number {
  const p = localParts(tsSec, tz);
  return zonedTimeToEpoch(p.year, p.month, p.day - p.weekday, 0, 0, tz);
}

/** [start, end) unix seconds of 'YYYY-MM' in the zone; null for a malformed month. */
export function monthRange(month: string, tz: string): { from: number; to: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return null;
  const from = zonedTimeToEpoch(year, mon, 1, 0, 0, tz);
  const to = mon === 12 ? zonedTimeToEpoch(year + 1, 1, 1, 0, 0, tz) : zonedTimeToEpoch(year, mon + 1, 1, 0, 0, tz);
  return { from, to };
}
