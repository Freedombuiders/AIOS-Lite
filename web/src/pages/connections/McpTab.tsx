import { KeyRound, PlugZap } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { Card } from '@/components/ui';
import { apiPost, apiPut, errorText } from '@/lib/api';
import type { ConnectionView } from '@/lib/api-types';
import { resolveAgentName } from '@/lib/format';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';

function ConnectionCard({ c }: { c: ConnectionView }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  async function test() {
    setBusy(true);
    try {
      setResult(await apiPost<{ ok: boolean; message: string }>(`/connections/${c.id}/test`));
    } catch (e) {
      setResult({ ok: false, message: errorText(e) });
    } finally {
      setBusy(false);
    }
  }
  const env = 'env' in c && c.env ? Object.entries(c.env) : [];
  return (
    <div class="card card-pad">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-[13px] font-semibold">{c.id}</span>
        <Pill>{c.type}</Pill>
        <Pill tone={c.ready ? 'success' : 'warn'}>{c.ready ? 'Sẵn sàng' : 'Chưa sẵn sàng'}</Pill>
        <button type="button" class="control-button control-sm ml-auto" disabled={busy} onClick={() => void test()}><PlugZap size={11} /> {busy ? 'Đang thử…' : 'Thử kết nối'}</button>
      </div>
      {c.description && <div class="hint mt-1">{c.description}</div>}
      {env.length > 0 && (
        <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {env.map(([k, v]) => <span key={k} class="mono text-[11px]">{k} = <span class={v === '[missing]' ? 'text-[var(--color-status-failed)]' : 'text-[var(--color-text-muted)]'}>{v}</span></span>)}
        </div>
      )}
      {c.type === 'composio' && c.toolkits && <div class="hint mt-1">Toolkit: {c.toolkits.join(', ')}</div>}
      <div class="mt-2 text-[12px]">
        <span class="hint">Đã cấp cho: </span>
        {c.grantedTo.length === 0 ? <span class="hint">chưa agent nào</span> : c.grantedTo.map((a) => <Link key={a} href={`/agents/${a}`} class="mr-1.5">{resolveAgentName(a)}</Link>)}
      </div>
      {result && <div class={`mt-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-[12px] ${result.ok ? 'pill-success' : 'pill-error'}`} style={{ height: 'auto', borderRadius: 6 }}>{result.message}</div>}
    </div>
  );
}

export function McpTab() {
  const f = useFetch<{ items: ConnectionView[] }>('/connections');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const items = f.data?.items ?? [];

  async function saveKey() {
    if (!key.trim()) return;
    setBusy(true);
    try {
      await apiPut('/connections/composio-key', { apiKey: key.trim() });
      setKey('');
      pushToast({ tone: 'success', title: 'Đã lưu khoá Composio', description: 'Khoá được ghi vào file .env, không hiển thị lại.' });
      f.refresh();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không lưu được khoá', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Card title="Khoá Composio" class="mb-3">
        <div class="flex flex-wrap items-center gap-2">
          <KeyRound size={14} class="text-[var(--color-text-faint)]" />
          <input class="field" style={{ maxWidth: 360 }} type="password" autocomplete="off" placeholder="Dán COMPOSIO_API_KEY" value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
          <button type="button" class="control-button control-accent" disabled={busy || !key.trim()} onClick={() => void saveKey()}>{busy ? 'Đang lưu…' : 'Lưu khoá'}</button>
        </div>
        <div class="hint mt-1.5">Khoá được ghi vào file .env của máy này. Giá trị bí mật không bao giờ được hiển thị lại trên giao diện.</div>
      </Card>
      <PageState loading={f.loading && !f.data} error={f.error} empty={!!f.data && items.length === 0} emptyTitle="Chưa khai báo kết nối nào" emptyDescription="Thêm kết nối vào config/connections.yaml (MCP, biến môi trường hoặc Composio), rồi tải lại trang." />
      <div class="grid gap-3 md:grid-cols-2">{items.map((c) => <ConnectionCard key={c.id} c={c} />)}</div>
    </div>
  );
}
