import { describe, expect, it } from 'vitest';
import { addDays, overviewRange, parseOverviewDays, rangeDates } from './overview-range';

describe('overview range', () => {
  it('ends today in Vietnam time and pairs it with the previous span', () => {
    // 2026-10-24 23:30 in Vietnam = 16:30 UTC
    const r = overviewRange(7, Date.UTC(2026, 9, 24, 16, 30));
    expect(r).toEqual({ days: 7, from: '2026-10-18', to: '2026-10-24', prevFrom: '2026-10-11', prevTo: '2026-10-17' });
    expect(overviewRange(7, Date.UTC(2026, 9, 24, 17, 30)).to).toBe('2026-10-25');
  });

  it('walks month and year ends, lists every day, falls back to 30', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(rangeDates({ from: '2026-10-30', to: '2026-11-02' })).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(parseOverviewDays('90')).toBe(90);
    expect(parseOverviewDays('12')).toBe(30);
    expect(parseOverviewDays(null)).toBe(30);
  });
});
