import { Link } from 'wouter-preact';
import { ArrowRight, BookOpen, FolderOpen, Plus, RefreshCw, Settings2 } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { useFetch } from '@/lib/useFetch';
import type { BrainFolderView } from '@/lib/api-types';

interface Vault {
  id: string;
  name: string;
  path: string;
}

interface VaultList { enabled: boolean; vaults: Vault[]; }

export default function SecondBrains() {
  const { data, loading, error, refresh } = useFetch<{ items: BrainFolderView[] }>('/brain/folders', 30_000);
  const list: VaultList | null = data ? { enabled: data.items.some((f) => f.exists), vaults: data.items.filter((f) => f.exists).map((f) => ({ id: f.id, name: f.name, path: f.path })) } : null;
  const vaults = list?.vaults ?? [];

  return (
    <div class="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Second Brains"
        actions={<Link href="/brain/search" class="control-button inline-flex min-h-10 items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 text-[13px]"><Settings2 size={16} aria-hidden="true" />Quản lý kho tri thức</Link>}
      />
      <div class="flex-1 overflow-y-auto px-4 py-6 sm:px-7 sm:py-8">
        <div class="mx-auto max-w-5xl">
          <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 class="text-xl font-semibold text-[var(--color-text)]">Kho tri thức của bạn</h2>
              <p class="mt-1 text-sm text-[var(--color-text-muted)]">Mở một Second Brain để xem thư mục, đọc và chỉnh sửa ghi chú.</p>
            </div>
            <button type="button" onClick={refresh} disabled={loading} aria-label="Làm mới danh sách Second Brains" class="control-button inline-flex min-h-10 items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 text-[13px] disabled:opacity-50"><RefreshCw size={15} aria-hidden="true" class={loading ? 'animate-spin' : ''} />Làm mới</button>
          </div>

          {error && <PageState error={error} />}
          {loading && !data && <PageState loading />}

          {list && !list.enabled && (
            <section class="mb-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-5 sm:p-6">
              <BookOpen size={25} class="text-[var(--color-accent)]" aria-hidden="true" />
              <h3 class="mt-3 text-lg font-semibold text-[var(--color-text)]">Bật Second Brains để dùng kho tri thức</h3>
              <p class="mt-1 text-sm text-[var(--color-text-muted)]">Chọn thư mục ghi chú trên máy để bắt đầu.</p>
              <Link href="/brain/search" class="control-button control-accent mt-4 inline-flex min-h-10 items-center gap-2 rounded-lg border px-4 text-[13px]">Thiết lập Second Brains <ArrowRight size={15} aria-hidden="true" /></Link>
            </section>
          )}

          {list && vaults.length === 0 && list.enabled && (
            <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-6 text-center">
              <FolderOpen size={30} class="mx-auto text-[var(--color-accent)]" aria-hidden="true" />
              <h3 class="mt-3 text-lg font-semibold text-[var(--color-text)]">Chưa có Second Brain nào</h3>
              <p class="mt-1 text-sm text-[var(--color-text-muted)]">Thêm một thư mục ghi chú để quản lý tại đây.</p>
              <Link href="/brain/search" class="control-button control-accent mt-4 inline-flex min-h-10 items-center gap-2 rounded-lg border px-4 text-[13px]"><Plus size={15} aria-hidden="true" />Thêm Second Brain</Link>
            </section>
          )}

          {list?.enabled && vaults.length > 0 && (
            <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Danh sách Second Brains">
              {vaults.map(vault => (
                <Link
                  key={vault.id}
                  href={`/brain?vault=${encodeURIComponent(vault.id)}`}
                  class="group flex min-h-44 flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-5 transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-control-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
                  aria-label={`Mở Second Brain ${vault.name}`}
                >
                  <div class="flex items-start justify-between gap-3">
                    <span class="flex size-11 items-center justify-center rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-accent)]"><BookOpen size={22} aria-hidden="true" /></span>
                    <ArrowRight size={17} class="text-[var(--color-text-muted)] transition-transform group-hover:translate-x-1" aria-hidden="true" />
                  </div>
                  <h3 class="mt-5 break-words text-base font-semibold text-[var(--color-text)]">{vault.name}</h3>
                  <span class="mt-1 text-sm text-[var(--color-text-muted)]">Xem thư mục và ghi chú</span>
                </Link>
              ))}
              <Link href="/brain/search" class="flex min-h-44 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--color-border)] p-5 text-center text-sm text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"><Plus size={22} aria-hidden="true" /><span>Thêm Second Brain</span></Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
