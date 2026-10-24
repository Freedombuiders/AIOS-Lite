import type { ComponentChildren } from 'preact';
import { AXIS, GRID, SERIES, SERIES_FADED, SERIES_HOVER, niceMax, spreadIndices } from './chart-utils';

interface Props {
  values: (number | null)[];
  /** One short label per column ('7/10'); a spread of them is shown under the axis. */
  labels: string[];
  active: number | null;
  onActive: (i: number | null) => void;
  ariaOf: (i: number) => string;
  formatAxis: (v: number) => string;
  groupLabel: string;
  height?: number;
  /** Bars drawn lighter (incomplete day, previous period). */
  faded?: (i: number) => boolean;
  /** Floating readout above the plot for the active bar. */
  tooltip?: (i: number) => ComponentChildren;
  /** Caps the drawn bar width (px) so a few wide columns stay slim; the hover target keeps the full slot. */
  barMax?: number;
}

/**
 * Daily column chart. Each column is a real button, so both hover and keyboard
 * focus move the readout. A null value is a gap (small tick), never a zero bar.
 */
export function DailyBars({ values, labels, active, onActive, ariaOf, formatAxis, groupLabel, height = 160, faded, tooltip, barMax }: Props) {
  const nums = values.filter((v): v is number => typeof v === 'number');
  const max = niceMax(nums.length ? Math.max(...nums) : 1);
  const n = values.length;
  const xl = spreadIndices(n, 5);
  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex gap-2">
        <div aria-hidden="true" class="shrink-0 w-[38px] flex flex-col justify-between items-end text-[11px] text-[var(--color-text-muted)] tabular-nums" style={{ height: `${height}px` }}>
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
            {values.map((v, i) => {
              const on = active === i;
              const fill = on ? SERIES_HOVER : faded?.(i) ? SERIES_FADED : SERIES;
              return (
                <button
                  key={i}
                  type="button"
                  aria-label={ariaOf(i)}
                  onMouseEnter={() => onActive(i)}
                  onFocus={() => onActive(i)}
                  onBlur={() => onActive(null)}
                  class="flex-1 h-full px-px border-0 bg-transparent flex items-end cursor-default min-w-0"
                >
                  {v === null ? (
                    <span class="block w-full" style={{ height: '2px', background: AXIS, opacity: 0.6 }} />
                  ) : (
                    <span class="block w-full rounded-t-[4px] mx-auto" style={{ height: `${Math.max(0.5, (v / max) * 100)}%`, background: fill, ...(barMax ? { maxWidth: `${barMax}px` } : {}) }} />
                  )}
                </button>
              );
            })}
          </div>
          {tooltip && active !== null && (
            <div
              role="status"
              class="absolute top-1 px-2.5 py-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-elevated)] text-[12px] whitespace-nowrap pointer-events-none z-10"
              style={{ left: `${Math.min(88, Math.max(12, ((active + 0.5) / n) * 100))}%`, transform: 'translateX(-50%)' }}
            >
              {tooltip(active)}
            </div>
          )}
        </div>
      </div>
      <div aria-hidden="true" class="flex justify-between pl-[46px] text-[11px] text-[var(--color-text-muted)]">
        {xl.map((i) => <span key={i}>{labels[i]}</span>)}
      </div>
    </div>
  );
}
