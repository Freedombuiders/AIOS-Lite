import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import { ChevronDown, ChevronRight, Pause, Pencil, Play, RotateCcw, Send, Trash2, XCircle } from 'lucide-preact';
import { ConfirmModal } from '@/components/ConfirmModal';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import {
  apiErrorMessage, BROADCAST_STATE_LABEL, BROADCAST_STATE_TONE, describeSchedule, errorLabel, reasonLabel,
  RUN_STATE_LABEL, RUN_STATE_TONE, TARGET_STATE_LABEL, TARGET_STATE_TONE, TRIGGER_LABEL,
  type Broadcast, type BroadcastDetail as Detail,
} from './GroupBroadcastModel';
import { apiDelete, apiPost } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { formatFullTime } from '../../lib/zalo';

const BTN = 'toolbar-control control-button inline-flex items-center gap-1.5 px-3 rounded-md text-[12px] text-[var(--color-text)] hover:bg-[var(--color-control-hover)] disabled:opacity-40';
const BTN_ACCENT = 'control-button inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium control-accent disabled:opacity-40';
const MAX_TARGET_ATTEMPTS = 3;

const sec = (s: number | null): string => (s ? formatFullTime(s * 1000) : '—');

interface Props {
  id: number;
  onBack: () => void;
  onEdit: (b: Broadcast) => void;
  /** Refresh the list behind the detail after a change. */
  onChanged: () => void;
}

type Confirm = 'cancel' | 'delete' | null;

