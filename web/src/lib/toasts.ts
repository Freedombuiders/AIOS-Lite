import { signal } from '@preact/signals';

export type ToastTone = 'success' | 'error' | 'warn' | 'info' | 'neutral';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
  /** ms before auto-dismiss; 0 keeps it until closed */
  ttlMs?: number;
  /** optional button, e.g. "Hoàn tác"; the toast closes after it runs */
  action?: { label: string; onClick: () => void | Promise<void> };
}

export const toasts = signal<Toast[]>([]);
let nextId = 1;

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

export function pushToast(t: Omit<Toast, 'id'>): number {
  const id = nextId++;
  toasts.value = [...toasts.value.slice(-4), { ...t, id }];
  const ttl = t.ttlMs ?? (t.tone === 'error' ? 7000 : 4000);
  if (ttl > 0) setTimeout(() => dismissToast(id), ttl);
  return id;
}
