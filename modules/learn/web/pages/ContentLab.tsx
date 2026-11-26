// "Phân tích nội dung": which kind of post works, from the bai-dang notes (drawing: ContentLab.dc.html).
// Every number comes from /api/m/learn/content-lab; this page only lays them out.
import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { apiPost, apiPut, errorText } from '@/lib/api';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { int, pct, postHref } from '@modules/learn/web/lib/format';
import type { BrainFolderView, Cell, ContentLabDto, ContentLabStats, Group, SyncStatus } from '@modules/learn/web/lib/types';

const DAY_OPTIONS = [30, 90, 180];

const STATE_TEXT: Record<Exclude<SyncStatus['state'], 'ok'>, string> = {
  'no-folder': 'Chưa chọn thư mục Second Brain. Module chưa ghi bài nào.',
  'folder-missing': 'Thư mục Second Brain đã chọn không còn. Chọn lại để tiếp tục ghi bài.',
  'no-marketing': 'Module Marketing Facebook đang tắt, nên chưa có bài nào để ghi.',
};

/** Picks the brain folder (module setting `folder`); shown while none is usable. */
function FolderSetup({ status, onSaved }: { status: SyncStatus; onSaved: () => void }) {
  const folders = useFetch<{ items: BrainFolderView[] }>('/brain/folders');
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const items = folders.data?.items ?? [];
  const save = async () => {
    const folder = pick || items[0]?.id;
    if (!folder) return;
    setBusy(true);
    setErr(null);
    try {
      await apiPut('/modules/learn/settings', { folder });
      await apiPost('/api/m/learn/sync');
      onSaved();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="card card-pad flex flex-col gap-2" aria-labelledby="chon-thu-muc">
      <h2 id="chon-thu-muc" class="m-0 text-[15px] font-semibold">Mỗi bài đã đăng sẽ thành một ghi chú</h2>
      <p class="m-0 text-[13px] text-[var(--color-text-muted)]">{STATE_TEXT[status.state as Exclude<SyncStatus['state'], 'ok'>]}</p>
      {status.state !== 'no-marketing' && (
        <div class="flex flex-wrap items-center gap-2">
          {items.length === 0 ? (
            <span class="text-[13px]">Chưa có thư mục Second Brain nào. <Link href="/brain" class="underline">Thêm thư mục</Link></span>
          ) : (
            <>
              <select class="field max-w-[280px]" value={pick || items[0]?.id} onChange={(e) => setPick((e.target as HTMLSelectElement).value)} aria-label="Thư mục Second Brain">
                {items.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              <button type="button" class="control-button control-accent" disabled={busy} onClick={save}>{busy ? 'Đang ghi…' : 'Ghi bài vào thư mục này'}</button>
            </>
          )}
        </div>
      )}
      <p class="m-0 text-[12px] text-[var(--color-text-faint)]">Ghi vào <code>noi-dung/bai/</code>, kể cả các bài 90 ngày gần nhất. Phần bạn viết trong ghi chú không bị máy sửa.</p>
      {err && <p class="m-0 text-[12px] text-[var(--color-status-failed)]">{err}</p>}
    </section>
  );
}

function cellStyle(c: Cell, lo: number, hi: number): Record<string, string> {
  if (c.notTried || c.medianEr === null) return { border: '1px dashed var(--color-border)', background: 'transparent' };
  const t = hi > lo ? (c.medianEr - lo) / (hi - lo) : 1;
  const mix = Math.round(12 + t * 70);
  return {
    background: `color-mix(in srgb, var(--color-accent) ${mix}%, transparent)`,
    border: '1px solid transparent',
    opacity: c.lowSample ? '0.55' : '1',
  };
}

function cellTitle(c: Cell, row: string, col: string): string {
  if (c.notTried) return `${row} · ${col}: chưa có bài nào`;
  if (c.unmeasured) return `${row} · ${col}: ${c.posts} bài, chưa đo ở mốc này`;
  return `${row} · ${col}: ER trung vị ${pct(c.medianEr)}, ${c.n} bài đã đo${c.lowSample ? ' (ít mẫu)' : ''}`;
}

function Matrix({ stats }: { stats: ContentLabStats }) {
  const { rows, cols, cells } = stats.matrix;
  const vals = cells.flat().map((c) => c.medianEr).filter((v): v is number => v !== null);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  let best: { row: string; col: string; c: Cell } | null = null;
  const untried: string[] = [];
  rows.forEach((r, i) => cols.forEach((col, j) => {
    const c = cells[i]![j]!;
    if (c.notTried) untried.push(`${r.label.toLowerCase()} về ${col.label.toLowerCase()}`);
    else if (!c.lowSample && c.medianEr !== null && (!best || c.medianEr > (best.c.medianEr ?? -1))) best = { row: r.label, col: col.label, c };
  }));
  const b = best as { row: string; col: string; c: Cell } | null;
  return (
    <section class="card card-pad flex min-w-0 flex-[1.6_1_520px] flex-col gap-2.5" aria-labelledby="ma-tran">
      <div>
        <h2 id="ma-tran" class="m-0 text-[15px] font-semibold">Định dạng nào, chủ đề nào</h2>
        <span class="text-[12.5px] text-[var(--color-text-muted)]">Mỗi ô là ER trung vị và số bài đã đo ở mốc {stats.moc}. Ô càng sáng càng hiệu quả; ô mờ có dưới 3 bài.</span>
      </div>
      <div class="overflow-x-auto">
        <div class="grid min-w-[480px] gap-0.5" style={{ gridTemplateColumns: `110px repeat(${cols.length}, minmax(0, 1fr))` }}>
          <span />
          {cols.map((c) => <span key={c.key} class="px-1.5 pb-1 text-[12px] text-[var(--color-text-muted)]">{c.label}</span>)}
          {rows.map((r, i) => (
            <Fragment key={r.key}>
              <span class="flex items-center text-[13px] font-semibold">{r.label}</span>
              {cols.map((col, j) => {
                const c = cells[i]![j]!;
                return (
                  <div key={`${r.key}-${col.key}`} title={cellTitle(c, r.label, col.label)} class="flex min-h-[58px] flex-col justify-center rounded-md px-2.5 py-2" style={cellStyle(c, lo, hi)}>
                    <span class="text-[16px] font-semibold">{c.notTried ? '–' : c.unmeasured ? '…' : pct(c.medianEr)}</span>
                    <span class="text-[11.5px] text-[var(--color-text-muted)]">
                      {c.notTried ? 'Chưa thử' : c.unmeasured ? `${c.posts} bài, chưa đo` : `${c.n} bài${c.lowSample ? ' · ít mẫu' : ''}`}
                    </span>
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
      <span class="text-[12.5px]">
        {b ? `Mạnh nhất: ${b.row.toLowerCase()} về ${b.col.toLowerCase()} (${pct(b.c.medianEr)}, ${b.c.n} bài). ` : 'Chưa ô nào đủ 3 bài để so. '}
        Ô có dưới 3 bài chỉ để tham khảo.
        {untried.length > 0 && ` Chưa thử: ${untried.slice(0, 3).join(', ')}${untried.length > 3 ? '…' : ''}.`}
      </span>
    </section>
  );
}

function Bars({ title, groups }: { title: string; groups: Group[] }) {
  const max = Math.max(0, ...groups.map((g) => g.medianEr ?? 0));
  return (
    <div class="flex flex-col gap-1.5">
      <span class="text-[11.5px] font-semibold tracking-wide text-[var(--color-text-muted)]">{title}</span>
      {groups.length === 0 && <span class="text-[12.5px] text-[var(--color-text-faint)]">Chưa có dữ liệu.</span>}
      {groups.map((g) => (
        <div key={g.key} class="flex items-center gap-2 text-[13px]" style={{ opacity: g.lowSample || g.notTried ? 0.6 : 1 }} title={g.lowSample ? 'Dưới 3 bài: ít mẫu' : undefined}>
          <span class="w-[132px] shrink-0 truncate">{g.label}</span>
          <span aria-hidden="true" class="flex h-2.5 flex-1 rounded bg-[var(--color-border)]">
            <span class="rounded bg-[var(--color-accent)]" style={{ width: `${max > 0 && g.medianEr !== null ? Math.round((g.medianEr / max) * 100) : 0}%` }} />
          </span>
          <span class="w-[118px] shrink-0 text-right tabular-nums">
            {g.notTried ? 'chưa thử' : g.unmeasured ? `${g.posts} bài, chưa đo` : <><b>{pct(g.medianEr)}</b> · {g.n} bài{g.lowSample ? ', ít mẫu' : ''}</>}
          </span>
        </div>
      ))}
    </div>
  );
}

function PostsTable({ stats, folder, dir }: { stats: ContentLabStats; folder: string; dir: string }) {
  const cols = 'grid-cols-[2.4fr_0.9fr_1.2fr_1.1fr_0.8fr_0.8fr_0.6fr]';
  return (
    <section class="card overflow-hidden" aria-labelledby="tung-bai">
      <div class="flex flex-wrap items-center gap-2.5 border-b border-[var(--color-border)] px-4 py-3">
        <h2 id="tung-bai" class="m-0 text-[15px] font-semibold">Mỗi bài là một ghi chú</h2>
        <span class="font-mono text-[12px] text-[var(--color-text-muted)]">{folder}/{dir}</span>
        <span class="ml-auto text-[12.5px] text-[var(--color-text-muted)]">Cột là thuộc tính đầu file, sửa được trong Obsidian · số đo ở mốc {stats.moc}</span>
      </div>
      <div class="overflow-x-auto">
        <div role="table" aria-label="Các bài đã đăng" class="flex min-w-[860px] flex-col">
          <div role="row" class={`grid ${cols} gap-x-3 border-b border-[var(--color-border)] px-4 py-2 font-mono text-[12px] font-semibold text-[var(--color-text-muted)]`}>
            <span role="columnheader">tieu_de</span><span role="columnheader">dinh_dang</span><span role="columnheader">tru_cot</span>
            <span role="columnheader">mo_dau</span><span role="columnheader" class="text-right">do_dai</span>
            <span role="columnheader" class="text-right">reach</span><span role="columnheader" class="text-right">er</span>
          </div>
          {stats.posts.length === 0 && <div class="px-4 py-3 text-[13px] text-[var(--color-text-muted)]">Chưa có bài nào trong khoảng này.</div>}
          {stats.posts.map((p) => (
            <Link key={p.path} href={postHref(p.path)} role="row" class={`grid ${cols} items-center gap-x-3 border-b border-[var(--color-border)] px-4 py-2 text-[13px] text-[var(--color-text)] no-underline hover:bg-[var(--color-elevated)]`}>
              <span role="cell" class="truncate font-semibold">{p.title}</span>
              <span role="cell" class="text-[var(--color-text-muted)]">{p.formatLabel}</span>
              <span role="cell" class="truncate text-[var(--color-text-muted)]">{p.pillar || '—'}</span>
              <span role="cell" class="truncate text-[var(--color-text-muted)]">{p.hookLabel || '—'}</span>
              <span role="cell" class="text-right tabular-nums">{p.length ?? '—'}</span>
              <span role="cell" class="text-right tabular-nums">{int(p.reach)}</span>
              <span role="cell" class="text-right tabular-nums">{pct(p.er)}</span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

export function ContentLab() {
  const [days, setDays] = useState(90);
  const [moc, setMoc] = useState('24h');
  const url = `/api/m/learn/content-lab?days=${days}&moc=${moc}`;
  const { data, loading, error } = useFetch<ContentLabDto>(url, 30_000);
  const reload = () => invalidateFetchCache('/api/m/learn');
  const stats = data?.stats ?? null;
  const st = data?.status;
  return (
    <div class="flex flex-col gap-4">
      <PageHeader
        title="Phân tích nội dung"
        breadcrumb="Marketing"
        actions={(
          <>
            <label class="flex items-center gap-1.5 text-[12.5px]">
              Khoảng
              <select class="field w-auto" value={days} onChange={(e) => setDays(Number((e.target as HTMLSelectElement).value))}>
                {DAY_OPTIONS.map((d) => <option key={d} value={d}>{d} ngày</option>)}
              </select>
            </label>
            <label class="flex items-center gap-1.5 text-[12.5px]">
              So ở mốc
              <select class="field w-auto" value={moc} onChange={(e) => setMoc((e.target as HTMLSelectElement).value)}>
                {(data?.mocs ?? [{ value: '24h', label: '24 giờ' }]).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>
          </>
        )}
      />
      <PageState loading={loading && !data} error={error} />
      {st && st.state !== 'ok' && <FolderSetup status={st} onSaved={reload} />}
      {stats && (
        <>
          <p class="m-0 text-[13px] text-[var(--color-text-muted)]">
            Dạng bài nào đang hiệu quả · {stats.totals.posts} bài Facebook trong {stats.days} ngày, {stats.totals.measured} bài đã đo ở mốc {stats.moc}.
            {' '}Chỉ so các bài cùng mốc đo.
          </p>
          <div class="flex flex-wrap items-start gap-4">
            <Matrix stats={stats} />
            <section class="card card-pad flex min-w-0 flex-[1_1_320px] flex-col gap-3" aria-labelledby="dac-diem">
              <div>
                <h2 id="dac-diem" class="m-0 text-[15px] font-semibold">Đặc điểm của bài hiệu quả</h2>
                <span class="text-[12.5px] text-[var(--color-text-muted)]">Nhãn lấy từ Kho nội dung (bạn sửa được trong ghi chú), máy tính ER trung vị theo nhãn.</span>
              </div>
              <Bars title="KIỂU MỞ ĐẦU" groups={stats.byHook} />
              <Bars title="ĐỘ DÀI" groups={stats.byLength} />
            </section>
          </div>
          <PostsTable stats={stats} folder={st?.folder ?? ''} dir={data?.dir ?? 'noi-dung/bai/'} />
          {st?.lastError && <p class="m-0 text-[12px] text-[var(--color-status-failed)]">Lần ghi gần nhất có lỗi: {st.lastError}</p>}
        </>
      )}
    </div>
  );
}
