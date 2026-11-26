import { ArrowDown, ArrowUp, Trash2 } from 'lucide-preact';
import { useMemo, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { PageState } from '@/components/PageState';
import { DueChip, StageChip, TagChips } from '../components/Chips';
import { CrmShell, pathOfCustomer } from '../components/CrmShell';
import { crmApi } from '../lib/client';
import {
  applyFilter, BUILT_IN_FILTERS, DEFAULT_SORT, DUE_OPTIONS, EMPTY_FILTER, loadSavedFilters, sameFilter, sortRows, storeSavedFilters,
  type CustomerFilter, type DueFilter, type SavedFilter, type Sort, type SortKey,
} from '../lib/filters';
import { relativeDay } from '@modules/care/web/lib/care-channels/customers';
import { STAGE_LABEL, STAGE_ORDER } from '../lib/stages';
import type { CrmApi, Stage } from '../lib/types';
import { useCrmStatus, useCustomerList } from '../lib/useCrm';

const MONO = 'font-[var(--font-mono)] text-[12px]';
const GRID = '1.5fr 1fr 1.4fr 0.9fr 1.8fr 0.8fr';

/** Tất cả khách: the machine-owned note fields as columns, with filters you can save (per browser). */
export function CrmAll({ api = crmApi, now = () => Date.now(), storage }: { api?: CrmApi; now?: () => number; storage?: Storage }) {
  const list = useCustomerList(api);
  const status = useCrmStatus(api);
  const nowMs = now();
  const [filter, setFilter] = useState<CustomerFilter>(EMPTY_FILTER);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [saved, setSaved] = useState<SavedFilter[]>(() => loadSavedFilters(storage));
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  const all = list.data ?? [];
  const shown = useMemo(() => sortRows(applyFilter(all, filter, nowMs), sort), [all, filter, sort, nowMs]);
  const tags = useMemo(() => [...new Set(all.flatMap((r) => r.the))].sort((a, b) => a.localeCompare(b, 'vi')), [all]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of [...BUILT_IN_FILTERS, ...saved]) m.set(v.id, applyFilter(all, v.filter, nowMs).length);
    return m;
  }, [all, saved, nowMs]);
  const active = [...BUILT_IN_FILTERS, ...saved].find((v) => sameFilter(v.filter, filter))?.id ?? null;
  const dirty = !sameFilter(filter, EMPTY_FILTER);
  const notes = all.filter((r) => r.notePath).length;

  const persist = (next: SavedFilter[]) => { setSaved(next); storeSavedFilters(next, storage); };
  const save = () => {
    const n = name.trim();
    if (!n || active) return;
    persist([...saved, { id: `f${Date.now().toString(36)}`, name: n.slice(0, 60), filter }]);
    setNaming(false);
    setName('');
  };
  const patch = (p: Partial<CustomerFilter>) => setFilter((f) => ({ ...f, ...p }));
  const toggleStage = (s: Stage) => patch({ stages: filter.stages.includes(s) ? filter.stages.filter((x) => x !== s) : [...filter.stages, s] });
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  return (
    <CrmShell current="all" status={status} search={filter.q} onSearch={(q) => patch({ q })}>
      <div class="flex flex-1 flex-wrap">
        <section aria-label="Bộ lọc" class="flex min-w-0 max-w-full flex-[1_1_220px] flex-col gap-3 border-b border-[var(--color-border)] px-3 py-4 md:max-w-[280px] md:border-b-0 md:border-r">
          <div class="flex flex-col gap-0.5">
            <span class="section-title px-2 pb-1">Bộ lọc</span>
            {BUILT_IN_FILTERS.map((v) => <FilterButton key={v.id} on={active === v.id} label={v.name} count={counts.get(v.id)} onClick={() => setFilter(v.filter)} />)}
            {saved.length > 0 && <span class="section-title px-2 pb-1 pt-3">Đã lưu trong trình duyệt này</span>}
            {saved.map((v) => (
              <div key={v.id} class="flex items-center gap-1" data-testid="crm-saved-filter">
                <div class="min-w-0 flex-1"><FilterButton on={active === v.id} label={v.name} count={counts.get(v.id)} onClick={() => setFilter(v.filter)} /></div>
                <button type="button" class="control-button !h-9 !w-9 !px-0" aria-label={`Xoá bộ lọc ${v.name}`} onClick={() => persist(saved.filter((x) => x.id !== v.id))}><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
          <div class="card flex flex-col gap-1.5 !p-3">
            <span class="text-[13px] font-semibold">Mỗi khách là một ghi chú</span>
            <span class="text-[13px] text-[var(--color-text-muted)]">Các cột là thuộc tính ở đầu file khach-hang/*.md. Máy ghi từ dữ liệu ra file; sửa giai đoạn, nhãn, việc cần làm thì sửa trong app.</span>
          </div>
        </section>

        <section id="bang" aria-label="Bảng khách hàng" class="flex min-w-0 flex-[4_1_520px] flex-col gap-3 py-4 pl-3.5 md:pl-[22px]">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold" data-testid="crm-shown">{shown.length} khách</span>
            <span class="text-[13px] text-[var(--color-text-muted)]">{all.length > 0 ? `trên tổng ${all.length} · ${notes} đã có ghi chú` : ''}</span>
          </div>

          <div class="flex flex-wrap items-center gap-2" aria-label="Điều kiện lọc">
            {STAGE_ORDER.map((s) => (
              <button key={s} type="button" aria-pressed={filter.stages.includes(s)} data-testid={`crm-stage-filter-${s}`} onClick={() => toggleStage(s)} class={`rounded-full border px-3 py-1.5 text-[12px] font-semibold ${filter.stages.includes(s) ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]' : 'border-[var(--color-border-strong)] text-[var(--color-control-text)]'}`}>{STAGE_LABEL[s]}</button>
            ))}
            <select class="field !h-9 !w-auto" aria-label="Lọc theo thẻ" value={filter.tag} onChange={(e) => patch({ tag: (e.target as HTMLSelectElement).value })}>
              <option value="">Mọi thẻ</option>
              {tags.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select class="field !h-9 !w-auto" aria-label="Lọc theo hạn chăm" value={filter.due} onChange={(e) => patch({ due: (e.target as HTMLSelectElement).value as DueFilter })}>
              {DUE_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
            {dirty && <button type="button" class="control-button !h-9" onClick={() => setFilter(EMPTY_FILTER)}>Bỏ lọc</button>}
            {dirty && !active && !naming && <button type="button" class="control-button !h-9 !border-[var(--color-accent)] !bg-[var(--color-accent)] !text-[var(--color-on-accent)]" onClick={() => setNaming(true)} data-testid="crm-save-filter">Lưu bộ lọc này</button>}
          </div>
          {naming && (
            <form class="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
              <input class="field !h-9 !w-[220px]" aria-label="Tên bộ lọc" placeholder="Tên bộ lọc, ví dụ: Khách sỉ cần gọi" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} data-testid="crm-filter-name" />
              <button type="submit" class="control-button !h-9 !border-[var(--color-accent)] !bg-[var(--color-accent)] !text-[var(--color-on-accent)]" disabled={!name.trim()}>Lưu</button>
              <button type="button" class="control-button !h-9" onClick={() => { setNaming(false); setName(''); }}>Huỷ</button>
            </form>
          )}

          {list.error && <PageState error={list.error} />}
          {!list.data && !list.error && <PageState loading />}
          {list.data && all.length === 0 && <PageState empty emptyTitle="Chưa có khách nào" emptyDescription="Khách xuất hiện ở đây khi có người nhắn qua một kênh trong Chăm sóc khách hàng." />}
          {list.data && all.length > 0 && shown.length === 0 && <PageState empty emptyTitle="Không có khách nào khớp bộ lọc" emptyDescription="Thử bỏ bớt điều kiện lọc." />}
          {shown.length > 0 && (
            <div class="overflow-x-auto rounded-[14px] border border-[var(--color-border)] bg-[var(--color-card)]">
              <div role="table" aria-label="Tất cả khách" class="flex min-w-[780px] flex-col">
                <div role="row" class={`grid gap-x-3 border-b border-[var(--color-border)] px-4 py-3 font-semibold text-[var(--color-text-faint)] ${MONO}`} style={{ gridTemplateColumns: GRID }}>
                  <SortHead label="ten · tệp" k="ten" sort={sort} onSort={sortBy} />
                  <SortHead label="giai_doan" k="giai_doan" sort={sort} onSort={sortBy} />
                  <span role="columnheader">the</span>
                  <span role="columnheader">sdt</span>
                  <SortHead label="viec_tiep · han" k="viec_tiep" sort={sort} onSort={sortBy} />
                  <SortHead label="cap_nhat" k="cap_nhat" sort={sort} onSort={sortBy} />
                </div>
                {shown.map((r) => (
                  <div key={r.id} role="row" data-testid="crm-row" data-customer-id={r.id} class="grid items-center gap-x-3 border-b border-[var(--color-border)] px-4 py-2.5 last:border-b-0" style={{ gridTemplateColumns: GRID }}>
                    <span role="cell" class="min-w-0">
                      <Link href={pathOfCustomer(r.id)} class="flex flex-col !text-[var(--color-text)]">
                        <span class="truncate font-semibold">{r.ten}</span>
                        <span class={`truncate text-[var(--color-text-faint)] ${MONO}`}>{r.notePath ? r.notePath.split('/').pop() : 'chưa có ghi chú'}</span>
                      </Link>
                    </span>
                    <span role="cell"><StageChip stage={r.giaiDoan} /></span>
                    <span role="cell"><TagChips tags={r.the} /></span>
                    <span role="cell" class="truncate text-[13px] text-[var(--color-control-text)]">{r.sdt ?? '—'}</span>
                    <span role="cell" class="flex min-w-0 flex-col gap-1">
                      {r.viecTiep ? <><span class="truncate text-[13px]">{r.viecTiep.title}</span><span><DueChip dueAtMs={r.viecTiep.dueAtMs} nowMs={nowMs} /></span></> : <span class="text-[var(--color-text-faint)]">—</span>}
                    </span>
                    <span role="cell" class="text-[13px] text-[var(--color-text-muted)]">{relativeDay(r.capNhatMs, nowMs)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </CrmShell>
  );
}

function FilterButton(props: { on: boolean; label: string; count?: number; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={props.on} onClick={props.onClick} class={`flex min-h-[40px] w-full items-center gap-2 rounded-lg border-0 px-2 text-left text-[13px] ${props.on ? 'bg-[var(--color-accent-soft)] font-semibold text-[var(--color-accent-hover)]' : 'bg-transparent text-[var(--color-control-text)] hover:bg-[var(--color-control-hover)]'}`}>
      <span class="min-w-0 flex-1">{props.label}</span>
      <span class="text-[12px] font-normal text-[var(--color-text-faint)]">{props.count ?? ''}</span>
    </button>
  );
}

function SortHead({ label, k, sort, onSort }: { label: string; k: SortKey; sort: Sort; onSort: (k: SortKey) => void }) {
  const on = sort.key === k;
  return (
    <span role="columnheader" aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" class="inline-flex items-center gap-1 border-0 bg-transparent p-0 font-[inherit] text-[inherit] text-[var(--color-text-faint)] hover:text-[var(--color-text)]" onClick={() => onSort(k)}>
        {label}{on && (sort.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </button>
    </span>
  );
}
