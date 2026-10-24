// Number formatting and "so với kỳ trước" for the Tổng quan sections. Unknown is null and prints "—", never 0.

/** 18.205.502 → "18,2 tr"; 1.250.000.000 → "1,25 tỷ"; 950.000 → "950 k". */
export function fmtVndCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  const nf = (n: number, d: number) => n.toLocaleString('vi-VN', { maximumFractionDigits: d });
  if (a >= 1e9) return `${sign}${nf(a / 1e9, 2)} tỷ`;
  if (a >= 1e6) return `${sign}${nf(a / 1e6, 1)} tr`;
  if (a >= 1e3) return `${sign}${nf(a / 1e3, 0)} k`;
  return `${sign}${nf(a, 0)} đ`;
}

export function fmtCount(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString('vi-VN');
}

/** 0.0734 → "7,3%"; 0.0103 → "1,0%" (small rates keep their decimal); 0.5 → "50%" */
export function fmtRate(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const pct = v * 100;
  return `${pct.toLocaleString('vi-VN', { minimumFractionDigits: Math.abs(pct) < 10 ? digits : 0, maximumFractionDigits: digits })}%`;
}

/** 95 → "1 g 35 ph"; 12 → "12 ph" */
export function fmtMinutes(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const m = Math.round(v);
  if (m < 60) return `${m} ph`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} g ${m % 60} ph` : `${h} g`;
}

export interface Delta {
  /** relative change, 0.12 = +12%; null when there is nothing to compare with */
  pct: number | null;
  dir: 'up' | 'down' | 'flat';
}

export function delta(cur: number | null | undefined, prev: number | null | undefined): Delta {
  if (cur === null || cur === undefined || prev === null || prev === undefined || !Number.isFinite(cur) || !Number.isFinite(prev)) return { pct: null, dir: 'flat' };
  if (prev === 0) return { pct: null, dir: cur > 0 ? 'up' : 'flat' };
  const pct = (cur - prev) / Math.abs(prev);
  return { pct, dir: Math.abs(pct) < 0.005 ? 'flat' : pct > 0 ? 'up' : 'down' };
}
