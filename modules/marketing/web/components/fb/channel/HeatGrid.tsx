import { useState } from 'preact/hooks';
import { fmtDec, type ChannelDashboardDto } from '@modules/marketing/web/lib/fbstudio';
import { HEAT, TRACK, finite } from '@/components/fb/charts/chart-utils';

const DAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
const SLOTS = ['06–09', '09–12', '12–14', '14–18', '18–21', '21–24'];
const DARK_TEXT_FROM = 2; // bins 0 and 1 are dark blues: white text; the rest dark text

function makeEdges(values: number[]): number[] {
  if (values.length === 0) return [];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (hi - lo < 0.05) return [];
  const step = (hi - lo) / 5;
  return [1, 2, 3, 4].map((k) => Math.round((lo + step * k) * 10) / 10);
}

function binOf(v: number, edges: number[]): number {
  if (edges.length === 0) return 2;
  let b = 0;
  for (const e of edges) if (v >= e) b += 1;
  return b;
}

/** Weekday × time-slot heatmap of median ER (sequential blue ramp, adaptive bins). */
export function HeatGrid({ heat }: { heat: ChannelDashboardDto['heat'] }) {
  const [active, setActive] = useState<string | null>(null);
  const at = (d: number, s: number) => heat.find((c) => c.weekday === d && c.slot === s);
  const values = heat.map((c) => c.er).filter(finite);
  const edges = makeEdges(values);

  let best: { d: number; s: number; er: number } | null = null;
  for (const c of heat) {
    if (finite(c.er) && (!best || c.er > best.er)) best = { d: c.weekday, s: c.slot, er: c.er };
  }

  const describe = (d: number, s: number) => {
    const c = at(d, s);
    if (!c || !finite(c.er)) return `${DAYS[d]} ${SLOTS[s]} giờ: chưa đăng bài`;
    return `${DAYS[d]} ${SLOTS[s]} giờ: ER ${fmtDec(c.er)}% · ${c.posts} bài`;
  };
  let readout = best ? `Ô tốt nhất: ${DAYS[best.d]} ${SLOTS[best.s]} giờ, ER ${fmtDec(best.er)}%` : 'Chưa có ô nào đủ dữ liệu';
  if (active) {
    const [d, s] = active.split('-').map(Number);
    readout = describe(d, s);
  }

  const legend = edges.length
    ? [`< ${fmtDec(edges[0])}%`, `${fmtDec(edges[0])}–${fmtDec(edges[1])}`, `${fmtDec(edges[1])}–${fmtDec(edges[2])}`, `${fmtDec(edges[2])}–${fmtDec(edges[3])}`, `≥ ${fmtDec(edges[3])}%`]
    : [];

  return (
    <div class="flex flex-col gap-2.5">
      <div role="status" class="text-[12px] text-[var(--color-text)]">{readout}</div>
      <div class="overflow-x-auto">
        <div class="min-w-[420px] flex flex-col gap-[3px] text-[11.5px]" onMouseLeave={() => setActive(null)}>
          <div class="grid gap-[3px]" style={{ gridTemplateColumns: '40px repeat(6, minmax(0, 1fr))' }}>
            <span />
            {SLOTS.map((s) => <span key={s} class="text-center text-[var(--color-text-muted)]">{s}</span>)}
          </div>
          {DAYS.map((day, d) => (
            <div key={day} class="grid gap-[3px]" style={{ gridTemplateColumns: '40px repeat(6, minmax(0, 1fr))' }}>
              <span class="flex items-center text-[var(--color-text-muted)]">{day}</span>
              {SLOTS.map((_, s) => {
                const c = at(d, s);
                const has = !!c && finite(c.er);
                const key = `${d}-${s}`;
                const on = active === key;
                const bin = has ? binOf(c!.er as number, edges) : -1;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-label={describe(d, s)}
                    onMouseEnter={() => setActive(key)}
                    onFocus={() => setActive(key)}
                    onBlur={() => setActive(null)}
                    class="h-[34px] rounded-[5px] font-semibold tabular-nums cursor-default"
                    style={{
                      background: has ? HEAT[bin] : TRACK,
                      color: has ? (bin >= DARK_TEXT_FROM ? '#0e0e10' : '#ffffff') : 'var(--color-text-faint)',
                      border: on ? '2px solid var(--color-text)' : has ? '1px solid transparent' : '1px solid var(--color-border)',
                    }}
                  >
                    {has ? fmtDec(c!.er) : '–'}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[var(--color-text-muted)]">
        <span>ER</span>
        {legend.map((t, i) => (
          <span key={t} class="inline-flex items-center gap-1">
            <span class="inline-block w-3.5 h-2.5 rounded-[2px]" style={{ background: HEAT[i] }} aria-hidden="true" />{t}
          </span>
        ))}
        {legend.length === 0 && values.length > 0 && <span class="inline-flex items-center gap-1"><span class="inline-block w-3.5 h-2.5 rounded-[2px]" style={{ background: HEAT[2] }} aria-hidden="true" />mọi ô gần như bằng nhau</span>}
        <span class="inline-flex items-center gap-1"><span class="inline-block w-3.5 h-2.5 rounded-[2px] border border-[var(--color-border)]" style={{ background: TRACK }} aria-hidden="true" />chưa đăng</span>
      </div>
    </div>
  );
}
