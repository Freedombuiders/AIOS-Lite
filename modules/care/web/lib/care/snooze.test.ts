import { describe, expect, it } from 'vitest';
import { snoozeOptions } from './snooze';

/** Vietnam wall clock (UTC+7) -> instant. */
const vn = (y: number, m: number, d: number, h: number, min = 0) => Date.UTC(y, m - 1, d, h, min) - 7 * 3_600_000;
const ids = (now: number) => snoozeOptions(now).map((o) => o.id);

describe('snooze options (Asia/Ho_Chi_Minh)', () => {
  it('Tuesday morning: 1 hour, 17:00 today, 9:00 tomorrow, next Monday 9:00', () => {
    const now = vn(2026, 10, 13, 10, 15); // Tue 13 Oct 2026 10:15
    const o = snoozeOptions(now);
    expect(o.map((x) => x.id)).toEqual(['oneHour', 'today17', 'tomorrow9', 'monday9']);
    expect(o[0].untilMs).toBe(now + 3_600_000);
    expect(o[1].untilMs).toBe(vn(2026, 10, 13, 17));
    expect(o[2].untilMs).toBe(vn(2026, 10, 14, 9));
    expect(o[3].untilMs).toBe(vn(2026, 10, 19, 9));
  });
  it('after 17:00 there is no "17:00 today"', () => {
    expect(ids(vn(2026, 10, 13, 18, 0))).toEqual(['oneHour', 'tomorrow9', 'monday9']);
  });
  it('within the hour before 17:00 it would be sooner than the 1-hour option: dropped', () => {
    expect(ids(vn(2026, 10, 13, 16, 30))).toEqual(['oneHour', 'tomorrow9', 'monday9']);
    expect(ids(vn(2026, 10, 13, 15, 59))).toContain('today17');
  });
  it('Sunday: tomorrow already is Monday, so the Monday option is not repeated', () => {
    const o = snoozeOptions(vn(2026, 10, 18, 9, 0)); // Sunday
    expect(o.map((x) => x.id)).toEqual(['oneHour', 'today17', 'tomorrow9']);
    expect(o[2].untilMs).toBe(vn(2026, 10, 19, 9));
  });
  it('Monday offers the NEXT Monday, not today', () => {
    const o = snoozeOptions(vn(2026, 10, 19, 8, 0));
    expect(o.at(-1)).toEqual({ id: 'monday9', untilMs: vn(2026, 10, 26, 9) });
  });
  it('uses Vietnam time even when it is another calendar day in UTC', () => {
    // 20:00 UTC on the 13th = 03:00 on the 14th in Vietnam: "tomorrow 9:00" is the 15th there
    const now = Date.UTC(2026, 9, 13, 20, 0);
    const tomorrow = snoozeOptions(now).find((o) => o.id === 'tomorrow9')!;
    expect(tomorrow.untilMs).toBe(vn(2026, 10, 15, 9));
    expect(snoozeOptions(now).find((o) => o.id === 'today17')!.untilMs).toBe(vn(2026, 10, 14, 17));
  });
  it('month and year rollover', () => {
    const o = snoozeOptions(vn(2026, 12, 31, 20, 0)).find((x) => x.id === 'tomorrow9')!;
    expect(o.untilMs).toBe(vn(2027, 1, 1, 9));
  });
  it('options are ascending', () => {
    const o = snoozeOptions(vn(2026, 10, 13, 10, 0)).map((x) => x.untilMs);
    expect([...o].sort((a, b) => a - b)).toEqual(o);
  });
});
