// "Hoãn" menu options, computed on Vietnam wall-clock time (Asia/Ho_Chi_Minh, UTC+7, no DST) whatever the
// browser's own timezone is.

const VN_OFFSET_MS = 7 * 3_600_000;
const HOUR_MS = 3_600_000;

export type SnoozeId = 'oneHour' | 'today17' | 'tomorrow9' | 'monday9';

export interface SnoozeOption {
  id: SnoozeId;
  untilMs: number;
}

interface VnParts { y: number; m: number; d: number; h: number; min: number; weekday: number }

function vnParts(ms: number): VnParts {
  const d = new Date(ms + VN_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), min: d.getUTCMinutes(), weekday: d.getUTCDay() };
}

/** The instant at hh:mm Vietnam time on y-m-(d + dayOffset). */
function vnInstant(p: Pick<VnParts, 'y' | 'm' | 'd'>, dayOffset: number, hour: number, minute = 0): number {
  return Date.UTC(p.y, p.m, p.d + dayOffset, hour, minute) - VN_OFFSET_MS;
}

/**
 * 1 hour from now, 17:00 today (only while it is still ahead), 9:00 tomorrow and 9:00 next Monday
 * (dropped when tomorrow already is that Monday). Options are in ascending order.
 */
export function snoozeOptions(nowMs: number): SnoozeOption[] {
  const p = vnParts(nowMs);
  const out: SnoozeOption[] = [{ id: 'oneHour', untilMs: nowMs + HOUR_MS }];
  const today17 = vnInstant(p, 0, 17);
  // Less than an hour away it would be sooner than the first option: not worth listing.
  if (today17 > nowMs + HOUR_MS) out.push({ id: 'today17', untilMs: today17 });
  const tomorrow9 = vnInstant(p, 1, 9);
  out.push({ id: 'tomorrow9', untilMs: tomorrow9 });
  // Next Monday strictly after today (a Monday morning offers the following Monday).
  const daysToMonday = ((1 - p.weekday + 7) % 7) || 7;
  const monday9 = vnInstant(p, daysToMonday, 9);
  if (monday9 !== tomorrow9) out.push({ id: 'monday9', untilMs: monday9 });
  return out;
}
