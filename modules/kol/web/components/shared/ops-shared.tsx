// Form atoms and small helpers shared by the KOL Studio screens (buttons, inputs, chips, time helpers).

import type { ComponentChildren } from 'preact';
import { ApiError } from '@/lib/api';
import { useFetch } from '@/lib/useFetch';

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
export const LABEL_CAPS = 'text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]';

/** Status and message of a failed API call. The server answers `{ error }` in Vietnamese. */
export function apiFail(err: unknown): { status: number; message: string } {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string } | undefined;
    return { status: err.status, message: body?.error || err.message };
  }
  return { status: 0, message: err instanceof Error ? err.message : String(err) };
}

/** useFetch exposes errors as "GET /path failed: 503"; recover the status code from it. */
export function statusFromError(error: string | null): number {
  const m = error?.match(/failed: (\d{3})/);
  return m ? Number(m[1]) : 0;
}

/** Fanpages the Marketing module knows (empty when that module is off). */
export interface FbPageLite { id: string; name: string; enabled: boolean; status: string; pictureUrl?: string; followers?: number | null }
export function useFbPages() {
  const res = useFetch<{ pages: FbPageLite[] }>('/api/m/marketing/pages');
  const pages = res.data?.pages ?? [];
  return { ...res, pages, enabledPages: pages.filter((p) => p.enabled) };
}

export function FilterChip({ on, label, count, tone, onClick }: {
  on: boolean; label: string; count?: number; tone?: 'danger' | 'accent'; onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      class={`h-8 px-3 rounded-md border text-[12.5px] transition-colors inline-flex items-center gap-1.5 whitespace-nowrap ${
        on
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-text)] font-semibold'
          : 'border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
      }`}
    >
      {label}
      {count !== undefined && (
        <span class={tone === 'danger' && count > 0 ? 'text-[var(--color-status-failed)]' : 'text-[var(--color-text-faint)]'}>{count}</span>
      )}
    </button>
  );
}

export function ConnDot({ status }: { status: string }) {
  const color = status === 'ACTIVE' ? '#4ade80' : status === 'UNKNOWN' ? 'var(--color-text-faint)' : '#f87171';
  return <span class="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: color }} aria-hidden="true" />;
}

export function Field({ label, hint, children, class: cls = '' }: { label: string; hint?: string; children: ComponentChildren; class?: string }) {
  return (
    <label class={`flex flex-col gap-1.5 text-[12px] text-[var(--color-text-muted)] min-w-0 ${cls}`}>
      {label}
      {children}
      {hint && <span class="text-[11.5px] text-[var(--color-text-faint)]">{hint}</span>}
    </label>
  );
}

export function Checkbox({ checked, onChange, children, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; children: ComponentChildren; disabled?: boolean;
}) {
  return (
    <label class="flex items-center gap-2.5 min-h-8 text-[13px] text-[var(--color-text)]">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
        class="w-4 h-4 accent-[var(--color-accent)]"
      />
      <span class="flex flex-wrap items-center gap-2 min-w-0">{children}</span>
    </label>
  );
}

/** Small colour-independent error/warn box. */
export function InlineError({ children }: { children: ComponentChildren }) {
  return (
    <div role="alert" class="rounded-lg border border-[color-mix(in_srgb,var(--color-status-failed)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-status-failed)_8%,transparent)] px-3.5 py-2.5 text-[12.5px] text-[var(--color-status-failed)]">
      {children}
    </div>
  );
}

// ── Time helpers ────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

/** unix seconds → value for <input type="datetime-local"> in the browser timezone. */
export function toLocalInput(sec: number | null | undefined): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function fmtClock(sec: number | null | undefined): string {
  if (!sec) return '–';
  const d = new Date(sec * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const WEEKDAYS_LONG = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
export function fmtDayLong(sec: number): string {
  const d = new Date(sec * 1000);
  return `${WEEKDAYS_LONG[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
