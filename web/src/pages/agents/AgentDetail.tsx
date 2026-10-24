import { MessageSquarePlus, Trash2 } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { Link, useLocation } from 'wouter-preact';
import type { Conversation, Run } from '@core/types';
import { AccessEditor } from '@/components/agents/AccessEditor';
import { AgentForm, toInput, validateAgent } from '@/components/agents/AgentForm';
import type { AgentFormValue } from '@/components/agents/AgentForm';
import { AgentAvatar } from '@/components/AgentAvatar';
import { ConfirmModal } from '@/components/ConfirmModal';
import { PageHeader, Tab } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { Card, Stat } from '@/components/ui';
import { apiDelete, apiPost, apiPut, errorText } from '@/lib/api';
import type { AgentDetail as AgentDetailDto } from '@/lib/api-types';
import { useAgents } from '@/lib/agents';
import { formatCost, formatDateTime, formatDuration, formatNumber, formatRelativeTime } from '@/lib/format';
import { ERROR_FAMILY_LABEL, RUNTIME_LABEL } from '@/lib/labels';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';
import { RuntimeBadge } from './AgentsPage';

type TabId = 'overview' | 'persona' | 'access' | 'runs' | 'chat';

function toForm(a: AgentDetailDto): AgentFormValue {
  return {
    id: a.id, name: a.name, description: a.description, runtime: a.runtime, model: a.model ?? '', permission: a.permission, context: a.context, reportsTo: a.reportsTo ?? '',
    canDelegate: a.canDelegate, maxConcurrent: a.maxConcurrent, budget: a.budgetUsdMonth === undefined ? '' : String(a.budgetUsdMonth), enabled: a.enabled, persona: a.persona,
  };
}

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
  const [, nav] = useLocation();
  const [tab, setTab] = useState<TabId>(() => (new URLSearchParams(location.search).get('tab') === 'access' ? 'access' : 'overview'));
  const f = useFetch<AgentDetailDto>(`/agents/${id}`);
  const { agents, refresh: refreshList } = useAgents();
  const [form, setForm] = useState<AgentFormValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const a = f.data;

  useEffect(() => {
    if (a) setForm(toForm(a));
  }, [a]);

  async function save() {
    if (!form) return;
    const err = validateAgent(form, false);
    if (err) return pushToast({ tone: 'error', title: err });
    setBusy(true);
    try {
      await apiPut(`/agents/${id}`, toInput(form));
      pushToast({ tone: 'success', title: 'Đã lưu agent' });
      f.refresh();
      refreshList();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không lưu được', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    setBusy(true);
    try {
      await apiDelete(`/agents/${id}`);
      pushToast({ tone: 'success', title: 'Đã lưu trữ agent', description: 'Thư mục được chuyển vào agents/_archive.' });
      refreshList();
      nav('/agents');
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không lưu trữ được', description: errorText(e) });
      setBusy(false);
    }
  }

  if (!a || !form) return <div class="page"><PageState loading={f.loading} error={f.error} /></div>;
  const budget = a.budgetUsdMonth;
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(a));
  const saveBar = (
    <div class="mt-3 flex justify-end gap-2">
      <button type="button" class="control-button" disabled={!dirty || busy} onClick={() => setForm(toForm(a))}>Hoàn tác</button>
      <button type="button" class="control-button control-accent" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Đang lưu…' : 'Lưu'}</button>
    </div>
  );

  return (
    <div class="page">
      <PageHeader
        breadcrumb="Agents"
        title={a.name}
        actions={
          <>
            <AgentAvatar agentId={a.id} name={a.name} size={26} running={a.stats.running > 0} />
            <RuntimeBadge runtime={a.runtime} />
            {a.model && <Pill>{a.model}</Pill>}
            {!a.enabled && <Pill>Tắt</Pill>}
          </>
        }
        tabs={
          <>
            <Tab label="Tổng quan" active={tab === 'overview'} onClick={() => setTab('overview')} />
            <Tab label="Persona" active={tab === 'persona'} onClick={() => setTab('persona')} />
            <Tab label="Quyền" active={tab === 'access'} onClick={() => setTab('access')} />
            <Tab label="Lượt chạy" active={tab === 'runs'} onClick={() => setTab('runs')} />
            <Tab label="Chat" active={tab === 'chat'} onClick={() => setTab('chat')} />
          </>
        }
      />

      {tab === 'overview' && (
        <>
          <div class="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Đang chạy / chờ" value={`${a.stats.running} / ${a.stats.queued}`} />
            <Stat label="Lượt chạy tháng này" value={a.stats.runsMonth} />
            <Stat label="Chi phí tháng này" value={formatCost(a.stats.costMonthUsd)} sub={budget !== undefined ? `Ngân sách $${budget}` : 'Không giới hạn'} />
            <Stat label="Chạy gần nhất" value={<span class="text-[16px]">{a.stats.lastRunAt ? formatRelativeTime(a.stats.lastRunAt) : 'Chưa chạy'}</span>} sub={RUNTIME_LABEL[a.runtime]} />
          </div>
          <Card title="Cài đặt">
            <AgentForm value={form} onChange={setForm} others={agents} show="settings" />
            {saveBar}
          </Card>
          <div class="mt-3 flex items-center justify-between">
            <span class="hint mono">{a.dir}</span>
            <button type="button" class="control-button control-danger" onClick={() => setConfirmDel(true)}><Trash2 size={12} /> Lưu trữ agent</button>
          </div>
        </>
      )}
      {tab === 'persona' && (
        <Card>
          <AgentForm value={form} onChange={setForm} others={agents} show="persona" />
          {saveBar}
        </Card>
      )}
      {tab === 'access' && <AccessEditor key={JSON.stringify(a.access)} agentId={a.id} access={a.access} runtimeLabel={RUNTIME_LABEL[a.runtime]} onSaved={f.refresh} />}
      {tab === 'runs' && <RunsTab agentId={a.id} />}
      {tab === 'chat' && <ChatTab agentId={a.id} />}

      <ConfirmModal open={confirmDel} onClose={() => setConfirmDel(false)} onConfirm={() => void archive()} destructive loading={busy} title={`Lưu trữ ${a.name}?`} body="Agent sẽ ngừng nhận việc. Thư mục được chuyển vào agents/_archive, không bị xoá hẳn." confirmLabel="Lưu trữ" />
    </div>
  );
}
