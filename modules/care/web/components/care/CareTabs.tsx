import { Link } from 'wouter-preact';
import { ct } from '@modules/care/web/lib/care/i18n';
import { cc } from '@modules/care/web/lib/care-channels/i18n';

export type CareTabId = 'inbox' | 'drafts' | 'customers' | 'tasks' | 'channels' | 'rules' | 'activity';
const TABS: Array<{ id: CareTabId; href: string; label: () => string }> = [
  { id: 'inbox', href: '/m/care/inbox', label: () => cc('tabs.inbox') },
  { id: 'drafts', href: '/m/care/drafts', label: () => cc('tabs.drafts') },
  { id: 'customers', href: '/m/care/customers', label: () => cc('tabs.customers') },
  { id: 'tasks', href: '/m/care/followups', label: () => cc('tabs.tasks') },
  { id: 'channels', href: '/m/care/channels', label: () => cc('tabs.channels') },
  { id: 'rules', href: '/m/care/rules', label: () => 'Quy tắc' },
  { id: 'activity', href: '/m/care/activity', label: () => cc('tabs.activity') },
];

/** Navigation between the Care screens: Hộp thư · Nháp · Khách hàng · Việc chăm sóc · Kênh & agent · Quy tắc · Nhật ký. */
export function CareTabs({ current }: { current: CareTabId }) {
  return (
    <nav class="care-navtabs" aria-label={ct('nav.label')}>
      {TABS.map((t) => (
        <Link key={t.id} href={t.href} class={`care-navtab${t.id === current ? ' is-on' : ''}`} aria-current={t.id === current ? 'page' : undefined} data-testid={`care-nav-${t.id}`}>
          {t.label()}
        </Link>
      ))}
    </nav>
  );
}
