import { useState } from 'preact/hooks';
import { RefreshCw, Settings2 } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { apiPatch, apiPost } from '@/lib/api';
import { errorMessage } from '@/lib/marketing';
import { pushToast } from '@/lib/toasts';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { usePageFocus } from '@/lib/page-context';
import {
  fmtCompact,
  fmtDec,
  fmtInt,
  fmtMoney,
  fmtPct,
  fmtSlot,
  type AdAccountDto,
  type AdsDashboardDto,
  type AdsOverviewDto,
  type AdsResultType,
  type ConnStatus,
} from '@modules/ads/web/lib/fbstudio';
import { Card, KpiTile, SetupNotice } from '@modules/ads/web/components/fb/common';
import { SERIES, TRACK, WARN, dayLabel, deltaLabel, finite, niceTicks, toneColor, type Tone } from '@/components/fb/charts/chart-utils';
import { BTN, DashError, DashLoading, SELECT } from '@modules/ads/web/components/fb/DashStates';
import { DailyBars } from '@/components/fb/charts/DailyBars';
import { Funnel, type FunnelStep } from '@/components/fb/charts/Funnel';
import { Legend } from '@/components/fb/charts/Legend';
import { LineChart } from '@/components/fb/charts/LineChart';
import { Quadrant, type QuadrantPoint } from '@/components/fb/charts/Quadrant';
import { AdsAccountsPanel, ConnectionNotice, TargetPrompt } from '@modules/ads/web/components/fb/ads/AdsAccounts';
import { AudienceSection } from '@modules/ads/web/components/fb/ads/AdsAudience';
import { AdsConnectPanel } from '@modules/ads/web/components/fb/ads/AdsConnect';
import { AdsOverview } from '@modules/ads/web/components/fb/ads/AdsOverview';
import { CreativesSection, OrganicSection, PlacementsSection } from '@modules/ads/web/components/fb/ads/AdsCreatives';
import { AdsQueue } from '@modules/ads/web/components/fb/ads/AdsQueue';
import { AdsTree } from '@modules/ads/web/components/fb/ads/AdsTree';
import { RESULT_META, moneyAxis, pctChange } from '@modules/ads/web/components/fb/ads/adsMeta';

interface AccountsRes { accounts: AdAccountDto[]; connection: ConnStatus }

type View = 'overview' | 'detail';
const VIEW_KEY = 'fb.ads.view';
const ACCOUNT_KEY = 'fb.ads.account';
function readView(): View {
  try { return localStorage.getItem(VIEW_KEY) === 'detail' ? 'detail' : 'overview'; } catch { return 'overview'; }
}
function readAccount(): string | null {
  try { return localStorage.getItem(ACCOUNT_KEY); } catch { return null; }
}

const SEG = (on: boolean, first: boolean) =>
  `h-8 px-3 text-[12.5px] whitespace-nowrap ${first ? '' : 'border-l border-[var(--color-border-strong)]'} ${on ? 'bg-[var(--color-accent-soft)] text-[var(--color-text)] font-semibold' : 'bg-[var(--color-card)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`;

