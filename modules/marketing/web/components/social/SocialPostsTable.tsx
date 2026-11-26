import { WARN, finite } from '@/components/fb/charts/chart-utils';
import { fmtCompact, fmtDec, fmtInt, fmtPct, fmtSlot, type PostsDashboardDto } from '@modules/marketing/web/lib/fbstudio';
import { FormatChip } from '@modules/marketing/web/components/fb/common';
import { fmtWatch, sourceLabel } from '@modules/marketing/web/components/fb/posts/PostsTable';

type Row = PostsDashboardDto['rows'][number];

/** "×1,4" against the Page median at the same milestone; absent stays "–". */
function vsMedian(index: number | null) {
  if (!finite(index)) return <span class="text-[var(--color-text-muted)]">–</span>;
  const tone = index >= 1.1 ? 'color-mix(in srgb, #22c55e 55%, var(--color-text))' : index <= 0.9 ? WARN : 'var(--color-text-muted)';
  const word = index >= 1.1 ? 'cao hơn' : index <= 0.9 ? 'thấp hơn' : 'ngang';
  return <span style={{ color: tone }}>×{fmtDec(index, 1)} · {word} trung vị</span>;
}

const TH = 'px-3 py-2.5 text-[12px] font-semibold text-[var(--color-text-muted)] whitespace-nowrap border-b border-[var(--color-border)]';
const TD = 'px-3 py-2.5 border-b border-[var(--color-border)] align-middle';

/** Post table of the Facebook screen. A real table, newest post first; a number the API lacks is "–". */
export function SocialPostsTable({ rows }: { rows: Row[] }) {
  const sorted = [...rows].sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  return (
    <div class="overflow-x-auto">
      <table class="w-full min-w-[860px] border-collapse text-[13px] tabular-nums">
        <caption class="sr-only">Hiệu quả bài đăng. Dấu gạch ngang nghĩa là chưa có số liệu.</caption>
        <thead>
          <tr>
            <th scope="col" class={`${TH} text-left`}>Bài</th>
            <th scope="col" class={`${TH} text-left`}>Định dạng</th>
            <th scope="col" class={`${TH} text-left`}>Đăng lúc</th>
            <th scope="col" class={`${TH} text-right`}>Reach</th>
            <th scope="col" class={`${TH} text-right`}>ER</th>
            <th scope="col" class={`${TH} text-left`}>So với trung vị trang</th>
            <th scope="col" class={`${TH} text-right`}>Bình luận</th>
            <th scope="col" class={`${TH} text-right`}>Chia sẻ</th>
            <th scope="col" class={`${TH} text-right`}>TB xem</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.postId}>
              <th scope="row" class={`${TD} max-w-[320px] text-left font-normal`}>
                <span class="block font-semibold text-[var(--color-text)] truncate">{r.title || '(không có tiêu đề)'}</span>
                <span class="block text-[12px] text-[var(--color-text-muted)] truncate">{r.pillar || 'Chưa gắn trụ'} · {sourceLabel(r.source)}</span>
              </th>
              <td class={`${TD} whitespace-nowrap`}><FormatChip format={r.format} /></td>
              <td class={`${TD} whitespace-nowrap`}>{fmtSlot(r.publishedAt)}</td>
              <td class={`${TD} text-right`}>{fmtCompact(r.reach)}</td>
              <td class={`${TD} text-right`}>{fmtPct(r.er)}</td>
              <td class={`${TD} whitespace-nowrap`}>{vsMedian(r.index)}</td>
              <td class={`${TD} text-right`}>{fmtInt(r.comments)}</td>
              <td class={`${TD} text-right`}>{fmtInt(r.shares)}</td>
              <td class={`${TD} text-right`}>{finite(r.avgWatchS) ? fmtWatch(r.avgWatchS) : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
