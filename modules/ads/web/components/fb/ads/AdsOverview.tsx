import { useEffect, useMemo, useState } from 'preact/hooks';
import { AlertCircle, AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, Download, ExternalLink, RefreshCw, Search } from 'lucide-preact';
import { apiPatch, apiPost } from '@/lib/api';
import { errorMessage } from '@/lib/marketing';
import { pushToast } from '@/lib/toasts';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { Toggle } from '@/components/Toggle';
import {
  fmtDec,
  fmtInt,
  fmtMoney,
  fmtPct,
  fmtSlot,
  type AdsOverviewAccountDto,
  type AdsOverviewDto,
  type AdsResultType,
} from '@modules/ads/web/lib/fbstudio';
import { Card, KpiTile } from '../common';
import { BAD, GOOD, MUTED_MARK, SERIES, TRACK, WARN, dayLabel, deltaLabel, finite, toneColor, type Tone } from '@/components/fb/charts/chart-utils';
import { BTN, BTN_PRIMARY, DashError, DashLoading, LINK_CLASS, SELECT } from '@modules/ads/web/components/fb/DashStates';
import { Legend } from '@/components/fb/charts/Legend';
import { RowBars } from '@/components/fb/charts/RowBars';
import { Sparkline } from '@/components/fb/charts/Sparkline';
import { StackedBars, type StackSeries } from '@/components/fb/charts/StackedBars';
import { RESULT_META, adsManagerUrl, downloadCsv, moneyAxis, pctChange } from './adsMeta';
import { CampaignsAcrossAccounts } from './AdsCampaigns';

/** Categorical slots (dark steps of the validated palette), in fixed order; the rest fold into "Khác". */
const CAT = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'];
const OTHER_COLOR = MUTED_MARK;

const ACCOUNT_STATUS: Record<number, { text: string; tone: Tone }> = {
  1: { text: 'Hoạt động', tone: 'good' },
  2: { text: 'Bị vô hiệu hóa', tone: 'bad' },
  3: { text: 'Chưa thanh toán', tone: 'bad' },
  7: { text: 'Đang xét duyệt', tone: 'warn' },
  8: { text: 'Chờ thanh toán', tone: 'warn' },
  9: { text: 'Gia hạn thanh toán', tone: 'warn' },
  100: { text: 'Sắp đóng', tone: 'neutral' },
  101: { text: 'Đã đóng', tone: 'neutral' },
  201: { text: 'Hoạt động', tone: 'good' },
  202: { text: 'Đã đóng', tone: 'neutral' },
};

/** Straight-line month projection from spend so far ('YYYY-MM-DD' is today, counted as a full day). */
function projectMonth(spentSoFar: number, today: string): number {
  const [y, m, d] = today.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d > 0 ? (spentSoFar / d) * daysInMonth : spentSoFar;
}

function statusOf(a: AdsOverviewAccountDto): { text: string; tone: Tone } {
  return (a.accountStatus !== null && ACCOUNT_STATUS[a.accountStatus]) || { text: 'Không rõ', tone: 'neutral' };
}

function StatusChip({ text, tone }: { text: string; tone: Tone }) {
  return (
    <span class="inline-flex items-center gap-1.5 text-[12px] whitespace-nowrap" style={{ color: tone === 'neutral' ? 'var(--color-text-muted)' : 'var(--color-text)' }}>
      <span class="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: toneColor(tone) }} aria-hidden="true" />
      {text}
    </span>
  );
}

function Delta({ cur, prev, goodWhen, unit = 'pct' }: { cur: number | null; prev: number | null; goodWhen: 'up' | 'down' | 'none'; unit?: 'pct' | 'pt' }) {
  const d = unit === 'pt'
    ? (finite(cur) && finite(prev) ? deltaLabel(cur - prev, 'pt') : null)
    : deltaLabel(pctChange(cur, prev), 'pct');
  if (!d) return <span class="text-[var(--color-text-muted)]">{prev === 0 && finite(cur) && cur > 0 ? 'Kỳ trước chưa chạy' : 'Chưa có kỳ trước để so'}</span>;
  const tone: Tone = goodWhen === 'none' || d.sign === 0 ? 'neutral' : (d.sign > 0) === (goodWhen === 'up') ? 'good' : 'bad';
  return <span style={{ color: toneColor(tone) }}>{unit === 'pct' ? bigChange(cur, prev) ?? d.text : d.text} so với kỳ trước</span>;
}

/** "▲ gấp 21 lần" instead of "▲ 1996%" once a value has more than tripled. */
function bigChange(cur: number | null, prev: number | null): string | null {
  if (!finite(cur) || !finite(prev) || !(prev > 0) || cur / prev < 4) return null;
  return `▲ gấp ${fmtDec(cur / prev, cur / prev >= 10 ? 0 : 1)} lần`;
}