export function GroupBroadcastDetail({ id, onBack, onEdit, onChanged }: Props) {
  const detail = useFetch<Detail>(`/api/m/zalo/group-broadcasts/${id}`, 5_000);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [openRun, setOpenRun] = useState<number | null>(null);

  if (detail.loading && !detail.data) return <PageState loading />;
  if (detail.error || !detail.data) return <PageState error={detail.error ?? 'Không tìm thấy lịch gửi'} />;

  const { broadcast: b, groups, runs } = detail.data;
  const latest = runs[0];
  const latestDone = latest && latest.state !== 'pending' && latest.state !== 'running';
  const retryable = !!latest && latestDone && (latest.targets ?? []).some(
    (t) => (t.state === 'failed' || t.state === 'pending') && t.attempts < MAX_TARGET_ATTEMPTS,
  );
  const runActive = runs.some((r) => r.state === 'pending' || r.state === 'running');
  const shownRun = openRun ?? latest?.id ?? null;

  async function act(path: string, ok: string, method: 'post' | 'delete' = 'post') {
    setBusy(true);
    try {
      if (method === 'delete') await apiDelete(`/api/m/zalo/group-broadcasts/${id}`);
      else await apiPost(`/api/m/zalo/group-broadcasts/${id}/${path}`);
      pushToast({ tone: 'success', title: ok });
      invalidateFetchCache('/api/m/zalo/group-broadcasts');
      onChanged();
      if (method === 'delete') onBack();
      else detail.refresh();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không thực hiện được', description: apiErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const canRun = b.state !== 'cancelled' && !runActive;

  return (
    <div class="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-5 w-full min-w-0">
      <section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4 flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-[15px] font-semibold text-[var(--color-text)]">{b.name}</h2>
          <Pill tone={BROADCAST_STATE_TONE[b.state]}>{BROADCAST_STATE_LABEL[b.state]}</Pill>
        </div>

        {b.state === 'paused' && b.pausedReason && (
          <div class="rounded border border-[var(--color-border)] bg-[var(--color-elevated)] px-3 py-2 text-[12px] text-[var(--color-text)]">
            Lịch đang tạm dừng: {reasonLabel(b.pausedReason)}.
            {b.pausedReason === 'CONSECUTIVE_FAILURES' && ' Kiểm tra nick Zalo và các nhóm đích rồi bấm Tiếp tục.'}
          </div>
        )}

        <dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-[12.5px]">
          <Row label="Nick gửi" value={b.accountName || b.accountId} />
          <Row label="Mẫu tin" value={b.templateName ?? 'Mẫu đã bị xoá'} />
          <Row label="Lịch" value={describeSchedule(b)} />
          <Row label="Múi giờ" value={b.timezone} />
          {(b.startDate || b.endDate) && <Row label="Thời gian áp dụng" value={`${b.startDate ?? '…'} → ${b.endDate ?? '…'}`} />}
          <Row label="Giãn cách giữa 2 nhóm" value={`${b.minDelaySec}–${b.maxDelaySec} giây`} />
          <Row label="Lượt gửi kế tiếp" value={b.state === 'active' ? sec(b.nextRunAt) : '—'} />
          <Row label="Nhóm nhận tin" value={`${groups.length} nhóm`} />
        </dl>
        <details class="text-[12px] text-[var(--color-text-muted)]">
          <summary class="cursor-pointer select-none">Xem danh sách nhóm</summary>
          <ul class="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-x-6 list-disc pl-5">
            {groups.map((g) => <li key={g.threadId} class="truncate">{g.name}</li>)}
          </ul>
        </details>

        <div class="flex flex-wrap gap-2 pt-1">
          {(b.state === 'draft' || b.state === 'paused') && (
            <button type="button" class={BTN_ACCENT} disabled={busy} onClick={() => void act(b.state === 'draft' ? 'activate' : 'resume', b.state === 'draft' ? 'Đã kích hoạt lịch gửi' : 'Đã tiếp tục lịch gửi')}>
              <Play size={13} /> {b.state === 'draft' ? 'Kích hoạt' : 'Tiếp tục'}
            </button>
          )}
          {b.state === 'active' && (
            <button type="button" class={BTN} disabled={busy} onClick={() => void act('pause', 'Đã tạm dừng lịch gửi')}>
              <Pause size={13} /> Tạm dừng
            </button>
          )}
          {canRun && (
            <button type="button" class={BTN} disabled={busy} onClick={() => void act('run-now', 'Đã xếp lượt gửi, sẽ bắt đầu trong ít phút')}>
              <Send size={13} /> Gửi ngay
            </button>
          )}
          {retryable && !runActive && b.state !== 'cancelled' && (
            <button type="button" class={BTN} disabled={busy} onClick={() => void act('retry-failed', 'Đã xếp lượt gửi lại các nhóm lỗi')}>
              <RotateCcw size={13} /> Gửi lại nhóm lỗi
            </button>
          )}
          {(b.state === 'draft' || b.state === 'paused' || b.state === 'active') && (
            <button type="button" class={BTN} disabled={busy} onClick={() => onEdit(b)}>
              <Pencil size={13} /> Sửa
            </button>
          )}
          {(b.state === 'draft' || b.state === 'paused' || b.state === 'active') && (
            <button type="button" class={`${BTN} text-[var(--color-status-failed)]`} disabled={busy} onClick={() => setConfirm('cancel')}>
              <XCircle size={13} /> Huỷ lịch
            </button>
          )}
          {(b.state === 'draft' || b.state === 'cancelled' || b.state === 'completed') && (
            <button type="button" class={`${BTN} text-[var(--color-status-failed)] ml-auto`} disabled={busy || runActive} onClick={() => setConfirm('delete')}>
              <Trash2 size={13} /> Xoá
            </button>
          )}
        </div>
      </section>

      <section>
        <h3 class="text-[13.5px] font-semibold text-[var(--color-text)] mb-2">Lịch sử các lượt gửi</h3>
        {runs.length === 0 ? (
          <div class="text-[12px] text-[var(--color-text-faint)]">Chưa có lượt gửi nào.</div>
        ) : (
          <div class="rounded-lg border border-[var(--color-border)] overflow-hidden">
            <table class="w-full text-[12px]">
              <thead>
                <tr class="bg-[var(--color-card)] text-left text-[11px] text-[var(--color-text-faint)]">
                  <th class="px-3 py-2 font-medium w-6" />
                  <th class="px-3 py-2 font-medium">Thời gian</th>
                  <th class="px-3 py-2 font-medium">Kiểu</th>
                  <th class="px-3 py-2 font-medium">Trạng thái</th>
                  <th class="px-3 py-2 font-medium">Kết quả</th>
                  <th class="px-3 py-2 font-medium">Ghi chú</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const open = shownRun === r.id;
                  return (
                    <Fragment key={r.id}>
                      <tr
                        class="border-t border-[var(--color-border)] align-top cursor-pointer hover:bg-[var(--color-card)]"
                        onClick={() => setOpenRun(open ? -1 : r.id)}
                      >
                        <td class="px-3 py-2 text-[var(--color-text-faint)]">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</td>
                        <td class="px-3 py-2 whitespace-nowrap text-[var(--color-text)]">{sec(r.scheduledFor)}</td>
                        <td class="px-3 py-2 whitespace-nowrap text-[var(--color-text-muted)]">{TRIGGER_LABEL[r.triggeredBy]}</td>
                        <td class="px-3 py-2"><Pill tone={RUN_STATE_TONE[r.state]}>{RUN_STATE_LABEL[r.state]}</Pill></td>
                        <td class="px-3 py-2 whitespace-nowrap tabular-nums text-[var(--color-text)]">
                          {runResult(r)}
                        </td>
                        <td class="px-3 py-2 text-[var(--color-text-muted)]">{r.skipReason ? reasonLabel(r.skipReason) : ''}</td>
                      </tr>
                      {open && (
                        <tr class="border-t border-[var(--color-border)] bg-[var(--color-bg)]">
                          <td colSpan={6} class="px-3 py-2">
                            {r.targets === undefined ? (
                              <div class="text-[12px] text-[var(--color-text-faint)]">Chi tiết từng nhóm chỉ giữ cho vài lượt gần nhất.</div>
                            ) : (
                              <table class="w-full text-[12px]">
                                <tbody>
                                  {r.targets.map((t) => (
                                    <tr key={t.id} class="border-b last:border-b-0 border-[var(--color-border)] align-top">
                                      <td class="py-1.5 pr-3 text-[var(--color-text)]">{t.groupName}</td>
                                      <td class="py-1.5 pr-3 w-[90px]"><Pill tone={TARGET_STATE_TONE[t.state]}>{TARGET_STATE_LABEL[t.state]}</Pill></td>
                                      <td class="py-1.5 text-[var(--color-text-muted)]">
                                        {t.errorCode && (
                                          <div>
                                            {errorLabel(t.errorCode)} <span class="text-[var(--color-text-faint)]">({t.errorCode})</span>
                                          </div>
                                        )}
                                        {t.errorMessage && <div class="text-[var(--color-text-faint)] break-words">{t.errorMessage}</div>}
                                        {t.state === 'pending' && r.skipReason && <div class="text-[var(--color-text-faint)]">Chưa gửi: {reasonLabel(r.skipReason)}</div>}
                                      </td>
                                      <td class="py-1.5 pl-3 text-right whitespace-nowrap text-[var(--color-text-faint)] tabular-nums">
                                        {t.attempts > 0 ? `${t.attempts} lần thử` : ''}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ConfirmModal
        open={confirm === 'cancel'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void act('cancel', 'Đã huỷ lịch gửi')}
        title="Huỷ lịch gửi này?"
        body="Lịch sẽ dừng hẳn và không gửi thêm lượt nào. Lịch sử các lượt đã gửi vẫn được giữ lại."
        confirmLabel="Huỷ lịch"
        cancelLabel="Không huỷ"
        destructive
      />
      <ConfirmModal
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void act('', 'Đã xoá lịch gửi', 'delete')}
        title="Xoá lịch gửi này?"
        body="Lịch và toàn bộ lịch sử các lượt gửi sẽ bị xoá vĩnh viễn. Tin đã gửi trong nhóm không bị ảnh hưởng."
        confirmLabel="Xoá"
        cancelLabel="Giữ lại"
        destructive
      />
    </div>
  );
}

/** "3 đã gửi · 1 lỗi · 2 chưa gửi", or just the group count while nothing has been tried. */
function runResult(r: { state: string; totalTargets: number; sentCount: number; failedCount: number }): string {
  const untried = r.totalTargets - r.sentCount - r.failedCount;
  if (r.state === 'pending' || r.state === 'running' || (r.sentCount === 0 && r.failedCount === 0)) {
    return `${r.totalTargets} nhóm`;
  }
  return [`${r.sentCount} đã gửi`, `${r.failedCount} lỗi`, untried > 0 ? `${untried} chưa gửi` : ''].filter(Boolean).join(' · ');
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div class="flex gap-2">
      <dt class="w-[150px] shrink-0 text-[var(--color-text-faint)]">{label}</dt>
      <dd class="text-[var(--color-text)] min-w-0 break-words">{value}</dd>
    </div>
  );
}
