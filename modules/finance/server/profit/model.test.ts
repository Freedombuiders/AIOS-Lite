import { describe, expect, it } from 'vitest';
import { calculateProfit, documentSchema, emptyDocument, type ProfitDocument, type AdSpend } from './model.js';
const base = (): ProfitDocument => ({ ...emptyDocument(), startDate: '2026-01-01', currency: 'USD', openingCash: 100, products: [{ id: 'course', name: 'Course', category: 'AI', tier: 'Cao', price: 100 }] });
const entry = (patch: Partial<ProfitDocument['entries'][number]>): ProfitDocument['entries'][number] => ({ id: 'e', productId: 'course', kind: 'revenue', date: '2026-01-01', amount: 100, cash: 0, cashDate: null, note: 'order', customerType: 'new', customers: 1, ...patch });
const ad = (patch: Partial<AdSpend> = {}): AdSpend => ({ accountId: 'a', campaignId: 'c', name: 'Campaign', day: '2026-01-02', currency: 'USD', spend: 10, capturedAt: 1, ...patch });
describe('profit accounting', () => {
  it('separates accrual from installments, investment, financing and advertising settlement', () => {
    const d = base();
    d.entries = [entry({ cash: 30, cashDate: '2026-01-03' }), entry({ id: 'installment', amount: 0, cash: 70, cashDate: '2026-02-02', customers: 0 }), entry({ id: 'direct', kind: 'direct', amount: 20, customers: 0 }), entry({ id: 'pay', kind: 'ad_payment', amount: 0, cash: 10, cashDate: '2026-01-05', customers: 0 }), entry({ id: 'investment', kind: 'investment', amount: 0, cash: 50, cashDate: '2026-01-10', customers: 0 }), entry({ id: 'capital', kind: 'financing', amount: 0, cash: 200, cashDate: '2026-01-11', customers: 0 })];
    d.mappings = [{ accountId: 'a', campaignId: 'c', productId: 'course' }];
    documentSchema.parse(d);
    const jan = calculateProfit(d, [ad()], '2026-01-01', '2026-01-31');
    expect(jan.total.profit).toBe(70);
    expect(jan.total.cac).toBe(10);
    expect(jan.closing).toBe(270);
    const feb = calculateProfit(d, [ad()], '2026-02-01', '2026-02-28');
    expect(feb.opening).toBe(270);
    expect(feb.total.profit).toBe(0);
    expect(feb.closing).toBe(340);
  });
  it('retains unallocated costs, excludes foreign currency and does not invent CAC', () => {
    const d = base(); d.entries = [entry({ kind: 'overhead', productId: '', amount: 15, customers: 0 })];
    const r = calculateProfit(d, [ad(), ad({ currency: 'VND', spend: 900000 })], '2026-01-01', '2026-01-31');
    expect(r.total.profit).toBe(-25); expect(r.rows.at(-1)?.ads).toBe(10); expect(r.total.cac).toBeNull(); expect(r.excludedAds).toBe(1);
  });
  it('deducts refunds and taxes without treating their unpaid amounts as cash', () => {
    const d = base(); d.entries = [entry({}), entry({ id: 'r', kind: 'refund', amount: 20, customers: 0 }), entry({ id: 'tax', kind: 'tax', amount: 5, customers: 0 })];
    const r = calculateProfit(d, [], '2026-01-01', '2026-01-31');
    expect(r.total.netRevenue).toBe(80); expect(r.total.profit).toBe(75); expect(r.closing).toBe(100);
  });
  it('rejects impossible dates, orphan references, duplicate mappings and missing cash dates', () => {
    for (const patch of [{ date: '2026-02-30' }, { productId: 'missing' }, { cash: 1 }, { amount: -1 }, { date: '2025-12-31' }, { kind: 'investment' as const, amount: 1 }]) {
      expect(documentSchema.safeParse({ ...base(), entries: [entry(patch)] }).success).toBe(false);
    }
    const m = { accountId: 'a', campaignId: 'c', productId: 'course' };
    expect(documentSchema.safeParse({ ...base(), mappings: [m, m] }).success).toBe(false);
  });
});
