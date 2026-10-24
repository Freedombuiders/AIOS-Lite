import { describe, expect, it } from 'vitest';
import { initialWideOpen, PANEL_STORAGE_KEY, WIDE_QUERY } from './useCustomerPanel';

describe('customer panel preference', () => {
  it('is open on a wide screen until the owner hides it, then stays hidden', () => {
    expect(initialWideOpen(null)).toBe(true);
    expect(initialWideOpen('open')).toBe(true);
    expect(initialWideOpen('closed')).toBe(false);
    expect(initialWideOpen('garbage')).toBe(true);
  });
  it('the column starts at 1280px and the choice lives in this browser only', () => {
    expect(WIDE_QUERY).toBe('(min-width: 1280px)');
    expect(PANEL_STORAGE_KEY).toContain('care');
  });
});
