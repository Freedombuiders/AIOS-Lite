// Công việc (tasks): grouping for /care/tasks. Days are Asia/Ho_Chi_Minh days (UTC+7, no DST), whatever the browser's
// time zone is: a task "due today" means today in Vietnam, because that is when the owner works.

export const VN_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;

export interface TaskLike {
  id: string;
  title: string;
  dueAtMs: number;
  done: boolean;
  updatedAtMs: number;
}

export type TaskGroupId = 'overdue' | 'today' | 'upcoming' | 'done';
export const TASK_GROUP_ORDER: readonly TaskGroupId[] = ['overdue', 'today', 'upcoming', 'done'];

/** Start (UTC ms) of the Vietnam day that contains `ms`. */
export function vnDayStart(ms: number): number {
  return Math.floor((ms + VN_OFFSET_MS) / DAY_MS) * DAY_MS - VN_OFFSET_MS;
}

/** `YYYY-MM-DD` of that Vietnam day. */
export function vnDayKey(ms: number): string {
  return new Date(ms + VN_OFFSET_MS).toISOString().slice(0, 10);
}

/** `HH:mm` in Vietnam time. */
export function vnTime(ms: number): string {
  return new Date(ms + VN_OFFSET_MS).toISOString().slice(11, 16);
}

/** `dd/MM` in Vietnam time. */
export function vnDate(ms: number): string {
  const d = new Date(ms + VN_OFFSET_MS).toISOString();
  return `${d.slice(8, 10)}/${d.slice(5, 7)}`;
}

/** Whole Vietnam days from `nowMs` to `ms` (0 = today, 1 = tomorrow, -1 = yesterday). */
export function dayDistance(ms: number, nowMs: number): number {
  return Math.round((vnDayStart(ms) - vnDayStart(nowMs)) / DAY_MS);
}

/**
 * Done tasks go to `done`. An open task is `overdue` when its day is before today, `today` when it is due today (even if
 * the hour has passed: see `isLate`), `upcoming` after that.
 */
export function groupOf(task: Pick<TaskLike, 'dueAtMs' | 'done'>, nowMs: number): TaskGroupId {
  if (task.done) return 'done';
  const d = dayDistance(task.dueAtMs, nowMs);
  return d < 0 ? 'overdue' : d === 0 ? 'today' : 'upcoming';
}

/** Due today but the hour is already gone (shown amber, still under "Hôm nay"). */
export function isLate(task: Pick<TaskLike, 'dueAtMs' | 'done'>, nowMs: number): boolean {
  return !task.done && task.dueAtMs < nowMs;
}

export type TaskGroups<T extends TaskLike> = Record<TaskGroupId, T[]>;

/** Overdue / today / upcoming ascending by due time; done newest first. */
export function groupTasks<T extends TaskLike>(tasks: readonly T[], nowMs: number): TaskGroups<T> {
  const out: TaskGroups<T> = { overdue: [], today: [], upcoming: [], done: [] };
  for (const t of tasks) out[groupOf(t, nowMs)].push(t);
  for (const id of ['overdue', 'today', 'upcoming'] as const) out[id].sort((a, b) => a.dueAtMs - b.dueAtMs || a.id.localeCompare(b.id));
  out.done.sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.id.localeCompare(b.id));
  return out;
}

/** Open tasks that need a look now: overdue plus due today. */
export function attentionCount(groups: Pick<TaskGroups<TaskLike>, 'overdue' | 'today'>): number {
  return groups.overdue.length + groups.today.length;
}
