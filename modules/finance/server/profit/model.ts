import { z } from 'zod';

export const TIERS = ['Rất thấp', 'Thấp', 'Trung bình', 'Cao', 'Rất cao'] as const;
export const KINDS = { revenue: 'Doanh thu', refund: 'Hoàn tiền', direct: 'Chi phí trực tiếp', overhead: 'Chi phí vận hành', tax: 'Thuế / chi phí thuế', investment: 'Đầu tư', financing: 'Vốn bổ sung', ad_payment: 'Thanh toán quảng cáo', other_ads: 'Chi phí Ads ngoài Meta' } as const;
const money = z.number().finite().min(0).max(1e15);
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(v); return !isNaN(+d) && d.toISOString().slice(0, 10) === v; }, 'Ngày không hợp lệ');
const id = z.string().min(1).max(120);
export const documentSchema = z.object({
  version: z.literal(1), currency: z.enum(['VND', 'USD']), openingCash: z.number().finite().min(-1e15).max(1e15), startDate: dateSchema,
  products: z.array(z.object({ id, name: z.string().trim().min(1).max(200), category: z.string().trim().min(1).max(100), tier: z.enum(TIERS), price: money })).max(1000),
  entries: z.array(z.object({ id, productId: z.string().max(120), kind: z.enum(Object.keys(KINDS) as [keyof typeof KINDS, ...(keyof typeof KINDS)[]]), date: dateSchema, amount: money, cashDate: dateSchema.nullable(), cash: money, note: z.string().trim().min(1).max(500), customerType: z.enum(['new', 'returning', 'na']), customers: z.number().int().min(0).max(1e7) })).max(20000),
  mappings: z.array(z.object({ accountId: id, campaignId: id, productId: id })).max(10000),
}).superRefine((d, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const ids = new Set(d.products.map(p => p.id));
  if (ids.size !== d.products.length || new Set(d.entries.map(e => e.id)).size !== d.entries.length) fail('ID trùng lặp');
  if (new Set(d.mappings.map(m => `${m.accountId}:${m.campaignId}`)).size !== d.mappings.length) fail('Chiến dịch đã được gắn sản phẩm');
  for (const m of d.mappings) if (!ids.has(m.productId)) fail('Sản phẩm không tồn tại');
  for (const e of d.entries) {
    if (e.productId && !ids.has(e.productId)) fail('Sản phẩm không tồn tại');
    if (e.date < d.startDate || (e.cashDate && e.cashDate < d.startDate)) fail('Giao dịch trước ngày bắt đầu sổ');
    if (e.cash > 0 && !e.cashDate) fail('Thiếu ngày thực thu / chi');
    if (['investment', 'financing', 'ad_payment'].includes(e.kind) && e.amount !== 0) fail('Khoản tiền này chỉ ghi dòng tiền; số ghi nhận phải bằng 0');
    if (e.kind !== 'revenue' && e.customers !== 0) fail('Chỉ đếm khách ở doanh thu');
  }
});
export type ProfitDocument = z.infer<typeof documentSchema>;
export interface AdSpend { accountId: string; campaignId: string; name: string; day: string; currency: string; spend: number; capturedAt: number; }
export const emptyDocument = (): ProfitDocument => ({ version: 1, currency: 'VND', openingCash: 0, startDate: new Date().toISOString().slice(0, 10), products: [], entries: [], mappings: [] });
export function calculateProfit(d: ProfitDocument, ads: AdSpend[], from: string, to: string) {
  const blank = (id: string, name: string) => ({ id, name, revenue: 0, refunds: 0, direct: 0, overhead: 0, tax: 0, ads: 0, newCustomers: 0, returningCustomers: 0 });
  const rows = [...d.products.map(p => blank(p.id, p.name)), blank('', 'Chung / chưa phân bổ')];
  const byId = new Map(rows.map(r => [r.id, r]));
  const cashDays = new Map<string, number>();
  let opening = d.openingCash;
  const inRange = (day: string) => day >= from && day <= to;
  for (const e of d.entries) {
    const r = byId.get(e.productId) ?? byId.get('')!;
    if (inRange(e.date)) {
      if (e.kind === 'revenue') { r.revenue += e.amount; if (e.customerType === 'new') r.newCustomers += e.customers; if (e.customerType === 'returning') r.returningCustomers += e.customers; }
      if (e.kind === 'refund') r.refunds += e.amount;
      if (e.kind === 'direct') r.direct += e.amount;
      if (e.kind === 'overhead') r.overhead += e.amount;
      if (e.kind === 'tax') r.tax += e.amount;
      if (e.kind === 'other_ads') r.ads += e.amount;
    }
    if (e.cashDate && e.cashDate <= to) {
      const net = e.cash * (['revenue', 'financing'].includes(e.kind) ? 1 : -1);
      if (e.cashDate < from) opening += net;
      else cashDays.set(e.cashDate, (cashDays.get(e.cashDate) ?? 0) + net);
    }
  }
  const mappings = new Map(d.mappings.map(m => [`${m.accountId}:${m.campaignId}`, m.productId]));
  let excludedAds = 0;
  for (const a of ads) {
    if (!inRange(a.day) || a.day < d.startDate) continue;
    if (a.currency !== d.currency) { excludedAds++; continue; }
    (byId.get(mappings.get(`${a.accountId}:${a.campaignId}`) ?? '') ?? byId.get('')!).ads += a.spend;
  }
  const finish = (r: ReturnType<typeof blank>) => {
    const netRevenue = r.revenue - r.refunds;
    const gross = netRevenue - r.direct;
    const contribution = gross - r.ads;
    const profit = contribution - r.overhead - r.tax;
    return { ...r, netRevenue, gross, contribution, profit, margin: netRevenue > 0 ? profit / netRevenue : null, cac: r.newCustomers > 0 ? r.ads / r.newCustomers : null };
  };
  const total = blank('total', 'Toàn công ty');
  for (const r of rows) for (const key of ['revenue', 'refunds', 'direct', 'overhead', 'tax', 'ads', 'newCustomers', 'returningCustomers'] as const) total[key] += r[key];
  let closing = opening;
  const timeline = [...cashDays].sort(([a], [b]) => a.localeCompare(b)).map(([day, change]) => ({ day, change, balance: closing += change }));
  return { rows: rows.map(finish), total: finish(total), opening, closing, netCash: closing - opening, timeline, excludedAds };
}
