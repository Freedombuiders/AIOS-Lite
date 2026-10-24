import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { RefreshCw } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { useFetch } from '@/lib/useFetch';
import { usePageFocus } from '@/lib/page-context';
import {
  FORMAT_META,
  fmtCompact,
  fmtDec,
  fmtInt,
  fmtPct,
  fmtSlot,
  type ChannelDashboardDto,
  type ChannelKpi,
  type PostRef,
} from '@modules/marketing/web/lib/fbstudio';
import { Card, FormatChip, KpiTile, PageTabs, SetupNotice } from '@modules/marketing/web/components/fb/common';
import { ACCENT_TEXT, DOWN, MIX_COLORS, SERIES, WARN, axisCompact, dayLabel, deltaLabel, finite, isToday, toneColor } from '@/components/fb/charts/chart-utils';
import { BTN, BTN_PRIMARY, DashError, DashLoading, LINK_CLASS, SELECT, useAnalyticsRefresh, useFbDashGate } from '@modules/marketing/web/components/fb/DashStates';
import { DailyBars } from '@/components/fb/charts/DailyBars';
import { FollowBars } from '@/components/fb/charts/FollowBars';
import { Funnel, type FunnelStep } from '@/components/fb/charts/Funnel';
import { Legend } from '@/components/fb/charts/Legend';
import { RowBars, type BarRow } from '@/components/fb/charts/RowBars';
import { Sparkline } from '@/components/fb/charts/Sparkline';
import { HeatGrid } from '@modules/marketing/web/components/fb/channel/HeatGrid';
import { PillarSection } from '@modules/marketing/web/components/fb/channel/PillarSection';

const RANGES = [7, 28, 90];
const MIX_LABEL: Record<string, string> = { reaction: 'Reaction', comment: 'Comment', share: 'Share', click: 'Click link' };

/** `tabs` is set when the page sits inside the Social hub: one compact header row carries the hub's tabs. */
export function FbChannel({ tabs }: { tabs?: ComponentChildren } = {}) {
  const gate = useFbDashGate();
  const [days, setDays] = useState(28);
  const path = gate.pageId ? `/api/m/marketing/analytics/channel?page=${encodeURIComponent(gate.pageId)}&days=${days}` : null;
  const dash = useFetch<ChannelDashboardDto>(gate.blocker ? null : path);

  const refresh = useAnalyticsRefresh(gate.pageId, () => dash.refresh());
  const refreshNow = refresh.run;
  const refreshing = refresh.busy;

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        compact={!!tabs}
        tabs={tabs}
        breadcrumb="Marketing · Facebook"
        title="Hiệu quả kênh"
        actions={
          !gate.blocker && (
            <>
              <label class="flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
                Khoảng
                <select class={SELECT} value={days} onChange={(e) => setDays(Number((e.target as HTMLSelectElement).value))}>
                  {RANGES.map((d) => <option key={d} value={d}>{d} ngày qua</option>)}
                </select>
              </label>
              <button type="button" class={`${BTN} inline-flex items-center gap-1.5`} onClick={refreshNow} disabled={refreshing || !gate.pageId}>
                <RefreshCw size={13} class={refreshing ? 'animate-spin' : ''} /> Lấy số liệu mới
              </button>
            </>
          )
        }
      />
      <div class="flex-1 overflow-y-auto px-4 sm:px-6 py-5 flex flex-col gap-4">
        <p class="m-0 text-[13px] text-[var(--color-text-muted)] max-w-3xl">
          Mỗi lần xem một fanpage. {days} ngày gần nhất, so với {days} ngày liền trước đó.
        </p>
        {gate.blocker}
        {!gate.blocker && (
          <>
            <PageTabs pages={gate.pages} value={gate.pageId} onChange={gate.setPageId} />
            {dash.loading && !dash.data && <DashLoading />}
            {dash.error && !dash.data && <DashError error={dash.error} onRetry={dash.refresh} />}
            {dash.data && <ChannelBody dto={dash.data} onRefresh={refreshNow} refreshing={refreshing} />}
          </>
        )}
      </div>
    </div>
  );
}

