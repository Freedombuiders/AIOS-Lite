import { _initTestDatabase } from './test-db.js';
import { describe, expect, it } from 'vitest';

import { buildBreakdowns } from './breakdowns.js';

const lead = (n: number) => [{ action_type: 'lead', value: String(n) }];

describe('buildBreakdowns', () => {
  it('sums age × gender cells and fills all 24 hours', () => {
    const dto = buildBreakdowns({ id: 'act_1', result_type: 'lead' }, {
      from: '2026-10-15', to: '2026-10-21', fetchedAt: 1,
      ageGender: [
        { age: '25-34', gender: 'female', spend: '300', impressions: '1000', inline_link_clicks: '20', actions: lead(3) },
        { age: '18-24', gender: 'male', spend: '100', impressions: '500', inline_link_clicks: '5', actions: lead(0) },
        { age: '65+', gender: 'unknown', spend: '0', impressions: '0' },
      ],
      hours: [
        { hourly_stats_aggregated_by_advertiser_time_zone: '20:00:00 - 20:59:59', spend: '200', impressions: '400', actions: lead(4) },
        { hourly_stats_aggregated_by_advertiser_time_zone: 'bad', spend: '9' },
      ],
    });
    expect(dto.ageGender).toEqual([
      { age: '18-24', gender: 'male', spend: 100, impressions: 500, linkClicks: 5, results: 0, cpa: null, ctr: 1 },
      { age: '25-34', gender: 'female', spend: 300, impressions: 1000, linkClicks: 20, results: 3, cpa: 100, ctr: 2 },
    ]);
    expect(dto.hours).toHaveLength(24);
    expect(dto.hours[20]).toMatchObject({ hour: 20, spend: 200, results: 4, cpa: 50 });
    expect(dto.hours[3]).toMatchObject({ spend: 0, results: 0, cpa: null });
  });
});
