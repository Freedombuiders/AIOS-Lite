/**
 * Tổng quan: the business view. One period switch (7 / 30 / 90 ngày) drives the module sections in the
 * 'overview' slot: revenue & costs (finance), content performance (marketing), sales over Zalo (zalo).
 * Above them "Cần bạn"; below them the small module cards ('dashboard' slot). Agent lists live on /agents.
 * A missing source shows an empty state, never a made-up number.
 */
import { ArrowUpRight, Bot, CircleCheck, Clock3, Coins, LayoutGrid, RefreshCw, TriangleAlert } from 'lucide-preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { approvalIdFromKey } from '@/lib/integrations';
import { ApprovalButtons } from '@/pages/connections/ApprovalButtons';
import type { AttentionItem } from '@core/types';
import { apiPost, errorText } from '@/lib/api';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { fmtLongDate, fmtTime, greeting, HOME_POLL_MS, localParts } from '@/lib/home-dashboard';
import { OVERVIEW_DAYS, OVERVIEW_DAYS_KEY, overviewRange, parseOverviewDays, type OverviewDays } from '@/lib/overview-range';
import { useEvents } from '@/lib/sse';
import { pushToast } from '@/lib/toasts';
import { slotWidgets, WidgetSlot } from '@/module-host/WidgetSlot';

function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function loadDays(): OverviewDays {
  try { return parseOverviewDays(localStorage.getItem(OVERVIEW_DAYS_KEY)); } catch { return 30; }
}

function RangeSwitch({ value, onChange }: { value: OverviewDays; onChange: (d: OverviewDays) => void }) {
  return (
    <div class="hd-range" role="radiogroup" aria-label="Khoảng thời gian">
      {OVERVIEW_DAYS.map((d) => (
        <button key={d} type="button" role="radio" aria-checked={value === d} class={value === d ? 'is-on' : undefined} onClick={() => onChange(d)}>
          {d} ngày
        </button>
      ))}
    </div>
  );
}

function severityClass(a: AttentionItem): string {
  return a.severity === 'error' ? 'is-urgent' : a.severity === 'warn' ? 'is-normal' : 'is-info';
}

