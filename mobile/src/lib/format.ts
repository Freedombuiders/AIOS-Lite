import type { Lang } from '@/i18n';

/** 1536 → "1,5 KB" (vi) or "1.5 KB" (en). Sizes in bytes, as the cloud reports them. */
export function formatBytes(bytes: number | null | undefined, lang: Lang = 'vi'): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  const text = i === 0 ? String(Math.round(value)) : value.toFixed(value >= 10 ? 0 : 1);
  return `${lang === 'vi' ? text.replace('.', ',') : text} ${units[i]}`;
}

/** An ISO time as a short local date; "" when it is missing or not a date. */
export function formatDate(iso: string | null | undefined, lang: Lang = 'vi'): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
