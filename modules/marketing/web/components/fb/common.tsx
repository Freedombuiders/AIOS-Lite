// Shared building blocks for the Marketing › Facebook pages. Owned by the
// coordinator: frontend workstreams import from here and add their own
// components in separate files rather than editing this one.

import type { ComponentChildren } from 'preact';
import { FORMAT_META, STATUS_META, type FbContentStatus, type FbFormat, type FbPageDto } from '@modules/marketing/web/lib/fbstudio';

export function FormatChip({ format }: { format: FbFormat }) {
  const meta = FORMAT_META[format] ?? FORMAT_META.text;
  return (
    <span class="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--color-text)] whitespace-nowrap">
      <span class="w-2 h-2 rounded-[2px]" style={{ background: meta.color }} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

export function StatusPill({ status }: { status: FbContentStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.draft;
  return (
    <span
      class="inline-flex items-center h-[22px] px-2 rounded-full text-[12px] font-medium whitespace-nowrap"
      style={{ background: meta.bg, color: meta.fg }}
    >
      {meta.label}
    </span>
  );
}

/**
 * Fanpage picker. Dashboards show ONE Page at a time (user decision): never
 * aggregate several Pages on one chart.
 */
export function PageTabs({
  pages,
  value,
  onChange,
}: {
  pages: Pick<FbPageDto, 'id' | 'name'>[];
  value: string | null;
  onChange: (pageId: string) => void;
}) {
  return (
    <div role="group" aria-label="Fanpage" class="flex flex-wrap gap-1.5">
      {pages.map((p) => {
        const on = p.id === value;
        return (
          <button
            key={p.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(p.id)}
            class={`h-8 px-3 rounded-md border text-[12.5px] transition-colors ${
              on
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-text)] font-semibold'
                : 'border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}
          >
            {p.name}
          </button>
        );
      })}
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
