import { useMemo } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

import { AXIS, GRID, finite, spreadIndices } from '@/components/fb/charts/chart-utils';
import { useElementWidth } from '@/components/fb/charts/useElementWidth';

let gradientSeq = 0;

/** Small filled trend for a tile or a row. Decorative: the value next to it is the information. */
export function AreaSpark({ values, color, height = 36, emptyLabel }: { values: number[]; color: string; height?: number; emptyLabel?: string }) {
  const id = useMemo(() => `hd-spark-${++gradientSeq}`, []);
  const v = values.filter((n) => Number.isFinite(n));
  if (v.length < 2) {
    return (
      <div class={`hd-spark-empty${emptyLabel ? ' has-label' : ''}`} style={{ height: `${height}px` }} aria-hidden="true">
        {emptyLabel ? <span>{emptyLabel}</span> : null}
      </div>
    );
  }
  const mn = Math.min(...v);
  const mx = Math.max(...v);
  const r = mx - mn || 1;
  const pts = v.map((n, i) => [(i * 100) / (v.length - 1), 2 + (1 - (n - mn) / r) * (height - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" aria-hidden="true" class="hd-spark" style={{ height: `${height}px` }}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color={color} stop-opacity="0.28" />
          <stop offset="100%" stop-color={color} stop-opacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L100,${height} L0,${height} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    </svg>
  );
}

interface ComboProps {
  labels: string[];
  /** Bars (revenue); null hides them. */
  bars: (number | null)[] | null;
  /** Line over the bars on the same axis (ad spend); null hides it. */
  line: (number | null)[] | null;
  yTicks: number[];
  fmtY: (v: number) => string;
  barColor: string;
  lineColor: string;
  /** The last column is today, still running: drawn lighter. */
  partialLast?: boolean;
  height?: number;
  active: number | null;
  onActive: (i: number | null) => void;
  ariaOf: (i: number) => string;
  groupLabel: string;
  /** Floating card for the active column (decorative: `ariaOf` already says the same). */
  tooltip?: (i: number) => ComponentChildren;
}

const PAD = { left: 52, right: 10, top: 14, bottom: 26 };

/**
 * Daily bars with a line on the same axis, drawn at real pixel width. Columns are buttons over the plot so
 * mouse hover and keyboard focus drive the same readout (same contract as fb/charts/LineChart).
 */
export function ComboChart({ labels, bars, line, yTicks, fmtY, barColor, lineColor, partialLast, height = 220, active, onActive, ariaOf, groupLabel, tooltip }: ComboProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>(640);
  const n = labels.length;
  const plotW = Math.max(40, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const lo = yTicks[0];
  const hi = yTicks[yTicks.length - 1];
  const span = hi - lo || 1;
  const slot = plotW / Math.max(1, n);
  const barW = Math.max(3, Math.min(30, slot * 0.62));
  const xOf = (i: number) => PAD.left + (i + 0.5) * slot;
  const yOf = (v: number) => PAD.top + (1 - (v - lo) / span) * plotH;
  const xl = spreadIndices(n, Math.max(2, Math.min(8, Math.floor(plotW / 64))));

  const segs: string[] = [];
  if (line) {
    let cur = '';
    line.forEach((v, i) => {
      if (finite(v)) cur += `${cur ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`;
      else if (cur) { segs.push(cur); cur = ''; }
    });
    if (cur) segs.push(cur);
  }

  return (
    <div ref={ref} class="relative w-full" style={{ height: `${height}px` }} onMouseLeave={() => onActive(null)}>
      <svg width={width} height={height} class="absolute inset-0 block" aria-hidden="true">
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={yOf(t)} y2={yOf(t)} stroke={t === lo ? AXIS : GRID} stroke-dasharray={t === lo ? undefined : '3 4'} />
            <text x={PAD.left - 8} y={yOf(t) + 4} text-anchor="end" font-size="11" fill="var(--color-text-muted)">{fmtY(t)}</text>
          </g>
        ))}
        {active !== null && (
          <rect x={xOf(active) - slot / 2} y={PAD.top} width={slot} height={plotH} fill="var(--color-elevated)" opacity="0.7" rx="6" />
        )}
        {bars?.map((v, i) => {
          if (!finite(v) || v <= lo) return null;
          const y = yOf(v);
          const faded = partialLast && i === n - 1;
          return (
            <rect key={i} x={xOf(i) - barW / 2} y={y} width={barW} height={Math.max(1, PAD.top + plotH - y)} rx={Math.min(4, barW / 3)}
              fill={barColor} opacity={active === null || active === i ? (faded ? 0.5 : 0.92) : 0.45} />
          );
        })}
        {segs.map((d, k) => (
          <path key={k} d={d} fill="none" stroke={lineColor} stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round" />
        ))}
        {line?.map((v, i) => finite(v) && (n <= 31) && (
          <circle key={i} cx={xOf(i)} cy={yOf(v)} r={active === i ? 5 : n > 14 ? 2.5 : 3.5} fill={lineColor} stroke="var(--color-card)" stroke-width="2" />
        ))}
        {xl.map((i) => (
          <text key={i} x={xOf(i)} y={height - 7} text-anchor="middle" font-size="10.5" fill="var(--color-text-muted)">{labels[i]}</text>
        ))}
      </svg>
      {active !== null && tooltip ? (
        // Beside the column, on the side with more room, so it never covers the bar it describes.
        <div class="hd-tip" aria-hidden="true"
          style={xOf(active) > width / 2
            ? { right: `${width - xOf(active) + slot / 2 + 4}px`, top: `${PAD.top}px` }
            : { left: `${xOf(active) + slot / 2 + 4}px`, top: `${PAD.top}px` }}>
          {tooltip(active)}
        </div>
      ) : null}
      <div role="group" aria-label={groupLabel} class="absolute flex" style={{ left: `${PAD.left}px`, width: `${plotW}px`, top: 0, height: `${PAD.top + plotH}px` }}>
        {labels.map((_, i) => (
          <button
            key={i}
            type="button"
            aria-label={ariaOf(i)}
            onMouseEnter={() => onActive(i)}
            onFocus={() => onActive(i)}
            onBlur={() => onActive(null)}
            class="flex-1 h-full min-w-0 border-0 bg-transparent cursor-default hd-chart-col"
          />
        ))}
      </div>
    </div>
  );
}
