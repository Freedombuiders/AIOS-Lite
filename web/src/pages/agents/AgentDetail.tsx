// One bot's activity, opened from its card on Đội AI · Bot (/bots): runs, conversations and brain/module access.
// Name, role, bot id, key, pause and delete live on the bot card; the generic Agents list and form are gone (G3).
import { ArrowLeft, MessageSquarePlus } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { Link, useLocation } from 'wouter-preact';
import type { Conversation, Run } from '@core/types';
import { AccessEditor } from '@/components/agents/AccessEditor';
import { AgentAvatar } from '@/components/AgentAvatar';
import { PageHeader, Tab } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { Card, Stat } from '@/components/ui';
import { apiPost, errorText } from '@/lib/api';
import type { AgentDetail as AgentDetailDto } from '@/lib/api-types';
import { formatCost, formatDateTime, formatDuration, formatNumber, formatRelativeTime } from '@/lib/format';
import { ERROR_FAMILY_LABEL, runtimeLabel } from '@/lib/labels';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';

type TabId = 'runs' | 'chat' | 'access';

function RunsTab({ agentId }: { agentId: string }) {
  const f = useFetch<{ items: Run[] }>(`/runs?agentId=${agentId}&limit=50`);
  const items = f.data?.items ?? [];
  return (
    <>
      <PageState loading={f.loading && !f.data} error={f.error} empty={!!f.data && items.length === 0} emptyTitle="Agent này chưa có lượt chạy" emptyDescription="Giao một việc cho agent để thấy lượt chạy ở đây." />
      {items.length > 0 && (
        <div class="card overflow-x-auto">
          <table class="table">
            <thead>
              <tr><th>Lượt</th><th>Việc</th><th>Trạng thái</th><th>Token vào/ra</th><th>Chi phí</th><th>Thời gian</th><th>Bắt đầu</th></tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td class="mono">#{r.id}</td>
                  <td><Link href={`/tasks/${r.taskId}`}>Việc #{r.taskId}</Link></td>
                  <td>
                    <Pill tone={r.status === 'done' ? 'success' : r.status === 'failed' ? 'error' : r.status === 'running' ? 'info' : 'neutral'}>{r.status === 'running' ? 'Đang chạy' : r.status === 'done' ? 'Xong' : r.status === 'failed' ? 'Lỗi' : 'Đã huỷ'}</Pill>
                    {r.errorFamily && <span class="hint ml-1">{ERROR_FAMILY_LABEL[r.errorFamily]}</span>}
                  </td>
                  <td>{formatNumber(r.inputTokens)} / {formatNumber(r.outputTokens)}</td>
                  <td>{formatCost(r.costUsd)}</td>
                  <td>{formatDuration(r.durationMs)}</td>
                  <td title={formatDateTime(r.startedAt)}>{formatRelativeTime(r.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ChatTab({ agentId }: { agentId: string }) {
  const [, nav] = useLocation();
  const f = useFetch<{ items: Conversation[] }>(`/conversations?agentId=${agentId}`);
  const items = f.data?.items ?? [];
  async function start() {
    try {
      const c = await apiPost<Conversation>('/conversations', { agentId });
      nav(`/chat/${c.id}`);
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không tạo được cuộc trò chuyện', description: errorText(e) });
    }
  }
  return (
    <Card title="Trò chuyện với agent này" actions={<button type="button" class="control-button control-accent control-sm" onClick={() => void start()}><MessageSquarePlus size={12} /> Cuộc trò chuyện mới</button>}>
      <PageState loading={f.loading && !f.data} error={f.error} empty={!!f.data && items.length === 0} emptyTitle="Chưa có cuộc trò chuyện" emptyDescription="Bấm “Cuộc trò chuyện mới” để hỏi trực tiếp agent." />
      <ul class="m-0 flex list-none flex-col gap-1 p-0">
        {items.map((c) => (
          <li key={c.id}>
            <Link href={`/chat/${c.id}`} class="flex items-center justify-between rounded-[var(--radius-md)] px-2 py-1.5 text-[var(--color-text)] no-underline hover:bg-[var(--color-control-hover)]">
              <span class="truncate">{c.title}</span>
              <span class="hint">{formatRelativeTime(c.updatedAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function AgentDetail({ id }: { id: string }) {
  const [tab, setTab] = useState<TabId>(() => (new URLSearchParams(location.search).get('tab') === 'access' ? 'access' : 'runs'));
  const f = useFetch<AgentDetailDto>(`/agents/${id}`);
  const a = f.data;
  if (!a) return <div class="page"><PageState loading={f.loading} error={f.error} /></div>;
  const legacy = a.runtimeAllowed === false;
  const budget = a.budgetUsdMonth;

  return (
    <div class="page">
      <PageHeader
        breadcrumb={<Link href="/bots" class="inline-flex items-center gap-1 no-underline"><ArrowLeft size={12} /> Đội AI · Bot</Link>}
        title={a.name}
        actions={
          <>
            <AgentAvatar agentId={a.id} name={a.name} size={26} running={a.stats.running > 0} />
            <Pill tone={legacy ? 'warn' : 'accent'}>{runtimeLabel(a.runtime)}</Pill>
            {!a.enabled && <Pill>Tạm dừng</Pill>}
          </>
        }
        tabs={
          <>
            <Tab label="Lượt chạy" active={tab === 'runs'} onClick={() => setTab('runs')} />
            <Tab label="Trò chuyện" active={tab === 'chat'} onClick={() => setTab('chat')} />
            <Tab label="Quyền" active={tab === 'access'} onClick={() => setTab('access')} />
          </>
        }
      />
      {legacy && (
        <p class="mb-3 rounded-[var(--radius-md)] border border-[var(--color-status-review)] p-2 text-[13px]" data-testid="legacy-note">
          Agent này đang dùng {runtimeLabel(a.runtime)}, hãy chuyển sang GenBot: mở <Link href="/bots">Đội AI · Bot</Link> và bấm “Chuyển sang GenBot”.
        </p>
      )}
      <div class="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Đang chạy / chờ" value={`${a.stats.running} / ${a.stats.queued}`} />
        <Stat label="Lượt chạy tháng này" value={a.stats.runsMonth} />
        <Stat label="Chi phí tháng này" value={formatCost(a.stats.costMonthUsd)} sub={budget !== undefined ? `Ngân sách $${budget}` : 'Không giới hạn'} />
        <Stat label="Chạy gần nhất" value={<span class="text-[16px]">{a.stats.lastRunAt ? formatRelativeTime(a.stats.lastRunAt) : 'Chưa chạy'}</span>} />
      </div>
      {tab === 'runs' && <RunsTab agentId={a.id} />}
      {tab === 'chat' && <ChatTab agentId={a.id} />}
      {tab === 'access' && <AccessEditor key={JSON.stringify(a.access)} agentId={a.id} access={a.access} runtimeLabel={runtimeLabel(a.runtime)} onSaved={f.refresh} />}
    </div>
  );
}
