/** Spend-approval card ('video_generate'): inline in the Đạo diễn AI chat and on the canvas. Same card as "Cần tôi" and Telegram. */
import { useEffect, useState } from 'preact/hooks';
import { Check, Coins, Loader2, X } from 'lucide-preact';

import { errorText, productionApi, type ApprovalDto } from '@modules/video/web/lib/video-production-api';

const STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: 'Chờ bạn duyệt', tone: 'is-busy' },
  deciding: { label: 'Đang xử lý…', tone: 'is-busy' },
  executed: { label: 'Đã duyệt', tone: 'is-done' },
  approved: { label: 'Đã duyệt', tone: 'is-done' },
  rejected: { label: 'Không tạo', tone: '' },
  expired: { label: 'Hết hiệu lực', tone: '' },
  failed: { label: 'Không chạy được', tone: 'is-bad' },
  uncertain: { label: 'Chưa rõ kết quả', tone: 'is-bad' },
};

export function ApprovalCard({ approvalId, compact = false, onDecided }: { approvalId: string; compact?: boolean; onDecided?: () => void }) {
  const [a, setA] = useState<ApprovalDto | null>(null);
  const [busy, setBusy] = useState<'' | 'approve' | 'reject'>('');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const r = await productionApi.approval(approvalId);
        if (!alive) return;
        setA(r.approval);
        if (r.approval.status === 'pending' || r.approval.status === 'deciding') timer = setTimeout(load, 8000);
      } catch (e) { if (alive) setError(errorText(e)); }
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [approvalId]);

  async function decide(action: 'approve' | 'reject') {
    setBusy(action);
    setError('');
    try {
      const r = await productionApi.decide(approvalId, action);
      setA(r.approval);
      if (r.approval.status === 'failed' && r.approval.error) setError(r.approval.error);
      onDecided?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  if (!a && error) return <div class="vx-approval is-loading" role="alert"><X size={14} /> Không tải được thẻ duyệt: {error}</div>;
  if (!a) return <div class="vx-approval is-loading"><Loader2 size={14} class="animate-spin" /> Đang tải thẻ duyệt…</div>;
  const st = STATUS[a.status] ?? { label: a.status, tone: '' };
  const lines = a.summary.split('\n');
  const cost = lines.find((l) => l.startsWith('Chi phí:'));
  const scenes = lines.filter((l) => l !== cost);
  const pending = a.status === 'pending';

  return (
    <div class={`vx-approval${pending ? ' is-pending' : ''}${compact ? ' is-compact' : ''}`} role="group" aria-label="Duyệt chi phí tạo cảnh">
      <div class="vx-approval-head">
        <span class="vx-approval-icon"><Coins size={15} /></span>
        <b>{a.title}</b>
        <span class={`vp-pill ${st.tone}`}>{st.label}</span>
      </div>
      {cost && <p class="vx-approval-cost">{cost.replace('Chi phí: ', '')}</p>}
      {!compact && (
        <ol class="vx-approval-lines">
          {scenes.map((l, i) => <li key={i}>{l}</li>)}
        </ol>
      )}
      {pending && (
        <div class="vx-approval-actions">
          <button type="button" class="vp-btn vp-btn-primary vp-btn-sm" disabled={Boolean(busy)} onClick={() => decide('approve')}>
            {busy === 'approve' ? <Loader2 size={13} class="animate-spin" /> : <Check size={13} />} Duyệt và tạo
          </button>
          <button type="button" class="vp-btn vp-btn-ghost vp-btn-sm" disabled={Boolean(busy)} onClick={() => decide('reject')}>
            <X size={13} /> Không tạo
          </button>
          <span class="vp-faint">Cũng có trong "Cần tôi" và Telegram</span>
        </div>
      )}
      {a.status === 'expired' && <p class="vp-faint">Thẻ hết hạn hoặc phân cảnh đã đổi sau khi xin duyệt. Không có gì được tạo; xin duyệt lại cho bản mới nhất.</p>}
      {(error || (a.status === 'failed' && a.error)) && <p class="vp-error">{error || a.error}</p>}
    </div>
  );
}
