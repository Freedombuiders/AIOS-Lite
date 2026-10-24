// "Doanh thu & chi phí" body for Tổng quan: sources, KPIs, one revenue-vs-cost chart and the cost breakdown.
import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import type { OverviewRange } from '@/module-host/contracts';
import { useFetch } from '@/lib/useFetch';
import { OvKpi, OvKpis, OvSources } from '@/components/overview/OvKpi';
import { fmtCount, fmtVndCompact } from '@/lib/overview-format';
import { LineChart } from '@/components/fb/charts/LineChart';
import { Legend } from '@/components/fb/charts/Legend';
import { RowBars, type BarRow } from '@/components/fb/charts/RowBars';
import { MIX_COLORS, ORANGE, SERIES, axisCompact, dayLabel, niceTicks } from '@/components/fb/charts/chart-utils';
import type { OverviewDto } from '../../server/overview';

const SOURCE_HREF: Record<string, string> = { erp: '/modules', whop: '/modules', pancake: '/connections' };
const vnd = (n: number) => `${Math.round(n).toLocaleString('vi-VN')} đ`;

export function OverviewWidget({ range }: { range: OverviewRange }) {
  const q = `from=${range.from}&to=${range.to}&prevFrom=${range.prevFrom}&prevTo=${range.prevTo}`;
  const { data, error } = useFetch<OverviewDto>(`/api/m/finance/overview?${q}`, 120_000);
  const [active, setActive] = useState<number | null>(null);
  if (error && !data) return <div class="text-sm text-[var(--color-text-muted)]">Chưa đọc được số doanh thu và chi phí.</div>;
  if (!data) return <div class="text-sm text-[var(--color-text-muted)]">Đang tải…</div>;

  const cur = data.current;
  const prev = data.previous;
  const src = (id: string) => data.sources.find((s) => s.id === id);
  const revenueConnected = ['erp', 'whop', 'pancake'].some((id) => src(id)?.connected);
  const bothSources = !!src('erp')?.connected && !!src('pancake')?.connected;
  const hasOrders = cur.orders !== null;

  const sources = (
    <OvSources items={data.sources.map((s) => ({ label: s.label, ok: s.connected, href: SOURCE_HREF[s.id], detail: s.lastSync ? `${s.detail} Cập nhật ${new Date(s.lastSync).toLocaleString('vi-VN')}.` : s.detail }))} />
  );

  const costRows: BarRow[] = [
    { key: 'ads', label: 'Quảng cáo Meta', value: cur.costs.ads, color: ORANGE },
    { key: 'ai', label: 'AI', value: cur.costs.ai, color: SERIES },
    { key: 'ledger', label: 'Sổ thu chi', value: cur.costs.ledger, color: MIX_COLORS.click },
  ].map((r) => ({
    key: r.key,
    label: r.label,
    ratio: cur.costs.total > 0 ? r.value / cur.costs.total : null,
    color: r.color,
    main: fmtVndCompact(r.value),
    sub: cur.costs.total > 0 ? `${Math.round((r.value / cur.costs.total) * 100)}%` : undefined,
    title: `${r.label}: ${vnd(r.value)}`,
  }));

  const labels = cur.daily.map((d) => dayLabel(d.date));
  const rev = cur.daily.map((d) => d.revenue);
  const cost = cur.daily.map((d) => d.cost);
  const top = Math.max(0, ...rev.map((v) => v ?? 0), ...cost);
  const ticks = top > 0 ? niceTicks(0, top, 4) : [0, 1];
  const tip = active !== null ? cur.daily[active] : null;

  return (
    <div>
      {sources}
      {!revenueConnected && (
        <p class="text-[13px] text-[var(--color-text-muted)] mb-4">
          Chưa có nguồn doanh thu nào được kết nối, nên chưa tính được lợi nhuận. Kết nối ERP hoặc Whop trong <Link href="/modules" class="underline">Module › Tài chính › Cài đặt</Link>, hoặc Pancake trong <Link href="/connections" class="underline">Kết nối</Link>.
        </p>
      )}
      <OvKpis>
        <OvKpi label="Doanh thu" value={fmtVndCompact(cur.revenue)} cur={cur.revenue} prev={prev.revenue} />
        <OvKpi label="Chi phí quảng cáo" value={fmtVndCompact(cur.costs.ads)} cur={cur.costs.ads} prev={prev.costs.ads} goodWhen="down" />
        <OvKpi label="Chi phí AI" value={fmtVndCompact(cur.costs.ai)} cur={cur.costs.ai} prev={prev.costs.ai} goodWhen="down" />
        <OvKpi label="Lợi nhuận ước tính" value={fmtVndCompact(cur.profit)} cur={cur.profit} prev={prev.profit} hint={cur.revenueBySource.pancake !== null ? 'Khớp trang P&L, chưa trừ giá vốn hàng bán' : 'Khớp trang P&L'} />
        <OvKpi label="ROAS" value={cur.roas === null ? '—' : `${cur.roas.toLocaleString('vi-VN', { maximumFractionDigits: 1 })}x`} cur={cur.roas} prev={prev.roas} hint="Doanh thu / chi phí quảng cáo" />
        {hasOrders && <OvKpi label="Đơn hàng" value={fmtCount(cur.orders)} cur={cur.orders} prev={prev.orders} hint={cur.aov !== null ? `Trung bình ${fmtVndCompact(cur.aov)}/đơn` : undefined} />}
      </OvKpis>
      {bothSources && <p class="text-[12px] text-[var(--color-text-muted)] -mt-2 mb-4">Đơn ghi ở cả ERP và Pancake sẽ bị tính hai lần: chỉ nên kết nối một trong hai cho cùng một cửa hàng.</p>}
      <div class="ov-grid">
        <div>
          <h3 class="ov-sub">Doanh thu và chi phí theo ngày</h3>
          <div class="mb-2"><Legend items={[{ label: 'Doanh thu', color: SERIES, kind: 'line' }, { label: 'Tổng chi phí', color: ORANGE, kind: 'line' }]} /></div>
          <div class="relative">
            <LineChart
              labels={labels}
              series={[{ name: 'Doanh thu', color: SERIES, values: rev }, { name: 'Tổng chi phí', color: ORANGE, values: cost }]}
              yTicks={ticks}
              fmtY={axisCompact}
              active={active}
              onActive={setActive}
              ariaOf={(i) => `${labels[i]}: doanh thu ${cur.daily[i].revenue === null ? 'chưa có số' : vnd(cur.daily[i].revenue as number)}, chi phí ${vnd(cur.daily[i].cost)}`}
              groupLabel="Doanh thu và chi phí theo ngày"
            />
            {tip && active !== null && (
              <div
                role="status"
                class="absolute z-10 pointer-events-none rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-2.5 py-1.5 text-[12px] text-[var(--color-text)] shadow-md"
                style={{ top: '4px', ...(active > cur.daily.length / 2 ? { right: '12px' } : { left: '48px' }) }}
              >
                <div class="font-semibold mb-0.5">{dayLabel(tip.date)}</div>
                <div class="text-[var(--color-text-muted)]">Doanh thu: <span class="text-[var(--color-text)] tabular-nums">{tip.revenue === null ? 'chưa có số' : vnd(tip.revenue)}</span></div>
                <div class="text-[var(--color-text-muted)]">Chi phí: <span class="text-[var(--color-text)] tabular-nums">{vnd(tip.cost)}</span></div>
                <div class="text-[var(--color-text-muted)]">Lợi nhuận: <span class="text-[var(--color-text)] tabular-nums">{tip.profit === null ? '—' : vnd(tip.profit)}</span></div>
              </div>
            )}
          </div>
        </div>
        <div>
          <h3 class="ov-sub">Chi phí trong kỳ{cur.costs.total > 0 ? `: ${fmtVndCompact(cur.costs.total)}` : ''}</h3>
          {cur.costs.total > 0
            ? <RowBars rows={costRows} labelWidth={110} />
            : <p class="text-[13px] text-[var(--color-text-muted)] m-0">Chưa có chi phí nào trong kỳ này.</p>}
        </div>
      </div>
    </div>
  );
}
