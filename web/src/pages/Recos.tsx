import { ShoppingCart } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { PageHeader, Tab } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { RecoCard } from '@/components/teams/RecoCard';
import { apiPost, apiPut, errorText } from '@/lib/api';
import { ARM_LABEL, type Reco, type RecoArm, type RecoStatus, type RecosList } from '@/lib/teams';
import { pushToast } from '@/lib/toasts';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';

const ARMS = Object.keys(ARM_LABEL) as RecoArm[];

export default function RecosPage() {
  const [arm, setArm] = useState<RecoArm | 'all'>('all');
  const [view, setView] = useState<'open' | 'done'>('open');
  const f = useFetch<RecosList>(`/recos?status=${view === 'open' ? 'open' : 'done'}`);
  const counts = useFetch<RecosList>('/recos?status=open');
  const [busy, setBusy] = useState<string | null>(null);
  const items = (f.data?.items ?? []).filter((r) => arm === 'all' || r.arm === arm);
  const cart = counts.data?.counts.cart ?? 0;

  const refresh = () => {
    invalidateFetchCache('/recos');
    f.refresh();
    counts.refresh();
  };

  async function run(key: string, job: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    try {
      await job();
      if (ok) pushToast({ tone: 'success', title: ok });
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không thực hiện được', description: errorText(e) });
    } finally {
      setBusy(null);
      refresh();
    }
  }
  const setStatus = (r: Reco, status: Exclude<RecoStatus, 'done'>) => run(r.id, () => apiPut(`/recos/${encodeURIComponent(r.id)}/status`, { status }));
  const apply = (r: Reco) => run(r.id, () => apiPost(`/recos/${encodeURIComponent(r.id)}/apply`), `Đã áp dụng: ${r.title}`);
  const applyCart = () => run('cart', async () => {
    const res = await apiPost<{ results: { id: string; ok: boolean; message: string }[] }>('/recos/apply-cart');
    const bad = res.results.filter((x) => !x.ok);
    pushToast({ tone: bad.length ? 'warn' : 'success', title: `Đã áp dụng ${res.results.length - bad.length}/${res.results.length} đề xuất`, description: bad[0]?.message });
  });

  return (
    <div class="page">
      <PageHeader
        title="Đề xuất cải tiến"
        actions={cart > 0 ? <button type="button" class="control-button control-accent" disabled={busy !== null} onClick={() => void applyCart()}><ShoppingCart size={12} /> Áp dụng giỏ ({cart})</button> : undefined}
        tabs={
          <>
            <Tab label="Đang mở" active={view === 'open'} count={counts.data?.counts.total} onClick={() => setView('open')} />
            <Tab label="Đã áp dụng" active={view === 'done'} onClick={() => setView('done')} />
          </>
        }
      />
      <p class="hint mb-3 max-w-2xl">Hệ thống tự xem việc thất bại, chi phí, skill, Second Brain và module để gợi ý cải tiến. Không có gì thay đổi cho đến khi bạn bấm “Áp dụng”.</p>
      <div class="mb-3 flex flex-wrap gap-1.5">
        <button type="button" class={`control-button control-sm ${arm === 'all' ? 'is-active' : ''}`} onClick={() => setArm('all')}>Tất cả</button>
        {ARMS.map((a) => <button key={a} type="button" class={`control-button control-sm ${arm === a ? 'is-active' : ''}`} onClick={() => setArm(a)}>{ARM_LABEL[a]}{counts.data?.counts[a] ? ` (${counts.data.counts[a]})` : ''}</button>)}
      </div>
      <PageState loading={f.loading && !f.data} error={f.error} empty={!!f.data && items.length === 0} emptyTitle={view === 'open' ? 'Không có đề xuất nào' : 'Chưa áp dụng đề xuất nào'} emptyDescription={view === 'open' ? 'Mọi thứ đang ổn. Đề xuất mới sẽ xuất hiện khi hệ thống phát hiện điều đáng cải thiện.' : undefined} />
      <div class="space-y-2">
        {items.map((r) => (
          <RecoCard key={r.id} reco={r} busy={busy !== null} onCart={() => void setStatus(r, 'cart')} onUncart={() => void setStatus(r, 'new')} onSkip={() => void setStatus(r, 'skipped')} onApply={() => void apply(r)} />
        ))}
      </div>
    </div>
  );
}
