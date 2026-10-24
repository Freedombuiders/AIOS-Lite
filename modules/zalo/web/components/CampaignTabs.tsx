import { Link } from 'wouter-preact';

export type CampaignTab = 'templates' | 'group' | 'list' | 'birthday';

const TABS: Array<{ id: CampaignTab; label: string; href: string }> = [
  { id: 'templates', label: 'Mẫu tin', href: '/m/zalo/templates' },
  { id: 'group', label: 'Gửi nhóm', href: '/m/zalo/group-broadcasts' },
  { id: 'list', label: 'Gửi 1-1', href: '/m/zalo/list-broadcasts' },
  { id: 'birthday', label: 'Sinh nhật', href: '/m/zalo/birthday' },
];

// Sub-navigation between the four Zalo marketing pages.
export function CampaignTabs({ current }: { current: CampaignTab }) {
  return (
    <nav class="mx-6 mt-1 mb-2 flex flex-wrap gap-1 border-b border-[var(--color-border)]" aria-label="Chiến dịch Zalo">
      {TABS.map((t) => (
        <Link
          key={t.id}
          href={t.href}
          class={`-mb-px border-b-2 px-3 py-1.5 text-[12px] ${
            t.id === current
              ? 'border-[var(--color-accent)] font-medium text-[var(--color-text)]'
              : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
