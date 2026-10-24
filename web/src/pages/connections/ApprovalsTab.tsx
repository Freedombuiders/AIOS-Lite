import { Link } from 'wouter-preact';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { Card } from '@/components/ui';
import { formatRelativeTime, resolveAgentName } from '@/lib/format';
import { excerpt, RISK_LABEL, type IntegrationApproval, type IntegrationRisk } from '@/lib/integrations';
import { useEvents } from '@/lib/sse';
import { useFetch } from '@/lib/useFetch';
import { ApprovalButtons } from './ApprovalButtons';

const RISK_TONE: Record<IntegrationRisk, 'neutral' | 'warn' | 'error'> = { read: 'neutral', write: 'warn', destructive: 'error' };

export function ApprovalsTab() {
  const f = useFetch<{ items: IntegrationApproval[] }>('/integrations/approvals', 30_000);
  useEvents(['attention', 'audit'], () => f.refresh());
  const all = f.data?.items ?? [];
  const pending = all.filter((a) => a.status === 'pending');
  const history = all.filter((a) => a.status !== 'pending');
  return (
    <div class="flex flex-col gap-3">
      <PageState loading={f.loading && !f.data} error={f.error} />
      <Card title={`Đang chờ duyệt${f.data ? ` (${pending.length})` : ''}`}>
        {f.data && pending.length === 0 && <div class="hint">Không có lệnh nào đang chờ bạn. Khi agent ở mức &quot;Hỏi trước&quot; muốn ghi, lệnh sẽ hiện ở đây.</div>}
        <ul class="m-0 flex list-none flex-col gap-2 p-0">
          {pending.map((a) => (
            <li key={a.id} class="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3" data-testid="pending-approval">
              <div class="flex flex-wrap items-center gap-2 text-[12.5px]">
                <b>{resolveAgentName(a.agentId)}</b>
                <span class="hint">muốn chạy</span>
                <span class="mono">{a.integrationId} {a.command}</span>
                <Pill tone={RISK_TONE[a.risk]}>{RISK_LABEL[a.risk]}</Pill>
                <span class="hint ml-auto">{formatRelativeTime(a.createdAt)}</span>
              </div>
              {a.args && <pre class="mono mt-2 mb-0 max-h-32 overflow-auto whitespace-pre-wrap rounded-[var(--radius-md)] bg-[var(--color-elevated)] px-2.5 py-1.5 text-[11.5px]">{a.args}</pre>}
              <div class="mt-2.5 flex flex-wrap items-center gap-2">
                <ApprovalButtons id={a.id} withAlways={a.risk !== 'destructive'} onDone={f.refresh} />
                {a.taskId != null && <Link href={`/tasks/${a.taskId}`} class="ml-auto text-[12px]">Xem việc #{a.taskId}</Link>}
              </div>
              {a.risk === 'destructive' && <div class="hint mt-1.5">Lệnh nguy hiểm luôn phải duyệt từng lần.</div>}
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Lịch sử">
        {f.data && history.length === 0 && <div class="hint">Chưa có lệnh nào được xử lý.</div>}
        <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
          {history.map((a) => (
            <li key={a.id} class="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] pb-1.5 text-[12px] last:border-0">
              <Pill tone={a.status === 'approved' ? (a.error ? 'failed' : 'done') : 'neutral'}>{a.status === 'approved' ? (a.error ? 'Duyệt, lỗi' : 'Đã duyệt') : 'Từ chối'}</Pill>
              <span>{resolveAgentName(a.agentId)}</span>
              <span class="mono">{a.integrationId} {a.command}</span>
              <span class="hint min-w-0 flex-1 truncate" title={a.error || excerpt(a.result, 400)}>{a.error || excerpt(a.result)}</span>
              <span class="hint">{formatRelativeTime(a.decidedAt ?? a.createdAt)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
