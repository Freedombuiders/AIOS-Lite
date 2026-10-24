import { LayoutGrid, Network, Plus, TriangleAlert } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { Link, useLocation } from 'wouter-preact';
import { AgentAvatar } from '@/components/AgentAvatar';
import { AgentForm, EMPTY_AGENT, toInput, validateAgent } from '@/components/agents/AgentForm';
import type { AgentFormValue } from '@/components/agents/AgentForm';
import { Modal } from '@/components/Modal';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { OrgChartView } from '@/pages/OrgChart';
import { Pill, StatusDot } from '@/components/Pill';
import { apiPost, errorText } from '@/lib/api';
import type { AgentDetail, AgentSummary } from '@/lib/api-types';
import { useAgents } from '@/lib/agents';
import { formatCost, formatRelativeTime } from '@/lib/format';
import { RUNTIME_LABEL } from '@/lib/labels';
import { pushToast } from '@/lib/toasts';

export function RuntimeBadge({ runtime }: { runtime: AgentSummary['runtime'] }) {
  return <Pill tone={runtime === 'mock' ? 'neutral' : 'accent'}>{RUNTIME_LABEL[runtime]}</Pill>;
}

const TONE: Record<AgentSummary['runtime'], string> = { claude: 'coral', codex: 'blue', grok: 'slate', hermes: 'plum', mock: 'sand' };

function AgentCard({ a }: { a: AgentSummary }) {
  const budget = a.budgetUsdMonth;
  const over = budget !== undefined && a.stats.costMonthUsd >= budget;
  return (
    <article class="agent-profile-card" data-tone={TONE[a.runtime]}>
      <div class="agent-profile-cover" aria-hidden="true"><span /><span /></div>
      <div class="agent-profile-heading">
        <div class="agent-profile-topline">
          <span class="agent-profile-portrait"><AgentAvatar agentId={a.id} name={a.name} size={72} running={a.stats.running > 0} /></span>
          <RuntimeBadge runtime={a.runtime} />
        </div>
        <div class="agent-profile-status">
          <StatusDot tone={a.stats.running ? 'running' : a.stats.queued ? 'warn' : 'neutral'} />
          <span class="agent-primary-label">{a.stats.running ? `${a.stats.running} ĐANG CHẠY` : a.stats.queued ? `${a.stats.queued} ĐANG CHỜ` : 'RẢNH'}</span>
          {!a.enabled && <Pill>Tắt</Pill>}
          {a.canDelegate && <Pill tone="info">giao việc</Pill>}
        </div>
        <h2 class="agent-profile-name">{a.name}</h2>
      </div>
      <div class="agent-profile-description"><p class="m-0 text-[12.5px] text-[var(--color-text-muted)]">{a.description || a.id}</p></div>
      <div class="agent-profile-activity">
        <span>Chi phí tháng <strong class={over ? 'text-[var(--color-status-failed)]' : ''}>{formatCost(a.stats.costMonthUsd)}{budget !== undefined ? ` / $${budget}` : ''}</strong></span>
        <span>Lượt chạy <strong>{a.stats.runsMonth}</strong></span>
        <span>Gần nhất <strong>{a.stats.lastRunAt ? formatRelativeTime(a.stats.lastRunAt) : '—'}</strong></span>
      </div>
      <div class="agent-profile-actions">
        <Link href={`/agents/${a.id}`} class="control-button control-accent no-underline" style={{ flex: 1 }}>Mở agent</Link>
        <Link href="/chat" class="control-button no-underline">Trò chuyện</Link>
      </div>
    </article>
  );
}

export default function AgentsPage() {
  const { agents, loadErrors, loading, error, refresh } = useAgents();
  const [, nav] = useLocation();
  const [view, setView] = useState<'cards' | 'org'>('cards');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<AgentFormValue>(EMPTY_AGENT);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function create() {
    const err = validateAgent(form, true);
    setFormError(err);
    if (err) return;
    setBusy(true);
    try {
      const a = await apiPost<AgentDetail>('/agents', { id: form.id, ...toInput(form) });
      pushToast({ tone: 'success', title: `Đã tạo agent ${a.name}` });
      setCreating(false);
      setForm(EMPTY_AGENT);
      refresh();
      nav(`/agents/${a.id}`);
    } catch (e) {
      setFormError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="page">
      <PageHeader
        title="Agents"
        actions={
          <>
            <div class="flex">
              <button type="button" class={`toolbar-control ${view === 'cards' ? 'is-active' : ''}`} onClick={() => setView('cards')}>
                <LayoutGrid size={12} /> Thẻ
              </button>
              <button type="button" class={`toolbar-control ml-1 ${view === 'org' ? 'is-active' : ''}`} onClick={() => setView('org')}>
                <Network size={12} /> Sơ đồ
              </button>
            </div>
            <button type="button" class="control-button control-accent" onClick={() => { setForm(EMPTY_AGENT); setFormError(null); setCreating(true); }}>
              <Plus size={12} /> Tạo agent
            </button>
          </>
        }
      />
      <PageState loading={loading && !agents.length} error={error} empty={!loading && !error && agents.length === 0} emptyTitle="Chưa có agent nào" emptyDescription="Agent là thư mục agents/<mã> gồm agent.yaml và persona.md. Tạo agent đầu tiên để giao việc." />
      {loadErrors.length > 0 && (
        <div class="card card-pad mb-3 border-[var(--color-status-review)]/50">
          <div class="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-[var(--color-status-review)]">
            <TriangleAlert size={13} /> {loadErrors.length} agent không đọc được
          </div>
          {loadErrors.map((e) => (
            <div key={e.id} class="hint">
              <span class="mono">{e.file}</span>: {e.message}
            </div>
          ))}
        </div>
      )}
      {view === 'cards' ? (
        <div class="agents-gallery">
          {agents.map((a) => (
            <AgentCard key={a.id} a={a} />
          ))}
        </div>
      ) : (
        agents.length > 0 && <div class="card" style={{ height: '70vh', display: 'flex' }}><OrgChartView onSelect={(id) => nav(`/agents/${id}`)} /></div>
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Tạo agent"
        width={720}
        closeDisabled={busy}
        footer={
          <>
            {formError && <span class="mr-auto text-[12px] text-[var(--color-status-failed)]">{formError}</span>}
            <button type="button" class="control-button" disabled={busy} onClick={() => setCreating(false)}>Huỷ</button>
            <button type="button" class="control-button control-accent" disabled={busy} onClick={() => void create()}>{busy ? 'Đang tạo…' : 'Tạo agent'}</button>
          </>
        }
      >
        <AgentForm value={form} onChange={setForm} creating others={agents} />
      </Modal>
    </div>
  );
}
