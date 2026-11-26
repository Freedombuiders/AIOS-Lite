import { describe, expect, it } from 'vitest';

import type { Run } from '@core/types';
import { botInitials, botState, doneToday, fmtLongDate, fmtTime, greeting, localParts } from './home-dashboard';

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

const run = (over: Partial<Run>): Run => ({
  id: 1, taskId: 1, agentId: 'main', runtime: 'mock', model: null, status: 'done', trigger: 'assigned', sessionId: null, output: null,
  errorFamily: null, error: null, inputTokens: null, outputTokens: null, costUsd: null, accessJson: null, skillsJson: null,
  startedAt: new Date(NOW - 3_600_000).toISOString(), finishedAt: new Date(NOW - 1_800_000).toISOString(), durationMs: null, ...over,
});

describe('doneToday', () => {
  it('keeps only successful, non-chat runs finished today, newest first, titled from the task', () => {
    const rows = doneToday(
      [
        run({ id: 1, taskId: 10, finishedAt: new Date(NOW - 3_600_000).toISOString() }),
        run({ id: 2, taskId: 11, finishedAt: new Date(NOW - 600_000).toISOString(), output: '**Caption 1:** nội dung' }),
        run({ id: 3, taskId: 12, status: 'failed' }),
        run({ id: 4, taskId: 13, trigger: 'chat' }),
        run({ id: 5, taskId: 14, finishedAt: new Date(NOW - 36 * 3_600_000).toISOString() }),
        run({ id: 6, taskId: 15, status: 'running', finishedAt: null }),
      ],
      new Map([[10, 'Trả lời khách']]),
      NOW,
    );
    expect(rows.map((r) => r.runId)).toEqual([2, 1]);
    expect(rows[0]!.text).toBe('Caption 1: nội dung');
    expect(rows[1]).toMatchObject({ text: 'Trả lời khách', time: '16:30', agentId: 'main' });
  });

  it('falls back to the task number when there is no title and no output', () => {
    expect(doneToday([run({ taskId: 77 })], new Map(), NOW)[0]!.text).toBe('Việc #77');
  });

  it('uses the business day, not UTC: a run just after local midnight is today', () => {
    // 2026-10-20 00:10 in Ho Chi Minh = 2026-10-19 17:10 UTC
    const late = Date.UTC(2026, 9, 19, 17, 10);
    expect(doneToday([run({ finishedAt: new Date(late).toISOString() })], new Map(), Date.UTC(2026, 9, 20, 10, 30))).toHaveLength(1);
    expect(doneToday([run({ finishedAt: new Date(late - 3_600_000).toISOString() })], new Map(), Date.UTC(2026, 9, 20, 10, 30))).toHaveLength(0);
  });
});

describe('bot tiles', () => {
  it('reads the state from the counts, running first', () => {
    expect(botState({ running: 1, queued: 3 })).toBe('busy');
    expect(botState({ running: 0, queued: 2 })).toBe('queued');
    expect(botState({ running: 0, queued: 0 })).toBe('idle');
    expect(botState(undefined)).toBe('idle');
  });

  it('makes two-letter initials', () => {
    expect(botInitials('Bot CSKH')).toBe('BC');
    expect(botInitials('Trợ lý chính')).toBe('TL');
    expect(botInitials('Đức')).toBe('ĐỨ');
    expect(botInitials('  ')).toBe('?');
  });
});
