// Facebook operational settings; credentials live in Integrations.
// hourly API budget. Talks to GET/PUT /api/m/marketing/settings.

import { useEffect, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { Toggle } from '@/components/Toggle';
import { apiPut } from '@/lib/api';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import { fmtInt, type FbSettingsDto, type FbSettingsUpdate, type FbStatusDto } from '@modules/marketing/web/lib/fbstudio';
import { apiFail, BTN, ConnDot, INPUT } from '@modules/marketing/web/components/fb/ops-shared';

export function FbSettingsPanel() {
  const settings = useFetch<FbSettingsDto>('/api/m/marketing/settings');
  const status = useFetch<FbStatusDto>('/api/m/marketing/status', 60_000);
  const s = settings.data;

  const [budget, setBudget] = useState('');
  const [saving, setSaving] = useState<'budget' | 'enabled' | null>(null);

  useEffect(() => { if (s) setBudget(String(s.apiBudgetPerHour)); }, [s?.apiBudgetPerHour]);

  async function save(part: 'budget' | 'enabled', body: FbSettingsUpdate, okTitle: string) {
    setSaving(part);
    try {
      await apiPut<FbSettingsDto>('/api/m/marketing/settings', body);
      pushToast({ tone: 'success', title: okTitle });
      invalidateFetchCache('/api/m/marketing/');
      settings.refresh();
      status.refresh();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không lưu được', description: apiFail(err).message });
    } finally {
      setSaving(null);
    }
  }

  if (settings.loading && !s) return <div class="text-[12px] text-[var(--color-text-faint)]">Đang tải…</div>;
  if (!s) {
    return (
      <div class="text-[12px] text-[var(--color-status-failed)]">
        Không tải được cấu hình Facebook{settings.error ? `: ${settings.error}` : ''}.{' '}
        <button type="button" class="underline" onClick={settings.refresh}>Thử lại</button>
      </div>
    );
  }

  const budgetNum = Number(budget);
  const budgetValid = Number.isInteger(budgetNum) && budgetNum >= 1;
  const conn = status.data?.composio;

  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="text-[13px] text-[var(--color-text)]">Bật Facebook Content Studio</div>
          <div class="text-[11px] text-[var(--color-text-faint)] mt-0.5">
            Tắt thì Publisher và trình thu bình luận dừng; bạn vẫn soạn nội dung được.
          </div>
        </div>
        <Toggle
          on={s.enabled}
          disabled={saving === 'enabled'}
          ariaLabel="Bật Facebook Content Studio"
          onChange={() => void save('enabled', { enabled: !s.enabled }, s.enabled ? 'Đã tắt Studio' : 'Đã bật Studio')}
        />
      </div>

      <div class="border-t border-[var(--color-border)]" />

      <div class="space-y-2">
        <p class="text-sm">Composio: {s.composioKeyConfigured ? 'đã cấu hình tại Kết nối' : 'chưa kết nối'}.</p>
        <Link href="/connections" class="text-sm text-[var(--color-accent)] underline">Quản lý Composio tại Kết nối</Link>
        {conn && <div class="flex flex-wrap gap-4 text-sm"><span class="inline-flex items-center gap-2"><ConnDot status={conn.facebook} />Facebook {conn.facebook}</span></div>}
      </div>

      <div class="border-t border-[var(--color-border)]" />

      <form
        class="flex flex-col gap-2"
        onSubmit={(e) => { e.preventDefault(); if (budgetValid) void save('budget', { apiBudgetPerHour: budgetNum }, 'Đã lưu ngân sách gọi API'); }}
      >
        <label class="text-[13px] text-[var(--color-text)]" for="fb-budget">Ngân sách gọi API mỗi giờ</label>
        <div class="text-[11px] text-[var(--color-text-faint)] -mt-1">
          Số lượt gọi Composio tối đa mỗi giờ cho cả Studio. Chạm ngưỡng thì các tác vụ nền chờ giờ sau.
          {status.data && <> Giờ này đã dùng {fmtInt(status.data.apiCallsThisHour)} / {fmtInt(status.data.apiBudgetPerHour)}.</>}
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <input
            id="fb-budget"
            type="number"
            min={1}
            step={1}
            class={`${INPUT} w-28`}
            value={budget}
            onInput={(e) => setBudget((e.target as HTMLInputElement).value)}
          />
          <button type="submit" class={BTN} disabled={!budgetValid || budgetNum === s.apiBudgetPerHour || saving === 'budget'}>
            {saving === 'budget' ? 'Đang lưu…' : 'Lưu'}
          </button>
        </div>
      </form>

      <div class="text-[11.5px] text-[var(--color-text-faint)] break-all">
        Thư mục media: <code class="font-mono">{s.mediaDir}</code>
      </div>
    </div>
  );
}
