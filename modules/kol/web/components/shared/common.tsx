// Small building blocks shared by the KOL Studio screens (Card, KpiTile, SetupNotice).

import type { ComponentChildren } from 'preact';

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

export function KpiTile({ label, value, delta, deltaTone = 'neutral', children }: {
  label: string;
  value: ComponentChildren;
  delta?: ComponentChildren;
  deltaTone?: 'good' | 'bad' | 'neutral';
  children?: ComponentChildren;
}) {
  const tone = deltaTone === 'good' ? 'text-[var(--color-status-done)]' : deltaTone === 'bad' ? 'text-[var(--color-status-failed)]' : 'text-[var(--color-text-muted)]';
  return (
    <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3.5 py-3 flex flex-col gap-1 min-w-0">
      <div class="text-[12px] text-[var(--color-text-muted)]">{label}</div>
      <div class="text-[22px] font-semibold tabular-nums text-[var(--color-text)]">{value}</div>
      {delta !== undefined && <div class={`text-[12px] ${tone}`}>{delta}</div>}
      {children}
    </div>
  );
}

/** Shown when Composio or the studio is not set up yet, with the next step. */
export function SetupNotice({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3 text-[13px] text-[var(--color-text-muted)] w-full min-w-0">
      <div class="font-semibold text-[var(--color-text)] mb-1">{title}</div>
      {children}
    </div>
  );
}
