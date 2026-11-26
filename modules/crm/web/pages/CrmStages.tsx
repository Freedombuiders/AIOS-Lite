import { useMemo, useRef, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { PageState } from '@/components/PageState';
import { errorText } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import { dayDistance } from '@modules/care/web/lib/care-channels/tasks';
import { DueChip, TagChips } from '../components/Chips';
import { CrmShell, PATH_ALL, pathOfCustomer } from '../components/CrmShell';
import { crmApi } from '../lib/client';
import { applyFilter, EMPTY_FILTER, sortRows } from '../lib/filters';
import { isStage, STAGE_LABEL, STAGE_ORDER } from '../lib/stages';
import type { CrmApi, CustomerRowDto, Stage } from '../lib/types';
import { useCrmStatus, useCustomerList } from '../lib/useCrm';

/** cards shown per column; the rest are one click away in "Tất cả khách" */
const COLUMN_CAP = 20;
const TODAY_CAP = 6;

/** Giai đoạn: a board by care stage. Dragging a card (or the select on it) changes the stage through care. */
export function CrmStages({ api = crmApi, now = () => Date.now() }: { api?: CrmApi; now?: () => number }) {
  const list = useCustomerList(api);
  const status = useCrmStatus(api);
  const [search, setSearch] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<Stage | null>(null);
  const busy = useRef(new Set<string>());
  const nowMs = now();

  const rows = useMemo(() => applyFilter(list.data ?? [], { ...EMPTY_FILTER, q: search }, nowMs), [list.data, search, nowMs]);
  const byStage = useMemo(() => {
    const m = new Map<Stage, CustomerRowDto[]>(STAGE_ORDER.map((s) => [s, []]));
    for (const r of sortRows(rows, { key: 'viec_tiep', dir: 'asc' })) m.get(r.giaiDoan)!.push(r);
    return m;
  }, [rows]);
  const today = useMemo(
    () => sortRows(rows, { key: 'viec_tiep', dir: 'asc' }).filter((r) => r.viecTiep && dayDistance(r.viecTiep.dueAtMs, nowMs) <= 0 && r.giaiDoan !== 'won' && r.giaiDoan !== 'lost'),
    [rows, nowMs],
  );

  async function move(id: string, to: Stage): Promise<void> {
    const cur = list.data?.find((r) => r.id === id);
    if (!cur || cur.giaiDoan === to || busy.current.has(id)) return;
    busy.current.add(id);
    const from = cur.giaiDoan;
    list.set((all) => all.map((r) => (r.id === id ? { ...r, giaiDoan: to } : r)));
    try {
      await api.changeStage(id, to);
      pushToast({ tone: 'success', title: `Đã chuyển ${cur.ten} sang “${STAGE_LABEL[to]}”` });
      list.reload(); // the note and the change time follow from the server
    } catch (e) {
      list.set((all) => all.map((r) => (r.id === id ? { ...r, giaiDoan: from } : r)));
      pushToast({ tone: 'error', title: `Chưa đổi được giai đoạn của ${cur.ten}`, description: errorText(e) });
    } finally {
      busy.current.delete(id);
    }
  }

  const drop = (to: Stage) => {
    const id = dragId;
    setDragId(null);
    setOver(null);
    if (id) void move(id, to);
  };

  return (
    <CrmShell current="stages" status={status} search={search} onSearch={setSearch}>
      <main class="flex flex-1 flex-col gap-5 px-4 py-4 md:px-6 md:py-5">
        {list.error && <PageState error={list.error} />}
        {!list.data && !list.error && <PageState loading />}
        {list.data && list.data.length === 0 && (
          <PageState empty emptyTitle="Chưa có khách nào" emptyDescription="Khách xuất hiện ở đây khi có người nhắn qua một kênh trong Chăm sóc khách hàng." />
        )}

        {list.data && list.data.length > 0 && (
          <>
            {today.length > 0 && (
              <section aria-labelledby="crm-today" class="card flex flex-col gap-3 !px-5 !py-4" data-testid="crm-today">
                <div class="flex items-center gap-2.5">
                  <h2 id="crm-today" class="m-0 text-[16px] font-semibold">Cần chăm hôm nay</h2>
                  <span class="rounded-full bg-[rgba(240,178,74,0.16)] px-2 py-0.5 text-[12px] font-semibold text-[var(--color-warning)]">{today.length}</span>
                </div>
                <div class="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))' }}>
                  {today.slice(0, TODAY_CAP).map((r) => (
                    <div key={r.id} class="flex flex-col gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-sidebar)] px-3.5 py-3">
                      <span class="font-semibold">{r.ten}</span>
                      <span class="text-[13px] text-[var(--color-text-muted)]">{r.viecTiep!.title}</span>
                      <div class="flex flex-wrap items-center gap-2 pt-1">
                        <DueChip dueAtMs={r.viecTiep!.dueAtMs} nowMs={nowMs} />
                        <Link href={pathOfCustomer(r.id)} class="control-button !h-9 !text-[13px] !font-semibold">Mở hồ sơ</Link>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section aria-label="Bảng giai đoạn" class="grid items-start gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(172px, 100%), 1fr))' }}>
              {STAGE_ORDER.map((stage) => {
                const col = byStage.get(stage) ?? [];
                return (
                  <div
                    key={stage}
                    role="group"
                    aria-label={`Giai đoạn ${STAGE_LABEL[stage]}`}
                    data-testid={`crm-col-${stage}`}
                    data-stage={stage}
                    class={`flex flex-col gap-2.5 rounded-[14px] border bg-[var(--color-sidebar)] p-3 ${over === stage && dragId ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-border)]'}`}
                    onDragOver={(e) => { if (dragId) { e.preventDefault(); if (over !== stage) setOver(stage); } }}
                    onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setOver((o) => (o === stage ? null : o)); }}
                    onDrop={(e) => { e.preventDefault(); drop(stage); }}
                  >
                    <div class="flex items-center gap-2">
                      <h2 class="m-0 text-[14px] font-semibold">{STAGE_LABEL[stage]}</h2>
                      <span class="text-[13px] text-[var(--color-text-muted)]" data-testid={`crm-count-${stage}`}>{col.length}</span>
                    </div>
                    {col.length === 0 && <span class="rounded-[10px] border border-dashed border-[var(--color-border-strong)] px-3 py-4 text-center text-[12px] text-[var(--color-text-faint)]">{dragId ? 'Thả vào đây' : 'Chưa có khách'}</span>}
                    {col.slice(0, COLUMN_CAP).map((r) => (
                      <Card
                        key={r.id}
                        row={r}
                        nowMs={nowMs}
                        dragging={dragId === r.id}
                        onDragStart={() => setDragId(r.id)}
                        onDragEnd={() => { setDragId(null); setOver(null); }}
                        onMove={(to) => void move(r.id, to)}
                      />
                    ))}
                    {col.length > COLUMN_CAP && <Link href={PATH_ALL} class="text-[13px] font-semibold">Còn {col.length - COLUMN_CAP} khách, xem ở Tất cả khách</Link>}
                  </div>
                );
              })}
            </section>
            <span class="text-[13px] text-[var(--color-text-muted)]">Kéo thẻ sang cột khác để đổi giai đoạn (hoặc chọn ở ô trên thẻ). Giai đoạn đổi trong dữ liệu Chăm sóc khách hàng, ghi chú khách đổi theo sau vài giây.</span>
          </>
        )}
      </main>
    </CrmShell>
  );
}

function Card(props: { row: CustomerRowDto; nowMs: number; dragging: boolean; onDragStart: () => void; onDragEnd: () => void; onMove: (to: Stage) => void }) {
  const { row: r, nowMs, dragging } = props;
  return (
    <div
      draggable
      data-testid="crm-card"
      data-customer-id={r.id}
      class={`flex cursor-grab flex-col gap-1.5 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)] p-3 ${dragging ? 'opacity-40' : ''}`}
      onDragStart={(e) => {
        try { e.dataTransfer?.setData('text/plain', r.id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; } catch { /* some browsers refuse */ }
        props.onDragStart();
      }}
      onDragEnd={props.onDragEnd}
    >
      <Link href={pathOfCustomer(r.id)} class="!text-[var(--color-text)] font-semibold" draggable={false}>{r.ten}</Link>
      <span class="text-[13px] text-[var(--color-text-muted)]">{r.viecTiep ? r.viecTiep.title : r.sdt ?? 'Chưa có việc tiếp'}</span>
      <span class="flex flex-wrap items-center gap-1.5"><DueChip dueAtMs={r.viecTiep?.dueAtMs} nowMs={nowMs} /></span>
      {r.the.length > 0 && <TagChips tags={r.the} max={2} />}
      <select
        class="field !h-8 !text-[12px]"
        aria-label={`Chuyển ${r.ten} sang giai đoạn`}
        value={r.giaiDoan}
        onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (isStage(v)) props.onMove(v); }}
        onDragStart={(e) => e.stopPropagation()}
      >
        {STAGE_ORDER.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
      </select>
    </div>
  );
}
