/**
 * Finance › P&L & dòng tiền: the company P&L built from ERP (education), Whop, Meta Ads, AI cost and the manual
 * ledger (src/pnl). Tabs: overview, programs, ads attribution, ledger, method. Every number names its source;
 * estimates carry a badge and gaps are listed under "Cần chú ý".
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { Banknote, Megaphone, RefreshCw, ShoppingCart, Target, TrendingUp } from 'lucide-preact';

import { PageHeader, Tab } from '@/components/PageHeader';
import { ComboChart } from '@/components/dashboard/charts';
import { Legend } from '@/components/fb/charts/Legend';
import { ORANGE, SERIES, niceTicks } from '@/components/fb/charts/chart-utils';
import { IssueList, KpiTile, Meter, MixBar, Statement, Waterfall } from '../components/pnl/PnlParts';
import { ProfitDashboard } from './ProfitDashboard';
import { apiGet, apiPost, apiPut, ApiError } from '@/lib/api';
import {
  ADS_OUT, ADS_SHARED, ADS_UNASSIGNED, PRESETS, bpsPct, deltaOf, dm, dmy, pct, pnlUrl, syncedLabel, times, vndFull, vndShort, waterfallSteps,
  type PnlCampaign, type PnlDto, type PnlIssue, type PnlPreset, type PnlProgram, type PnlSettings,
} from '../lib/pnl';

type TabId = 'overview' | 'programs' | 'ads' | 'ledger' | 'method';
const TABS: Array<[TabId, string]> = [['overview', 'Tổng quan'], ['programs', 'Chương trình'], ['ads', 'Phân bổ Ads'], ['ledger', 'Sổ thu chi'], ['method', 'Cách tính']];
const ERP_COLOR = '#3987e5';
const WHOP_COLOR = '#8b5cf6';
const OTHER_COLOR = '#c98500';
const vnToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
const API = '/api/m/finance';
const errorText = (e: unknown) => (e instanceof ApiError ? (e.body as { error?: string })?.error ?? e.message : e instanceof Error ? e.message : 'Không thực hiện được');

function loadPref<T extends string>(key: string, fallback: T): T {
  try { return (localStorage.getItem(key) as T) || fallback; } catch { return fallback; }
}
function savePref(key: string, v: string) { try { localStorage.setItem(key, v); } catch { /* private mode */ } }

