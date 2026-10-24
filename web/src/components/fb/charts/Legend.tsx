import { MUTED_MARK } from './chart-utils';

export interface LegendItem {
  label: string;
  color: string;
  kind?: 'box' | 'line' | 'dash';
}

/** Legend for charts with two or more series. Always text + swatch, never colour alone. */
export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--color-text-muted)] list-none m-0 p-0" aria-label="Chú giải">
      {items.map((it) => (
        <li key={it.label} class="inline-flex items-center gap-1.5">
          {it.kind === 'line' && <span class="inline-block w-3.5 h-0.5" style={{ background: it.color }} aria-hidden="true" />}
          {it.kind === 'dash' && <span class="inline-block w-3.5 h-0 border-t-2 border-dashed" style={{ borderColor: it.color || MUTED_MARK }} aria-hidden="true" />}
          {(!it.kind || it.kind === 'box') && <span class="inline-block w-2.5 h-2.5 rounded-[2px]" style={{ background: it.color }} aria-hidden="true" />}
          {it.label}
        </li>
      ))}
    </ul>
  );
}
