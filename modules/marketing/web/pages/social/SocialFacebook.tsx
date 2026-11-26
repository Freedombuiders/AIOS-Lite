import { useState } from 'preact/hooks';
import { useFetch } from '@/lib/useFetch';
import { usePageFocus } from '@/lib/page-context';
import { SERIES, WARN, finite } from '@/components/fb/charts/chart-utils';
import { Funnel, type FunnelStep } from '@/components/fb/charts/Funnel';
import { RowBars, type BarRow } from '@/components/fb/charts/RowBars';
import {
  fmtCompact,
  fmtDec,
  fmtInt,
  fmtPct,
  type ChannelDashboardDto,
  type PostsDashboardDto,
} from '@modules/marketing/web/lib/fbstudio';
import { Card, FormatChip, SetupNotice } from '@modules/marketing/web/components/fb/common';
import { BTN_PRIMARY, DashError, DashLoading, useAnalyticsRefresh, useFbDashGate } from '@modules/marketing/web/components/fb/DashStates';
import { DAYS, HeatGrid, SLOTS } from '@modules/marketing/web/components/fb/channel/HeatGrid';
import { SocialPostsTable } from '@modules/marketing/web/components/social/SocialPostsTable';
import { AbsentNote, SocialKpi, SocialShell, SrTable, useSocialDays } from '@modules/marketing/web/components/social/social-ui';

type Milestone = PostsDashboardDto['milestone'];
const MILESTONES: { key: Milestone; label: string }[] = [
  { key: 'latest', label: 'Hiện tại' },
  { key: '24h', label: '24 giờ' },
  { key: '7d', label: '7 ngày' },
  { key: '28d', label: '28 ngày' },
];

/** Mạng xã hội › Facebook: six KPIs, funnel, ER by format, "giờ vàng" heatmap and the post table. */
export function SocialFacebook() {
  const gate = useFbDashGate();
  const [days, setDays] = useSocialDays();
  const [milestone, setMilestone] = useState<Milestone>('latest');
  const q = gate.pageId ? `page=${encodeURIComponent(gate.pageId)}&days=${days}` : null;
  const channel = useFetch<ChannelDashboardDto>(gate.blocker || !q ? null : `/api/m/marketing/analytics/channel?${q}`);
  const posts = useFetch<PostsDashboardDto>(gate.blocker || !q ? null : `/api/m/marketing/analytics/posts?${q}&milestone=${milestone}`);
  const refresh = useAnalyticsRefresh(gate.pageId, () => { channel.refresh(); posts.refresh(); });

  return (
    <SocialShell active="facebook" gate={gate} days={days} onDays={setDays} onRefresh={refresh.run} refreshing={refresh.busy}>
      {channel.loading && !channel.data && <DashLoading />}
      {channel.error && !channel.data && <DashError error={channel.error} onRetry={channel.refresh} />}
      {channel.data && (
        <FacebookBody dto={channel.data} posts={posts.data} postsLoading={posts.loading && !posts.data} postsError={posts.error} milestone={milestone} onMilestone={setMilestone} onRefresh={refresh.run} refreshing={refresh.busy} onRetryPosts={posts.refresh} />
      )}
    </SocialShell>
  );
}

