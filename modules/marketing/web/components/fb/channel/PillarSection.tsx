import { useState } from 'preact/hooks';
import { fmtDec, fmtInt, type ChannelDashboardDto, type PillarVerdict } from '@modules/marketing/web/lib/fbstudio';
import { Card } from '../common';
import { ACCENT_TEXT, SERIES, finite } from '@/components/fb/charts/chart-utils';
import { Legend } from '@/components/fb/charts/Legend';
import { Quadrant, type QuadrantPoint } from '@/components/fb/charts/Quadrant';

const VERDICT: Record<PillarVerdict, string> = {
  win: 'Thắng',
  promising: 'Hứa hẹn, ít mẫu',
  good: 'Tốt',
  keep: 'Giữ',
  fix: 'Sửa cách làm',
  cut: 'Giảm',
};

const COLS = '110px 50px minmax(160px, 1fr) 76px 64px 76px 130px';

export function PillarSection({ pillars, winner }: { pillars: ChannelDashboardDto['pillars']; winner: string | null }) {
  const [active, setActive] = useState<string | null>(null);
  const maxShare = Math.max(1, ...pillars.flatMap((p) => [p.postShare, p.interactionShare]));
  const rated = pillars.filter((p) => finite(p.index));
  const maxPost = Math.max(1, ...pillars.map((p) => p.postShare));
  const xMax = Math.max(20, Math.ceil((maxPost * 1.25) / 10) * 10);
  const evenShare = pillars.length ? 100 / pillars.length : 50;

  const points: QuadrantPoint[] = rated.map((p) => ({
    id: p.name,
    label: p.name,
    x: Math.min(92, Math.max(6, (p.postShare / xMax) * 100)),
    y: Math.min(94, Math.max(6, (1 - (p.index as number) / 2) * 100)),
    size: 14,
    aria: `${p.name}: ${fmtDec(p.postShare, 0)}% số bài, hiệu quả ×${fmtDec(p.index, 2)}`,
  }));
  const act = pillars.find((p) => p.name === active);

  return (
    <Card
      title={<>Tuyến content nào thắng{winner ? <> · <span style={{ color: ACCENT_TEXT }}>{winner}</span></> : <span class="font-normal text-[var(--color-text-muted)]"> · chưa có tuyến thắng (cần ít nhất 3 bài)</span>}</>}
      aside={<Legend items={[{ label: '% số bài', color: 'var(--color-text-faint)' }, { label: '% tương tác', color: SERIES }]} />}
    >
      {pillars.length === 0 ? (
        <p class="text-[13px] text-[var(--color-text-muted)] m-0">Chưa có bài nào gắn tuyến content trong khoảng này. Khi bài có tuyến, bảng đánh giá sẽ hiện ở đây.</p>
      ) : (
        <div class="flex flex-wrap gap-5">
          <div class="flex-[3_1_560px] min-w-0 overflow-x-auto">
            <div class="min-w-[640px] flex flex-col text-[13px]">
              <div class="grid gap-x-3 items-center text-[11.5px] text-[var(--color-text-muted)]" style={{ gridTemplateColumns: COLS }}>
                <span class="py-1.5">Tuyến</span>
                <span class="py-1.5 text-right">Số bài</span>
                <span class="py-1.5">Tỷ trọng bài và tương tác</span>
                <span class="py-1.5 text-right">Hiệu quả</span>
                <span class="py-1.5 text-right">ER TB</span>
                <span class="py-1.5 text-right">Cmt / bài</span>
                <span class="py-1.5">Đánh giá</span>
              </div>
              {pillars.map((r) => (
                <div
                  key={r.name}
                  class="grid gap-x-3 items-center border-t border-[var(--color-border)] tabular-nums"
                  style={{ gridTemplateColumns: COLS, background: active === r.name ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)' : undefined }}
                  onMouseEnter={() => setActive(r.name)}
                  onMouseLeave={() => setActive(null)}
                >
                  <span class="py-2.5 font-semibold text-[var(--color-text)]">{r.name}</span>
                  <span class="py-2.5 text-right">{fmtInt(r.posts)}</span>
                  <span class="py-2 flex flex-col gap-[3px]">
                    <span class="flex items-center gap-1.5">
                      <span class="h-2 rounded-r" style={{ width: `${(r.postShare / maxShare) * 100}%`, minWidth: '2px', background: 'var(--color-text-faint)' }} aria-hidden="true" />
                      <span class="text-[11.5px] text-[var(--color-text-muted)]">{fmtDec(r.postShare, 0)}%</span>
                    </span>
                    <span class="flex items-center gap-1.5">
                      <span class="h-2 rounded-r" style={{ width: `${(r.interactionShare / maxShare) * 100}%`, minWidth: '2px', background: SERIES }} aria-hidden="true" />
                      <span class="text-[11.5px] text-[var(--color-text)]">{fmtDec(r.interactionShare, 0)}%</span>
                    </span>
                  </span>
                  <span class="py-2.5 text-right font-semibold text-[var(--color-text)]">{finite(r.index) ? `×${fmtDec(r.index, 2)}` : '–'}</span>
                  <span class="py-2.5 text-right">{finite(r.erMedian) ? `${fmtDec(r.erMedian)}%` : '–'}</span>
                  <span class="py-2.5 text-right">{finite(r.commentsPerPost) ? fmtInt(r.commentsPerPost) : '–'}</span>
                  <span class="py-2">
                    <span
                      class="inline-flex items-center h-[22px] px-2.5 rounded-full text-[12px] font-medium whitespace-nowrap"
                      style={r.verdict === 'win'
                        ? { background: 'var(--color-accent-soft)', color: ACCENT_TEXT, border: '1px solid var(--color-accent)' }
                        : { background: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
                    >
                      {VERDICT[r.verdict]}
                    </span>
                  </span>
                </div>
              ))}
            </div>
            <p class="m-0 mt-2 text-[12px] text-[var(--color-text-muted)]">Hiệu quả = % tương tác ÷ % số bài. Trên ×1,0 là tuyến tạo nhiều tương tác hơn phần bài nó chiếm. Tuyến dưới 3 bài chỉ được gọi là “Hứa hẹn”.</p>
          </div>

          <div class="flex-[2_1_320px] min-w-0 flex flex-col gap-2">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <div class="text-[13px] font-semibold text-[var(--color-text)]">Khối lượng và hiệu quả</div>
              <span role="status" class="text-[12px] text-[var(--color-text-muted)]">
                {act ? `${act.name}: ${fmtDec(act.postShare, 0)}% số bài, ${finite(act.index) ? `×${fmtDec(act.index, 2)}` : 'chưa đủ dữ liệu'}` : ' '}
              </span>
            </div>
            {points.length === 0 ? (
              <p class="text-[12.5px] text-[var(--color-text-muted)] m-0">Chưa tuyến nào có chỉ số hiệu quả.</p>
            ) : (
              <Quadrant
                groupLabel="Ma trận khối lượng và hiệu quả của các tuyến content"
                points={points}
                active={active}
                onActive={setActive}
                quads={{ tl: 'Tăng thêm bài', tr: 'Giữ làm trụ cột', bl: 'Thử lại hoặc bỏ', br: 'Sửa cách làm' }}
                yLabels={{ top: '×2', mid: '×1', bottom: '0' }}
                xLabels={['0% số bài', `${fmtDec(xMax / 2, 0)}%`, `${fmtDec(xMax, 0)}%`]}
                xDivider={Math.min(96, (evenShare / xMax) * 100)}
              />
            )}
            <p class="m-0 text-[11.5px] text-[var(--color-text-muted)]">Đường dọc = mức chia đều giữa các tuyến. Đường ngang = ×1,0.</p>
          </div>
        </div>
      )}
    </Card>
  );
}
