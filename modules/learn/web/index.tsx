import { FlaskConical } from 'lucide-preact';
import { defineWebModule, type WebNavItem } from '@/module-host/contracts';
import { ContentLab } from '@modules/learn/web/pages/ContentLab';
import { ContentNote } from '@modules/learn/web/pages/ContentNote';

// lucide's icon props accept string sizes, the host contract only numbers: cast once here
const icon = FlaskConical as unknown as WebNavItem['icon'];

export default defineWebModule({
  id: 'learn',
  nav: [{ group: 'marketing', label: 'Phân tích nội dung', path: '/m/learn', icon, order: 45, match: ['/m/learn/posts'] }],
  routes: [
    { path: '/m/learn', component: ContentLab },
    { path: '/m/learn/posts/:path', component: ContentNote },
  ],
});
