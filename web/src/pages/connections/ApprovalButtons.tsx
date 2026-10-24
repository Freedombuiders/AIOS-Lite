import { useState } from 'preact/hooks';
import { Check, X } from 'lucide-preact';
import { errorText } from '@/lib/api';
import { approveApproval, rejectApproval } from '@/lib/integrations';
import { pushToast } from '@/lib/toasts';

/** Duyệt / Duyệt luôn / Từ chối for one pending integration approval. */
export function ApprovalButtons({ id, onDone, withAlways = false }: { id: number | string; onDone: () => void; withAlways?: boolean }) {
  const [busy, setBusy] = useState(false);
  async function run(kind: 'approve' | 'always' | 'reject') {
    setBusy(true);
    try {
      const res = kind === 'reject' ? await rejectApproval(id) : await approveApproval(id, kind === 'always');
      if (kind === 'reject') pushToast({ tone: 'info', title: 'Đã từ chối lệnh' });
      else if (res.error) pushToast({ tone: 'error', title: 'Đã duyệt nhưng lệnh lỗi', description: res.error });
      else pushToast({ tone: 'success', title: kind === 'always' ? 'Đã duyệt và luôn cho phép lệnh y hệt' : 'Đã duyệt, lệnh đã chạy' });
      onDone();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không xử lý được', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <span class="inline-flex flex-wrap items-center gap-1.5">
      <button type="button" class="control-button control-sm control-accent" disabled={busy} onClick={() => void run('approve')}><Check size={11} /> Duyệt</button>
      {withAlways && <button type="button" class="control-button control-sm" disabled={busy} onClick={() => void run('always')}>Duyệt luôn lệnh y hệt</button>}
      <button type="button" class="control-button control-sm" disabled={busy} onClick={() => void run('reject')}><X size={11} /> Từ chối</button>
    </span>
  );
}
