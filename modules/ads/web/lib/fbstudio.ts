export type * from '../../../_lib/fb-types.js';
import type { FbFormat, FbContentStatus, AdsDashboardDto as SharedAdsDashboardDto } from '../../../_lib/fb-types.js';
export type AdsDashboardDto = SharedAdsDashboardDto & { organicAvailable?: boolean };

export const FORMAT_META: Record<FbFormat, { label: string; color: string }> = {
  reel: { label: 'Reel', color: '#3987e5' },
  video: { label: 'Video dài', color: '#d95926' },
  photo: { label: 'Ảnh', color: '#199e70' },
  album: { label: 'Album', color: '#c98500' },
  text: { label: 'Chữ', color: '#d55181' },
  link: { label: 'Link', color: '#008300' },
};

export const STATUS_META: Record<FbContentStatus, { label: string; bg: string; fg: string }> = {
  idea: { label: 'Ý tưởng', bg: 'var(--color-elevated)', fg: 'var(--color-text-muted)' },
  draft: { label: 'Bản nháp', bg: 'rgba(251, 191, 36, 0.14)', fg: '#fcd34d' },
  review: { label: 'Chờ duyệt', bg: 'var(--color-accent-soft)', fg: 'var(--color-accent-hover)' },
  approved: { label: 'Đã duyệt', bg: 'rgba(124, 196, 255, 0.10)', fg: '#a9d8ff' },
  scheduled: { label: 'Đã lên lịch', bg: 'rgba(124, 196, 255, 0.14)', fg: '#a9d8ff' },
  publishing: { label: 'Đang đăng', bg: 'rgba(124, 196, 255, 0.14)', fg: '#a9d8ff' },
  published: { label: 'Đã đăng', bg: 'rgba(74, 222, 128, 0.14)', fg: '#86efac' },
  failed: { label: 'Lỗi', bg: 'rgba(248, 113, 113, 0.14)', fg: '#fca5a5' },
  missed: { label: 'Lỡ giờ', bg: 'rgba(248, 113, 113, 0.14)', fg: '#fca5a5' },
  deleted: { label: 'Đã xóa', bg: 'var(--color-elevated)', fg: 'var(--color-text-faint)' },
};

/** Vietnamese number formatting: 1.284 · 4,3 · 18,2 N · 45,3 tr. */
export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return Math.round(n).toLocaleString('vi-VN');
}

export function fmtDec(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return n.toFixed(digits).replace('.', ',');
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '–' : `${fmtDec(n, digits)}%`;
}

/** Compact count: 312 N for thousands, 1,2 tr for millions. */
export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${fmtDec(n / 1_000_000, a >= 10_000_000 ? 0 : 1)} tr`;
  if (a >= 100_000) return `${Math.round(n / 1000)} N`;
  if (a >= 1000) return `${fmtDec(n / 1000, 1)} N`;
  return fmtInt(n);
}

/** Money in the account currency, compact for VND (45,3 tr ₫ / 110k ₫). */
export function fmtMoney(n: number | null | undefined, currency = 'VND'): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  if (currency === 'VND') {
    if (Math.abs(n) >= 1_000_000) return `${fmtDec(n / 1_000_000, 1)} tr ₫`;
    if (Math.abs(n) >= 1000) return `${Math.round(n / 1000)}k ₫`;
    return `${fmtInt(n)} ₫`;
  }
  return `${fmtDec(n, 2)} ${currency}`;
}

const WEEKDAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

/** "T6 9/10 · 19:30" in the browser timezone. */
export function fmtSlot(sec: number | null | undefined): string {
  if (!sec) return '–';
  const d = new Date(sec * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} · ${hh}:${mm}`;
}
