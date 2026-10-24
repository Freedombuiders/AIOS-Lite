import { Fragment } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { ArrowDown, ArrowUp, Download, ExternalLink, Search } from 'lucide-preact';
import { useFetch } from '@/lib/useFetch';
import { Toggle } from '@/components/Toggle';
import { fmtDec, fmtInt, fmtMoney, fmtPct, type AdsCampaignsDto } from '@modules/ads/web/lib/fbstudio';
import { Card } from '../common';
import { BAD, GOOD, WARN, finite } from '@/components/fb/charts/chart-utils';
import { BTN, DashError, DashLoading, LINK_CLASS, SELECT } from '@modules/ads/web/components/fb/DashStates';
import { ACTION_META, RESULT_META, adsManagerCampaignUrl, downloadCsv, statusLabel } from './adsMeta';

type Row = AdsCampaignsDto['campaigns'][number];
type SortKey = 'name' | 'spend' | 'today' | 'results' | 'cpa' | 'ctr' | 'cpm' | 'freq' | 'budget';

const value: Record<SortKey, (c: Row) => number | string> = {
  name: (c) => c.name.toLowerCase(),
  spend: (c) => c.spend,
  today: (c) => c.spendToday,
  results: (c) => c.results,
  cpa: (c) => c.cpa ?? Infinity,
  ctr: (c) => c.ctr ?? -Infinity,
  cpm: (c) => c.cpm ?? Infinity,
  freq: (c) => c.frequency ?? -Infinity,
  budget: (c) => c.dailyBudget ?? -Infinity,
};

const needsAction = (c: Row) => Boolean(c.recommendation && c.recommendation.action !== 'keep' && c.recommendation.action !== 'watch');
const isRunning = (c: Row) => c.status.toUpperCase() === 'ACTIVE' || c.status.toUpperCase() === 'LEARNING';

