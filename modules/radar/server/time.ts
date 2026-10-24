/** Local-time helpers for Radar scheduling (thin layer over the Facebook analytics timezone helpers). */

import { addDays, localDay, localDayStartSec, localParts, safeTimezone } from './tz.js';

export { addDays, localDay, localDayStartSec, localParts, safeTimezone };

/** "UTC+7" for the timezone at the given instant. */
export function utcLabel(now: Date, tz: string): string {
  const sec = Math.floor(now.getTime() / 1000);
  const p = localParts(sec, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) / 1000;
  const offsetMin = Math.round((asUtc - Math.floor(sec / 60) * 60) / 60);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/** Seconds from local midnight of "HH:MM". */
export function slotSeconds(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60;
}
