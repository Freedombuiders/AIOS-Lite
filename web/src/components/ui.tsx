// Small shared building blocks for pages (kept dependency-free).
import type { ComponentChildren } from 'preact';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <label class="block">
      <span class="label">{label}</span>
      {children}
      {hint && <span class="hint mt-1 block">{hint}</span>}
    </label>
  );
}

export function Card({ title, actions, children, class: cls = '' }: { title?: string; actions?: ComponentChildren; children: ComponentChildren; class?: string }) {
  return (
    <section class={`card card-pad ${cls}`}>
      {(title || actions) && (
        <div class="mb-2 flex items-center justify-between gap-2">
          {title && <div class="section-title">{title}</div>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ComponentChildren; sub?: string }) {
  return (
    <div class="card card-pad">
      <div class="hint">{label}</div>
      <div class="mt-0.5 text-[22px] font-semibold leading-tight">{value}</div>
      {sub && <div class="hint mt-0.5">{sub}</div>}
    </div>
  );
}

export function Markdown({ html, class: cls = '' }: { html: string; class?: string }) {
  return <div class={`md ${cls}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
