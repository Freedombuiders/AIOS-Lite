import { AXIS, DOWN, SERIES, SERIES_HOVER } from './chart-utils';

interface Props {
  up: (number | null)[];
  down: (number | null)[];
  active: number | null;
  onActive: (i: number | null) => void;
  ariaOf: (i: number) => string;
  groupLabel: string;
  totalHeight?: number;
}

/** New follows above the baseline, unfollows below it, one px-per-unit scale for both. */
export function FollowBars({ up, down, active, onActive, ariaOf, groupLabel, totalHeight = 160 }: Props) {
  const maxUp = Math.max(1, ...up.map((v) => v ?? 0));
  const maxDown = Math.max(0, ...down.map((v) => v ?? 0));
  const scale = (totalHeight - 2) / (maxUp + maxDown || 1);
  const upH = maxUp * scale;
  const downH = maxDown * scale;
  return (
    <div class="relative pl-[46px]" style={{ height: `${totalHeight}px` }} onMouseLeave={() => onActive(null)}>
      <div class="relative h-full">
        <div aria-hidden="true" class="absolute left-0 right-0" style={{ top: `${upH}px`, height: '1px', background: AXIS }} />
        <div class="absolute inset-0 flex">
          {up.map((u, i) => {
            const d = down[i];
            const on = active === i;
            return (
              <div key={i} class="flex-1 min-w-0 px-px flex flex-col" aria-hidden="true">
                <div class="flex items-end" style={{ height: `${upH}px` }}>
                  {u !== null && <span class="block w-full rounded-t-[4px]" style={{ height: `${(u ?? 0) * scale}px`, minHeight: u > 0 ? '1px' : 0, background: on ? SERIES_HOVER : SERIES }} />}
                </div>
                <div style={{ height: '1px' }} />
                <div class="flex items-start" style={{ height: `${downH}px` }}>
                  {d !== null && <span class="block w-full rounded-b-[4px]" style={{ height: `${(d ?? 0) * scale}px`, minHeight: d > 0 ? '1px' : 0, background: DOWN, opacity: on ? 1 : 0.9 }} />}
                </div>
              </div>
            );
          })}
        </div>
        <div role="group" aria-label={groupLabel} class="absolute inset-0 flex">
          {up.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={ariaOf(i)}
              onMouseEnter={() => onActive(i)}
              onFocus={() => onActive(i)}
              onBlur={() => onActive(null)}
              class="flex-1 h-full min-w-0 border-0 bg-transparent cursor-default"
              style={active === i ? { background: 'color-mix(in srgb, var(--color-text) 6%, transparent)' } : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
