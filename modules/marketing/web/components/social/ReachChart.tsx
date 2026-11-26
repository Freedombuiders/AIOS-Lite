import { useState } from 'preact/hooks';
import { DailyBars } from '@/components/fb/charts/DailyBars';
import { axisCompact, dayLabel, finite, isToday } from '@/components/fb/charts/chart-utils';
import { fmtCompact, fmtInt, type ChannelDashboardDto } from '@modules/marketing/web/lib/fbstudio';
import { Card } from '@modules/marketing/web/components/fb/common';
import { AbsentNote, SrTable } from './social-ui';

/**
 * Reach per day (one hue). Every column is a focusable button with a spoken
 * value, hover or focus shows a tooltip, and a table with the same numbers is
 * there for screen readers. A day without a number is a gap, never a zero bar.
 */
export function ReachChart({ daily, title = 'Reach mỗi ngày trên Facebook' }: { daily: ChannelDashboardDto['reachDaily']; title?: string }) {
  const [active, setActive] = useState<number | null>(null);
  const vals = daily.map((d) => d.reach);
  const nums = vals.filter(finite);
  const last = daily.length - 1;
  const partial = (i: number) => i === last && isToday(daily[i].day);
  const peak = nums.length ? vals.indexOf(Math.max(...nums)) : -1;
  const summary = peak >= 0
    ? `Cao nhất ${fmtInt(vals[peak])} người, ngày ${dayLabel(daily[peak].day)}`
    : 'Chưa có số liệu reach theo ngày';
  const missing = vals.length - nums.length;
  const description = `Biểu đồ cột: số người thấy bài mỗi ngày trong ${daily.length} ngày. ${summary}.${missing > 0 ? ` ${missing} ngày chưa có số liệu.` : ''} Bảng số liệu nằm ngay dưới biểu đồ.`;

  return (
    <Card title={title} aside={<span role="status">{summary}</span>}>
      {nums.length === 0 ? (
        <AbsentNote>Facebook chưa trả số reach theo ngày cho khoảng này. Bấm “Lấy số liệu mới” rồi quay lại sau vài phút.</AbsentNote>
      ) : (
        <>
          <div aria-describedby="social-reach-desc">
            <DailyBars
              groupLabel="Reach theo ngày"
              values={vals}
              labels={daily.map((d) => dayLabel(d.day))}
              active={active}
              onActive={setActive}
              formatAxis={axisCompact}
              faded={partial}
              ariaOf={(i) => `${dayLabel(daily[i].day)}: ${vals[i] === null ? 'chưa có số liệu' : `${fmtInt(vals[i])} người thấy bài`}${partial(i) ? ', hôm nay chưa đủ ngày' : ''}`}
              tooltip={(i) => (
                <>
                  <div class="text-[14px] font-semibold tabular-nums text-[var(--color-text)]">{vals[i] === null ? 'Chưa có số liệu' : `${fmtCompact(vals[i])} người`}</div>
                  <div class="text-[var(--color-text-muted)]">{dayLabel(daily[i].day)}{partial(i) ? ' (hôm nay, chưa đủ ngày)' : ''}</div>
                </>
              )}
            />
          </div>
          <p id="social-reach-desc" class="sr-only">{description}</p>
          <SrTable
            caption={`Reach mỗi ngày, ${daily.length} ngày`}
            columns={['Ngày', 'Số người thấy bài']}
            rows={daily.map((d) => [dayLabel(d.day), d.reach === null ? null : fmtInt(d.reach)])}
          />
        </>
      )}
    </Card>
  );
}
