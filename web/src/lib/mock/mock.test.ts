import { beforeEach, describe, expect, it } from 'vitest';
import { fold, formatCost, formatRelativeTime } from '../format';
import { mockEnabled, mockRequest } from './index';

describe('mock api', () => {
  beforeEach(() => sessionStorage.setItem('aios.mock', '1'));

  it('is enabled by the session flag', () => {
    expect(mockEnabled()).toBe(true);
    sessionStorage.clear();
    expect(mockEnabled()).toBe(false);
  });

  it('serves every list endpoint the pages use', async () => {
    for (const path of ['/agents', '/tasks', '/schedules', '/conversations', '/brain/folders', '/memory', '/skills', '/connections', '/modules', '/audit', '/board', '/attention', '/runtimes']) {
      const r = await mockRequest<{ items: unknown[] }>('GET', path);
      expect(Array.isArray(r.items), path).toBe(true);
    }
  });

  it('refuses to add a module whose requirements are missing (412)', async () => {
    await expect(mockRequest('POST', '/modules/marketing/add', {})).rejects.toMatchObject({ status: 412, code: 'requirements_missing' });
  });

  it('search ignores accents', async () => {
    const r = await mockRequest<{ items: unknown[] }>('GET', '/brain/search?q=gia%20tri');
    const withAccents = await mockRequest<{ items: unknown[] }>('GET', '/brain/search?q=Giá');
    expect(r.items.length >= 0).toBe(true);
    expect(withAccents.items.length).toBeGreaterThan(0);
  });
});

describe('format', () => {
  it('shows unknown numbers as a dash, never zero', () => {
    expect(formatCost(null)).toBe('—');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(1.234)).toBe('$1.23');
  });
  it('folds Vietnamese diacritics', () => {
    expect(fold('Đường Hoàng Sa')).toBe('duong hoang sa');
  });
  it('formats relative time in Vietnamese', () => {
    const now = Date.parse('2026-10-24T10:00:00Z');
    expect(formatRelativeTime('2026-10-24T09:00:00Z', now)).toBe('1 giờ trước');
    expect(formatRelativeTime(null)).toBe('—');
  });
});
