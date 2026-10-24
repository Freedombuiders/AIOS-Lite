import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { ChevronLeft, ChevronRight } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PostSheet } from '@modules/marketing/web/components/fb/calendar/PostSheet';
import {
  apiFail, BTN, FbReadiness, FetchError, FilterChip, NoPageNotice, useFbPages,
} from '@modules/marketing/web/components/fb/ops-shared';
import { apiPatch } from '@/lib/api';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import { PlatformBadge } from '@/components/social/PlatformBadge';
import { PLATFORMS, platformMeta, type SocialPlatform } from '@/lib/social-platforms';
import { FORMAT_META, STATUS_META, type FbContentDto, type FbFormat } from '@modules/marketing/web/lib/fbstudio';

const DOW = ['Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ nhật'];
const pad = (n: number) => String(n).padStart(2, '0');
const monthKey = (y: number, m: number) => `${y}-${pad(m + 1)}`;
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The moment an item sits on the calendar. */
const slotOf = (c: FbContentDto): number | null =>
  (c.status === 'published' ? c.publishedAt ?? c.scheduledAt : c.scheduledAt ?? c.publishedAt) ?? null;

function itemStyle(c: FbContentDto): { border: string; bg: string; fg: string; mark: string; markFg: string; dashed: boolean } {
  switch (c.status) {
    case 'published':
      return { border: 'var(--color-border)', bg: 'var(--color-sidebar)', fg: 'var(--color-text-muted)', mark: '✓', markFg: 'var(--color-status-done)', dashed: false };
    case 'missed':
    case 'failed':
      return { border: 'color-mix(in srgb, var(--color-status-failed) 55%, transparent)', bg: 'color-mix(in srgb, var(--color-status-failed) 8%, transparent)', fg: 'var(--color-status-failed)', mark: '!', markFg: 'var(--color-status-failed)', dashed: false };
    case 'review':
    case 'draft':
    case 'idea':
      return { border: 'var(--color-accent)', bg: 'var(--color-accent-soft)', fg: 'var(--color-text)', mark: '', markFg: 'var(--color-accent-hover)', dashed: true };
    default:
      return { border: 'var(--color-border-strong)', bg: 'var(--color-elevated)', fg: 'var(--color-text)', mark: '', markFg: '#a9d8ff', dashed: false };
  }
}

