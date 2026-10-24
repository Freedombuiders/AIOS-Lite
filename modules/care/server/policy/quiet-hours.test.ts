import { describe, expect, it } from 'vitest';
import { quietHoursAt } from './quiet-hours.js';

const at = (h: number, m = 0) => new Date(2026, 9, 24, h, m, 0, 0).getTime();

describe('quietHoursAt', () => {
  const w = { start: '22:00', end: '07:00' };
  it('is active late at night and before the morning end', () => {
    expect(quietHoursAt(w, at(23)).active).toBe(true);
    expect(quietHoursAt(w, at(3)).active).toBe(true);
  });
  it('is inactive during the day', () => {
    expect(quietHoursAt(w, at(12)).active).toBe(false);
    expect(quietHoursAt(w, at(7)).active).toBe(false);
  });
  it('reports when the window ends', () => {
    expect(quietHoursAt(w, at(23)).endsAtMs).toBe(new Date(2026, 9, 25, 7, 0, 0, 0).getTime());
    expect(quietHoursAt(w, at(3)).endsAtMs).toBe(at(7));
  });
  it('treats a same-day window and invalid input', () => {
    expect(quietHoursAt({ start: '12:00', end: '13:00' }, at(12, 30)).active).toBe(true);
    expect(quietHoursAt({ start: '12:00', end: '13:00' }, at(14)).active).toBe(false);
    expect(quietHoursAt({ start: 'x', end: '07:00' }, at(3)).active).toBe(false);
    expect(quietHoursAt({ start: '08:00', end: '08:00' }, at(8)).active).toBe(false);
  });
});
