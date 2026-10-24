import { Crown, Users } from 'lucide-preact';
import { AgentAvatar } from '@/components/AgentAvatar';
import { CARD_H, CARD_W, type LayoutNode } from '@/lib/org-layout';
import type { RunningTaskRef } from '@/lib/org-view';

const CARD = 'absolute flex flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2.5 text-left shadow-sm';

/** The root of the chart: the owner. */
export function OwnerCard({ layout, summary }: { layout: LayoutNode; summary: string }) {
  return <div data-org-card="owner" class={`${CARD} justify-center`}
    style={{ left: `${layout.x}px`, top: `${layout.y}px`, width: `${CARD_W}px`, height: `${CARD_H}px`, borderColor: 'color-mix(in srgb, var(--color-accent) 45%, var(--color-border))' }}>
    <div class="flex items-center gap-3">
      <span class="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent)]"><Crown size={17} aria-hidden="true" /></span>
      <div class="min-w-0">
        <div class="truncate text-[14px] font-semibold text-[var(--color-text)]">Bạn (chủ)</div>
        <div class="mt-0.5 text-[11px] leading-[15px] text-[var(--color-text-muted)]">{summary}</div>
      </div>
    </div>
  </div>;
}

interface AgentCardProps {
  layout: LayoutNode;
  task?: RunningTaskRef;
  onOpen: (id: string) => void;
  onChangeManager: (id: string) => void;
}

export function AgentOrgCard({ layout, task, onOpen, onChangeManager }: AgentCardProps) {
  const node = layout.node!;
  const open = () => onOpen(node.id);
  return <div
    data-org-card={node.id}
    role="link"
    tabIndex={0}
    aria-label={`${node.name}, ${node.running ? 'đang chạy' : 'đang nghỉ'}`}
    onClick={open}
    onKeyDown={(e) => { if (e.key === 'Enter') open(); }}
    class={`${CARD} cursor-pointer hover:border-[var(--color-border-strong)] hover:shadow-md`}
    style={{ left: `${layout.x}px`, top: `${layout.y}px`, width: `${CARD_W}px`, height: `${CARD_H}px` }}
  >
    <div class="flex items-start gap-3">
      <span class="relative shrink-0">
        <AgentAvatar agentId={node.id} name={node.name} size={36} running={node.running} />
        <span class="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-[var(--color-card)]"
          style={{ background: node.running ? 'var(--color-status-done)' : 'var(--color-text-faint)' }} aria-hidden="true" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="truncate text-[14px] font-semibold leading-[18px] text-[var(--color-text)]">{node.name}</div>
        <div class="mt-0.5 line-clamp-2 break-words text-[11px] leading-[15px] text-[var(--color-text-muted)]">{node.role || node.id}</div>
      </div>
      <button type="button" data-org-control
        class="-mr-1 -mt-1 grid size-8 shrink-0 place-items-center rounded-md text-[var(--color-text-faint)] hover:bg-[var(--color-elevated)] hover:text-[var(--color-text)] touch-manipulation"
        aria-label={`Đổi người quản lý của ${node.name}`} title="Đổi người quản lý"
        onClick={(e) => { e.stopPropagation(); onChangeManager(node.id); }}
        onKeyDown={(e) => e.stopPropagation()}>
        <Users size={14} aria-hidden="true" />
      </button>
    </div>
    <div class="mt-auto flex items-center gap-1.5 text-[11px] leading-[15px]">
      <span class="shrink-0 font-medium" style={{ color: node.running ? 'var(--color-status-done)' : 'var(--color-text-faint)' }}>{node.running ? 'Đang chạy' : 'Nghỉ'}</span>
      {task && <span class="min-w-0 truncate text-[var(--color-text-muted)]" title={task.title}>· {task.title}</span>}
    </div>
  </div>;
}
