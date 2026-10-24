import { Inbox, Loader2, TriangleAlert } from 'lucide-preact';
import type { ComponentChildren } from 'preact';

export interface PageStateProps {
  loading?: boolean;
  error?: string | null;
  empty?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  /** next-step action shown under an empty state */
  action?: ComponentChildren;
}

/** Renders nothing when there is nothing to show (loading, error and empty are all false). */
export function PageState({ loading, error, empty, emptyTitle = 'Chưa có gì ở đây', emptyDescription, action }: PageStateProps) {
  if (loading) {
    return (
      <div class="flex items-center justify-center gap-2 py-10 text-[var(--color-text-muted)]">
        <Loader2 size={15} class="animate-spin" /> Đang tải…
      </div>
    );
  }
  if (error) {
    return (
      <div class="card card-pad flex items-start gap-2 border-[var(--color-status-failed)]/40 text-[var(--color-status-failed)]">
        <TriangleAlert size={15} class="mt-0.5 shrink-0" />
        <div>
          <div class="font-medium">Không tải được dữ liệu</div>
          <div class="text-[12px] opacity-90">{error}</div>
        </div>
      </div>
    );
  }
  if (empty) {
    return (
      <div class="flex flex-col items-center gap-1 py-10 text-center">
        <Inbox size={22} class="text-[var(--color-text-faint)]" />
        <div class="font-medium">{emptyTitle}</div>
        {emptyDescription && <div class="hint max-w-md">{emptyDescription}</div>}
        {action && <div class="mt-2">{action}</div>}
      </div>
    );
  }
  return null;
}
