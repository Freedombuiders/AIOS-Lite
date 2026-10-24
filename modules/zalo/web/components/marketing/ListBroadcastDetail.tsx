import { useState } from 'preact/hooks';
import { ArrowLeft, Pause, Pencil, Play, RefreshCw, RotateCcw, Trash2, Users, X } from 'lucide-preact';
import { ConfirmModal } from '@/components/ConfirmModal';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { Tab } from '@/components/PageHeader';
import { apiDelete, apiPost } from '@/lib/api';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import {
  BTN, BTN_ACCENT, RECIPIENT_LABEL, RECIPIENT_TONE, STATE_LABEL, STATE_TONE,
  errMsg, errorLabel, fmtDateTime, pauseLabel, stopLabel,
  type ListDetail, type ListRecipient, type ListRecipientState,
} from './ListBroadcastTypes';

const PAGE_SIZE = 50;

interface Props {
  id: number;
  accountLabel: (accountId: string) => string;
  onBack: () => void;
  onEdit: () => void;
  onDeleted: () => void;
}

export function ListBroadcastDetail({ id, accountLabel, onBack, onEdit, onDeleted }: Props) {
  const detail = useFetch<ListDetail>(`/api/m/zalo/list-broadcasts/${id}`, 10_000);
  const [filter, setFilter] = useState<ListRecipientState | 'all'>('all');
  const [offset, setOffset] = useState(0);
  const query = `/api/m/zalo/list-broadcasts/${id}/recipients?limit=${PAGE_SIZE}&offset=${offset}${filter === 'all' ? '' : `&state=${filter}`}`;
  const recipients = useFetch<{ total: number; recipients: ListRecipient[] }>(query, 15_000);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null);

  const d = detail.data;
  const b = d?.broadcast;

  function refreshAll() {
    invalidateFetchCache('/api/m/zalo/list-broadcasts');
    detail.refresh();
    recipients.refresh();
  }

  async function act(path: string, ok: (r: any) => string) {
    setBusy(true);
    try {
      const r = await apiPost(`/api/m/zalo/list-broadcasts/${id}/${path}`);
      pushToast({ tone: 'success', title: ok(r) });
      refreshAll();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không thực hiện được', description: errMsg(err) });
    } finally {
      setBusy(false);
    }
  }

  async function skip(r: ListRecipient) {
    try {
      await apiPost(`/api/m/zalo/list-broadcasts/${id}/recipients/${r.id}/skip`);
      refreshAll();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không bỏ qua được', description: errMsg(err) });
    }
  }

  async function remove() {
    try {
      await apiDelete(`/api/m/zalo/list-broadcasts/${id}`);
      invalidateFetchCache('/api/m/zalo/list-broadcasts');
      pushToast({ tone: 'success', title: 'Đã xoá chiến dịch' });
      onDeleted();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không xoá được', description: errMsg(err) });
    }
  }

  if (!d || !b) return detail.error ? <PageState error={detail.error} /> : <PageState loading />;

  const { counts } = b;
  const done = counts.sent + counts.failed + counts.skipped;
  const pct = counts.total > 0 ? Math.round((done / counts.total) * 100) : 0;
  const editable = b.state === 'draft' || b.state === 'paused';
  const listed = recipients.data?.recipients ?? [];
  const total = recipients.data?.total ?? 0;

  return (
    <div class="flex-1 overflow-y-auto px-6 py-5">
      <div class="w-full min-w-0 flex flex-col gap-5">
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" class={BTN} onClick={onBack}><ArrowLeft size={13} /> Danh sách</button>
          <h2 class="text-[15px] font-semibold text-[var(--color-text)] mx-1">{b.name}</h2>
          <Pill tone={STATE_TONE[b.state]}>{STATE_LABEL[b.state]}</Pill>
          <div class="ml-auto flex flex-wrap gap-2">
            {b.state === 'draft' && <button type="button" class={BTN_ACCENT} disabled={busy} onClick={() => void act('activate', () => 'Đã kích hoạt chiến dịch')}><Play size={12} /> Kích hoạt</button>}
            {b.state === 'active' && <button type="button" class={BTN} disabled={busy} onClick={() => void act('pause', () => 'Đã tạm dừng')}><Pause size={12} /> Tạm dừng</button>}
            {b.state === 'paused' && <button type="button" class={BTN_ACCENT} disabled={busy} onClick={() => void act('resume', () => 'Chiến dịch tiếp tục chạy')}><Play size={12} /> Tiếp tục</button>}
            {b.state !== 'completed' && b.state !== 'cancelled' && (
              <button type="button" class={BTN} disabled={busy} onClick={() => void act('sync-recipients', (r) => `Đã thêm ${r.added} khách mới (tổng ${r.total})`)}><Users size={12} /> Đồng bộ người nhận</button>
            )}
            {counts.failed > 0 && b.state !== 'draft' && b.state !== 'cancelled' && (
              <button type="button" class={BTN} disabled={busy} onClick={() => void act('retry-failed', (r) => r.requeued > 0 ? `Đã xếp lại ${r.requeued} người lỗi` : 'Không còn người lỗi nào thử lại được (tối đa 3 lần)')}><RotateCcw size={12} /> Gửi lại người lỗi</button>
            )}
            {editable && <button type="button" class={BTN} onClick={onEdit}><Pencil size={12} /> Sửa</button>}
            {b.state !== 'completed' && b.state !== 'cancelled' && (
              <button type="button" class={`${BTN} text-[var(--color-status-failed)]`} disabled={busy} onClick={() => setConfirm('cancel')}><X size={12} /> Huỷ</button>
            )}
            {b.state !== 'active' && b.state !== 'paused' && (
              <button type="button" class={`${BTN} text-[var(--color-status-failed)]`} onClick={() => setConfirm('delete')}><Trash2 size={12} /> Xoá</button>
            )}
          </div>
        </div>

        {b.state === 'paused' && b.pausedReason && b.pausedReason !== 'MANUAL' && (
          <div class="rounded-lg border border-[color-mix(in_srgb,var(--color-priority-high)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-priority-high)_8%,transparent)] px-4 py-3 text-[12.5px] text-[var(--color-text)]">
            Chiến dịch đã tự tạm dừng: {pauseLabel(b.pausedReason)}. Kiểm tra rồi bấm “Tiếp tục”.
          </div>
        )}

        <section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4 flex flex-col gap-3">
          <div class="flex items-center gap-3 text-[12px] text-[var(--color-text-muted)]">
            <span class="text-[var(--color-text)] font-medium tabular-nums">{done}/{counts.total}</span> khách đã xử lý ({pct}%)
            <span class="ml-auto tabular-nums">Hôm nay: {b.sentToday}/{b.dailyQuota}</span>
          </div>
          <div class="h-2 rounded-full bg-[var(--color-elevated)] overflow-hidden flex">
            <div style={{ width: `${counts.total ? (counts.sent / counts.total) * 100 : 0}%`, background: 'var(--color-status-done)' }} />
            <div style={{ width: `${counts.total ? (counts.failed / counts.total) * 100 : 0}%`, background: 'var(--color-status-failed)' }} />
            <div style={{ width: `${counts.total ? (counts.skipped / counts.total) * 100 : 0}%`, background: 'var(--color-text-faint)' }} />
          </div>
          <div class="flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-[var(--color-text-muted)]">
            <span>Đã gửi <b class="text-[var(--color-text)]">{counts.sent}</b></span>
            <span>Chờ gửi <b class="text-[var(--color-text)]">{counts.pending}</b></span>
            <span>Lỗi <b class="text-[var(--color-text)]">{counts.failed}</b></span>
            <span>Bỏ qua <b class="text-[var(--color-text)]">{counts.skipped}</b></span>
          </div>
          <div class="grid gap-x-6 gap-y-1 text-[12px] text-[var(--color-text-muted)] sm:grid-cols-2">
            <div>Nick: {b.accounts.map((a) => a.label).join(', ')}</div>
            <div>Mẫu tin: {b.templateName ?? <span class="text-[var(--color-status-failed)]">đã bị xoá</span>}</div>
            <div>Khung giờ: {b.windowStart}–{b.windowEnd} ({b.timezone}){b.daysOfWeek.length > 0 && b.daysOfWeek.length < 7 ? ' · một số ngày trong tuần' : ''}</div>
            <div>Giãn cách: {b.minDelaySec}–{b.maxDelaySec} giây · {b.dailyQuota} khách/ngày · {b.perNickDailyQuota}/nick</div>
            {b.state === 'active' && (
              <div class="sm:col-span-2">
                {d.windowOpenNow
                  ? 'Đang trong khung giờ gửi.'
                  : d.nextWindowOpenAt ? `Ngoài khung giờ. Lượt gửi kế tiếp: ${fmtDateTime(d.nextWindowOpenAt)}.` : 'Đã hết lịch gửi (quá ngày kết thúc).'}
              </div>
            )}
            {counts.pending > 0 && <div class="sm:col-span-2">Ước tính còn ~{d.estimate.sendingDays} ngày gửi cho {counts.pending} khách chờ.</div>}
          </div>
          {d.estimate.warnings.map((w) => (
            <div key={w} class="text-[11.5px] text-[var(--color-priority-high)]">{w}</div>
          ))}
          <div class="text-[11px] text-[var(--color-text-faint)]">Chỉ gửi cho khách đã nhắn tin 1-1 với nick; khách đã từ chối nhận tin tự động bị loại, kể cả khi từ chối sau lúc tạo danh sách.</div>
        </section>

        <section>
          <h3 class="text-[13px] font-semibold text-[var(--color-text)] mb-2">Các lượt gửi</h3>
          {d.batches.length === 0 ? (
            <div class="text-[12px] text-[var(--color-text-faint)]">Chưa có lượt nào. Mỗi lượt gửi tối đa 25 khách, kiểm tra mỗi phút.</div>
          ) : (
            <div class="rounded-lg border border-[var(--color-border)] overflow-x-auto">
              <table class="w-full text-[12px]">
                <thead>
                  <tr class="text-left text-[11px] text-[var(--color-text-faint)] border-b border-[var(--color-border)]">
                    <th class="px-3 py-2 font-medium">Bắt đầu</th>
                    <th class="px-3 py-2 font-medium">Kết thúc</th>
                    <th class="px-3 py-2 font-medium text-right">Đã gửi</th>
                    <th class="px-3 py-2 font-medium text-right">Lỗi</th>
                    <th class="px-3 py-2 font-medium text-right">Bỏ qua</th>
                    <th class="px-3 py-2 font-medium">Lý do dừng</th>
                  </tr>
                </thead>
                <tbody>
                  {d.batches.map((x) => (
                    <tr key={x.id} class="border-b last:border-b-0 border-[var(--color-border)]">
                      <td class="px-3 py-2 whitespace-nowrap">{fmtDateTime(x.startedAt)}</td>
                      <td class="px-3 py-2 whitespace-nowrap">{x.finishedAt ? fmtDateTime(x.finishedAt) : <Pill tone="running">Đang gửi</Pill>}</td>
                      <td class="px-3 py-2 text-right tabular-nums">{x.sent}</td>
                      <td class="px-3 py-2 text-right tabular-nums">{x.failed}</td>
                      <td class="px-3 py-2 text-right tabular-nums">{x.skipped}</td>
                      <td class="px-3 py-2 text-[var(--color-text-muted)]">{x.finishedAt ? stopLabel(x.stopReason) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <div class="flex flex-wrap items-center gap-2 mb-2">
            <h3 class="text-[13px] font-semibold text-[var(--color-text)]">Người nhận</h3>
            <div class="flex gap-1 ml-auto overflow-x-auto">
              <Tab label="Tất cả" active={filter === 'all'} count={counts.total} onClick={() => { setFilter('all'); setOffset(0); }} />
              {(['pending', 'sent', 'failed', 'skipped'] as ListRecipientState[]).map((s) => (
                <Tab key={s} label={RECIPIENT_LABEL[s]} active={filter === s} count={counts[s]} onClick={() => { setFilter(s); setOffset(0); }} />
              ))}
            </div>
            <button type="button" class={BTN} onClick={refreshAll} aria-label="Làm mới"><RefreshCw size={12} /></button>
          </div>
          {listed.length === 0 ? (
            <div class="text-[12px] text-[var(--color-text-faint)]">{recipients.loading ? 'Đang tải…' : 'Không có người nhận nào ở trạng thái này.'}</div>
          ) : (
            <div class="rounded-lg border border-[var(--color-border)] overflow-x-auto">
              <table class="w-full text-[12px]">
                <tbody>
                  {listed.map((r) => (
                    <tr key={r.id} class="border-b last:border-b-0 border-[var(--color-border)]">
                      <td class="px-3 py-2 text-[var(--color-text)] max-w-[220px] truncate">{r.name || 'Không tên'}</td>
                      <td class="px-3 py-2 text-[var(--color-text-faint)] whitespace-nowrap">{accountLabel(r.accountId)}</td>
                      <td class="px-3 py-2 w-[90px]"><Pill tone={RECIPIENT_TONE[r.state]}>{RECIPIENT_LABEL[r.state]}</Pill></td>
                      <td class="px-3 py-2 text-[var(--color-text-muted)]">
                        {r.errorCode ? errorLabel(r.errorCode) : r.state === 'sent' ? fmtDateTime(r.sentAt) : r.sentSteps > 0 ? 'Đã gửi một phần' : ''}
                        {r.attempts > 1 && <span class="text-[var(--color-text-faint)]"> · lần {r.attempts}</span>}
                      </td>
                      <td class="px-3 py-2 w-[110px] text-right">
                        {(r.state === 'pending' || r.state === 'failed') && (
                          <button type="button" class="text-[11.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline" onClick={() => void skip(r)}>Bỏ qua</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {total > PAGE_SIZE && (
            <div class="flex items-center gap-2 mt-2 text-[12px] text-[var(--color-text-muted)]">
              <button type="button" class={BTN} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Trước</button>
              <span class="tabular-nums">{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} / {total}</span>
              <button type="button" class={BTN} disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Sau</button>
            </div>
          )}
        </section>
      </div>

      <ConfirmModal
        open={confirm === 'cancel'}
        onClose={() => setConfirm(null)}
        onConfirm={() => { setConfirm(null); void act('cancel', () => 'Đã huỷ chiến dịch'); }}
        title="Huỷ chiến dịch?"
        body="Chiến dịch dừng hẳn, các khách chưa nhận sẽ không được gửi nữa. Không hoàn tác được."
        confirmLabel="Huỷ chiến dịch"
        cancelLabel="Giữ lại"
        destructive
      />
      <ConfirmModal
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        onConfirm={() => { setConfirm(null); void remove(); }}
        title="Xoá chiến dịch?"
        body="Xoá luôn danh sách người nhận và nhật ký các lượt gửi. Tin đã gửi vẫn nằm trong lịch sử chat."
        confirmLabel="Xoá"
        cancelLabel="Giữ lại"
        destructive
      />
    </div>
  );
}
