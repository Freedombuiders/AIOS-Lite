import { describe, expect, it } from 'vitest';

import {
  activityTotals, dayLabel, fmtCompact, fmtLongDate, fmtRelative, fmtTime, fmtUsd, greeting,
  groupByDay, spendByAgent, spendByDay, statusLine, upcomingItems,
} from './home-dashboard';

// 2026-10-20 17:30 in Ho Chi Minh (UTC+7) = 10:30 UTC.
const NOW = Date.UTC(2026, 9, 20, 10, 30);
const sec = (ms: number) => Math.floor(ms / 1000);

describe('formatting', () => {
  it('formats numbers, money and dates the Vietnamese way', () => {
    expect(fmtCompact(70_900).replace(/\s/g, ' ')).toBe('70,9 N');
    expect(fmtCompact(9_999)).toBe('9.999');
    expect(fmtCompact(null)).toBe('—');
    expect(fmtUsd(3.2469924)).toBe('$3,25');
    expect(fmtUsd(0.0421)).toBe('$0,042');
    expect(fmtUsd(null)).toBe('—');
    expect(fmtLongDate(NOW)).toBe('Thứ ba, 20 tháng 10, 2026');
    expect(fmtTime(NOW)).toBe('17:30');
  });

  it('greets by local hour', () => {
    expect(greeting(7)).toBe('Chào buổi sáng');
    expect(greeting(12)).toBe('Chào buổi trưa');
    expect(greeting(17)).toBe('Chào buổi chiều');
    expect(greeting(21)).toBe('Chào buổi tối');
    expect(greeting(2)).toBe('Khuya rồi');
  });

  it('says how long ago or how soon', () => {
    expect(fmtRelative(sec(NOW) - 20, NOW)).toBe('vừa xong');
    expect(fmtRelative(sec(NOW) - 600, NOW)).toBe('10 phút trước');
    expect(fmtRelative(sec(NOW) + 7200, NOW)).toBe('sau 2 giờ');
  });

  it('labels days relative to today in the local timezone', () => {
    expect(dayLabel(NOW + 3 * 3600_000, NOW)).toBe('Hôm nay');
    expect(dayLabel(NOW + 24 * 3600_000, NOW)).toBe('Ngày mai');
    expect(dayLabel(NOW + 48 * 3600_000, NOW)).toBe('Thứ năm 22/10');
  });
});

describe('upcoming', () => {
  it('lists enabled schedules inside the window, soonest first', () => {
    const items = upcomingItems({
      nowMs: NOW,
      agentNames: { main: 'Trợ lý chính' },
      schedules: [
        { id: 1, name: 'Báo cáo sáng', agentId: 'main', enabled: true, nextRunAt: new Date(NOW + 7200_000).toISOString() },
        { id: 2, name: 'Quét tin', agentId: 'main', enabled: true, nextRunAt: new Date(NOW + 1800_000).toISOString() },
        { id: 3, name: 'Tắt', agentId: 'main', enabled: false, nextRunAt: new Date(NOW + 1800_000).toISOString() },
        { id: 4, name: 'Quá xa', agentId: 'main', enabled: true, nextRunAt: new Date(NOW + 9 * 86_400_000).toISOString() },
      ],
    });
    expect(items.map((i) => i.key)).toEqual(['schedule:2', 'schedule:1']);
    expect(items[0]).toMatchObject({ title: 'Quét tin', sub: 'Lịch định kỳ · Trợ lý chính' });
    expect(groupByDay(items, NOW).map((g) => g.label)).toEqual(['Hôm nay']);
  });
});

describe('spend and activity', () => {
  const rows = [
    { day: '2026-10-20', agentId: 'kol-studio', costUsd: 1.3428, turns: 121 },
    { day: '2026-10-20', agentId: 'main', costUsd: 1.1719904, turns: 7 },
    { day: '2026-10-16', agentId: 'main', costUsd: 0.732202, turns: 2 },
  ];

  it('fills every day of the window and sums agents per day', () => {
    const days = spendByDay(rows, 7, NOW);
    expect(days).toHaveLength(7);
    expect(days[0].day).toBe('2026-10-14');
    expect(days[6].day).toBe('2026-10-20');
    expect(days[6].usd).toBeCloseTo(2.5147904, 5);
    expect(days[2]).toEqual({ day: '2026-10-16', usd: 0.732202 });
    expect(days[1].usd).toBe(0);
  });

  it('ranks spend per agent', () => {
    const byAgent = spendByAgent(rows);
    expect(byAgent.map((r) => [r.agentId, r.turns])).toEqual([['main', 9], ['kol-studio', 121]]);
    expect(byAgent[0].usd).toBeCloseTo(1.9041924, 5);
  });

  it('totals activity and only gives a rate when something ran', () => {
    expect(activityTotals([{ day: 'a', succeeded: 3, failed: 1 }, { day: 'b', succeeded: 1, failed: 0 }])).toEqual({ succeeded: 4, failed: 1, total: 5, rate: 80 });
    expect(activityTotals([{ day: 'a', succeeded: 0, failed: 0 }]).rate).toBeNull();
  });

  it('builds the status sentence from what is known', () => {
    expect(statusLine({ needsYou: 0, agentsRunning: 1, agentsTotal: 2, tasksRunning: 0, upcomingToday: 0, careWaiting: 0 }))
      .toEqual(['Không có việc nào chờ bạn', '1/2 agent trực tuyến', 'Lịch hôm nay trống']);
    expect(statusLine({ needsYou: 3, agentsRunning: null, agentsTotal: null, tasksRunning: null, upcomingToday: 2, careWaiting: 4 }))
      .toEqual(['3 việc cần bạn xử lý', '4 khách đang chờ trả lời', '2 mục trong lịch hôm nay']);
  });
});
