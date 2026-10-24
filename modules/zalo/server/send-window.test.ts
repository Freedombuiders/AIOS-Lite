import { describe, expect, it } from 'vitest';

import {
  dayBounds,
  isWithinWindow,
  minutesOfDay,
  nextWindowOpen,
  sendingDaysPerWeek,
  validateWindow,
  windowLengthMinutes,
  zonedParts,
  zonedWallClockToUtc,
  type WindowSpec,
} from './send-window.js';

const VN = 'Asia/Ho_Chi_Minh'; // UTC+7, no DST

function spec(over: Partial<WindowSpec> = {}): WindowSpec {
  return {
    windowStart: '08:00', windowEnd: '17:00', daysOfWeek: [], timezone: VN, startDate: null, endDate: null, ...over,
  };
}

/** A UTC instant from a Vietnam wall-clock time. */
function vn(y: number, mo: number, d: number, h: number, mi = 0): Date {
  return zonedWallClockToUtc(y, mo, d, h, mi, VN);
}

describe('zoned helpers', () => {
  it('reads wall clock parts in a timezone', () => {
    // 2026-10-07 is a Wednesday
    expect(zonedParts(new Date('2026-10-07T17:30:00Z'), VN)).toMatchObject({ year: 2026, month: 10, day: 8, weekday: 4, hour: 0, minute: 30 });
  });

  it('round-trips wall clock to UTC', () => {
    expect(vn(2026, 10, 7, 8, 0).toISOString()).toBe('2026-10-07T01:00:00.000Z');
  });

  it('handles DST zones', () => {
    // New York leaves DST on 2026-11-01: 09:00 local is UTC-5 afterwards, UTC-4 before.
    expect(zonedWallClockToUtc(2026, 10, 31, 9, 0, 'America/New_York').toISOString()).toBe('2026-10-31T13:00:00.000Z');
    expect(zonedWallClockToUtc(2026, 11, 2, 9, 0, 'America/New_York').toISOString()).toBe('2026-11-02T14:00:00.000Z');
  });

  it('parses HH:mm', () => {
    expect(minutesOfDay('08:30')).toBe(510);
    expect(minutesOfDay('24:00')).toBeNull();
    expect(minutesOfDay('8:30')).toBeNull();
  });
});

describe('isWithinWindow', () => {
  it('is open from start (inclusive) to end (exclusive)', () => {
    const s = spec();
    expect(isWithinWindow(vn(2026, 10, 7, 7, 59), s)).toBe(false);
    expect(isWithinWindow(vn(2026, 10, 7, 8, 0), s)).toBe(true);
    expect(isWithinWindow(vn(2026, 10, 7, 16, 59), s)).toBe(true);
    expect(isWithinWindow(vn(2026, 10, 7, 17, 0), s)).toBe(false);
  });

  it('crosses midnight when end <= start', () => {
    const s = spec({ windowStart: '22:00', windowEnd: '02:00' });
    expect(isWithinWindow(vn(2026, 10, 7, 21, 59), s)).toBe(false);
    expect(isWithinWindow(vn(2026, 10, 7, 22, 0), s)).toBe(true);
    expect(isWithinWindow(vn(2026, 10, 8, 1, 59), s)).toBe(true);
    expect(isWithinWindow(vn(2026, 10, 8, 2, 0), s)).toBe(false);
  });

  it('counts the after-midnight tail toward the weekday it started on', () => {
    // Wednesday-only overnight window: Thursday 01:00 is still Wednesday's session.
    const s = spec({ windowStart: '22:00', windowEnd: '02:00', daysOfWeek: [3] });
    expect(isWithinWindow(vn(2026, 10, 8, 1, 0), s)).toBe(true);
    expect(isWithinWindow(vn(2026, 10, 8, 23, 0), s)).toBe(false); // Thursday evening
    expect(isWithinWindow(vn(2026, 10, 7, 23, 0), s)).toBe(true); // Wednesday evening
  });

  it('respects days of week in the campaign timezone', () => {
    const s = spec({ daysOfWeek: [1, 2, 3, 4, 5] });
    expect(isWithinWindow(vn(2026, 10, 7, 10), s)).toBe(true); // Wed
    expect(isWithinWindow(vn(2026, 10, 10, 10), s)).toBe(false); // Sat
    // Sun 2026-10-11 00:30 VN is Saturday 17:30 UTC: weekday must follow the tz.
    expect(isWithinWindow(new Date('2026-10-10T17:30:00Z'), spec({ windowStart: '00:00', windowEnd: '06:00', daysOfWeek: [0] }))).toBe(true);
  });

  it('respects start/end dates inclusively', () => {
    const s = spec({ startDate: '2026-10-08', endDate: '2026-10-09' });
    expect(isWithinWindow(vn(2026, 10, 7, 10), s)).toBe(false);
    expect(isWithinWindow(vn(2026, 10, 8, 10), s)).toBe(true);
    expect(isWithinWindow(vn(2026, 10, 9, 16), s)).toBe(true);
    expect(isWithinWindow(vn(2026, 10, 10, 10), s)).toBe(false);
  });

  it('is closed for malformed or empty windows', () => {
    expect(isWithinWindow(vn(2026, 10, 7, 10), spec({ windowStart: 'x' }))).toBe(false);
    expect(isWithinWindow(vn(2026, 10, 7, 10), spec({ windowStart: '08:00', windowEnd: '08:00' }))).toBe(false);
  });
});

