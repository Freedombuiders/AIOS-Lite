import type { ComponentChildren } from 'preact';

export interface PageHeaderProps {
  title: string;
  breadcrumb?: string;
  actions?: ComponentChildren;
  tabs?: ComponentChildren;
  compact?: boolean;
}

export function PageHeader({ title, breadcrumb, actions, tabs, compact }: PageHeaderProps) {
  return (
    <header class={compact ? 'mb-3' : 'mb-4'}>
      {breadcrumb && <div class="hint mb-0.5">{breadcrumb}</div>}
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h1 class={`m-0 font-semibold ${compact ? 'text-[15px]' : 'text-[18px]'}`}>{title}</h1>
        {actions && <div class="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {tabs && <div class="mt-3 flex flex-wrap gap-1 border-b border-[var(--color-border)]">{tabs}</div>}
    </header>
  );
}

export type TabProps = { label: string; active?: boolean; count?: number; onClick?: () => void };

const TAB_BASE = '-mb-px cursor-pointer border-0 border-b-2 bg-transparent px-3 py-1.5 text-[12px]';
const TAB_ON = 'border-[var(--color-accent)] font-medium text-[var(--color-text)]';
const TAB_OFF = 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]';

export function Tab(props: TabProps) {
  const { label, active = false, count, onClick } = props;
  const suffix = count === undefined ? null : <span class="ml-1.5 text-[var(--color-text-faint)]">{count}</span>;
  return (
    <button type="button" class={`${TAB_BASE} ${active ? TAB_ON : TAB_OFF}`} onClick={onClick}>
      {label}
      {suffix}
    </button>
  );
}
