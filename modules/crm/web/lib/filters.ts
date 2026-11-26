// Filtering, sorting and the per-browser saved filters of "Tất cả khách". Pure except the storage helpers.
import { dayDistance } from '@modules/care/web/lib/care-channels/tasks';
import { STAGE_LABEL } from './stages';
import type { CustomerRowDto, Stage } from './types';

export type DueFilter = 'any' | 'attention' | 'late' | 'today' | 'week' | 'none';

export interface CustomerFilter {
  q: string;
  stages: Stage[];
  tag: string;
  due: DueFilter;
}

export const EMPTY_FILTER: CustomerFilter = { q: '', stages: [], tag: '', due: 'any' };

export const DUE_OPTIONS: Array<{ id: DueFilter; label: string }> = [
  { id: 'any', label: 'Mọi hạn' },
  { id: 'attention', label: 'Quá hạn hoặc hôm nay' },
  { id: 'late', label: 'Quá hạn' },
  { id: 'today', label: 'Hôm nay' },
  { id: 'week', label: 'Trong 7 ngày' },
  { id: 'none', label: 'Chưa có việc tiếp' },
];

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase();

export function applyFilter(rows: readonly CustomerRowDto[], f: CustomerFilter, nowMs: number): CustomerRowDto[] {
  const q = fold(f.q.trim());
  const tag = fold(f.tag.trim());
  return rows.filter((r) => {
    if (f.stages.length && !f.stages.includes(r.giaiDoan)) return false;
    if (tag && !r.the.some((t) => fold(t) === tag)) return false;
    if (q) {
      const hay = fold([r.ten, r.sdt ?? '', r.email ?? '', r.congTy ?? '', ...r.the].join(' '));
      if (!hay.includes(q)) return false;
    }
    if (f.due !== 'any') {
      const due = r.viecTiep?.dueAtMs;
      if (f.due === 'none') return due === undefined;
      if (due === undefined) return false;
      const d = dayDistance(due, nowMs);
      if (f.due === 'attention') return d <= 0;
      if (f.due === 'late') return d < 0;
      if (f.due === 'today') return d === 0;
      return d >= 0 && d <= 7;
    }
    return true;
  });
}

export type SortKey = 'ten' | 'giai_doan' | 'viec_tiep' | 'cap_nhat';
export interface Sort { key: SortKey; dir: 'asc' | 'desc' }
export const DEFAULT_SORT: Sort = { key: 'viec_tiep', dir: 'asc' };

const stageRank = (s: Stage) => Object.keys(STAGE_LABEL).indexOf(s);

export function sortRows(rows: readonly CustomerRowDto[], sort: Sort): CustomerRowDto[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  const byName = (a: CustomerRowDto, b: CustomerRowDto) => a.ten.localeCompare(b.ten, 'vi');
  const cmp = (a: CustomerRowDto, b: CustomerRowDto): number => {
    switch (sort.key) {
      case 'ten': return byName(a, b);
      case 'giai_doan': return stageRank(a.giaiDoan) - stageRank(b.giaiDoan);
      case 'cap_nhat': return a.capNhatMs - b.capNhatMs;
      case 'viec_tiep': {
        // customers without a follow-up always go last, whichever direction
        const x = a.viecTiep?.dueAtMs;
        const y = b.viecTiep?.dueAtMs;
        if (x === undefined && y === undefined) return 0;
        if (x === undefined) return 2 * sign;
        if (y === undefined) return -2 * sign;
        return x - y;
      }
    }
  };
  return [...rows].sort((a, b) => sign * cmp(a, b) || byName(a, b));
}

/** Filters that need no saving: always there, with live counts. */
export const BUILT_IN_FILTERS: Array<{ id: string; name: string; filter: CustomerFilter }> = [
  { id: 'tat-ca', name: 'Tất cả khách', filter: EMPTY_FILTER },
  { id: 'can-cham', name: 'Cần chăm (quá hạn, hôm nay)', filter: { ...EMPTY_FILTER, due: 'attention' } },
  { id: 'dang-tu-van', name: 'Đang tư vấn', filter: { ...EMPTY_FILTER, stages: ['consulting'] } },
  { id: 'chua-co-viec', name: 'Chưa có việc tiếp', filter: { ...EMPTY_FILTER, due: 'none' } },
];

export interface SavedFilter {
  id: string;
  name: string;
  filter: CustomerFilter;
}

export const SAVED_FILTERS_KEY = 'aios.crm.savedFilters.v1';

const isFilter = (v: unknown): v is CustomerFilter => {
  const f = v as CustomerFilter | null;
  return !!f && typeof f.q === 'string' && typeof f.tag === 'string' && Array.isArray(f.stages) && DUE_OPTIONS.some((o) => o.id === f.due);
};

/** Saved filters live in this browser only (localStorage). Anything unreadable is dropped. */
export function loadSavedFilters(storage: Pick<Storage, 'getItem'> | null = safeStorage()): SavedFilter[] {
  try {
    const raw = storage?.getItem(SAVED_FILTERS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is SavedFilter => !!x && typeof x.id === 'string' && typeof x.name === 'string' && isFilter(x.filter));
  } catch {
    return [];
  }
}

export function storeSavedFilters(list: SavedFilter[], storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(SAVED_FILTERS_KEY, JSON.stringify(list));
  } catch {
    /* private window or full storage: the filters just do not persist */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export const sameFilter = (a: CustomerFilter, b: CustomerFilter) =>
  a.q.trim() === b.q.trim() && a.tag === b.tag && a.due === b.due && [...a.stages].sort().join() === [...b.stages].sort().join();