function kpiValue(k: ChannelKpi): string {
  if (k.value === null) return '–';
  if (k.unit === 'pct') return fmtPct(k.value);
  if (k.unit === 'permille') return `${fmtDec(k.value, 1)}‰`;
  return fmtCompact(k.value);
}

export function KpiRow({ k }: { k: ChannelKpi }) {
  const d = deltaLabel(k.delta, k.deltaUnit === 'pt' && k.unit === 'permille' ? 'permille' : k.deltaUnit);
  const tone = !d || d.sign === 0 ? 'neutral' : d.sign > 0 ? 'good' : 'bad';
  const extra = k.key === 'followers' && finite(k.extra) ? `${k.extra >= 0 ? '+' : '−'}${fmtInt(Math.abs(k.extra))} ròng` : null;
  return (
    <KpiTile
      label={k.label}
      value={kpiValue(k)}
      delta={
        <span style={{ color: toneColor(tone) }}>
          {extra && <>{extra}{d ? ' · ' : ''}</>}
          {d ? d.text : !extra ? 'Chưa có kỳ trước để so' : ''}
        </span>
      }
    >
      <Sparkline values={k.spark} />
    </KpiTile>
  );
}

export function PostList({ items, empty }: { items: PostRef[]; empty: string }) {
  if (items.length === 0) return <p class="m-0 text-[12.5px] text-[var(--color-text-muted)]">{empty}</p>;
  return (
    <ul class="list-none m-0 p-0 flex flex-col">
      {items.map((t) => (
        <li key={t.postId} class="flex items-center gap-3 py-2 border-t border-[var(--color-border)] first:border-t-0">
          <span class="flex-1 min-w-0">
            <span class="block text-[13px] font-semibold text-[var(--color-text)] break-words">{t.title || '(không có tiêu đề)'}</span>
            <span class="block text-[13px] text-[var(--color-text-muted)]">
              {FORMAT_META[t.format]?.label ?? t.format}{t.pillar ? ` · ${t.pillar}` : ''}{t.publishedAt ? ` · ${fmtSlot(t.publishedAt)}` : ''}
            </span>
          </span>
          <span class="text-[14px] font-semibold tabular-nums text-[var(--color-text)]">{fmtPct(t.er)}</span>
        </li>
      ))}
    </ul>
  );
}

