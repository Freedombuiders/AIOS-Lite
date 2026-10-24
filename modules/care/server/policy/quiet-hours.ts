/** Quiet hours from the module settings ("HH:MM" local time). Pure, so it is easy to test. */

export interface QuietWindow {
  start: string;
  end: string;
}

function minutesOf(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : null;
}

/** `active` when `nowMs` (local clock) is inside [start, end); the window may wrap midnight. start === end => never quiet. */
export function quietHoursAt(window: QuietWindow, nowMs: number): { active: boolean; endsAtMs: number | null } {
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  if (start === null || end === null || start === end) return { active: false, endsAtMs: null };
  const now = new Date(nowMs);
  const cur = now.getHours() * 60 + now.getMinutes();
  const active = start < end ? cur >= start && cur < end : cur >= start || cur < end;
  if (!active) return { active: false, endsAtMs: null };
  const endsAt = new Date(nowMs);
  endsAt.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (endsAt.getTime() <= nowMs) endsAt.setDate(endsAt.getDate() + 1);
  return { active: true, endsAtMs: endsAt.getTime() };
}
