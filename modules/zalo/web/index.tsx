import { Cake, FileText, MessageCircle, Send, UsersRound } from 'lucide-preact';
import { apiGet } from '@/lib/api';
import { defineWebModule, type WebNavItem } from '@/module-host/contracts';
import { ZaloChannelPanel } from './components/ZaloChannelPanel';
import { MarketingBirthday } from './pages/MarketingBirthday';
import { MarketingGroupBroadcasts } from './pages/MarketingGroupBroadcasts';
import { MarketingListBroadcasts } from './pages/MarketingListBroadcasts';
import { MarketingTemplates } from './pages/MarketingTemplates';
import { ZaloAccounts } from './pages/ZaloAccounts';

// lucide's icon props accept string sizes, the host contract only numbers: cast once here
const icon = (c: unknown) => c as unknown as WebNavItem['icon'];

export default defineWebModule({
  id: 'zalo',
  nav: [
    {
      group: 'sales',
      label: 'Zalo · Tài khoản',
      path: '/m/zalo',
      icon: icon(MessageCircle),
      // nicks that need attention: locked sending or lost session
      badge: async () => {
        const { accounts } = await apiGet<{ accounts: Array<{ status: string; sendLockReason: string }> }>('/api/m/zalo/accounts');
        const n = accounts.filter((a) => a.sendLockReason || a.status === 'session_expired').length;
        return n > 0 ? n : undefined;
      },
    },
    { group: 'marketing', label: 'Mẫu tin Zalo', path: '/m/zalo/templates', icon: icon(FileText), order: 10 },
    { group: 'marketing', label: 'Gửi nhóm', path: '/m/zalo/group-broadcasts', icon: icon(UsersRound), order: 11 },
    { group: 'marketing', label: 'Gửi 1-1', path: '/m/zalo/list-broadcasts', icon: icon(Send), order: 12 },
    { group: 'marketing', label: 'Sinh nhật', path: '/m/zalo/birthday', icon: icon(Cake), order: 13 },
  ],
  routes: [
    { path: '/m/zalo', component: ZaloAccounts },
    { path: '/m/zalo/templates', component: MarketingTemplates },
    { path: '/m/zalo/group-broadcasts', component: MarketingGroupBroadcasts },
    { path: '/m/zalo/list-broadcasts', component: MarketingListBroadcasts },
    { path: '/m/zalo/birthday', component: MarketingBirthday },
  ],
  // The care module renders this inside the card of every channel account (it returns null unless channel === 'zalo').
  provides: { 'care.channelPanel': ZaloChannelPanel },
  agentAccess: [
    { scope: 'messages.read', label: 'Đọc tin nhắn Zalo', description: 'Agent được xem hội thoại và ảnh khách gửi trên Zalo.' },
    { scope: 'broadcast.manage', label: 'Quản lý chiến dịch Zalo', description: 'Agent được tạo mẫu tin và chiến dịch gửi tin hàng loạt.' },
  ],
});