const changeText = (cur: number, prev: number): string | null => bigChange(cur, prev) ?? deltaLabel(pctChange(cur, prev), 'pct')?.text ?? null;

// ── Attention list ─────────────────────────────────────────────────────

interface Alert { key: string; tone: Tone; account: AdsOverviewAccountDto; title: string; detail: string }

/** What deserves a look today, worst first. Thresholds are deliberately plain so the reason reads as a sentence. */
function buildAlerts(dto: AdsOverviewDto): Alert[] {
  const out: Alert[] = [];
  const total = dto.totals.spend || 1;
  for (const a of dto.accounts) {
    const cur = a.currency;
    const r = RESULT_META[a.resultType];
    const st = a.accountStatus;
    const recent = a.spend + a.spendPrev + a.spendToday > 0;
    if ((st === 2 || st === 3 || st === 8 || st === 9 || st === 7) && (recent || (a.amountSpent ?? 0) > 0)) {
      out.push({ key: `${a.id}-st`, tone: st === 7 || st === 9 ? 'warn' : 'bad', account: a, title: statusOf(a).text, detail: st === 3 || st === 8 || st === 9 ? 'Kiểm tra phương thức thanh toán trong Billing để quảng cáo không bị dừng.' : 'Quảng cáo trong tài khoản này không phân phối. Xem lý do trong Account Quality.' });
    }
    if (a.spendCap && a.amountSpent !== null && a.amountSpent / a.spendCap >= 0.85) {
      const pct = (a.amountSpent / a.spendCap) * 100;
      out.push({ key: `${a.id}-cap`, tone: pct >= 97 ? 'bad' : 'warn', account: a, title: `Đã dùng ${fmtDec(pct, 0)}% giới hạn chi tiêu`, detail: `${fmtMoney(a.amountSpent, cur)} / ${fmtMoney(a.spendCap, cur)}. Tới giới hạn, mọi quảng cáo dừng.` });
    }
    if (st === 1 && a.spendPrev > 0 && a.spend === 0 && a.spendToday === 0) {
      out.push({ key: `${a.id}-stop`, tone: 'warn', account: a, title: 'Ngừng chi tiêu', detail: `Kỳ trước chi ${fmtMoney(a.spendPrev, cur)}, kỳ này 0. Chiến dịch tắt có chủ đích, hay bị từ chối, hết ngân sách?` });
    }
    if (finite(a.targetCpa) && finite(a.cpa) && a.results >= 3 && a.cpa > a.targetCpa * 1.2) {
      out.push({ key: `${a.id}-tgt`, tone: 'bad', account: a, title: `${r.cpa} vượt mục tiêu ${fmtDec((a.cpa / a.targetCpa - 1) * 100, 0)}%`, detail: `${fmtMoney(a.cpa, cur)} so với mục tiêu ${fmtMoney(a.targetCpa, cur)}. Mở chi tiết để xem nhóm nào kéo giá lên.` });
    } else if (finite(a.cpa) && finite(a.cpaPrev) && a.results >= 5 && a.cpa > a.cpaPrev * 1.3) {
      out.push({ key: `${a.id}-cpa`, tone: 'warn', account: a, title: `${r.cpa} tăng ${fmtDec((a.cpa / a.cpaPrev - 1) * 100, 0)}%`, detail: `${fmtMoney(a.cpaPrev, cur)} → ${fmtMoney(a.cpa, cur)} trên ${fmtInt(a.results)} ${r.noun}.` });
    }
    if (a.spendPrev > 0 && a.spend > a.spendPrev * 1.5 && a.spend / total >= 0.05 && !(finite(a.cpa) && finite(a.cpaPrev) && a.cpa <= a.cpaPrev)) {
      out.push({ key: `${a.id}-jump`, tone: 'warn', account: a, title: `Chi tiêu tăng ${fmtDec((a.spend / a.spendPrev - 1) * 100, 0)}%`, detail: `${fmtMoney(a.spendPrev, cur)} → ${fmtMoney(a.spend, cur)} mà ${r.cpa} không rẻ hơn.` });
    }
    if (finite(a.cpa) && finite(a.cpaPrev) && a.results >= 10 && a.cpa < a.cpaPrev * 0.8 && a.spend > 0) {
      out.push({ key: `${a.id}-win`, tone: 'good', account: a, title: `${r.cpa} giảm ${fmtDec((1 - a.cpa / a.cpaPrev) * 100, 0)}%`, detail: `${fmtMoney(a.cpa, cur)} trên ${fmtInt(a.results)} ${r.noun}: ứng viên để tăng ngân sách.` });
    }
  }
  const rank: Record<Tone, number> = { bad: 0, warn: 1, good: 2, neutral: 3 };
  return out.sort((x, y) => rank[x.tone] - rank[y.tone] || y.account.spend - x.account.spend);
}

