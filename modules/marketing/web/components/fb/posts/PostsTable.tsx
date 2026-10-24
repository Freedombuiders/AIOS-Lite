import { FORMAT_META, fmtCompact, fmtDec, fmtInt, fmtPct, fmtSlot, type PostsDashboardDto } from '@modules/marketing/web/lib/fbstudio';
import { FormatChip } from '../common';
import { AXIS, SERIES, TRACK, finite } from '@/components/fb/charts/chart-utils';

export type PostRow = PostsDashboardDto['rows'][number];
export type SortKey = 'index' | 'publishedAt' | 'reach' | 'er' | 'comments' | 'shares';
export interface SortState { key: SortKey; dir: 'asc' | 'desc' }

/** Index bar scale: the full track is ×2,5, so the Page median (×1,0) sits at 40%. */
const INDEX_FULL = 2.5;

export function fmtWatch(sec: number | null): string {
  if (!finite(sec)) return '–';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function sourceLabel(source: string): string {
  return !source || source === 'user' ? 'Bạn' : source;
}

export function sortRows(rows: PostRow[], sort: SortState): PostRow[] {
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[sort.key];
    const bv = b[sort.key];
    if (!finite(av) && !finite(bv)) return 0;
    if (!finite(av)) return 1;
    if (!finite(bv)) return -1;
    return (av - bv) * dir;
  });
}

const COLS: { key: SortKey | null; label: string; num?: boolean }[] = [
  { key: null, label: 'Bài' },
  { key: null, label: 'Format' },
  { key: 'publishedAt', label: 'Đăng lúc' },
  { key: 'reach', label: 'Reach', num: true },
  { key: 'er', label: 'ER', num: true },
  { key: 'index', label: 'So với trung vị Page' },
  { key: 'comments', label: 'Comment', num: true },
  { key: 'shares', label: 'Share', num: true },
  { key: null, label: 'TB xem', num: true },
];

export function PostsTable({ rows, selectedId, onSelect, sort, onSort }: {
  rows: PostRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  sort: SortState;
  onSort: (key: SortKey) => void;
}) {
  const th = 'px-3 py-2.5 text-[11.5px] font-medium text-[var(--color-text-muted)] whitespace-nowrap border-b border-[var(--color-border)]';
  const td = 'px-3 py-2.5 border-b border-[var(--color-border)] align-middle whitespace-nowrap';
  return (
    <div class="overflow-x-auto">
      <table class="w-full border-collapse text-[13px] tabular-nums">
        <thead>
          <tr>
            {COLS.map((c) => {
              const on = c.key !== null && sort.key === c.key;
              return (
                <th key={c.label} class={`${th} ${c.num ? 'text-right' : 'text-left'}`} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined} scope="col">
                  {c.key ? (
                    <button type="button" onClick={() => onSort(c.key as SortKey)} class="bg-transparent border-0 p-0 font-medium text-[11.5px] hover:text-[var(--color-text)]" style={{ color: on ? 'var(--color-text)' : undefined }}>
                      {c.label}{on ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </button>
                  ) : c.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const sel = r.postId === selectedId;
            return (
              <tr key={r.postId} onClick={() => onSelect(r.postId)} style={{ background: sel ? 'var(--color-accent-soft)' : undefined }}>
                <td class={`${td} max-w-[320px]`}>
                  <button type="button" aria-pressed={sel} onClick={(e) => { e.stopPropagation(); onSelect(r.postId); }} class="block max-w-full text-left bg-transparent border-0 p-0">
                    <span class="block font-semibold text-[var(--color-text)] truncate">{r.title || '(không có tiêu đề)'}</span>
                    <span class="block text-[12px] font-normal text-[var(--color-text-muted)] truncate">{r.pillar || 'Chưa gắn tuyến'} · {sourceLabel(r.source)}</span>
                  </button>
                </td>
                <td class={td}><FormatChip format={r.format} /></td>
                <td class={td}>{fmtSlot(r.publishedAt)}</td>
                <td class={`${td} text-right`}>{fmtCompact(r.reach)}</td>
                <td class={`${td} text-right`}>{fmtPct(r.er)}</td>
                <td class={td}>
                  <div class="flex items-center gap-2">
                    <div class="relative w-[120px] h-1.5 rounded-full" style={{ background: TRACK }} aria-hidden="true">
                      {finite(r.index) && <div class="h-1.5 rounded-full" style={{ width: `${Math.max(2, Math.min(100, (r.index / INDEX_FULL) * 100))}%`, background: SERIES }} />}
                      <div class="absolute" style={{ left: `${(1 / INDEX_FULL) * 100}%`, top: '-3px', width: '1px', height: '12px', background: AXIS }} />
                    </div>
                    <span>{finite(r.index) ? `×${fmtDec(r.index, 1)}` : '–'}</span>
                  </div>
                </td>
                <td class={`${td} text-right`}>{fmtInt(r.comments)}</td>
                <td class={`${td} text-right`}>{fmtInt(r.shares)}</td>
                <td class={`${td} text-right`}>{fmtWatch(r.avgWatchS)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function formatLabel(f: PostRow['format']): string {
  return FORMAT_META[f]?.label ?? f;
}
