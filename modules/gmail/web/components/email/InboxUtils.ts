// Small helpers shared by the Email › Hộp thư page and its components.

export const BTN = 'toolbar-control control-button inline-flex items-center gap-1.5 px-3 rounded-md text-[12px] text-[var(--color-text)] hover:bg-[var(--color-control-hover)] disabled:opacity-40';
export const SELECT = 'px-2 py-1.5 rounded bg-[var(--color-bg)] border border-[var(--color-border)] text-[12px] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]';
export const TEXTAREA = 'w-full resize-y px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none text-[13px] text-[var(--color-text)] disabled:opacity-50';

export function errMsg(err: unknown): string {
  const body = (err as { body?: { error?: string } })?.body;
  return body?.error || (err instanceof Error ? err.message : String(err));
}

/** pausedUntil is stored in seconds; tolerate ms in case a caller sends them. */
export function toMs(value: number): number {
  return value > 1e12 ? value : value * 1000;
}

/** Vietnamese relative time for a millisecond timestamp. */
export function relTime(ms: number): string {
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return 'vừa xong';
  if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} ngày trước`;
  return new Date(ms).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function fullTime(ms: number): string {
  return new Date(ms).toLocaleString('vi-VN', {
    weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function initialThreadId(search: string): number | null {
  const v = Number(new URLSearchParams(search).get('thread'));
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function rememberThread(id: number | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('thread', String(id));
  else url.searchParams.delete('thread');
  window.history.replaceState(window.history.state, '', url.toString());
}