/** Every campaign of the tracked accounts in one sortable, filterable table. */
export function CampaignsAcrossAccounts({ days, onOpenAccount }: { days: number; onOpenAccount: (id: string) => void }) {
  const res = useFetch<AdsCampaignsDto>(`/api/m/ads/campaigns?days=${days}`);
  const [q, setQ] = useState('');
  const [acc, setAcc] = useState('');
  const [onlyRunning, setOnlyRunning] = useState(true);
  const [onlyAction, setOnlyAction] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'spend', dir: -1 });
  const [openReason, setOpenReason] = useState<string | null>(null);
  const dto = res.data;

  const all = dto?.campaigns ?? [];
  const withSpend = all.filter((c) => c.spend > 0 || isRunning(c));
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const f = value[sort.key];
    return withSpend
      .filter((c) => (!onlyRunning || isRunning(c) || c.spendToday > 0)
        && (!onlyAction || needsAction(c))
        && (!acc || c.accountId === acc)
        && (!needle || c.name.toLowerCase().includes(needle) || c.accountName.toLowerCase().includes(needle)))
      .sort((x, y) => { const a = f(x); const b = f(y); return (a < b ? -1 : a > b ? 1 : 0) * sort.dir || y.spend - x.spend; });
  }, [dto, q, acc, onlyRunning, onlyAction, sort]);

  if (res.loading && !dto) return <Card title="Chiến dịch trên mọi tài khoản"><DashLoading /></Card>;
  if (res.error && !dto) return <Card title="Chiến dịch trên mọi tài khoản"><DashError error={res.error} onRetry={res.refresh} /></Card>;
  if (!dto) return null;

  const accounts = [...new Map(all.map((c) => [c.accountId, c.accountName])).entries()];
  const actionCount = withSpend.filter(needsAction).length;
  const runningCount = withSpend.filter(isRunning).length;

  const th = (key: SortKey, label: string, align: 'left' | 'right' = 'right') => {
    const on = sort.key === key;
    return (
      <th scope="col" class={`px-2.5 py-2 font-medium text-[12px] whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`} aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
        <button
          type="button"
          class={`bg-transparent border-0 p-0 cursor-pointer inline-flex items-center gap-1 ${on ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}
          onClick={() => setSort(on ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: key === 'name' || key === 'cpa' || key === 'cpm' ? 1 : -1 })}
        >
          {label}{on && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
        </button>
      </th>
    );
  };

  function exportCsv() {
    const head = ['Tài khoản', 'Chiến dịch', 'Trạng thái', 'Ngân sách/ngày', `Chi ${days} ngày`, 'Chi hôm nay', 'Kết quả', 'Loại kết quả', 'Giá/kết quả', 'Mục tiêu', 'CTR link %', 'CPM', 'Tần suất', 'Đề xuất', 'Lý do'];
    downloadCsv(`chien-dich-${days}-ngay.csv`, [head, ...rows.map((c) => [
      c.accountName, c.name, statusLabel(c.status).text, c.dailyBudget, c.spend, c.spendToday, c.results, RESULT_META[c.resultType].noun,
      c.cpa, c.targetCpa, c.ctr, c.cpm, c.frequency, c.recommendation ? ACTION_META[c.recommendation.action].label : '', c.recommendation?.reason ?? '',
    ])]);
  }

  return (
    <Card
      title={`Chiến dịch trên mọi tài khoản · ${days} ngày`}
      aside={<span>{runningCount} đang chạy · {actionCount} cần xử lý{dto.staleAccounts.length ? ` · ${dto.staleAccounts.length} tài khoản chưa cập nhật trong 2 giờ` : ''}</span>}
    >
      {all.length === 0 ? (
        <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Chưa có chiến dịch nào. Bật “Theo dõi sâu” cho tài khoản ở bảng bên dưới để kéo số liệu tới cấp chiến dịch.</p>
      ) : (
        <>
          <div class="flex flex-wrap items-center gap-2">
            <label class="relative flex-[1_1_220px] max-w-[300px]">
              <span class="sr-only">Tìm chiến dịch</span>
              <Search size={13} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" aria-hidden="true" />
              <input class={`${SELECT} w-full pl-8`} placeholder="Tìm chiến dịch, tài khoản…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
            </label>
            {accounts.length > 1 && (
              <select class={SELECT} value={acc} onChange={(e) => setAcc((e.target as HTMLSelectElement).value)} aria-label="Lọc theo tài khoản">
                <option value="">Mọi tài khoản</option>
                {accounts.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            )}
            <label class="inline-flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">
              <Toggle on={onlyRunning} onChange={() => setOnlyRunning((v) => !v)} ariaLabel="Chỉ chiến dịch đang chạy" size="sm" /> Đang chạy
            </label>
            <label class="inline-flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">
              <Toggle on={onlyAction} onChange={() => setOnlyAction((v) => !v)} ariaLabel="Chỉ chiến dịch cần xử lý" size="sm" /> Cần xử lý
            </label>
            <button type="button" class={`${BTN} inline-flex items-center gap-1.5 ml-auto`} onClick={exportCsv} disabled={!rows.length}>
              <Download size={13} /> Xuất CSV
            </button>
          </div>

          <div class="overflow-x-auto -mx-4 px-4">
            <table class="w-full border-collapse text-[13px] min-w-[1180px]">
              <thead>
                <tr class="border-b border-[var(--color-border)]">
                  {th('name', 'Chiến dịch', 'left')}
                  <th scope="col" class="px-2.5 py-2 font-medium text-[12px] text-left text-[var(--color-text-muted)]">Trạng thái</th>
                  {th('budget', 'Ngân sách/ngày')}
                  {th('spend', `Chi ${days} ngày`)}
                  {th('today', 'Hôm nay')}
                  {th('results', 'Kết quả')}
                  {th('cpa', 'Giá/kết quả')}
                  {th('ctr', 'CTR')}
                  {th('cpm', 'CPM')}
                  {th('freq', 'Tần suất')}
                  <th scope="col" class="px-2.5 py-2 font-medium text-[12px] text-left text-[var(--color-text-muted)]">Đề xuất</th>
                  <th scope="col" class="px-2.5 py-2"><span class="sr-only">Mở</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={12} class="px-2.5 py-6 text-center text-[var(--color-text-muted)]">Không có chiến dịch nào khớp bộ lọc.</td></tr>}
                {rows.map((c) => {
                  const r = RESULT_META[c.resultType];
                  const st = statusLabel(c.status);
                  const ratio = finite(c.targetCpa) && finite(c.cpa) && c.targetCpa > 0 ? c.cpa / c.targetCpa : null;
                  const rec = c.recommendation && (finite(c.targetCpa) || c.recommendation.action !== 'keep') ? c.recommendation : null;
                  const m = rec ? ACTION_META[rec.action] : null;
                  const key = `${c.accountId}:${c.id}`;
                  return (
                    <Fragment key={key}>
                      <tr class="border-b border-[var(--color-border)] hover:bg-[var(--color-elevated)]/40">
                        <td class="px-2.5 py-2.5 max-w-[320px]">
                          <div class="font-semibold text-[var(--color-text)] truncate" title={c.name}>{c.name}</div>
                          <div class="text-[11.5px] text-[var(--color-text-muted)] truncate">
                            <button type="button" class="bg-transparent border-0 p-0 cursor-pointer text-inherit hover:underline" onClick={() => onOpenAccount(c.accountId)} title="Mở chi tiết tài khoản">{c.accountName}</button>
                            {' · '}{c.adsets} nhóm
                          </div>
                        </td>
                        <td class="px-2.5 py-2.5 text-[12px] whitespace-nowrap" style={{ color: st.warn ? WARN : 'var(--color-text-muted)' }}>{st.text}</td>
                        <td class="px-2.5 py-2.5 text-right tabular-nums whitespace-nowrap text-[var(--color-text-muted)]">{finite(c.dailyBudget) ? fmtMoney(c.dailyBudget, c.currency) : 'Nhóm'}</td>
                        <td class="px-2.5 py-2.5 text-right tabular-nums whitespace-nowrap font-semibold text-[var(--color-text)]">{fmtMoney(c.spend, c.currency)}</td>
                        <td class="px-2.5 py-2.5 text-right tabular-nums whitespace-nowrap text-[var(--color-text-muted)]">{c.spendToday > 0 ? fmtMoney(c.spendToday, c.currency) : '–'}</td>
                        <td class="px-2.5 py-2.5 text-right tabular-nums whitespace-nowrap">
                          <div class="text-[var(--color-text)]">{fmtInt(c.results)}</div>
                          <div class="text-[11px] text-[var(--color-text-muted)]">{r.noun}</div>
                        </td>
                        <td class="px-2.5 py-2.5 text-right tabular-nums whitespace-nowrap">
                          <div class="font-semibold" style={{ color: ratio === null ? 'var(--color-text)' : ratio <= 1 ? GOOD : BAD }}>{finite(c.cpa) ? fmtMoney(c.cpa, c.currency) : c.spend > 0 ? '0 KQ' : '–'}</div>
                          {ratio !== null && <div class="text-[11px] text-[var(--color-text-muted)]">×{fmtDec(ratio, 2)} mục tiêu</div>}
                        </td>
                        <td class="px-2.5 py-2.5 text-right tabular-nums whitespace-nowrap">{fmtPct(c.ctr, 2)}</td>
                        <td class="px-2.5 py-2.5 text-right tabular-nums whitespace-nowrap">{finite(c.cpm) ? fmtMoney(c.cpm, c.currency) : '–'}</td>
                        <td class="px-2.5 py-2.5 text-right tabular-nums whitespace-nowrap" style={{ color: finite(c.frequency) && c.frequency > 3 ? WARN : undefined }}>{finite(c.frequency) ? fmtDec(c.frequency, 1) : '–'}</td>
                        <td class="px-2.5 py-2.5">
                          {m && rec ? (
                            <button
                              type="button"
                              aria-expanded={openReason === key}
                              onClick={() => setOpenReason(openReason === key ? null : key)}
                              class="inline-flex items-center h-[22px] px-2.5 rounded-full border-0 text-[12px] font-semibold whitespace-nowrap"
                              style={{ background: m.bg, color: m.fg }}
                              title={rec.reason}
                            >
                              {m.label}
                            </button>
                          ) : !finite(c.targetCpa) ? <span class="text-[11.5px] text-[var(--color-text-faint)] whitespace-nowrap">Chưa có mục tiêu</span> : <span class="text-[var(--color-text-faint)]">–</span>}
                        </td>
                        <td class="px-2.5 py-2.5 text-right">
                          <a class="inline-flex items-center text-[var(--color-text-muted)] hover:text-[var(--color-text)]" href={adsManagerCampaignUrl(c.accountId, c.id)} target="_blank" rel="noopener noreferrer" aria-label={`Mở ${c.name} trong Ads Manager`} title="Mở trong Ads Manager"><ExternalLink size={13} /></a>
                        </td>
                      </tr>
                      {openReason === key && rec && m && (
                        <tr class="border-b border-[var(--color-border)]">
                          <td colSpan={12} class="px-4 py-2 text-[12.5px] text-[var(--color-text-muted)] bg-[var(--color-bg)]">
                            <span class="font-semibold" style={{ color: m.fg }}>{m.label}:</span> {rec.reason}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p class="m-0 text-[12px] text-[var(--color-text-muted)]">
            Chỉ gồm tài khoản đang “Theo dõi sâu”, số liệu {days} ngày gần nhất (gồm hôm nay), cập nhật mỗi giờ. Giá xanh/đỏ so với mục tiêu của tài khoản; chưa đặt mục tiêu thì chưa có đề xuất.
            {' '}<a class={LINK_CLASS} href="https://adsmanager.facebook.com/" target="_blank" rel="noopener noreferrer">Mở Ads Manager</a> để thực hiện thay đổi.
          </p>
        </>
      )}
    </Card>
  );
}
