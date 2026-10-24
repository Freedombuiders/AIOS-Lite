// Shared palette + helpers for the hand-rolled Facebook dashboard charts.

/** Validated chart palette (see docs/facebook-content-studio.md). */
export const SERIES = '#3987e5';
export const SERIES_HOVER = '#6da7ec';
export const SERIES_FADED = 'rgba(57, 135, 229, 0.45)';
export const DOWN = '#e66767';
export const ORANGE = '#d95926';
export const HEAT = ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4'];
export const MIX_COLORS = { reaction: '#3987e5', comment: '#d95926', share: '#199e70', click: '#c98500' } as const;

/** Neutral marks that follow the theme. */
export const GRID = 'var(--color-border)';
export const AXIS = 'var(--color-border-strong)';
export const TRACK = 'var(--color-elevated)';
export const MUTED_MARK = 'var(--color-text-faint)';

/**
 * Status tones that stay readable on both light and dark surfaces: the hue is
 * mixed towards the theme's text colour (lighter on dark, darker on light).
 */
export const GOOD = 'color-mix(in srgb, #22c55e 55%, var(--color-text))';
export const BAD = 'color-mix(in srgb, #ef4444 55%, var(--color-text))';
export const WARN = 'color-mix(in srgb, #f59e0b 55%, var(--color-text))';
export const ACCENT_TEXT = 'color-mix(in srgb, var(--color-accent) 70%, var(--color-text))';

export type Tone = 'good' | 'bad' | 'warn' | 'neutral';
export function toneColor(tone: Tone): string {
  return tone === 'good' ? GOOD : tone === 'bad' ? BAD : tone === 'warn' ? WARN : 'var(--color-text-muted)';
}

/** 'YYYY-MM-DD' -> '7/10'. */
export function dayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])}/${Number(m[2])}`;
}

/** True when the ISO day is today in the browser timezone (the day is still incomplete). */
export function isToday(iso: string): boolean {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return iso.slice(0, 10) === `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local day key ('YYYY-MM-DD') of a unix-seconds timestamp. */
export function dayKeyOfSec(sec: number): string {
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const exp = Math.floor(Math.log10(raw));
  const f = raw / 10 ** exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * 10 ** exp;
}

/** Round a maximum up to a tidy axis ceiling (1, 2, 2.5, 5, 10 × 10^n). */
export function niceMax(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 1;
  return niceStep(v);
}

/** Evenly spaced tidy ticks covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!(hi > lo)) return [lo, lo + 1];
  const step = niceStep((hi - lo) / Math.max(1, count - 1));
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step * 1e-6; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** Up to `n` evenly spread indices (always includes first and last). */
export function spreadIndices(len: number, n = 5): number[] {
  if (len <= 0) return [];
  if (len <= n) return Array.from({ length: len }, (_, i) => i);
  return Array.from({ length: n }, (_, i) => Math.round((i * (len - 1)) / (n - 1)));
}

/** Axis count label without a dangling ',0' (20 N, 7,5 N, 1,2 tr). */
export function axisCompact(n: number): string {
  const a = Math.abs(n);
  const body = (v: number) => (Math.round(v * 10) / 10).toString().replace('.', ',');
  if (a >= 1_000_000) return `${body(n / 1_000_000)} tr`;
  if (a >= 1000) return `${body(n / 1000)} N`;
  return body(n);
}

export function finite(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** "▲ 12%" / "▼ 0,3 điểm"; null when there is nothing to compare. */
export function deltaLabel(delta: number | null | undefined, unit: 'pct' | 'pt' | 'count' | 'permille', digits = 1): { text: string; sign: -1 | 0 | 1 } | null {
  if (!finite(delta)) return null;
  const abs = Math.abs(delta);
  const body = (n: number, d: number) => n.toFixed(d).replace('.', ',');
  const sign: -1 | 0 | 1 = abs < 0.05 && unit !== 'count' ? 0 : delta > 0 ? 1 : delta < 0 ? -1 : 0;
  const arrow = sign > 0 ? '▲' : sign < 0 ? '▼' : '■';
  const num = unit === 'count' ? Math.round(abs).toLocaleString('vi-VN') : body(abs, abs >= 100 ? 0 : digits);
  const suffix = unit === 'pct' ? '%' : unit === 'pt' ? ' điểm' : unit === 'permille' ? '‰' : '';
  return { text: `${arrow} ${num}${suffix}`, sign };
}
