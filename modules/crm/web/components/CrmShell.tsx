import { FolderOpen } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { Link } from 'wouter-preact';
import type { CrmStatus } from '../lib/types';

export const PATH_STAGES = '/m/crm/stages';
export const PATH_ALL = '/m/crm/all';
export const pathOfCustomer = (id: string) => `/m/crm/customer/${encodeURIComponent(id)}`;

/** The screens read the database; this only says why no note exists yet. */
export function NotConfiguredBanner({ status }: { status: CrmStatus | null }) {
  if (!status || status.state !== 'chua-cau-hinh') return null;
  return (
    <div role="status" data-testid="crm-not-configured" class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] border border-[var(--color-warning)]/40 bg-[rgba(240,178,74,0.10)] px-3 py-2.5 text-[13px]">
      <FolderOpen size={15} class="shrink-0 text-[var(--color-warning)]" aria-hidden="true" />
      <span class="min-w-0 flex-1">
        <strong class="font-semibold">Chưa chọn thư mục Second Brain cho ghi chú khách.</strong>{' '}
        <span class="text-[var(--color-text-muted)]">Các màn hình vẫn đọc từ dữ liệu trong máy; chỉ chưa có file ghi chú nào để mở trong Obsidian.</span>
      </span>
      <Link href="/modules" class="font-semibold">Chọn thư mục trong Module CRM</Link>
    </div>
  );
}

const TAB = 'inline-flex min-h-[36px] items-center rounded-[7px] px-3 text-[13px] font-semibold';

export function CrmShell(props: {
  current: 'stages' | 'all' | 'customer';
  status: CrmStatus | null;
  search?: string;
  onSearch?: (v: string) => void;
  children: ComponentChildren;
}) {
  const { current, status, search, onSearch, children } = props;
  return (
    <div class="flex min-h-full flex-col" data-testid={`crm-${current}`}>
      {current !== 'customer' && <header class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--color-border)] px-4 py-3 md:px-6">
        <h1 class="m-0 text-[20px] font-bold">Khách hàng</h1>
        <nav aria-label="Cách xem khách hàng" class="flex gap-1 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)] p-1">
          <Link href={PATH_STAGES} aria-current={current === 'stages' ? 'page' : undefined} class={`${TAB} ${current === 'stages' ? '!bg-[var(--color-accent)] !text-[var(--color-on-accent)]' : '!text-[var(--color-control-text)]'}`}>Giai đoạn</Link>
          <Link href={PATH_ALL} aria-current={current === 'all' ? 'page' : undefined} class={`${TAB} ${current === 'all' ? '!bg-[var(--color-accent)] !text-[var(--color-on-accent)]' : '!text-[var(--color-control-text)]'}`}>Tất cả khách</Link>
        </nav>
        {onSearch && (
          <input
            type="search"
            class="field ml-auto !h-10 min-w-0 flex-[0_1_260px]"
            aria-label="Tìm khách"
            placeholder="Tên, số điện thoại, thẻ"
            value={search ?? ''}
            onInput={(e) => onSearch((e.target as HTMLInputElement).value)}
            data-testid="crm-search"
          />
        )}
      </header>}
      <NotConfiguredBanner status={status} />
      {children}
    </div>
  );
}
