import { AXIS, GRID, MUTED_MARK, finite, spreadIndices } from './chart-utils';
import { useElementWidth } from './useElementWidth';

export interface LineSeries {
  name: string;
  color: string;
  dashed?: boolean;
  values: (number | null)[];
  /** Direct label on the last point. */
  endLabel?: string | null;
  labelPos?: 'above' | 'below';
  /** No dots (reference lines). */
  noDots?: boolean;
}

interface Props {
  labels: string[];
  series: LineSeries[];
  yTicks: number[];
  fmtY: (v: number) => string;
  target?: { value: number; color?: string } | null;
  height?: number;
  active: number | null;
  onActive: (i: number | null) => void;
  ariaOf: (i: number) => string;
  groupLabel: string;
  /** Show every label instead of a spread (few categories). */
  allXLabels?: boolean;
}

const PAD = { left: 42, right: 12, top: 18, bottom: 24 };

/**
 * Pixel-true SVG line chart. Null values break the line (gap). Columns are real
 * buttons stacked over the plot so hover and keyboard focus share one readout.
 */
export function LineChart({ labels, series, yTicks, fmtY, target, height = 170, active, onActive, ariaOf, groupLabel, allXLabels }: Props) {
  const [ref, width] = useElementWidth<HTMLDivElement>(520);
  const n = labels.length;
  const plotW = Math.max(40, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const lo = yTicks[0];
  const hi = yTicks[yTicks.length - 1];
  const span = hi - lo || 1;
  const xOf = (i: number) => PAD.left + ((i + 0.5) / Math.max(1, n)) * plotW;
  const yOf = (v: number) => PAD.top + (1 - (v - lo) / span) * plotH;
  const xl = allXLabels ? labels.map((_, i) => i) : spreadIndices(n, Math.max(2, Math.min(6, Math.floor(plotW / 70))));

  return (
    <div ref={ref} class="relative w-full" style={{ height: `${height}px` }} onMouseLeave={() => onActive(null)}>
      <svg width={width} height={height} class="absolute inset-0 block" aria-hidden="true">
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={yOf(t)} y2={yOf(t)} stroke={t === lo ? AXIS : GRID} />
            <text x={PAD.left - 6} y={yOf(t) + 4} text-anchor="end" font-size="11" fill="var(--color-text-muted)">{fmtY(t)}</text>
          </g>
        ))}
        {target && finite(target.value) && target.value >= lo && target.value <= hi && (
          <line x1={PAD.left} x2={PAD.left + plotW} y1={yOf(target.value)} y2={yOf(target.value)} stroke={target.color ?? MUTED_MARK} stroke-width="2" stroke-dasharray="5 4" />
        )}
        {active !== null && <line x1={xOf(active)} x2={xOf(active)} y1={PAD.top} y2={PAD.top + plotH} stroke={AXIS} stroke-dasharray="2 3" />}
        {series.map((s) => {
          const segs: string[] = [];
          let cur = '';
          s.values.forEach((v, i) => {
            if (finite(v)) {
              cur += `${cur ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`;
            } else if (cur) {
              segs.push(cur);
              cur = '';
            }
          });
          if (cur) segs.push(cur);
          let last = -1;
          s.values.forEach((v, i) => { if (finite(v)) last = i; });
          return (
            <g key={s.name}>
              {segs.map((d, k) => (
                <path key={k} d={d} fill="none" stroke={s.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray={s.dashed ? '5 4' : undefined} />
              ))}
              {!s.noDots && s.values.map((v, i) => finite(v) && (
                <circle key={i} cx={xOf(i)} cy={yOf(v)} r={active === i ? 5.5 : s.values.length > 20 ? 3 : 4} fill={s.color} stroke="var(--color-card)" stroke-width="2" />
              ))}
              {s.endLabel && last >= 0 && finite(s.values[last]) && (
                <text
                  x={Math.min(xOf(last), width - PAD.right)}
                  y={yOf(s.values[last] as number) + (s.labelPos === 'below' ? 18 : -9)}
                  text-anchor="end"
                  font-size="11"
                  font-weight={s.dashed ? 400 : 600}
                  fill={s.dashed ? 'var(--color-text-muted)' : 'var(--color-text)'}
                >
                  {s.endLabel}
                </text>
              )}
            </g>
          );
        })}
        {xl.map((i) => (
          <text key={i} x={xOf(i)} y={height - 6} text-anchor="middle" font-size="10.5" fill="var(--color-text-muted)">{labels[i]}</text>
        ))}
      </svg>
      <div role="group" aria-label={groupLabel} class="absolute flex" style={{ left: `${PAD.left}px`, width: `${plotW}px`, top: 0, height: `${PAD.top + plotH}px` }}>
        {labels.map((_, i) => (
          <button
            key={i}
            type="button"
            aria-label={ariaOf(i)}
            onMouseEnter={() => onActive(i)}
            onFocus={() => onActive(i)}
            onBlur={() => onActive(null)}
            class="flex-1 h-full min-w-0 border-0 bg-transparent cursor-default"
          />
        ))}
      </div>
    </div>
  );
}
