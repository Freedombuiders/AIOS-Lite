import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { LayoutGrid, List, Plus, Search, Play, Image, Images, ExternalLink, FileText, Sparkles } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { FormatChip, StatusPill } from '@modules/marketing/web/components/fb/common';
import {
  apiFail, BTN, BTN_SM, FbReadiness, FetchError, FilterChip, INPUT, NoPageNotice, useFbPages,
} from '@modules/marketing/web/components/fb/ops-shared';
import { ContentCard } from '@modules/marketing/web/components/fb/library/ContentCard';
import { ContentEditor } from '@modules/marketing/web/components/fb/library/ContentEditor';
import { AgentChatPanel } from '@modules/marketing/web/components/fb/library/AgentChatPanel';
import { ConfirmModal } from '@/components/ConfirmModal';
import { apiPost } from '@/lib/api';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { useDebouncedValue } from '@/lib/useDebounce';
import { pushToast } from '@/lib/toasts';
import {
  FORMAT_META, fmtCompact, fmtPct, fmtSlot,
  type FbContentDto, type FbContentListDto, type FbContentStatus, type FbFormat,
} from '@modules/marketing/web/lib/fbstudio';

const PAGE_SIZES = [25, 50, 100] as const;

type StatusFilter = 'all' | 'idea' | 'draft' | 'review' | 'scheduled' | 'published' | 'problem';

const STATUS_CHIPS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'Tất cả' },
  { key: 'idea', label: 'Ý tưởng' },
  { key: 'draft', label: 'Bản nháp' },
  { key: 'review', label: 'Chờ duyệt' },
  { key: 'scheduled', label: 'Đã lên lịch' },
  { key: 'published', label: 'Đã đăng' },
  { key: 'problem', label: 'Lỗi / Lỡ giờ' },
];

const statusParam = (f: StatusFilter) => (f === 'all' ? '' : f === 'problem' ? 'failed,missed' : f);

