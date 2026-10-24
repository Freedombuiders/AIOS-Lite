import { Cable, Inbox, ListChecks, PencilLine, ScrollText, SlidersHorizontal, Users } from 'lucide-preact';
import { apiGet } from '@/lib/api';
import { useFetch } from '@/lib/useFetch';
import { defineWebModule, type WebNavItem } from '@/module-host/contracts';
import { CareActivity } from './pages/care/CareActivity';
import { CareChannels } from './pages/care/CareChannels';
import { CareCustomers } from './pages/care/CareCustomers';
import { CareDrafts } from './pages/care/CareDrafts';
import { CareInbox } from './pages/care/CareInbox';
import { CareRules } from './pages/care/CareRules';
import { CareTasks } from './pages/care/CareTasks';
import { CARE_API_BASE } from './lib/care/client';
import { INBOX_BADGE_PATH, meCountFrom } from './lib/care-channels/badge-view';

// lucide's icon props accept string sizes, the host contract only numbers: cast once per icon
const asIcon = (c: unknown) => c as WebNavItem['icon'];

interface StatusLite { conversations?: { waiting?: number } }

/** Dashboard tile: how many customers wait for an answer (GET /status). */
function WaitingWidget() {
  const { data } = useFetch<StatusLite>(`${CARE_API_BASE}/status`, 30_000);
  return (
    <div class="text-sm" data-testid="care-waiting-widget">
      <div class="text-2xl font-semibold tabular-nums">{data?.conversations?.waiting ?? 0}</div>
      <div class="text-[var(--color-text-muted)]">khách đang chờ trả lời</div>
    </div>
  );
}

/** Dashboard tile: how many AI drafts wait for a human to approve (GET /drafts?status=draft). */
function DraftsWidget() {
  const { data } = useFetch<{ items: unknown[] }>(`${CARE_API_BASE}/drafts?status=draft&limit=200`, 30_000);
  return (
    <div class="text-sm" data-testid="care-drafts-widget">
      <div class="text-2xl font-semibold tabular-nums">{data?.items?.length ?? 0}</div>
      <div class="text-[var(--color-text-muted)]">nháp chờ duyệt</div>
    </div>
  );
}

export default defineWebModule({
  id: 'care',
  nav: [
    {
      group: 'sales', label: 'Hộp thư', path: '/m/care/inbox', icon: asIcon(Inbox), order: 10,
      badge: async () => meCountFrom(await apiGet(INBOX_BADGE_PATH)) || undefined,
    },
    { group: 'sales', label: 'Nháp chờ duyệt', path: '/m/care/drafts', icon: asIcon(PencilLine), order: 11 },
    { group: 'sales', label: 'Khách hàng', path: '/m/care/customers', icon: asIcon(Users), order: 12 },
    { group: 'sales', label: 'Việc chăm sóc', path: '/m/care/followups', icon: asIcon(ListChecks), order: 13 },
    { group: 'sales', label: 'Kênh & agent', path: '/m/care/channels', icon: asIcon(Cable), order: 14 },
    { group: 'sales', label: 'Quy tắc', path: '/m/care/rules', icon: asIcon(SlidersHorizontal), order: 15 },
    { group: 'sales', label: 'Nhật ký CSKH', path: '/m/care/activity', icon: asIcon(ScrollText), order: 16 },
  ],
  routes: [
    { path: '/m/care', component: CareInbox },
    { path: '/m/care/inbox', component: CareInbox },
    { path: '/m/care/inbox/:id', component: CareInbox },
    { path: '/m/care/drafts', component: CareDrafts },
    { path: '/m/care/customers', component: CareCustomers },
    { path: '/m/care/followups', component: CareTasks },
    { path: '/m/care/channels', component: CareChannels },
    { path: '/m/care/rules', component: CareRules },
    { path: '/m/care/activity', component: CareActivity },
  ],
  widgets: [
    { slot: 'dashboard', id: 'care-waiting', title: 'Khách đang chờ', component: WaitingWidget },
    { slot: 'dashboard', id: 'care-drafts', title: 'Nháp chờ duyệt', component: DraftsWidget },
  ],
  agentAccess: [
    { scope: 'inbox.read', label: 'Đọc hộp thư', description: 'Agent được xem hội thoại và tin nhắn của khách.' },
    { scope: 'customers.read', label: 'Xem khách hàng', description: 'Agent được đọc hồ sơ và lịch sử khách hàng.' },
    { scope: 'customers.write', label: 'Sửa khách hàng', description: 'Agent được cập nhật hồ sơ, giai đoạn và việc chăm sóc.' },
    { scope: 'reply.draft', label: 'Soạn nháp trả lời', description: 'Agent được soạn nháp để người duyệt trước khi gửi.' },
    { scope: 'reply.send', label: 'Tự gửi trả lời', description: 'Agent được gửi tin cho khách mà không cần duyệt.' },
  ],
});
