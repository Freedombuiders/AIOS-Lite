import { useState } from 'preact/hooks';
import { CalendarPlus } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { CampaignTabs } from '../components/CampaignTabs';
import { PageState } from '@/components/PageState';
import { ZaloServiceBanner } from '../components/ZaloServiceBanner';
import { BirthdayBirthDateDialog } from '../components/marketing/BirthdayBirthDateDialog';
import { BirthdayHistory } from '../components/marketing/BirthdayHistory';
import { BirthdaySettings } from '../components/marketing/BirthdaySettings';
import { BirthdayUpcoming } from '../components/marketing/BirthdayUpcoming';
import {
  BTN, type BirthdayConfigResponse, type BirthdayStats, type UpcomingBirthday,
} from '../components/marketing/BirthdayShared';
import { useFetch } from '@/lib/useFetch';
import type { ZaloAccount, ZaloServiceStatus } from '../lib/zalo';

function Coverage({ stats }: { stats: BirthdayStats }) {
  const pct = stats.threads > 0 ? Math.round((stats.withBirthDate / stats.threads) * 100) : 0;
  return (
    <section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3 w-full min-w-0">
      <div class="flex items-baseline gap-2">
        <span class="text-[18px] font-semibold text-[var(--color-text)] tabular-nums">{stats.withBirthDate}/{stats.threads}</span>
        <span class="text-[13px] text-[var(--color-text-muted)]">khách đã có ngày sinh</span>
        <span class="ml-auto text-[11.5px] text-[var(--color-text-faint)] tabular-nums">{pct}%</span>
      </div>
      <div class="h-1.5 rounded-full bg-[var(--color-elevated)] mt-2 overflow-hidden">
        <div class="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${pct}%` }} />
      </div>
      {stats.nicks.length > 1 && (
        <div class="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11.5px] text-[var(--color-text-muted)]">
          {stats.nicks.map((n) => (
            <span key={n.accountId}>{n.label}: <b class="text-[var(--color-text)] tabular-nums">{n.withBirthDate}/{n.threads}</b></span>
          ))}
        </div>
      )}
      <p class="text-[12px] text-[var(--color-text-faint)] mt-2">
        Hệ thống tự đọc ngày sinh từ hồ sơ Zalo của khách (mỗi nick tối đa 100 lượt tra/ngày, rải chậm để an toàn). Khách ẩn ngày sinh thì nhập tay bằng “Đặt ngày sinh”.
      </p>
    </section>
  );
}

export function MarketingBirthday() {
  const status = useFetch<ZaloServiceStatus>('/api/m/zalo/status', 15_000);
  const accounts = useFetch<{ accounts: ZaloAccount[] }>('/api/m/zalo/accounts', 60_000);
  const config = useFetch<BirthdayConfigResponse>('/api/m/zalo/birthday/config');
  const stats = useFetch<BirthdayStats>('/api/m/zalo/birthday/stats', 60_000);
  const upcoming = useFetch<{ upcoming: UpcomingBirthday[] }>('/api/m/zalo/birthday/upcoming?days=14', 60_000);
  const [dialog, setDialog] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  function refreshAll() {
    config.refresh();
    stats.refresh();
    upcoming.refresh();
    setRefreshKey((k) => k + 1);
  }

  const accountList = accounts.data?.accounts ?? [];

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        compact
        title="Chúc mừng sinh nhật"
        actions={
          <button type="button" class={BTN} onClick={() => setDialog(true)}>
            <CalendarPlus size={13} /> Đặt ngày sinh
          </button>
        }
      />
      <CampaignTabs current="birthday" />
      <ZaloServiceBanner status={status.data} onChange={status.refresh} />

      <div class="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-6">
        <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3 text-[13px] leading-relaxed text-[var(--color-text-muted)] w-full min-w-0">
          Tự động nhắn lời chúc đúng ngày sinh nhật của khách (có thể thêm tin báo trước và tin nhắc lại sau). Mỗi lời chúc gửi từ chính nick
          đang chat 1-1 với khách, theo mẫu tin bạn chọn, cách nhau ngẫu nhiên vài chục giây. Khách đã từ chối nhận tin không được gửi.
        </div>

        {config.loading && !config.data && <PageState loading />}
        {config.error && !config.data && <PageState error={config.error} />}

        {stats.data && <Coverage stats={stats.data} />}

        {config.data && (
          <BirthdaySettings data={config.data} accounts={accountList} onSaved={refreshAll} />
        )}

        <section>
          <h2 class="text-[13.5px] font-semibold text-[var(--color-text)] mb-2">Sinh nhật 14 ngày tới</h2>
          {upcoming.loading && !upcoming.data && <PageState loading />}
          {upcoming.error && !upcoming.data && <PageState error={upcoming.error} />}
          {upcoming.data && (
            <BirthdayUpcoming
              items={upcoming.data.upcoming}
              enabled={config.data?.config.enabled ?? false}
              onChanged={refreshAll}
            />
          )}
        </section>

        <section>
          <h2 class="text-[13.5px] font-semibold text-[var(--color-text)] mb-2">Lịch sử</h2>
          <BirthdayHistory timezone={config.data?.config.timezone ?? 'Asia/Ho_Chi_Minh'} refreshKey={refreshKey} />
        </section>
      </div>

      <BirthdayBirthDateDialog open={dialog} onClose={() => setDialog(false)} onSaved={refreshAll} />
    </div>
  );
}
