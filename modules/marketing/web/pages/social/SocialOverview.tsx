import type { ComponentChildren } from 'preact';
import { Link } from 'wouter-preact';
import { useFetch } from '@/lib/useFetch';
import { usePageFocus } from '@/lib/page-context';
import { ACCENT_TEXT, finite } from '@/components/fb/charts/chart-utils';
import { FORMAT_META, fmtInt, fmtPct, fmtSlot, type ChannelDashboardDto } from '@modules/marketing/web/lib/fbstudio';
import { Card, SetupNotice } from '@modules/marketing/web/components/fb/common';
import { BTN_PRIMARY, DashError, DashLoading, LINK_CLASS, useAnalyticsRefresh, useFbDashGate } from '@modules/marketing/web/components/fb/DashStates';
import { ChannelCards } from '@modules/marketing/web/components/social/ChannelCards';
import { ReachChart } from '@modules/marketing/web/components/social/ReachChart';
import { SocialKpi, SocialShell, useSocialDays } from '@modules/marketing/web/components/social/social-ui';

/** Mạng xã hội › Tổng quan: the channel cards, four KPIs, reach per day, highlights and the analyst's summary. */
export function SocialOverview() {
  const gate = useFbDashGate();
  const [days, setDays] = useSocialDays();
  const path = gate.pageId ? `/api/m/marketing/analytics/channel?page=${encodeURIComponent(gate.pageId)}&days=${days}` : null;
  const dash = useFetch<ChannelDashboardDto>(gate.blocker ? null : path);
  const refresh = useAnalyticsRefresh(gate.pageId, () => dash.refresh());

  return (
    <SocialShell active="overview" gate={gate} days={days} onDays={setDays} onRefresh={refresh.run} refreshing={refresh.busy}>
      {dash.loading && !dash.data && <DashLoading />}
      {dash.error && !dash.data && <DashError error={dash.error} onRetry={dash.refresh} />}
      {dash.data && <OverviewBody dto={dash.data} onRefresh={refresh.run} refreshing={refresh.busy} />}
    </SocialShell>
  );
}

function Highlight({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="flex flex-col gap-0.5">
      <span class="text-[12px] text-[var(--color-text-muted)]">{label}</span>
      <span class="font-semibold text-[var(--color-text)]">{children}</span>
    </div>
  );
}

function OverviewBody({ dto, onRefresh, refreshing }: { dto: ChannelDashboardDto; onRefresh: () => void; refreshing: boolean }) {
  usePageFocus({ fbPageId: dto.page.id, days: dto.days, label: `${dto.page.name} · ${dto.days} ngày` });

  const noData = dto.lastSnapshotAt === null && dto.posts === 0 && dto.reachDaily.every((d) => d.reach === null) && !finite(dto.page.followers);
  if (noData) {
    return (
      <>
        <ChannelCards dto={dto} />
        <SetupNotice title="Chưa có số liệu cho Page này">
          <p class="m-0 mb-2">Chưa lấy bài và chỉ số của <strong>{dto.page.name}</strong> từ Facebook. Bấm nút dưới để nhập bài đăng và chụp chỉ số đầu tiên; sau đó hệ thống tự cập nhật mỗi đêm.</p>
          <button type="button" class={BTN_PRIMARY} onClick={onRefresh} disabled={refreshing}>{refreshing ? 'Đang gửi yêu cầu…' : 'Lấy số liệu ngay'}</button>
        </SetupNotice>
      </>
    );
  }

  const pillar = dto.winner ? dto.pillars.find((p) => p.name === dto.winner) : undefined;
  // Best format counts only when at least 3 posts back it (same bar the Facebook screen uses).
  const bestFormat = dto.formats
    .filter((f) => f.posts >= 3 && finite(f.erMedian))
    .sort((a, b) => (b.erMedian as number) - (a.erMedian as number))[0];
  const net = dto.kpis.find((k) => k.key === 'followers')?.extra;

  return (
    <>
      <ChannelCards dto={dto} />
      <p class="m-0 text-[13px] text-[var(--color-text-muted)]">
        {dto.posts} bài trong {dto.days} ngày{dto.lastSnapshotAt ? ` · số liệu chụp lúc ${fmtSlot(dto.lastSnapshotAt)}` : ' · chưa có ảnh chụp chỉ số bài nào'}. So với {dto.days} ngày liền trước đó.
      </p>
      <div class="flex flex-wrap gap-4 items-start">
        <div class="flex-[2_1_520px] min-w-0 flex flex-col gap-3">
          <section aria-label="Chỉ số chính" class="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))' }}>
            {dto.kpis.slice(0, 4).map((k) => <SocialKpi key={k.key} k={k} />)}
          </section>
          <ReachChart daily={dto.reachDaily} />
        </div>

        <div class="flex-[1_1_300px] min-w-0 flex flex-col gap-3">
          <Card title="Điểm nhấn">
            <Highlight label="Trụ nội dung hiệu quả nhất">
              {dto.winner ? `${dto.winner}${finite(pillar?.erMedian) ? ` · ER ${fmtPct(pillar!.erMedian)}` : ''}` : <span class="font-normal text-[var(--color-text-muted)]">Chưa đủ bài để chọn trụ nổi bật.</span>}
            </Highlight>
            <Highlight label="Định dạng có ER cao nhất">
              {bestFormat ? `${FORMAT_META[bestFormat.format]?.label ?? bestFormat.format} · ${fmtInt(bestFormat.posts)} bài · ER ${fmtPct(bestFormat.erMedian)}` : <span class="font-normal text-[var(--color-text-muted)]">Chưa có định dạng nào đủ 3 bài để so.</span>}
            </Highlight>
            <Highlight label="Người theo dõi ròng">
              {finite(net) ? `${net >= 0 ? '+' : '−'}${fmtInt(Math.abs(net))} trong ${dto.days} ngày` : <span class="font-normal text-[var(--color-text-muted)]">Chưa có số theo dõi theo ngày.</span>}
            </Highlight>
          </Card>

          {dto.insight && (
            <section aria-label="Analyst tóm tắt" class="flex flex-col gap-2 p-4 rounded-xl border" style={{ background: 'var(--color-accent-soft)', borderColor: 'color-mix(in srgb, var(--color-accent) 40%, transparent)' }}>
              <h2 class="m-0 text-[14px] font-semibold" style={{ color: ACCENT_TEXT }}>Analyst tóm tắt</h2>
              <ol class="m-0 pl-[18px] list-decimal flex flex-col gap-1.5 text-[13.5px] leading-relaxed text-[var(--color-text)]">
                {dto.insight.summary.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
              <div class="text-[12px] text-[var(--color-text-muted)]">Cập nhật {fmtSlot(dto.insight.createdAt)}. Con số do hệ thống tính từ số liệu đã lưu, Analyst chỉ giải thích.</div>
              <Link href="/m/marketing/library" class={`${LINK_CLASS} text-[13px] self-start`}>Lên bài tuần sau theo gợi ý này</Link>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