function NeedsYou({ items, loaded, error, onChanged }: { items: AttentionItem[]; loaded: boolean; error: string | null; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  async function resolve(key: string) {
    setBusy(key);
    try {
      await apiPost(`/attention/${encodeURIComponent(key)}/resolve`);
      onChanged();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không đánh dấu được', description: errorText(e) });
    } finally {
      setBusy(null);
    }
  }
  if (loaded && items.length === 0 && !error) {
    return (
      <section class="hd-needs-slim" aria-labelledby="hd-needs" aria-live="polite">
        <CircleCheck size={17} />
        <h2 id="hd-needs">Cần bạn</h2>
        <span>Không có việc nào chờ duyệt hay bị lỗi</span>
        <Link href="/tasks">Mọi công việc <ArrowUpRight size={12} /></Link>
      </section>
    );
  }
  const urgent = items.filter((i) => i.severity === 'error').length;
  const normal = items.filter((i) => i.severity === 'warn').length;
  return (
    <section class="hd-card" aria-labelledby="hd-needs">
      <div class="hd-card-head">
        <h2 id="hd-needs">Cần bạn <small>{loaded ? `${items.length} việc` : 'đang tải…'}</small></h2>
        <Link href="/tasks">Mọi công việc <ArrowUpRight size={12} /></Link>
      </div>
      <div class="hd-attn">
        <div>
          {error && !loaded ? <p class="hd-error">Không tải được danh sách: {error}</p> : null}
          <ul class="hd-attn-list">
            {items.map((a) => (
              <li key={a.key} class={`hd-attn-item ${severityClass(a)}`}>
                <i aria-hidden="true" />
                <span class="hd-attn-icon">{a.kind === 'budget' ? <Coins size={15} /> : a.kind === 'review' ? <Clock3 size={15} /> : <TriangleAlert size={15} />}</span>
                <div class="hd-attn-text">
                  {a.link ? <Link href={a.link}>{a.title}</Link> : <span>{a.title}</span>}
                  {a.detail && <p title={a.detail}>{a.detail}</p>}
                </div>
                <div class="hd-attn-actions">
                  {approvalIdFromKey(a.key) && <ApprovalButtons id={approvalIdFromKey(a.key)!} onDone={onChanged} />}
                  <button type="button" class="hd-icon-btn" title="Đã xử lý" aria-label="Đã xử lý" disabled={busy === a.key} onClick={() => void resolve(a.key)}>
                    <CircleCheck size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div class="hd-attn-side" aria-label="Đếm theo mức độ">
          <div class={`hd-attn-count ${urgent ? 'is-hot' : ''}`}><strong>{urgent}</strong><span>Lỗi</span></div>
          <div class="hd-attn-count"><strong>{normal}</strong><span>Chờ duyệt</span></div>
          <div class="hd-attn-count"><strong>{items.length - urgent - normal}</strong><span>Để ý khi rảnh</span></div>
        </div>
      </div>
    </section>
  );
}

export default function HomeDashboard() {
  const now = useNow(HOME_POLL_MS);
  const attention = useFetch<{ items: AttentionItem[] }>('/attention', HOME_POLL_MS);
  const [days, setDays] = useState<OverviewDays>(loadDays);
  const pickDays = (d: OverviewDays) => {
    setDays(d);
    try { localStorage.setItem(OVERVIEW_DAYS_KEY, String(d)); } catch { /* private window: keep it for this visit only */ }
  };
  const todayKey = localParts(now).key;
  // recomputed when the day changes, not on every clock tick, so sections don't refetch every 30 s
  const range = useMemo(() => overviewRange(days), [days, todayKey]);

  const refresh = useCallback(() => attention.refresh(), [attention.refresh]);
  useEvents(['attention'], refresh);

  const items = attention.data?.items ?? [];
  const sections = slotWidgets('overview');
  const status = attention.data ? (items.length ? `${items.length} việc cần bạn xử lý` : 'Không có việc nào chờ bạn') : '';

  return (
    <div class="os-scroll">
      <div class="hd">
        <header class="hd-head">
          <div>
            <p class="hd-eyebrow">{fmtLongDate(now)} · {fmtTime(now)}</p>
            <h1>{greeting(localParts(now).h)}<span>.</span></h1>
            {status && <p class="hd-status" aria-live="polite"><span class={items.length ? 'hd-warn' : 'hd-ok'}>{status}</span></p>}
          </div>
          <nav class="hd-head-actions" aria-label="Kỳ báo cáo và lối tắt">
            <RangeSwitch value={days} onChange={pickDays} />
            <Link href="/chat" class="hd-btn hd-btn-primary"><Bot size={15} /> Trò chuyện với agent</Link>
          </nav>
        </header>

        <NeedsYou items={items} loaded={!!attention.data} error={attention.error} onChanged={attention.refresh} />

        {sections.length ? (
          <WidgetSlot slot="overview" range={range} />
        ) : (
          <section class="hd-card">
            <div class="hd-empty">
              <strong>Chưa có số liệu kinh doanh</strong>
              <p>Thêm module <b>Tài chính</b> (doanh thu và chi phí), <b>Marketing</b> (hiệu quả nội dung) và <b>Zalo</b> (bán hàng qua Zalo) để xem biểu đồ ở đây.</p>
              <Link href="/modules" class="hd-btn"><LayoutGrid size={14} /> Mở trang Module</Link>
            </div>
          </section>
        )}

        {slotWidgets('dashboard').length ? <p class="hd-section-label">Theo dõi nhanh</p> : null}
        <WidgetSlot slot="dashboard" />

        <footer class="hd-foot">
          <span>Kỳ {range.from.slice(8, 10)}/{range.from.slice(5, 7)} – {range.to.slice(8, 10)}/{range.to.slice(5, 7)}, so với {days} ngày liền trước · cập nhật {fmtTime(now)}</span>
          <button type="button" onClick={() => { invalidateFetchCache(); refresh(); }} class="inline-flex items-center gap-1"><RefreshCw size={12} /> Làm mới ngay</button>
        </footer>
      </div>
    </div>
  );
}