/** Opens a row from a deep link such as /marketing/fb/library?id=12 (used by the calendar). */
function idFromUrl(): number | null {
  const raw = new URLSearchParams(window.location.search).get('id');
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** A prompt handed over by another screen, e.g. /marketing/fb/library?ask=Viết bài về… */
function askFromUrl(): string {
  return new URLSearchParams(window.location.search).get('ask') ?? '';
}

/** `tabs` is set when the page sits inside the Social hub: one compact header row carries the hub's tabs. */
export function FbLibrary({ tabs }: { tabs?: ComponentChildren } = {}) {
  const { pages, enabledPages, loading: pagesLoading, error: pagesError } = useFbPages();

  const [view, setView] = useState<'table' | 'grid'>(() => {
    try { return localStorage.getItem('fb-library-view') === 'table' ? 'table' : 'grid'; } catch { return 'grid'; }
  });
  useEffect(() => { try { localStorage.setItem('fb-library-view', view); } catch { /* Storage may be disabled. */ } }, [view]);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [pageId, setPageId] = useState('');
  const [format, setFormat] = useState<FbFormat | ''>('');
  const [pillar, setPillar] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState<number>(25);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const dQuery = useDebouncedValue(query.trim(), 300);

  const [selected, setSelected] = useState<Map<number, FbContentDto>>(new Map());
  const [editing, setEditing] = useState<number | 'new' | null>(idFromUrl);
  const [republish, setRepublish] = useState<FbContentDto | null>(null);

  // Any filter change goes back to the first page.
  useEffect(() => { setOffset(0); }, [status, pageId, format, pillar, dQuery, pageSize]);
  // A new page starts at its first row.
  useEffect(() => { if (tableScrollRef.current) tableScrollRef.current.scrollTop = 0; }, [offset, pageSize]);

  const path = useMemo(() => {
    const q = new URLSearchParams();
    if (status !== 'all') q.set('status', statusParam(status));
    if (pageId) q.set('page', pageId);
    if (format) q.set('format', format);
    if (pillar) q.set('pillar', pillar);
    if (dQuery) q.set('q', dQuery);
    q.set('limit', String(pageSize));
    q.set('offset', String(offset));
    return `/api/m/marketing/content?${q.toString()}`;
  }, [status, pageId, format, pillar, dQuery, offset, pageSize]);

  const list = useFetch<FbContentListDto>(path, 30_000);
  const data = list.data;

  // The problem chip asks for failed+missed; keep only those even if the server ignores the list.
  const items = useMemo(() => {
    const rows = data?.items ?? [];
    return status === 'problem' ? rows.filter((r) => r.status === 'failed' || r.status === 'missed') : rows;
  }, [data, status]);

  const counts = data?.counts;
  const chipCount = (k: StatusFilter): number | undefined => {
    if (!counts) return undefined;
    if (k === 'all') return counts.all;
    if (k === 'problem') return (counts.failed ?? 0) + (counts.missed ?? 0);
    return counts[k as FbContentStatus] ?? 0;
  };

  const pillars = useMemo(() => {
    const names = new Set<string>();
    for (const p of pages) for (const x of p.pillars) names.add(x.name);
    return [...names];
  }, [pages]);

  function toggleRow(c: FbContentDto, on: boolean) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (on) next.set(c.id, c); else next.delete(c.id);
      return next;
    });
  }

  function refreshAll() {
    invalidateFetchCache('/api/m/marketing/content');
    invalidateFetchCache('/api/m/marketing/calendar');
    list.refresh();
  }

  async function publishAgain(c: FbContentDto) {
    try {
      await apiPost(`/api/m/marketing/content/${c.id}/publish-now`);
      pushToast({ tone: 'success', title: 'Đang đăng lại lên Facebook…' });
      refreshAll();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không đăng lại được', description: apiFail(err).message });
    }
  }

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const pageNo = Math.floor(offset / pageSize) + 1;
  const selectedList = [...selected.values()];
  const filtered = status !== 'all' || !!pageId || !!format || !!pillar || !!dQuery;
  const [chatOpen, setChatOpen] = useState(true);

  return (
    <div class="flex h-full min-h-0">
    <div class="flex-1 min-w-0 flex flex-col h-full min-h-0">
      <PageHeader
        compact={!!tabs}
        tabs={tabs}
        breadcrumb="Marketing · Facebook"
        title="Kho content"
        actions={
          <>
            <button type="button" class={BTN} onClick={() => setEditing('new')}>
              <Plus size={13} /> Thêm content
            </button>
            <button type="button" class={BTN} aria-pressed={chatOpen} onClick={() => setChatOpen((v) => !v)}>
              <Sparkles size={13} /> Chat với agent
            </button>
          </>
        }
      />
      <div class="flex-1 min-h-0 overflow-y-auto md:overflow-hidden px-4 md:px-6 py-4 flex flex-col gap-3">
        <p class="text-[13px] text-[var(--color-text-muted)] -mb-1">
          Mọi bài do agent và người tạo. Mở chat với agent ở bên phải để viết, sửa, xếp lịch.
        </p>
        <FbReadiness />
        {!pagesLoading && !pagesError && enabledPages.length === 0 && <NoPageNotice hasPages={pages.length > 0} />}

        <div class="md:flex-1 md:min-h-0 flex flex-col">
          <div class="md:flex-1 md:min-h-0 min-w-0 flex flex-col gap-3">
            <div class="flex flex-wrap gap-1.5" role="group" aria-label="Lọc theo trạng thái">
              {STATUS_CHIPS.map((c) => (
                <FilterChip
                  key={c.key}
                  on={status === c.key}
                  label={c.label}
                  count={chipCount(c.key)}
                  tone={c.key === 'problem' ? 'danger' : undefined}
                  onClick={() => setStatus(c.key)}
                />
              ))}
            </div>

            <div class="flex flex-wrap items-center gap-2">
              <div class="flex items-center gap-1" role="group" aria-label="Chế độ xem content">
                {(['table', 'grid'] as const).map((mode) => (
                  <button key={mode} type="button" aria-pressed={view === mode} onClick={() => setView(mode)} class={`${BTN} ${view === mode ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]' : ''}`}>
                    {mode === 'grid' ? <LayoutGrid size={14} /> : <List size={14} />} {mode === 'grid' ? 'Grid' : 'Bảng'}
                  </button>
                ))}
              </div>
              <label class="flex items-center gap-2 flex-1 basis-[220px] h-9 px-3 rounded-md border border-[var(--color-border)] bg-[var(--color-sidebar)] text-[13px] text-[var(--color-text-muted)] focus-within:border-[var(--color-accent)]">
                <Search size={14} aria-hidden="true" />
                <span class="sr-only">Tìm content</span>
                <input
                  type="search"
                  value={query}
                  placeholder="Tìm theo tiêu đề, caption, hook…"
                  class="flex-1 min-w-0 border-0 outline-none bg-transparent text-[13px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)]"
                  onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
                />
              </label>
              <label class="flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
                Page
                <select class={INPUT} value={pageId} onChange={(e) => setPageId((e.target as HTMLSelectElement).value)}>
                  <option value="">Tất cả Page ({pages.length})</option>
                  {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <label class="flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
                Format
                <select class={INPUT} value={format} onChange={(e) => setFormat((e.target as HTMLSelectElement).value as FbFormat | '')}>
                  <option value="">Tất cả</option>
                  {(Object.keys(FORMAT_META) as FbFormat[]).map((f) => <option key={f} value={f}>{FORMAT_META[f].label}</option>)}
                </select>
              </label>
              <label class="flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
                Tuyến
                <select class={INPUT} value={pillar} onChange={(e) => setPillar((e.target as HTMLSelectElement).value)}>
                  <option value="">Tất cả</option>
                  {pillars.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
            </div>

            <section aria-label="Danh sách content" class="md:flex-1 md:min-h-0 flex flex-col rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)] overflow-hidden">
              {list.loading && !data && <PageState loading />}
              {list.error && !data && <div class="p-4"><FetchError error={list.error} onRetry={list.refresh} /></div>}
              {data && items.length === 0 && (
                <PageState
                  empty
                  emptyTitle={filtered ? 'Không có content khớp bộ lọc' : 'Kho đang trống'}
                  emptyDescription={filtered
                    ? 'Thử bỏ bớt bộ lọc hoặc đổi từ khóa tìm.'
                    : 'Bấm “Thêm content” hoặc nhờ agent ở khung chat viết bài đầu tiên. Bài agent viết sẽ nằm ở đây, trạng thái Chờ duyệt.'}
                />
              )}
              {items.length > 0 && (
                <div ref={tableScrollRef} class="overflow-auto md:flex-1 md:min-h-0">
                  {view === 'grid' ? (
                    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))] items-start gap-4 p-4 bg-[var(--color-bg)]">
                      {items.map((c) => <ContentCard key={c.id} c={c} pictureUrl={pages.find((p) => p.id === c.pageId)?.pictureUrl} checked={selected.has(c.id)} onCheck={(on) => toggleRow(c, on)} onOpen={() => setEditing(c.id)} onRepublish={() => setRepublish(c)} />)}
                    </div>
                  ) : <table class="w-full border-collapse text-[13px]">
                    <thead>
                      <tr class="text-left text-[11.5px] font-medium text-[var(--color-text-muted)]">
                        <th class="sticky top-0 z-[1] bg-[var(--color-card)] px-3 py-2.5 border-b border-[var(--color-border)] w-9"><span class="sr-only">Chọn làm ngữ cảnh</span></th>
                        <th class="sticky top-0 z-[1] bg-[var(--color-card)] px-3 py-2.5 border-b border-[var(--color-border)]">Content</th>
                        <th class="sticky top-0 z-[1] bg-[var(--color-card)] px-3 py-2.5 border-b border-[var(--color-border)]">Format</th>
                        <th class="sticky top-0 z-[1] bg-[var(--color-card)] px-3 py-2.5 border-b border-[var(--color-border)] whitespace-nowrap">Tuyến · Hook</th>
                        <th class="sticky top-0 z-[1] bg-[var(--color-card)] px-3 py-2.5 border-b border-[var(--color-border)]">Page</th>
                        <th class="sticky top-0 z-[1] bg-[var(--color-card)] px-3 py-2.5 border-b border-[var(--color-border)]">Agent</th>
                        <th class="sticky top-0 z-[1] bg-[var(--color-card)] px-3 py-2.5 border-b border-[var(--color-border)] whitespace-nowrap">Trạng thái</th>
                        <th class="sticky top-0 z-[1] bg-[var(--color-card)] px-3 py-2.5 border-b border-[var(--color-border)] whitespace-nowrap">Lịch đăng</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((c) => (
                        <ContentRow
                          key={c.id}
                          c={c}
                          checked={selected.has(c.id)}
                          onCheck={(on) => toggleRow(c, on)}
                          onOpen={() => setEditing(c.id)}
                          onRepublish={() => setRepublish(c)}
                        />
                      ))}
                    </tbody>
                  </table>}
                </div>
              )}
              <div class="shrink-0 flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 text-[13px] text-[var(--color-text-muted)] border-t border-[var(--color-border)]">
                <span>{selected.size > 0 ? `${selected.size} content đang chọn làm ngữ cảnh cho agent` : 'Tick ô vuông để chọn content làm ngữ cảnh cho agent'}</span>
                <nav aria-label="Phân trang" class="flex flex-wrap items-center gap-1.5">
                  {data && total > 0 && (
                    <span class="mr-1 tabular-nums">{offset + 1}–{Math.min(offset + items.length, total)} / {total}</span>
                  )}
                  <label class="flex items-center gap-1">
                    <span class="sr-only">Số dòng mỗi trang</span>
                    <select class={`${INPUT} h-7 text-[13px]`} value={pageSize} onChange={(e) => setPageSize(Number((e.target as HTMLSelectElement).value))}>
                      {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} / trang</option>)}
                    </select>
                  </label>
                  <button type="button" class={BTN_SM} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>Trước</button>
                  {pageWindow(pageNo, pageCount).map((n, i) => n === null ? (
                    <span key={`gap-${i}`} class="px-0.5 text-[var(--color-text-faint)]">…</span>
                  ) : (
                    <button
                      key={n}
                      type="button"
                      aria-current={n === pageNo ? 'page' : undefined}
                      class={`${BTN_SM} min-w-[28px] justify-center tabular-nums ${n === pageNo ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-text)] font-semibold' : ''}`}
                      onClick={() => setOffset((n - 1) * pageSize)}
                    >
                      {n}
                    </button>
                  ))}
                  <button type="button" class={BTN_SM} disabled={offset + pageSize >= total} onClick={() => setOffset(offset + pageSize)}>Sau</button>
                </nav>
              </div>
            </section>
          </div>

        </div>
      </div>

    </div>

      {chatOpen && (
        <AgentChatPanel
          initialDraft={askFromUrl()}
          selected={selectedList}
          onDeselect={(id) => setSelected((prev) => { const n = new Map(prev); n.delete(id); return n; })}
          onClearSelection={() => setSelected(new Map())}
          onReply={refreshAll}
          onClose={() => setChatOpen(false)}
        />
      )}

      {editing !== null && (
        <ContentEditor
          contentId={editing}
          pages={pages}
          onClose={() => {
            setEditing(null);
            if (idFromUrl() !== null) {
              const q = new URLSearchParams(window.location.search);
              q.delete('id');
              window.history.replaceState(null, '', `${window.location.pathname}${q.size ? `?${q}` : ''}`);
            }
          }}
          onChanged={refreshAll}
        />
      )}
      <ConfirmModal
        open={republish !== null}
        onClose={() => setRepublish(null)}
        onConfirm={() => { if (republish) void publishAgain(republish); }}
        title="Đăng lại bài này?"
        body={republish ? `“${republish.title}” sẽ được đăng lên ${republish.pageName ?? 'Page'} ngay bây giờ.` : undefined}
        detail="Nếu lần trước bài đã lên Facebook một phần, hãy kiểm tra Page trước để tránh đăng trùng."
        confirmLabel="Đăng lại"
        cancelLabel="Hủy"
      />
    </div>
  );
}