export function Pnl() {
  const [tab, setTab] = useState<TabId>(() => loadPref<TabId>('pnl.tab', 'overview'));
  const [preset, setPreset] = useState<PnlPreset>(() => loadPref<PnlPreset>('pnl.preset', 'month'));
  const [from, setFrom] = useState(`${vnToday().slice(0, 7)}-01`);
  const [to, setTo] = useState(vnToday());
  const [dto, setDto] = useState<PnlDto | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const url = pnlUrl(preset, from, to);
  async function load() {
    try { setDto(await apiGet<PnlDto>(url)); setError(''); } catch (e) { setError(errorText(e)); }
  }
  useEffect(() => { void load(); }, [url]);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => { savePref('pnl.tab', tab); mainRef.current?.scrollTo({ top: 0 }); }, [tab]);
  useEffect(() => { savePref('pnl.preset', preset); }, [preset]);

  async function refresh() {
    setBusy(true); setMsg('');
    try { await apiPost(`${API}/pnl/refresh`); await load(); setMsg('Đã cập nhật dữ liệu ERP và Whop.'); }
    catch (e) { setMsg(errorText(e)); } finally { setBusy(false); }
  }
  async function saveSettings(patch: Partial<PnlSettings>) {
    try { await apiPut(`${API}/pnl/settings`, patch); await load(); setMsg('Đã lưu.'); } catch (e) { setMsg(errorText(e)); }
  }
  const onAction = (a: NonNullable<PnlIssue['action']>) => setTab(a === 'fx' || a === 'ads' ? 'ads' : a === 'ledger' ? 'ledger' : tab);

  return (
    <div class="flex h-full min-w-0 flex-col overflow-hidden select-text pl-page">
      <PageHeader title="P&L & dòng tiền" breadcrumb="Finance"
        actions={<>
          <span class="pl-sync" title="ERP đồng bộ mỗi 15 phút, Whop mỗi 30 phút">ERP {syncedLabel(dto?.erp.syncedAt ?? null)} · Whop {syncedLabel(dto?.whop.syncedAt ?? null)}</span>
          <button type="button" class="pl-btn" disabled={busy} onClick={refresh}><RefreshCw size={13} class={busy ? 'animate-spin' : ''} /> {busy ? 'Đang cập nhật…' : 'Cập nhật dữ liệu'}</button>
        </>}
        tabs={<>{TABS.map(([id, label]) => <Tab key={id} label={label} active={tab === id} onClick={() => setTab(id)} />)}</>} />
      <main ref={mainRef} class="min-w-0 flex-1 overflow-auto p-4 md:p-6">
        <div class="pl-wrap">
          {tab !== 'ledger' && tab !== 'method' ? (
            <div class="pl-toolbar">
              <div class="pl-seg" role="tablist" aria-label="Kỳ báo cáo">
                {PRESETS.map((p) => <button key={p.id} type="button" role="tab" aria-selected={preset === p.id} class={preset === p.id ? 'is-on' : ''} onClick={() => setPreset(p.id)}>{p.label}</button>)}
              </div>
              {preset === 'custom' ? (
                <div class="pl-dates">
                  <input type="date" aria-label="Từ ngày" value={from} max={to} onChange={(e) => setFrom(e.currentTarget.value)} />
                  <span>→</span>
                  <input type="date" aria-label="Đến ngày" value={to} min={from} max={vnToday()} onChange={(e) => setTo(e.currentTarget.value)} />
                </div>
              ) : null}
              {dto ? <span class="pl-range">{dto.range.label} · so với {dto.prevRange.label}</span> : null}
            </div>
          ) : null}
          {msg ? <p role="status" class="pl-msg">{msg}</p> : null}
          {error ? <p role="alert" class="pl-msg is-error">{error}</p> : null}
          {!dto && !error && tab !== 'ledger' && tab !== 'method' ? <div class="pl-card pl-skeleton" aria-busy="true" /> : null}
          {dto && tab === 'overview' ? <Overview dto={dto} onAction={onAction} onTab={setTab} /> : null}
          {dto && tab === 'programs' ? <Programs dto={dto} /> : null}
          {dto && tab === 'ads' ? <Ads dto={dto} onSave={saveSettings} /> : null}
          {tab === 'ledger' ? <ProfitDashboard embedded /> : null}
          {tab === 'method' ? <Method /> : null}
        </div>
      </main>
    </div>
  );
}

// ── Overview ──────────────────────────────────────────────────────────────────

