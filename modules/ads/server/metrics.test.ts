import { _initTestDatabase } from './test-db.js';
import { describe, expect, it } from 'vitest';

import { fmtMoney, fmtPct, fmtRatio } from './format.js';
import {
  addDays,
  budgetFromMinorUnits,
  cpaOf,
  ctrChangePct,
  dayIn,
  dayRange,
  extractRows,
  holdRateOf,
  hookRateOf,
  InsightsRowSchema,
  metricsFromInsights,
  monthElapsedPct,
  monthStart,
  placementKey,
  placementLabel,
  resultsFromActions,
  resultsFromRaw,
  resultsByType,
  sumDays,
  weightedFrequency,
  type DayStats,
} from './metrics.js';

function day(offset: number, p: Partial<DayStats> = {}): DayStats {
  return {
    day: addDays('2026-10-07', offset), spend: 0, impressions: 0, reach: null, frequency: null, clicks: 0,
    linkClicks: 0, lpViews: 0, results: 0, purchases: 0, revenue: 0, video3s: 0, thruplays: 0, ...p,
  };
}

describe('result mapping', () => {
  it('uses the aggregate action and does not add its parts', () => {
    const actions = [
      { action_type: 'lead', value: '10' },
      { action_type: 'onsite_conversion.lead_grouped', value: '6' },
      { action_type: 'offsite_conversion.fb_pixel_lead', value: '4' },
    ];
    expect(resultsFromActions(actions, 'lead')).toBe(10);
  });

  it('falls back to the sum of the parts when there is no aggregate', () => {
    const actions = [
      { action_type: 'onsite_conversion.lead_grouped', value: '6' },
      { action_type: 'offsite_conversion.fb_pixel_lead', value: '4' },
    ];
    expect(resultsFromActions(actions, 'lead')).toBe(10);
  });

  it('maps message, purchase and registration', () => {
    const actions = [
      { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: 12 },
      { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' },
      { action_type: 'complete_registration', value: '5' },
      { action_type: 'link_click', value: '99' },
    ];
    expect(resultsFromActions(actions, 'message')).toBe(12);
    expect(resultsFromActions(actions, 'purchase')).toBe(3);
    expect(resultsFromActions(actions, 'registration')).toBe(5);
    expect(resultsFromActions(undefined, 'lead')).toBe(0);
    expect(resultsFromActions([{ action_type: 'lead', value: 'abc' }], 'lead')).toBe(0);
  });

  it('keeps every type in raw_json so a changed type needs no API call', () => {
    const byType = resultsByType([{ action_type: 'lead', value: '7' }, { action_type: 'purchase', value: '2' }]);
    expect(byType).toEqual({ lead: 7, message: 0, purchase: 2, registration: 0 });
    const raw = JSON.stringify({ r: byType });
    expect(resultsFromRaw(raw, 'purchase')).toBe(2);
    expect(resultsFromRaw('not json', 'lead')).toBe(0);
    expect(resultsFromRaw('{}', 'lead')).toBe(0);
  });
});

describe('insights parsing', () => {
  const row = InsightsRowSchema.parse({
    date_start: '2026-10-06',
    spend: '1250000.50',
    impressions: '20000',
    reach: '15000',
    frequency: '1.33',
    clicks: '500',
    inline_link_clicks: '300',
    actions: [
      { action_type: 'lead', value: '12' },
      { action_type: 'landing_page_view', value: '220' },
      { action_type: 'video_view', value: '7000' },
      { action_type: 'purchase', value: '2' },
    ],
    action_values: [{ action_type: 'purchase', value: '9000000' }],
    video_thruplay_watched_actions: [{ action_type: 'video_view', value: '1400' }],
  });

  it('turns strings into numbers and reads every field the dashboard needs', () => {
    const m = metricsFromInsights(row, 'lead');
    expect(m).toMatchObject({
      spend: 1250000.5, impressions: 20000, reach: 15000, frequency: 1.33, clicks: 500, linkClicks: 300,
      lpViews: 220, results: 12, purchases: 2, revenue: 9000000, video3s: 7000, thruplays: 1400,
    });
  });

  it('results follow the result type', () => {
    expect(metricsFromInsights(row, 'purchase').results).toBe(2);
    expect(metricsFromInsights(row, 'message').results).toBe(0);
  });

  it('falls back to link_click actions when inline_link_clicks is absent', () => {
    const r = InsightsRowSchema.parse({ spend: '1', impressions: '10', actions: [{ action_type: 'link_click', value: '4' }] });
    expect(metricsFromInsights(r, 'lead').linkClicks).toBe(4);
  });

  it('treats missing numbers as zero / null instead of failing', () => {
    const m = metricsFromInsights(InsightsRowSchema.parse({}), 'lead');
    expect(m).toMatchObject({ spend: 0, impressions: 0, reach: null, frequency: null, results: 0, thruplays: 0 });
  });

  it('rejects a row whose shape is wrong', () => {
    expect(InsightsRowSchema.safeParse({ actions: 'nope' }).success).toBe(false);
  });
});

describe('extractRows', () => {
  it('reads data, data.data and named lists', () => {
    expect(extractRows({ data: [{ a: 1 }] }).rows).toHaveLength(1);
    expect(extractRows({ data: { data: [{ a: 1 }, { a: 2 }] } }).rows).toHaveLength(2);
    expect(extractRows({ data: { ads: [{ id: '1' }] } }).rows).toHaveLength(1);
    expect(extractRows([{ a: 1 }]).rows).toHaveLength(1);
    expect(extractRows(null).rows).toEqual([]);
    expect(extractRows({ data: { foo: 1 } }).rows).toEqual([]);
  });

  it('follows the cursor only when Meta says there is a next page', () => {
    const withNext = { data: { data: [{}], paging: { cursors: { after: 'CUR' }, next: 'https://x' } } };
    expect(extractRows(withNext, 500).after).toBe('CUR');
    // Meta sends a cursor on the last page too, but no `next`.
    const last = { data: [{}], paging: { cursors: { after: 'CUR' }, next: undefined }, } as unknown;
    expect(extractRows({ data: [{}], paging: { cursors: { after: 'CUR' } } }, 500).after).toBeNull();
    expect(extractRows(last, 500).after).toBeNull();
  });

  it('assumes more when paging has no `next` field and the page came back full', () => {
    const full = { data: Array.from({ length: 3 }, () => ({})), paging: { cursors: { after: 'C' } } };
    // `next` key absent altogether and page is full.
    expect(extractRows(full, 3).after).toBe('C');
    expect(extractRows(full, 4).after).toBeNull();
  });
});

describe('placements and currency', () => {
  it('labels placements in Vietnamese', () => {
    expect(placementLabel(placementKey('facebook', 'facebook_reels'))).toBe('Facebook Reels');
    expect(placementLabel(placementKey('instagram', 'feed'))).toBe('Instagram Bảng tin');
    expect(placementLabel(placementKey('facebook', 'story'))).toBe('Facebook Stories');
    expect(placementLabel(placementKey('audience_network', 'an_classic'))).toBe('Audience Network');
    expect(placementLabel(placementKey(undefined, undefined))).toBe('Khác');
    expect(placementLabel('facebook|some_new_spot')).toBe('Facebook some new spot');
  });

  it('converts budgets out of minor units, except for zero-decimal currencies', () => {
    expect(budgetFromMinorUnits('1800000', 'VND')).toBe(1800000);
    expect(budgetFromMinorUnits('1800', 'USD')).toBe(18);
    expect(budgetFromMinorUnits(undefined, 'VND')).toBeNull();
    expect(budgetFromMinorUnits('0', 'VND')).toBeNull();
  });
});

describe('dates', () => {
  it('computes the day in the account timezone', () => {
    // 2026-10-06 18:30 UTC is already the 7th in Ho Chi Minh (UTC+7).
    const t = Date.UTC(2026, 9, 6, 18, 30) / 1000;
    expect(dayIn('Asia/Ho_Chi_Minh', t)).toBe('2026-10-07');
    expect(dayIn('UTC', t)).toBe('2026-10-06');
    expect(dayIn('Not/AZone', t)).toBe('2026-10-06');
  });

  it('adds days across month boundaries and builds ranges', () => {
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(dayRange('2026-10-03', 3)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(monthStart('2026-10-17')).toBe('2026-10-01');
    expect(monthElapsedPct('2026-10-07')).toBeCloseTo((7 / 31) * 100, 5);
    expect(monthElapsedPct('2026-02-14')).toBeCloseTo((14 / 28) * 100, 5);
  });
});

describe('rates', () => {
  it('computes hook, hold, CPA and weighted frequency', () => {
    const t = sumDays([day(0, { spend: 600, results: 3, impressions: 1000, video3s: 380, thruplays: 80 }), day(-1, { spend: 400, results: 2, impressions: 1000, video3s: 380, thruplays: 76 })]);
    expect(cpaOf(t)).toBe(200);
    expect(hookRateOf(t)).toBeCloseTo(38, 5);
    expect(holdRateOf(t)).toBeCloseTo((156 / 760) * 100, 5);
    expect(hookRateOf({ video3s: 0, impressions: 100 })).toBeNull();
    expect(holdRateOf({ thruplays: 0, video3s: 0 })).toBeNull();
    expect(cpaOf({ spend: 5, results: 0 })).toBeNull();
    expect(weightedFrequency([day(0, { impressions: 3000, frequency: 2 }), day(-1, { impressions: 1000, frequency: 4 })])).toBeCloseTo(2.5, 5);
    expect(weightedFrequency([day(0, { impressions: 0, frequency: 2 })])).toBeNull();
  });
});

describe('ctrChangePct', () => {
  const series = (firstCtr: number, lastCtr: number, impressions = 10000): DayStats[] =>
    [-8, -7, -6, -5, -4, -3, -2, -1, 0].map((o, i) => {
      const ctr = i < 3 ? firstCtr : i >= 6 ? lastCtr : (firstCtr + lastCtr) / 2;
      return day(o, { impressions, linkClicks: Math.round(impressions * ctr / 100) });
    });

  it('compares the last 3 delivery days with the first 3', () => {
    expect(ctrChangePct(series(2.4, 1.6))).toBeCloseTo(-33.33, 1);
    expect(ctrChangePct(series(1.0, 1.5))).toBeCloseTo(50, 1);
  });

  it('needs six delivery days, enough impressions and a non-zero start', () => {
    expect(ctrChangePct(series(2.4, 1.6).slice(0, 5))).toBeNull();
    expect(ctrChangePct(series(2.4, 1.6, 100))).toBeNull();
    expect(ctrChangePct(series(0, 1.6))).toBeNull();
  });

  it('ignores days without delivery', () => {
    const days = [...series(2.4, 1.6), day(-9), day(-10)];
    expect(ctrChangePct(days)).toBeCloseTo(-33.33, 1);
  });
});

describe('Vietnamese formatting', () => {
  it('formats VND the way the design does', () => {
    expect(fmtMoney(195_454, 'VND')).toBe('195k');
    expect(fmtMoney(4_300_000, 'VND')).toBe('4,3 tr');
    expect(fmtMoney(1_100_000, 'VND')).toBe('1,1 tr');
    expect(fmtMoney(2_160_000, 'VND', 2)).toBe('2,16 tr');
    expect(fmtMoney(1_800_000, 'VND', 2)).toBe('1,8 tr');
    expect(fmtMoney(1_200_000_000, 'VND')).toBe('1,2 tỷ');
    expect(fmtMoney(850, 'VND')).toBe('850');
    expect(fmtMoney(12.345, 'USD')).toBe('12,35 USD');
    expect(fmtMoney(250, 'USD')).toBe('250 USD');
  });

  it('formats ratios and percentages', () => {
    expect(fmtRatio(1.6287)).toBe('1,63×');
    expect(fmtRatio(9)).toBe('9×');
    expect(fmtRatio(12.4)).toBe('12×');
    expect(fmtPct(0.8)).toBe('0,8%');
    expect(fmtPct(38.04, 0)).toBe('38%');
  });
});
