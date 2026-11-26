import { dayDistance, vnDate, vnTime } from '@modules/care/web/lib/care-channels/tasks';

export type DueTone = 'late' | 'today' | 'soon' | 'none';

/** "Quá hạn 24/11" / "Hôm nay" / "28/11"; `none` when there is no follow-up. Days are Asia/Ho_Chi_Minh days. */
export function dueChip(dueAtMs: number | null | undefined, nowMs: number): { text: string; tone: DueTone } {
  if (!dueAtMs) return { text: 'Chưa có việc', tone: 'none' };
  const d = dayDistance(dueAtMs, nowMs);
  if (d < 0) return { text: `Quá hạn ${vnDate(dueAtMs)}`, tone: 'late' };
  if (d === 0) return { text: 'Hôm nay', tone: 'today' };
  if (d === 1) return { text: 'Ngày mai', tone: 'soon' };
  return { text: vnDate(dueAtMs), tone: 'soon' };
}

export const DUE_CHIP_CLASS: Record<DueTone, string> = {
  late: 'bg-[rgba(240,178,74,0.16)] text-[var(--color-warning)]',
  today: 'bg-[rgba(240,178,74,0.16)] text-[var(--color-warning)]',
  soon: 'bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]',
  none: 'bg-[rgba(255,255,255,0.07)] text-[var(--color-control-text)]',
};

/** dd/MM/yyyy in Vietnam time */
export function vnFullDate(ms: number): string {
  return `${vnDate(ms)}/${new Date(ms + 7 * 3_600_000).toISOString().slice(0, 4)}`;
}

export { vnDate, vnTime };

export const initial = (name: string) => (name.trim().match(/\p{L}/u)?.[0] ?? '?').toUpperCase();
