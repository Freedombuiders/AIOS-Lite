// Shared pieces of the four "Vòng học" pages (drawings Loop/Playbook/Learn/Weekly.dc.html): the tab row, state
// colours and small formatters.
import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { Link, useLocation } from 'wouter-preact';
import { invalidateFetchCache, useFetch, type FetchState } from '@/lib/useFetch';
import type { LessonState } from './types';

/** Bumped after every change the owner makes on these pages; every loop fetch then reloads. */
const loopVersion = signal(0);

export function loopChanged(): void {
  invalidateFetchCache('/api/m/learn');
  loopVersion.value++;
}

/** useFetch that also reloads after loopChanged(). */
export function useLoopFetch<T>(path: string | null, pollMs = 0): FetchState<T> {
  const f = useFetch<T>(path, pollMs);
  const v = loopVersion.value;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    f.refresh();
  }, [v]);
  return f;
}

export const STATE_COLOR: Record<LessonState, string> = {
  'gia-thuyet': 'var(--color-warning)',
  'dang-thu': 'var(--color-accent)',
  'da-kiem-chung': 'var(--color-status-done)',
  'bi-bac-bo': 'var(--color-text-faint)',
};
export const STATE_LABEL: Record<LessonState, string> = {
  'gia-thuyet': 'Giả thuyết', 'dang-thu': 'Đang thử', 'da-kiem-chung': 'Đã kiểm chứng', 'bi-bac-bo': 'Bị bác bỏ',
};
export const STATE_HINT: Record<LessonState, string> = {
  'gia-thuyet': 'Bot mới để ý, chưa đủ bằng chứng',
  'dang-thu': 'Bot cố ý làm theo để xem có đúng không',
  'da-kiem-chung': 'Bot làm theo khi viết và trả lời',
  'bi-bac-bo': 'Đã thử, không đúng. Giữ lại để khỏi thử lại',
};

export function StatePill({ state }: { state: LessonState }) {
  return (
    <span
      class="inline-flex items-center rounded-full px-2 py-px text-[12px] font-semibold"
      style={{ background: `color-mix(in srgb, ${STATE_COLOR[state]} 16%, transparent)`, color: STATE_COLOR[state] }}
    >
      {STATE_LABEL[state]}
    </span>
  );
}

export function StateDot({ state }: { state: LessonState }) {
  return <span aria-hidden="true" class="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: STATE_COLOR[state] }} />;
}

const TABS = [
  { label: 'Tổng quan', path: '/m/learn/loop' },
  { label: 'Sổ bài học', path: '/m/learn/playbook' },
  { label: 'Chờ duyệt', path: '/m/learn/pending' },
  { label: 'Tổng kết tuần', path: '/m/learn/weekly' },
];

/** The tab row under the page title; "Chờ duyệt" shows how many proposals wait. */
export function LoopTabs() {
  const [loc] = useLocation();
  const pending = useLoopFetch<{ items: unknown[] }>('/api/m/learn/pending', 60_000);
  const n = pending.data?.items.length ?? 0;
  return (
    <nav aria-label="Vòng học" class="mt-3 flex flex-wrap gap-1 border-b border-[var(--color-border)]">
      {TABS.map((t) => {
        const on = loc === t.path || loc.startsWith(`${t.path}/`);
        return (
          <Link
            key={t.path}
            href={t.path}
            aria-current={on ? 'page' : undefined}
            class={`-mb-px inline-flex min-h-[40px] items-center gap-1.5 border-0 border-b-2 px-3 text-[13px] no-underline ${on ? 'border-[var(--color-accent)] font-semibold text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}
          >
            {t.label}
            {t.path === '/m/learn/pending' && n > 0 && (
              <span class="rounded-full bg-[var(--color-accent)] px-1.5 text-[11px] font-semibold text-[var(--color-on-accent)]">{n}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

export function LoopHeader({ title, actions }: { title: string; actions?: preact.ComponentChildren }) {
  return (
    <header class="mb-1">
      <div class="hint mb-0.5">Marketing · Vòng học</div>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h1 class="m-0 text-[18px] font-semibold">{title}</h1>
        {actions && <div class="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <LoopTabs />
    </header>
  );
}

export const who = (actor: string) =>
  actor === 'owner' ? 'Bạn' : actor === 'module:learn' ? 'Máy' : actor.startsWith('agent:') ? `Bot ${actor.slice(6)}` : actor;

export const dayMonth = (ymd: string) => `${Number(ymd.slice(8, 10))}/${Number(ymd.slice(5, 7))}`;

export const whenText = (sec: number) =>
  new Date(sec * 1000).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Folder not chosen: the loop has nothing to read. */
export function NoFolder() {
  return (
    <section class="card card-pad text-[13px]">
      Chưa chọn thư mục Second Brain cho module Học. Chọn ở <Link href="/m/learn" class="underline">Phân tích nội dung</Link>; bài học sẽ nằm trong <code>bai-hoc/</code>, tổng kết trong <code>tong-ket/</code>.
    </section>
  );
}
