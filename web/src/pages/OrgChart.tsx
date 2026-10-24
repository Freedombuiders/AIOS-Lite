import { useMemo, useState } from 'preact/hooks';
import { PageState } from '@/components/PageState';
import { Modal } from '@/components/Modal';
import { AgentAvatar } from '@/components/AgentAvatar';
import { OrgViewport } from '@/components/org-viewport';
import { AgentOrgCard, OwnerCard } from '@/components/org-card';
import { ApiError, apiPut } from '@/lib/api';
import type { AgentSummary } from '@/lib/api-types';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import { OWNER_ID, buildTree, chartBounds, collectEdges, edgePath, flattenLayout, layoutTree, ownerCenterX, type OrgNodeDto } from '@/lib/org-layout';
import { managerChoices, runningTaskByAgent, teamSummary } from '@/lib/org-view';

interface TasksResponse { items: Array<{ id: number; title: string; agentId: string; status: string }> }

const BTN = 'min-h-11 control-button inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] px-4 py-2 text-[13px] disabled:opacity-40';

/** Org-chart view of the agents hub (/agents?layout=org): who reports to whom, who is running, what they are doing now. */
export function OrgChartView({ onSelect }: { onSelect: (id: string) => void }) {
  const org = useFetch<{ items: AgentSummary[] }>('/agents', 15_000);
  // A missing or failing task feed only hides the "đang làm" line; the chart still draws.
  const tasks = useFetch<TasksResponse>('/tasks?status=running', 15_000);
  const [editing, setEditing] = useState<string | null>(null);

  const nodes = useMemo<OrgNodeDto[]>(
    () => (org.data?.items ?? []).filter((a) => a.enabled).map((a) => ({ id: a.id, name: a.name, role: a.description, reportsTo: a.reportsTo ?? null, running: a.stats.running > 0 })),
    [org.data],
  );
  const chart = useMemo(() => {
    const root = layoutTree(buildTree(nodes));
    const flat = flattenLayout(root);
    return { root, flat, edges: collectEdges(root), bounds: chartBounds(flat) };
  }, [org.data]);
  const running = useMemo(() => runningTaskByAgent(tasks.error ? null : tasks.data?.items.map((t) => ({ id: String(t.id), title: t.title, assigned_agent: t.agentId, status: t.status }))), [tasks.data, tasks.error]);
  const editingNode = editing ? nodes.find((n) => n.id === editing) ?? null : null;

  let body;
  if (org.error && !org.data) body = <PageState error={org.error} />;
  else if (org.loading && !org.data) body = <PageState loading />;
  else if (nodes.length === 0) body = <PageState empty emptyTitle="Chưa có agent nào" emptyDescription="Bấm “Agent mới” để tạo agent, rồi sắp xếp ai báo cáo cho ai ở đây." />;
  else body = <>
    <OrgViewport bounds={chart.bounds} anchorX={ownerCenterX(chart.root)}
      edges={chart.edges.map(({ parent, child }) => <path key={`${parent.id}>${child.id}`} d={edgePath(parent, child)} fill="none" stroke="var(--color-border-strong)" stroke-width={1.5} />)}>
      {chart.flat.map((l) => l.id === OWNER_ID
        ? <OwnerCard key={l.id} layout={l} summary={teamSummary(nodes)} />
        : <AgentOrgCard key={l.id} layout={l} task={running.get(l.id)} onOpen={onSelect} onChangeManager={setEditing} />)}
    </OrgViewport>
    <p class="shrink-0 text-[12px] leading-[18px] text-[var(--color-text-muted)]">Kéo để di chuyển, cuộn hoặc chụm hai ngón để thu phóng, bấm thẻ để mở thao tác của agent.</p>
  </>;

  return <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-2 px-4 py-4 sm:px-6 sm:py-5">
    {body}
    {editingNode && <ManagerDialog node={editingNode} nodes={nodes} onClose={() => setEditing(null)} />}
  </div>;
}

function ManagerDialog({ node, nodes, onClose }: { node: OrgNodeDto; nodes: OrgNodeDto[]; onClose: () => void }) {
  const choices = useMemo(() => managerChoices(nodes, node.id), [nodes, node.id]);
  const [picked, setPicked] = useState<string | null>(node.reportsTo);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiPut(`/agents/${encodeURIComponent(node.id)}`, { reportsTo: picked ?? '' });
      invalidateFetchCache('/agents');
      pushToast({ tone: 'success', title: picked ? `${node.name} báo cáo cho ${nodes.find((n) => n.id === picked)?.name ?? picked}` : `${node.name} báo cáo thẳng cho bạn` });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError && err.message || 'Không lưu được. Thử lại sau.');
      setSaving(false);
    }
  }

  const option = (id: string | null, label: string, hint?: string, avatar?: OrgNodeDto) => {
    const selected = picked === id;
    return <label key={id ?? 'owner'} class={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 ${selected ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-border)] hover:bg-[var(--color-elevated)]'}`}>
      <input type="radio" name="org-manager" checked={selected} onChange={() => setPicked(id)} class="shrink-0 accent-[var(--color-accent)]" />
      {avatar && <AgentAvatar agentId={avatar.id} name={avatar.name} size={24} running={avatar.running} />}
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[13px] font-medium text-[var(--color-text)]">{label}</span>
        {hint && <span class="block truncate text-[11px] text-[var(--color-text-muted)]">{hint}</span>}
      </span>
    </label>;
  };

  return <Modal open onClose={saving ? () => {} : onClose} title={`Đổi người quản lý: ${node.name}`} width={440}
    footer={<>
      {error && <p role="alert" class="w-full text-[13px] text-[var(--color-status-failed)]">{error}</p>}
      <button type="button" class={`${BTN} ml-auto`} disabled={saving} onClick={onClose}>Hủy</button>
      <button type="button" class={`${BTN} control-accent font-medium`} disabled={saving || picked === node.reportsTo} onClick={() => void save()}>{saving ? 'Đang lưu…' : 'Lưu'}</button>
    </>}>
    <div role="radiogroup" aria-label="Người quản lý" class="space-y-2">
      {option(null, 'Bạn (chủ)', 'Báo cáo thẳng cho bạn')}
      {choices.map((c) => option(c.id, c.name, c.role, c))}
    </div>
    <p class="mt-3 text-[12px] leading-[18px] text-[var(--color-text-muted)]">Những agent đang báo cáo cho {node.name} (trực tiếp hoặc gián tiếp) không có trong danh sách để tránh vòng lặp.</p>
  </Modal>;
}
