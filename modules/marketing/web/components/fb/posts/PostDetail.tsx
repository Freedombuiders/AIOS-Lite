import { useState } from 'preact/hooks';
import { FORMAT_META, fmtCompact, fmtInt, fmtSlot, type Milestone, type PostDetailDto } from '@modules/marketing/web/lib/fbstudio';
import { useFetch } from '@/lib/useFetch';
import { ACCENT_TEXT, SERIES, axisCompact, finite, niceTicks } from '@/components/fb/charts/chart-utils';
import { DashError, DashLoading, LINK_CLASS } from '@modules/marketing/web/components/fb/DashStates';
import { Legend } from '@/components/fb/charts/Legend';
import { LineChart } from '@/components/fb/charts/LineChart';
import { fmtWatch } from './PostsTable';

const MILESTONE_LABEL: Record<Milestone, string> = { '1h': '1 giờ', '6h': '6 giờ', '24h': '24 giờ', '3d': '3 ngày', '7d': '7 ngày', '28d': '28 ngày' };
const MILESTONE_SEC: Record<Milestone, number> = { '1h': 3600, '6h': 21600, '24h': 86400, '3d': 259200, '7d': 604800, '28d': 2419200 };

function dayMonth(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div class="px-2.5 py-2 rounded-lg bg-[var(--color-elevated)] min-w-0">
      <dt class="text-[11.5px] text-[var(--color-text-muted)]">{label}</dt>
      <dd class="m-0 mt-0.5 text-[14px] font-semibold tabular-nums text-[var(--color-text)]">{value}</dd>
    </div>
  );
}

export function PostDetail({ postId }: { postId: string }) {
  const res = useFetch<PostDetailDto>(`/api/m/marketing/analytics/post/${encodeURIComponent(postId)}`);
  const [active, setActive] = useState<number | null>(null);
  const d = res.data;

  if (res.loading && !d) return <DashLoading label="Đang tải chi tiết bài…" />;
  if (res.error && !d) return <DashError error={res.error} onRetry={res.refresh} />;
  if (!d) return null;

  const labels = d.curve.map((c) => MILESTONE_LABEL[c.milestone]);
  const own = d.curve.map((c) => c.reach);
  const median = d.medianCurve.length ? d.curve.map((c) => d.medianCurve.find((m) => m.milestone === c.milestone)?.reach ?? null) : d.curve.map(() => null);
  const all = [...own, ...median].filter(finite);
  const ticks = niceTicks(0, all.length ? Math.max(...all) * 1.15 : 1, 4);
  const pending = d.curve.filter((c) => c.reach === null).map((c) => c.milestone);
  const hasCurve = own.some(finite);
  const readout = active !== null
    ? `${labels[active]}: bài này ${fmtCompact(own[active])}${finite(median[active]) ? ` · trung vị ${fmtCompact(median[active])}` : ''}`
    : null;
  const fmt = FORMAT_META[d.format]?.label ?? d.format;
  const s = d.stats;

  return (
    <div class="flex flex-col gap-3.5">
      <div>
        <div class="text-[12px] text-[var(--color-text-muted)]">{fmt}{d.pillar ? ` · ${d.pillar}` : ''}{d.publishedAt ? ` · ${fmtSlot(d.publishedAt)}` : ''}</div>
        <h2 class="m-0 mt-1 text-[15px] font-semibold text-[var(--color-text)] break-words">{d.title || '(không có tiêu đề)'}</h2>
        {d.permalink && <a href={d.permalink} target="_blank" rel="noopener noreferrer" class={`${LINK_CLASS} text-[12.5px]`}>Mở trên Facebook</a>}
      </div>

      <div class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-[12px] font-semibold text-[var(--color-text)]">Reach theo mốc tuổi bài</span>
          <Legend items={[{ label: 'Bài này', color: SERIES, kind: 'line' }, { label: 'Trung vị của Page', color: 'var(--color-text-faint)', kind: 'dash' }]} />
        </div>
        {hasCurve ? (
          <>
            <LineChart
              groupLabel="Reach của bài theo từng mốc tuổi, so với trung vị Page"
              labels={labels}
              allXLabels
              yTicks={ticks}
              fmtY={axisCompact}
              height={170}
              active={active}
              onActive={setActive}
              ariaOf={(i) => `${labels[i]}: ${finite(own[i]) ? `reach ${fmtCompact(own[i])}` : 'chưa tới mốc'}${finite(median[i]) ? `, trung vị ${fmtCompact(median[i])}` : ''}`}
              series={[
                { name: 'median', color: 'var(--color-text-faint)', dashed: true, values: median, noDots: true, endLabel: (() => { const m = [...median].reverse().find(finite); return m === undefined ? null : fmtCompact(m); })(), labelPos: 'below' },
                { name: 'own', color: SERIES, values: own, endLabel: (() => { const m = [...own].reverse().find(finite); return m === undefined ? null : fmtCompact(m); })() },
              ]}
            />
            <div role="status" class="min-h-[18px] text-[12px] text-[var(--color-text)] tabular-nums">{readout}</div>
          </>
        ) : (
          <p class="m-0 text-[12.5px] text-[var(--color-text-muted)]">Chưa có ảnh chụp reach cho bài này. Mốc đầu tiên (1 giờ sau khi đăng) sẽ xuất hiện khi worker chạy.</p>
        )}
        {hasCurve && pending.length > 0 && d.publishedAt && (
          <div class="text-[12px] text-[var(--color-text-muted)]">
            Mốc {pending.map((m) => MILESTONE_LABEL[m]).join(' và ')} sẽ có vào {pending.map((m) => dayMonth(d.publishedAt! + MILESTONE_SEC[m])).join(' và ')}.
          </div>
        )}
      </div>

      <dl class="m-0 grid grid-cols-2 gap-2">
        <Stat label="Lượt xem 3 giây" value={fmtCompact(s.views3s)} />
        <Stat label="Xem trung bình" value={finite(s.avgWatchS) ? (finite(s.videoLengthS) ? `${fmtWatch(s.avgWatchS)} / ${fmtWatch(s.videoLengthS)}` : fmtWatch(s.avgWatchS)) : '–'} />
        <Stat label="Follow mới từ bài" value={fmtInt(s.follows)} />
        <Stat label="Share" value={fmtInt(s.shares)} />
        <Stat label="Comment" value={fmtInt(s.comments)} />
        <Stat label="AI đã trả lời" value={finite(s.comments) ? `${fmtInt(s.commentsReplied ?? 0)} / ${fmtInt(s.comments)}` : '–'} />
      </dl>

      <div class="p-3 rounded-lg flex flex-col gap-1.5 border" style={{ background: 'var(--color-accent-soft)', borderColor: 'color-mix(in srgb, var(--color-accent) 40%, transparent)' }}>
        <div class="text-[12px] font-semibold" style={{ color: ACCENT_TEXT }}>Nhận xét của Analyst</div>
        <p class="m-0 text-[13px] leading-relaxed text-[var(--color-text)]">
          {d.note ?? 'Analyst chưa có nhận xét cho bài này. Hệ thống chỉ ghi chú cho 3 bài tốt nhất của mỗi Page.'}
        </p>
      </div>
    </div>
  );
}
