import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { Pill } from '@/components/Pill';
import { AgentAvatar } from '@/components/AgentAvatar';
import { SectionTitle, errMessage } from '@/components/mission-detail-shared';
import { apiPost } from '@/lib/api';
import { resolveAgentName } from '@/lib/format';
import { pushToast } from '@/lib/toasts';
import {
  formatDateTime, isTerminal, priorityLabel, priorityTone, statusLabel, statusTone, taskLabel, timeAgoVi,
  type MissionDetail,
} from '@/lib/mission-detail';

interface AgentLite { id: string; name: string }

function Row({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return <div class="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-3 py-2 text-[13px]">
    <dt class="pt-0.5 text-[12px] text-[var(--color-text-muted)]">{label}</dt>
    <dd class="min-w-0">{children}</dd>
  </div>;
}

/** Right column "Thuộc tính": state, owner of the work, dependencies and timing. */
export function MissionProperties({ detail, agents, onChange }: {
  detail: MissionDetail; agents: AgentLite[]; onChange: () => void;
}) {
  const { task, parent, blocked } = detail;
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try {
      await fn();
      if (done) pushToast({ tone: 'success', title: done });
      onChange();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không thực hiện được', description: errMessage(err) });
    } finally { setBusy(false); }
  }

  const cancel = () => run(() => apiPost(`/tasks/${task.id}/cancel`), 'Đã hủy task');

  const creator = task.created_by === 'dashboard' ? 'Bạn' : resolveAgentName(task.created_by);
  const waitingRunAt = task.status === 'queued' && task.available_at;

  return <section aria-label="Thuộc tính" class="px-4 py-4 sm:px-5">
    <SectionTitle>Thuộc tính</SectionTitle>
    <dl class="divide-y divide-[var(--color-border)]">
      <Row label="Trạng thái">
        <div class="flex flex-wrap items-center gap-2">
          <Pill tone={statusTone(task.status, blocked)}>{statusLabel(task.status, blocked)}</Pill>
          {!isTerminal(task.status) && (
            <button type="button" disabled={busy} onClick={cancel}
              class="min-h-[32px] rounded px-2 text-[12px] text-[var(--color-status-failed)] hover:bg-[var(--color-elevated)] disabled:opacity-50">Hủy task</button>
          )}
        </div>
      </Row>
      <Row label="Ưu tiên">
        <Pill tone={priorityTone(task.priority)}>{task.priority > 0 ? `P${task.priority} · ${priorityLabel(task.priority)}` : 'Không đặt'}</Pill>
      </Row>
      <Row label="Agent">
        {task.assigned_agent
          ? <div class="flex items-center gap-2">
              <AgentAvatar agentId={task.assigned_agent} name={resolveAgentName(task.assigned_agent)} size={22} />
              <span class="truncate">{resolveAgentName(task.assigned_agent)}</span>
            </div>
          : <span class="text-[var(--color-text-muted)]">Chưa giao</span>}
      </Row>
      <Row label="Task cha">
        {parent
          ? <Link href={`/tasks/${parent.id}`} class="text-[var(--color-accent)] hover:underline">
              <span class="tabular-nums">{taskLabel(parent)}</span> {parent.title}
            </Link>
          : <span class="text-[var(--color-text-muted)]">Không có</span>}
      </Row>
      <Row label="Chạy lúc">
        {task.available_at
          ? <span class={waitingRunAt ? 'text-[var(--color-accent)]' : ''} title={new Date(task.available_at * 1000).toISOString()}>{formatDateTime(task.available_at)}</span>
          : <span class="text-[var(--color-text-muted)]">Ngay khi tới lượt</span>}
      </Row>
      <Row label="Người tạo"><span>{creator}</span></Row>
      <Row label="Thời gian">
        <div class="space-y-0.5 text-[12.5px]">
          <div><span class="text-[var(--color-text-muted)]">Tạo: </span>{formatDateTime(task.created_at)} <span class="text-[var(--color-text-faint)]">({timeAgoVi(task.created_at)})</span></div>
          {task.started_at && <div><span class="text-[var(--color-text-muted)]">Bắt đầu: </span>{formatDateTime(task.started_at)}</div>}
          {task.completed_at && <div><span class="text-[var(--color-text-muted)]">Kết thúc: </span>{formatDateTime(task.completed_at)}</div>}
        </div>
      </Row>
    </dl>
  </section>;
}
