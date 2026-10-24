import { _initTestDatabase } from './test-db.js';
import { describe, expect, it } from 'vitest';

import type { FbAdAccountRow } from './store.js';
import { buildOverview, overviewWindow } from './overview.js';

const day = (d: string, spend: number, extra: Record<string, unknown> = {}) => ({
  date_start: d, spend: String(spend), impressions: String(spend * 10), inline_link_clicks: String(spend / 10), ...extra,
});

function stored(id: string, patch: Partial<FbAdAccountRow> = {}): FbAdAccountRow {
  return {
    id, name: id, currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', connection_id: 'ca_1', entity_id: 'u', enabled: 0,
    result_type: 'lead', target_cpa: null, monthly_budget: null, status: 'ACTIVE', synced_at: null, created_at: 0, updated_at: 0, ...patch,
  };
}

const base = { window: 2, today: '2026-10-21', fetchedAt: 1, connection: 'ACTIVE' as const, warnings: [] };

describe('buildOverview', () => {
  it('splits two windows ending today, keeps today and the month apart, and sums totals', () => {
    const msg = (n: number) => ({ actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: String(n) }] });
    const dto = buildOverview({
      ...base,
      stored: [stored('act_1', { enabled: 1, result_type: 'message', monthly_budget: 5000 })],
      rows: [{
        row: {
          id: 'act_1', name: 'A', currency: 'VND', account_status: 1, amount_spent: '900000', spend_cap: '1000000',
          business: { id: '22', name: 'Kaching' },
          insights: { data: [
            day('2026-09-30', 70), // last month: in no window, not in the month
            day('2026-10-16', 50), // before both windows, still this month
            day('2026-10-18', 100, msg(2)),
            day('2026-10-19', 100),
            day('2026-10-20', 300, msg(3)),
            day('2026-10-21', 40),
          ] },
        },
      }],
    });
    expect(dto.days).toEqual(['2026-10-20', '2026-10-21']);
    const a = dto.accounts[0];
    expect(a).toMatchObject({ id: 'act_1', spend: 340, spendPrev: 200, spendToday: 40, spendMonth: 590, monthlyBudget: 5000, results: 3, resultsPrev: 2, resultType: 'message', resultTypeGuessed: false, enabled: true });
    expect(a.spark).toEqual([300, 40]);
    expect(a.spendCap).toBe(1_000_000);
    expect(dto.totals).toMatchObject({ spend: 340, spendPrev: 200, spendToday: 40, spendMonth: 590, impressions: 3400, impressionsPrev: 2000, spendingAccounts: 1, activeAccounts: 1 });
    expect(dto.totals.resultsByType.message).toEqual({ results: 3, resultsPrev: 2, spend: 340, spendPrev: 200 });
    expect(dto.daily.map((d) => d.total)).toEqual([300, 40]);
    expect(dto.businesses).toEqual([{ id: '22', name: 'Kaching', spend: 340, spendPrev: 200, accounts: 1 }]);
  });

  it('guesses the result type of an unconfigured account and sorts by spend', () => {
    const dto = buildOverview({
      ...base,
      stored: [],
      rows: [
        { row: { id: '2', name: 'Small', currency: 'VND', insights: { data: [day('2026-10-21', 10)] } } },
        { row: { account_id: '1', name: 'Big', currency: 'VND', insights: { data: [day('2026-10-21', 500, { actions: [{ action_type: 'purchase', value: '4' }], action_values: [{ action_type: 'purchase', value: '2000' }] })] } } },
        { row: { id: 'act_1', name: 'Duplicate' } },
      ],
    });
    expect(dto.accounts.map((a) => a.id)).toEqual(['act_1', 'act_2']);
    expect(dto.accounts[0]).toMatchObject({ resultType: 'purchase', resultTypeGuessed: true, results: 4, revenue: 2000, roas: 4 });
    expect(dto.businesses[0].name).toBe('Không thuộc business portfolio');
  });

  it('totals only the dominant currency and lists the others', () => {
    const dto = buildOverview({
      ...base,
      stored: [],
      rows: [
        { row: { id: '1', currency: 'VND', insights: { data: [day('2026-10-20', 1_000_000)] } } },
        { row: { id: '2', currency: 'USD', insights: { data: [day('2026-10-20', 50)] } } },
      ],
    });
    expect(dto.currency).toBe('VND');
    expect(dto.otherCurrencies).toEqual(['USD']);
    expect(dto.totals.spend).toBe(1_000_000);
    expect(dto.accounts).toHaveLength(2);
  });
});

describe('overview helpers', () => {
  it('accepts only the offered windows', () => {
    expect(overviewWindow('14')).toBe(14);
    expect(overviewWindow('5')).toBe(7);
    expect(overviewWindow(undefined)).toBe(7);
  });
});
