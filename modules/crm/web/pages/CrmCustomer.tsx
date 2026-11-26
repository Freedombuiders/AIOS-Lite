import { useEffect, useState } from 'preact/hooks';
import { Link, useRoute } from 'wouter-preact';
import { PageState } from '@/components/PageState';
import { errorText } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import { snoozeOptions, type SnoozeId } from '@modules/care/web/lib/care/snooze';
import { DueChip, StageChip } from '../components/Chips';
import { CrmShell, PATH_ALL } from '../components/CrmShell';
import { crmApi } from '../lib/client';
import { initial, vnDate, vnFullDate, vnTime } from '../lib/format';
import { obsidianUrl } from '../lib/obsidian';
import type { BrainFolderLite, CareCustomerLite, CrmApi, CustomerDetailDto } from '../lib/types';
import { useCrmStatus } from '../lib/useCrm';

const SNOOZE_LABEL: Record<SnoozeId, string> = { oneHour: '1 giờ nữa', today17: '17:00 hôm nay', tomorrow9: '9:00 ngày mai', monday9: '9:00 thứ Hai' };
const MONO = 'font-[var(--font-mono)] text-[12px]';
const BTN = 'control-button !h-10 !px-3.5 !text-[13px] !font-semibold';

type FileState = { state: 'idle' } | { state: 'loading' } | { state: 'ok'; content: string } | { state: 'error'; message: string };

