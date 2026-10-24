import { describe, expect, it } from 'vitest';

import { isLayerDue, nextRunAt } from './worker.js';

const TZ = 'Asia/Ho_Chi_Minh';
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe('isLayerDue', () => {
  it('is not due before the slot, due after it, once per local day', () => {
    expect(isLayerDue(at('2026-10-17T12:59:00Z'), TZ, '20:00', null)).toBe(false); // 19:59 local
    expect(isLayerDue(at('2026-10-17T13:00:00Z'), TZ, '20:00', null)).toBe(true);
    expect(isLayerDue(at('2026-10-17T16:00:00Z'), TZ, '20:00', '2026-10-17')).toBe(false);
    expect(isLayerDue(at('2026-10-17T16:00:00Z'), TZ, '20:00', '2026-10-16')).toBe(true); // catch up after downtime
  });

  it('does not catch up after midnight: the new day waits for its own slot', () => {
    expect(isLayerDue(at('2026-10-17T17:30:00Z'), TZ, '20:00', '2026-10-17')).toBe(false); // 00:30 next day, slot not reached
    expect(isLayerDue(at('2026-10-17T17:30:00Z'), TZ, '20:00', '2026-10-16')).toBe(false);
  });

  it('catches a missed slot up for 6 hours only, so switching Radar on at night runs one layer, not three', () => {
    expect(isLayerDue(at('2026-10-17T15:00:00Z'), TZ, '07:00', null)).toBe(false); // 22:00 local, 07:00 slot long gone
    expect(isLayerDue(at('2026-10-17T15:00:00Z'), TZ, '12:00', null)).toBe(false);
    expect(isLayerDue(at('2026-10-17T15:00:00Z'), TZ, '20:00', null)).toBe(true);
    expect(nextRunAt(at('2026-10-17T15:00:00Z'), TZ, '07:00', null)).toBe('2026-10-18T00:00:00.000Z');
  });
});

describe('nextRunAt', () => {
  it('is today\'s slot when not run yet, else tomorrow', () => {
    expect(nextRunAt(at('2026-10-17T01:00:00Z'), TZ, '20:00', null)).toBe('2026-10-17T13:00:00.000Z');
    expect(nextRunAt(at('2026-10-17T14:00:00Z'), TZ, '20:00', '2026-10-17')).toBe('2026-10-18T13:00:00.000Z');
  });
});
