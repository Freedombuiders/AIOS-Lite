// "Vòng học · Tổng kết tuần" (drawing Weekly.dc.html): the list of weekly notes, one week's numbers and words,
// and the plan the owner approves line by line (each chosen line becomes a task on the Việc page).
import { useEffect, useState } from 'preact/hooks';
import { Link, useParams } from 'wouter-preact';
import { PageState } from '@/components/PageState';
import { apiPost, errorText } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import { pct } from '@modules/learn/web/lib/format';
import { dayMonth, loopChanged, LoopHeader, NoFolder, useLoopFetch } from '@modules/learn/web/lib/loop';
import type { WeeklyNoteDto, WeeklyRow } from '@modules/learn/web/lib/types';

const weekHref = (r: { year: number; week: number }) => `/m/learn/weekly/${r.year}/${r.week}`;

/** Bullet lines under a `## heading` of the note body (what the agent wrote, or the machine's note). */
export function sectionLines(body: string, heading: string): string[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    const t = l.trim();
    if (t.startsWith('- ')) out.push(t.slice(2).replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1').replace(/\[\[([^\]]+)\]\]/g, '$1'));
    else if (/^_.*_$/.test(t)) out.push(t.slice(1, -1));
  }
  return out;
}

function Numbers({ note }: { note: WeeklyNoteDto }) {
  const s = (note.data.so_lieu ?? {}) as Record<string, number | undefined>;
  const cards = [
    { label: 'Bài đã đăng', value: s.bai_dang === undefined ? '—' : String(s.bai_dang), note: s.bai_da_do === undefined ? '' : `${s.bai_da_do} bài đã đo` },
    { label: 'ER trung vị', value: pct(s.er_trung_vi ?? null), note: `Tuần trước ${pct(s.er_tuan_truoc ?? null)}` },
    {
      label: 'Nháp gửi nguyên',
      value: s.nhap_da_xu_ly ? `${Math.round(((s.nhap_gui_nguyen ?? 0) / s.nhap_da_xu_ly) * 100)}%` : '—',
      note: s.nhap_da_xu_ly ? `${s.nhap_gui_nguyen ?? 0}/${s.nhap_da_xu_ly} nháp bot không phải sửa` : 'Chưa có nháp nào được xử lý',
    },
    { label: 'Bài học mới', value: String(s.bai_hoc_moi ?? 0), note: 'Giả thuyết ghi trong tuần' },
  ];
  return (
    <div class="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
      {cards.map((c) => (
        <div key={c.label} class="rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)] p-3">
          <div class="text-[12px] text-[var(--color-text-muted)]">{c.label}</div>
          <div class="text-[20px] font-semibold">{c.value}</div>
          {c.note && <div class="text-[12px] text-[var(--color-text-muted)]">{c.note}</div>}
        </div>
      ))}
    </div>
  );
}