export function FbAds() {
  const studio = { blocker: null, loading: false };
  const accountsRes = useFetch<AccountsRes>(studio.blocker ? null : '/api/m/ads/accounts');
  const [pickedId, setPickedState] = useState<string | null>(readAccount);
  const setPickedId = (id: string) => { setPickedState(id); try { localStorage.setItem(ACCOUNT_KEY, id); } catch { /* per-viewer convenience only */ } };
  const [days, setDays] = useState(7);
  const [view, setViewState] = useState<View>(readView);
  const [showSettings, setShowSettings] = useState(false);
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* per-viewer convenience only */ } };
  const [refreshing, setRefreshing] = useState(false);

  const accounts = accountsRes.data?.accounts ?? [];
  const connection = accountsRes.data?.connection ?? 'UNKNOWN';
  const active = connection === 'ACTIVE';
  const detail = view === 'detail';
  // Same request as the overview (cached server side): orders the account picker by recent spend.
  const overview = useFetch<AdsOverviewDto>(!studio.blocker && active ? `/api/m/ads/overview?days=${days}` : null);
  const spendOf = new Map((overview.data?.accounts ?? []).map((a) => [a.id, a.spend]));
  const enabled = accounts.filter((a) => a.enabled).sort((x, y) => (spendOf.get(y.id) ?? 0) - (spendOf.get(x.id) ?? 0) || x.name.localeCompare(y.name));
  const picked = enabled.find((a) => a.id === pickedId);
  // With no remembered pick, wait for the spend ranking so the screen does not jump to another account when it lands.
  const rankingPending = !picked && overview.loading && !overview.data;
  const account = picked ?? (rankingPending ? null : enabled[0] ?? null);
  // The dock's agent reads this account's dashboard for the range on screen.
  usePageFocus(detail && account ? { fbAdAccountId: account.id, days, label: `${account.name} · ${days} ngày` } : { label: `Mọi tài khoản quảng cáo · ${days} ngày` });

  /** From the overview: open one account's dashboard, turning on in-depth tracking first when needed. */
  async function openAccount(id: string, guessedType?: AdsResultType) {
    const target = accounts.find((a) => a.id === id);
    if (target && !target.enabled) {
      try {
        await apiPatch(`/api/m/ads/accounts/${encodeURIComponent(id)}`, { enabled: true, ...(guessedType ? { resultType: guessedType } : {}) });
        pushToast({ tone: 'success', title: `Đã bật theo dõi sâu ${target.name}`, description: 'Số liệu chi tiết đang được kéo, mất khoảng một phút.' });
        invalidateFetchCache('/api/m/ads/');
      } catch (err) {
        pushToast({ tone: 'error', title: 'Không bật được tài khoản', description: errorMessage(err) });
        return;
      }
    }
    setPickedId(id);
    setView('detail');
  }

  async function refreshNow() {
    if (!account) return;
    setRefreshing(true);
    try {
      await apiPost('/api/m/ads/refresh', { accountId: account.id });
      pushToast({ tone: 'success', title: 'Đã kéo số liệu quảng cáo mới' });
      invalidateFetchCache('/api/m/ads/');
    } catch (err) {
      pushToast({ tone: 'error', title: 'Chưa kéo được số liệu', description: errorMessage(err) });
    } finally {
      setRefreshing(false);
    }
  }

  let body;
  if (studio.blocker) body = studio.blocker;
  else if (accountsRes.loading && !accountsRes.data) body = <DashLoading />;
  else if (accountsRes.error && !accountsRes.data) body = <DashError error={accountsRes.error} onRetry={accountsRes.refresh} />;
  else {
    body = (
      <>
        {!active && (connection === 'EXPIRED' ? <ConnectionNotice connection={connection} /> : <AdsConnectPanel />)}
        {(showSettings || (detail && enabled.length === 0) || (!active && accounts.length > 0)) && <AdsAccountsPanel accounts={accounts} canAddLogin={active} />}
        {active && !detail && <AdsOverview days={days} onOpenAccount={openAccount} />}
        {active && detail && enabled.length === 0 && (
          <SetupNotice title="Chưa bật theo dõi sâu tài khoản nào">
            {accounts.length === 0
              ? 'Chưa thấy tài khoản quảng cáo. Bấm “Đồng bộ tài khoản” để lấy danh sách từ Meta Ads.'
              : 'Ở “Tổng quan”, bật “Theo dõi sâu” cho tài khoản cần xem tới cấp chiến dịch, nhóm và mẫu quảng cáo.'}
          </SetupNotice>
        )}
        {detail && rankingPending && enabled.length > 0 && <DashLoading label="Đang chọn tài khoản chi nhiều nhất…" />}
        {detail && account && <AdsDashboard key={account.id} account={account} days={days} stale={!active} />}
      </>
    );
  }

  const showTools = !studio.blocker && accountsRes.data && (active || accounts.length > 0);
  return (
    <div class="flex flex-col h-full">
      <PageHeader
        breadcrumb="Marketing · Facebook"
        title="Quảng cáo"
        actions={
          !studio.blocker && accountsRes.data && (
            <>
              <span
                class="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-[var(--color-border)] text-[12.5px] text-[var(--color-text-muted)] whitespace-nowrap"
                title={active ? 'Kết nối Meta Ads đang hoạt động (chỉ đọc)' : connection === 'EXPIRED' ? 'Kết nối Meta Ads đã hết hạn' : 'Chưa kết nối Meta Ads'}
              >
                <span class="w-[7px] h-[7px] rounded-full" style={{ background: active ? '#4ade80' : '#f87171' }} aria-hidden="true" />
                Meta Ads{active ? '' : connection === 'EXPIRED' ? ' · hết hạn' : ' · chưa kết nối'}
              </span>
              {detail && account && active && (
                <button type="button" class={`${BTN} inline-flex items-center gap-1.5 whitespace-nowrap`} onClick={refreshNow} disabled={refreshing} title="Kéo lại số liệu của tài khoản này từ Meta">
                  <RefreshCw size={13} class={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Đang kéo…' : 'Kéo số liệu'}
                </button>
              )}
              <button type="button" class={`${BTN} inline-flex items-center gap-1.5 whitespace-nowrap`} aria-pressed={showSettings} onClick={() => setShowSettings((v) => !v)}>
                <Settings2 size={13} /> Mục tiêu
              </button>
            </>
          )
        }
        tabs={showTools ? (
          <>
            <div role="tablist" aria-label="Chế độ xem" class="flex shrink-0 rounded-md border border-[var(--color-border-strong)] overflow-hidden">
              {([['overview', 'Tổng quan'], ['detail', 'Chi tiết tài khoản']] as const).map(([v, label], i) => (
                <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} class={SEG(view === v, i === 0)}>{label}</button>
              ))}
            </div>
            {detail && enabled.length > 0 && (
              <label class="flex shrink-0 items-center gap-1.5 ml-2 text-[12.5px] text-[var(--color-text-muted)]">
                <span class="sr-only">Tài khoản</span>
                <select class={`${SELECT} max-w-[280px]`} value={account?.id ?? ''} onChange={(e) => setPickedId((e.target as HTMLSelectElement).value)} aria-label="Tài khoản quảng cáo">
                  {enabled.map((a) => {
                    const sp = spendOf.get(a.id);
                    return <option key={a.id} value={a.id}>{a.name || a.id}{sp ? ` · ${fmtMoney(sp, a.currency)}` : ''}</option>;
                  })}
                </select>
              </label>
            )}
            <div role="group" aria-label="Khoảng thời gian" class="flex shrink-0 ml-2 rounded-md border border-[var(--color-border-strong)] overflow-hidden">
              {[7, 14, 28].map((d, i) => (
                <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)} class={SEG(days === d, i === 0)}>{d} ngày</button>
              ))}
            </div>
          </>
        ) : undefined}
      />
      <div class="flex-1 overflow-y-auto px-4 sm:px-6 py-5 flex flex-col gap-4">
        {body}
      </div>
    </div>
  );
}

