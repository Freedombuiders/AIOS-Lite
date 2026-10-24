// Text helpers shared by the list rows, the conversation header and the list banner.

import { ct } from '@modules/care/web/lib/care/i18n';
import { snoozeUntilLabel, waitLabel } from '@modules/care/web/lib/care/inboxView';

/** "2 phút" / "3 giờ" / "2 ngày". */
export function waitText(mins: number): string {
  const l = waitLabel(mins);
  return ct(`inbox2.wait.${l.unit}`, { n: l.n });
}

/** "Hoãn tới" target in words: "17:00", "09:00 ngày mai", "09:00 T2". */
export function snoozeUntilText(untilMs: number, nowMs: number): string {
  const l = snoozeUntilLabel(untilMs, nowMs);
  if (l.day === 'today') return ct('inbox2.snooze.untilToday', { time: l.time });
  if (l.day === 'tomorrow') return ct('inbox2.snooze.untilTomorrow', { time: l.time });
  return ct('inbox2.snooze.untilDay', { time: l.time, day: ct(`inbox2.weekday.${l.weekday}`) });
}