/** Hồ sơ một khách: fields (or the real markdown of the note), needs, activity, open follow-ups. Read-only except follow-ups. */
export function CrmCustomer({ api = crmApi, id: idProp, now = () => Date.now() }: { api?: CrmApi; id?: string; now?: () => number }) {
  const [, params] = useRoute('/m/crm/customer/:id');
  const id = idProp ?? (params?.id ? decodeURIComponent(params.id) : '');
  const status = useCrmStatus(api);
  const [detail, setDetail] = useState<CustomerDetailDto | null>(null);
  const [care, setCare] = useState<CareCustomerLite | null>(null);
  const [folders, setFolders] = useState<BrainFolderLite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'props' | 'file'>('props');
  const [file, setFile] = useState<FileState>({ state: 'idle' });
  const [busy, setBusy] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const nowMs = now();

  useEffect(() => {
    let live = true;
    setError(null);
    api.customer(id).then((d) => { if (live) setDetail(d); }).catch((e) => { if (live) setError(errorText(e)); });
    // care's own record: only needed for tasks and the chat link, so its failure is not fatal
    api.careCustomer(id).then((c) => { if (live) setCare(c); }).catch(() => { if (live) setCare(null); });
    return () => { live = false; };
  }, [api, id, n]);

  useEffect(() => {
    let live = true;
    api.brainFolders().then((f) => { if (live) setFolders(f); }).catch(() => undefined);
    return () => { live = false; };
  }, [api]);

  // the markdown is read only when the person asks for it
  useEffect(() => {
    if (mode !== 'file' || !detail?.folderId || !detail.notePath) return;
    let live = true;
    setFile({ state: 'loading' });
    api.noteFile(detail.folderId, detail.notePath)
      .then((f) => { if (live) setFile({ state: 'ok', content: f.content }); })
      .catch((e) => { if (live) setFile({ state: 'error', message: errorText(e) }); });
    return () => { live = false; };
  }, [api, mode, detail?.folderId, detail?.notePath, detail?.capNhatMs]);

  const folder = folders.find((f) => f.id === detail?.folderId);
  const obsidian = obsidianUrl(folder?.path, detail?.notePath);
  const conv = care?.conversations.slice().sort((a, b) => (a.primaryCustomerId === id ? 0 : 1) - (b.primaryCustomerId === id ? 0 : 1) || b.lastActivityMs - a.lastActivityMs)[0];
  const tasks = (care?.tasks ?? []).filter((t) => !t.done).sort((a, b) => a.dueAtMs - b.dueAtMs);

  async function act(taskId: string, revision: number, body: { done?: boolean; dueAtMs?: number }, ok: string): Promise<void> {
    if (busy) return;
    setBusy(taskId);
    try {
      await api.patchTask(taskId, { expectedRevision: revision, ...body });
      pushToast({ tone: 'success', title: ok });
      setN((x) => x + 1);
    } catch (e) {
      pushToast({ tone: 'error', title: 'Chưa cập nhật được việc', description: errorText(e) });
      setN((x) => x + 1); // the revision may be stale: show the truth
    } finally {
      setBusy(null);
    }
  }

  return (
    <CrmShell current="customer" status={status}>
      {error && <div class="p-6"><PageState error={error} /></div>}
      {!detail && !error && <div class="p-6"><PageState loading /></div>}
      {detail && (
        <>
          <header class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--color-border)] px-4 py-3 md:px-6">
            <Link href={PATH_ALL} class="inline-flex min-h-[40px] items-center font-semibold">‹ Khách hàng</Link>
            <span aria-hidden="true" class="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-[var(--color-elevated)] font-bold text-[var(--color-control-text)]">{initial(detail.ten)}</span>
            <div class="flex min-w-0 flex-col">
              <h1 class="m-0 truncate text-[20px] font-bold" data-testid="crm-customer-name">{detail.ten}</h1>
              <span class={`truncate text-[var(--color-text-faint)] ${MONO}`} data-testid="crm-note-path">{detail.notePath ? `${detail.folderId}/${detail.notePath}` : 'Chưa có ghi chú'}</span>
            </div>
            <StageChip stage={detail.giaiDoan} />
            <div class="ml-auto flex flex-wrap gap-2">
              {obsidian
                ? <a href={obsidian} class={BTN} data-testid="crm-obsidian">Mở bằng Obsidian</a>
                : <button type="button" class={BTN} disabled data-testid="crm-obsidian" title={detail.notePath ? 'Không dựng được đường dẫn tuyệt đối của thư mục này.' : 'Khách này chưa có file ghi chú.'}>Mở bằng Obsidian</button>}
              {conv
                ? <Link href={`/m/care/inbox/${encodeURIComponent(conv.id)}`} class={`${BTN} !border-[var(--color-accent)] !bg-[var(--color-accent)] !text-[var(--color-on-accent)]`} data-testid="crm-open-chat">Mở cuộc chat</Link>
                : <button type="button" class={BTN} disabled data-testid="crm-open-chat" title="Chưa có cuộc trò chuyện nào của khách này.">Mở cuộc chat</button>}
            </div>
          </header>

          <div class="flex flex-1 flex-wrap">
            <section aria-labelledby="thuoc-tinh" class="flex min-w-0 max-w-full flex-[1_1_300px] flex-col gap-3 border-b border-[var(--color-border)] py-4 pr-3.5 md:max-w-[360px] md:border-b-0 md:border-r">
              <div class="flex items-center gap-2">
                <h2 id="thuoc-tinh" class="m-0 flex-1 text-[15px] font-semibold">{mode === 'props' ? 'Thuộc tính' : 'File gốc'}</h2>
                <div role="group" aria-label="Cách xem thuộc tính" class="flex gap-1 rounded-[9px] border border-[var(--color-border)] bg-[var(--color-card)] p-[3px]">
                  <ModeButton on={mode === 'props'} onClick={() => setMode('props')}>Thuộc tính</ModeButton>
                  <ModeButton on={mode === 'file'} onClick={() => setMode('file')} testId="crm-file-toggle">File gốc</ModeButton>
                </div>
              </div>

              {mode === 'props' && <Props d={detail} />}
              {mode === 'file' && <RawFile d={detail} file={file} configured={status?.state !== 'chua-cau-hinh'} />}
              <span class="text-[13px] text-[var(--color-text-muted)]">
                {mode === 'props' ? 'Đây là phần đầu của file ghi chú, đọc từ dữ liệu Chăm sóc khách hàng. Sửa trong app, không sửa trong Obsidian: máy sẽ ghi đè lại.' : 'Nội dung thật của file markdown, đọc từ thư mục Second Brain.'}
              </span>
            </section>

            <section aria-label="Nội dung ghi chú" class="flex min-w-0 flex-[2.4_1_420px] flex-col gap-6 px-3.5 py-5 md:px-[26px]">
              <div class="flex flex-col gap-2.5">
                <h2 class="m-0 text-[17px] font-semibold">Khách cần gì</h2>
                {detail.nhuCau.length === 0 && !detail.ghiChuChamSoc && <p class="m-0 text-[var(--color-text-muted)]" data-testid="crm-need-empty">Chưa có thông tin. Nhu cầu của khách ghi ở hồ sơ trong Hộp thư.</p>}
                <div class="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))' }}>
                  {detail.nhuCau.map((x) => (
                    <div key={x.field} class="card flex flex-col gap-1.5 !px-3.5 !py-3" data-testid="crm-need">
                      <span class="text-[12px] font-semibold uppercase text-[var(--color-accent-hover)]">{x.label}</span>
                      <span class="[overflow-wrap:anywhere]">{x.value}</span>
                    </div>
                  ))}
                  {detail.ghiChuChamSoc && (
                    <div class="card flex flex-col gap-1.5 !px-3.5 !py-3">
                      <span class="text-[12px] font-semibold uppercase text-[var(--color-status-done)]">Ghi chú chăm sóc</span>
                      <span class="[overflow-wrap:anywhere]">{detail.ghiChuChamSoc}</span>
                    </div>
                  )}
                </div>
              </div>

              <div class="flex flex-col gap-2.5">
                <h2 class="m-0 text-[17px] font-semibold">Nhật ký</h2>
                {detail.nhatKy.length === 0 && <p class="m-0 text-[var(--color-text-muted)]">Chưa có thay đổi nào.</p>}
                {detail.nhatKy.map((e, i) => (
                  <div key={`${e.atMs}-${i}`} class="flex gap-3.5" data-testid="crm-log">
                    <span class="w-[92px] flex-none pt-px text-[13px] tabular-nums text-[var(--color-text-muted)]">{vnDate(e.atMs)} {vnTime(e.atMs)}</span>
                    <span class="min-w-0 flex-1 border-l-2 border-[var(--color-accent)] pb-3 pl-3.5">{e.text}</span>
                  </div>
                ))}
                <span class="text-[13px] text-[var(--color-text-muted)]">Chỉ ghi thay đổi hồ sơ và việc cần làm, không chép nội dung tin nhắn.</span>
              </div>
            </section>

            <aside aria-label="Việc tiếp theo" class="flex min-w-0 max-w-full flex-[1_1_280px] flex-col gap-4 border-t border-[var(--color-border)] py-4 pl-3.5 md:max-w-[340px] md:border-l md:border-t-0">
              <span class="section-title">Việc tiếp theo</span>
              {care === null && <span class="text-[13px] text-[var(--color-text-muted)]">Đang lấy việc cần làm…</span>}
              {care && tasks.length === 0 && <p class="m-0 text-[13px] text-[var(--color-text-muted)]" data-testid="crm-no-tasks">Không còn việc nào chưa xong.</p>}
              {tasks.map((t) => (
                <div key={t.id} class="flex flex-col gap-1.5" data-testid="crm-task" data-task-id={t.id}>
                  <span class="font-semibold">{t.title}</span>
                  <span class="flex items-center gap-2 text-[13px] text-[var(--color-text-muted)]">Hạn {vnFullDate(t.dueAtMs)} <DueChip dueAtMs={t.dueAtMs} nowMs={nowMs} /></span>
                  <div class="flex flex-wrap gap-2 pt-1">
                    <button type="button" class={BTN} disabled={busy === t.id} onClick={() => void act(t.id, t.revision, { done: true }, 'Đã xong việc')} data-testid="crm-task-done">Xong</button>
                    <select
                      class="field !h-10 !w-auto"
                      aria-label={`Dời hạn: ${t.title}`}
                      value=""
                      disabled={busy === t.id}
                      data-testid="crm-task-postpone"
                      onChange={(e) => {
                        const v = (e.target as HTMLSelectElement).value as SnoozeId;
                        const opt = snoozeOptions(now()).find((o) => o.id === v);
                        if (opt) void act(t.id, t.revision, { dueAtMs: opt.untilMs }, `Đã dời hạn đến ${vnDate(opt.untilMs)} ${vnTime(opt.untilMs)}`);
                      }}
                    >
                      <option value="">Dời hạn…</option>
                      {snoozeOptions(nowMs).map((o) => <option key={o.id} value={o.id}>{SNOOZE_LABEL[o.id]}</option>)}
                    </select>
                  </div>
                </div>
              ))}
            </aside>
          </div>
        </>
      )}
    </CrmShell>
  );
}

