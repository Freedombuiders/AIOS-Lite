// Class strings and tiny helpers shared by the connection / rule components that the legacy Zalo and Email screens and
// the "Kênh & agent" page both render.
import type { ComponentChildren } from 'preact';

export const INPUT = 'w-full px-3 py-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none text-[12.5px] text-[var(--color-text)]';
export const NUM = 'w-28 px-2 py-1.5 rounded bg-[var(--color-bg)] border border-[var(--color-border)] text-[12.5px] text-[var(--color-text)] tabular-nums focus:outline-none focus:border-[var(--color-accent)]';
export const BTN = 'toolbar-control control-button inline-flex items-center gap-1.5 px-3 rounded-md text-[13px] text-[var(--color-text)] hover:bg-[var(--color-control-hover)] disabled:opacity-40';
export const LABEL = 'block text-[13px] font-medium text-[var(--color-text-muted)] mb-1.5';
export const ACCENT_BTN = 'control-button px-3 py-1.5 rounded text-[12.5px] font-medium control-accent disabled:opacity-40';

export function errMsg(err: unknown): string {
  const body = (err as { body?: { error?: string } })?.body;
  return body?.error || (err instanceof Error ? err.message : String(err));
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <div>
      <label class={LABEL}>{label}</label>
      {children}
      {hint && <div class="mt-1 text-[12px] text-[var(--color-text-faint)]">{hint}</div>}
    </div>
  );
}

export function Hint({ children }: { children: ComponentChildren }) {
  return <div class="mt-1 text-[12px] text-[var(--color-text-faint)]">{children}</div>;
}
