import { FlaskConical, RefreshCcw } from 'lucide-preact';
import { defineWebModule, type WebNavItem } from '@/module-host/contracts';
import { ScoreBox } from '@modules/learn/web/components/ScoreBox';
import { ContentLab } from '@modules/learn/web/pages/ContentLab';
import { ContentNote } from '@modules/learn/web/pages/ContentNote';
import { LoopOverview } from '@modules/learn/web/pages/LoopOverview';
import { Pending } from '@modules/learn/web/pages/Pending';
import { Playbook } from '@modules/learn/web/pages/Playbook';
import { Weekly } from '@modules/learn/web/pages/Weekly';

// lucide's icon props accept string sizes, the host contract only numbers: cast once here
const icon = (c: unknown) => c as WebNavItem['icon'];

export default defineWebModule({
  id: 'learn',
  nav: [
    { group: 'marketing', label: 'Phân tích nội dung', path: '/m/learn', icon: icon(FlaskConical), order: 45, match: ['/m/learn/posts'] },
    { group: 'marketing', label: 'Vòng học', path: '/m/learn/loop', icon: icon(RefreshCcw), order: 46, match: ['/m/learn/playbook', '/m/learn/pending', '/m/learn/weekly'] },
  ],
  routes: [
    { path: '/m/learn', component: ContentLab },
    { path: '/m/learn/posts/:path', component: ContentNote },
    { path: '/m/learn/loop', component: LoopOverview },
    { path: '/m/learn/playbook', component: Playbook },
    { path: '/m/learn/pending', component: Pending },
    { path: '/m/learn/weekly', component: Weekly },
    { path: '/m/learn/weekly/:year/:week', component: Weekly },
  ],
  agentAccess: [
    { scope: 'playbook.read', label: 'Đọc sổ bài học', description: 'Agent nhận các bài học bạn đã duyệt có tên nó trong dung_boi, trước mỗi lượt viết hay trả lời.' },
    { scope: 'learn.propose', label: 'Đề xuất bài học', description: 'Agent ghi được giả thuyết mới vào sổ, chờ bạn xem. Không đổi được trạng thái bài học nào.' },
  ],
  provides: {
    /** rendered by marketing's composer: Khớp sổ bài học x/y */
    'marketing.composerScore': ScoreBox,
  },
});
