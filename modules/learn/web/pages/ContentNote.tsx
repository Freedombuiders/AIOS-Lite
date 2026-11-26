// One post's note (drawing: ContentNote.dc.html): its properties, the numbers per milestone, and how it compares
// with the other posts at the same milestone. Numbers only; no "why" text from a bot in this version.
import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import { Link, useParams } from 'wouter-preact';
import { PageState } from '@/components/PageState';
import { useFetch } from '@/lib/useFetch';
import { MILESTONE_LABELS, MILESTONE_SECONDS, int, pct, shortDate } from '@modules/learn/web/lib/format';
import type { BrainFolderView, PostDto } from '@modules/learn/web/lib/types';

type Entry = Record<string, unknown> & { moc: string };

const MACHINE = new Set(['so_do', 'moc_da_do', 'do_dai', 'so_chu', 'ma_bai', 'link', 'dang_luc', 'id', 'nen_tang', 'loai']);
const FROM_STUDIO = new Set(['tieu_de', 'dinh_dang', 'tru_cot', 'mo_dau', 'kieu_hook']);
const LINEAGE = new Set(['de_xuat', 'cong_thuc', 'cong_thuc_phien_ban', 'hoc_tu', 'ky_vong']);
const HIDDEN = new Set(['so_do', 'loai']);

function sourceOf(key: string): string {
  if (MACHINE.has(key)) return 'máy lấy về';
  if (FROM_STUDIO.has(key)) return 'từ Kho nội dung, sửa được';
  if (LINEAGE.has(key)) return 'nguồn gốc bài';
  return 'bạn thêm';
}

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.map(show).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** The person's text: the body without the machine block. */
function ownText(body: string): string {
  return body.replace(/<!--\s*aios:begin so-do\s*-->[\s\S]*?<!--\s*aios:end so-do\s*-->\n?/, '').replace(/\n{3,}/g, '\n\n').trim();
}

