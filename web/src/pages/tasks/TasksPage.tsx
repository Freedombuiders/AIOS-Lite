import { Plus, Search, Users, Workflow } from 'lucide-preact';
import { useCallback, useMemo, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import type { Task, TaskStatus } from '@core/types';
import { AgentAvatar } from '@/components/AgentAvatar';
import { CreateTaskDialog } from '@/components/CreateTaskDialog';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { TeamDialog } from '@/components/TeamDialogs';
import { useAgents } from '@/lib/agents';
import { formatRelativeTime, fold, resolveAgentName } from '@/lib/format';
import { SOURCE_LABEL, STATUS_LABEL } from '@/lib/labels';
import { useEvents } from '@/lib/sse';
import { useFetch } from '@/lib/useFetch';
import { moduleInfos } from '@/module-host/host';

const COLUMNS: TaskStatus[] = ['queued', 'running', 'waiting', 'review', 'done', 'failed'];
const DOT: Record<string, string> = { queued: '', running: 'dot-info dot-pulse', waiting: 'dot-warn', review: 'dot-warn', done: 'dot-success', failed: 'dot-error' };

function sourceGroup(source: string): string {
  if (source.startsWith('module:')) return source;
  if (source.startsWith('schedule:')) return 'schedule';
  if (source.startsWith('agent:')) return 'agent';
  return source;
}

function TaskCard({ t }: { t: Task }) {
  return (
    <Link href={`/tasks/${t.id}`} class="card block px-2.5 py-2 text-[var(--color-text)] no-underline hover:border-[var(--color-border-strong)]">
      <div class="line-clamp-2 text-[12.5px] font-medium">{t.title}</div>
      <div class="mt-1.5 flex items-center gap-1.5">
        <AgentAvatar agentId={t.agentId} name={resolveAgentName(t.agentId)} size={16} />
        <span class="hint truncate">{resolveAgentName(t.agentId)}</span>
        {t.kind === 'team' && <Pill tone="waiting">nhóm</Pill>}
        {t.parentId && <span class="hint">↳ #{t.parentId}</span>}
        <span class="hint ml-auto shrink-0">{formatRelativeTime(t.updatedAt)}</span>
      </div>
      {t.source !== 'user' && <div class="hint mt-1">{SOURCE_LABEL(t.source)}</div>}
    </Link>
  );
}

export default function TasksPage() {
  const { agents } = useAgents();
  const f = useFetch<{ items: Task[] }>('/tasks?limit=300');
  const [agentFilter, setAgentFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [q, setQ] = useState('');
  const [showCancelled, setShowCancelled] = useState(false);
  const [creating, setCreating] = useState(false);
  const [team, setTeam] = useState<'parallel' | 'relay' | null>(null);

  const refresh = f.refresh;
  const onEvent = useCallback(() => refresh(), [refresh]);
  useEvents(['task'], onEvent);

  const items = useMemo(() => {
    const needle = fold(q);
    return (f.data?.items ?? []).filter(
      (t) => (!agentFilter || t.agentId === agentFilter) && (!sourceFilter || sourceGroup(t.source) === sourceFilter) && (!needle || fold(t.title).includes(needle)),
    );
  }, [f.data, agentFilter, sourceFilter, q]);

  const enabledModules = moduleInfos.value.filter((m) => m.state.enabled);
  const cancelled = items.filter((t) => t.status === 'cancelled');
  const total = f.data?.items.length ?? 0;

  return (
    <div class="page page-wide">
      <PageHeader
        title="Công việc"
        actions={
          <>
            <button type="button" class="control-button" onClick={() => setTeam('parallel')}><Users size={12} /> Hỏi cả nhóm</button>
            <button type="button" class="control-button" onClick={() => setTeam('relay')}><Workflow size={12} /> Relay</button>
            <button type="button" class="control-button control-accent" onClick={() => setCreating(true)}><Plus size={12} /> Tạo việc</button>
          </>
        }
      />
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <div class="relative">
          <Search size={12} class="absolute top-2 left-2 text-[var(--color-text-faint)]" />
          <input class="field" style={{ width: 200, paddingLeft: 24 }} placeholder="Tìm theo tiêu đề…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </div>
        <select class="field" style={{ width: 'auto' }} value={agentFilter} onChange={(e) => setAgentFilter((e.target as HTMLSelectElement).value)} aria-label="Lọc theo agent">
          <option value="">Mọi agent</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select class="field" style={{ width: 'auto' }} value={sourceFilter} onChange={(e) => setSourceFilter((e.target as HTMLSelectElement).value)} aria-label="Lọc theo nguồn">
          <option value="">Mọi nguồn</option>
          <option value="user">Bạn giao</option>
          <option value="api">API</option>
          <option value="chat">Trò chuyện</option>
          <option value="schedule">Lịch định kỳ</option>
          <option value="agent">Agent giao</option>
          {enabledModules.map((m) => <option key={m.manifest.id} value={`module:${m.manifest.id}`}>Module {m.manifest.name}</option>)}
        </select>
        <label class="flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
          <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled((e.target as HTMLInputElement).checked)} /> Hiện việc đã huỷ ({cancelled.length})
        </label>
      </div>

      <PageState loading={f.loading && !f.data} error={f.error} empty={!!f.data && total === 0} emptyTitle="Chưa có công việc nào" emptyDescription="Giao việc đầu tiên cho một agent để bắt đầu." action={<button type="button" class="control-button control-accent" onClick={() => setCreating(true)}><Plus size={12} /> Tạo việc</button>} />
      {total > 0 && (
        <div class="kanban">
          {COLUMNS.map((st) => {
            const col = items.filter((t) => t.status === st);
            const shown = st === 'done' ? col.slice(0, 20) : col;
            return (
              <section key={st} class="kanban-col" aria-label={STATUS_LABEL[st]}>
                <div class="flex items-center gap-1.5 px-2.5 py-2">
                  <span class={`dot ${DOT[st]}`} />
                  <span class="text-[12px] font-semibold">{STATUS_LABEL[st]}</span>
                  <span class="hint ml-auto">{col.length}</span>
                </div>
                <div class="flex flex-1 flex-col gap-1.5 px-1.5 pb-2">
                  {shown.map((t) => <TaskCard key={t.id} t={t} />)}
                  {col.length === 0 && <div class="hint px-1 py-3 text-center">Trống</div>}
                  {col.length > shown.length && <div class="hint text-center">+{col.length - shown.length} việc cũ hơn</div>}
                </div>
              </section>
            );
          })}
          {showCancelled && (
            <section class="kanban-col" aria-label="Đã huỷ">
              <div class="flex items-center gap-1.5 px-2.5 py-2"><span class="dot" /><span class="text-[12px] font-semibold">Đã huỷ</span><span class="hint ml-auto">{cancelled.length}</span></div>
              <div class="flex flex-1 flex-col gap-1.5 px-1.5 pb-2">{cancelled.map((t) => <TaskCard key={t.id} t={t} />)}</div>
            </section>
          )}
        </div>
      )}

      <CreateTaskDialog open={creating} agents={agents} onClose={() => setCreating(false)} />
      <TeamDialog open={team !== null} mode={team ?? 'parallel'} agents={agents} onClose={() => setTeam(null)} />
    </div>
  );
}
