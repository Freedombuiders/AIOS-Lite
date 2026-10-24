import { useEffect, useState } from 'preact/hooks';
import { TriangleAlert } from 'lucide-preact';
import { Pill } from '@/components/Pill';
import { Card } from '@/components/ui';
import { errorText } from '@/lib/api';
import { GRANT_LEVELS, getAgentGrants, grantLevel, listIntegrations, saveAgentGrants, withGrant, type IntegrationGrant, type IntegrationGrantSetting, type IntegrationSummary } from '@/lib/integrations';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';
import { GrantControl } from './GrantControl';

const statusPill = (i: IntegrationSummary) =>
  i.status === 'ok' ? <Pill tone="done">Đã kết nối</Pill> : i.status === 'error' ? <Pill tone="failed">Lỗi</Pill> : i.status === 'unchecked' ? <Pill tone="queued">Chưa kiểm tra</Pill> : <Pill tone="neutral">Chưa kết nối</Pill>;

/** Per-integration grant levels for one agent; each change saves immediately. */
export function IntegrationGrants({ agentId }: { agentId: string }) {
  const items = useFetch<{ items: IntegrationSummary[] }>('/integrations');
  const grants = useFetch<{ grants: Record<string, IntegrationGrantSetting> }>(`/agents/${agentId}/integrations`);
  const [local, setLocal] = useState<Record<string, IntegrationGrantSetting>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (grants.data) setLocal(grants.data.grants); }, [grants.data]);

  async function change(id: string, level: IntegrationGrant) {
    const prev = local;
    const next = { ...local };
    if (level === 'off') delete next[id];
    else next[id] = withGrant(local[id], level);
    setLocal(next);
    setBusy(true);
    try {
      const res = await saveAgentGrants(agentId, next);
      setLocal(res.grants);
      pushToast({ tone: level === 'write' ? 'warn' : 'success', title: 'Đã lưu quyền integration', description: 'Áp dụng từ lượt chạy tiếp theo.' });
    } catch (e) {
      setLocal(prev);
      pushToast({ tone: 'error', title: 'Không lưu được quyền', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const list = items.data?.items ?? [];
  const writing = list.filter((i) => grantLevel(local[i.id]) === 'write');
  return (
    <Card title="Integration (Pancake, Botcake, Composio…)">
      <ul class="m-0 mb-2.5 list-none space-y-0.5 p-0 text-[12px] text-[var(--color-text-muted)]">
        {GRANT_LEVELS.map((l) => <li key={l.value}><b class="text-[var(--color-text)]">{l.label}</b>: {l.hint}</li>)}
      </ul>
      {writing.length > 0 && (
        <div role="alert" class="mb-2.5 flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--color-elevated)] px-3 py-2 text-[12px]">
          <TriangleAlert size={14} class="mt-0.5 shrink-0 text-[var(--color-status-failed)]" />
          <span>Agent này được ghi trực tiếp vào {writing.map((i) => i.name).join(', ')}: tạo đơn, gửi tin, sửa dữ liệu thật. Chỉ cấp khi bạn tin lệnh của nó; dùng &quot;Hỏi trước&quot; nếu muốn tự duyệt từng lệnh ghi.</span>
        </div>
      )}
      {items.data && list.length === 0 && <div class="hint">Chưa có integration nào.</div>}
      <div class="flex flex-col gap-2">
        {list.map((i) => (
          <div key={i.id} class="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] px-2.5 py-2">
            <span class="w-32 text-[12.5px] font-medium">{i.name}</span>
            {statusPill(i)}
            {i.status === 'not_configured' && grantLevel(local[i.id]) !== 'off' && <span class="hint">cần kết nối trước khi dùng được</span>}
            <span class="ml-auto"><GrantControl label={`Quyền ${i.name}`} value={grantLevel(local[i.id])} disabled={busy || !grants.data} onChange={(v) => void change(i.id, v)} /></span>
          </div>
        ))}
      </div>
    </Card>
  );
}
