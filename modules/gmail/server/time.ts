import type { EmailProtectionSettings } from './store.js';
function localMinutes(date: Date, zone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value);
}
export function isEmailQuietHours(now: Date, settings: EmailProtectionSettings): boolean {
  const q = settings.quietHours;
  const minute = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const n = localMinutes(now, settings.timezone), start = minute(q.start), end = minute(q.end);
  return q.enabled && (start === end || (start < end ? n >= start && n < end : n >= start || n < end));
}
export function startOfEmailDaySec(now: Date, settings: EmailProtectionSettings): number {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  let lo = now.getTime() - 27 * 3_600_000, hi = now.getTime();
  while (hi - lo > 1000) { const mid = Math.floor((lo + hi) / 2); if (day(new Date(mid)) === day(now)) hi = mid; else lo = mid; }
  return Math.ceil(hi / 1000);
}
export function quietHoursEndSec(now: Date, settings: EmailProtectionSettings): number {
  let t = Math.floor(now.getTime() / 1000);
  for (let i = 0; i <= 1440 && isEmailQuietHours(new Date(t * 1000), settings); i++) t += 60;
  return t;
}
