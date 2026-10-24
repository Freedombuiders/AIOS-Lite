import type { ComponentChildren } from 'preact';
import { Link } from 'wouter-preact';
import { ApiError } from '@/lib/api';
import { StatusDot } from '@/components/Pill';
import { statusTone, taskLabel, type TaskRef } from '@/lib/mission-detail';

/** Message to show for a failed call: the server's Vietnamese `error` when it sent one. */
export function errMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: unknown } | null;
    if (body && typeof body.error === 'string') return body.error;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Markdown body: .chat-md styles plus the list markers the global reset removes. */
export const markdownClass = 'chat-md break-words leading-relaxed [&_ul]:list-disc [&_ol]:list-decimal [&_h1]:mt-3 [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-semibold';

export const inputClass =
  'w-full min-h-[40px] bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--color-accent)]';

export function SectionTitle({ children, aside }: { children: ComponentChildren; aside?: ComponentChildren }) {
  return <div class="mb-2 flex items-center gap-2">
    <h2 class="text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-faint)]">{children}</h2>
    {aside && <div class="ml-auto text-[12px] text-[var(--color-text-muted)]">{aside}</div>}
  </div>;
}

/** A task shown as a compact link chip: status dot, #seq, title. */
export function TaskChip({ task, onRemove, removeLabel }: { task: TaskRef; onRemove?: () => void; removeLabel?: string }) {
  return <span class="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-elevated)] pl-2 pr-1 py-0.5 text-[12px]">
    <StatusDot tone={statusTone(task.status)} />
    <Link href={`/tasks/${task.id}`} class="min-w-0 truncate hover:text-[var(--color-accent)]" title={task.title}>
      <span class="tabular-nums text-[var(--color-text-muted)]">{taskLabel(task)}</span> {task.title}
    </Link>
    {onRemove
      ? <button type="button" onClick={onRemove} aria-label={removeLabel ?? 'Gỡ'} title={removeLabel ?? 'Gỡ'}
          class="ml-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[var(--color-text-faint)] hover:bg-[var(--color-card)] hover:text-[var(--color-text)]">×</button>
      : <span class="w-1" />}
  </span>;
}
