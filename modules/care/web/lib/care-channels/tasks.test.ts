import { describe, expect, it } from 'vitest';
import { attentionCount, dayDistance, groupOf, groupTasks, isLate, vnDate, vnDayKey, vnDayStart, vnTime, type TaskLike } from './tasks';

// 2026-10-13 11:30 in Ho Chi Minh = 04:30 UTC
const NOW = Date.UTC(2026, 9, 13, 4, 30);
const vn = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 7, min);
const task = (id: string, dueAtMs: number, done = false, updatedAtMs = 0): TaskLike => ({ id, title: id, dueAtMs, done, updatedAtMs });

describe('Asia/Ho_Chi_Minh days', () => {
  it('cuts the day at 00:00 Vietnam time, not UTC', () => {
    expect(vnDayStart(NOW)).toBe(vn(2026, 10, 13));
    expect(vnDayKey(NOW)).toBe('2026-10-13');
    // 23:30 UTC on the 12th is already 06:30 on the 13th in Vietnam
    expect(vnDayKey(Date.UTC(2026, 9, 12, 23, 30))).toBe('2026-10-13');
    // 16:59 UTC is 23:59 the same Vietnam day, 17:00 UTC opens the next one
    expect(vnDayKey(Date.UTC(2026, 9, 13, 16, 59))).toBe('2026-10-13');
    expect(vnDayKey(Date.UTC(2026, 9, 13, 17, 0))).toBe('2026-10-14');
  });

  it('formats time and date in Vietnam time', () => {
    expect(vnTime(NOW)).toBe('11:30');
    expect(vnDate(vn(2026, 1, 5, 9))).toBe('05/01');
    expect(vnTime(vn(2026, 10, 13, 0, 5))).toBe('00:05');
  });

  it('counts whole days around today', () => {
    expect(dayDistance(vn(2026, 10, 13, 23, 59), NOW)).toBe(0);
    expect(dayDistance(vn(2026, 10, 14, 0, 0), NOW)).toBe(1);
    expect(dayDistance(vn(2026, 10, 12, 23, 59), NOW)).toBe(-1);
  });
});

describe('groupTasks', () => {
  const tasks = [
    task('yesterday', vn(2026, 10, 12, 18)),
    task('lastweek', vn(2026, 10, 6, 9)),
    task('today-past', vn(2026, 10, 13, 9)),
    task('today-late', vn(2026, 10, 13, 20)),
    task('midnight-tonight', vn(2026, 10, 13, 23, 59)),
    task('tomorrow', vn(2026, 10, 14, 0, 0)),
    task('wed', vn(2026, 10, 14, 9)),
    task('done-old', vn(2026, 10, 1), true, 100),
    task('done-new', vn(2026, 10, 20), true, 200),
  ];
  const g = groupTasks(tasks, NOW);

  it('splits into Quá hạn / Hôm nay / Sắp tới / Xong by Vietnam day', () => {
    expect(g.overdue.map((t) => t.id)).toEqual(['lastweek', 'yesterday']);
    expect(g.today.map((t) => t.id)).toEqual(['today-past', 'today-late', 'midnight-tonight']);
    expect(g.upcoming.map((t) => t.id)).toEqual(['tomorrow', 'wed']);
    expect(g.done.map((t) => t.id)).toEqual(['done-new', 'done-old']);
  });

  it('a done task is Xong whatever its date', () => {
    expect(groupOf(task('x', vn(2026, 10, 1), true), NOW)).toBe('done');
    expect(groupOf(task('x', vn(2026, 12, 1), true), NOW)).toBe('done');
  });

  it('flags a task due earlier today as late but keeps it under Hôm nay', () => {
    expect(isLate(task('x', vn(2026, 10, 13, 9)), NOW)).toBe(true);
    expect(isLate(task('x', vn(2026, 10, 13, 20)), NOW)).toBe(false);
    expect(isLate(task('x', vn(2026, 10, 13, 9), true), NOW)).toBe(false);
    expect(groupOf(task('x', vn(2026, 10, 13, 9)), NOW)).toBe('today');
  });

  it('counts what needs a look now: overdue plus today', () => {
    expect(attentionCount(g)).toBe(5);
  });

  it('does not move a task across the day line when the browser time zone differs: the cut is 17:00 UTC', () => {
    const justBefore = Date.UTC(2026, 9, 13, 16, 59, 59);
    const justAfter = Date.UTC(2026, 9, 13, 17, 0, 0);
    expect(groupOf(task('x', justBefore), NOW)).toBe('today');
    expect(groupOf(task('x', justAfter), NOW)).toBe('upcoming');
  });
});
