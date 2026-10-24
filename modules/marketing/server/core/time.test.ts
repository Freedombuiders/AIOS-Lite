import { describe, expect, it } from 'vitest';

import {
  formatLocal,
  isValidTimezone,
  localDayKey,
  localParts,
  monthRange,
  parseHm,
  parseLocalDateTime,
  startOfLocalWeek,
  zonedTimeToEpoch,
} from './time.js';

const VN = 'Asia/Ho_Chi_Minh';

describe('time helpers', () => {
  it('converts Vietnam wall-clock time to epoch (UTC+7, no DST)', () => {
    // 2026-10-20 19:30 +07:00 = 12:30 UTC
    expect(zonedTimeToEpoch(2026, 10, 20, 19, 30, VN)).toBe(Date.UTC(2026, 9, 20, 12, 30) / 1000);
  });

  it('round-trips through formatLocal', () => {
    const at = parseLocalDateTime('2026-10-20 19:30', VN) as number;
    expect(formatLocal(at, VN)).toBe('2026-10-20 19:30');
  });

  it('handles zones with DST', () => {
    const summer = zonedTimeToEpoch(2026, 7, 1, 12, 0, 'America/New_York');
    const winter = zonedTimeToEpoch(2026, 1, 1, 12, 0, 'America/New_York');
    expect(summer).toBe(Date.UTC(2026, 6, 1, 16, 0) / 1000);
    expect(winter).toBe(Date.UTC(2026, 0, 1, 17, 0) / 1000);
  });

  it('rejects malformed or impossible dates', () => {
    expect(parseLocalDateTime('20/10/2026 19:30', VN)).toBeNull();
    expect(parseLocalDateTime('2026-02-30 10:00', VN)).toBeNull();
    expect(parseLocalDateTime('2026-10-20 25:00', VN)).toBeNull();
    expect(parseLocalDateTime('2026-10-20T07:05', VN)).not.toBeNull();
  });

  it('knows the local day across the UTC boundary', () => {
    // 2026-10-20 18:30 UTC is already 21 Oct 01:30 in Vietnam
    const ts = Date.UTC(2026, 9, 20, 18, 30) / 1000;
    expect(localDayKey(ts, VN)).toBe('2026-10-21');
    expect(localDayKey(ts, 'UTC')).toBe('2026-10-20');
    expect(localParts(ts, VN).hour).toBe(1);
  });

  it('computes Monday start of the week', () => {
    // Wednesday 2026-10-21 10:00 VN -> Monday 2026-10-19 00:00 VN
    const wed = parseLocalDateTime('2026-10-21 10:00', VN) as number;
    expect(formatLocal(startOfLocalWeek(wed, VN), VN)).toBe('2026-10-19 00:00');
    // Sunday belongs to the week that started the previous Monday
    const sun = parseLocalDateTime('2026-10-25 23:59', VN) as number;
    expect(formatLocal(startOfLocalWeek(sun, VN), VN)).toBe('2026-10-19 00:00');
  });

  it('builds month ranges including December', () => {
    const oct = monthRange('2026-10', VN)!;
    expect(formatLocal(oct.from, VN)).toBe('2026-10-01 00:00');
    expect(formatLocal(oct.to, VN)).toBe('2026-11-01 00:00');
    const dec = monthRange('2026-12', VN)!;
    expect(formatLocal(dec.to, VN)).toBe('2027-01-01 00:00');
    expect(monthRange('2026-13', VN)).toBeNull();
    expect(monthRange('oct', VN)).toBeNull();
  });

  it('validates timezones and HH:MM', () => {
    expect(isValidTimezone('Asia/Ho_Chi_Minh')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(parseHm('07:00')).toBe(420);
    expect(parseHm('7:05')).toBe(425);
    expect(parseHm('24:00')).toBeNull();
    expect(parseHm('abc')).toBeNull();
  });
});
