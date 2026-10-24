import { CalendarClock, FileText, Flag, LineChart, MessageSquareReply, SlidersHorizontal } from 'lucide-preact';
import { Link } from 'wouter-preact';
import { useFetch } from '@/lib/useFetch';
import { defineWebModule, type WebNavItem } from '@/module-host/contracts';
import { Analytics } from '@modules/marketing/web/pages/Analytics';
import { FbCalendar } from '@modules/marketing/web/pages/fb/FbCalendar';
import { FbCommentRules } from '@modules/marketing/web/pages/fb/FbCommentRules';
import { FbComments } from '@modules/marketing/web/pages/fb/FbComments';
import { FbLibrary } from '@modules/marketing/web/pages/fb/FbLibrary';
import { ContentOverview } from '@modules/marketing/web/components/ContentOverview';
import { FbPages } from '@modules/marketing/web/pages/fb/FbPages';
import type { FbContentListDto } from '@modules/marketing/web/lib/fbstudio';

// lucide's icon props accept string sizes, the host contract only numbers: cast once here
const icon = (c: unknown) => c as WebNavItem['icon'];

function formatWhen(sec: number): string {
  return new Date(sec * 1000).toLocaleString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Dashboard widget: the next posts the publisher will send. */
function ScheduledWidget() {
  const { data, error } = useFetch<FbContentListDto>('/api/m/marketing/content?status=scheduled&limit=4', 60_000);
  const items = (data?.items ?? []).filter((c) => c.scheduledAt !== null).sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0));
  if (error) return <div class="text-sm text-[var(--color-text-muted)]">Chưa đọc được lịch đăng.</div>;
  if (!data) return <div class="text-sm text-[var(--color-text-muted)]">Đang tải…</div>;
  if (items.length === 0) return <div class="text-sm text-[var(--color-text-muted)]">Chưa có bài nào hẹn giờ. <Link href="/m/marketing/library" class="underline">Mở Kho nội dung</Link></div>;
  return (
    <ul class="m-0 p-0 list-none flex flex-col gap-1.5">
      {items.map((c) => (
        <li key={c.id} class="flex items-baseline gap-2 text-[13px] min-w-0">
          <span class="shrink-0 text-[11.5px] text-[var(--color-text-muted)]">{formatWhen(c.scheduledAt as number)}</span>
          <span class="truncate min-w-0">{c.title || c.caption.slice(0, 60) || '(chưa có tiêu đề)'}</span>
          {c.pageName && <span class="shrink-0 text-[11.5px] text-[var(--color-text-faint)]">{c.pageName}</span>}
        </li>
      ))}
    </ul>
  );
}

export default defineWebModule({
  id: 'marketing',
  nav: [
    { group: 'marketing', label: 'Pages', path: '/m/marketing', icon: icon(Flag), order: 10 },
    { group: 'marketing', label: 'Kho nội dung', path: '/m/marketing/library', icon: icon(FileText), order: 20 },
    { group: 'marketing', label: 'Lịch đăng', path: '/m/marketing/calendar', icon: icon(CalendarClock), order: 30 },
    { group: 'marketing', label: 'Phân tích', path: '/m/marketing/analytics', icon: icon(LineChart), order: 40 },
    { group: 'marketing', label: 'Bình luận AI', path: '/m/marketing/comments', icon: icon(MessageSquareReply), order: 50 },
    { group: 'marketing', label: 'Quy tắc bình luận', path: '/m/marketing/comment-rules', icon: icon(SlidersHorizontal), order: 60 },
  ],
  routes: [
    { path: '/m/marketing', component: FbPages },
    { path: '/m/marketing/library', component: FbLibrary },
    { path: '/m/marketing/calendar', component: FbCalendar },
    { path: '/m/marketing/analytics', component: Analytics },
    { path: '/m/marketing/comments', component: FbComments },
    { path: '/m/marketing/comment-rules', component: FbCommentRules },
  ],
  widgets: [
    { slot: 'overview', id: 'marketing-overview', title: 'Hiệu quả nội dung', subtitle: 'Facebook Pages', href: '/m/marketing/analytics', component: ContentOverview, order: 20 },
    { slot: 'dashboard', id: 'marketing-scheduled', title: 'Bài sắp đăng', component: ScheduledWidget, order: 40 },
  ],
  agentAccess: [
    { scope: 'content.write', label: 'Soạn nội dung', description: 'Agent được tạo và sửa bài trong Kho nội dung, không được đăng.' },
    { scope: 'publish', label: 'Duyệt và đăng bài', description: 'Agent được duyệt và đăng bài lên Fanpage.' },
    { scope: 'comments.reply', label: 'Trả lời bình luận', description: 'Agent được trả lời công khai bình luận trên Fanpage.' },
    { scope: 'analytics.read', label: 'Đọc số liệu', description: 'Agent được đọc số liệu phân tích Fanpage.' },
  ],
});