function ModeButton(props: { on: boolean; onClick: () => void; testId?: string; children: string }) {
  return (
    <button type="button" aria-pressed={props.on} onClick={props.onClick} data-testid={props.testId} class={`min-h-9 cursor-pointer rounded-md border-0 px-2.5 text-[13px] font-semibold ${props.on ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)]' : 'bg-transparent text-[var(--color-control-text)]'}`}>{props.children}</button>
  );
}

function Props({ d }: { d: CustomerDetailDto }) {
  const rows: Array<[string, string | null]> = [
    ['ten', d.ten],
    ['sdt', d.sdt],
    ['giai_doan', d.giaiDoanGhiChu],
    ['the', d.the.length ? d.the.join(', ') : null],
    ['viec_tiep', d.viecTiep?.title ?? null],
    ['han', d.viecTiep ? vnFullDate(d.viecTiep.dueAtMs) : null],
    ['cap_nhat', `${vnFullDate(d.capNhatMs)} ${vnTime(d.capNhatMs)}`],
  ];
  return (
    <dl class="m-0 grid text-[14px]" style={{ gridTemplateColumns: '104px minmax(0, 1fr)' }} data-testid="crm-props">
      {rows.map(([k, v]) => (
        <>
          <dt key={`k-${k}`} class={`border-b border-[var(--color-border)] py-2.5 text-[var(--color-text-faint)] ${MONO}`}>{k}</dt>
          <dd key={`v-${k}`} class={`m-0 border-b border-[var(--color-border)] py-2.5 [overflow-wrap:anywhere] ${v ? '' : 'text-[var(--color-text-faint)]'}`}>{v ?? '—'}</dd>
        </>
      ))}
      {(d.email || d.congTy) && (
        <>
          {d.email && <><dt class={`border-b border-[var(--color-border)] py-2.5 text-[var(--color-text-faint)] ${MONO}`}>email</dt><dd class="m-0 border-b border-[var(--color-border)] py-2.5 [overflow-wrap:anywhere]">{d.email}</dd></>}
          {d.congTy && <><dt class={`border-b border-[var(--color-border)] py-2.5 text-[var(--color-text-faint)] ${MONO}`}>cong_ty</dt><dd class="m-0 border-b border-[var(--color-border)] py-2.5 [overflow-wrap:anywhere]">{d.congTy}</dd></>}
        </>
      )}
    </dl>
  );
}

function RawFile({ d, file, configured }: { d: CustomerDetailDto; file: FileState; configured: boolean }) {
  if (!d.notePath) {
    return (
      <p class="m-0 rounded-xl border border-dashed border-[var(--color-border-strong)] px-3.5 py-3 text-[13px] text-[var(--color-text-muted)]" data-testid="crm-file-none">
        {configured ? 'Khách này chưa có file ghi chú. Máy tạo file trong vài giây sau khi khách thay đổi.' : 'Chưa chọn thư mục Second Brain nên chưa có file ghi chú nào.'}
      </p>
    );
  }
  if (file.state === 'idle' || file.state === 'loading') return <PageState loading />;
  if (file.state === 'error') return <PageState error={`Không đọc được file ${d.notePath}: ${file.message}`} />;
  return <pre data-testid="crm-file" class="m-0 whitespace-pre-wrap rounded-xl border border-[var(--color-border)] bg-[var(--color-sidebar)] p-3.5 text-[12.5px] leading-[1.7] text-[var(--color-control-text)] [overflow-wrap:anywhere] font-[var(--font-mono)]">{file.content}</pre>;
}
