import { formatBytes, formatDate } from './format';

describe('format', () => {
  it('sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1,5 KB');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(148_000)).toBe('145 KB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB');
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(-1)).toBeNull();
  });
  it('dates', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate('nope')).toBe('');
    expect(formatDate('2026-11-26T09:00:00.000Z', 'en')).toMatch(/26\/11\/2026/);
  });
});
