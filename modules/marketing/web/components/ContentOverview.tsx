// Tổng quan section "Hiệu quả nội dung": body only, the overview slot draws the card, title and link.
import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { OvKpi, OvKpis } from '@/components/overview/OvKpi';
import { DailyBars } from '@/components/fb/charts/DailyBars';
import { RowBars } from '@/components/fb/charts/RowBars';
import { SERIES, axisCompact, dayLabel } from '@/components/fb/charts/chart-utils';
import { fmtCount, fmtRate } from '@/lib/overview-format';
import { useFetch } from '@/lib/useFetch';
import type { OverviewRange } from '@/module-host/contracts';

interface Period {
  posts: number;
  reach: number | null;
  interactions: number | null;
  engagementRate: number | null;
  clicks: number | null;
  commentsReceived: number | null;
  commentsReplied: number | null;
  postsWithMetrics: number;
}
export interface MarketingOverviewDto {
  current: Period;
  previous: Period;
  dailyBasis: 'post-publish-day';
  daily: { day: string; posts: number; reach: number | null; interactions: number | null }[];
  topPosts: { postId: string; pageName: string; snippet: string; publishedAt: number; reach: number | null; interactions: number; permalink: string }[];
  pages: { pageId: string; pageName: string; posts: number; reach: number | null; interactions: number | null }[];
  metricsFetchedAt: number | null;
  hasPages: boolean;
}

type Metric = 'reach' | 'interactions';
const METRIC_LABEL: Record<Metric, string> = { reach: 'Lượt tiếp cận', interactions: 'Tương tác' };
const MUTED = 'text-[var(--color-text-muted)]';

