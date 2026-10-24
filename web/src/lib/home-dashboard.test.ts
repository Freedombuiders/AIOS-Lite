import { describe, expect, it } from 'vitest';

import { fmtLongDate, fmtTime, greeting, localParts } from './home-dashboard';

// 2026-10-20 17:30 in Ho Chi Minh (UTC+7) = 10:30 UTC.
const NOW = Date.UTC(2026, 9, 20, 10, 30);

describe('home date helpers', () => {
  it('formats dates the Vietnamese way in the business timezone', () => {
    expect(fmtLongDate(NOW)).toBe('Thứ ba, 20 tháng 10, 2026');
    expect(fmtTime(NOW)).toBe('17:30');
    expect(localParts(Date.UTC(2026, 9, 20, 17, 30)).key).toBe('2026-10-21');
  });

  it('greets by local hour', () => {
    expect(greeting(7)).toBe('Chào buổi sáng');
    expect(greeting(12)).toBe('Chào buổi trưa');
    expect(greeting(17)).toBe('Chào buổi chiều');
    expect(greeting(21)).toBe('Chào buổi tối');
    expect(greeting(2)).toBe('Khuya rồi');
  });
});
