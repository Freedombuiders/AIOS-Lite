import { Banknote, BookOpen, Network, ServerCog } from 'lucide-preact';
import { defineWebModule } from '@/module-host/contracts';
import './styles/pnl.css';
import { Pnl } from './pages/Pnl';
import { BusinessModel } from './pages/BusinessModel';
import { ProfitDashboard } from './pages/ProfitDashboard';
import { Erp } from './pages/Erp';
import { OverviewWidget } from './components/OverviewWidget';

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
  widgets: [{ slot: 'overview', id: 'finance-overview', title: 'Doanh thu & chi phí', subtitle: 'ERP · Whop · Pancake · Meta Ads · AI', href: '/m/finance/pnl', component: OverviewWidget, order: 10 }],
  agentAccess: [
    { scope: 'finance.read', label: 'Đọc tóm tắt P&L và sổ thu chi' },
    { scope: 'finance.write', label: 'Ghi khoản thu chi vào sổ' },
  ],
});