function Plan({ note }: { note: WeeklyNoteDto }) {
  const [picked, setPicked] = useState<Set<number>>(() => new Set(note.plan.map((_, i) => i)));
  const [busy, setBusy] = useState(false);
  useEffect(() => setPicked(new Set(note.plan.map((_, i) => i))), [note.path, note.plan.length]);
  const done = new Map(note.tasks.map((t) => [t.line, t.taskId]));
  const approve = async () => {
    setBusy(true);
    try {
      const r = await apiPost<{ tasks: unknown[] }>(`/api/m/learn/weekly/${note.year}/${note.week}/approve`, { lines: [...picked].sort((a, b) => a - b) });
      pushToast({ tone: 'success', title: `Đã tạo ${r.tasks.length} việc`, description: 'Xem ở trang Việc.' });
      loopChanged();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Chưa duyệt được', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="flex flex-col gap-2" aria-labelledby="de-xuat-tuan">
      <div>
        <h3 id="de-xuat-tuan" class="m-0 text-[14px] font-semibold">Bot đề xuất cho tuần này</h3>
        <span class="text-[12.5px] text-[var(--color-text-muted)]">{note.approved ? 'Đã duyệt. Các việc đã chọn nằm ở trang Việc.' : 'Bỏ chọn việc nào bạn không muốn, rồi duyệt.'}</span>
      </div>
      {note.plan.length === 0 ? (
        <p class="m-0 text-[12.5px] text-[var(--color-text-faint)]">Tuần này chưa có đề xuất.</p>
      ) : (
        <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
          {note.plan.map((p, i) => (
            <li key={i}>
              <label class="flex min-h-[40px] cursor-pointer items-start gap-2 text-[13px]">
                <input
                  type="checkbox"
                  class="mt-1"
                  checked={note.approved ? done.has(i) : picked.has(i)}
                  disabled={note.approved}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if ((e.target as HTMLInputElement).checked) next.add(i);
                    else next.delete(i);
                    setPicked(next);
                  }}
                />
                <span>
                  <span class="font-medium">{p.viec}</span>
                  {p.ly_do && <span class="block text-[12.5px] text-[var(--color-text-muted)]">{p.ly_do}</span>}
                  {p.agent && <span class="block text-[12px] text-[var(--color-text-faint)]">Giao cho {p.agent}</span>}
                  {done.has(i) && <Link href={`/tasks/${done.get(i)}`} class="text-[12px]">Việc #{done.get(i)}</Link>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {!note.approved && note.plan.length > 0 && (
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" class="control-button control-accent" disabled={busy || picked.size === 0} onClick={() => void approve()}>{busy ? 'Đang duyệt…' : `Duyệt kế hoạch tuần (${picked.size} việc)`}</button>
          <span class="text-[12px] text-[var(--color-text-muted)]">Mỗi việc được chọn thành một thẻ ở Việc, giao cho đúng bot.</span>
        </div>
      )}
    </section>
  );
}

function WeekDetail({ year, week }: { year: number; week: number }) {
  const { data, loading, error } = useLoopFetch<WeeklyNoteDto>(`/api/m/learn/weekly/${year}/${week}`);
  if (loading && !data) return <PageState loading />;
  if (error || !data) return <PageState error={error ?? 'Không có tổng kết này.'} />;
  const good = sectionLines(data.body, 'Cái được');
  const bad = sectionLines(data.body, 'Cái hỏng');
  const learned = sectionLines(data.body, 'Học được');
  return (
    <section class="card card-pad flex min-w-0 flex-[2_1_440px] flex-col gap-3" aria-labelledby="tuan-chon">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="tuan-chon" class="m-0 text-[16px] font-semibold">Tuần {data.week} · {dayMonth(data.from)} đến {dayMonth(data.to)}</h2>
        <code class="text-[12px] text-[var(--color-text-muted)]">{data.path}</code>
      </div>
      <Numbers note={data} />
      <div class="flex flex-wrap gap-3">
        <div class="min-w-0 flex-[1_1_220px]">
          <h3 class="m-0 mb-1 text-[14px] font-semibold text-[var(--color-status-done)]">Cái được</h3>
          <ul class="m-0 flex flex-col gap-1 pl-4 text-[13px]">{good.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </div>
        <div class="min-w-0 flex-[1_1_220px]">
          <h3 class="m-0 mb-1 text-[14px] font-semibold text-[var(--color-status-failed)]">Cái hỏng</h3>
          <ul class="m-0 flex flex-col gap-1 pl-4 text-[13px]">{bad.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </div>
      </div>
      <div>
        <h3 class="m-0 mb-1 text-[14px] font-semibold">Học được</h3>
        <ul class="m-0 flex flex-col gap-1 pl-4 text-[13px]">{learned.map((l, i) => <li key={i}>{l}</li>)}</ul>
      </div>
      <Plan note={data} />
    </section>
  );
}

export function Weekly() {
  const params = useParams<{ year?: string; week?: string }>();
  const { data, loading, error } = useLoopFetch<{ folder: string; dir: string; items: WeeklyRow[] }>('/api/m/learn/weekly', 60_000);
  const [running, setRunning] = useState(false);
  const items = data?.items ?? [];
  const selected = params.year && params.week ? { year: Number(params.year), week: Number(params.week) } : items[0] ? { year: items[0].year, week: items[0].week } : null;
  const run = async () => {
    setRunning(true);
    try {
      const r = await apiPost<{ result: { created: boolean } | null }>('/api/m/learn/weekly/run');
      pushToast({ tone: 'success', title: r.result?.created ? 'Đã viết tổng kết tuần trước' : 'Tổng kết tuần trước đã có' });
      loopChanged();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Chưa viết được', description: errorText(e) });
    } finally {
      setRunning(false);
    }
  };
  return (
    <div class="flex flex-col gap-4">
      <LoopHeader title="Tổng kết tuần" actions={data?.folder ? <button type="button" class="control-button" disabled={running} onClick={() => void run()}>{running ? 'Đang viết…' : 'Viết bù tuần trước'}</button> : undefined} />
      <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Sáng thứ Hai 7:30, máy tính số liệu tuần trước và một bot viết phần lời vào một ghi chú trong brain. Máy tắt lúc đó thì lần mở sau sẽ viết bù.</p>
      <PageState loading={loading && !data} error={error} />
      {data && !data.folder && <NoFolder />}
      {data && data.folder && (
        <div class="flex flex-wrap items-start gap-4">
          <nav class="card card-pad flex min-w-0 flex-[1_1_220px] flex-col gap-1" aria-label="Các tuần">
            <code class="mb-1 text-[12px] text-[var(--color-text-muted)]">{data.dir}</code>
            {items.length === 0 && <span class="text-[12.5px] text-[var(--color-text-faint)]">Chưa có tổng kết nào.</span>}
            {items.map((r) => {
              const on = selected?.year === r.year && selected.week === r.week;
              return (
                <Link key={`${r.year}-${r.week}`} href={weekHref(r)} aria-current={on ? 'page' : undefined} class={`flex min-h-[44px] flex-col justify-center rounded-md px-2 py-1 no-underline ${on ? 'bg-[var(--color-accent-soft)] font-semibold' : ''} text-[var(--color-text)]`}>
                  <span class="text-[13px]">Tuần {r.week} · {dayMonth(r.from)}–{dayMonth(r.to)}</span>
                  <span class="text-[12px] font-normal text-[var(--color-text-muted)]">ER {pct(r.medianEr)}{r.newLessons ? ` · ${r.newLessons} giả thuyết mới` : ''}{r.approved ? ' · đã duyệt' : ''}</span>
                </Link>
              );
            })}
          </nav>
          {selected && <WeekDetail key={`${selected.year}-${selected.week}`} year={selected.year} week={selected.week} />}
        </div>
      )}
    </div>
  );
}
