import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { SetupNotice } from './common';
import { BAD } from '@/components/fb/charts/chart-utils';
import { apiPost } from '@/lib/api';
import { errorMessage } from '@/lib/marketing';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';
import type { FbPageDto, FbSettingsDto } from '@modules/marketing/web/lib/fbstudio';

export const LINK_CLASS = 'text-[var(--color-accent-hover)] underline underline-offset-2 hover:text-[var(--color-text)]';
export const BTN = 'h-8 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-card)] text-[12.5px] text-[var(--color-text)] hover:bg-[var(--color-elevated)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors';
export const BTN_PRIMARY = 'h-8 px-3 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[12.5px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-control-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors';
export const SELECT = 'h-8 px-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] text-[12.5px] text-[var(--color-text)]';

export function DashLoading({ label = 'Đang tải số liệu…' }: { label?: string }) {
  return (
    <div class="flex items-center justify-center py-16 text-[12.5px] text-[var(--color-text-muted)]" role="status">
      {label}
    </div>
  );
}

/** Turn a raw `GET … failed: 503` message into a sentence with a next step. */
export function explainError(error: string): string {
  if (/\b503\b/.test(error)) return 'Composio chưa được cấu hình hoặc Facebook Studio đang tắt. Kiểm tra lại trong Cài đặt.';
  if (/\b404\b/.test(error)) return 'Máy chủ chưa có API này. Khởi động lại AIOS-Lite để nạp bản mới.';
  if (/\b(401|403)\b/.test(error)) return 'Phiên đăng nhập dashboard đã hết hạn. Mở lại dashboard từ liên kết mới.';
  return 'Không tải được dữ liệu. Thử lại sau ít phút.';
}

export function DashError({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div class="rounded-lg border px-4 py-3 w-full min-w-0 flex flex-col gap-2" style={{ borderColor: 'color-mix(in srgb, #ef4444 40%, transparent)', background: 'color-mix(in srgb, #ef4444 8%, transparent)' }} role="alert">
      <div class="text-[13px] font-semibold" style={{ color: BAD }}>{explainError(error)}</div>
      <div class="text-[12px] text-[var(--color-text-muted)] font-mono break-all">{error}</div>
      {onRetry && <div><button type="button" class={BTN} onClick={onRetry}>Thử lại</button></div>}
    </div>
  );
}

const STORE_KEY = 'aios.fb.dashPage';

function readStored(): string | null {
  try { return sessionStorage.getItem(STORE_KEY); } catch { return null; }
}

export interface DashGate {
  /** When set, render this instead of the dashboard. */
  blocker: ComponentChildren | null;
  pages: FbPageDto[];
  pageId: string | null;
  setPageId: (id: string) => void;
}

/** Studio-level preconditions: settings loaded, Composio key present, studio enabled. */
export function useStudioGate(): { blocker: ComponentChildren | null } {
  const settings = useFetch<FbSettingsDto>('/api/m/marketing/settings');
  let blocker: ComponentChildren | null = null;
  if (settings.loading && !settings.data) blocker = <DashLoading />;
  else if (settings.error && !settings.data) blocker = <DashError error={settings.error} onRetry={settings.refresh} />;
  else if (settings.data && !settings.data.composioKeyConfigured) {
    blocker = (
      <SetupNotice title="Chưa nối Composio">
        Facebook Studio lấy số liệu qua Composio. Dán Composio API key tại <Link href="/connections" class={LINK_CLASS}>Kết nối → Composio</Link>, rồi quay lại trang này.
      </SetupNotice>
    );
  } else if (settings.data && !settings.data.enabled) {
    blocker = (
      <SetupNotice title="Facebook Studio đang tắt">
        Bật công tắc Facebook Studio trong <Link href="/modules" class={LINK_CLASS}>Cài đặt</Link> để bắt đầu lấy số liệu.
      </SetupNotice>
    );
  }
  return { blocker };
}

/**
 * Shared preconditions for the Facebook analytics dashboards: studio gate plus
 * at least one enabled Page, and the one-Page-at-a-time selection that is
 * remembered across the dashboards.
 */
export function useFbDashGate(): DashGate {
  const studio = useStudioGate();
  const pagesRes = useFetch<{ pages: FbPageDto[] }>('/api/m/marketing/pages');
  const [picked, setPicked] = useState<string | null>(readStored);

  const pages = (pagesRes.data?.pages ?? []).filter((p) => p.enabled);
  const pageId = picked && pages.some((p) => p.id === picked) ? picked : pages[0]?.id ?? null;
  const setPageId = (id: string) => {
    setPicked(id);
    try { sessionStorage.setItem(STORE_KEY, id); } catch { /* private mode */ }
  };

  let blocker: ComponentChildren | null = studio.blocker;
  if (!blocker) {
    if (pagesRes.loading && !pagesRes.data) blocker = <DashLoading />;
    else if (pagesRes.error && !pagesRes.data) blocker = <DashError error={pagesRes.error} onRetry={pagesRes.refresh} />;
    else if (pages.length === 0) {
      blocker = (
        <SetupNotice title="Chưa bật Page nào">
          Vào <Link href="/m/marketing" class={LINK_CLASS}>Cài đặt Page</Link>, bấm Đồng bộ rồi bật Page cần theo dõi. Số liệu sẽ có sau lần lấy dữ liệu đầu tiên.
        </SetupNotice>
      );
    }
  }
  return { blocker, pages, pageId, setPageId };
}

/** POST /api/m/marketing/analytics/refresh for one Page (server rate-limits to once per 10 minutes). */
export function useAnalyticsRefresh(pageId: string | null, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  async function run() {
    if (!pageId) return;
    setBusy(true);
    try {
      await apiPost('/api/m/marketing/analytics/refresh', { pageId });
      pushToast({ tone: 'success', title: 'Đã yêu cầu lấy số liệu mới', description: 'Có thể mất vài phút. Số liệu sẽ tự hiện khi xong.' });
      setTimeout(onDone, 4000);
    } catch (err) {
      pushToast({ tone: 'error', title: 'Chưa lấy được số liệu', description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }
  return { busy, run };
}
