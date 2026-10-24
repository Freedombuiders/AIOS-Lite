import { addDays, datesBetween } from './engine.js';
import type { PnlPreset } from './types.js';

export interface ResolvedRange { from: string; to: string; label: string; prevFrom: string; prevTo: string; prevLabel: string }

const lastOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based
const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const dm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const span = (from: string, to: string) => `${dm(from)}–${dm(to)}`;
export const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

/** Pure: the period for a preset, Vietnam dates, and the period it is compared with. Null for a bad custom range. */
export function resolveRange(preset: PnlPreset, today: string, custom?: { from?: string; to?: string }): ResolvedRange | null {
  const y = +today.slice(0, 4);
  const m = +today.slice(5, 7);
  const d = +today.slice(8, 10);
  const sameLengthBefore = (from: string, to: string) => {
    const n = datesBetween(from, to).length;
    return { prevFrom: addDays(from, -n), prevTo: addDays(from, -1) };
  };
  switch (preset) {
    case 'today':
      return { from: today, to: today, label: 'Hôm nay', prevFrom: addDays(today, -1), prevTo: addDays(today, -1), prevLabel: 'hôm qua' };
    case 'week': {
      const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
      const monday = addDays(today, -((dow + 6) % 7));
      return { from: monday, to: today, label: `Tuần này (${span(monday, today)})`, prevFrom: addDays(monday, -7), prevTo: addDays(today, -7), prevLabel: 'cùng kỳ tuần trước' };
    }
    case 'month': {
      const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
      return {
        from: ymd(y, m, 1), to: today, label: `Tháng ${m}/${y}`,
        prevFrom: ymd(py, pm, 1), prevTo: ymd(py, pm, Math.min(d, lastOfMonth(py, pm))), prevLabel: 'cùng kỳ tháng trước',
      };
    }
    case 'last_month': {
      const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
      const [qy, qm] = pm === 1 ? [py - 1, 12] : [py, pm - 1];
      return { from: ymd(py, pm, 1), to: ymd(py, pm, lastOfMonth(py, pm)), label: `Tháng ${pm}/${py}`, prevFrom: ymd(qy, qm, 1), prevTo: ymd(qy, qm, lastOfMonth(qy, qm)), prevLabel: `tháng ${qm}/${qy}` };
    }
    case '7d':
    case '30d': {
      const n = preset === '7d' ? 7 : 30;
      const from = addDays(today, -(n - 1));
      return { from, to: today, label: `${n} ngày (${span(from, today)})`, ...sameLengthBefore(from, today), prevLabel: `${n} ngày trước đó` };
    }
    case 'custom': {
      if (!isDate(custom?.from) || !isDate(custom?.to) || custom.from > custom.to || custom.to > today) return null;
      if (datesBetween(custom.from, custom.to).length > 366) return null;
      return { from: custom.from, to: custom.to, label: span(custom.from, custom.to), ...sameLengthBefore(custom.from, custom.to), prevLabel: 'kỳ trước cùng độ dài' };
    }
  }
}
