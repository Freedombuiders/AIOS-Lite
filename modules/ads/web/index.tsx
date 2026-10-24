import { ChartNoAxesCombined } from 'lucide-preact';
import { defineWebModule } from '@/module-host/contracts';
import { FbAds } from './pages/fb/FbAds';
export default defineWebModule({
  id: 'ads',
  nav: [{ group: 'marketing', label: 'Quảng cáo Meta', path: '/m/ads', icon: ChartNoAxesCombined }],
  routes: [{ path: '/m/ads', component: FbAds }],
  agentAccess: [{ scope: 'reports.read', label: 'Đọc báo cáo quảng cáo' }],
});
