import { useEffect, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { PageHeader, Tab } from '@/components/PageHeader';
import { apiGet, apiPost, ApiError } from '@/lib/api';

// Mirrors GET /api/m/finance/erp (server/routes.ts): read-only ERP data synced over MCP.
const API = '/api/m/finance';

const PANEL = 'min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-5';
const BUTTON = 'rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm hover:bg-[var(--color-control-hover)] disabled:opacity-40';
const TH = 'p-2 text-left border-b border-[var(--color-border)] font-medium';

type Period = 'today' | 'week' | 'month';
interface Summary {
  period: Period; from_date: string; to_date: string; revenue: number; paid_orders: number; registrations: number; company_share: number;
  programs?: Array<{ program: string; registrations: number; paid_orders: number; converted_people: number; conversion_rate_bps: number }>;
}
interface Snap<T> { payload: T; syncedAt: number }
interface Status { ok: boolean; at: number; error?: string; warning?: string; skipped: string[] }
interface Payload {
  hub: { id: string; name: string; status: string } | null;
  status: Status | null;
  summaries: Record<Period, Snap<Summary> | null>;
  unmatchedTransfers: Snap<{ transfers: Array<{ amount: number; bank_transaction: string; occurred_at: string }> }> | null;
  partnerStatements: Snap<{ statements: Array<Record<string, unknown>> }> | null;
  unpaidOrders: Snap<{ orders: Array<{ sales_order: string; offer: string; amount: number; transaction_date: string; payment_in_time: boolean }> }> | null;
  daily: Array<{ date: string; revenue: number; paid_orders: number; registrations: number; company_share: number }>;
}

const vnd = (v: number | null | undefined) => v === null || v === undefined ? '—' : new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(v);
const when = (sec: number | undefined) => sec ? new Date(sec * 1000).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '—';
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const PERIODS: Array<[Period, string]> = [['today', 'Hôm nay'], ['week', 'Tuần này'], ['month', 'Tháng này']];
function errorText(e: unknown) { return e instanceof ApiError ? (e.body as { error?: string })?.error ?? e.message : e instanceof Error ? e.message : 'Không thực hiện được'; }

export function Erp() {
  const [data, setData] = useState<Payload | null>(null);
  const [period, setPeriod] = useState<Period>('month');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function load() {
    try { setData(await apiGet<Payload>(`${API}/erp`)); } catch (e) { setMessage(errorText(e)); }
  }
  useEffect(() => { void load(); }, []);
  async function sync() {
    setBusy(true);
    try { await apiPost(`${API}/erp/sync`); setMessage('Đã đồng bộ dữ liệu ERP.'); } catch (e) { setMessage(errorText(e)); }
    finally { setBusy(false); await load(); }
  }
  if (!data) return <div class="p-8"><h1>ERP</h1><p role="status">{message || 'Đang tải dữ liệu…'}</p></div>;

  const s = data.summaries[period]?.payload ?? null;
  const transfers = data.unmatchedTransfers?.payload.transfers ?? [];
  const unpaid = data.unpaidOrders?.payload.orders ?? [];
  const statements = data.partnerStatements?.payload.statements ?? [];
  const firstDay = data.daily[0]?.date;
  const cards: Array<[string, string, string?]> = s ? [
    ['Doanh thu thuần', vnd(s.revenue), 'Tiền thu thuần (gồm VAT) của đơn hợp lệ trả lần đầu'],
    ['Đơn đã trả', String(s.paid_orders)],
    ['Đăng ký', String(s.registrations)],
    ['Phần công ty', vnd(s.company_share), 'Theo chính sách chia EB28, chưa phải lợi nhuận'],
    ['Chia đối tác / affiliate', vnd(s.revenue - s.company_share), 'Doanh thu thuần − phần công ty'],
  ] : [];

  return <div class="flex h-full min-w-0 flex-col overflow-hidden select-text">
    <PageHeader title="ERP" breadcrumb="Tài chính" actions={<><Link class={BUTTON} href="/modules">Cài đặt module</Link><button class={`${BUTTON} control-accent`} disabled={busy || !data.hub} onClick={sync}>{busy ? 'Đang đồng bộ…' : 'Đồng bộ ngay'}</button></>}
      tabs={<>{PERIODS.map(([id, label]) => <Tab key={id} label={label} active={period === id} onClick={() => setPeriod(id)} />)}</>} />
    <main inert={busy} class="overflow-auto min-w-0 flex-1 p-4 md:p-6 space-y-5">
      {!data.hub && <p class={PANEL}>Chưa kết nối ERP. Vào <Link class="underline" href="/modules">Module › Tài chính › Cài đặt</Link>, nhập địa chỉ MCP và token của ERP.</p>}
      <p class="text-xs text-[var(--color-text-muted)]">
        Đồng bộ tự động mỗi 15 phút, chỉ đọc · Lần cuối: {when(data.status?.at)}
        {data.status?.ok === false && <span class="text-[var(--color-status-failed)]"> · {data.status.error}</span>}
        {data.status?.warning && <span> · {data.status.warning}</span>}
        {!!data.status?.skipped.length && <span> · Chưa duyệt đọc: {data.status.skipped.join(', ')}</span>}
      </p>
      {message && <p role="status" class={PANEL}>{message}</p>}

      {s ? <>
        <p class="text-sm text-[var(--color-text-muted)]">Kỳ {dmy(s.from_date)} → {dmy(s.to_date)} · cập nhật {when(data.summaries[period]?.syncedAt)}</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">{cards.map(([label, value, hint]) =>
          <div class={PANEL} key={label} title={hint}><p class="text-xs text-[var(--color-text-muted)]">{label}</p><p class="text-xl xl:text-2xl break-words font-semibold mt-3">{value}</p>{hint && <p class="text-[11px] mt-2 text-[var(--color-text-muted)]">{hint}</p>}</div>)}
        </div>
        <section class={PANEL}><h3 class="font-semibold">Theo chương trình</h3><div class="overflow-auto mt-3"><table class="w-full text-sm whitespace-nowrap">
          <thead><tr>{['Chương trình', 'Đăng ký', 'Đơn đã trả', 'Người chuyển đổi', 'Tỷ lệ chuyển đổi'].map(h => <th class={TH}>{h}</th>)}</tr></thead>
          <tbody>{(s.programs ?? []).slice().sort((a, b) => b.registrations - a.registrations).map(p => <tr key={p.program}><td class="p-2">{p.program}</td><td class="p-2">{p.registrations}</td><td class="p-2">{p.paid_orders}</td><td class="p-2">{p.converted_people}</td><td class="p-2">{(p.conversion_rate_bps / 100).toLocaleString('vi-VN')}%</td></tr>)}</tbody>
        </table></div></section>
      </> : data.hub && <p class={PANEL}>Chưa có dữ liệu kỳ này. Bấm Đồng bộ ngay.</p>}

      <section class={PANEL}><h3 class="font-semibold">Doanh thu theo ngày</h3>
        <p class="text-xs mt-1 text-[var(--color-text-muted)]">ERP chỉ trả số theo hôm nay / tuần / tháng nên lịch sử theo ngày bắt đầu từ lần đồng bộ đầu tiên{firstDay ? ` (${dmy(firstDay)})` : ''}. Dashboard dùng bảng này cho 7 và 30 ngày.</p>
        {data.daily.length ? <div class="overflow-auto mt-3"><table class="w-full text-sm whitespace-nowrap">
          <thead><tr>{['Ngày', 'Doanh thu thuần', 'Đơn đã trả', 'Đăng ký', 'Phần công ty'].map(h => <th class={TH}>{h}</th>)}</tr></thead>
          <tbody>{data.daily.slice().reverse().map(d => <tr key={d.date}><td class="p-2">{dmy(d.date)}</td><td class="p-2">{vnd(d.revenue)}</td><td class="p-2">{d.paid_orders}</td><td class="p-2">{d.registrations}</td><td class="p-2">{vnd(d.company_share)}</td></tr>)}</tbody>
        </table></div> : <p class="mt-3 text-sm">Chưa có.</p>}
      </section>

      <div class="grid lg:grid-cols-2 gap-5">
        <section class={PANEL}><h3 class="font-semibold">Đơn chưa thanh toán ({unpaid.length})</h3>
          <p class="text-xs mt-1 text-[var(--color-text-muted)]">Đơn chưa trả của khách do tài khoản ERP này phụ trách.</p>
          {unpaid.length ? <div class="overflow-auto mt-3"><table class="w-full text-sm whitespace-nowrap">
            <thead><tr>{['Mã đơn', 'Gói', 'Số tiền', 'Ngày', 'Hạn'].map(h => <th class={TH}>{h}</th>)}</tr></thead>
            <tbody>{unpaid.map(o => <tr key={o.sales_order}><td class="p-2">{o.sales_order}</td><td class="p-2">{o.offer}</td><td class="p-2">{vnd(o.amount)}</td><td class="p-2">{dmy(o.transaction_date)}</td><td class="p-2">{o.payment_in_time ? 'Còn hạn' : 'Quá hạn'}</td></tr>)}</tbody>
          </table></div> : <p class="mt-3 text-sm">Không có.</p>}
        </section>
        <section class={PANEL}><h3 class="font-semibold">Tiền về chưa khớp đơn ({transfers.length})</h3>
          <p class="text-xs mt-1 text-[var(--color-text-muted)]">Khoản SePay cần kế toán khớp với đơn trên ERP.</p>
          {transfers.length ? <div class="overflow-auto mt-3"><table class="w-full text-sm whitespace-nowrap">
            <thead><tr>{['Thời điểm', 'Số tiền', 'Giao dịch'].map(h => <th class={TH}>{h}</th>)}</tr></thead>
            <tbody>{transfers.map(t => <tr key={t.bank_transaction}><td class="p-2">{t.occurred_at}</td><td class="p-2">{vnd(t.amount)}</td><td class="p-2">{t.bank_transaction}</td></tr>)}</tbody>
          </table></div> : <p class="mt-3 text-sm">Không có.</p>}
        </section>
      </div>

      <section class={PANEL}><h3 class="font-semibold">Chi phí</h3>
        <ul class="list-disc pl-5 text-sm space-y-2 mt-3">
          <li>Chia đối tác / affiliate theo ERP: xem thẻ phía trên. Bảng kê đối tác: {statements.length ? `${statements.length} bảng kê` : 'chưa có bảng kê nào'}.</li>
          <li>Chi phí quảng cáo lấy từ Meta Ads, chi phí AI từ lịch sử dùng model: xem <Link class="underline" href="/m/finance/pnl">P&L & dòng tiền</Link> và <Link class="underline" href="/usage">Chi phí AI</Link>.</li>
          <li>ERP chưa trả chi phí vận hành, giá vốn hay lương, nên lợi nhuận thật vẫn cần sổ thu chi.</li>
        </ul>
      </section>
    </main>
  </div>;
}