function decodePath(raw: string | undefined): string {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function ContentNote() {
  const params = useParams<{ path: string }>();
  const path = decodePath(params.path);
  const [moc, setMoc] = useState<string>('');
  const url = `/api/m/learn/posts/${encodeURIComponent(path)}${moc ? `?moc=${moc}` : ''}`;
  const { data, loading, error } = useFetch<PostDto>(path ? url : null);
  const folders = useFetch<{ items: BrainFolderView[] }>('/brain/folders');

  const d = data?.data ?? {};
  const soDo = (Array.isArray(d.so_do) ? d.so_do : []).filter((e): e is Entry => !!e && typeof e === 'object' && typeof (e as Entry).moc === 'string');
  const c = data?.comparison ?? null;
  const folderPath = folders.data?.items.find((f) => f.id === data?.folder)?.path;
  const obsidian = folderPath ? `obsidian://open?path=${encodeURIComponent(`${folderPath}/${path}`)}` : null;
  const maxReach = Math.max(0, ...soDo.map((e) => (typeof e.reach === 'number' ? e.reach : 0)));
  const published = typeof d.dang_luc === 'string' ? Date.parse(d.dang_luc) : NaN;
  const upcoming = Number.isFinite(published)
    ? Object.entries(MILESTONE_SECONDS).filter(([m, s]) => !soDo.some((e) => e.moc === m) && published + s * 1000 > Date.now())
      .map(([m, s]) => `${MILESTONE_LABELS[m]} (${shortDate(new Date(published + s * 1000).toISOString())})`)
    : [];

  return (
    <div class="flex flex-col gap-4">
      <header class="flex flex-wrap items-center gap-3.5">
        <Link href="/m/learn" class="text-[13px] font-semibold">‹ Phân tích nội dung</Link>
        <div class="flex min-w-0 flex-col">
          <h1 class="m-0 text-[18px] font-semibold">{show(d.tieu_de) === '—' ? path.split('/').pop() : show(d.tieu_de)}</h1>
          <span class="mono truncate text-[12px] text-[var(--color-text-muted)]">{data?.folder ? `${data.folder}/` : ''}{path}</span>
        </div>
        {c?.diffPct !== null && c?.diffPct !== undefined && (
          <span class={`pill ${c.diffPct >= 0 ? 'pill-success' : 'pill-warn'}`} title={`So với trung vị ER của ${c.others.n} bài khác ở mốc ${c.mocLabel}`}>
            {c.diffPct >= 0 ? 'Cao hơn' : 'Thấp hơn'} trung vị {Math.abs(c.diffPct)}%{c.others.lowSample ? ' · ít mẫu' : ''}
          </span>
        )}
        {obsidian && <a class="control-button ml-auto no-underline" href={obsidian}>Mở bằng Obsidian</a>}
      </header>

      <PageState loading={loading && !data} error={error} />

      {data && (
        <div class="flex flex-wrap items-start gap-4">
          <section class="card card-pad flex min-w-0 flex-[1_1_300px] flex-col gap-2" aria-labelledby="thuoc-tinh">
            <h2 id="thuoc-tinh" class="m-0 text-[15px] font-semibold">Thuộc tính</h2>
            <dl class="m-0 grid grid-cols-[minmax(90px,auto)_1fr] gap-x-3 gap-y-1.5 text-[13px]">
              {Object.entries(d).filter(([k]) => !HIDDEN.has(k)).map(([k, v]) => (
                <Fragment key={k}>
                  <dt class="mono text-[12px] text-[var(--color-text-muted)]">{k}</dt>
                  <dd class="m-0 flex min-w-0 flex-col">
                    <span class="break-words">{k === 'link' && typeof v === 'string' ? <a href={v} target="_blank" rel="noreferrer">{v}</a> : show(v)}</span>
                    <span class="text-[11px] text-[var(--color-text-faint)]">{sourceOf(k)}</span>
                  </dd>
                </Fragment>
              ))}
            </dl>
            <span class="text-[12px] text-[var(--color-text-faint)]">Số đo do máy lấy từ Facebook. Trụ cột và kiểu mở đầu lấy từ Kho nội dung; bạn sửa trong ghi chú thì máy giữ bản của bạn.</span>
          </section>

          <section class="flex min-w-0 flex-[1.6_1_480px] flex-col gap-4" aria-label="Số đo">
            <div class="card card-pad flex flex-col gap-2.5">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="m-0 text-[15px] font-semibold">Số đo theo mốc</h2>
                <label class="ml-auto flex items-center gap-1.5 text-[12.5px]">
                  So ở mốc
                  <select class="field w-auto" value={c?.moc ?? ''} onChange={(e) => setMoc((e.target as HTMLSelectElement).value)}>
                    {data.mocs.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </label>
              </div>
              {soDo.length === 0 ? (
                <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Chưa có số đo. Máy tự đo ở các mốc 1 giờ, 6 giờ, 24 giờ, 3 ngày, 7 ngày và 28 ngày.</p>
              ) : (
                <>
                  <div role="img" aria-label={`Reach theo mốc: ${soDo.map((e) => `${int(e.reach as number)} sau ${MILESTONE_LABELS[e.moc] ?? e.moc}`).join(', ')}`} class="flex h-[120px] items-end gap-2">
                    {soDo.map((e) => (
                      <div key={e.moc} class="flex flex-1 flex-col items-center justify-end gap-1" title={`${MILESTONE_LABELS[e.moc] ?? e.moc}: reach ${int(e.reach as number)}, ER ${pct(e.er as number)}`}>
                        <span class="text-[11.5px] tabular-nums">{int(e.reach as number)}</span>
                        <div class="w-full rounded-t bg-[var(--color-accent)]" style={{ height: `${maxReach > 0 && typeof e.reach === 'number' ? Math.max(4, Math.round((e.reach / maxReach) * 84)) : 2}px`, opacity: e.moc === c?.moc ? 1 : 0.55 }} />
                      </div>
                    ))}
                  </div>
                  <div class="flex gap-2 text-[11.5px] text-[var(--color-text-muted)]">
                    {soDo.map((e) => <span key={e.moc} class="flex-1 text-center">{MILESTONE_LABELS[e.moc] ?? e.moc}</span>)}
                  </div>
                  <table class="table">
                    <thead><tr><th>Mốc</th><th class="text-right">Reach</th><th class="text-right">ER</th><th class="text-right">Xem TB</th><th class="text-right">Bình luận</th><th class="text-right">Chia sẻ</th></tr></thead>
                    <tbody>
                      {soDo.map((e) => (
                        <tr key={e.moc}>
                          <td>{MILESTONE_LABELS[e.moc] ?? e.moc}</td>
                          <td class="text-right tabular-nums">{int(e.reach as number)}</td>
                          <td class="text-right tabular-nums">{pct(e.er as number)}</td>
                          <td class="text-right tabular-nums">{typeof e.tb_xem === 'number' ? `${e.tb_xem} giây` : '—'}</td>
                          <td class="text-right tabular-nums">{int(e.binh_luan as number)}</td>
                          <td class="text-right tabular-nums">{int(e.chia_se as number)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              {upcoming.length > 0 && <span class="text-[12.5px] text-[var(--color-text-muted)]">Còn {upcoming.length} mốc sẽ tự đo: {upcoming.join(', ')}.</span>}
            </div>

            {c && (
              <div class="card card-pad flex flex-col gap-1.5 text-[13px]">
                <h2 class="m-0 text-[15px] font-semibold">So với các bài khác ở mốc {c.mocLabel}</h2>
                <span>ER của bài: <b>{pct(c.er)}</b>{c.er === null ? ' (chưa đo ở mốc này)' : ''}</span>
                <span>Trung vị {c.others.n} bài Facebook khác trong {data.days} ngày: <b>{pct(c.others.medianEr)}</b>{c.others.lowSample ? ' · ít mẫu' : ''}</span>
                <span>Trung vị {c.sameFormat.n} bài cùng dạng {c.sameFormat.label.toLowerCase()}: <b>{pct(c.sameFormat.medianEr)}</b>{c.sameFormat.lowSample ? ' · ít mẫu' : ''}</span>
                <span class="text-[12px] text-[var(--color-text-faint)]">Một bài chưa đủ để kết luận. Chỉ so các bài đo cùng mốc; bài này không nằm trong trung vị.</span>
              </div>
            )}

            <div class="card card-pad flex flex-col gap-2">
              <h2 class="m-0 text-[15px] font-semibold">Nội dung</h2>
              <pre class="m-0 whitespace-pre-wrap break-words font-[inherit] text-[13px]">{ownText(data.body) || '—'}</pre>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