function when(sec: number): string {
  return new Date(sec * 1000).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function ContentOverview({ range }: { range: OverviewRange }) {
  const q = `from=${range.from}&to=${range.to}&prevFrom=${range.prevFrom}&prevTo=${range.prevTo}`;
  const { data, error } = useFetch<MarketingOverviewDto>(`/api/m/marketing/overview?${q}`, 120_000);
  const [metric, setMetric] = useState<Metric>('reach');
  const [active, setActive] = useState<number | null>(null);
  const [activePosts, setActivePosts] = useState<number | null>(null);

  if (error && !data) return <div class={`text-sm ${MUTED}`}>Chưa đọc được số liệu nội dung.</div>;
  if (!data) return <div class={`text-sm ${MUTED}`}>Đang tải…</div>;
  if (!data.hasPages) return <div class={`text-sm ${MUTED}`}>Chưa kết nối Fanpage nào. <Link href="/m/marketing" class="underline">Mở màn Pages</Link></div>;
  if (data.current.posts === 0) {
    return <div class={`text-sm ${MUTED}`}>Chưa có bài nào được đăng trong {range.days} ngày này. <Link href="/m/marketing" class="underline">Mở màn Pages</Link></div>;
  }

  const c = data.current;
  const p = data.previous;
  const labels = data.daily.map((d) => dayLabel(d.day));
  const values = data.daily.map((d) => (metric === 'reach' ? d.reach : d.interactions));
  const postsPerDay = data.daily.map((d) => d.posts);
  const maxPageReach = Math.max(1, ...data.pages.map((x) => x.interactions ?? 0));
  const replied = c.commentsReceived === null ? '—' : `${fmtCount(c.commentsReceived)} / ${fmtCount(c.commentsReplied)}`;

  return (
    <div>
      <OvKpis>
        <OvKpi label="Bài đã đăng" value={fmtCount(c.posts)} cur={c.posts} prev={p.posts} />
        <OvKpi label="Lượt tiếp cận" value={fmtCount(c.reach)} cur={c.reach} prev={p.reach} hint="Tổng của các bài" />
        <OvKpi label="Tương tác" value={fmtCount(c.interactions)} cur={c.interactions} prev={p.interactions} hint="Cảm xúc + bình luận + chia sẻ" />
        <OvKpi label="Tỉ lệ tương tác" value={fmtRate(c.engagementRate)} cur={c.engagementRate} prev={p.engagementRate} hint="Tương tác ÷ tiếp cận" />
        <OvKpi label="Bình luận / AI đã trả lời" value={replied} cur={c.commentsReceived} prev={p.commentsReceived} hint={c.commentsReceived === null ? 'Chưa đồng bộ bình luận' : undefined} />
      </OvKpis>
      <div class="ov-grid">
        <div class="min-w-0 flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <p class="ov-sub" style={{ margin: 0 }}>{METRIC_LABEL[metric]} của các bài, theo ngày đăng</p>
            <div role="group" aria-label="Chọn số liệu" class="inline-flex gap-1">
              {(['reach', 'interactions'] as Metric[]).map((m) => (
                <button key={m} type="button" aria-pressed={metric === m} onClick={() => setMetric(m)}
                  class={`px-2.5 py-1 rounded-md text-[12px] border border-[var(--color-border)] ${metric === m ? 'bg-[var(--color-elevated)] text-[var(--color-text)] font-semibold' : MUTED}`}>
                  {METRIC_LABEL[m]}
                </button>
              ))}
            </div>
          </div>
          <DailyBars
            values={values} labels={labels} active={active} onActive={setActive} formatAxis={axisCompact}
            groupLabel={`${METRIC_LABEL[metric]} theo ngày đăng`} barMax={28}
            ariaOf={(i) => `${labels[i]}: ${fmtCount(values[i])} ${METRIC_LABEL[metric].toLowerCase()}, ${postsPerDay[i]} bài`}
            tooltip={(i) => (<><strong>{labels[i]}</strong><div>{METRIC_LABEL[metric]}: {fmtCount(values[i])}</div><div>{postsPerDay[i]} bài đăng</div></>)}
          />
          <p class="ov-sub" style={{ margin: '4px 0 0' }}>Số bài đăng mỗi ngày</p>
          <DailyBars
            values={postsPerDay} labels={labels} active={activePosts} onActive={setActivePosts} formatAxis={axisCompact}
            groupLabel="Số bài đăng theo ngày" height={70} barMax={28}
            ariaOf={(i) => `${labels[i]}: ${postsPerDay[i]} bài`}
            tooltip={(i) => (<><strong>{labels[i]}</strong><div>{postsPerDay[i]} bài</div></>)}
          />
          <p class={`text-[11.5px] m-0 ${MUTED}`}>
            Số liệu của mỗi bài tính đến lần cập nhật gần nhất{data.metricsFetchedAt ? ` (${when(data.metricsFetchedAt)})` : ''}, gán vào ngày bài được đăng.
            {c.postsWithMetrics < c.posts ? ` ${c.posts - c.postsWithMetrics} bài chưa có số liệu.` : ''}
          </p>
        </div>
        <div class="min-w-0 flex flex-col gap-4">
          <div>
            <p class="ov-sub">Top 5 bài theo tương tác</p>
            {data.topPosts.length === 0 ? <div class={`text-[13px] ${MUTED}`}>Chưa có số liệu tương tác.</div> : (
              <ol class="m-0 p-0 list-none flex flex-col gap-2">
                {data.topPosts.map((t, i) => (
                  <li key={t.postId} class="text-[13px] min-w-0">
                    <div class="flex gap-2 min-w-0">
                      <span class={`shrink-0 tabular-nums ${MUTED}`}>{i + 1}.</span>
                      {t.permalink ? <a href={t.permalink} target="_blank" rel="noreferrer" class="truncate underline-offset-2 hover:underline">{t.snippet}</a> : <span class="truncate">{t.snippet}</span>}
                    </div>
                    <div class={`pl-5 text-[11.5px] ${MUTED}`}>
                      {t.pageName} · {when(t.publishedAt)} · tiếp cận {fmtCount(t.reach)} · <strong class="text-[var(--color-text)]">{fmtCount(t.interactions)}</strong> tương tác
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div>
            <p class="ov-sub">Tương tác theo Page</p>
            <RowBars
              labelWidth={110}
              rows={data.pages.map((x) => ({
                key: x.pageId, label: <span class="truncate block" title={x.pageName}>{x.pageName}</span>,
                ratio: x.interactions === null ? null : x.interactions / maxPageReach, color: SERIES,
                main: fmtCount(x.interactions), sub: `${x.posts} bài · ${fmtCount(x.reach)} tiếp cận`,
              }))}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
