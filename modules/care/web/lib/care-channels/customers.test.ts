import { describe, expect, it } from 'vitest';
import { customersQuery, relativeDay, stageTone } from './customers';

describe('customers list query', () => {
  it('always limits; adds q, stage, cursor only when set', () => {
    expect(customersQuery({})).toBe('limit=50');
    expect(customersQuery({ q: '  lan  ', stage: 'won', cursor: 'abc' })).toBe('limit=50&q=lan&stage=won&cursor=abc');
    expect(customersQuery({ q: '   ', stage: '' })).toBe('limit=50');
    expect(customersQuery({ q: 'a&b' })).toBe('limit=50&q=a%26b');
  });
  it('tones and day labels', () => {
    expect(stageTone('won')).toBe('won');
    expect(stageTone('lost')).toBe('lost');
    expect(stageTone('new')).toBe('plain');
    expect(stageTone('quoted')).toBe('active');
    const now = Date.UTC(2026, 9, 13, 5);
    expect(relativeDay(now - 3600_000, now)).toBe('hôm nay');
    expect(relativeDay(now - 36 * 3600_000, now)).toBe('hôm qua');
    expect(relativeDay(now - 3 * 86_400_000, now)).toBe('3 ngày trước');
    expect(relativeDay(0, now)).toBe('—');
  });
});