describe('dayBounds', () => {
  it('uses local midnight, not UTC midnight', () => {
    const { startMs, endMs } = dayBounds(VN, vn(2026, 10, 7, 23, 30));
    expect(new Date(startMs).toISOString()).toBe('2026-10-06T17:00:00.000Z');
    expect(endMs - startMs).toBe(86_400_000);
  });

  it('handles a 23 h DST day', () => {
    const { startMs, endMs } = dayBounds('America/New_York', new Date('2026-03-08T18:00:00Z'));
    expect(endMs - startMs).toBe(23 * 3_600_000);
  });
});

describe('window maths', () => {
  it('computes lengths, including overnight', () => {
    expect(windowLengthMinutes(spec())).toBe(540);
    expect(windowLengthMinutes(spec({ windowStart: '22:00', windowEnd: '02:00' }))).toBe(240);
    expect(windowLengthMinutes(spec({ windowStart: '08:00', windowEnd: '08:00' }))).toBe(0);
  });

  it('counts sending days per week', () => {
    expect(sendingDaysPerWeek({ daysOfWeek: [] })).toBe(7);
    expect(sendingDaysPerWeek({ daysOfWeek: [1, 2, 3, 3] })).toBe(3);
  });
});

describe('nextWindowOpen', () => {
  it('returns now when already open', () => {
    const now = vn(2026, 10, 7, 10);
    expect(nextWindowOpen(now, spec())).toEqual(now);
  });

  it('returns later today or tomorrow', () => {
    expect(nextWindowOpen(vn(2026, 10, 7, 6), spec())).toEqual(vn(2026, 10, 7, 8));
    expect(nextWindowOpen(vn(2026, 10, 7, 18), spec())).toEqual(vn(2026, 10, 8, 8));
  });

  it('skips closed weekdays', () => {
    // Friday evening, Mon-Fri only -> Monday 08:00
    expect(nextWindowOpen(vn(2026, 10, 9, 18), spec({ daysOfWeek: [1, 2, 3, 4, 5] }))).toEqual(vn(2026, 10, 12, 8));
  });

  it('waits for the start date and gives up after the end date', () => {
    expect(nextWindowOpen(vn(2026, 10, 7, 10), spec({ startDate: '2026-10-20' }))).toEqual(vn(2026, 10, 20, 8));
    expect(nextWindowOpen(vn(2026, 10, 7, 18), spec({ endDate: '2026-10-07' }))).toBeNull();
  });
});

describe('validateWindow', () => {
  it('accepts a normal spec', () => {
    expect(validateWindow(spec())).toEqual([]);
  });

  it('reports bad inputs in Vietnamese', () => {
    expect(validateWindow(spec({ timezone: 'Mars/Base' }))[0]).toMatch(/Múi giờ/);
    expect(validateWindow(spec({ windowStart: '8h' }))[0]).toMatch(/HH:mm/);
    expect(validateWindow(spec({ windowStart: '09:00', windowEnd: '09:00' }))[0]).toMatch(/trùng/);
    expect(validateWindow(spec({ daysOfWeek: [7] }))[0]).toMatch(/Ngày trong tuần/);
    expect(validateWindow(spec({ startDate: '2026-10-09', endDate: '2026-10-01' }))[0]).toMatch(/sau ngày bắt đầu/);
  });
});
