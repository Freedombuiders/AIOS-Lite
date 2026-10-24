import { SERIES, TRACK, toneColor, type Tone } from './chart-utils';

export interface FunnelStep {
  key: string;
  label: string;
  valueText: string;
  /** Bar length relative to the first step, 0..1; null = no data. */
  ratio: number | null;
  note: string;
  noteTone?: Tone;
}

/** Horizontal funnel: label + value, a proportional bar, then the conversion note. */
export function Funnel({ steps }: { steps: FunnelStep[] }) {
  return (
    <ol class="flex flex-col gap-3 list-none m-0 p-0">
      {steps.map((s) => (
        <li key={s.key} class="flex flex-col gap-1">
          <div class="flex justify-between gap-2 text-[12.5px] text-[var(--color-text)]">
            <span>{s.label}</span>
            <span class="font-semibold tabular-nums">{s.valueText}</span>
          </div>
          <div class="h-3.5 rounded" style={{ background: TRACK }} aria-hidden="true">
            {s.ratio !== null && (
              <div class="h-3.5 rounded" style={{ width: `${Math.max(0.6, Math.min(100, s.ratio * 100))}%`, minWidth: '3px', background: SERIES }} />
            )}
          </div>
          <div class="text-[11.5px]" style={{ color: toneColor(s.noteTone ?? 'neutral') }}>{s.note}</div>
        </li>
      ))}
    </ol>
  );
}
