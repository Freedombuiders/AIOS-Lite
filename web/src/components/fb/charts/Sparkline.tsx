import { SERIES } from './chart-utils';

/** Tiny trend line for KPI tiles. Decorative: the tile already states the value. */
export function Sparkline({ values }: { values: number[] }) {
  const v = values.filter((n) => Number.isFinite(n));
  if (v.length < 2) return <div class="h-7 mt-1" aria-hidden="true" />;
  const mn = Math.min(...v);
  const mx = Math.max(...v);
  const r = mx - mn || 1;
  const pts = v.map((n, i) => `${((i * 100) / (v.length - 1)).toFixed(1)},${(26 - ((n - mn) / r) * 22).toFixed(1)}`).join(' ');
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true" class="w-full h-7 mt-1">
      <polyline points={pts} fill="none" stroke={SERIES} stroke-width="1.5" vector-effect="non-scaling-stroke" />
    </svg>
  );
}