/** `tabs` is set when the page sits inside the Social hub: one compact header row carries the hub's tabs. */
export function FbCalendar({ tabs }: { tabs?: ComponentChildren } = {}) {
  const now = new Date();
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [pageId, setPageId] = useState('');
  const [platform, setPlatform] = useState<SocialPlatform | ''>('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);

  const { pages, enabledPages, loading: pagesLoading, error: pagesError } = useFbPages();
  const path = `/api/m/marketing/calendar?month=${monthKey(cursor.y, cursor.m)}${pageId ? `&page=${encodeURIComponent(pageId)}` : ''}`;
  const cal = useFetch<{ items: FbContentDto[] }>(path, 60_000);

  const allItems = cal.data?.items ?? [];
  const platformCount = (id: SocialPlatform) => allItems.filter((c) => (c.platform ?? 'facebook') === id).length;
  const items = platform ? allItems.filter((c) => (c.platform ?? 'facebook') === platform) : allItems;
  const byDay = useMemo(() => {
    const map = new Map<string, FbContentDto[]>();
    for (const c of items) {
      const s = slotOf(c);
      if (!s) continue;
      const k = dayKey(new Date(s * 1000));
      (map.get(k) ?? map.set(k, []).get(k)!).push(c);
    }
    for (const list of map.values()) list.sort((a, b) => (slotOf(a) ?? 0) - (slotOf(b) ?? 0));
    return map;
  }, [items]);

  // Monday-first grid covering the month.
  const weeks = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1);
    const lead = (first.getDay() + 6) % 7;
    const daysIn = new Date(cursor.y, cursor.m + 1, 0).getDate();
    const rows = Math.ceil((lead + daysIn) / 7);
    return Array.from({ length: rows }, (_, w) =>
      Array.from({ length: 7 }, (_, i) => new Date(cursor.y, cursor.m, 1 - lead + w * 7 + i)));
  }, [cursor]);

  const todayKey = dayKey(now);
  const open = items.find((c) => c.id === openId) ?? null;
  const shift = (delta: number) => setCursor(({ y, m }) => {
    const d = new Date(y, m + delta, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  function refresh() {
    invalidateFetchCache('/api/m/marketing/calendar');
    invalidateFetchCache('/api/m/marketing/content');
    cal.refresh();
  }

  async function dropOn(day: Date) {
    const c = items.find((x) => x.id === dragId);
    setDragId(null);
    setDropDay(null);
    const s = c ? slotOf(c) : null;
    if (!c || !s || c.status !== 'scheduled') return;
    const from = new Date(s * 1000);
    if (dayKey(from) === dayKey(day)) return;
    const to = new Date(day.getFullYear(), day.getMonth(), day.getDate(), from.getHours(), from.getMinutes());
    if (to.getTime() < Date.now()) {
      pushToast({ tone: 'warn', title: 'Không dời được', description: 'Giờ mới đã qua. Chọn một ngày từ hôm nay trở đi.' });
      return;
    }
    try {
      await apiPatch(`/api/m/marketing/content/${c.id}`, { scheduledAt: Math.floor(to.getTime() / 1000) });
      pushToast({ tone: 'success', title: `Đã dời “${c.title}” sang ${to.getDate()}/${to.getMonth() + 1}` });
      refresh();
    } catch (err) {
      // 409: the Page's posting rules blocked it; the server gives the reason.
      pushToast({ tone: 'error', title: 'Không dời được', description: apiFail(err).message, ttlMs: 7000 });
    }
  }

  return (
    <div class="flex flex-col h-full min-h-0">
      <PageHeader
        compact={!!tabs}
        tabs={tabs}
        breadcrumb="Marketing · Facebook"
        title="Lịch đăng"
        actions={
          <>
            <button type="button" aria-label="Tháng trước" class={`${BTN} w-9 px-0`} onClick={() => shift(-1)}><ChevronLeft size={16} /></button>
            <span class="px-1.5 text-[14px] font-semibold tabular-nums" aria-live="polite">Tháng {cursor.m + 1}/{cursor.y}</span>
            <button type="button" aria-label="Tháng sau" class={`${BTN} w-9 px-0`} onClick={() => shift(1)}><ChevronRight size={16} /></button>
            <button type="button" class={BTN} onClick={() => setCursor({ y: now.getFullYear(), m: now.getMonth() })}>Hôm nay</button>
          </>
        }
      />
      <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4 flex flex-col gap-3">
        <p class="text-[13px] text-[var(--color-text-muted)] -mb-1">Bấm vào một bài để xem chi tiết, mở bài trên Facebook hoặc xóa lịch.</p>
        <FbReadiness />
        {!pagesLoading && !pagesError && enabledPages.length === 0 && <NoPageNotice hasPages={pages.length > 0} />}

        <div role="group" aria-label="Lọc theo nền tảng" class="flex flex-wrap items-center gap-1.5">
          <FilterChip on={platform === ''} label="Tất cả nền tảng" count={allItems.length} onClick={() => setPlatform('')} />
          {PLATFORMS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={platform === p.id}
              onClick={() => setPlatform(platform === p.id ? '' : p.id)}
              class={`h-11 pl-2 pr-3.5 rounded-lg border text-[13.5px] transition-colors inline-flex items-center gap-2 whitespace-nowrap ${
                platform === p.id
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-text)] font-semibold'
                  : 'border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
              } ${platformCount(p.id) === 0 && platform !== p.id ? 'opacity-60' : ''}`}
            >
              <PlatformBadge platform={p.id} size={26} />{p.name}
              <span class="text-[var(--color-text-faint)]">{platformCount(p.id)}</span>
            </button>
          ))}
        </div>

        <div class="flex flex-wrap items-center gap-x-4 gap-y-2.5">
          {(platform === '' || platform === 'facebook') && <div role="group" aria-label="Lọc theo Page" class="flex flex-wrap gap-1.5">
            <FilterChip on={pageId === ''} label="Tất cả Page" onClick={() => setPageId('')} />
            {pages.map((p) => <FilterChip key={p.id} on={pageId === p.id} label={p.name} onClick={() => setPageId(p.id)} />)}
          </div>}
          <ul class="ml-auto m-0 p-0 list-none flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-[var(--color-text-muted)]" aria-label="Chú giải">
            {(Object.keys(FORMAT_META) as FbFormat[]).map((f) => (
              <li key={f} class="inline-flex items-center gap-1.5">
                <span class="w-2 h-2 rounded-[2px]" style={{ background: FORMAT_META[f].color }} aria-hidden="true" />{FORMAT_META[f].label}
              </li>
            ))}
            <li class="text-[var(--color-border-strong)]" aria-hidden="true">|</li>
            <li><span style={{ color: 'var(--color-status-done)' }}>✓</span> đã đăng</li>
            <li class="inline-flex items-center gap-1.5">
              <span class="w-3.5 h-2.5 rounded-[3px] border border-dashed border-[var(--color-accent)]" aria-hidden="true" />chờ duyệt
            </li>
            <li style={{ color: 'var(--color-status-failed)' }}>! lỡ giờ / lỗi</li>
          </ul>
        </div>

        {cal.error && !cal.data && <FetchError error={cal.error} onRetry={cal.refresh} />}
        {cal.loading && !cal.data && <div class="text-[13px] text-[var(--color-text-faint)] py-6 text-center">Đang tải lịch…</div>}

        <div class={`overflow-x-auto rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)] ${cal.loading && !cal.data ? 'hidden' : ''}`}>
          <div class="min-w-[900px]" role="grid" aria-label={`Lịch đăng tháng ${cursor.m + 1}/${cursor.y}`}>
            <div role="row" class="grid grid-cols-7 border-b border-[var(--color-border)] text-[13px] text-[var(--color-text-muted)]">
              {DOW.map((d) => <div key={d} role="columnheader" class="px-2.5 py-2">{d}</div>)}
            </div>
            {weeks.map((week, w) => (
              <div key={w} role="row" class="grid grid-cols-7">
                {week.map((day) => {
                  const k = dayKey(day);
                  const inMonth = day.getMonth() === cursor.m;
                  const isToday = k === todayKey;
                  const list = inMonth ? byDay.get(k) ?? [] : [];
                  return (
                    <div
                      key={k}
                      role="gridcell"
                      onDragOver={(e) => { if (dragId !== null && inMonth) { e.preventDefault(); setDropDay(k); } }}
                      onDragLeave={() => setDropDay((cur) => (cur === k ? null : cur))}
                      onDrop={(e) => { e.preventDefault(); if (inMonth) void dropOn(day); }}
                      class={`min-h-[128px] p-1.5 border-r border-b border-[var(--color-border)] flex flex-col gap-1 min-w-0 ${
                        inMonth ? '' : 'bg-[var(--color-sidebar)]'
                      } ${dropDay === k ? 'outline outline-2 -outline-offset-2 outline-[var(--color-accent)]' : ''}`}
                    >
                      <div class="flex items-center justify-between px-1 pb-1">
                        <span
                          class={`inline-flex items-center justify-center min-w-6 h-6 px-1 rounded-full text-[12.5px] tabular-nums ${
                            isToday ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)] font-bold' : inMonth ? 'text-[var(--color-text)] font-medium' : 'text-[var(--color-text-faint)]'
                          }`}
                        >
                          {day.getDate()}
                        </span>
                        {isToday && <span class="text-[12px] text-[var(--color-text-muted)]">hôm nay</span>}
                      </div>
                      {list.map((c) => {
                        const st = itemStyle(c);
                        const s = slotOf(c)!;
                        const t = `${pad(new Date(s * 1000).getHours())}:${pad(new Date(s * 1000).getMinutes())}`;
                        const draggable = c.status === 'scheduled';
                        return (
                          <button
                            key={c.id}
                            type="button"
                            draggable={draggable}
                            onDragStart={() => setDragId(c.id)}
                            onDragEnd={() => { setDragId(null); setDropDay(null); }}
                            onClick={() => setOpenId(c.id)}
                            aria-label={`${t}, ${c.title}, ${platformMeta(c.platform).name}, ${c.pageName ?? 'chưa gán Page'}, ${STATUS_META[c.status].label}`}
                            class="flex items-center gap-1.5 w-full min-h-[32px] px-1.5 py-1 rounded-md border text-[13px] text-left min-w-0 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                            style={{ borderStyle: st.dashed ? 'dashed' : 'solid', borderColor: st.border, background: st.bg, color: st.fg }}
                          >
                            <PlatformBadge platform={c.platform} size={24} />
                            <span class="shrink-0 w-[7px] h-[7px] rounded-[2px]" style={{ background: (FORMAT_META[c.format] ?? FORMAT_META.text).color }} aria-hidden="true" />
                            <span class="shrink-0 tabular-nums opacity-80">{t}</span>
                            <span class="flex-1 min-w-0 truncate">{c.title}</span>
                            {st.mark && <span class="shrink-0 text-[12px]" style={{ color: st.markFg }} aria-hidden="true">{st.mark}</span>}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {cal.data && items.length === 0 && (
          <p class="m-0 text-[13px] text-[var(--color-text-muted)]">
            Tháng này chưa có bài nào được xếp lịch{platform ? ` trên ${platformMeta(platform).name}` : ''}{pageId ? ' cho Page này' : ''}. Nhờ agent ở Kho content xếp lịch, hoặc duyệt bài kèm giờ đăng.
          </p>
        )}
        <p class="m-0 text-[13px] text-[var(--color-text-muted)]">
          Publisher đăng đúng giờ qua Composio. Kéo bài đã lên lịch sang ngày khác để dời giờ; bài vi phạm luật đăng của Page sẽ bị chặn kèm lý do. Giờ hiển thị theo múi giờ trên máy bạn.
        </p>
      </div>

      {open && <PostSheet key={open.id} item={open} onClose={() => setOpenId(null)} onChanged={refresh} />}
    </div>
  );
}