function Overview({ dto, onAction, onTab }: { dto: PnlDto; onAction: (a: NonNullable<PnlIssue['action']>) => void; onTab: (t: TabId) => void }) {
  const k = dto.kpis;
  const cmp = `so với ${dto.prevRange.label}`;
  const ledgerRevenue = dto.statement.find((l) => l.key === 'gross')?.children?.find((c) => c.key === 'gross:ledger')?.value ?? 0;
  return (
    <div class="pl-stack">
      <IssueList issues={dto.issues} onAction={onAction} />

      <section class="pl-kpis" aria-label="Chỉ số chính">
        <KpiTile icon={Banknote} label="Doanh thu thuần" value={vndShort(k.netRevenue)} delta={deltaOf(dto, 'netRevenue')} compare={cmp}
          sub={<>Gộp {vndShort(k.grossRevenue)}</>} title={vndFull(k.netRevenue)} />
        <KpiTile icon={TrendingUp} label="Lợi nhuận ròng" value={vndShort(k.netProfit)} tone={k.netProfit >= 0 ? 'good' : 'bad'}
          delta={deltaOf(dto, 'netProfit')} compare={cmp} sub={<>Biên {pct(k.margin, 1)}</>} title={vndFull(k.netProfit)} />
        <KpiTile icon={Megaphone} label="Marketing" value={vndShort(k.marketing)} delta={deltaOf(dto, 'marketing')} deltaInverse compare={cmp}
          sub={<>ROAS {times(k.roas)}</>} title={vndFull(k.marketing)} />
        <KpiTile icon={ShoppingCart} label="Đơn ERP đã trả" value={String(k.paidOrders)} delta={deltaOf(dto, 'paidOrders')} compare={cmp}
          sub={<>AOV {vndShort(k.aov)} · chuyển đổi {pct(k.conversion, 1)}</>} />
        <KpiTile icon={Target} label="CAC / đơn ERP" value={vndShort(k.cac)} delta={deltaOf(dto, 'cac')} deltaInverse compare={cmp}
          sub={<>{k.registrations.toLocaleString('vi-VN')} đăng ký</>} title="Chi phí marketing / số đơn ERP đã trả" />
      </section>

      <div class="pl-grid">
        <section class="pl-card" aria-labelledby="pl-st">
          <header class="pl-card-head"><h2 id="pl-st">Báo cáo lãi lỗ <small>{dmy(dto.range.from)} – {dmy(dto.range.to)}</small></h2></header>
          <Statement lines={dto.statement} />
        </section>
        <div class="pl-stack">
          <section class="pl-card" aria-labelledby="pl-wf">
            <header class="pl-card-head"><h2 id="pl-wf">Dòng chảy lợi nhuận</h2></header>
            <Waterfall steps={waterfallSteps(dto.statement)} />
          </section>
          <section class="pl-card" aria-labelledby="pl-mix">
            <header class="pl-card-head"><h2 id="pl-mix">Cơ cấu doanh thu gộp</h2></header>
            <MixBar parts={[
              { label: 'ERP · giáo dục', value: k.erpRevenue, color: ERP_COLOR },
              { label: 'Whop', value: dto.whop.grossUsd * dto.settings.usdVnd, color: WHOP_COLOR, hint: `$${dto.whop.grossUsd.toFixed(2)}` },
              ...(ledgerRevenue ? [{ label: 'Khác (sổ thu chi)', value: ledgerRevenue, color: OTHER_COLOR }] : []),
            ]} />
            <div class="pl-split">
              <div><span>Whop thực nhận</span><strong>{vndShort(k.whopNet)}</strong><em>${dto.whop.netUsd.toFixed(0)} sau hoàn ${dto.whop.refundedUsd.toFixed(0)}, phí ${dto.whop.feesUsd.toFixed(0)}</em></div>
              <div><span>ERP công ty giữ</span><strong>{vndShort(k.erpRevenue - (dto.statement.find((l) => l.key === 'partners')?.value ?? 0))}</strong><em>gồm quỹ Ads {vndShort(k.adsFund)}</em></div>
            </div>
          </section>
          <section class="pl-card" aria-labelledby="pl-fund">
            <header class="pl-card-head"><h2 id="pl-fund">Quỹ Ads ERP và chi Ads thực</h2></header>
            {k.adsFund ? (
              <>
                <div class="pl-fund-row"><span>Quỹ Ads trích từ đơn ERP</span><strong>{vndShort(k.adsFund)}</strong></div>
                <Meter value={k.adsFund} max={Math.max(k.adsFund, dto.ads.inScope)} color={ERP_COLOR} label="Quỹ Ads" />
                <div class="pl-fund-row"><span>Chi Meta Ads trong phạm vi</span><strong>{vndShort(dto.ads.inScope)}</strong></div>
                <Meter value={dto.ads.inScope} max={Math.max(k.adsFund, dto.ads.inScope)} color={ORANGE} label="Chi Ads" />
                <p class="pl-note">Chi Ads gấp <strong>{times(k.adsFundUse)}</strong> quỹ trích được. Quỹ Ads là phần chính sách chia giữ lại cho quảng cáo (đã nằm trong doanh thu giữ lại).</p>
              </>
            ) : <p class="pl-note">Chưa có đơn ERP hoặc chưa đọc được chính sách chia trong kỳ.</p>}
          </section>
        </div>
      </div>

      <DailyCard dto={dto} />
      <ProgramsMini dto={dto} onMore={() => onTab('programs')} />
    </div>
  );
}

