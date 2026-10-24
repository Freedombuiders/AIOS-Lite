import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Download, RefreshCw } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { useFetch } from '@/lib/useFetch';
import { usePageFocus } from '@/lib/page-context';
import {
  FORMAT_META,
  fmtCompact,
  fmtDec,
  fmtInt,
  fmtPct,
  type FbFormat,
  type PostsDashboardDto,
} from '@modules/marketing/web/lib/fbstudio';
import { Card, KpiTile, PageTabs, SetupNotice } from '@modules/marketing/web/components/fb/common';
import { WARN, axisCompact, dayKeyOfSec, dayLabel, deltaLabel, finite, isToday, toneColor } from '@/components/fb/charts/chart-utils';
import { BTN, BTN_PRIMARY, DashError, DashLoading, SELECT, useAnalyticsRefresh, useFbDashGate } from '@modules/marketing/web/components/fb/DashStates';
import { DailyBars } from '@/components/fb/charts/DailyBars';
import { PostsTable, sortRows, sourceLabel, type SortKey, type SortState } from '@modules/marketing/web/components/fb/posts/PostsTable';
import { PostDetail } from '@modules/marketing/web/components/fb/posts/PostDetail';

const RANGES = [7, 28, 90];
const MILESTONES: { key: PostsDashboardDto['milestone']; label: string }[] = [
  { key: 'latest', label: 'Hiện tại' },
  { key: '24h', label: '24 giờ' },
  { key: '7d', label: '7 ngày' },
  { key: '28d', label: '28 ngày' },
];

