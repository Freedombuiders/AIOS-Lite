import { describe, expect, it } from 'vitest';

import {
  addDays, dayFromEndTime, lastNDays, localDay, localDayStartSec, localParts, safeTimezone, slotOfHour,
} from './time.js';

const VN = 'Asia/Ho_Chi_Minh';
const utc = (s: string) => Date.parse(`${s}Z`) / 1000;

describe('timezone helpers', () => {
  it('falls back to the default timezone for junk input', () => {
    expect(safeTimezone('Not/AZone')).toBe(VN);
    expect(safeTimezone('')).toBe(VN);
    expect(safeTimezone(null)).toBe(VN);
    expect(safeTimezone('America/Los_Angeles')).toBe('America/Los_Angeles');
  });

  it('reads local parts with Monday as weekday 0', () => {
    // 2026-10-07 is a Wednesday. 05:00Z is 12:00 in Vietnam.
    const p = localParts(utc('2026-10-07T05:00:00'), VN);
    expect(p).toMatchObject({ year: 2026, month: 10, day: 7, hour: 12, minute: 0, weekday: 2 });
    expect(localParts(utc('2026-10-04T05:00:00'), VN).weekday).toBe(6); // Sunday
    expect(localParts(utc('2026-10-05T05:00:00'), VN).weekday).toBe(0); // Monday
  });

  it('gives a different local day and slot for a different timezone', () => {
    const t = utc('2026-10-07T03:00:00');
    expect(localDay(t, VN)).toBe('2026-10-07');
    expect(localParts(t, VN).hour).toBe(10);
    expect(localDay(t, 'America/Los_Angeles')).toBe('2026-10-06');
    expect(localParts(t, 'America/Los_Angeles').hour).toBe(20);
  });

  it('does midnight rollover in the Page timezone, not UTC', () => {
    expect(localDay(utc('2026-10-06T17:30:00'), VN)).toBe('2026-10-07'); // 00:30 next day in VN
    expect(localDay(utc('2026-10-06T16:59:00'), VN)).toBe('2026-10-06');
  });

  it('adds calendar days across month ends', () => {
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('lists the last n days oldest first, ending today', () => {
    expect(lastNDays(utc('2026-10-07T05:00:00'), VN, 3)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
  });

  it('finds the start of a local day', () => {
    expect(localDayStartSec('2026-10-07', VN)).toBe(utc('2026-10-06T17:00:00'));
    expect(localDayStartSec('2026-10-07', 'America/Los_Angeles')).toBe(utc('2026-10-07T07:00:00'));
    // Across a DST change (US fall back 2026-11-01): midnight is still PDT, the next midnight is PST.
    expect(localDayStartSec('2026-11-01', 'America/Los_Angeles')).toBe(utc('2026-11-01T07:00:00'));
    expect(localDayStartSec('2026-11-02', 'America/Los_Angeles')).toBe(utc('2026-11-02T08:00:00'));
  });

  it('maps hours to the six heat slots and drops the small hours', () => {
    const slots = [5, 6, 8, 9, 11, 12, 13, 14, 17, 18, 20, 21, 23].map(slotOfHour);
    expect(slots).toEqual([null, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    expect(slotOfHour(0)).toBeNull();
  });

  it('labels a Meta daily value by the Pacific day that ended at end_time', () => {
    expect(dayFromEndTime(utc('2026-10-08T07:00:00'))).toBe('2026-10-07'); // PDT midnight
    expect(dayFromEndTime(utc('2026-12-08T08:00:00'))).toBe('2026-12-07'); // PST midnight
    expect(dayFromEndTime(utc('2026-10-08T00:00:00'))).toBe('2026-10-07');
  });
});
