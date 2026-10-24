import { describe, expect, it } from 'vitest';

import {
  minGapMinutes,
  nextRunAt,
  normalizeSchedule,
  occurrencesBetween,
  todayInZone,
  validateSchedule,
  zonedDateParts,
  zonedWallClockToUtc,
  type ScheduleSpec,
} from './schedule.js';

const HCM = 'Asia/Ho_Chi_Minh';

function spec(over: Partial<ScheduleSpec> = {}): ScheduleSpec {
  return {
    scheduleKind: 'daily',
    timesOfDay: ['08:00'],
    daysOfWeek: [],
    daysOfMonth: [],
    timezone: HCM,
    startDate: null,
    endDate: null,
    ...over,
  };
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe('timezone helpers', () => {
  it('converts wall clock to UTC with a fixed offset', () => {
    expect(iso(zonedWallClockToUtc(2026, 8, 3, 8, 0, HCM))).toBe('2026-08-03T01:00:00.000Z');
  });

  it('follows DST for zones that have it', () => {
    // New York: UTC-4 in summer, UTC-5 in winter.
    expect(iso(zonedWallClockToUtc(2026, 7, 1, 9, 0, 'America/New_York'))).toBe('2026-07-01T13:00:00.000Z');
    expect(iso(zonedWallClockToUtc(2026, 12, 1, 9, 0, 'America/New_York'))).toBe('2026-12-01T14:00:00.000Z');
  });

  it('reads the calendar date in the target zone, not UTC', () => {
    // 18:00Z is already the next day in Vietnam.
    const parts = zonedDateParts(new Date('2026-08-03T18:00:00Z'), HCM);
    expect(parts).toMatchObject({ year: 2026, month: 8, day: 4, weekday: 2 });
    expect(todayInZone(HCM, new Date('2026-08-03T18:00:00Z'))).toBe('2026-08-04');
  });
});

describe('nextRunAt', () => {
  it('daily: picks the next time today, then tomorrow', () => {
    const s = spec({ timesOfDay: ['08:00', '20:00'] });
    expect(iso(nextRunAt(s, new Date('2026-08-03T00:00:00Z')))).toBe('2026-08-03T01:00:00.000Z'); // 07:00 local -> 08:00
    expect(iso(nextRunAt(s, new Date('2026-08-03T02:00:00Z')))).toBe('2026-08-03T13:00:00.000Z'); // 09:00 -> 20:00
    expect(iso(nextRunAt(s, new Date('2026-08-03T14:00:00Z')))).toBe('2026-08-04T01:00:00.000Z'); // 21:00 -> tomorrow 08:00
  });

  it('is strictly after `from`', () => {
    expect(iso(nextRunAt(spec(), new Date('2026-08-03T01:00:00Z')))).toBe('2026-08-04T01:00:00.000Z');
  });

  it('handles a local time that falls on the previous UTC day', () => {
    const s = spec({ timesOfDay: ['01:00'] }); // 01:00 local = 18:00Z the day before
    expect(iso(nextRunAt(s, new Date('2026-08-03T17:00:00Z')))).toBe('2026-08-03T18:00:00.000Z');
  });

  it('weekly: only the chosen weekdays (2026-08-03 is a Monday)', () => {
    const s = spec({ scheduleKind: 'weekly', daysOfWeek: [1, 5] });
    expect(iso(nextRunAt(s, new Date('2026-08-03T02:00:00Z')))).toBe('2026-08-07T01:00:00.000Z'); // Fri
    expect(iso(nextRunAt(s, new Date('2026-08-07T02:00:00Z')))).toBe('2026-08-10T01:00:00.000Z'); // next Mon
  });

  it('monthly: the 31st skips short months instead of rolling over', () => {
    const s = spec({ scheduleKind: 'monthly', daysOfMonth: [31] });
    expect(iso(nextRunAt(s, new Date('2026-04-01T00:00:00Z')))).toBe('2026-05-31T01:00:00.000Z');
    const feb = spec({ scheduleKind: 'monthly', daysOfMonth: [30] });
    expect(iso(nextRunAt(feb, new Date('2026-02-01T00:00:00Z')))).toBe('2026-03-30T01:00:00.000Z');
  });

  it('respects start and end dates inclusively in the campaign zone', () => {
    const s = spec({ startDate: '2026-08-10', endDate: '2026-08-12' });
    expect(iso(nextRunAt(s, new Date('2026-08-01T00:00:00Z')))).toBe('2026-08-10T01:00:00.000Z');
    expect(iso(nextRunAt(s, new Date('2026-08-12T00:00:00Z')))).toBe('2026-08-12T01:00:00.000Z');
    expect(nextRunAt(s, new Date('2026-08-12T02:00:00Z'))).toBeNull();
  });

  it('returns null for a "now" campaign or without times', () => {
    expect(nextRunAt(spec({ scheduleKind: 'now' }), new Date())).toBeNull();
    expect(nextRunAt(spec({ timesOfDay: [] }), new Date())).toBeNull();
  });
});

describe('occurrencesBetween', () => {
  const s = spec({ timesOfDay: ['08:00', '08:05', '20:00'] });

  it('is exclusive on the left and inclusive on the right', () => {
    const got = occurrencesBetween(s, new Date('2026-08-03T01:00:00Z'), new Date('2026-08-03T01:05:00Z'));
    expect(got.map(iso)).toEqual(['2026-08-03T01:05:00.000Z']);
  });

  it('returns several due times in order across days', () => {
    const got = occurrencesBetween(s, new Date('2026-08-03T12:00:00Z'), new Date('2026-08-04T01:10:00Z'));
    expect(got.map(iso)).toEqual([
      '2026-08-03T13:00:00.000Z', '2026-08-04T01:00:00.000Z', '2026-08-04T01:05:00.000Z',
    ]);
  });

  it('returns nothing for an empty or inverted window', () => {
    const t = new Date('2026-08-03T01:00:00Z');
    expect(occurrencesBetween(s, t, t)).toEqual([]);
    expect(occurrencesBetween(s, new Date('2026-08-04T00:00:00Z'), t)).toEqual([]);
  });
});

describe('minGapMinutes', () => {
  it('finds the smallest neighbouring gap', () => {
    expect(minGapMinutes(['08:00', '08:30', '20:00'])).toBe(30);
  });

  it('wraps around midnight', () => {
    expect(minGapMinutes(['23:00', '01:00'])).toBe(120);
    expect(minGapMinutes(['00:10', '23:50'])).toBe(20);
  });

  it('is Infinity with fewer than two times and ignores duplicates', () => {
    expect(minGapMinutes([])).toBe(Infinity);
    expect(minGapMinutes(['08:00'])).toBe(Infinity);
    expect(minGapMinutes(['08:00', '08:00'])).toBe(Infinity);
  });
});

describe('validateSchedule / normalizeSchedule', () => {
  it('accepts a valid daily spec', () => {
    expect(validateSchedule(spec())).toEqual({ ok: true, errors: [] });
  });

  it('flags missing, malformed and too many times', () => {
    expect(validateSchedule(spec({ timesOfDay: [] })).errors).toContain('TIMES_REQUIRED');
    expect(validateSchedule(spec({ timesOfDay: ['8:00'] })).errors).toContain('INVALID_TIME');
    expect(validateSchedule(spec({ timesOfDay: ['25:00'] })).errors).toContain('INVALID_TIME');
    const many = Array.from({ length: 13 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
    expect(validateSchedule(spec({ timesOfDay: many })).errors).toContain('TOO_MANY_TIMES');
  });

  it('flags bad weekdays, month days, timezone and dates', () => {
    expect(validateSchedule(spec({ scheduleKind: 'weekly', daysOfWeek: [] })).errors).toContain('INVALID_DAYS_OF_WEEK');
    expect(validateSchedule(spec({ scheduleKind: 'weekly', daysOfWeek: [7] })).errors).toContain('INVALID_DAYS_OF_WEEK');
    expect(validateSchedule(spec({ scheduleKind: 'monthly', daysOfMonth: [0] })).errors).toContain('INVALID_DAYS_OF_MONTH');
    expect(validateSchedule(spec({ timezone: 'Mars/Olympus' })).errors).toContain('INVALID_TIMEZONE');
    expect(validateSchedule(spec({ startDate: '2026-02-30' })).errors).toContain('INVALID_DATE');
    expect(validateSchedule(spec({ startDate: '2026-08-10', endDate: '2026-08-01' })).errors).toContain('INVALID_DATE_RANGE');
  });

  it('does not require times for "now"', () => {
    expect(validateSchedule(spec({ scheduleKind: 'now', timesOfDay: [] })).ok).toBe(true);
  });

  it('normalizes to unique ascending values', () => {
    const n = normalizeSchedule({ timesOfDay: ['20:00', '08:00', '08:00'], daysOfWeek: [5, 1, 1], daysOfMonth: [15, 1] });
    expect(n).toEqual({ timesOfDay: ['08:00', '20:00'], daysOfWeek: [1, 5], daysOfMonth: [1, 15] });
  });
});