function DailyCard({ dto }: { dto: PnlDto }) {
  const [active, setActive] = useState<number | null>(null);
  const rows = dto.daily;
  const bars = rows.map((d) => (d.erpRevenue ?? 0) + d.whopNet);
  const line = rows.map((d) => d.ads);
  const ticks = niceTicks(0, Math.max(1, ...bars, ...line), 4);
  const undated = dto.erp.undated.reduce((s, u) => s + u.revenue, 0);
  if (rows.length < 2) return null;
  return (
    <section class="pl-card" aria-labelledby="pl-daily">
      <header class="pl-card-head">
        <h2 id="pl-daily">Doanh thu và chi Ads theo ngày</h2>
        <Legend items={[{ label: 'Doanh thu (ERP theo ngày + Whop thực nhận)', color: SERIES }, { label: 'Chi Meta Ads', color: ORANGE, kind: 'line' }]} />
      </header>
      <ComboChart labels={rows.map((d) => dm(d.date))} bars={bars} line={line} yTicks={ticks} fmtY={(v) => vndShort(v)}
        barColor={SERIES} lineColor={ORANGE} active={active} onActive={setActive} groupLabel="Theo ngày"
        ariaOf={(i) => `${dmy(rows[i].date)}: doanh thu ${vndShort(bars[i])}, Ads ${vndShort(line[i])}`}
        tooltip={(i) => {
          const d = rows[i];
          return (
            <div class="pl-daytip">
              <strong>{dmy(d.date)}</strong>
              <span>ERP <b>{d.erpRevenue === null ? 'chưa có theo ngày' : vndFull(d.erpRevenue)}</b></span>
              <span>Whop thực nhận <b>{vndFull(d.whopNet)}</b></span>
              <span>Chi Ads <b>{vndFull(d.ads)}</b></span>
              {d.ai ? <span>AI <b>{vndFull(d.ai)}</b></span> : null}
              <span>Lãi ngày <b class={d.profit !== null && d.profit < 0 ? 'is-bad' : ''}>{d.profit === null ? '—' : vndFull(d.profit)}</b></span>
            </div>
          );
        }} />
      {undated > 0 ? (
        <p class="pl-note">{vndFull(undated)} doanh thu ERP ({dto.erp.undated.map((u) => `${dm(u.from)}–${dm(u.to)}`).join(', ')}) đã tính trong tổng nhưng chưa chia được theo ngày: ERP chỉ trả số theo kỳ, lịch sử từng ngày bắt đầu từ lần đồng bộ đầu tiên.</p>
      ) : null}
    </section>
  );
}

function ProgramsMini({ dto, onMore }: { dto: PnlDto; onMore: () => void }) {
  const rows = dto.programs.filter((p) => (p.registrations ?? 0) > 0 || p.ads > 0 || (p.paidOrders ?? 0) > 0);
  if (!rows.length) return null;
  const maxAds = Math.max(1, ...rows.map((p) => p.ads));
  return (
    <section class="pl-card" aria-labelledby="pl-prog">
      <header class="pl-card-head"><h2 id="pl-prog">Hiệu quả theo chương trình</h2><button type="button" class="pl-link" onClick={onMore}>Chi tiết</button></header>
      <div class="pl-table-wrap">
        <table class="pl-table">
          <thead><tr><th>Chương trình</th><th class="num">Đăng ký</th><th class="num">Đơn trả</th><th class="num">Chuyển đổi</th><th>Chi Ads</th><th class="num">CPL</th><th class="num">CAC</th></tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.code}>
              <td><strong>{p.title}</strong><div class="pl-muted text-[11px]">{p.code}</div></td>
              <td class="num">{p.registrations ?? '—'}</td>
              <td class="num">{p.paidOrders ?? '—'}</td>
              <td class="num">{pct(p.conversion, 1)}</td>
              <td><div class="pl-inline-bar"><i style={{ width: `${(p.ads / maxAds) * 100}%` }} /><span>{vndShort(p.ads)}</span></div></td>
              <td class="num">{vndShort(p.cpl)}</td>
              <td class={`num${p.cac !== null && p.cac > (dto.kpis.aov ?? Infinity) ? ' is-bad' : ''}`}>{p.paidOrders === 0 && p.ads > 0 ? <span class="is-bad">chưa có đơn</span> : vndShort(p.cac)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p class="pl-note">CPL = chi Ads / đăng ký trong kỳ; CAC = chi Ads / đơn đã trả. ERP chưa trả doanh thu theo chương trình nên chưa tính lãi lỗ riêng từng chương trình. {dto.otherOrders ? `${dto.otherOrders} đơn ngoài chương trình (vd. phần mềm).` : ''}</p>
    </section>
  );
}