function AlertIcon({ tone }: { tone: Tone }) {
  const color = toneColor(tone);
  if (tone === 'good') return <CheckCircle2 size={14} style={{ color }} aria-hidden="true" />;
  if (tone === 'warn') return <AlertCircle size={14} style={{ color }} aria-hidden="true" />;
  return <AlertTriangle size={14} style={{ color }} aria-hidden="true" />;
}

const TONE_WORD: Record<Tone, string> = { bad: 'Nghiêm trọng', warn: 'Cần xem', good: 'Tín hiệu tốt', neutral: '' };

function AttentionCard({ alerts, onOpen }: { alerts: Alert[]; onOpen: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? alerts : alerts.slice(0, 6);
  return (
    <Card title="Cần chú ý" aside={alerts.length ? `${alerts.filter((a) => a.tone !== 'good').length} vấn đề · ${alerts.filter((a) => a.tone === 'good').length} tín hiệu tốt` : 'Không có gì bất thường'}>
      {alerts.length === 0 ? (
        <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Không tài khoản nào bị khóa, sắp chạm giới hạn chi tiêu hay đột biến giá trong kỳ này.</p>
      ) : (
        <ul class="list-none m-0 p-0 flex flex-col">
          {shown.map((al) => (
            <li key={al.key} class="grid items-start gap-2.5 py-2.5 border-t border-[var(--color-border)] first:border-t-0 first:pt-0" style={{ gridTemplateColumns: '18px minmax(0, 1fr) auto' }}>
              <span class="pt-0.5"><AlertIcon tone={al.tone} /></span>
              <div class="min-w-0">
                <div class="text-[13px] text-[var(--color-text)]">
                  <span class="sr-only">{TONE_WORD[al.tone]}: </span>
                  <strong class="font-semibold">{al.title}</strong>
                  <span class="text-[var(--color-text-muted)]"> · {al.account.name}</span>
                </div>
                <div class="text-[12.5px] text-[var(--color-text-muted)]">{al.detail}</div>
              </div>
              <button type="button" class={`${LINK_CLASS} text-[12.5px] bg-transparent border-0 p-0 cursor-pointer whitespace-nowrap`} onClick={() => onOpen(al.account.id)}>Xem chi tiết</button>
            </li>
          ))}
        </ul>
      )}
      {alerts.length > 6 && <button type="button" class={`${BTN} self-start`} onClick={() => setAll((v) => !v)}>{all ? 'Thu gọn' : `Xem thêm ${alerts.length - 6}`}</button>}
    </Card>
  );
}

// ── Accounts table ─────────────────────────────────────────────────────

type SortKey = 'name' | 'spend' | 'delta' | 'results' | 'cpa' | 'ctr' | 'cpm' | 'roas' | 'today' | 'month';

const sortValue: Record<SortKey, (a: AdsOverviewAccountDto) => number | string> = {
  name: (a) => a.name.toLowerCase(),
  spend: (a) => a.spend,
  delta: (a) => pctChange(a.spend, a.spendPrev) ?? -Infinity,
  results: (a) => a.results,
  cpa: (a) => a.cpa ?? Infinity,
  ctr: (a) => a.ctr ?? -Infinity,
  cpm: (a) => a.cpm ?? Infinity,
  roas: (a) => a.roas ?? -Infinity,
  today: (a) => a.spendToday,
  month: (a) => a.spendMonth,
};

function AccountsTable({ dto, colorOf, onOpen, onToggle, busyId }: {
  dto: AdsOverviewDto;
  colorOf: (id: string) => string | null;
  onOpen: (id: string) => void;
  onToggle: (a: AdsOverviewAccountDto) => void;
  busyId: string | null;
}) {
  const [q, setQ] = useState('');
  const [biz, setBiz] = useState('');
  const [onlySpending, setOnlySpending] = useState(true);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'spend', dir: -1 });

  const spendingCount = dto.accounts.filter((a) => a.spend + a.spendToday > 0).length;
  const hasRoas = dto.accounts.some((a) => a.roas !== null);
  const effectiveOnly = onlySpending && spendingCount > 0;
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = dto.accounts.filter((a) =>
      (!effectiveOnly || a.spend + a.spendToday > 0)
      && (!biz || (a.business?.id ?? '') === biz)
      && (!needle || a.name.toLowerCase().includes(needle) || a.id.includes(needle) || (a.business?.name ?? '').toLowerCase().includes(needle)));
    const f = sortValue[sort.key];
    return [...list].sort((x, y) => {
      const a = f(x); const b = f(y);
      return (a < b ? -1 : a > b ? 1 : 0) * sort.dir || y.spend - x.spend;
    });
  }, [dto, q, biz, effectiveOnly, sort]);

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
    const head = ['Tài khoản', 'ID', 'Business portfolio', 'Trạng thái', `Chi ${dto.window} ngày`, 'Chi kỳ trước', 'Chi hôm nay', 'Chi tháng này', 'Ngân sách tháng', 'Kết quả', 'Loại kết quả', 'Giá/kết quả', 'CTR link %', 'CPM', 'ROAS', 'Tiền tệ'];
    downloadCsv(`tai-khoan-quang-cao-${dto.window}-ngay.csv`, [head, ...rows.map((a) => [
      a.name, a.id.replace(/^act_/, ''), a.business?.name ?? '', statusOf(a).text, a.spend, a.spendPrev, a.spendToday, a.spendMonth, a.monthlyBudget,
      a.results, RESULT_META[a.resultType].noun, a.cpa, a.ctr, a.cpm, a.roas, a.currency,
    ])]);
  }

  const bizOptions = dto.accounts.reduce((m, a) => m.set(a.business?.id ?? '', a.business?.name ?? 'Không thuộc business portfolio'), new Map<string, string>());

  return (
    <Card
      title={`Tất cả tài khoản quảng cáo · ${dto.accounts.length}`}
      aside={<span>{spendingCount} tài khoản có chi tiêu trong {dto.window} ngày</span>}
    >
      <div class="flex flex-wrap items-center gap-2">
        <label class="relative flex-[1_1_220px] max-w-[320px]">
          <span class="sr-only">Tìm tài khoản</span>
          <Search size={13} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" aria-hidden="true" />
          <input class={`${SELECT} w-full pl-8`} placeholder="Tìm theo tên, ID, business…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </label>
        {bizOptions.size > 1 && (
          <select class={SELECT} value={biz} onChange={(e) => setBiz((e.target as HTMLSelectElement).value)} aria-label="Lọc theo business portfolio">
            <option value="">Mọi business portfolio</option>
            {[...bizOptions.entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
        <label class="inline-flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">
          <Toggle on={onlySpending} onChange={() => setOnlySpending((v) => !v)} ariaLabel="Chỉ hiện tài khoản đang chi tiêu" size="sm" />
          Chỉ tài khoản đang chi tiêu
        </label>
        <button type="button" class={`${BTN} inline-flex items-center gap-1.5 ml-auto`} onClick={exportCsv} disabled={!rows.length}>
          <Download size={13} /> Xuất CSV
        </button>
      </div>

      <div class="overflow-x-auto -mx-4 px-4">
        <table class="w-full border-collapse text-[13px] min-w-[1120px]">
          <thead>
            <tr class="border-b border-[var(--color-border)]">
              {th('name', 'Tài khoản', 'left')}
              <th scope="col" class="px-2.5 py-2 font-medium text-[12px] text-left text-[var(--color-text-muted)]">Trạng thái</th>
              {th('spend', `Chi ${dto.window} ngày`)}
              {th('delta', '± kỳ trước')}
              <th scope="col" class="px-2.5 py-2 font-medium text-[12px] text-left text-[var(--color-text-muted)] w-[96px]">Xu hướng</th>
              {th('results', 'Kết quả')}
              {th('cpa', 'Giá/kết quả')}
              {th('ctr', 'CTR link')}
              {th('cpm', 'CPM')}
              {hasRoas && th('roas', 'ROAS')}
              {th('today', 'Hôm nay')}
              {th('month', 'Tháng này')}
              <th scope="col" class="px-2.5 py-2 font-medium text-[12px] text-center text-[var(--color-text-muted)] whitespace-nowrap" title="Kéo số liệu mỗi giờ tới cấp chiến dịch, nhóm, mẫu quảng cáo">Theo dõi</th>
              <th scope="col" class="px-2.5 py-2"><span class="sr-only">Thao tác</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={hasRoas ? 14 : 13} class="px-2.5 py-6 text-center text-[var(--color-text-muted)]">Không có tài khoản nào khớp bộ lọc.</td></tr>
            )}
            {rows.map((a) => {
              const r = RESULT_META[a.resultType];
              const st = statusOf(a);
              const color = colorOf(a.id);
              const dd = changeText(a.spend, a.spendPrev);
              const overTarget = finite(a.targetCpa) && finite(a.cpa) ? a.cpa > a.targetCpa : null;
              return (
                <tr key={a.id} class="border-b border-[var(--color-border)] hover:bg-[var(--color-elevated)]/40">
                  <td class="px-2.5 py-2.5 max-w-[280px]">
                    <div class="flex items-start gap-2 min-w-0">
                      <span class="mt-[5px] w-2.5 h-2.5 rounded-[2px] shrink-0" style={{ background: color ?? 'transparent', border: color ? 'none' : `1px solid var(--color-border-strong)` }} aria-hidden="true" />
                      <div class="min-w-0">
                        <div class="font-semibold text-[var(--color-text)] truncate" title={a.name}>{a.name}</div>
                        <div class="text-[11.5px] text-[var(--color-text-muted)] truncate">{a.business?.name ?? 'Cá nhân'} · {a.id.replace(/^act_/, '')}{a.currency !== dto.currency ? ` · ${a.currency}` : ''}</div>
                      </div>
                    </div>
                  </td>
                  <td class="px-2.5 py-2.5"><StatusChip {...st} /></td>
                  <td class="px-2.5 py-2.5 text-right tabular-nums whitespace-nowrap font-semibold text-[var(--color-text)]">{fmtMoney(a.spend, a.currency)}</td>
                  <td class="px-2.5 py-2.5 text-right tabular-nums whitespace-nowrap text-[12.5px]" style={{ color: 'var(--color-text-muted)' }}>{dd ?? (a.spend > 0 && a.spendPrev === 0 ? 'mới chi' : '–')}</td>
                  <td class="px-2.5 py-1"><div class="w-[88px]"><Sparkline values={a.spark} /></div></td>
                  <td class="px-2.5 py-2.5 text-right tabular-nums whitespace-nowrap">
                    <div class="text-[var(--color-text)]">{fmtInt(a.results)}</div>
                    <div class="text-[11px] text-[var(--color-text-muted)]" title={a.resultTypeGuessed ? 'Tự chọn theo loại kết quả nhiều nhất; đặt lại trong “Tài khoản & mục tiêu”' : undefined}>{r.noun}{a.resultTypeGuessed ? ' *' : ''}</div>
                  </td>
                  <td class="px-2.5 py-2.5 text-right tabular-nums whitespace-nowrap">
                    <div class="text-[var(--color-text)]">{fmtMoney(a.cpa, a.currency)}</div>
                    {overTarget !== null && (
                      <div class="text-[11px] inline-flex items-center gap-1 justify-end" style={{ color: overTarget ? BAD : GOOD }}>
                        {overTarget ? 'trên' : 'dưới'} mục tiêu
                      </div>
                    )}
                  </td>
                  <td class="px-2.5 py-2.5 text-right tabular-nums whitespace-nowrap">{fmtPct(a.ctr, 2)}</td>
                  <td class="px-2.5 py-2.5 text-right tabular-nums whitespace-nowrap">{fmtMoney(a.cpm, a.currency)}</td>
                  {hasRoas && <td class="px-2.5 py-2.5 text-right tabular-nums whitespace-nowrap">{a.roas === null ? '–' : fmtDec(a.roas, 2)}</td>}
                  <td class="px-2.5 py-2.5 text-right tabular-nums whitespace-nowrap text-[var(--color-text-muted)]">{a.spendToday > 0 ? fmtMoney(a.spendToday, a.currency) : '–'}</td>
                  <td class="px-2.5 py-2.5 text-right tabular-nums whitespace-nowrap">
                    <div class="text-[var(--color-text)]">{a.spendMonth > 0 ? fmtMoney(a.spendMonth, a.currency) : '–'}</div>
                    {finite(a.monthlyBudget) && a.monthlyBudget > 0 && (
                      <div class="flex items-center justify-end gap-1.5" title={`${fmtDec((a.spendMonth / a.monthlyBudget) * 100, 0)}% ngân sách tháng ${fmtMoney(a.monthlyBudget, a.currency)}`}>
                        <span class="relative w-[54px] h-1 rounded-full" style={{ background: TRACK }} aria-hidden="true">
                          <span class="block h-1 rounded-full" style={{ width: `${Math.min(100, (a.spendMonth / a.monthlyBudget) * 100)}%`, background: a.spendMonth > a.monthlyBudget ? BAD : SERIES }} />
                        </span>
                        <span class="text-[11px] text-[var(--color-text-muted)]">{fmtDec((a.spendMonth / a.monthlyBudget) * 100, 0)}%</span>
                      </div>
                    )}
                  </td>
                  <td class="px-2.5 py-2.5 text-center">
                    <span class="inline-flex"><Toggle on={a.enabled} onChange={() => onToggle(a)} ariaLabel={`Theo dõi sâu ${a.name}`} size="sm" disabled={busyId === a.id} /></span>
                  </td>
                  <td class="px-2.5 py-2.5 text-right whitespace-nowrap">
                    <button type="button" class={`${LINK_CLASS} bg-transparent border-0 p-0 cursor-pointer text-[12.5px] mr-3`} onClick={() => onOpen(a.id)}>Chi tiết</button>
                    <a class="inline-flex items-center text-[var(--color-text-muted)] hover:text-[var(--color-text)]" href={adsManagerUrl(a.id)} target="_blank" rel="noopener noreferrer" aria-label={`Mở ${a.name} trong Ads Manager`} title="Mở trong Ads Manager"><ExternalLink size={13} /></a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p class="m-0 text-[12px] text-[var(--color-text-muted)]">
        * Loại kết quả được tự chọn theo hành động nhiều nhất của tài khoản. “Theo dõi sâu” bật kéo số liệu từng giờ tới cấp chiến dịch, nhóm, mẫu quảng cáo và đề xuất tối ưu.
      </p>
    </Card>
  );
}

// ── Page ───────────────────────────────────────────────────────────────

export function AdsOverview({ days, onOpenAccount: openRaw }: { days: number; onOpenAccount: (id: string, guessedType?: AdsResultType) => void }) {
  const [fresh, setFresh] = useState(0);
  const url = `/api/m/ads/overview?days=${days}${fresh ? `&fresh=1&n=${fresh}` : ''}`;
  const res = useFetch<AdsOverviewDto>(url);
  const [hd, setHd] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const dto = res.data;
  // Re-read every 10 minutes while the tab is visible (the server caches Meta reads for as long).
  useEffect(() => {
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') res.refresh(); }, 10 * 60_000);
    return () => window.clearInterval(t);
  }, [url]);
  const onOpenAccount = (id: string) => {
    const a = dto?.accounts.find((x) => x.id === id);
    openRaw(id, a && a.resultTypeGuessed ? a.resultType : undefined);
  };

  // Colour follows the account (fixed by spend rank over the window), never the day.
  const top = useMemo(() => (dto ? dto.accounts.filter((a) => a.currency === dto.currency && a.spend > 0).slice(0, CAT.length) : []), [dto]);
  const colorOf = (id: string) => { const i = top.findIndex((a) => a.id === id); return i >= 0 ? CAT[i] : null; };
  const alerts = useMemo(() => (dto ? buildAlerts(dto) : []), [dto]);

  async function toggle(a: AdsOverviewAccountDto) {
    setBusyId(a.id);
    try {
      await apiPatch(`/api/m/ads/accounts/${encodeURIComponent(a.id)}`, { enabled: !a.enabled, ...(!a.enabled && a.resultTypeGuessed ? { resultType: a.resultType } : {}) });
      pushToast({ tone: 'success', title: a.enabled ? `Đã tắt theo dõi sâu ${a.name}` : `Đã bật theo dõi sâu ${a.name}`, description: a.enabled ? undefined : 'Số liệu chi tiết đang được kéo, mất khoảng một phút.' });
      invalidateFetchCache('/api/m/ads/');
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không cập nhật được', description: errorMessage(err) });
    } finally {
      setBusyId(null);
    }
  }

  async function enableSpending() {
    if (!dto) return;
    const picked = dto.accounts.filter((a) => !a.enabled && a.spend + a.spendToday > 0);
    const ids = picked.map((a) => a.id);
    if (!ids.length) return;
    const resultTypes = Object.fromEntries(picked.filter((a) => a.resultTypeGuessed).map((a) => [a.id, a.resultType]));
    setBulkBusy(true);
    try {
      await apiPost('/api/m/ads/accounts/enable-all', { enabled: true, ids, resultTypes });
      pushToast({ tone: 'success', title: `Đã bật theo dõi sâu ${ids.length} tài khoản`, description: 'Số liệu chi tiết được kéo lần lượt từng tài khoản.' });
      invalidateFetchCache('/api/m/ads/');
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không bật được', description: errorMessage(err) });
    } finally {
      setBulkBusy(false);
    }
  }

  if (res.loading && !dto) return <DashLoading label="Đang đọc mọi tài khoản quảng cáo từ Meta…" />;
  if (res.error && !dto) return <DashError error={res.error} onRetry={res.refresh} />;
  if (!dto) return null;

  if (dto.accounts.length === 0) {
    return (
      <Card title="Chưa thấy tài khoản quảng cáo nào">
        <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Kết nối Meta Ads đang hoạt động nhưng chưa cấp tài khoản quảng cáo nào. Bấm “Thêm đăng nhập Meta” và khi Meta hỏi, chọn tất cả business portfolio cùng tài khoản quảng cáo.</p>
      </Card>
    );
  }

  const cur = dto.currency;
  const t = dto.totals;
  const n = dto.days.length;
  const types = (Object.entries(t.resultsByType) as [AdsResultType, NonNullable<AdsOverviewDto['totals']['resultsByType'][AdsResultType]>][])
    .sort((a, b) => b[1].spend - a[1].spend);
  const ctr = t.impressions > 0 ? (t.linkClicks / t.impressions) * 100 : null;
  const ctrPrev = t.impressionsPrev > 0 ? (t.linkClicksPrev / t.impressionsPrev) * 100 : null;
  const cpm = t.impressions > 0 ? (t.spend / t.impressions) * 1000 : null;
  const cpmPrev = t.impressionsPrev > 0 ? (t.spendPrev / t.impressionsPrev) * 1000 : null;
  const roas = t.spend > 0 && t.revenue > 0 ? t.revenue / t.spend : null;
  const dailyTotals = dto.daily.map((d) => d.total);
  const notEnabledSpending = dto.accounts.filter((a) => !a.enabled && a.spend + a.spendToday > 0).length;

  // Stacked chart: top accounts + "Khác".
  const hasOther = dto.daily.some((d) => Object.entries(d.byAccount).some(([id, v]) => v > 0 && !top.some((a) => a.id === id)));
  const series: StackSeries[] = [
    ...top.map((a, i) => ({ key: a.id, label: a.name, color: CAT[i] })),
    ...(hasOther ? [{ key: '_other', label: 'Khác', color: OTHER_COLOR }] : []),
  ];
  const values = dto.daily.map((d) => {
    const col = top.map((a) => d.byAccount[a.id] ?? 0);
    if (hasOther) col.push(d.total - col.reduce((s, v) => s + v, 0));
    return col;
  });
  const labels = dto.days.map(dayLabel);
  const half = Math.floor(n / 2);
  const recentHalf = dailyTotals.slice(n - half).reduce((s, v) => s + v, 0);
  const earlyHalf = dailyTotals.slice(0, half).reduce((s, v) => s + v, 0);

  // Business portfolios and top accounts share one scale each.
  const bizMax = Math.max(1, ...dto.businesses.map((b) => b.spend));
  const topRows = dto.accounts.filter((a) => a.currency === cur && a.spend > 0).slice(0, 8);
  const accMax = Math.max(1, ...topRows.map((a) => a.spend));

  return (
    <>
      <div class="flex flex-wrap items-center justify-between gap-2 -mt-1">
        <span class="text-[13px] text-[var(--color-text-muted)]">
          {dto.accounts.length} tài khoản · {t.spendingAccounts} đang chi tiêu · {n} ngày gần nhất ({dayLabel(dto.days[0])}–{dayLabel(dto.days[n - 1])}, gồm hôm nay) · đọc lúc {fmtSlot(dto.fetchedAt)}, tự làm mới 10 phút
          {dto.otherCurrencies.length > 0 && <> · tổng tính bằng {cur}, tài khoản {dto.otherCurrencies.join(', ')} chỉ liệt kê</>}
        </span>
        <div class="flex flex-wrap items-center gap-2">
          {notEnabledSpending > 0 && (
            <button type="button" class={BTN_PRIMARY} onClick={enableSpending} disabled={bulkBusy} title="Bật kéo số liệu chi tiết từng giờ cho mọi tài khoản đang chi tiêu">
              {bulkBusy ? 'Đang bật…' : `Theo dõi sâu ${notEnabledSpending} tài khoản đang chi`}
            </button>
          )}
          <button type="button" class={`${BTN} inline-flex items-center gap-1.5`} onClick={() => setFresh(Date.now())} disabled={res.loading}>
            <RefreshCw size={13} class={res.loading ? 'animate-spin' : ''} /> Đọc lại từ Meta
          </button>
        </div>
      </div>
      {dto.warnings.map((w) => <div key={w} class="text-[12.5px]" style={{ color: WARN }}>{w}</div>)}

      <section aria-label={`Tổng ${n} ngày, mọi tài khoản`} class="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
        <KpiTile label={`Tổng chi tiêu ${n} ngày`} value={fmtMoney(t.spend, cur)} delta={<Delta cur={t.spend} prev={t.spendPrev} goodWhen="none" />}>
          <Sparkline values={dailyTotals} />
        </KpiTile>
        <KpiTile label="Chi hôm nay (đến giờ)" value={fmtMoney(t.spendToday, cur)} delta={<span class="text-[var(--color-text-muted)]">TB {fmtMoney(t.spend / Math.max(1, n), cur)}/ngày trong kỳ</span>} />
        <KpiTile label={`Tháng ${Number(dto.today.slice(5, 7))} đến nay`} value={fmtMoney(t.spendMonth, cur)} delta={<span class="text-[var(--color-text-muted)]">Dự kiến cả tháng ~{fmtMoney(projectMonth(t.spendMonth, dto.today), cur)}</span>} />
        {types.slice(0, 2).map(([type, v]) => {
          const meta = RESULT_META[type];
          const cpa = v.results > 0 ? v.spend / v.results : null;
          const cpaPrev = v.resultsPrev > 0 ? v.spendPrev / v.resultsPrev : null;
          return (
            <KpiTile key={type} label={`${meta.name} · ${meta.cpa} ${fmtMoney(cpa, cur)}`} value={fmtInt(v.results)} delta={<Delta cur={cpa} prev={cpaPrev} goodWhen="down" />} />
          );
        })}
        <KpiTile label="CTR link" value={fmtPct(ctr, 2)} delta={<Delta cur={ctr} prev={ctrPrev} goodWhen="up" unit="pt" />} />
        <KpiTile label="CPM" value={fmtMoney(cpm, cur)} delta={<Delta cur={cpm} prev={cpmPrev} goodWhen="down" />} />
        {roas !== null ? (
          <KpiTile label="ROAS (đơn hàng)" value={fmtDec(roas, 2)} delta={<span class="text-[var(--color-text-muted)]">{fmtInt(t.purchases)} đơn · {fmtMoney(t.revenue, cur)}</span>} />
        ) : (
          <KpiTile label="Tài khoản đang chi" value={`${t.spendingAccounts}/${dto.accounts.length}`} delta={<span class="text-[var(--color-text-muted)]">{t.activeAccounts} tài khoản đang hoạt động</span>} />
        )}
      </section>

      <div class="flex flex-wrap gap-4">
        <Card
          class="flex-[2_1_560px]"
          title={`Chi tiêu mỗi ngày theo tài khoản, ${n} ngày`}
          aside={<span role="status" class="tabular-nums text-[var(--color-text)]">{hd === null && n >= 4 ? `${half} ngày gần nhất ${fmtMoney(recentHalf, cur)} · ${half} ngày trước đó ${fmtMoney(earlyHalf, cur)}` : ' '}</span>}
        >
          <StackedBars
            series={series}
            values={values}
            labels={labels}
            active={hd}
            onActive={setHd}
            formatAxis={(v) => moneyAxis(v, cur)}
            groupLabel="Chi tiêu mỗi ngày, chồng theo tài khoản"
            height={268}
            ariaOf={(i) => `${labels[i]}: tổng ${fmtMoney(dto.daily[i].total, cur)}`}
            tooltip={(i) => (
              <div class="flex flex-col gap-1">
                <div class="flex justify-between gap-4 text-[var(--color-text)]"><strong>{labels[i]}</strong><strong class="tabular-nums">{fmtMoney(dto.daily[i].total, cur)}</strong></div>
                {series.map((s, k) => values[i][k] > 0 && (
                  <div key={s.key} class="flex items-center justify-between gap-4 text-[var(--color-text-muted)]">
                    <span class="inline-flex items-center gap-1.5 min-w-0"><span class="w-2 h-2 rounded-[2px] shrink-0" style={{ background: s.color }} /> <span class="truncate max-w-[150px]">{s.label}</span></span>
                    <span class="tabular-nums text-[var(--color-text)]">{fmtMoney(values[i][k], cur)}</span>
                  </div>
                ))}
              </div>
            )}
          />
          <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
        </Card>

        <div class="flex-[1_1_340px] flex flex-col gap-4 min-w-0">
          <Card title="Theo business portfolio" aside={`${n} ngày · ± kỳ trước`}>
            <RowBars
              labelWidth={128}
              rows={dto.businesses.filter((b) => b.spend + b.spendPrev > 0).map((b) => {
                const d = changeText(b.spend, b.spendPrev);
                return {
                  key: b.id || '_none',
                  label: <span class="block truncate" title={b.name}>{b.name}</span>,
                  ratio: b.spend / bizMax,
                  color: SERIES,
                  main: fmtMoney(b.spend, cur),
                  sub: d ?? `${b.accounts} TK`,
                  title: `${b.name}: ${b.accounts} tài khoản, ${fmtMoney(b.spend, cur)}`,
                };
              })}
            />
            {dto.businesses.every((b) => b.spend + b.spendPrev === 0) && <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Chưa có chi tiêu trong hai kỳ gần nhất.</p>}
          </Card>
          <Card title="Top tài khoản theo chi tiêu" aside="Tỷ trọng trong tổng">
            <RowBars
              labelWidth={128}
              rows={topRows.map((a) => ({
                key: a.id,
                label: <span class="block truncate" title={a.name}>{a.name}</span>,
                ratio: a.spend / accMax,
                color: colorOf(a.id) ?? OTHER_COLOR,
                main: fmtMoney(a.spend, cur),
                sub: fmtPct(t.spend > 0 ? (a.spend / t.spend) * 100 : null, 0),
              }))}
            />
          </Card>
        </div>
      </div>

      <AttentionCard alerts={alerts} onOpen={onOpenAccount} />

      <CampaignsAcrossAccounts days={days} onOpenAccount={onOpenAccount} />

      <AccountsTable dto={dto} colorOf={colorOf} onOpen={onOpenAccount} onToggle={toggle} busyId={busyId} />
    </>
  );
}
