/**
 * Tổng quan (home): date, time and greeting in the business timezone. The business numbers come from the
 * module sections in the 'overview' slot; see web/src/lib/overview-range.ts and overview-format.ts.
 */

import type { Run } from '@core/types';

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

// ---------------------------------------------------------------- "AI đã tự làm" and "Đội AI"

export interface DoneRow {
  runId: number;
  taskId: number;
  agentId: string;
  /** HH:MM, business timezone */
  time: string;
  text: string;
}

function firstLine(text: string | null, max = 90): string {
  const line = (text ?? '').split('\n').map((l) => l.replace(/[*#>`]+/g, '').replace(/^-\s+/, '').trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Runs that finished successfully today (business timezone), newest first. Chat turns are left out: the owner
 * asked for those, they are not something the AI did on its own. `titles` maps task id to the task's title.
 */
export function doneToday(runs: readonly Run[], titles: ReadonlyMap<number, string>, now: number, tz = HOME_TZ): DoneRow[] {
  const today = localParts(now, tz).key;
  return runs
    .filter((r) => r.status === 'done' && r.trigger !== 'chat')
    .map((r) => ({ r, at: Date.parse(r.finishedAt ?? r.startedAt) }))
    .filter(({ at }) => Number.isFinite(at) && localParts(at, tz).key === today)
    .sort((a, b) => b.at - a.at)
    .map(({ r, at }) => ({
      runId: r.id,
      taskId: r.taskId,
      agentId: r.agentId,
      time: fmtTime(at, tz),
      text: titles.get(r.taskId) || firstLine(r.output) || `Việc #${r.taskId}`,
    }));
}

export type BotState = 'busy' | 'queued' | 'idle';

/** What one agent is doing, from the counts the agents list already carries. */
export function botState(stats: { running: number; queued: number } | undefined): BotState {
  if (stats && stats.running > 0) return 'busy';
  if (stats && stats.queued > 0) return 'queued';
  return 'idle';
}

export const BOT_STATE_LABEL: Record<BotState, string> = { busy: 'Đang chạy', queued: 'Có việc chờ', idle: 'Rảnh' };

/** Two letters for the bot's avatar tile: initials of its first two words. */
export function botInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const pick = words.length === 1 ? words[0]!.slice(0, 2) : `${words[0]![0]}${words[1]![0]}`;
  return pick.toLocaleUpperCase('vi');
}
