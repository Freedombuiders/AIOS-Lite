import { useState } from 'preact/hooks';
import { Plus } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { StatusDot } from '@/components/Pill';
import { Link } from 'wouter-preact';
import { SectionTitle, errMessage, inputClass } from '@/components/mission-detail-shared';
import { apiPost } from '@/lib/api';
import { resolveAgentName } from '@/lib/format';
import { pushToast } from '@/lib/toasts';
import { progressPercent, progressSummary, statusLabel, statusTone, taskLabel, type MissionDetail } from '@/lib/mission-detail';

interface AgentLite { id: string; name: string }

/** "Task con": progress bar, the list, and the "Thêm task con" form. */
export function MissionSubtasks({ detail, agents, onChange }: {
  detail: MissionDetail; agents: AgentLite[]; onChange: () => void;
}) {
  const { task, children, progress } = detail;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState('');
  const [priority, setPriority] = useState(task.priority || 5);
  const [busy, setBusy] = useState(false);
  const blockedIds = new Set(detail.blockedChildIds ?? []);
  const pct = progressPercent(progress);

  function close() { setOpen(false); setTitle(''); setPrompt(''); setAgent(''); }

  async function submit() {
    setBusy(true);
    try {
      await apiPost('/tasks', {
        title: title.trim() || undefined, prompt: prompt.trim(), priority, parentId: Number(task.id), agentId: agent || task.assigned_agent || undefined,
      });
      pushToast({ tone: 'success', title: 'Đã tạo task con' });
      close();
      onChange();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không tạo được task con', description: errMessage(err) });
    } finally { setBusy(false); }
  }

  return <section aria-label="Task con" class="mt-8">
    <SectionTitle aside={children.length > 0 ? progressSummary(progress) : undefined}>Task con</SectionTitle>
    {children.length > 0 && (
      <div class="mb-3 h-1.5 overflow-hidden rounded-full bg-[var(--color-elevated)]" role="progressbar"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Tiến độ task con">
        <div class="h-full rounded-full bg-[var(--color-status-done)] transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    )}
    {children.length > 0 && (
      <ul class="mb-3 divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)] bg-[var(--color-card)]">
        {children.map((c) => {
          const blocked = blockedIds.has(c.id);
          return <li key={c.id}>
            <Link href={`/tasks/${c.id}`} class="flex min-h-[44px] items-center gap-2.5 px-3 py-2 text-[13px] hover:bg-[var(--color-elevated)]">
              <StatusDot tone={statusTone(c.status, blocked)} />
              <span class="w-10 shrink-0 tabular-nums text-[var(--color-text-faint)]">{taskLabel(c)}</span>
              <span class="min-w-0 flex-1 truncate">{c.title}</span>
              {c.assigned_agent && <span class="hidden shrink-0 text-[12px] text-[var(--color-text-muted)] sm:inline">{resolveAgentName(c.assigned_agent)}</span>}
              <span class="shrink-0 text-[12px] text-[var(--color-text-muted)]">{statusLabel(c.status, blocked)}</span>
            </Link>
          </li>;
        })}
      </ul>
    )}
    <button type="button" onClick={() => setOpen(true)}
      class="inline-flex min-h-[40px] items-center gap-1.5 rounded border border-[var(--color-border)] px-3 text-[13px] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]">
      <Plus size={14} aria-hidden="true" /> Thêm task con
    </button>
    {children.length === 0 && <p class="mt-2 text-[12.5px] text-[var(--color-text-muted)]">Chưa có task con. Chia việc lớn thành các bước nhỏ để theo dõi tiến độ.</p>}

    <Modal open={open} onClose={close} title="Thêm task con" width={520}
      footer={<>
        <button type="button" onClick={close} class="min-h-[40px] rounded px-3 text-[13px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Hủy</button>
        <button type="button" onClick={submit} disabled={busy || !title.trim() || !prompt.trim()}
          class="control-button control-accent ml-auto min-h-[40px] rounded px-3 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-40">
          {busy ? 'Đang tạo…' : 'Tạo task con'}
        </button>
      </>}>
      <div class="space-y-3">
        <label class="block">
          <span class="mb-1 block text-[12px] text-[var(--color-text-muted)]">Tiêu đề</span>
          <input class={inputClass} value={title} maxLength={200} placeholder="Việc cần làm"
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
        </label>
        <label class="block">
          <span class="mb-1 block text-[12px] text-[var(--color-text-muted)]">Nội dung giao việc</span>
          <textarea class={inputClass + ' min-h-[120px] resize-y font-mono'} value={prompt} placeholder="Mô tả chi tiết để agent làm được ngay"
            onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)} />
        </label>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_96px]">
          <label class="block">
            <span class="mb-1 block text-[12px] text-[var(--color-text-muted)]">Giao cho</span>
            <select class={inputClass} value={agent} onChange={(e) => setAgent((e.target as HTMLSelectElement).value)}>
              <option value="">Chưa giao</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label class="block">
            <span class="mb-1 block text-[12px] text-[var(--color-text-muted)]">Ưu tiên (0-10)</span>
            <input type="number" min={0} max={10} class={inputClass + ' tabular-nums'} value={priority}
              onInput={(e) => setPriority(Math.max(0, Math.min(10, Number((e.target as HTMLInputElement).value) || 0)))} />
          </label>
        </div>
      </div>
    </Modal>
  </section>;
}
