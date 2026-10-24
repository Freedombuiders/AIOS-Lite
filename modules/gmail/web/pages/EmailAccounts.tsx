import { useState } from 'preact/hooks';
import { PageHeader } from '@/components/PageHeader';
import { apiPost, apiPatch } from '@/lib/api';
import { useFetch } from '@/lib/useFetch';
import type { EmailAccount } from '../lib/email';
import { SignatureEditor } from '../components/care-channels/email/EmailAccountParts';
import { EmailServiceBanner } from '../components/email/EmailServiceBanner';
import { EmailAssignmentEditor } from '../components/care-channels/email/EmailAssignmentEditor';
const base = '/api/m/gmail';
export default function EmailAccounts() {
  const { data, loading, error, refresh } = useFetch<{ accounts: EmailAccount[] }>(`${base}/accounts`);
  const status = useFetch<{ enabled: boolean }>(`${base}/status`);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setMessage('');
    try { await fn(); await refresh(); await status.refresh(); setMessage('Đã cập nhật.'); }
    catch { setMessage('Không thực hiện được. Kiểm tra kết nối Composio và thử lại.'); }
    finally { setBusy(false); }
  }
  const button = 'control-button';
  const primary = 'control-button control-accent';
  return <div><PageHeader title="Tài khoản Gmail" breadcrumb="Chăm sóc khách hàng" />
    <div class="p-4 space-y-4"><EmailServiceBanner />
      <div class="flex flex-wrap gap-3">
        <button class={primary} disabled={busy} onClick={() => act(async () => { const r = await apiPost<{ redirectUrl: string }>(`${base}/accounts/connect`, {}); const url = new URL(r.redirectUrl); if (url.protocol !== 'https:') throw new Error(); window.location.assign(url.href); })}>Kết nối Gmail</button>
        <button class={button} disabled={busy} onClick={() => act(() => apiPost(`${base}/accounts/refresh`, {}))}>Làm mới tài khoản</button>
        <button class={button} disabled={busy || !status.data} aria-pressed={status.data?.enabled ?? false} onClick={() => act(() => apiPost(`${base}/enable`, { enabled: !status.data?.enabled }))}>{status.data?.enabled ? 'Tắt đồng bộ Gmail' : 'Bật đồng bộ Gmail'}</button>
      </div>
      <p role="status" aria-live="polite">{busy ? 'Đang xử lý…' : message}</p>
      {loading && <p>Đang tải tài khoản…</p>}{error && <p role="alert">Không tải được tài khoản: {error}</p>}
      {!loading && !error && !data?.accounts.length && <p>Chưa có tài khoản Gmail. Kết nối rồi làm mới danh sách để bắt đầu.</p>}
      {data?.accounts.map(a => <section class="card card-pad space-y-3" key={a.id}>
        <h2 class="font-semibold break-all">{a.emailAddress || a.id}</h2><p>{a.status === 'ACTIVE' ? 'Đã kết nối' : 'Cần kết nối lại'}</p>
        <button class={button} disabled={busy || a.status !== 'ACTIVE'} aria-pressed={a.syncEnabled} onClick={() => act(() => apiPatch(`${base}/accounts/${encodeURIComponent(a.id)}`, { syncEnabled: !a.syncEnabled }))}>{a.syncEnabled ? 'Tắt hộp thư này' : 'Bật hộp thư này'}</button>
        <SignatureEditor account={a} save={async signature => { await apiPatch(`${base}/accounts/${encodeURIComponent(a.id)}`, { signature }); await refresh(); }} />
      </section>)}<EmailAssignmentEditor />
    </div></div>;
}
