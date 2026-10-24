// Shared bits for the Facebook ops screens (Kho content, Lịch đăng, Cài đặt
// Page, Bình luận AI). Dashboards live in FRONTEND-DASH files; common.tsx is
// owned by the coordinator, so everything ops-specific is here.

import type { ComponentChildren } from 'preact';
import { Link } from 'wouter-preact';
import { ApiError } from '@/lib/api';
import { useFetch } from '@/lib/useFetch';
import { SetupNotice } from '@modules/marketing/web/components/fb/common';
import type { FbPageDto, FbSettingsDto } from '@modules/marketing/web/lib/fbstudio';

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

export function useFbPages() {
  const res = useFetch<{ pages: FbPageDto[] }>('/api/m/marketing/pages');
  const pages = res.data?.pages ?? [];
  return { ...res, pages, enabledPages: pages.filter((p) => p.enabled) };
}

export function useFbSettings() {
  return useFetch<FbSettingsDto>('/api/m/marketing/settings');
}

/**
 * Non-blocking banner shown at the top of every ops screen when the studio is
 * not ready: Composio key missing or the studio switched off. Always names the
 * next step and links to where to do it.
 */
export function FbReadiness() {
  const settings = useFbSettings();
  const s = settings.data;
  if (!s) return null;
  if (!s.composioKeyConfigured) {
    return (
      <SetupNotice title="Chưa nhập Composio API key">
        Facebook Content Studio đăng bài và đọc bình luận qua Composio. Vào{' '}
        <Link href="/connections" class="text-[var(--color-accent)] underline">Kết nối › Composio</Link>{' '}
        để nhập API key dùng chung.
      </SetupNotice>
    );
  }
  if (!s.enabled) {
    return (
      <SetupNotice title="Studio đang tắt">
        Lịch đăng và trả lời bình luận chưa chạy. Bật ở{' '}
        <Link href="/modules" class="text-[var(--color-accent)] underline">Modules › Marketing Facebook</Link>.
        Bạn vẫn xem và soạn nội dung được.
      </SetupNotice>
    );
  }
  return null;
}

/** Shown when no Page is enabled yet. */
export function NoPageNotice({ hasPages }: { hasPages: boolean }) {
  return (
    <SetupNotice title={hasPages ? 'Chưa có Page nào được bật' : 'Chưa có Page nào'}>
      {hasPages ? 'Bật ít nhất một Page' : 'Đồng bộ danh sách Page từ Composio'} ở{' '}
      <Link href="/m/marketing" class="text-[var(--color-accent)] underline">FB · Cài đặt Page</Link>{' '}
      rồi quay lại đây.
    </SetupNotice>
  );
}

export function PageSelect({
  pages, value, onChange, allLabel, label = 'Page',
}: {
  pages: Pick<FbPageDto, 'id' | 'name' | 'enabled'>[];
  value: string;
  onChange: (id: string) => void;
  allLabel?: string;
  label?: string;
}) {
  return (
    <label class="flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
      {label}
      <select
        class={`${INPUT} pr-7`}
        value={value}
        onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
      >
        {allLabel && <option value="">{allLabel}</option>}
        {pages.map((p) => <option key={p.id} value={p.id}>{p.name}{p.enabled ? '' : ' (chưa bật)'}</option>)}
      </select>
    </label>
  );
}

/** Rounded filter chip with a count (aria-pressed). */
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

/**
 * Error panel for a failed fetch: 503 means Composio is not configured (next
 * step is the Settings link), anything else shows the raw message with retry.
 */
export function FetchError({ error, onRetry }: { error: string; onRetry?: () => void }) {
  const status = statusFromError(error);
  if (status === 503) {
    return (
      <SetupNotice title="Composio chưa sẵn sàng">
        Máy chủ trả về 503: chưa có Composio API key hoặc Studio đang tắt. Vào{' '}
        <Link href="/modules" class="text-[var(--color-accent)] underline">Modules › Marketing Facebook</Link>{' '}
        để bật Studio; khóa API được quản lý tại Kết nối → Composio.
      </SetupNotice>
    );
  }
  return (
    <InlineError>
      <div class="font-medium mb-0.5">Không tải được dữ liệu</div>
      <div class="font-mono text-[11.5px] opacity-80 break-all">{error}</div>
      {onRetry && <button type="button" class={`${BTN_SM} mt-2`} onClick={onRetry}>Thử lại</button>}
    </InlineError>
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
