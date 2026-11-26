// Number and label formatting shared by the learn pages (Vietnamese conventions: 4,3% and 1.200).

export const pct = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : `${v.toLocaleString('vi-VN', { maximumFractionDigits: 2 })}%`;

export const int = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString('vi-VN'));

export const MILESTONE_LABELS: Record<string, string> = {
  '1h': '1 giờ', '6h': '6 giờ', '24h': '24 giờ', '3d': '3 ngày', '7d': '7 ngày', '28d': '28 ngày', latest: 'Mới nhất',
};

export const MILESTONE_SECONDS: Record<string, number> = {
  '1h': 3600, '6h': 6 * 3600, '24h': 86400, '3d': 3 * 86400, '7d': 7 * 86400, '28d': 28 * 86400,
};

/** Link of the single-post page for a note path. */
export const postHref = (relPath: string) => `/m/learn/posts/${encodeURIComponent(relPath)}`;

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}
