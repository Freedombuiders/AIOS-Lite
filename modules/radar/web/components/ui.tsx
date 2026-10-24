// Small UI kit of the Radar pages: button/input classes, error helpers and the Card shell.
import type { ComponentChildren } from 'preact';
import { ApiError } from '@/lib/api';

export const INPUT =
  'h-9 px-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[13px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50 min-w-0';
export const TEXTAREA =
  'px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[13px] leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50 resize-y min-w-0';
export const BTN =
  'inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-card)] text-[12.5px] text-[var(--color-text)] hover:bg-[var(--color-control-hover)] transition-colors disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]';
export const BTN_PRIMARY =
  'inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-md bg-[var(--color-accent)] text-[12.5px] font-semibold text-[var(--color-on-accent)] hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]';
export const BTN_DANGER =
  'inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-md border border-[color-mix(in_srgb,var(--color-status-failed)_55%,transparent)] bg-transparent text-[12.5px] text-[var(--color-status-failed)] hover:bg-[color-mix(in_srgb,var(--color-status-failed)_14%,transparent)] transition-colors disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap';
export const BTN_SM =
  'inline-flex items-center justify-center h-7 px-2.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-elevated)] text-[12px] text-[var(--color-text)] hover:bg-[var(--color-control-hover)] transition-colors disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap';

/** Status and message of a failed API call. The server answers `{ error }` in Vietnamese. */
export function apiFail(err: unknown): { status: number; message: string } {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string } | undefined;
    return { status: err.status, message: body?.error || err.message };
  }
  return { status: 0, message: err instanceof Error ? err.message : String(err) };
}

export function InlineError({ children }: { children: ComponentChildren }) {
  return (
    <div role="alert" class="rounded-lg border border-[color-mix(in_srgb,var(--color-status-failed)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-status-failed)_8%,transparent)] px-3.5 py-2.5 text-[12.5px] text-[var(--color-status-failed)]">
      {children}
    </div>
  );
}

export function Card({ title, aside, children, class: cls = '' }: { title?: ComponentChildren; aside?: ComponentChildren; children: ComponentChildren; class?: string }) {
  return (
    <section class={`rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4 flex flex-col gap-3 min-w-0 ${cls}`}>
      {(title || aside) && (
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          {title && <h2 class="text-[14px] font-semibold text-[var(--color-text)]">{title}</h2>}
          {aside && <div class="text-[12px] text-[var(--color-text-muted)]">{aside}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
