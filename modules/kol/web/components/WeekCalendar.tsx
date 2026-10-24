// Nội dung › Lịch tuần: 7 local-time columns (Monday first), posts as chips coloured by status.

import { useMemo } from 'preact/hooks';
import { ChevronLeft, ChevronRight } from 'lucide-preact';
import { BTN } from '@modules/kol/web/components/shared/ops-shared';
import { PlatformBadge } from '@/components/social/PlatformBadge';
import { toneColor } from '@modules/kol/web/components/ui';
import { POST_STATUS, dayKey, postSlot, postsByDay, weekDays, weekLabel, type PostDto } from '@modules/kol/web/lib/kol';

const DOW = ['Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ nhật'];
const pad = (n: number) => String(n).padStart(2, '0');

export function WeekCalendar({ posts, weekStart, onShift, onToday, onOpen }: {
  posts: PostDto[];
  weekStart: Date;
  onShift: (weeks: number) => void;
  onToday: () => void;
  onOpen: (post: PostDto) => void;
}) {
  const days = weekDays(weekStart);
  const byDay = useMemo(() => postsByDay(posts, weekStart), [posts, weekStart]);
  const today = dayKey(new Date());
  const unscheduled = posts.filter((p) => postSlot(p) === null && p.status !== 'cancelled').length;

  return (
    <div class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" aria-label="Tuần trước" class={`${BTN} w-9 px-0`} onClick={() => onShift(-1)}><ChevronLeft size={16} /></button>
        <span class="px-1 text-[14px] font-semibold tabular-nums" aria-live="polite">{weekLabel(weekStart)}</span>
        <button type="button" aria-label="Tuần sau" class={`${BTN} w-9 px-0`} onClick={() => onShift(1)}><ChevronRight size={16} /></button>
        <button type="button" class={BTN} onClick={onToday}>Tuần này</button>
        {unscheduled > 0 && <span class="ml-auto text-[12px] text-[var(--color-text-muted)]">{unscheduled} bài chưa có giờ (xem ở Danh sách)</span>}
      </div>
      <div class="grid grid-cols-1 md:grid-cols-7 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)] overflow-hidden" role="grid" aria-label={`Lịch tuần ${weekLabel(weekStart)}`}>
        {days.map((d, i) => {
          const k = dayKey(d);
          const list = byDay.get(k) ?? [];
          const isToday = k === today;
          return (
            <div key={k} role="gridcell" class={`min-h-[64px] md:min-h-[260px] p-1.5 flex flex-col gap-1 border-b md:border-b-0 md:border-r last:border-r-0 last:border-b-0 border-[var(--color-border)] min-w-0 ${isToday ? 'bg-[var(--color-accent-soft)]' : ''}`}>
              <div class="flex items-baseline gap-1.5 px-1 pb-1">
                <span class="text-[12px] text-[var(--color-text-muted)]">{DOW[i]}</span>
                <span class={`text-[13px] tabular-nums ${isToday ? 'font-bold text-[var(--color-accent)]' : 'font-medium text-[var(--color-text)]'}`}>{d.getDate()}/{d.getMonth() + 1}</span>
                {list.length > 0 && <span class="ml-auto text-[11px] text-[var(--color-text-faint)] md:hidden">{list.length} bài</span>}
              </div>
              {list.map((p) => {
                const st = POST_STATUS[p.status];
                const color = toneColor(st.tone);
                const s = postSlot(p)!;
                const t = new Date(s * 1000);
                const platforms = [...new Set(p.targets.map((x) => x.platform))];
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onOpen(p)}
                    aria-label={`${pad(t.getHours())}:${pad(t.getMinutes())}, ${p.title || 'Bài chưa đặt tên'}, ${st.label}`}
                    class="w-full text-left rounded-md border px-1.5 py-1 text-[12px] min-w-0 hover:brightness-110 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                    style={{
                      borderColor: `color-mix(in srgb, ${color} 55%, transparent)`,
                      background: `color-mix(in srgb, ${color} 12%, var(--color-card))`,
                      borderStyle: p.status === 'review' || p.status === 'draft' || p.status === 'idea' ? 'dashed' : 'solid',
                      opacity: p.status === 'cancelled' ? 0.55 : 1,
                    }}
                  >
                    <span class="flex items-center gap-1 min-w-0">
                      <span class="tabular-nums shrink-0 font-medium" style={{ color }}>{pad(t.getHours())}:{pad(t.getMinutes())}</span>
                      <span class="flex items-center gap-0.5 shrink-0">{platforms.map((pl) => <PlatformBadge key={pl} platform={pl} size={13} />)}</span>
                    </span>
                    <span class="block truncate text-[var(--color-text)]">{p.title || 'Bài chưa đặt tên'}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
