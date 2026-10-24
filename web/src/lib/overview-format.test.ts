import { describe, expect, it } from 'vitest';
import { delta, fmtCount, fmtMinutes, fmtRate, fmtVndCompact } from './overview-format';

describe('overview format', () => {
  it('prints VND compactly and unknown as a dash', () => {
    expect(fmtVndCompact(18_205_502)).toBe('18,2 tr');
    expect(fmtVndCompact(1_250_000_000)).toBe('1,25 tỷ');
    expect(fmtVndCompact(-950_000)).toBe('−950 k');
    expect(fmtVndCompact(null)).toBe('—');
    expect(fmtCount(1234)).toBe('1.234');
    expect(fmtRate(0.0734)).toBe('7,3%');
    expect(fmtRate(0.0103)).toBe('1,0%');
    expect(fmtRate(0.5)).toBe('50%');
    expect(fmtMinutes(95)).toBe('1 g 35 ph');
  });

  it('compares with the previous period', () => {
    expect(delta(110, 100)).toEqual({ pct: 0.1, dir: 'up' });
    expect(delta(90, 100)).toEqual({ pct: -0.1, dir: 'down' });
    expect(delta(5, 0)).toEqual({ pct: null, dir: 'up' });
    expect(delta(null, 100)).toEqual({ pct: null, dir: 'flat' });
  });
});
