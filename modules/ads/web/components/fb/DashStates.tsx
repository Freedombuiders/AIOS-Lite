export const BTN = 'min-h-11 px-3 rounded border border-[var(--color-border)] disabled:opacity-50';
export const BTN_PRIMARY = BTN + ' bg-[var(--color-accent-soft)]';
export const SELECT = 'min-h-11 rounded border border-[var(--color-border)] bg-[var(--color-card)] px-2';
export const LINK_CLASS = 'underline text-[var(--color-accent)]';
export function DashLoading({ label = 'Đang tải số liệu…' }: { label?: string }) { return <p role="status" class="p-4">{label}</p>; }
export function DashError({ error, onRetry }: { error: string; onRetry?: () => void }) { return <div role="alert" class="p-4"><p>{error}</p><button class={BTN} onClick={onRetry}>Thử lại</button></div>; }
