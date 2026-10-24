/**
 * Tổng quan (home): date, time and greeting in the business timezone. The business numbers come from the
 * module sections in the 'overview' slot; see web/src/lib/overview-range.ts and overview-format.ts.
 */

export const HOME_TZ = 'Asia/Ho_Chi_Minh';
export const HOME_POLL_MS = 30_000;

export function localParts(ms: number, tz = HOME_TZ): { y: number; m: number; d: number; h: number; min: number; weekday: number; key: string } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const parts = Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);
  return { y, m, d, h: Number(parts.hour), min: Number(parts.minute), weekday, key: `${parts.year}-${parts.month}-${parts.day}` };
}

const WEEKDAY_VI = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];

/** "Thứ ba, 20 tháng 10, 2026". */
export function fmtLongDate(ms: number, tz = HOME_TZ): string {
  const p = localParts(ms, tz);
  return `${WEEKDAY_VI[p.weekday]}, ${p.d} tháng ${p.m}, ${p.y}`;
}

export function fmtTime(ms: number, tz = HOME_TZ): string {
  const p = localParts(ms, tz);
  return `${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
}

/** Greeting by local hour. */
export function greeting(hour: number): string {
  if (hour >= 5 && hour < 11) return 'Chào buổi sáng';
  if (hour >= 11 && hour < 13) return 'Chào buổi trưa';
  if (hour >= 13 && hour < 18) return 'Chào buổi chiều';
  if (hour >= 18 && hour < 23) return 'Chào buổi tối';
  return 'Khuya rồi';
}
