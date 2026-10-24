import { AXIS, SERIES, SERIES_HOVER, toneColor, type Tone } from './chart-utils';

export interface QuadrantPoint {
  id: string;
  label: string;
  /** 0..100 from the left. */
  x: number;
  /** 0..100 from the top. */
  y: number;
  size: number;
  aria: string;
}

interface Props {
  points: QuadrantPoint[];
  active: string | null;
  onActive: (id: string | null) => void;
  quads: { tl: string; tr: string; bl: string; br: string; tones?: Partial<Record<'tl' | 'tr' | 'bl' | 'br', Tone>> };
  yLabels: { top: string; mid: string; bottom: string };
  xLabels: [string, string, string];
  /** Vertical divider position, % from the left. */
  xDivider?: number;
  height?: number;
  groupLabel: string;
}

/** Scatter with a horizontal reference line (×1,0) and four labelled quadrants. */
export function Quadrant({ points, active, onActive, quads, yLabels, xLabels, xDivider = 50, height = 260, groupLabel }: Props) {
  // Alternate label sides for neighbours so names do not collide.
  const below = new Map<string, boolean>();
  let lastX = -100;
  let lastBelow = false;
  [...points].sort((a, b) => a.x - b.x).forEach((p) => {
    let b = p.x - lastX < 16 ? !lastBelow : true;
    if (p.y > 82) b = false;
    if (p.y < 14) b = true;
    below.set(p.id, b);
    lastX = p.x;
    lastBelow = b;
  });
  const tone = (k: 'tl' | 'tr' | 'bl' | 'br') => toneColor(quads.tones?.[k] ?? 'neutral');
  return (
    <div class="flex flex-col gap-1">
      <div class="relative ml-9 mr-1" style={{ height: `${height}px`, borderLeft: `1px solid ${AXIS}`, borderBottom: `1px solid ${AXIS}` }} onMouseLeave={() => onActive(null)}>
        <div aria-hidden="true" class="absolute left-0 right-0" style={{ top: '50%', borderTop: '2px dashed var(--color-text-faint)' }} />
        <div aria-hidden="true" class="absolute top-0 bottom-0" style={{ left: `${xDivider}%`, width: '1px', background: 'var(--color-border)' }} />
        <span class="absolute left-1.5 top-1.5 text-[11px]" style={{ color: tone('tl') }}>{quads.tl}</span>
        <span class="absolute right-1.5 top-1.5 text-[11px] text-right" style={{ color: tone('tr') }}>{quads.tr}</span>
        <span class="absolute left-1.5 bottom-1.5 text-[11px]" style={{ color: tone('bl') }}>{quads.bl}</span>
        <span class="absolute right-1.5 bottom-1.5 text-[11px] text-right" style={{ color: tone('br') }}>{quads.br}</span>
        <div role="group" aria-label={groupLabel}>
          {points.map((p) => {
            const on = active === p.id;
            const b = below.get(p.id);
            return (
              <div key={p.id}>
                <button
                  type="button"
                  aria-label={p.aria}
                  onMouseEnter={() => onActive(p.id)}
                  onFocus={() => onActive(p.id)}
                  onBlur={() => onActive(null)}
                  class="absolute rounded-full cursor-default p-0"
                  style={{
                    left: `${p.x}%`,
                    top: `${p.y}%`,
                    width: `${p.size}px`,
                    height: `${p.size}px`,
                    transform: 'translate(-50%, -50%)',
                    background: on ? SERIES_HOVER : SERIES,
                    opacity: on ? 1 : 0.8,
                    border: '2px solid var(--color-card)',
                  }}
                />
                <span
                  class="absolute text-[11.5px] font-semibold whitespace-nowrap text-[var(--color-text)] pointer-events-none"
                  style={{ left: `${p.x}%`, top: `calc(${p.y}% ${b ? '+' : '-'} ${p.size / 2 + (b ? 4 : 18)}px)`, transform: 'translateX(-50%)' }}
                >
                  {p.label}
                </span>
              </div>
            );
          })}
        </div>
        <span aria-hidden="true" class="absolute -left-9 top-0 text-[10.5px] text-[var(--color-text-muted)]">{yLabels.top}</span>
        <span aria-hidden="true" class="absolute -left-9 text-[10.5px] text-[var(--color-text-muted)]" style={{ top: '50%', transform: 'translateY(-50%)' }}>{yLabels.mid}</span>
        <span aria-hidden="true" class="absolute -left-5 -bottom-0.5 text-[10.5px] text-[var(--color-text-muted)]">{yLabels.bottom}</span>
      </div>
      <div aria-hidden="true" class="flex justify-between ml-9 mr-1 text-[11px] text-[var(--color-text-muted)]">
        <span>{xLabels[0]}</span><span>{xLabels[1]}</span><span>{xLabels[2]}</span>
      </div>
    </div>
  );
}
