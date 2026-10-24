// KOL growth charts. Built on the hand-rolled FB dashboard primitives
// (components/fb/charts): plain SVG/HTML, theme variables, real buttons for
// hover + keyboard readouts, the same validated categorical palette.

import { useMemo, useState } from 'preact/hooks';
import { DailyBars } from '@/components/fb/charts/DailyBars';
import { Legend } from '@/components/fb/charts/Legend';
import { LineChart } from '@/components/fb/charts/LineChart';
import { RowBars } from '@/components/fb/charts/RowBars';
import { MIX_COLORS, SERIES, axisCompact, dayLabel, isToday, niceTicks } from '@/components/fb/charts/chart-utils';
import { PLATFORM_META, fmtCompact, fmtInt, fmtRate, fmtUsd, hourIntensity, type GrowthDto } from '@modules/kol/web/lib/kol';

/** Fixed categorical order (validated in light and dark): blue, orange, green, amber. Colour follows the account. */
const CATEGORICAL = [MIX_COLORS.reaction, MIX_COLORS.comment, MIX_COLORS.share, MIX_COLORS.click];
const MAX_SERIES = CATEGORICAL.length;

/** Followers per account over the period. One line per account, legend + direct end labels. */
export function FollowersChart({ accounts }: { accounts: GrowthDto['accounts'] }) {
  const [active, setActive] = useState<number | null>(null);
  // Stable colour per account: order by platform then id, never by rank.
  const ordered = useMemo(() => [...accounts].sort((a, b) => a.platform.localeCompare(b.platform) || a.id.localeCompare(b.id)), [accounts]);
  const shown = ordered.slice(0, MAX_SERIES);
  const days = useMemo(() => [...new Set(shown.flatMap((a) => a.series.map((p) => p.day)))].sort(), [shown]);
  const series = shown.map((a, i) => {
    const byDay = new Map(a.series.map((p) => [p.day, p.followers]));
    const values = days.map((d) => byDay.get(d) ?? null);
    const last = [...values].reverse().find((v) => v !== null) ?? null;
    return {
      name: `${PLATFORM_META[a.platform].name} @${a.handle}`,
      color: CATEGORICAL[i],
      values,
      endLabel: shown.length <= 4 && last !== null ? fmtCompact(last) : null,
    };
  });
  const nums = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  if (!days.length || !nums.length) {
    return <p class="py-8 text-center text-[12.5px] text-[var(--color-text-muted)]">Chưa có số người theo dõi theo ngày. Số liệu được cập nhật mỗi ngày sau khi liên kết kênh.</p>;
  }
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const pad = Math.max(1, (hi - lo) * 0.1);
  const ticks = niceTicks(Math.max(0, lo - pad), hi + pad, 4);
  const labels = days.map(dayLabel);
  return (
    <div class="flex flex-col gap-2">
      {series.length > 1 && <Legend items={series.map((s) => ({ label: s.name, color: s.color, kind: 'line' as const }))} />}
      <LineChart
        labels={labels}
        series={series}
        yTicks={ticks}
        fmtY={axisCompact}
        active={active}
        onActive={setActive}
        groupLabel="Người theo dõi theo ngày"
        ariaOf={(i) => `${labels[i]}: ${series.map((s) => `${s.name} ${fmtInt(s.values[i])}`).join(', ')}`}
      />
      <div class="min-h-[18px] text-[12px] text-[var(--color-text-muted)] tabular-nums" aria-live="polite">
        {active !== null
          ? <>{labels[active]} · {series.map((s, i) => <span key={s.name}>{i ? ' · ' : ''}<span class="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: s.color }} aria-hidden="true" />{s.name}: <b class="text-[var(--color-text)]">{fmtInt(s.values[active])}</b></span>)}</>
          : 'Rê chuột hoặc dùng Tab trên biểu đồ để xem từng ngày.'}
      </div>
      {ordered.length > MAX_SERIES && <p class="text-[11.5px] text-[var(--color-text-faint)]">Hiện {MAX_SERIES}/{ordered.length} tài khoản.</p>}
    </div>
  );
}

/** Daily studio spend (USD) for this persona. Today is drawn lighter (incomplete). */
export function SpendBars({ spend }: { spend: GrowthDto['spend'] }) {
  const [active, setActive] = useState<number | null>(null);
  if (!spend.length || spend.every((d) => d.usd === 0)) {
    return <p class="py-8 text-center text-[12.5px] text-[var(--color-text-muted)]">Chưa có chi tiêu trong kỳ này.</p>;
  }
  const total = spend.reduce((s, d) => s + d.usd, 0);
  return (
    <div class="flex flex-col gap-1.5">
      <DailyBars
        values={spend.map((d) => d.usd)}
        labels={spend.map((d) => dayLabel(d.day))}
        active={active}
        onActive={setActive}
        formatAxis={(v) => fmtUsd(v)}
        groupLabel="Chi tiêu theo ngày"
        ariaOf={(i) => `${dayLabel(spend[i].day)}: ${fmtUsd(spend[i].usd)}`}
        faded={(i) => isToday(spend[i].day)}
        tooltip={(i) => <><b>{fmtUsd(spend[i].usd)}</b> <span class="text-[var(--color-text-muted)]">· {dayLabel(spend[i].day)}</span></>}
      />
      <p class="text-[12px] text-[var(--color-text-muted)] tabular-nums">Tổng {fmtUsd(total)} trong {spend.length} ngày</p>
    </div>
  );
}

/** Average engagement per content pillar, one hue, sorted high to low. */
export function PillarBars({ pillars }: { pillars: GrowthDto['pillars'] }) {
  const rows = [...pillars].sort((a, b) => (b.avgEngagement ?? -1) - (a.avgEngagement ?? -1));
  const max = Math.max(0, ...rows.map((r) => r.avgEngagement ?? 0));
  if (!rows.length) return <p class="py-6 text-center text-[12.5px] text-[var(--color-text-muted)]">Chưa có bài đã đăng gắn trụ cột.</p>;
  return (
    <RowBars
      labelWidth={110}
      rows={rows.map((r) => ({
        key: r.pillar || '—',
        label: <span class="block truncate" title={r.pillar}>{r.pillar || 'Không trụ cột'}</span>,
        ratio: r.avgEngagement === null || max === 0 ? null : r.avgEngagement / max,
        color: SERIES,
        main: fmtRate(r.avgEngagement),
        sub: `${r.posts} bài`,
        title: `${r.pillar || 'Không trụ cột'}: tương tác TB ${fmtRate(r.avgEngagement)} trên ${r.posts} bài`,
      }))}
    />
  );
}

/** Best posting hours: 24 cells, one hue light→dark by average engagement; empty hours stay neutral. */
export function HourHeatStrip({ hours }: { hours: GrowthDto['hours'] }) {
  const intensity = hourIntensity(hours);
  const byHour = new Map(hours.map((h) => [h.hour, h]));
  const best = intensity.reduce<number | null>((b, v, i) => (v !== null && (b === null || v > (intensity[b] ?? -1)) ? i : b), null);
  if (best === null) return <p class="py-6 text-center text-[12.5px] text-[var(--color-text-muted)]">Chưa đủ bài để biết giờ đăng tốt nhất.</p>;
  return (
    <div class="flex flex-col gap-1.5">
      <div class="grid gap-[2px]" style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }} role="list" aria-label="Tương tác trung bình theo giờ đăng">
        {intensity.map((v, h) => {
          const info = byHour.get(h);
          const label = `${h}h: ${info && info.posts > 0 ? `${fmtRate(info.avgEngagement)} trên ${info.posts} bài` : 'chưa có bài'}`;
          return (
            <span
              key={h}
              role="listitem"
              tabIndex={0}
              title={label}
              aria-label={label}
              class={`h-9 rounded-[3px] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ${h === best ? 'ring-2 ring-[var(--color-text)] ring-offset-1 ring-offset-[var(--color-card)]' : ''}`}
              style={{ background: v === null ? 'var(--color-elevated)' : `color-mix(in srgb, ${SERIES} ${Math.round(18 + v * 82)}%, var(--color-card))` }}
            />
          );
        })}
      </div>
      <div class="grid text-[10.5px] text-[var(--color-text-muted)] tabular-nums" style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }} aria-hidden="true">
        {Array.from({ length: 24 }, (_, h) => <span key={h} class="text-center">{h % 6 === 0 || h === 23 ? h : ''}</span>)}
      </div>
      <p class="text-[12px] text-[var(--color-text-muted)]">
        Giờ tốt nhất: <b class="text-[var(--color-text)]">{best}h–{best + 1}h</b> ({fmtRate(byHour.get(best)?.avgEngagement)} tương tác TB). Ô xám là giờ chưa đăng bài.
      </p>
    </div>
  );
}
