import { Banknote, BookOpen, Network, ServerCog } from 'lucide-preact';
import { Link } from 'wouter-preact';
import { defineWebModule } from '@/module-host/contracts';
import { useFetch } from '@/lib/useFetch';
import './styles/pnl.css';
import { Pnl } from './pages/Pnl';
import { BusinessModel } from './pages/BusinessModel';
import { ProfitDashboard } from './pages/ProfitDashboard';
import { Erp } from './pages/Erp';

interface MonthSummary {
  month: string; currency: 'VND' | 'USD'; revenue: number; refunds: number; costs: number; profit: number;
  cashIn: number; cashOut: number; closingCash: number; entries: number;
}

const money = (n: number, currency: string) => `${Math.round(n).toLocaleString('vi-VN')} ${currency === 'USD' ? '$' : 'đ'}`;

function MonthWidget() {
  const { data, error } = useFetch<{ month: MonthSummary }>('/api/m/finance/summary', 60_000);
  if (error) return <div class="text-sm text-[var(--color-text-muted)]">Chưa đọc được số thu chi.</div>;
  if (!data) return <div class="text-sm text-[var(--color-text-muted)]">Đang tải…</div>;
  const m = data.month;
  if (m.entries === 0 && m.cashIn === 0 && m.cashOut === 0) {
    return <div class="text-sm text-[var(--color-text-muted)]">Chưa có khoản thu chi nào trong tháng {m.month.slice(5)}/{m.month.slice(0, 4)}. <Link href="/m/finance/ledger" class="underline">Mở Sổ thu chi</Link></div>;
  }
  const rows: Array<[string, string, boolean?]> = [
    ['Thu (ghi nhận)', money(m.revenue, m.currency)],
    ['Chi (ghi nhận)', money(m.costs + m.refunds, m.currency)],
    ['Lợi nhuận', money(m.profit, m.currency), m.profit < 0],
    ['Tiền vào / ra', `${money(m.cashIn, m.currency)} / ${money(m.cashOut, m.currency)}`],
  ];
  return (
    <ul class="m-0 p-0 list-none flex flex-col gap-1.5">
      {rows.map(([label, value, negative]) => (
        <li key={label} class="flex items-baseline justify-between gap-2 text-[13px]">
          <span class="text-[var(--color-text-muted)]">{label}</span>
          <span class={negative ? 'text-[#fca5a5]' : ''}>{value}</span>
        </li>
      ))}
      <li class="text-[11.5px] text-[var(--color-text-faint)]">Tháng {m.month.slice(5)}/{m.month.slice(0, 4)} · <Link href="/m/finance/ledger" class="underline">Sổ thu chi</Link></li>
    </ul>
  );
}

export default defineWebModule({
  id: 'finance',
  nav: [
    { group: 'finance', label: 'P&L & dòng tiền', path: '/m/finance/pnl', icon: Banknote, order: 10 },
    { group: 'finance', label: 'Mô hình kinh doanh', path: '/m/finance/business-model', icon: Network, order: 20 },
    { group: 'finance', label: 'Sổ thu chi', path: '/m/finance/ledger', icon: BookOpen, order: 30 },
    { group: 'finance', label: 'ERP', path: '/m/finance/erp', icon: ServerCog, order: 40 },
  ],
  routes: [
    { path: '/m/finance/pnl', component: Pnl },
    { path: '/m/finance/business-model', component: BusinessModel },
    { path: '/m/finance/ledger', component: () => <ProfitDashboard /> },
    { path: '/m/finance/erp', component: Erp },
  ],
  widgets: [{ slot: 'dashboard', id: 'finance-month', title: 'Thu chi tháng này', component: MonthWidget, order: 30 }],
  agentAccess: [
    { scope: 'finance.read', label: 'Đọc tóm tắt P&L và sổ thu chi' },
    { scope: 'finance.write', label: 'Ghi khoản thu chi vào sổ' },
  ],
});
