import { Sparkles } from 'lucide-preact';
import { defineWebModule, type WebNavItem } from '@/module-host/contracts';
import { KolHome } from '@modules/kol/web/pages/KolHome';
import { KolWorkspace } from '@modules/kol/web/pages/KolWorkspace';

// lucide's icon props accept string sizes, the host contract only numbers: cast once here
const icon = (c: unknown) => c as WebNavItem['icon'];

export default defineWebModule({
  id: 'kol',
  nav: [{ group: 'studio', label: 'KOL Studio', path: '/m/kol', icon: icon(Sparkles), match: ['/m/kol/'], order: 10 }],
  routes: [
    { path: '/m/kol', component: KolHome },
    { path: '/m/kol/:id', component: KolWorkspace },
  ],
  agentAccess: [
    { scope: 'kol.read', label: 'Đọc KOL Studio', description: 'Agent được đọc hồ sơ KOL, thư viện, bài đăng và số liệu tăng trưởng.' },
    { scope: 'content.write', label: 'Soạn bài đăng', description: 'Agent được soạn bài nháp cho KOL, chờ chủ duyệt, không được đăng.' },
    { scope: 'media.generate', label: 'Tạo ảnh/video', description: 'Agent được yêu cầu tạo ảnh/video cho KOL (tốn tiền, trong hạn mức).' },
  ],
});