function FacebookBody({ dto, posts, postsLoading, postsError, milestone, onMilestone, onRefresh, refreshing, onRetryPosts }: {
  dto: ChannelDashboardDto;
  posts: PostsDashboardDto | null;
  postsLoading: boolean;
  postsError: string | null;
  milestone: Milestone;
  onMilestone: (m: Milestone) => void;
  onRefresh: () => void;
  refreshing: boolean;
  onRetryPosts: () => void;
}) {
  usePageFocus({ fbPageId: dto.page.id, days: dto.days, milestone, label: `${dto.page.name} · ${dto.days} ngày` });

  const noData = dto.lastSnapshotAt === null && dto.posts === 0 && dto.reachDaily.every((d) => d.reach === null) && !finite(dto.page.followers);
  if (noData) {
    return (
      <SetupNotice title="Chưa có số liệu cho Page này">
        <p class="m-0 mb-2">Chưa lấy bài và chỉ số của <strong>{dto.page.name}</strong> từ Facebook. Bấm nút dưới để nhập bài đăng và chụp chỉ số đầu tiên; sau đó hệ thống tự cập nhật mỗi đêm.</p>
        <button type="button" class={BTN_PRIMARY} onClick={onRefresh} disabled={refreshing}>{refreshing ? 'Đang gửi yêu cầu…' : 'Lấy số liệu ngay'}</button>
      </SetupNotice>
    );
  }

  // Funnel: widths are relative to the first step that has a number; a missing step has no bar.
  const firstStep = dto.funnel.find((s) => finite(s.value) && s.value > 0)?.value ?? null;
  const steps: FunnelStep[] = dto.funnel.map((s, i) => {
    const prev = i > 0 ? dto.funnel[i - 1].value : null;
    return {
      key: s.key,
      label: s.label,
      valueText: fmtCompact(s.value),
      ratio: finite(s.value) && finite(firstStep) ? s.value / firstStep : null,
      note: !finite(s.value)
        ? 'Chưa có số liệu cho bước này.'
        : i === 0 ? 'Mốc gốc' : finite(prev) && prev > 0 ? `${fmtPct((s.value / prev) * 100)} của bước trước` : 'Chưa có bước trước để so.',
    };
  });
  const reachStep = dto.funnel.find((s) => s.key === 'reach')?.value ?? null;
  const actionStep = dto.funnel.find((s) => s.key === 'actions')?.value ?? null;
  const per100 = finite(reachStep) && reachStep > 0 && finite(actionStep) ? (actionStep / reachStep) * 100 : null;

  // ER by format: a format without posts is an empty track, one with fewer than 3 posts is faded.
  const maxEr = Math.max(0.1, ...dto.formats.map((f) => f.erMedian ?? 0));
  const formatRows: BarRow[] = dto.formats.map((f) => ({
    key: f.format,
    label: <FormatChip format={f.format} />,
    ratio: f.posts > 0 && finite(f.erMedian) ? f.erMedian / maxEr : null,
    color: SERIES,
    opacity: f.posts === 0 ? 0.55 : f.posts < 3 ? 0.55 : 1,
    main: f.posts > 0 && finite(f.erMedian) ? fmtPct(f.erMedian) : '–',
    sub: f.posts === 0 ? 'chưa có bài' : f.posts < 3 ? `${f.posts} bài, chưa đủ kết luận` : `${f.posts} bài`,
    title: f.posts === 0 ? 'Chưa có bài nào ở định dạng này trong khoảng đã chọn' : f.posts < 3 ? 'Dưới 3 bài, chưa đủ để kết luận' : `ER trung vị ${fmtPct(f.erMedian)} trên ${f.posts} bài`,
  }));

  const heatAt = (d: number, s: number) => dto.heat.find((c) => c.weekday === d && c.slot === s);
  const heatHasData = dto.heat.some((c) => finite(c.er));

  const msLabel = MILESTONES.find((m) => m.key === milestone)?.label ?? milestone;

  return (
    <>
      <p class="m-0 text-[13px] text-[var(--color-text-muted)]">
        {dto.page.name} · {dto.posts} bài trong {dto.days} ngày, so với {dto.days} ngày liền trước đó. Số liệu cập nhật mỗi đêm.
      </p>

      <section aria-label="Chỉ số chính" class="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))' }}>
        {dto.kpis.map((k) => <SocialKpi key={k.key} k={k} />)}
      </section>

      <div class="flex flex-wrap gap-4 items-start">
        <Card class="flex-[1_1_300px]" title="Phễu tương tác">
          <Funnel steps={steps} />
          <SrTable caption="Phễu tương tác" columns={['Bước', 'Số lượng']} rows={dto.funnel.map((s) => [s.label, finite(s.value) ? fmtInt(s.value) : null])} />
          {finite(per100)
            ? <AbsentNote>Cứ 100 người thấy bài thì khoảng {fmtDec(per100, 1)} người bấm link hoặc nhắn tin.</AbsentNote>
            : <AbsentNote>Chưa đủ số liệu reach và lượt bấm link, nhắn tin để tính tỷ lệ này.</AbsentNote>}
        </Card>

        <Card class="flex-[1_1_300px]" title="ER trung vị theo định dạng">
          <RowBars rows={formatRows} labelWidth={84} />
          <SrTable caption="ER trung vị theo định dạng" columns={['Định dạng', 'ER trung vị', 'Số bài']} rows={dto.formats.map((f) => [f.format, f.posts > 0 && finite(f.erMedian) ? fmtPct(f.erMedian) : null, f.posts])} />
          <AbsentNote>ER = (cảm xúc + bình luận + chia sẻ) ÷ reach. Định dạng dưới 3 bài chưa đủ để kết luận.</AbsentNote>
        </Card>

        <Card class="flex-[2_1_440px]" title="Giờ vàng">
          {heatHasData ? <HeatGrid heat={dto.heat} /> : <AbsentNote>Chưa có ô nào đủ dữ liệu. Giờ vàng hiện sau khi có bài đã đăng và có số đo.</AbsentNote>}
          <SrTable
            caption="ER trung vị theo thứ và khung giờ đăng. Ô trống nghĩa là chưa đăng bài."
            columns={['Thứ', ...SLOTS.map((s) => `${s} giờ`)]}
            rows={DAYS.map((day, d) => [day, ...SLOTS.map((_, s) => { const c = heatAt(d, s); return c && finite(c.er) ? `${fmtDec(c.er)}% (${c.posts} bài)` : null; })])}
          />
        </Card>
      </div>

      <section aria-labelledby="social-posts-title" class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] overflow-hidden min-w-0">
        <div class="flex flex-wrap items-center justify-between gap-2 px-4 pt-3.5 pb-2">
          <h2 id="social-posts-title" class="m-0 text-[14px] font-semibold text-[var(--color-text)]">Hiệu quả bài đăng</h2>
          <div role="group" aria-label="Mốc đo" class="flex items-center gap-2 text-[13px] text-[var(--color-text-muted)]">
            Mốc đo
            <div class="flex rounded-md border border-[var(--color-border-strong)] overflow-hidden">
              {MILESTONES.map((m, i) => (
                <button
                  key={m.key}
                  type="button"
                  aria-pressed={milestone === m.key}
                  onClick={() => onMilestone(m.key)}
                  class={`h-8 px-3 text-[12.5px] ${i > 0 ? 'border-l border-[var(--color-border-strong)]' : ''} ${milestone === m.key ? 'bg-[var(--color-accent-soft)] text-[var(--color-text)] font-semibold' : 'bg-[var(--color-card)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <p class="m-0 px-4 pb-2 text-[13px] text-[var(--color-text-muted)]">
          {milestone === 'latest' ? 'Số liệu tới hôm nay; bài mới đăng chưa đủ thời gian.' : `Số đo ở mốc ${msLabel} sau khi đăng; bài chưa tới mốc hoặc chưa đo được hiện dấu “–”.`}
        </p>
        {postsLoading && <DashLoading />}
        {postsError && !posts && <div class="px-4 pb-4"><DashError error={postsError} onRetry={onRetryPosts} /></div>}
        {posts && posts.rows.length === 0 && (
          <p class="m-0 px-4 py-5 text-[13px] text-[var(--color-text-muted)]">Chưa có bài nào đã đăng trong {dto.days} ngày qua.</p>
        )}
        {posts && posts.rows.length > 0 && <SocialPostsTable rows={posts.rows} />}
        {posts && posts.rows.length > 0 && milestone !== 'latest' && posts.rows.every((r) => r.er === null) && (
          <div class="px-4 py-2 text-[13px]" style={{ color: WARN }}>
            Bài cũ chỉ có số liệu “Hiện tại”; mốc 24 giờ, 7 ngày, 28 ngày có cho bài đăng từ khi bật Content Studio.
          </div>
        )}
        <div class="px-4 py-2.5 text-[13px] text-[var(--color-text-muted)]">
          ER = (cảm xúc + bình luận + chia sẻ) ÷ reach. “So với trung vị trang” so ở cùng mốc tuổi bài. Dấu “–” là chưa có số liệu, không phải 0.
        </div>
      </section>
    </>
  );
}
