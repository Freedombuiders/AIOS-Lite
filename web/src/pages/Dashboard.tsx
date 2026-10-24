import { Check, ExternalLink } from 'lucide-preact';
import { useCallback } from 'preact/hooks';
import { Link } from 'wouter-preact';
import type { AttentionItem, BoardEntry, TaskStatus } from '@core/types';
import { AgentAvatar } from '@/components/AgentAvatar';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { QuickAssign } from '@/components/QuickAssign';
import { Card, Stat } from '@/components/ui';
import { apiPost, errorText } from '@/lib/api';
import type { StatsOverview } from '@/lib/api-types';
import { useAgents } from '@/lib/agents';
import { formatCost, formatRelativeTime, resolveAgentName } from '@/lib/format';
import { STATUS_LABEL } from '@/lib/labels';
import { useEvents } from '@/lib/sse';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';
import { WidgetSlot } from '@/module-host/WidgetSlot';

const BOARD_STATUSES: TaskStatus[] = ['queued', 'running', 'waiting', 'review', 'failed', 'done'];
const KIND_TONE: Record<string, 'success' | 'error' | 'warn' | 'info'> = { done: 'success', error: 'error', review: 'warn', status: 'info' };

function AttentionList({ items, onChange }: { items: AttentionItem[]; onChange: () => void }) {
  async function resolve(key: string) {
    try {
      await apiPost(`/attention/${encodeURIComponent(key)}/resolve`);
      onChange();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không đánh dấu được', description: errorText(e) });
    }
  }
  return (
    <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
      {items.map((a) => (
        <li key={a.key} class="flex items-center gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
          <span class={`dot ${a.severity === 'error' ? 'dot-error' : a.severity === 'warn' ? 'dot-warn' : 'dot-info'}`} />
          <div class="min-w-0 flex-1">
            <div class="truncate text-[12.5px] font-medium">{a.title}</div>
            {a.detail && <div class="hint truncate">{a.detail}</div>}
          </div>
          {a.link && (
            <Link href={a.link} class="control-button control-sm no-underline">
              <ExternalLink size={11} /> Mở
            </Link>
          )}
          <button type="button" class="control-button control-sm" onClick={() => void resolve(a.key)} title="Đánh dấu đã xử lý">
            <Check size={11} /> Đã xử lý
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function Dashboard() {
  const stats = useFetch<StatsOverview>('/stats');
  const attention = useFetch<{ items: AttentionItem[] }>('/attention');
  const board = useFetch<{ items: BoardEntry[] }>('/board?limit=12');
  const { agents } = useAgents();

  const refreshAll = useCallback(() => {
    stats.refresh();
    attention.refresh();
    board.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats.refresh, attention.refresh, board.refresh]);
  useEvents(['task', 'run', 'attention', 'board'], refreshAll);

  const s = stats.data;
  const items = attention.data?.items ?? [];
  return (
    <div class="page">
      <PageHeader title="Tổng quan" />

      <Card title={`Cần bạn${items.length ? ` · ${items.length}` : ''}`} class="mb-3">
        <PageState loading={attention.loading && !attention.data} error={attention.error} />
        {attention.data && items.length === 0 && <div class="hint py-1">Không có gì cần bạn lúc này. Việc cần duyệt hoặc bị lỗi sẽ hiện ở đây.</div>}
        {items.length > 0 && <AttentionList items={items} onChange={attention.refresh} />}
      </Card>

      <PageState loading={stats.loading && !s} error={stats.error} />
      {s && (
        <div class="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Agents đang chạy" value={`${s.agents.running}/${s.agents.enabled}`} sub={`${s.agents.total} agent tổng cộng`} />
          <Stat label="Lượt chạy hôm nay" value={s.runsToday} />
          <Stat label="Chi phí tháng này" value={formatCost(s.costMonthUsd)} sub="chỉ tính lượt chạy có báo giá" />
          <div class="card card-pad">
            <div class="hint">Công việc</div>
            <div class="mt-1.5 flex flex-wrap gap-1.5">
              {BOARD_STATUSES.map((st) => (
                <Link key={st} href={`/tasks?status=${st}`} class="no-underline">
                  <Pill tone={st === 'failed' ? 'error' : st === 'review' ? 'warn' : st === 'running' ? 'info' : st === 'done' ? 'success' : 'neutral'}>
                    {STATUS_LABEL[st]} {s.tasks[st]}
                  </Pill>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}

      <div class="mb-3 grid gap-3 lg:grid-cols-5">
        <Card title="Giao việc nhanh" class="lg:col-span-2">
          <QuickAssign agents={agents} />
        </Card>
        <Card title="Hoạt động của đội" class="lg:col-span-3">
          <PageState loading={board.loading && !board.data} error={board.error} />
          {board.data && board.data.items.length === 0 && <div class="hint py-1">Chưa có hoạt động. Giao một việc để bắt đầu.</div>}
          <ul class="m-0 flex list-none flex-col gap-2 p-0">
            {(board.data?.items ?? []).map((b) => (
              <li key={b.id} class="flex items-start gap-2">
                {b.agentId ? <AgentAvatar agentId={b.agentId} name={resolveAgentName(b.agentId)} size={22} /> : <span class="dot mt-1.5" />}
                <div class="min-w-0 flex-1">
                  <div class="text-[12.5px]">
                    <b class="font-medium">{b.agentId ? resolveAgentName(b.agentId) : 'Hệ thống'}</b> · {b.taskId ? <Link href={`/tasks/${b.taskId}`}>{b.text}</Link> : b.text}
                  </div>
                  <div class="hint">{formatRelativeTime(b.createdAt)}</div>
                </div>
                <Pill tone={KIND_TONE[b.kind] ?? 'neutral'}>{b.kind}</Pill>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {s && s.costByAgent.length > 0 && (
        <Card title="Chi phí theo agent (tháng này)" class="mb-3">
          <div class="flex flex-wrap gap-x-6 gap-y-1">
            {s.costByAgent.map((c) => (
              <div key={c.agentId} class="text-[12px]">
                <Link href={`/agents/${c.agentId}`}>{resolveAgentName(c.agentId)}</Link> · {formatCost(c.costUsd)} <span class="hint">({c.runs} lượt)</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <WidgetSlot slot="dashboard" />
    </div>
  );
}