/** `tabs` is set when the page sits inside the Social hub: one compact header row carries the hub's tabs. */
export function FbPosts({ tabs }: { tabs?: ComponentChildren } = {}) {
  const gate = useFbDashGate();
  const [days, setDays] = useState(28);
  const [milestone, setMilestone] = useState<PostsDashboardDto['milestone']>('latest');
  const path = gate.pageId ? `/api/m/marketing/analytics/posts?page=${encodeURIComponent(gate.pageId)}&days=${days}&milestone=${milestone}` : null;
  const dash = useFetch<PostsDashboardDto>(gate.blocker ? null : path);
  const refresh = useAnalyticsRefresh(gate.pageId, () => dash.refresh());

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        compact={!!tabs}
        tabs={tabs}
        breadcrumb="Marketing · Facebook"
        title="Hiệu quả bài đăng"
        actions={
          !gate.blocker && (
            <button type="button" class={`${BTN} inline-flex items-center gap-1.5`} onClick={refresh.run} disabled={refresh.busy || !gate.pageId}>
              <RefreshCw size={13} class={refresh.busy ? 'animate-spin' : ''} /> Lấy số liệu mới
            </button>
          )
        }
      />
      <div class="flex-1 overflow-y-auto px-4 sm:px-6 py-5 flex flex-col gap-4">
        <p class="m-0 text-[13px] text-[var(--color-text-muted)] max-w-3xl">
          Bài được so ở cùng mốc tuổi với trung vị của Page, nên bài mới đăng không bị thiệt. Số liệu cập nhật mỗi đêm lúc 02:00.
        </p>
        {gate.blocker}
        {!gate.blocker && (
          <>
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
              <PageTabs pages={gate.pages} value={gate.pageId} onChange={gate.setPageId} />
              <label class="flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
                Khoảng
                <select class={SELECT} value={days} onChange={(e) => setDays(Number((e.target as HTMLSelectElement).value))}>
                  {RANGES.map((d) => <option key={d} value={d}>{d} ngày qua</option>)}
                </select>
              </label>
              <div role="group" aria-label="Mốc so sánh" class="flex items-center gap-2 text-[13px] text-[var(--color-text-muted)]">
                Mốc so sánh
                <div class="flex rounded-md border border-[var(--color-border-strong)] overflow-hidden">
                  {MILESTONES.map((m, i) => (
                    <button
                      key={m.key}
                      type="button"
                      aria-pressed={milestone === m.key}
                      onClick={() => setMilestone(m.key)}
                      class={`h-8 px-3 text-[12.5px] ${i > 0 ? 'border-l border-[var(--color-border-strong)]' : ''} ${milestone === m.key ? 'bg-[var(--color-accent-soft)] text-[var(--color-text)] font-semibold' : 'bg-[var(--color-card)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
              {milestone === 'latest' && <span class="text-[13px] text-[var(--color-text-muted)]">Số liệu tới hôm nay — bài mới đăng chưa đủ thời gian.</span>}
            </div>
            {dash.loading && !dash.data && <DashLoading />}
            {dash.error && !dash.data && <DashError error={dash.error} onRetry={dash.refresh} />}
            {dash.data && <PostsBody dto={dash.data} onRefresh={refresh.run} refreshing={refresh.busy} />}
          </>
        )}
      </div>
    </div>
  );
}

function DeltaText({ delta, unit, suffix = '' }: { delta: number | null; unit: 'pct' | 'pt' | 'count'; suffix?: string }) {
  const d = deltaLabel(delta, unit);
  if (!d) return <span class="text-[var(--color-text-muted)]">Chưa có kỳ trước để so</span>;
  return <span style={{ color: toneColor(d.sign > 0 ? 'good' : d.sign < 0 ? 'bad' : 'neutral') }}>{d.text}{suffix}</span>;
}

function exportCsv(dto: PostsDashboardDto, rows: PostsDashboardDto['rows']) {
  const esc = (v: string | number | null) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['Bài', 'Format', 'Tuyến', 'Nguồn', 'Đăng lúc', 'Reach', 'ER %', 'Chỉ số so với trung vị', 'Comment', 'Share', 'TB xem (giây)'];
  const lines = rows.map((r) => [
    r.title, FORMAT_META[r.format]?.label ?? r.format, r.pillar, sourceLabel(r.source),
    r.publishedAt ? new Date(r.publishedAt * 1000).toISOString() : '', r.reach, r.er, r.index, r.comments, r.shares, r.avgWatchS,
  ].map(esc).join(','));
  const blob = new Blob(['﻿' + [head.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bai-dang-${dto.page.name.replace(/\s+/g, '-')}-${dto.milestone}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function PostsBody({ dto, onRefresh, refreshing }: { dto: PostsDashboardDto; onRefresh: () => void; refreshing: boolean }) {
  const [format, setFormat] = useState<'all' | FbFormat>('all');
  const [sort, setSort] = useState<SortState>({ key: 'index', dir: 'desc' });
  const [selected, setSelected] = useState<string | null>(null);
  const [bar, setBar] = useState<number | null>(null);

  const onSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));
  const rows = sortRows(dto.rows.filter((r) => format === 'all' || r.format === format), sort);
  const selectedId = selected && rows.some((r) => r.postId === selected) ? selected : rows[0]?.postId ?? null;
  const selectedTitle = rows.find((r) => r.postId === selectedId)?.title;
  // The dock's agent reads this table and the selected post's detail.
  usePageFocus({
    fbPageId: dto.page.id, days: dto.days, milestone: dto.milestone, fbPostId: selectedId ?? undefined,
    label: `${dto.page.name} · ${dto.days} ngày${selectedTitle ? ` · “${selectedTitle.slice(0, 40)}”` : ''}`,
  });
  const present = Array.from(new Set(dto.rows.map((r) => r.format)));

  if (dto.kpis.posts === 0 && dto.rows.length === 0 && dto.reachDaily.every((d) => d.reach === null)) {
    return (
      <SetupNotice title="Chưa có bài nào để phân tích">
        <p class="m-0 mb-2">Trong {dto.days} ngày qua Page <strong>{dto.page.name}</strong> chưa có bài đã đăng hoặc chưa có ảnh chụp chỉ số. Hãy lấy dữ liệu từ Facebook, hoặc đăng bài từ Kho content rồi quay lại sau mốc 1 giờ đầu tiên.</p>
        <button type="button" class={BTN_PRIMARY} onClick={onRefresh} disabled={refreshing}>{refreshing ? 'Đang gửi yêu cầu…' : 'Lấy số liệu ngay'}</button>
      </SetupNotice>
    );
  }

  const k = dto.kpis;
  const msName = MILESTONES.find((m) => m.key === dto.milestone)?.label ?? dto.milestone;

  const rd = dto.reachDaily;
  const vals = rd.map((d) => d.reach);
  const nums = vals.filter(finite);
  const peak = nums.length ? vals.indexOf(Math.max(...nums)) : -1;
  const lastIdx = rd.length - 1;
  const partial = (i: number) => i === lastIdx && isToday(rd[i].day);
  let peakNote = '';
  if (peak >= 0) {
    const cause = dto.rows
      .filter((r) => r.publishedAt && dayKeyOfSec(r.publishedAt) === rd[peak].day)
      .sort((a, b) => (b.reach ?? 0) - (a.reach ?? 0))[0];
    peakNote = `Đỉnh ${dayLabel(rd[peak].day)}${cause ? ` nhờ “${cause.title}”` : ''}`;
  }
  const range = rd.length ? `${dayLabel(rd[0].day)} – ${dayLabel(rd[lastIdx].day)}` : '';

  return (
    <>
      <section aria-label="Chỉ số chính" class="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
        <KpiTile label="Bài đã đăng" value={fmtInt(k.posts)} delta={<DeltaText delta={k.postsDelta} unit="count" suffix=" bài so với kỳ trước" />} />
        <KpiTile label="Tổng reach theo ngày" value={fmtCompact(k.reach)} delta={<DeltaText delta={k.reachDeltaPct} unit="pct" suffix=" so với kỳ trước" />} />
        <KpiTile label={dto.milestone === 'latest' ? 'ER trung vị (hiện tại)' : `ER trung vị (mốc ${msName})`} value={fmtPct(k.erMedian)} delta={<DeltaText delta={k.erDeltaPt} unit="pt" />} />
        <KpiTile
          label="Comment"
          value={fmtCompact(k.comments)}
          delta={<><DeltaText delta={k.commentsDeltaPct} unit="pct" />{finite(k.aiReplyRate) && <span class="text-[var(--color-text-muted)]"> · {fmtDec(k.aiReplyRate, 0)}% được AI trả lời</span>}</>}
        />
      </section>

      <Card title={`Reach theo ngày${range ? `, ${range}` : ''}`} aside={<>{peakNote}{peakNote && ' · '}<button type="button" class="bg-transparent border-0 p-0 text-[var(--color-accent-hover)] underline underline-offset-2" onClick={() => document.getElementById('fb-bang-bai')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Xem dạng bảng</button></>}>
        {rd.length === 0 ? (
          <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Chưa có số liệu reach theo ngày.</p>
        ) : (
          <DailyBars
            groupLabel="Reach theo ngày"
            height={200}
            values={vals}
            labels={rd.map((d) => dayLabel(d.day))}
            active={bar}
            onActive={setBar}
            formatAxis={axisCompact}
            faded={partial}
            ariaOf={(i) => `${dayLabel(rd[i].day)}: ${vals[i] === null ? 'chưa có số liệu' : `reach ${fmtCompact(vals[i])}`}, ${rd[i].posts} bài${partial(i) ? ', hôm nay chưa đủ ngày' : ''}`}
            tooltip={(i) => (
              <>
                <div class="text-[14px] font-semibold tabular-nums text-[var(--color-text)]">{vals[i] === null ? '–' : fmtCompact(vals[i])}</div>
                <div class="text-[var(--color-text-muted)]">{dayLabel(rd[i].day)}{partial(i) ? ' (hôm nay, chưa đủ ngày)' : ''} · {rd[i].posts} bài</div>
              </>
            )}
          />
        )}
      </Card>

      <div class="flex flex-wrap gap-4 items-start">
        <section id="fb-bang-bai" aria-label="Bảng bài đăng" class="flex-[999_1_640px] min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] overflow-hidden">
          <div class="flex flex-wrap items-center justify-between gap-2 px-4 pt-3.5 pb-2">
            <h2 class="m-0 text-[14px] font-semibold text-[var(--color-text)]">Bài đăng, so với trung vị Page</h2>
            <div class="flex flex-wrap items-center gap-2">
              <label class="flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
                Format
                <select class={SELECT} value={format} onChange={(e) => setFormat((e.target as HTMLSelectElement).value as 'all' | FbFormat)}>
                  <option value="all">Tất cả</option>
                  {present.map((f) => <option key={f} value={f}>{FORMAT_META[f]?.label ?? f}</option>)}
                </select>
              </label>
              <button type="button" class={`${BTN} inline-flex items-center gap-1.5`} onClick={() => exportCsv(dto, rows)} disabled={rows.length === 0}>
                <Download size={13} /> Xuất CSV
              </button>
            </div>
          </div>
          {rows.length === 0 ? (
            <p class="m-0 px-4 py-6 text-[13px] text-[var(--color-text-muted)]">Không có bài nào {format === 'all' ? 'trong khoảng này' : `thuộc format ${FORMAT_META[format]?.label ?? format}`}. Thử mở rộng khoảng thời gian.</p>
          ) : (
            <PostsTable rows={rows} selectedId={selectedId} onSelect={setSelected} sort={sort} onSort={onSort} />
          )}
          {dto.rows.length > 0 && dto.milestone !== 'latest' && dto.rows.every((r) => r.er === null) && (
            <div class="px-4 pb-2 text-[13px]" style={{ color: WARN }}>
              Bài cũ chỉ có số liệu ‘Hiện tại’; mốc 24 giờ, 7 ngày, 28 ngày có cho bài đăng từ khi bật Content Studio.
            </div>
          )}
          <div class="px-4 py-2.5 text-[13px] text-[var(--color-text-muted)]">
            ER = (reaction + comment + share) ÷ reach, đo {dto.milestone === 'latest' ? 'tới hôm nay' : `ở mốc ${msName}`}. Vạch dọc trên thanh = trung vị của Page (×1,0). Hiển thị {rows.length} / {dto.rows.length} bài của {dto.page.name}.
          </div>
        </section>

        <aside aria-label="Chi tiết bài đang chọn" class="flex-[1_1_340px] min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
          {selectedId ? <PostDetail key={selectedId} postId={selectedId} /> : <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Chọn một bài trong bảng để xem đường reach theo mốc tuổi và nhận xét của Analyst.</p>}
        </aside>
      </div>
    </>
  );
}

