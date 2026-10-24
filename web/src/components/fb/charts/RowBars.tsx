import type { ComponentChildren } from 'preact';
import { MUTED_MARK, TRACK } from './chart-utils';

export interface BarRow {
  key: string;
  label: ComponentChildren;
  /** 0..1 of the track; null = no data (empty track). */
  ratio: number | null;
  color: string;
  opacity?: number;
  main: string;
  sub?: string;
  title?: string;
}

interface Props {
  rows: BarRow[];
  /** Reference marker on the track, 0..1 (target line). */
  marker?: number | null;
  labelWidth?: number;
}

/** Labelled horizontal bars sharing one scale, with an optional dashed target line. */
export function RowBars({ rows, marker, labelWidth = 96 }: Props) {
  return (
    <ul class="flex flex-col gap-2.5 list-none m-0 p-0">
      {rows.map((r) => (
        <li
          key={r.key}
          title={r.title}
          class="grid items-center gap-2.5 text-[13px] text-[var(--color-text)]"
          style={{ gridTemplateColumns: `${labelWidth}px minmax(0, 1fr) minmax(96px, auto)`, opacity: r.opacity ?? 1 }}
        >
          <span class="min-w-0">{r.label}</span>
          <span class="relative h-3.5 rounded-r" style={{ background: TRACK }} aria-hidden="true">
            {r.ratio !== null && <span class="block h-3.5 rounded-r" style={{ width: `${Math.max(0.5, Math.min(100, r.ratio * 100))}%`, background: r.color }} />}
            {marker !== null && marker !== undefined && (
              <span class="absolute" style={{ left: `${Math.min(100, marker * 100)}%`, top: '-3px', height: '20px', borderLeft: `2px dashed ${MUTED_MARK}` }} />
            )}
          </span>
          <span class="text-right tabular-nums">
            <strong class="font-semibold">{r.main}</strong>
            {r.sub && <span class="text-[12px] text-[var(--color-text-muted)]"> · {r.sub}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
