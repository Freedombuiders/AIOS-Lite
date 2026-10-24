// View helpers for GET /api/pnl (src/pnl). Types are shared with the server.
import type { PnlDto, PnlKpis, PnlLine, PnlPreset } from '../../server/pnl/types';

export type { PnlDto, PnlKpis, PnlLine, PnlPreset, PnlProgram, PnlCampaign, PnlIssue, PnlSettings } from '../../server/pnl/types';
export { ADS_OUT, ADS_SHARED, ADS_UNASSIGNED } from '../../server/pnl/types';

export const PRESETS: Array<{ id: PnlPreset; label: string }> = [
  { id: 'today', label: 'Hôm nay' },
  { id: 'week', label: 'Tuần này' },
  { id: 'month', label: 'Tháng này' },
  { id: 'last_month', label: 'Tháng trước' },
  { id: '7d', label: '7 ngày' },
  { id: '30d', label: '30 ngày' },
  { id: 'custom', label: 'Tùy chọn' },
];

export function pnlUrl(preset: PnlPreset, from?: string, to?: string): string {
  return preset === 'custom' && from && to ? `/api/m/finance/pnl?preset=custom&from=${from}&to=${to}` : `/api/m/finance/pnl?preset=${preset}`;
}

const DASH = '—';
const nf = (digits: number) => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/** 17,8 tr · 897 k · 1,2 tỷ (sign kept). */
export function vndShort(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  const a = Math.abs(n);
  const s = n < 0 ? '−' : '';
  if (a >= 1e9) return `${s}${nf(2).format(a / 1e9)} tỷ`;
  if (a >= 1e6) return `${s}${nf(1).format(a / 1e6)} tr`;
  if (a >= 1e3) return `${s}${nf(0).format(a / 1e3)} k`;
  return `${s}${nf(0).format(a)}`;
}

/** 17.799.860 ₫ */
export function vndFull(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return `${n < 0 ? '−' : ''}${nf(0).format(Math.abs(Math.round(n)))} ₫`;
}

export function pct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return `${nf(digits).format(n * 100)}%`;
}

export function times(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return `${nf(n >= 10 ? 0 : 2).format(n)}×`;
}

export const bpsPct = (bps: number) => `${nf(1).format(bps / 100)}%`;

/** Relative change; null when there is nothing sound to compare with. */
export function change(cur: number, prev: number | null | undefined): number | null {
  if (prev === null || prev === undefined || !Number.isFinite(prev) || prev === 0) return null;
  return (cur - prev) / Math.abs(prev);
}

export function deltaOf(dto: PnlDto, key: keyof PnlKpis): number | null {
  const cur = dto.kpis[key];
  const prev = dto.prev?.[key];
  return typeof cur === 'number' && typeof prev === 'number' ? change(cur, prev) : null;
}

export const dm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
export const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

export function syncedLabel(sec: number | null): string {
  if (!sec) return 'chưa đồng bộ';
  const mins = Math.round((Date.now() / 1000 - sec) / 60);
  if (mins < 1) return 'vừa xong';
  if (mins < 60) return `${mins} phút trước`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} giờ trước` : new Date(sec * 1000).toLocaleDateString('vi-VN');
}

export interface WaterfallStep { key: string; label: string; value: number; kind: 'start' | 'down' | 'up' | 'total' }

/** Gross revenue → each deduction / cost → net profit, skipping zero steps. */
export function waterfallSteps(statement: PnlLine[]): WaterfallStep[] {
  const v = (k: string) => statement.find((l) => l.key === k)?.value ?? 0;
  const steps: WaterfallStep[] = [
    { key: 'gross', label: 'Doanh thu gộp', value: v('gross'), kind: 'start' },
    { key: 'deductions', label: 'Giảm trừ', value: -v('deductions'), kind: 'down' },
    { key: 'partners', label: 'Chia đối tác', value: -v('partners'), kind: 'down' },
    { key: 'direct', label: 'CP trực tiếp', value: -v('direct'), kind: 'down' },
    { key: 'marketing', label: 'Marketing', value: -v('marketing'), kind: 'down' },
    { key: 'operating', label: 'Vận hành', value: -v('operating'), kind: 'down' },
    { key: 'tax', label: 'Thuế', value: -v('tax'), kind: 'down' },
    { key: 'netProfit', label: 'Lợi nhuận', value: v('netProfit'), kind: 'total' },
  ];
  return steps.filter((s) => s.kind !== 'down' || Math.abs(s.value) >= 1);
}