function ChannelBody({ dto, onRefresh, refreshing }: { dto: ChannelDashboardDto; onRefresh: () => void; refreshing: boolean }) {
  // The dock's agent reads this same dashboard for the Page and range on screen.
  usePageFocus({ fbPageId: dto.page.id, days: dto.days, label: `${dto.page.name} · ${dto.days} ngày` });
  const [hr, setHr] = useState<number | null>(null);
  const [hf, setHf] = useState<number | null>(null);
  const [hm, setHm] = useState<string | null>(null);

  const noData = dto.lastSnapshotAt === null && dto.posts === 0 && dto.reachDaily.every((d) => d.reach === null);
  if (noData) {
    return (
      <SetupNotice title="Chưa có số liệu cho Page này">
        <p class="m-0 mb-2">Studio chưa lấy bài và chỉ số của <strong>{dto.page.name}</strong>. Bấm nút dưới để nhập 90 ngày bài đăng và chụp chỉ số đầu tiên; sau đó hệ thống tự cập nhật lúc 02:00 mỗi đêm.</p>
        <button type="button" class={BTN_PRIMARY} onClick={onRefresh} disabled={refreshing}>{refreshing ? 'Đang gửi yêu cầu…' : 'Lấy số liệu ngay'}</button>
      </SetupNotice>
    );
  }

  // Reach
  const reachVals = dto.reachDaily.map((d) => d.reach);
  const reachNums = reachVals.filter(finite);
  const reachPeakIdx = reachNums.length ? reachVals.indexOf(Math.max(...reachNums)) : -1;
  const lastIdx = dto.reachDaily.length - 1;
  const reachPartial = (i: number) => i === lastIdx && isToday(dto.reachDaily[i].day);
  const reachReadout = hr !== null && dto.reachDaily[hr]
    ? `${dayLabel(dto.reachDaily[hr].day)}: ${dto.reachDaily[hr].reach === null ? 'chưa có số liệu' : fmtCompact(dto.reachDaily[hr].reach)}${reachPartial(hr) ? ' (hôm nay, chưa đủ ngày)' : ''}`
    : reachPeakIdx >= 0 ? `Cao nhất ${dayLabel(dto.reachDaily[reachPeakIdx].day)}: ${fmtCompact(reachVals[reachPeakIdx])}` : 'Chưa có số liệu reach';

  // Follows (same scale up and down)
  const up = dto.followsDaily.map((d) => d.newFollows);
  const down = dto.followsDaily.map((d) => d.unfollows);
  const newTotal = up.reduce<number>((s, v) => s + (v ?? 0), 0);
  const unTotal = down.reduce<number>((s, v) => s + (v ?? 0), 0);
  const upNums = up.filter(finite);
  const followPeak = upNums.length ? up.indexOf(Math.max(...upNums)) : -1;
  const followReadout = hf !== null && dto.followsDaily[hf]
    ? `${dayLabel(dto.followsDaily[hf].day)}: +${fmtInt(up[hf])} theo dõi mới, −${fmtInt(down[hf])} bỏ theo dõi`
    : followPeak >= 0 ? `Ròng ${newTotal - unTotal >= 0 ? '+' : '−'}${fmtInt(Math.abs(newTotal - unTotal))} người. Ngày cao nhất: ${dayLabel(dto.followsDaily[followPeak].day)} (${fmtInt(up[followPeak])} người).` : 'Chưa có số liệu theo dõi';

  // Funnel
  const first = dto.funnel[0]?.value ?? null;
  const steps: FunnelStep[] = dto.funnel.map((s, i) => {
    const prev = i > 0 ? dto.funnel[i - 1].value : null;
    return {
      key: s.key,
      label: s.label,
      valueText: fmtCompact(s.value),
      ratio: finite(s.value) && finite(first) && first > 0 ? s.value / first : null,
      note: i === 0 ? 'Mốc gốc' : finite(s.value) && finite(prev) && prev > 0 ? `${fmtPct((s.value / prev) * 100)} của bước trước` : 'Chưa có dữ liệu',
    };
  });

  // Mix
  const mixTotal = dto.mix.reduce((s, m) => s + m.value, 0);
  const mixColor = (k: string) => (MIX_COLORS as Record<string, string>)[k] ?? SERIES;
  const mixPct = (v: number) => (mixTotal > 0 ? (v / mixTotal) * 100 : 0);
  const activeMix = dto.mix.find((m) => m.key === hm);

  // Formats
  const maxEr = Math.max(0.1, ...dto.formats.map((f) => f.erMedian ?? 0));
  const formatRows: BarRow[] = dto.formats.map((f) => ({
    key: f.format,
    label: <FormatChip format={f.format} />,
    ratio: f.posts > 0 && finite(f.erMedian) ? f.erMedian / maxEr : null,
    color: SERIES,
    opacity: f.posts === 0 ? 0.4 : f.posts < 3 ? 0.55 : 1,
    main: f.posts > 0 ? fmtPct(f.erMedian) : '–',
    sub: `${f.posts} bài`,
    title: f.posts < 3 ? 'Dưới 3 bài, chưa đủ để kết luận' : undefined,
  }));

  return (
    <>
      {dto.lastSnapshotAt === null && (
        <div class="rounded-lg border px-4 py-2.5 text-[12.5px] w-full min-w-0 text-[var(--color-text)]" style={{ borderColor: WARN, background: 'var(--color-card)' }}>
          Chưa có ảnh chụp chỉ số nào cho các bài. Một số biểu đồ sẽ còn trống đến lần cập nhật 02:00 tới.{' '}
          <button type="button" class={LINK_CLASS} onClick={onRefresh} disabled={refreshing}>Lấy ngay</button>
        </div>
      )}
      <p class="m-0 -mt-2 text-[13px] text-[var(--color-text-muted)]">
        {dto.posts} bài trong {dto.days} ngày{dto.lastSnapshotAt ? ` · số liệu chụp lúc ${fmtSlot(dto.lastSnapshotAt)}` : ''}
        {finite(dto.page.followers) ? ` · ${fmtCompact(dto.page.followers)} người theo dõi` : ''}
      </p>

      {/* Analyst */}
      <section aria-label="Kết luận của Analyst" class="flex flex-wrap gap-4 p-4 rounded-xl border" style={{ background: 'var(--color-accent-soft)', borderColor: 'color-mix(in srgb, var(--color-accent) 40%, transparent)' }}>
        {dto.insight ? (
          <>
            <div class="flex-[2_1_420px] min-w-0 flex flex-col gap-2">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="text-[13px] font-semibold" style={{ color: ACCENT_TEXT }}>Analyst tóm tắt · {dto.page.name}</span>
                <span class="text-[13px] text-[var(--color-text-muted)]">
                  {dto.page.role ? `Vai trò Page: ${dto.page.role}` : ''}{dto.page.role && dto.page.mainKpi ? ' · ' : ''}{dto.page.mainKpi ? `KPI chính: ${dto.page.mainKpi}` : ''}
                </span>
              </div>
              <ul class="m-0 pl-[18px] list-disc flex flex-col gap-1.5 text-[13.5px] leading-relaxed text-[var(--color-text)]">
                {dto.insight.summary.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
              <div class="text-[11.5px] text-[var(--color-text-muted)]">Cập nhật {fmtSlot(dto.insight.createdAt)}. Con số do hệ thống tính, Analyst chỉ giải thích.</div>
            </div>
            <div class="flex-[1_1_280px] min-w-0 flex flex-col gap-2">
              <div class="text-[13px] font-semibold" style={{ color: ACCENT_TEXT }}>Việc nên làm tuần tới</div>
              <ol class="m-0 pl-[18px] list-decimal flex flex-col gap-1.5 text-[13px] leading-relaxed text-[var(--color-text)]">
                {dto.insight.actions.map((a, i) => <li key={i}>{a}</li>)}
              </ol>
              <Link href="/m/marketing/library" class={`${LINK_CLASS} text-[12.5px]`}>Giao agent lên kế hoạch tuần</Link>
            </div>
          </>
        ) : (
          <div class="text-[13px] text-[var(--color-text-muted)]">
            <span class="font-semibold" style={{ color: ACCENT_TEXT }}>Analyst chưa có kết luận cho {dto.page.name}.</span>{' '}
            Analyst chạy lúc 07:00 mỗi ngày khi Page đã có bài và chỉ số. Các bảng bên dưới vẫn dùng được.
          </div>
        )}
      </section>

      {/* KPI */}
      <section aria-label="Sức khỏe kênh" class="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
        {dto.kpis.map((k) => <KpiRow key={k.key} k={k} />)}
      </section>

      <div class="flex flex-wrap gap-4">
        <Card class="flex-[1_1_460px]" title="Reach mỗi ngày" aside={<span role="status" class="tabular-nums text-[var(--color-text)]">{reachReadout}</span>}>
          <DailyBars
            groupLabel="Reach theo ngày"
            values={reachVals}
            labels={dto.reachDaily.map((d) => dayLabel(d.day))}
            active={hr}
            onActive={setHr}
            formatAxis={axisCompact}
            faded={reachPartial}
            ariaOf={(i) => `${dayLabel(dto.reachDaily[i].day)}: ${reachVals[i] === null ? 'chưa có số liệu' : `reach ${fmtCompact(reachVals[i])}`}${reachPartial(i) ? ', hôm nay chưa đủ ngày' : ''}`}
          />
        </Card>

        <Card
          class="flex-[1_1_460px]"
          title="Theo dõi mới và bỏ theo dõi"
          aside={<Legend items={[{ label: `Theo dõi mới ${fmtInt(newTotal)}`, color: SERIES }, { label: `Bỏ theo dõi ${fmtInt(unTotal)}`, color: DOWN }]} />}
        >
          <FollowBars
            groupLabel="Theo dõi mới và bỏ theo dõi theo ngày"
            up={up}
            down={down}
            active={hf}
            onActive={setHf}
            ariaOf={(i) => `${dayLabel(dto.followsDaily[i].day)}: ${up[i] === null ? 'chưa có số liệu' : `${fmtInt(up[i])} theo dõi mới, ${fmtInt(down[i])} bỏ theo dõi`}`}
          />
          <div role="status" class="text-[13px] text-[var(--color-text-muted)]">{followReadout} Cùng thang đo cho cả hai chiều.</div>
        </Card>
      </div>

      <div class="flex flex-wrap gap-4">
        <Card class="flex-[1_1_460px]" title="Phễu tương tác" aside="Độ rộng theo tỷ lệ với bước đầu tiên">
          <Funnel steps={steps} />
        </Card>

        <Card class="flex-[1_1_460px]" title="Cơ cấu tương tác" aside={<span role="status">{activeMix ? `${MIX_LABEL[activeMix.key] ?? activeMix.key}: ${fmtInt(activeMix.value)} lượt (${fmtPct(mixPct(activeMix.value))})` : `Tổng ${fmtCompact(mixTotal)} lượt`}</span>}>
          {mixTotal <= 0 ? (
            <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Chưa có lượt tương tác nào trong khoảng này.</p>
          ) : (
            <>
              <div class="flex h-7 gap-0.5" role="group" aria-label="Cơ cấu tương tác">
                {dto.mix.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    aria-label={`${MIX_LABEL[m.key] ?? m.key}: ${fmtInt(m.value)} lượt, ${fmtPct(mixPct(m.value))}`}
                    onMouseEnter={() => setHm(m.key)}
                    onMouseLeave={() => setHm(null)}
                    onFocus={() => setHm(m.key)}
                    onBlur={() => setHm(null)}
                    class="h-7 rounded border-0 p-0 cursor-default"
                    style={{ width: `${mixPct(m.value)}%`, minWidth: m.value > 0 ? '3px' : 0, background: mixColor(m.key), outlineOffset: '2px' }}
                  />
                ))}
              </div>
              <div class="grid grid-cols-2 gap-2.5">
                {dto.mix.map((m) => (
                  <div key={m.key} class="flex gap-2.5 items-start p-2.5 rounded-lg bg-[var(--color-elevated)]" onMouseEnter={() => setHm(m.key)} onMouseLeave={() => setHm(null)}>
                    <span class="mt-1 w-2.5 h-2.5 rounded-[2px] shrink-0" style={{ background: mixColor(m.key) }} aria-hidden="true" />
                    <span class="flex flex-col gap-0.5 min-w-0">
                      <span class="text-[13px] text-[var(--color-text-muted)]">{MIX_LABEL[m.key] ?? m.key}</span>
                      <span class="text-[16px] font-semibold tabular-nums text-[var(--color-text)]">
                        {fmtCompact(m.value)} <span class="text-[13px] font-medium text-[var(--color-text-muted)]">{fmtPct(mixPct(m.value))}</span>
                      </span>
                      <span class="text-[11.5px] text-[var(--color-text-muted)]">{dto.posts > 0 ? `${fmtDec(m.value / dto.posts, 1)} mỗi bài` : '–'}</span>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>

      <PillarSection pillars={dto.pillars} winner={dto.winner} />

      <div class="flex flex-wrap gap-4">
        <Card class="flex-[1_1_400px]" title="ER trung vị theo format" aside="Mờ = dưới 3 bài, chưa đủ để kết luận">
          <RowBars rows={formatRows} labelWidth={92} />
        </Card>
        <Card class="flex-[1_1_460px]" title="Giờ vàng: ER trung vị theo khung đăng">
          <HeatGrid heat={dto.heat} />
        </Card>
      </div>

      <section aria-label="Bài nổi bật" class="flex flex-wrap gap-4">
        <Card class="flex-[3_1_480px]" title="Top 3 bài theo ER" aside={<Link href="/m/marketing/analytics?tab=posts" class={LINK_CLASS}>Xem tất cả bài</Link>}>
          <PostList items={dto.top} empty="Chưa có bài nào đủ số liệu để xếp hạng." />
        </Card>
        <Card class="flex-[2_1_320px]" title="Bài kém nhất">
          <PostList items={dto.bottom} empty="Chưa đủ bài để chỉ ra bài kém nhất." />
        </Card>
      </section>
    </>
  );
}
