import { ExternalLink } from 'lucide-preact';
import { fmtMoney, type AdAccountDto, type AdsDashboardDto, type AdsRecommendationDto } from '@modules/ads/web/lib/fbstudio';
import { ACCENT_TEXT, finite } from '@/components/fb/charts/chart-utils';
import { BTN, BTN_PRIMARY } from '@modules/ads/web/components/fb/DashStates';
import { ACTION_META, RESULT_META, adsManagerUrl } from './adsMeta';

const LEVEL: Record<AdsRecommendationDto['level'], string> = { campaign: 'Chiến dịch', adset: 'Nhóm', ad: 'Quảng cáo' };

export function AdsQueue({ dto, account, acted, busy, onAct }: {
  dto: AdsDashboardDto;
  account: AdAccountDto;
  /** Optimistic local state while the POST is in flight / just finished. */
  acted: Record<number, 'done' | 'snoozed'>;
  busy: number | null;
  onAct: (id: number, state: 'done' | 'snoozed') => void;
}) {
  const r = RESULT_META[account.resultType];
  const items = dto.queue.map((q): { q: AdsRecommendationDto; state: AdsRecommendationDto['state'] } => ({ q, state: acted[q.id] ?? q.state }));
  const openCount = items.filter((i) => i.state === 'open').length;
  const imp = dto.impact;
  const hasImpact = finite(imp.savingsPerDay) || finite(imp.extraResultsPerDay);
  const cpa = r.cpa;

  return (
    <section aria-label="Cần quyết định hôm nay" class="flex flex-wrap gap-4 p-4 rounded-xl border" style={{ background: 'var(--color-accent-soft)', borderColor: 'color-mix(in srgb, var(--color-accent) 40%, transparent)' }}>
      <div class="flex-[3_1_560px] min-w-0 flex flex-col gap-2.5">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="m-0 text-[15px] font-semibold text-[var(--color-text)]">Cần quyết định hôm nay · {openCount} việc</h2>
          {hasImpact && openCount > 0 && (
            <span class="text-[12.5px]" style={{ color: ACCENT_TEXT }}>
              Nếu làm theo đề xuất, ước tính
              {finite(imp.savingsPerDay) && <> tiết kiệm {fmtMoney(imp.savingsPerDay, account.currency)}/ngày</>}
              {finite(imp.savingsPerDay) && finite(imp.extraResultsPerDay) && ','}
              {finite(imp.extraResultsPerDay) && <> thêm khoảng {Math.round(imp.extraResultsPerDay).toLocaleString('vi-VN')} {r.noun}/ngày ở cùng ngân sách</>}
            </span>
          )}
        </div>
        <p class="m-0 text-[12px] text-[var(--color-text-muted)]">AIOS-Lite chỉ đọc dữ liệu, không đổi gì trong Meta. Mở Ads Manager để tự thực hiện, rồi bấm “Đã xử lý”.</p>

        {items.length === 0 && (
          <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-3 text-[13px] text-[var(--color-text-muted)]">
            Hôm nay chưa có đề xuất nào. Các luật chạy lại sau mỗi lần kéo số liệu (mỗi giờ).
          </div>
        )}
        {items.map(({ q, state }) => {
          const m = ACTION_META[q.action];
          const pending = state === 'open';
          return (
            <div key={q.id} class="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)]" style={{ opacity: pending ? 1 : 0.6 }}>
              <span class="shrink-0 inline-flex items-center h-6 px-2.5 rounded-full text-[12px] font-semibold" style={{ background: m.bg, color: m.fg }}>{m.label}</span>
              <div class="flex-[1_1_320px] min-w-0">
                <div class="text-[13.5px] font-semibold text-[var(--color-text)] break-words">{LEVEL[q.level]} “{q.objectName}”</div>
                <div class="text-[12.5px] leading-snug text-[var(--color-text-muted)]">{q.reason}</div>
              </div>
              {pending ? (
                <div class="flex flex-wrap gap-1.5">
                  <a href={adsManagerUrl(account.id)} target="_blank" rel="noopener noreferrer" class={`${BTN} inline-flex items-center gap-1.5 no-underline`}>
                    Mở Ads Manager <ExternalLink size={12} />
                  </a>
                  <button type="button" class={BTN} disabled={busy === q.id} onClick={() => onAct(q.id, 'snoozed')}>Bỏ qua 24 giờ</button>
                  <button type="button" class={BTN_PRIMARY} disabled={busy === q.id} onClick={() => onAct(q.id, 'done')}>Đã xử lý</button>
                </div>
              ) : (
                <span class="text-[12.5px] text-[var(--color-text-muted)]">{state === 'done' ? 'Đã xử lý' : 'Đã bỏ qua 24 giờ'}</span>
              )}
            </div>
          );
        })}
      </div>
      <div class="flex-[1_1_260px] min-w-0 flex flex-col gap-2">
        <div class="text-[12px] font-semibold" style={{ color: ACCENT_TEXT }}>Luật đang dùng để đề xuất</div>
        <ol class="m-0 pl-[18px] list-decimal flex flex-col gap-1.5 text-[12.5px] leading-snug text-[var(--color-text)]">
          <li>Chi ≥ 2× {cpa} mục tiêu mà chưa có {r.noun} → tắt ngay.</li>
          <li>Đã qua giai đoạn học, chi ≥ 3× {cpa} mục tiêu và {cpa} &gt; 1,5× mục tiêu → tắt.</li>
          <li>Tần suất &gt; 3 và CTR giảm &gt; 30% so với 3 ngày đầu → làm mới creative.</li>
          <li>{cpa} &lt; 0,8× mục tiêu 3 ngày liền và ≥ 50 {r.noun}/tuần → tăng ngân sách 20%.</li>
          <li>Không đụng nhóm đang học (&lt; 50 {r.noun}/7 ngày), trừ luật 1.</li>
        </ol>
      </div>
    </section>
  );
}