// ── Programs ──────────────────────────────────────────────────────────────────

const ROLE_LABEL: Record<string, string> = { Author: 'Tác giả', Instructor: 'Giảng viên', Affiliate: 'Affiliate', Sales: 'Sales', AdsFund: 'Quỹ Ads' };
const ROLE_COLOR: Record<string, string> = { AdsFund: ORANGE, Author: '#8b5cf6', Instructor: '#199e70', Sales: '#c98500', Affiliate: '#e05a5a' };

function Programs({ dto }: { dto: PnlDto }) {
  if (!dto.programs.length) return <p class="pl-card">Chưa có danh mục chương trình từ ERP. Bấm Cập nhật dữ liệu.</p>;
  return (
    <div class="pl-stack">
      {dto.programs.map((p) => <ProgramCard key={p.code} p={p} aov={dto.kpis.aov} />)}
    </div>
  );
}

function ProgramCard({ p, aov }: { p: PnlProgram; aov: number | null }) {
  const f = p.funnel;
  const steps = f ? [['Đăng ký', f.registrations], ['Checkout', f.checkouts], ['Tạo đơn', f.orders], ['Đã trả', f.paid_orders]] as const : [];
  const top = Math.max(1, ...steps.map(([, v]) => v));
  const pol = p.policy;
  const company = pol ? 10_000 - pol.adsFundBps - pol.roles.reduce((s, r) => s + r.bps, 0) : 0;
  return (
    <section class="pl-card pl-program">
      <header class="pl-card-head">
        <h2>{p.title} <small>{p.code}</small></h2>
        <div class="pl-chips">
          <span class={`pl-chip is-${p.status.toLowerCase()}`}>{p.status}</span>
          {p.type ? <span class="pl-chip">{p.type}</span> : null}
          {p.start ? <span class="pl-chip">{dmy(p.start)}{p.end && p.end !== p.start ? ` → ${dmy(p.end)}` : ''}</span> : null}
        </div>
      </header>
      <div class="pl-metrics">
        <div><span>Đăng ký (kỳ)</span><strong>{p.registrations ?? '—'}</strong></div>
        <div><span>Đơn đã trả (kỳ)</span><strong>{p.paidOrders ?? '—'}</strong></div>
        <div><span>Chuyển đổi</span><strong>{pct(p.conversion, 1)}</strong></div>
        <div><span>Chi Ads</span><strong>{vndShort(p.ads)}</strong></div>
        <div><span>Kết quả Meta</span><strong>{p.adsResults.toLocaleString('vi-VN')}</strong></div>
        <div><span>CPL</span><strong>{vndShort(p.cpl)}</strong></div>
        <div><span>CAC</span><strong class={p.cac !== null && aov !== null && p.cac > aov ? 'is-bad' : ''}>{p.paidOrders === 0 && p.ads > 0 ? 'chưa có đơn' : vndShort(p.cac)}</strong></div>
      </div>
      <div class="pl-program-grid">
        <div>
          <h3>Phễu từ đầu chương trình</h3>
          {f ? (
            <ol class="pl-funnel">
              {steps.map(([label, v], i) => (
                <li key={label}>
                  <span>{label}</span>
                  <div class="pl-funnel-bar"><i style={{ width: `${Math.max(1.5, (v / top) * 100)}%` }} /></div>
                  <strong>{v.toLocaleString('vi-VN')}</strong>
                  <em>{i > 0 && steps[i - 1][1] > 0 ? pct(v / steps[i - 1][1], 0) : ''}</em>
                </li>
              ))}
            </ol>
          ) : <p class="pl-note">ERP chưa trả phễu cho chương trình này.</p>}
        </div>
        <div>
          <h3>Gói bán</h3>
          {p.offers.length ? (
            <ul class="pl-offers">{p.offers.map((o) => <li key={o.code}><span>{o.title}</span><strong>{o.price ? vndShort(o.price) : 'Miễn phí'}</strong>{o.orderCount !== null ? <em>{o.orderCount} đơn</em> : null}</li>)}</ul>
          ) : <p class="pl-note">Chưa có gói bán.</p>}
          {pol ? (
            <>
              <h3 class="mt-4">Chia doanh thu <small class="pl-muted">{pol.title}</small></h3>
              <div class="pl-mix" role="img" aria-label="Tỷ lệ chia">
                <i style={{ width: `${pol.adsFundBps / 100}%`, background: ROLE_COLOR.AdsFund }} title={`Quỹ Ads ${bpsPct(pol.adsFundBps)}`} />
                {pol.roles.map((r) => <i key={r.role} style={{ width: `${r.bps / 100}%`, background: ROLE_COLOR[r.role] ?? '#999' }} title={`${ROLE_LABEL[r.role] ?? r.role} ${bpsPct(r.bps)}`} />)}
                <i style={{ width: `${company / 100}%`, background: ERP_COLOR }} title={`Công ty ${bpsPct(company)}`} />
              </div>
              <ul class="pl-mix-legend is-inline">
                <li><span><i style={{ background: ROLE_COLOR.AdsFund }} />Quỹ Ads</span><em>{bpsPct(pol.adsFundBps)}</em></li>
                {pol.roles.map((r) => <li key={r.role}><span><i style={{ background: ROLE_COLOR[r.role] ?? '#999' }} />{ROLE_LABEL[r.role] ?? r.role}</span><em>{bpsPct(r.bps)}</em></li>)}
                <li><span><i style={{ background: ERP_COLOR }} />Công ty</span><em>{bpsPct(company)}</em></li>
                {pol.affiliateBps ? <li><span><i style={{ background: ROLE_COLOR.Affiliate }} />Affiliate (khi có)</span><em>{bpsPct(pol.affiliateBps)}</em></li> : null}
              </ul>
              <p class="pl-note">Tỷ lệ trên đơn không qua affiliate, theo chính sách cấu hình. Vai trò để trống (vd. chương trình không có tác giả) thì phần đó về công ty.</p>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

// ── Ads attribution ───────────────────────────────────────────────────────────

function Ads({ dto, onSave }: { dto: PnlDto; onSave: (patch: Partial<PnlSettings>) => Promise<void> }) {
  const [fx, setFx] = useState(String(dto.settings.usdVnd));
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [outAcc, setOutAcc] = useState<string[]>(dto.settings.outAccounts);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setFx(String(dto.settings.usdVnd)); setOutAcc(dto.settings.outAccounts); }, [dto.settings]);

  const targets = useMemo(() => [
    ...dto.programs.map((p) => ({ id: p.code, label: p.title })),
    { id: ADS_SHARED, label: 'Chung / thương hiệu' },
    { id: ADS_OUT, label: 'Ngoài P&L (vd. Amazon)' },
  ], [dto.programs]);
  const dirty = Object.keys(edits).length > 0 || outAcc.join() !== dto.settings.outAccounts.join();
  async function save() {
    setSaving(true);
    const campaigns = { ...dto.settings.campaigns };
    for (const [k, v] of Object.entries(edits)) { if (v === '') delete campaigns[k]; else campaigns[k] = v; }
    await onSave({ campaigns, outAccounts: outAcc });
    setEdits({}); setSaving(false);
  }
  const fxNum = Number(fx.replace(/[^\d]/g, ''));
  const byLabel = new Map(targets.map((t) => [t.id, t.label]));
  const groupTotal = dto.ads.byTarget;

  return (
    <div class="pl-stack">
      <section class="pl-card">
        <header class="pl-card-head"><h2>Tỷ giá USD → VND</h2>{dto.settings.usdVndConfirmed ? <span class="pl-chip is-open">Đã xác nhận</span> : <span class="pl-chip is-warn">Tạm tính</span>}</header>
        <div class="pl-fx">
          <input inputMode="numeric" aria-label="Tỷ giá" value={fx} onInput={(e) => setFx(e.currentTarget.value)} />
          <span>đ / 1 USD</span>
          <button type="button" class="pl-btn is-primary" disabled={!(fxNum >= 1000 && fxNum <= 100_000)} onClick={() => onSave({ usdVnd: fxNum, usdVndConfirmed: true })}>Lưu tỷ giá</button>
        </div>
        <p class="pl-note">Dùng cho Whop (${dto.whop.grossUsd.toFixed(2)} gộp trong kỳ), chi phí AI và các dòng USD trong sổ thu chi. Nên dùng tỷ giá ngân hàng nhận tiền Whop.</p>
      </section>

      <section class="pl-card">
        <header class="pl-card-head"><h2>Chi Ads theo nhóm <small>{dto.range.label}</small></h2></header>
        <ul class="pl-bars">
          {groupTotal.map((g) => (
            <li key={g.target} class={g.target === ADS_OUT ? 'is-out' : g.target === ADS_UNASSIGNED ? 'is-warn' : ''}>
              <span>{g.label}</span>
              <div class="pl-inline-bar"><i style={{ width: `${(g.spend / Math.max(1, groupTotal[0]?.spend ?? 1)) * 100}%` }} /></div>
              <strong>{vndShort(g.spend)}</strong>
            </li>
          ))}
        </ul>
        <p class="pl-note">Trong P&L: {vndFull(dto.ads.inScope)} · ngoài P&L: {vndFull(dto.ads.outOfScope)}. "Chưa phân bổ" vẫn tính vào chi phí công ty cho tới khi được gán.</p>
      </section>

      <section class="pl-card">
        <header class="pl-card-head"><h2>Tài khoản quảng cáo</h2></header>
        <ul class="pl-accounts">
          {dto.ads.accounts.map((a) => {
            const auto = a.out && !dto.settings.outAccounts.includes(a.id);
            const manual = outAcc.includes(a.id);
            const out = auto || manual;
            return (
              <li key={a.id}>
                <div><strong>{a.name}</strong><span class="pl-muted">{a.id}</span></div>
                <span>{vndShort(a.spend)}</span>
                <label class="pl-toggle">
                  <input type="checkbox" checked={!out} disabled={auto} title={auto ? 'Tài khoản Amazon: luôn ngoài P&L' : undefined}
                    onChange={(e) => setOutAcc(e.currentTarget.checked ? outAcc.filter((x) => x !== a.id) : [...outAcc, a.id])} />
                  {out ? (auto ? 'Ngoài P&L (tự nhận diện)' : 'Ngoài P&L') : 'Tính vào P&L'}
                </label>
              </li>
            );
          })}
        </ul>
      </section>

      <section class="pl-card">
        <header class="pl-card-head">
          <h2>Chiến dịch <small>{dto.ads.campaigns.length} chiến dịch có chi tiêu trong kỳ</small></h2>
          <button type="button" class="pl-btn is-primary" disabled={!dirty || saving} onClick={save}>{saving ? 'Đang lưu…' : 'Lưu phân bổ'}</button>
        </header>
        <div class="pl-table-wrap">
          <table class="pl-table">
            <thead><tr><th>Chiến dịch</th><th class="num">Chi tiêu</th><th class="num">Kết quả</th><th>Gán vào</th></tr></thead>
            <tbody>{dto.ads.campaigns.map((c) => <CampaignRow key={c.key} c={c} targets={targets} value={edits[c.key]} label={byLabel}
              onChange={(v) => setEdits({ ...edits, [c.key]: v })} manual={dto.settings.campaigns[c.key]} />)}</tbody>
          </table>
        </div>
        <p class="pl-note">Tự nhận diện theo tên chiến dịch (6X, "5 ngày", Second Brain / "nhớ đã lưu", edit video, amz…). Chọn tay sẽ ghi đè; chọn "Tự động" để bỏ ghi đè. Áp dụng cho mọi kỳ.</p>
      </section>
    </div>
  );
}

function CampaignRow({ c, targets, value, onChange, manual, label }: {
  c: PnlCampaign; targets: Array<{ id: string; label: string }>; value: string | undefined; onChange: (v: string) => void; manual: string | undefined; label: Map<string, string>;
}) {
  const current = value !== undefined ? value : (manual ?? '');
  const autoLabel = c.by === 'auto' ? `Tự động: ${label.get(c.target) ?? c.target}` : c.by === 'account' ? 'Tự động: ngoài P&L (tài khoản)' : 'Tự động: chưa nhận diện';
  return (
    <tr class={c.target === ADS_UNASSIGNED && !current ? 'is-warn' : c.target === ADS_OUT ? 'is-out' : ''}>
      <td><strong>{c.name}</strong><div class="pl-muted text-[11px]">{c.accountName} · đến {dm(c.lastDay)}{c.by === 'auto' && c.rule ? ` · ${c.rule}` : ''}</div></td>
      <td class="num">{vndShort(c.spend)}</td>
      <td class="num">{c.results.toLocaleString('vi-VN')}</td>
      <td>
        <select aria-label={`Gán ${c.name}`} value={current} onChange={(e) => onChange(e.currentTarget.value)} class="pl-select">
          <option value="">{autoLabel}</option>
          {targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </td>
    </tr>
  );
}

// ── Method ────────────────────────────────────────────────────────────────────

function Method() {
  return (
    <div class="pl-grid is-even">
      <section class="pl-card">
        <header class="pl-card-head"><h2>Công thức</h2></header>
        <ol class="pl-method">
          <li><strong>Doanh thu gộp</strong> = doanh thu ERP (tiền thu thuần gồm VAT của đơn hợp lệ trả lần đầu) + Whop gross × tỷ giá + doanh thu khác trong sổ thu chi.</li>
          <li><strong>Giảm trừ</strong> = hoàn tiền Whop + phí Whop / affiliate Whop (gross − hoàn − net) + hoàn tiền trong sổ.</li>
          <li><strong>Chia đối tác ERP</strong> = doanh thu ERP − phần công ty (ERP) − quỹ Ads nội bộ. Quỹ Ads = doanh thu × tỷ lệ AdsFund của chính sách chia (30% với Second Brain, Bộ Skill Video; 0% với ReelStudio).</li>
          <li><strong>Doanh thu giữ lại</strong> = doanh thu thuần − chia đối tác (gồm quỹ Ads, vì quỹ là tiền công ty dành cho quảng cáo).</li>
          <li><strong>Marketing</strong> = Meta Ads của các chiến dịch trong phạm vi (không gồm "Ngoài P&L") + Ads ngoài Meta trong sổ.</li>
          <li><strong>Vận hành</strong> = chi phí AI của Freedom OS (USD × tỷ giá) + chi phí vận hành trong sổ.</li>
          <li><strong>Lợi nhuận ròng</strong> = doanh thu giữ lại − chi phí trực tiếp − marketing − vận hành − thuế.</li>
          <li><strong>ROAS</strong> = (doanh thu ERP + Whop gross) / Meta Ads trong phạm vi. <strong>CAC</strong> = marketing / đơn ERP đã trả.</li>
        </ol>
      </section>
      <section class="pl-card">
        <header class="pl-card-head"><h2>Nguồn & độ chính xác</h2></header>
        <ul class="pl-method">
          <li><strong>ERP</strong>: đồng bộ chỉ đọc mỗi 15 phút. ERP chỉ trả số theo hôm nay / tuần / tháng nên P&L dùng tổng tuần/tháng (chính xác) và số từng ngày từ lần đồng bộ đầu; ngày chưa có được báo ở "Cần chú ý", không đoán.</li>
          <li><strong>Whop</strong>: doanh thu gross / hoàn tiền / net theo ngày (giờ Việt Nam), đồng bộ mỗi 30 phút, lịch sử 1 năm.</li>
          <li><strong>Meta Ads</strong>: snapshot theo ngày của các tài khoản đang bật (Quảng cáo). Phần chi của tài khoản không có chi tiết chiến dịch tính vào "Chung".</li>
          <li><strong>Sổ thu chi</strong>: nhập tay các khoản các nguồn trên không có (lương, công cụ, mặt bằng, thuế…). Không nhập lại doanh thu ERP/Whop hay Meta Ads.</li>
          <li>Dòng có nhãn <span class="pl-badge">ước tính</span> có phần ước tính hoặc thiếu ngày. So sánh kỳ trước chỉ hiện khi kỳ trước có đủ dữ liệu ERP.</li>
        </ul>
        <p class="pl-note">Muốn chính xác hơn: xin admin ERP danh sách báo cáo được phép (<code>run_report</code>) có doanh thu theo ngày/chương trình để bổ sung lịch sử, và bật bảng kê đối tác để thay quỹ Ads ước tính bằng số chia thực tế. <Link href="/erp" class="underline">Xem dữ liệu ERP</Link></p>
      </section>
    </div>
  );
}

