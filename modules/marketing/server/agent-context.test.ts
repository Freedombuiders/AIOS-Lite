import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAgentContext } from './agent-context.js';
import { makePage, seedContent, futureAt } from './core/test-fixtures.js';
import { bindFakeRuntime, unbindFakeRuntime } from './test-runtime.js';
import { _initTestDatabase, setFbSetting } from './store.js';

beforeEach(() => _initTestDatabase(':memory:'));
afterEach(() => unbindFakeRuntime());

describe('buildAgentContext', () => {
  it('is empty while the master switch is off or there are no Pages', () => {
    makePage('p1');
    expect(buildAgentContext(['analytics.read'])).toBeUndefined();
    setFbSetting('enabled', '1');
    _initTestDatabase(':memory:');
    setFbSetting('enabled', '1');
    expect(buildAgentContext(['analytics.read'])).toBeUndefined();
  });

  it('analytics.read: lists Pages with a 7-day summary line', () => {
    setFbSetting('enabled', '1');
    makePage('p1');
    const text = buildAgentContext(['analytics.read'])!;
    expect(text).toContain('Page p1 (id p1)');
    expect(text).toContain('7 ngày qua');
    expect(text.length).toBeLessThanOrEqual(3000);
  });

  it('content.write only: lists Pages and the next scheduled items', () => {
    setFbSetting('enabled', '1');
    makePage('p1');
    seedContent({ title: 'Bài hẹn giờ', status: 'scheduled', scheduled_at: futureAt(2, '09:00') });
    const text = buildAgentContext(['content.write'])!;
    expect(text).toContain('(id p1)');
    expect(text).toContain('Bài sắp đăng');
    expect(text).toContain('Bài hẹn giờ');
    expect(text).not.toContain('7 ngày qua');
    expect(text).toContain('giọng:');
    expect(text).toContain('giờ đăng');
  });

  it('clips a long brand voice to one short line per Page', () => {
    setFbSetting('enabled', '1');
    makePage('p1', { brand_voice: 'rất dài '.repeat(100) });
    const line = buildAgentContext(['content.write'])!.split('\n').find((l) => l.includes('giọng:'))!;
    expect(line.length).toBeLessThanOrEqual(200);
  });

  it('follows the module setting once a context is bound', () => {
    makePage('p1');
    bindFakeRuntime({ settings: { enabled: true } });
    expect(buildAgentContext(['content.write'])).toContain('(id p1)');
    unbindFakeRuntime();
    bindFakeRuntime({ settings: { enabled: false } });
    expect(buildAgentContext(['content.write'])).toBeUndefined();
  });
});
