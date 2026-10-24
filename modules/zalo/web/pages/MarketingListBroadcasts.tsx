import { useState } from 'preact/hooks';
import { Plus } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { CampaignTabs } from '../components/CampaignTabs';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { ZaloServiceBanner } from '../components/ZaloServiceBanner';
import { ListBroadcastDetail } from '../components/marketing/ListBroadcastDetail';
import { ListBroadcastEditor } from '../components/marketing/ListBroadcastEditor';
import {
  BTN, STATE_LABEL, STATE_TONE, type ListBroadcast,
} from '../components/marketing/ListBroadcastTypes';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import type { ZaloAccount, ZaloServiceStatus } from '../lib/zalo';

type View =
  | { kind: 'list' }
  | { kind: 'edit'; id?: number }
  | { kind: 'detail'; id: number };

export function MarketingListBroadcasts() {
  const status = useFetch<ZaloServiceStatus>('/api/m/zalo/status', 15_000);
  const accounts = useFetch<{ accounts: ZaloAccount[] }>('/api/m/zalo/accounts', 60_000);
  const list = useFetch<{ broadcasts: ListBroadcast[] }>('/api/m/zalo/list-broadcasts', 10_000);
  const [view, setView] = useState<View>({ kind: 'list' });

  const accountMap = new Map((accounts.data?.accounts ?? []).map((a) => [a.id, a.displayName || a.label]));
  const accountLabel = (id: string) => accountMap.get(id) ?? id;
  const broadcasts = list.data?.broadcasts ?? [];

  function show(next: View) {
    invalidateFetchCache('/api/m/zalo/list-broadcasts');
    list.refresh();
    setView(next);
  }

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        compact
        title="Gửi 1-1 theo danh sách"
        actions={view.kind === 'list' ? (
          <button type="button" class={BTN} onClick={() => setView({ kind: 'edit' })}>
            <Plus size={13} /> Tạo chiến dịch
          </button>
        ) : undefined}
      />
      <CampaignTabs current="list" />
      <ZaloServiceBanner status={status.data} onChange={status.refresh} />

      {view.kind === 'edit' && (
        <ListBroadcastEditor
          editId={view.id}
          onCancel={() => show(view.id ? { kind: 'detail', id: view.id } : { kind: 'list' })}
          onDone={(id) => show({ kind: 'detail', id })}
        />
      )}

      {view.kind === 'detail' && (
        <ListBroadcastDetail
          id={view.id}
          accountLabel={accountLabel}
          onBack={() => show({ kind: 'list' })}
          onEdit={() => setView({ kind: 'edit', id: view.id })}
          onDeleted={() => show({ kind: 'list' })}
        />
      )}

      {view.kind === 'list' && (
        <div class="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-4">
          <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3 text-[13px] leading-relaxed text-[var(--color-text-muted)] w-full min-w-0">
            Gửi một mẫu tin tới từng khách <b>đã nhắn tin 1-1 với nick</b>, rải đều trong khung giờ bạn chọn, từng người một với giãn cách ngẫu nhiên để nick an toàn.
            Không nhập số điện thoại và không nhắn người lạ. Khách đã từ chối nhận tin được loại tự động.
          </div>

          {list.loading && broadcasts.length === 0 && <PageState loading />}
          {list.error && <PageState error={list.error} />}
          {!list.loading && !list.error && broadcasts.length === 0 && (
            <PageState empty emptyTitle="Chưa có chiến dịch nào" emptyDescription="Bấm “Tạo chiến dịch” để gửi tin tới khách cũ của nick." />
          )}

          {broadcasts.length > 0 && (
            <div class="w-full min-w-0 rounded-lg border border-[var(--color-border)] overflow-x-auto">
              <table class="w-full text-[13px]">
                <thead>
                  <tr class="text-left text-[12px] text-[var(--color-text-faint)] border-b border-[var(--color-border)]">
                    <th class="px-3 py-2 font-medium">Chiến dịch</th>
                    <th class="px-3 py-2 font-medium">Nick</th>
                    <th class="px-3 py-2 font-medium">Trạng thái</th>
                    <th class="px-3 py-2 font-medium">Tiến độ</th>
                    <th class="px-3 py-2 font-medium text-right">Hôm nay</th>
                  </tr>
                </thead>
                <tbody>
                  {broadcasts.map((b) => {
                    const done = b.counts.sent + b.counts.failed + b.counts.skipped;
                    const pct = b.counts.total > 0 ? Math.round((done / b.counts.total) * 100) : 0;
                    return (
                      <tr
                        key={b.id}
                        class="border-b last:border-b-0 border-[var(--color-border)] hover:bg-[var(--color-control-hover)] cursor-pointer"
                        onClick={() => setView({ kind: 'detail', id: b.id })}
                      >
                        <td class="px-3 py-2.5 text-[var(--color-text)] font-medium">{b.name}</td>
                        <td class="px-3 py-2.5 text-[var(--color-text-muted)]">{b.accounts.map((a) => a.label).join(', ')}</td>
                        <td class="px-3 py-2.5"><Pill tone={STATE_TONE[b.state]}>{STATE_LABEL[b.state]}</Pill></td>
                        <td class="px-3 py-2.5 min-w-[160px]">
                          <div class="flex items-center gap-2">
                            <div class="h-1.5 w-24 rounded-full bg-[var(--color-elevated)] overflow-hidden">
                              <div class="h-full" style={{ width: `${pct}%`, background: 'var(--color-status-done)' }} />
                            </div>
                            <span class="tabular-nums text-[var(--color-text-muted)]">{b.counts.sent}/{b.counts.total}</span>
                          </div>
                        </td>
                        <td class="px-3 py-2.5 text-right tabular-nums text-[var(--color-text-muted)]">{b.sentToday}/{b.dailyQuota}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
