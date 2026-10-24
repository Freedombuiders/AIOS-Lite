import { useState } from 'preact/hooks';
import { Tab } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { useFetch } from '@/lib/useFetch';
import {
  BTN, ERROR_LABEL, OCCASION_LABEL, STATE_LABEL, STATE_TONE, formatDateTime, reasonLabel, shortDate,
  type BirthdayGreeting, type GreetingState,
} from './BirthdayShared';

const PAGE = 20;
type Filter = 'all' | GreetingState;
const FILTERS: Array<[Filter, string]> = [
  ['all', 'Tất cả'], ['pending', 'Chờ gửi'], ['sent', 'Đã gửi'], ['failed', 'Lỗi'], ['skipped', 'Bỏ qua'],
];

export function BirthdayHistory({ timezone, refreshKey }: { timezone: string; refreshKey: number }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(0);
  const qs = `limit=${PAGE}&offset=${page * PAGE}${filter === 'all' ? '' : `&state=${filter}`}`;
  // refreshKey is part of the path so an action elsewhere on the page reloads this table.
  const res = useFetch<{ greetings: BirthdayGreeting[]; total: number }>(`/api/m/zalo/birthday/greetings?${qs}&_=${refreshKey}`, 30_000);
  const rows = res.data?.greetings ?? [];
  const total = res.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div class="w-full min-w-0">
      <div class="flex flex-wrap gap-1 mb-2">
        {FILTERS.map(([key, label]) => (
          <Tab key={key} label={label} active={filter === key} onClick={() => { setFilter(key); setPage(0); }} />
        ))}
      </div>
      {res.loading && rows.length === 0 && <PageState loading />}
      {res.error && <PageState error={res.error} />}
      {!res.loading && !res.error && rows.length === 0 && (
        <div class="text-[12px] text-[var(--color-text-faint)]">Chưa có lời chúc nào.</div>
      )}
      {rows.length > 0 && (
        <div class="rounded-lg border border-[var(--color-border)] overflow-x-auto">
          <table class="w-full text-[12px]">
            <thead>
              <tr class="text-left text-[11px] text-[var(--color-text-faint)] border-b border-[var(--color-border)] bg-[var(--color-card)]">
                <th class="px-3 py-2 font-medium">Giờ</th>
                <th class="px-3 py-2 font-medium">Khách</th>
                <th class="px-3 py-2 font-medium">Dịp chúc</th>
                <th class="px-3 py-2 font-medium">Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.id} class="border-b last:border-b-0 border-[var(--color-border)] align-top">
                  <td class="px-3 py-2 whitespace-nowrap text-[var(--color-text-muted)]">
                    {formatDateTime(g.state === 'sent' && g.sentAt ? g.sentAt : g.dueAt, timezone)}
                  </td>
                  <td class="px-3 py-2">
                    <span class="text-[var(--color-text)]">{g.name || 'Không tên'}</span>
                    <div class="text-[10.5px] text-[var(--color-text-faint)]">{g.accountLabel}</div>
                  </td>
                  <td class="px-3 py-2 text-[var(--color-text-muted)]">
                    {OCCASION_LABEL[g.occasion]}
                    <div class="text-[10.5px] text-[var(--color-text-faint)]">sinh nhật {shortDate(g.birthdayOn)}</div>
                  </td>
                  <td class="px-3 py-2">
                    <Pill tone={STATE_TONE[g.state]}>{STATE_LABEL[g.state]}</Pill>
                    {g.state === 'failed' && g.errorCode && (
                      <div class="text-[10.5px] text-[var(--color-status-failed)] mt-0.5">{ERROR_LABEL[g.errorCode] ?? g.errorCode}</div>
                    )}
                    {g.skipReason && g.state !== 'sent' && (
                      <div class="text-[10.5px] text-[var(--color-text-faint)] mt-0.5">{reasonLabel(g.skipReason)}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > PAGE && (
        <div class="flex items-center gap-2 mt-2 text-[11.5px] text-[var(--color-text-muted)]">
          <button type="button" class={BTN} disabled={page === 0} onClick={() => setPage(page - 1)}>Trước</button>
          <span>{page + 1} / {pages}</span>
          <button type="button" class={BTN} disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Sau</button>
        </div>
      )}
    </div>
  );
}
