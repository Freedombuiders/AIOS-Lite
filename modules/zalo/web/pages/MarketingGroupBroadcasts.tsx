import { useState } from 'preact/hooks';
import { ArrowLeft, Plus } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { CampaignTabs } from '../components/CampaignTabs';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { ZaloServiceBanner } from '../components/ZaloServiceBanner';
import { GroupBroadcastDetail } from '../components/marketing/GroupBroadcastDetail';
import { GroupBroadcastEditor } from '../components/marketing/GroupBroadcastEditor';
import {
  BROADCAST_STATE_LABEL, BROADCAST_STATE_TONE, describeSchedule, reasonLabel, RUN_STATE_LABEL, RUN_STATE_TONE,
  type Broadcast,
} from '../components/marketing/GroupBroadcastModel';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { formatFullTime, type ZaloAccount, type ZaloServiceStatus } from '../lib/zalo';

const BTN = 'toolbar-control control-button inline-flex items-center gap-1.5 px-3 rounded-md text-[13px] text-[var(--color-text)] hover:bg-[var(--color-control-hover)] disabled:opacity-40';

const sec = (s: number | null): string => (s ? formatFullTime(s * 1000) : '—');

export function MarketingGroupBroadcasts() {
  const status = useFetch<ZaloServiceStatus>('/api/m/zalo/status', 15_000);
  const accounts = useFetch<{ accounts: ZaloAccount[] }>('/api/m/zalo/accounts', 30_000);
  const list = useFetch<{ broadcasts: Broadcast[] }>('/api/m/zalo/group-broadcasts', 10_000);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editing, setEditing] = useState<Broadcast | 'new' | null>(null);

  const accountList = accounts.data?.accounts ?? [];
  const broadcasts = list.data?.broadcasts ?? [];

  function refreshAll() {
    invalidateFetchCache('/api/m/zalo/group-broadcasts');
    list.refresh();
  }

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        compact
        title="Gửi nhóm theo lịch"
        actions={selectedId === null ? (
          <button type="button" class={BTN} disabled={accountList.length === 0} onClick={() => setEditing('new')}>
            <Plus size={13} /> Tạo lịch gửi
          </button>
        ) : (
          <button type="button" class={BTN} onClick={() => { setSelectedId(null); refreshAll(); }}>
            <ArrowLeft size={13} /> Danh sách
          </button>
        )}
      />
      <CampaignTabs current="group" />
      <ZaloServiceBanner status={status.data} onChange={status.refresh} />

      {selectedId !== null ? (
        <GroupBroadcastDetail
          id={selectedId}
          onBack={() => setSelectedId(null)}
          onEdit={(b) => setEditing(b)}
          onChanged={refreshAll}
        />
      ) : (
        <div class="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-4">
          <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3 text-[13px] leading-relaxed text-[var(--color-text-muted)] w-full min-w-0">
            Tự động gửi một mẫu tin vào nhiều nhóm Zalo theo giờ đã hẹn. Nick gửi lần lượt từng nhóm, giãn cách ngẫu nhiên giữa các nhóm,
            không gửi trong giờ yên tĩnh và luôn nằm trong ngân sách gửi hằng ngày để nick không bị Zalo khoá.
          </div>

          {list.loading && broadcasts.length === 0 && <PageState loading />}
          {list.error && broadcasts.length === 0 && <PageState error={list.error} />}
          {!list.loading && !list.error && broadcasts.length === 0 && (
            <PageState
              empty
              emptyTitle="Chưa có lịch gửi nào"
              emptyDescription={accountList.length === 0
                ? 'Thêm và đăng nhập nick ở Zalo · Tài khoản trước, rồi quay lại tạo lịch gửi.'
                : 'Bấm “Tạo lịch gửi” để hẹn giờ gửi một mẫu tin vào các nhóm.'}
            />
          )}

          {broadcasts.length > 0 && (
            <div class="rounded-lg border border-[var(--color-border)] overflow-x-auto w-full min-w-0">
              <table class="w-full text-[13px] min-w-[720px]">
                <thead>
                  <tr class="bg-[var(--color-card)] text-left text-[12px] text-[var(--color-text-faint)]">
                    <th class="px-3 py-2 font-medium">Tên</th>
                    <th class="px-3 py-2 font-medium">Nick</th>
                    <th class="px-3 py-2 font-medium">Trạng thái</th>
                    <th class="px-3 py-2 font-medium">Lượt kế tiếp</th>
                    <th class="px-3 py-2 font-medium">Lượt gần nhất</th>
                  </tr>
                </thead>
                <tbody>
                  {broadcasts.map((b) => (
                    <tr
                      key={b.id}
                      class="border-t border-[var(--color-border)] align-top cursor-pointer hover:bg-[var(--color-card)]"
                      onClick={() => setSelectedId(b.id)}
                    >
                      <td class="px-3 py-2.5">
                        <button type="button" class="text-left text-[var(--color-text)] font-medium hover:underline" onClick={() => setSelectedId(b.id)}>
                          {b.name}
                        </button>
                        <div class="text-[12px] text-[var(--color-text-faint)]">
                          {describeSchedule(b)} · {b.targetThreadIds.length} nhóm
                        </div>
                      </td>
                      <td class="px-3 py-2.5 text-[var(--color-text-muted)]">{b.accountName || b.accountId}</td>
                      <td class="px-3 py-2.5">
                        <Pill tone={BROADCAST_STATE_TONE[b.state]}>{BROADCAST_STATE_LABEL[b.state]}</Pill>
                        {b.state === 'paused' && b.pausedReason === 'CONSECUTIVE_FAILURES' && (
                          <div class="mt-0.5 text-[10.5px] text-[var(--color-status-failed)]">Tự tạm dừng do lỗi</div>
                        )}
                      </td>
                      <td class="px-3 py-2.5 whitespace-nowrap text-[var(--color-text-muted)]">{b.state === 'active' ? sec(b.nextRunAt) : '—'}</td>
                      <td class="px-3 py-2.5">
                        {b.lastRun ? (
                          <>
                            <div class="flex items-center gap-1.5">
                              <Pill tone={RUN_STATE_TONE[b.lastRun.state]}>{RUN_STATE_LABEL[b.lastRun.state]}</Pill>
                              <span class="tabular-nums text-[var(--color-text-muted)]">
                                {b.lastRun.sentCount}/{b.lastRun.totalTargets} nhóm
                                {b.lastRun.failedCount > 0 && ` · ${b.lastRun.failedCount} lỗi`}
                              </span>
                            </div>
                            <div class="text-[12px] text-[var(--color-text-faint)]">
                              {sec(b.lastRun.scheduledFor)}{b.lastRun.skipReason ? ` · ${reasonLabel(b.lastRun.skipReason)}` : ''}
                            </div>
                          </>
                        ) : (
                          <span class="text-[var(--color-text-faint)]">Chưa gửi lần nào</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {editing !== null && (
        <GroupBroadcastEditor
          initial={editing === 'new' ? null : editing}
          accounts={accountList}
          onClose={() => setEditing(null)}
          onSaved={(b) => {
            setEditing(null);
            refreshAll();
            setSelectedId(b.id);
          }}
        />
      )}
    </div>
  );
}