function cmp(cur: number | null, prev: number | null, goodWhen: 'up' | 'down' | 'none'): { text: string; tone: Tone } | null {
  if (prev === 0 && finite(cur) && cur > 0) return { text: 'Kỳ trước chưa chạy', tone: 'neutral' };
  const d = deltaLabel(pctChange(cur, prev), 'pct');
  if (!d) return null;
  const tone: Tone = goodWhen === 'none' || d.sign === 0 ? 'neutral' : (d.sign > 0) === (goodWhen === 'up') ? 'good' : 'bad';
  return { text: `${d.text} so với kỳ trước`, tone };
}

function Delta({ v, idle = false }: { v: { text: string; tone: Tone } | null; idle?: boolean }) {
  return v ? <span style={{ color: toneColor(v.tone) }}>{v.text}</span> : <span class="text-[var(--color-text-muted)]">{idle ? 'Kỳ trước chưa chạy' : 'Chưa có kỳ trước để so'}</span>;
}

function AdsDashboard({ account, days, stale }: { account: AdAccountDto; days: number; stale: boolean }) {
  const res = useFetch<AdsDashboardDto>(`/api/m/ads/dashboard?account=${encodeURIComponent(account.id)}&days=${days}`);
  const [review, setReview] = useState<{ text: string; reason: string; score: number } | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  async function evaluate() {
    setReviewBusy(true); setReviewError(null);
    try { setReview(await apiPost('/api/m/ads/evaluate', { accountId: account.id })); }
    catch { setReviewError('Chưa đánh giá được. Kiểm tra quyền agent rồi thử lại.'); }
    finally { setReviewBusy(false); }
  }
  const [acted, setActed] = useState<Record<number, 'done' | 'snoozed'>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [hd, setHd] = useState<number | null>(null);
  const [hq, setHq] = useState<string | null>(null);

  async function act(id: number, state: 'done' | 'snoozed') {
    setBusy(id);
    setActed((a) => ({ ...a, [id]: state }));
    try {
      await apiPost(`/api/m/ads/recommendations/${id}`, { state });
      res.refresh();
    } catch (err) {
      setActed((a) => { const n = { ...a }; delete n[id]; return n; });
      pushToast({ tone: 'error', title: 'Không cập nhật được đề xuất', description: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  if (res.loading && !res.data) return <DashLoading />;
  if (res.error && !res.data) return stale ? null : <DashError error={res.error} onRetry={res.refresh} />;
  const dto = res.data;
  if (!dto) return null;

  if (dto.lastSnapshotAt === null && dto.tree.length === 0 && dto.daily.length === 0) {
    return (
      <SetupNotice title="Chưa có số liệu quảng cáo">
        Tài khoản <strong>{account.name || account.id}</strong> chưa được kéo số liệu lần nào. Worker kéo mỗi giờ khi kết nối còn hạn; bấm “Kéo số liệu mới” ở đầu trang để chạy ngay.
      </SetupNotice>
    );
  }

  const cur = account.currency;
  const r = RESULT_META[account.resultType];
  const target = account.targetCpa;
  const k = dto.kpis;
  const pace = k.pacing;
  const paceDiff = pace ? pace.spentPct - pace.elapsedPct : 0;
  const paceText = !pace ? null : Math.abs(paceDiff) <= 10 ? 'đúng nhịp' : paceDiff > 0 ? 'vượt nhịp' : 'chậm nhịp';

  const ctrD = finite(k.ctr) && finite(k.ctrPrev) ? deltaLabel(k.ctr - k.ctrPrev, 'pt') : null;
  const prevIdle = k.spendPrev === 0 && k.spend > 0;
  const ctrTone: Tone = !ctrD || ctrD.sign === 0 ? 'neutral' : ctrD.sign > 0 ? 'good' : 'bad';

  // Daily charts share one active day.
  const daily = dto.daily;
  const n = daily.length;
  const half = Math.floor(n / 2);
  const spendVals = daily.map((d) => d.spend);
  const cpaVals = daily.map((d) => d.cpa);
  const cpaNums = cpaVals.filter(finite);
  const lo = Math.max(0, Math.min(...cpaNums, finite(target) ? target : Infinity) * 0.85);
  const hi = Math.max(...cpaNums, finite(target) ? target : 0) * 1.08;
  const cpaTicks = cpaNums.length ? niceTicks(Number.isFinite(lo) ? lo : 0, hi > lo ? hi : lo + 1, 4) : [0, 1];
  const sumSpend = (a: number, b: number) => spendVals.slice(a, b).reduce((s, v) => s + v, 0);
  const lastCpa = [...cpaVals].reverse().find(finite);
  const dayReadout = hd !== null && daily[hd]
    ? `${dayLabel(daily[hd].day)}: chi ${fmtMoney(daily[hd].spend, cur)} · ${r.cpa} ${finite(daily[hd].cpa) ? fmtMoney(daily[hd].cpa, cur) : '–'}`
    : n >= 4 ? `${half} ngày gần nhất ${fmtMoney(sumSpend(n - half, n), cur)} · ${half} ngày trước đó ${fmtMoney(sumSpend(0, half), cur)}` : '';
  const ariaDay = (i: number) => `${dayLabel(daily[i].day)}: chi ${fmtMoney(daily[i].spend, cur)}, ${r.cpa} ${finite(daily[i].cpa) ? fmtMoney(daily[i].cpa, cur) : 'chưa có kết quả'}`;

  // Quadrant: ad sets, x = spend, y = CPA ÷ target (0..2).
  const sets = dto.tree.filter((t) => t.level === 'adset');
  const maxSpend = Math.max(1, ...sets.map((s) => s.spend)) * 1.1;
  const maxResults = Math.max(1, ...sets.map((s) => s.results));
  const points: QuadrantPoint[] = finite(target) && target > 0 ? sets.map((s) => {
    const ratio = finite(s.cpa) ? s.cpa / target : 2;
    return {
      id: s.id,
      label: s.name.length > 22 ? `${s.name.slice(0, 21)}…` : s.name,
      x: Math.min(92, Math.max(8, (s.spend / maxSpend) * 100)),
      y: Math.min(92, Math.max(8, (1 - ratio / 2) * 100)),
      size: Math.round(10 + (s.results / maxResults) * 20),
      aria: `${s.name}: chi ${fmtMoney(s.spend, cur)}, ${s.results} ${r.noun}, ${finite(s.cpa) ? `${r.cpa} ×${fmtDec(ratio, 2)} mục tiêu` : 'chưa có kết quả'}`,
    };
  }) : [];
  const hqSet = sets.find((s) => s.id === hq);

  // Funnel
  const f0 = dto.funnel[0]?.value ?? null;
  const steps: FunnelStep[] = dto.funnel.map((s, i) => ({
    key: s.key,
    label: s.label,
    valueText: fmtCompact(s.value),
    ratio: finite(s.value) && finite(f0) && f0 > 0 ? s.value / f0 : null,
    note: s.note || (i === 0 ? 'Mốc gốc' : 'Chưa có dữ liệu'),
    noteTone: /rò/i.test(s.note) ? 'warn' : 'neutral',
  }));

  return (
    <>
      <Card title="Nhận xét của agent">
        <button type="button" class={BTN} disabled={reviewBusy} aria-busy={reviewBusy} onClick={evaluate}>{reviewBusy ? 'Đang đánh giá…' : 'Đánh giá số liệu'}</button>
        {reviewError && <p role="alert">{reviewError}</p>}
        {review && <div><p>Điểm: {review.score}/100 · {review.text}</p><p>{review.reason}</p></div>}
      </Card>
      {stale && (
        <div class="text-[12.5px] w-full min-w-0" style={{ color: WARN }}>
          Kết nối đang hết hạn nên đây là số liệu cũ{dto.lastSnapshotAt ? `, chụp lúc ${fmtSlot(dto.lastSnapshotAt)}` : ''}. Kết nối lại để cập nhật.
        </div>
      )}
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12.5px] text-[var(--color-text-muted)] -mt-1">
        <span><strong class="font-semibold text-[var(--color-text)]">{account.name}</strong> · {dayLabel(dto.range.from)}–{dayLabel(dto.range.to)} (gồm hôm nay)</span>
        {finite(target) && <span>Mục tiêu {r.cpa} ≤ {fmtMoney(target, cur)}</span>}
        {!stale && dto.lastSnapshotAt && <span>Số liệu chụp lúc {fmtSlot(dto.lastSnapshotAt)}, tự cập nhật mỗi giờ</span>}
        <span>Quy đổi 7 ngày click, 1 ngày xem</span>
      </div>
      {!finite(target) && <TargetPrompt account={account} suggested={dto.suggestedTargetCpa} />}

      <AdsQueue dto={dto} account={account} acted={acted} busy={busy} onAct={act} />

      <section aria-label={`Chỉ số ${days} ngày`} class="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(165px, 1fr))' }}>
        <KpiTile label={`Chi tiêu ${days} ngày`} value={fmtMoney(k.spend, cur)} delta={<Delta v={cmp(k.spend, k.spendPrev, 'none')} />} />
        <KpiTile label="Chi hôm nay (đến giờ)" value={fmtMoney(k.spendToday, cur)} delta={<span class="text-[var(--color-text-muted)]">TB {fmtMoney(k.spend / Math.max(1, days), cur)}/ngày trong kỳ</span>} />
        <KpiTile
          label="Tháng này"
          value={fmtMoney(k.spendMonth, cur)}
          delta={pace ? undefined : <span class="text-[var(--color-text-muted)]">Đặt ngân sách tháng để theo dõi nhịp</span>}
        >
          {pace && (
            <div class="flex flex-col gap-1 mt-1">
              <div class="relative h-1.5 rounded-full" style={{ background: TRACK }} role="img" aria-label={`Đã chi ${fmtDec(pace.spentPct, 0)}% ngân sách tháng, đã qua ${fmtDec(pace.elapsedPct, 0)}% tháng`}>
                <div class="h-1.5 rounded-full" style={{ width: `${Math.min(100, pace.spentPct)}%`, background: SERIES }} />
                <div class="absolute" style={{ left: `${Math.min(100, pace.elapsedPct)}%`, top: '-3px', width: '2px', height: '12px', background: 'var(--color-text-muted)' }} />
              </div>
              <span class="text-[11.5px]" style={{ color: paceDiff > 10 ? WARN : 'var(--color-text-muted)' }}>{fmtDec(pace.spentPct, 0)}% ngân sách · {paceText}</span>
            </div>
          )}
        </KpiTile>
        <KpiTile label={RESULT_META[account.resultType].name} value={fmtInt(k.results)} delta={<Delta v={cmp(k.results, k.resultsPrev, 'up')} />} />
        <KpiTile
          label={`${r.cpa} trung bình`}
          value={fmtMoney(k.cpa, cur)}
          delta={<><Delta v={cmp(k.cpa, k.cpaPrev, 'down')} idle={prevIdle} />{finite(target) && <span class="text-[var(--color-text-muted)]"> · mục tiêu {fmtMoney(target, cur)}</span>}</>}
        />
        {k.purchases !== null && account.resultType !== 'purchase' && (
          <KpiTile label="Đơn hàng" value={fmtInt(k.purchases)} delta={<span class="text-[var(--color-text-muted)]">{k.results > 0 ? `${fmtPct((k.purchases / k.results) * 100)} ${r.noun} → đơn` : ''}</span>} />
        )}
        {k.roas !== null && <KpiTile label="ROAS" value={fmtDec(k.roas, 2)} delta={<span class="text-[var(--color-text-muted)]">Doanh thu ÷ chi tiêu</span>} />}
        <KpiTile label="CTR link" value={fmtPct(k.ctr, 2)} delta={ctrD ? <span style={{ color: toneColor(ctrTone) }}>{ctrD.text}</span> : <span class="text-[var(--color-text-muted)]">{prevIdle ? 'Kỳ trước chưa chạy' : 'Chưa có kỳ trước để so'}</span>} />
        <KpiTile label="CPM" value={fmtMoney(k.cpm, cur)} delta={<Delta v={cmp(k.cpm, k.cpmPrev, 'down')} idle={prevIdle} />} />
      </section>

      <div class="flex flex-wrap gap-4">
        <Card
          class="flex-[1_1_440px]"
          title={`Chi tiêu mỗi ngày, ${n} ngày`}
          aside={<span role="status" class="tabular-nums text-[var(--color-text)]">{dayReadout}</span>}
        >
          {n === 0 ? (
            <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Chưa có số liệu theo ngày.</p>
          ) : (
            <>
              <DailyBars
                groupLabel="Chi tiêu theo ngày"
                height={150}
                values={spendVals}
                labels={daily.map((d) => dayLabel(d.day))}
                active={hd}
                onActive={setHd}
                formatAxis={(v) => moneyAxis(v, cur)}
                faded={(i) => i < half}
                ariaOf={ariaDay}
              />
              <Legend items={[{ label: `${half} ngày trước đó`, color: 'rgba(57, 135, 229, 0.5)' }, { label: `${n - half} ngày gần nhất`, color: SERIES }]} />
            </>
          )}
        </Card>

        <Card
          class="flex-[1_1_440px]"
          title={`${r.cpa} mỗi ngày, ${n} ngày`}
          aside={<Legend items={[{ label: r.cpa, color: SERIES, kind: 'line' }, ...(finite(target) ? [{ label: `Mục tiêu ${moneyAxis(target, cur)}`, color: 'var(--color-text-muted)', kind: 'dash' as const }] : [])]} />}
        >
          {cpaNums.length === 0 ? (
            <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Chưa ngày nào có {r.noun}, nên chưa tính được {r.cpa}.</p>
          ) : (
            <>
              <LineChart
                groupLabel={`${r.cpa} theo ngày`}
                labels={daily.map((d) => dayLabel(d.day))}
                series={[{ name: r.cpa, color: SERIES, values: cpaVals, endLabel: finite(lastCpa) ? moneyAxis(lastCpa, cur) : null }]}
                yTicks={cpaTicks}
                fmtY={(v) => moneyAxis(v, cur)}
                target={finite(target) ? { value: target } : null}
                height={170}
                active={hd}
                onActive={setHd}
                ariaOf={ariaDay}
              />
              <div class="text-[13px] text-[var(--color-text-muted)]">Ngày không có {r.noun} để trống thay vì vẽ về 0. Rê chuột hoặc dùng phím Tab để xem từng ngày ở cả hai biểu đồ.</div>
            </>
          )}
        </Card>
      </div>

      <AdsTree tree={dto.tree} account={account} />

      <div class="flex flex-wrap gap-4">
        {finite(target) && <Card class="flex-[1_1_440px]" title={`Nhóm quảng cáo: chi tiêu × ${r.cpa}`} aside={<span role="status">{hqSet ? `${hqSet.name}: chi ${fmtMoney(hqSet.spend, cur)}, ${hqSet.results} ${r.noun}` : ' '}</span>}>
          {!finite(target) ? (
            <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Đặt {r.cpa} mục tiêu trong “Tài khoản & mục tiêu” để vẽ ma trận này.</p>
          ) : points.length === 0 ? (
            <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Chưa có nhóm quảng cáo nào có số liệu.</p>
          ) : (
            <>
              <Quadrant
                groupLabel="Ma trận chi tiêu và giá mỗi kết quả của các nhóm quảng cáo"
                height={270}
                points={points}
                active={hq}
                onActive={setHq}
                quads={{ tl: 'Đắt, chi còn ít: cắt khi đủ dữ liệu', tr: 'Đắt và tốn tiền: cắt', bl: 'Rẻ, còn nhỏ: tăng ngân sách', br: 'Rẻ và lớn: trụ cột', tones: { tr: 'bad', bl: 'good' } }}
                yLabels={{ top: '×2,0', mid: '×1,0', bottom: '0' }}
                xLabels={['0', `Chi ${days} ngày`, fmtMoney(maxSpend, cur)]}
              />
              <div class="text-[13px] text-[var(--color-text-muted)]">Trục dọc: {r.cpa} ÷ mục tiêu (cao hơn là đắt hơn; nhóm chưa có kết quả nằm sát đỉnh). Kích thước chấm theo số {r.noun}.</div>
            </>
          )}
        </Card>}

        <Card class="flex-[1_1_440px]" title={`Phễu ${days} ngày: rò ở đâu`} aside="Ghi chú lấy theo ngưỡng tốt của tài khoản">
          {dto.funnel.length === 0 ? <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Chưa có số liệu phễu.</p> : <Funnel steps={steps} />}
        </Card>
      </div>

      {!stale && <AudienceSection account={account} days={days} />}

      <CreativesSection creatives={dto.creatives} account={account} />

      <div class="flex flex-wrap gap-4">
        <PlacementsSection placements={dto.placements} account={account} />
        <OrganicSection available={dto.organicAvailable === true} items={dto.organicCandidates} />
      </div>
    </>
  );
}

