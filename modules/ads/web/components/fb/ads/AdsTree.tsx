import { useState } from 'preact/hooks';
import { fmtDec, fmtInt, fmtMoney, fmtPct, type AdAccountDto, type AdsDashboardDto } from '@modules/ads/web/lib/fbstudio';
import { AXIS, ORANGE, SERIES, TRACK, WARN, finite } from '@/components/fb/charts/chart-utils';
import { ACTION_META, RESULT_META, statusLabel } from './adsMeta';

type Node = AdsDashboardDto['tree'][number];
const COLS = 'minmax(240px, 1.6fr) 100px 84px 76px 72px 84px 130px 64px 72px 64px minmax(140px, 1fr)';

export function AdsTree({ tree, account }: { tree: Node[]; account: AdAccountDto }) {
  const target = account.targetCpa;
  const r = RESULT_META[account.resultType];
  const campaigns = tree.filter((n) => n.level === 'campaign');
  const campaignIds = new Set(campaigns.map((c) => c.id));
  const childrenOf = (id: string) => tree.filter((n) => n.level === 'adset' && n.parentId === id);
  const orphans = tree.filter((n) => n.level === 'adset' && !(n.parentId && campaignIds.has(n.parentId)));

  const [open, setOpen] = useState<Set<string>>(() => new Set([...campaigns].sort((a, b) => b.spend - a.spend).slice(0, 2).map((c) => c.id)));
  const [reason, setReason] = useState<string | null>(null);
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOpen = campaigns.length > 0 && campaigns.every((c) => open.has(c.id));

  const rows: { node: Node; depth: 0 | 1 }[] = [];
  campaigns.forEach((c) => {
    rows.push({ node: c, depth: 0 });
    if (open.has(c.id)) childrenOf(c.id).forEach((a) => rows.push({ node: a, depth: 1 }));
  });
  orphans.forEach((a) => rows.push({ node: a, depth: 0 }));

  return (
    <section aria-label="Chiến dịch và nhóm quảng cáo" class="shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] overflow-hidden">
      <div class="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3.5 pb-2.5">
        <h2 class="m-0 text-[14px] font-semibold text-[var(--color-text)]">Chiến dịch và nhóm quảng cáo</h2>
        <div class="flex flex-wrap items-center gap-3 text-[12px] text-[var(--color-text-muted)]">
          <span>Thanh = {r.cpa} so với mục tiêu; vạch dọc = ×1,0</span>
          {campaigns.length > 0 && (
            <button type="button" class="bg-transparent border-0 p-0 text-[var(--color-accent-hover)] underline underline-offset-2" onClick={() => setOpen(allOpen ? new Set() : new Set(campaigns.map((c) => c.id)))}>
              {allOpen ? 'Thu gọn tất cả' : 'Mở tất cả'}
            </button>
          )}
        </div>
      </div>
      {rows.length === 0 ? (
        <p class="m-0 px-4 pb-4 text-[13px] text-[var(--color-text-muted)]">Chưa có chiến dịch nào có số liệu trong khoảng này.</p>
      ) : (
        <div class="overflow-x-auto">
          <div class="min-w-[1160px]">
            <div class="grid gap-x-2.5 px-4 py-2 text-[11.5px] text-[var(--color-text-muted)] border-t border-[var(--color-border)]" style={{ gridTemplateColumns: COLS }}>
              <span>Tên</span><span>Trạng thái</span><span class="text-right">Chi</span><span class="text-right">Hôm nay</span><span class="text-right">{r.noun.charAt(0).toUpperCase() + r.noun.slice(1)}</span><span class="text-right">{r.cpa}</span>
              <span>So với mục tiêu</span><span class="text-right">CTR</span><span class="text-right">CPM</span><span class="text-right">Tần suất</span><span>Đề xuất</span>
            </div>
            {rows.map(({ node: n, depth }) => {
              const isCamp = n.level === 'campaign';
              const st = statusLabel(n.status);
              const ratio = finite(target) && target > 0 && finite(n.cpa) ? n.cpa / target : null;
              const noResult = n.results === 0 && n.spend > 0;
              // Without a target every rule says "Giữ"; a column of identical chips reads as advice, so show nothing.
              const rec = n.recommendation && (finite(target) || n.recommendation.action !== 'keep') ? n.recommendation : null;
              const m = rec ? ACTION_META[rec.action] : null;
              const expanded = open.has(n.id);
              return (
                <div key={`${n.level}-${n.id}`}>
                  <div
                    class="grid gap-x-2.5 items-center px-4 py-2 border-t border-[var(--color-border)] text-[13px] tabular-nums text-[var(--color-text)]"
                    style={{ gridTemplateColumns: COLS, background: isCamp ? 'var(--color-elevated)' : 'transparent' }}
                  >
                    <span class="flex items-center gap-2 min-w-0" style={{ paddingLeft: depth ? '24px' : 0 }}>
                      {isCamp ? (
                        <button type="button" aria-expanded={expanded} onClick={() => toggle(n.id)} class="flex items-center gap-2 min-w-0 h-8 p-0 bg-transparent border-0 text-left font-semibold text-[var(--color-text)]">
                          <span aria-hidden="true" class="w-4 shrink-0 text-[var(--color-text-muted)]">{expanded ? '▾' : '▸'}</span>
                          <span class="truncate">{n.name}</span>
                        </button>
                      ) : (
                        <span class="min-w-0">
                          <span class="block truncate text-[var(--color-text)]">{n.name}</span>
                          {finite(n.dailyBudget) && <span class="block text-[11px] text-[var(--color-text-muted)]">Ngân sách {fmtMoney(n.dailyBudget, account.currency)}/ngày</span>}
                        </span>
                      )}
                    </span>
                    <span class="text-[12px]" style={{ color: st.warn ? WARN : 'var(--color-text-muted)' }}>{st.text}</span>
                    <span class="text-right">{fmtMoney(n.spend, account.currency)}</span>
                    <span class="text-right text-[var(--color-text-muted)]">{n.spendToday > 0 ? fmtMoney(n.spendToday, account.currency) : '–'}</span>
                    <span class="text-right">{fmtInt(n.results)}</span>
                    <span class="text-right font-semibold">{finite(n.cpa) ? fmtMoney(n.cpa, account.currency) : '–'}</span>
                    <span class="flex items-center gap-1.5">
                      <span class="relative flex-1 h-1.5 rounded-full" style={{ background: TRACK }} aria-hidden="true">
                        {(ratio !== null || noResult) && (
                          <span class="block h-1.5 rounded-full" style={{ width: noResult ? '100%' : `${Math.min(100, (ratio as number) / 2 * 100)}%`, background: noResult ? 'var(--color-status-failed)' : (ratio as number) <= 1 ? SERIES : ORANGE }} />
                        )}
                        <span class="absolute" style={{ left: '50%', top: '-3px', width: '1px', height: '12px', background: AXIS }} />
                      </span>
                      <span class="text-[12px] w-[42px] text-right">{ratio !== null ? `×${fmtDec(ratio, 2)}` : noResult ? '0 KQ' : '–'}</span>
                    </span>
                    <span class="text-right">{fmtPct(n.ctr, 1)}</span>
                    <span class="text-right">{finite(n.cpm) ? fmtMoney(n.cpm, account.currency) : '–'}</span>
                    <span class="text-right" style={{ color: finite(n.frequency) && n.frequency > 3 ? WARN : undefined }}>{finite(n.frequency) ? fmtDec(n.frequency, 1) : '–'}</span>
                    <span>
                      {rec && m ? (
                        <button
                          type="button"
                          aria-expanded={reason === n.id}
                          onClick={() => setReason(reason === n.id ? null : n.id)}
                          class="inline-flex items-center h-[22px] px-2.5 rounded-full border-0 text-[12px] font-semibold"
                          style={{ background: m.bg, color: m.fg }}
                          title={rec.reason}
                        >
                          {m.label}
                        </button>
                      ) : <span class="text-[var(--color-text-faint)]">–</span>}
                    </span>
                  </div>
                  {rec && m && reason === n.id && (
                    <div class="px-4 py-2 text-[12.5px] leading-snug text-[var(--color-text-muted)] border-t border-[var(--color-border)]" style={{ paddingLeft: depth ? '44px' : '20px', background: 'var(--color-bg)' }}>
                      <span class="font-semibold" style={{ color: m.fg }}>{m.label}:</span> {rec.reason}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div class="px-4 py-2.5 text-[12px] text-[var(--color-text-muted)]">Bấm vào nhãn đề xuất để xem lý do. Thanh xanh: {r.cpa} tốt hơn mục tiêu; thanh cam: đắt hơn mục tiêu; thanh đỏ: đã chi nhưng chưa có kết quả.{!finite(target) && ' Đặt mục tiêu ở “Tài khoản & mục tiêu” để so sánh.'}</div>
    </section>
  );
}
