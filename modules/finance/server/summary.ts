import type { DB } from '../../../src/core/db.js';
import { buildPnl } from './pnl/engine.js';
import { resolveRange } from './pnl/range.js';
import { readInputs } from './pnl/store.js';
import type { PnlDto } from './pnl/types.js';
import { calculateProfit } from './profit/model.js';
import { readArchivedAds, readDocument, vnToday } from './profit/ledger.js';

export const fmtVnd = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? 'chưa có' : `${Math.round(n).toLocaleString('vi-VN')} đ`);

export interface MonthLedgerSummary {
  month: string;
  from: string;
  to: string;
  currency: 'VND' | 'USD';
  revenue: number;
  refunds: number;
  costs: number;
  profit: number;
  cashIn: number;
  cashOut: number;
  closingCash: number;
  entries: number;
}

/** Thu chi tháng này từ sổ thu chi: số ghi nhận (revenue/costs) và dòng tiền thực. */
export function monthLedger(db: DB, today = vnToday()): MonthLedgerSummary {
  const doc = readDocument(db);
  const from = `${today.slice(0, 7)}-01`;
  const r = calculateProfit(doc, readArchivedAds(db), from, today);
  const inMonth = doc.entries.filter((e) => e.date >= from && e.date <= today);
  let cashIn = 0;
  let cashOut = 0;
  for (const e of doc.entries) {
    if (!e.cashDate || e.cashDate < from || e.cashDate > today) continue;
    if (e.kind === 'revenue' || e.kind === 'financing') cashIn += e.cash; else cashOut += e.cash;
  }
  const t = r.total;
  return {
    month: today.slice(0, 7), from, to: today, currency: doc.currency,
    revenue: t.revenue, refunds: t.refunds, costs: t.direct + t.overhead + t.tax + t.ads, profit: t.profit,
    cashIn, cashOut, closingCash: r.closing, entries: inMonth.length,
  };
}

export function monthPnl(db: DB, flags: { erpConnected: boolean; whopConnected: boolean }, today = vnToday()): PnlDto | null {
  const range = resolveRange('month', today);
  if (!range) return null;
  return buildPnl(readInputs(db, { preset: 'month', ...range }, flags));
}

/** Compact text for agentContext (well under 3000 chars). */
export function agentSummary(db: DB, flags: { erpConnected: boolean; whopConnected: boolean }, today = vnToday()): string {
  const l = monthLedger(db, today);
  const lines = [`Tài chính tháng ${l.month} (đến ${l.to}):`];
  const dto = monthPnl(db, flags, today);
  if (dto) {
    const k = dto.kpis;
    lines.push(
      `- P&L: doanh thu gộp ${fmtVnd(k.grossRevenue)}, doanh thu thuần ${fmtVnd(k.netRevenue)}, giữ lại ${fmtVnd(k.retained)}, marketing ${fmtVnd(k.marketing)}, lợi nhuận ròng ${fmtVnd(k.netProfit)}${k.margin === null ? '' : ` (biên ${(k.margin * 100).toFixed(1)}%)`}.`,
    );
    const warn = dto.issues.filter((i) => i.level === 'warn').slice(0, 3).map((i) => i.text);
    if (warn.length) lines.push(`- Lưu ý dữ liệu: ${warn.join(' | ')}`);
  }
  lines.push(`- Sổ thu chi (${l.currency}): ghi nhận thu ${fmtVnd(l.revenue)}, chi ${fmtVnd(l.costs + l.refunds)}; tiền vào ${fmtVnd(l.cashIn)}, tiền ra ${fmtVnd(l.cashOut)}, số dư ${fmtVnd(l.closingCash)}; ${l.entries} khoản trong tháng.`);
  return lines.join('\n');
}
