import type { ComponentChildren } from 'preact';
import { AXIS, GRID, niceTicks, spreadIndices } from './chart-utils';

export interface StackSeries {
  key: string;
  label: string;
  color: string;
}

interface Props {
  series: StackSeries[];
  /** values[col][seriesIndex]; series are stacked bottom-up in `series` order. */
  values: number[][];
  labels: string[];
  active: number | null;
  onActive: (i: number | null) => void;
  ariaOf: (i: number) => string;
  formatAxis: (v: number) => string;
  groupLabel: string;
  height?: number;
  tooltip?: (i: number) => ComponentChildren;
}

/**
 * Daily stacked columns (one segment per series, a 2px surface gap between
 * segments, rounded top). Each column is a button so hover and keyboard focus
 * both drive the readout.
 */
export function StackedBars({ series, values, labels, active, onActive, ariaOf, formatAxis, groupLabel, height = 180, tooltip }: Props) {
  const totals = values.map((col) => col.reduce((s, v) => s + (v > 0 ? v : 0), 0));
  // Tidy ceiling on a 4-step grid (10,2 tr → 15 tr, not 20 tr).
  const ticks = niceTicks(0, Math.max(1, ...totals), 5);
  const max = ticks[ticks.length - 1];
  const n = values.length;
  const xl = spreadIndices(n, 6);
  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex gap-2">
        <div aria-hidden="true" class="shrink-0 w-[42px] flex flex-col justify-between items-end text-[11px] text-[var(--color-text-muted)] tabular-nums" style={{ height: `${height}px` }}>
          <span style={{ transform: 'translateY(-6px)' }}>{formatAxis(max)}</span>
          <span>{formatAxis(max / 2)}</span>
          <span style={{ transform: 'translateY(6px)' }}>0</span>
        </div>
        <div class="relative flex-1 min-w-0" style={{ height: `${height}px` }} onMouseLeave={() => onActive(null)}>
          <div aria-hidden="true" class="absolute inset-0 flex flex-col justify-between">
            <div style={{ height: '1px', background: GRID }} />
            <div style={{ height: '1px', background: GRID }} />
            <div style={{ height: '1px', background: AXIS }} />
          </div>
          <div role="group" aria-label={groupLabel} class="absolute inset-0 flex items-end">
            {values.map((col, i) => {
              const dim = active !== null && active !== i;
              const segs = col.map((v, s) => ({ v, s })).filter((x) => x.v > 0);
              return (
                <button
                  key={i}
                  type="button"
                  aria-label={ariaOf(i)}
                  onMouseEnter={() => onActive(i)}
                  onFocus={() => onActive(i)}
                  onBlur={() => onActive(null)}
                  class="flex-1 h-full px-[2px] border-0 bg-transparent flex flex-col justify-end cursor-default min-w-0"
                  style={{ opacity: dim ? 0.55 : 1 }}
                >
                  {totals[i] <= 0 ? (
                    <span class="block w-full" style={{ height: '2px', background: AXIS, opacity: 0.6 }} />
                  ) : (
                    <span class="flex flex-col-reverse w-full gap-[2px]" style={{ height: `${Math.max(0.8, (totals[i] / max) * 100)}%` }}>
                      {segs.map(({ v, s }, k) => (
                        <span
                          key={series[s].key}
                          class={`block w-full ${k === segs.length - 1 ? 'rounded-t-[4px]' : ''}`}
                          style={{ flex: `${v} 0 0`, minHeight: '1px', background: series[s].color }}
                        />
                      ))}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {tooltip && active !== null && (
            <div
              role="status"
              class="absolute top-1 px-2.5 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-elevated)] text-[12px] pointer-events-none z-10 min-w-[180px] shadow-lg"
              style={{ left: `${Math.min(82, Math.max(18, ((active + 0.5) / n) * 100))}%`, transform: 'translateX(-50%)' }}
            >
              {tooltip(active)}
            </div>
          )}
        </div>
      </div>
      <div aria-hidden="true" class="flex justify-between pl-[50px] text-[11px] text-[var(--color-text-muted)]">
        {xl.map((i) => <span key={i}>{labels[i]}</span>)}
      </div>
    </div>
  );
}