function ContentRow({ c, checked, onCheck, onOpen, onRepublish }: {
  c: FbContentDto; checked: boolean;
  onCheck: (on: boolean) => void; onOpen: () => void; onRepublish: () => void;
}) {
  const meta = FORMAT_META[c.format] ?? FORMAT_META.text;
  const problem = c.status === 'failed' || c.status === 'missed';
  const sub = problem && c.lastError
    ? { text: c.lastError, bad: true }
    : c.status === 'published' && c.metrics
      ? { text: `Reach ${fmtCompact(c.metrics.reach)} · ER ${fmtPct(c.metrics.er)}`, bad: false }
      : { text: c.hooks[0] ? `Hook: ${c.hooks[0]}` : c.caption.split('\n')[0] ?? '', bad: false };
  const tall = c.format === 'reel';
  const td = 'px-3 py-2.5 border-b border-[var(--color-border)] align-middle';
  return (
    <tr class={checked ? 'bg-[var(--color-accent-soft)]' : ''}>
      <td class={td}>
        <input
          type="checkbox"
          checked={checked}
          aria-label={`Chọn: ${c.title}`}
          class="w-4 h-4 accent-[var(--color-accent)]"
          onChange={(e) => onCheck((e.target as HTMLInputElement).checked)}
        />
      </td>
      <td class={`${td} min-w-[240px] max-w-[360px]`}>
        <div class="flex items-center gap-3">
          <span
            class={`shrink-0 h-12 rounded-md bg-[var(--color-elevated)] inline-flex items-center justify-center text-[13px] font-bold ${tall ? 'w-[30px]' : 'w-12'}`}
            style={{ color: meta.color }}
            aria-hidden="true"
          >
            {c.format === 'text' ? <FileText size={16} aria-hidden="true" /> : c.format === 'reel' || c.format === 'video' ? <Play size={16} aria-hidden="true" /> : c.format === 'photo' ? <Image size={16} aria-hidden="true" /> : c.format === 'album' ? <Images size={16} aria-hidden="true" /> : <ExternalLink size={16} aria-hidden="true" />}
          </span>
          <div class="min-w-0">
            <button
              type="button"
              onClick={onOpen}
              class="block max-w-full text-left font-semibold text-[var(--color-text)] truncate hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] rounded"
            >
              {c.title || '(chưa có tiêu đề)'}
            </button>
            <div class={`text-[13px] truncate ${sub.bad ? 'text-[var(--color-status-failed)]' : 'text-[var(--color-text-muted)]'}`}>{sub.text}</div>
          </div>
        </div>
      </td>
      <td class={td}><FormatChip format={c.format} /></td>
      <td class={td}>
        <div>{c.pillar || '–'}</div>
        {(c.hookType || c.cta) && (
          <div class="text-[13px] text-[var(--color-text-muted)]">{c.hookType ? `Hook: ${c.hookType}` : `CTA: ${c.cta}`}</div>
        )}
      </td>
      <td class={`${td} whitespace-nowrap`}>{c.pageName ?? <span class="text-[var(--color-text-faint)]">Chưa gán Page</span>}</td>
      <td class={`${td} whitespace-nowrap ${c.source === 'user' ? 'text-[12.5px] text-[var(--color-text-muted)]' : 'font-mono text-[13px] text-[var(--color-text-muted)]'}`}>
        {c.source === 'user' ? 'Bạn' : c.source}
      </td>
      <td class={td}><StatusPill status={c.status} /></td>
      <td class={`${td} whitespace-nowrap`}>
        {problem ? (
          <button type="button" class={BTN_SM} onClick={onRepublish}>Đăng lại</button>
        ) : c.status === 'published' ? (
          <div>
            <div>{fmtSlot(c.publishedAt)}</div>
          </div>
        ) : c.scheduledAt ? (
          <div>{fmtSlot(c.scheduledAt)}</div>
        ) : (
          <span class="text-[var(--color-text-muted)]">Chưa xếp</span>
        )}
      </td>
    </tr>
  );
}

/** Page numbers to show: first, last and two around the current page, with null for a gap. */
function pageWindow(current: number, count: number): (number | null)[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const pages = new Set([1, count, current - 1, current, current + 1].filter((n) => n >= 1 && n <= count));
  const sorted = [...pages].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1]! > 1) out.push(null);
    out.push(n);
  });
  return out;
}
