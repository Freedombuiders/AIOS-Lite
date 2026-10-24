import { useState } from 'preact/hooks';
import { Toggle } from '@/components/Toggle';
import { FORMAT_META, fmtDec, fmtInt, fmtMoney, fmtPct, type AdAccountDto, type AdsDashboardDto } from '@modules/ads/web/lib/fbstudio';
import { Card } from '../common';
import { BAD, GOOD, ORANGE, SERIES, TRACK, WARN, finite } from '@/components/fb/charts/chart-utils';
import { BTN, SELECT } from '@modules/ads/web/components/fb/DashStates';
import { RowBars, type BarRow } from '@/components/fb/charts/RowBars';
import { ACTION_META, RESULT_META, placementLabel, statusLabel } from './adsMeta';

/** Match a free-text creative format ('Reel', 'video', 'Ảnh'…) to the format palette. */
function formatColor(raw: string): string {
  const key = raw.trim().toLowerCase();
  for (const [k, v] of Object.entries(FORMAT_META)) {
    if (k === key || v.label.toLowerCase() === key) return v.color;
  }
  if (key.includes('reel')) return FORMAT_META.reel.color;
  if (key.includes('video')) return FORMAT_META.video.color;
  if (key.includes('ảnh') || key.includes('image') || key.includes('photo')) return FORMAT_META.photo.color;
  if (key.includes('album') || key.includes('carousel')) return FORMAT_META.album.color;
  return 'var(--color-text-faint)';
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span class="flex flex-col min-w-0">
      <span class="text-[11px] text-[var(--color-text-muted)]">{label}</span>
      <span class="text-[13.5px] font-semibold text-[var(--color-text)] truncate">{value}</span>
    </span>
  );
}

function Thumb({ url, format }: { url: string | null; format: string }) {
  const [broken, setBroken] = useState(false);
  if (url && !broken) {
    return (
      <span class="relative shrink-0 w-14 h-[72px] rounded-md overflow-hidden bg-[var(--color-elevated)]">
        <img src={url} alt="" loading="lazy" referrerpolicy="no-referrer" class="w-full h-full object-cover" onError={() => setBroken(true)} />
        {/video|reel/i.test(format) && <span class="absolute bottom-1 right-1 text-[9px] px-1 rounded bg-black/60 text-white" aria-hidden="true">▶</span>}
      </span>
    );
  }
  return (
    <span class="shrink-0 w-14 h-[72px] rounded-md bg-[var(--color-elevated)] flex items-center justify-center" aria-hidden="true">
      <span class="w-2 h-2 rounded-[2px]" style={{ background: formatColor(format) }} />
    </span>
  );
}

type SortKey = 'spend' | 'cpa' | 'results' | 'ctr';
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'spend', label: 'Chi nhiều nhất' },
  { key: 'results', label: 'Nhiều kết quả' },
  { key: 'cpa', label: 'Giá rẻ nhất' },
  { key: 'ctr', label: 'CTR cao nhất' },
];

export function CreativesSection({ creatives, account }: { creatives: AdsDashboardDto['creatives']; account: AdAccountDto }) {
  const r = RESULT_META[account.resultType];
  const cur = account.currency;
  const running = creatives.filter((c) => c.status.toUpperCase() === 'ACTIVE');
  const [onlyRunning, setOnlyRunning] = useState(true);
  const [sort, setSort] = useState<SortKey>('spend');
  const useRunning = onlyRunning && running.length > 0;
  const shown = [...(useRunning ? running : creatives)].sort((a, b) => {
    if (sort === 'cpa') return (a.cpa ?? Infinity) - (b.cpa ?? Infinity) || b.spend - a.spend;
    if (sort === 'results') return b.results - a.results || b.spend - a.spend;
    if (sort === 'ctr') return (b.ctr ?? -1) - (a.ctr ?? -1);
    return b.spend - a.spend;
  });
  const total = creatives.reduce((s, c) => s + c.spend, 0);
  const target = account.targetCpa;

  return (
    <Card
      title="Creative nào kéo, creative nào mệt"
      aside={(
        <span class="inline-flex flex-wrap items-center gap-3">
          {running.length > 0 && running.length < creatives.length && (
            <label class="inline-flex items-center gap-2">
              <Toggle on={onlyRunning} onChange={() => setOnlyRunning((v) => !v)} ariaLabel="Chỉ hiện quảng cáo đang chạy" size="sm" />
              Chỉ đang chạy ({running.length}/{creatives.length})
            </label>
          )}
          <select class={SELECT} value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as SortKey)} aria-label="Sắp xếp creative">
            {SORTS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </span>
      )}
    >
      {creatives.length === 0 ? (
        <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Chưa có creative nào có chi tiêu trong khoảng này.</p>
      ) : (
        <>
          <div class="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
            {shown.map((c) => {
              const m = c.recommendation ? ACTION_META[c.recommendation.action] : null;
              const change = finite(c.ctrChangePct) ? c.ctrChangePct : null;
              const st = statusLabel(c.status);
              const isVideo = finite(c.hookRate) || /video|reel/i.test(c.format);
              const cpaTone = finite(target) && finite(c.cpa) ? (c.cpa <= target ? GOOD : BAD) : 'var(--color-text)';
              return (
                <article key={c.adId} class="flex flex-col gap-2.5 p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] min-w-0" style={{ opacity: st.warn && c.status.toUpperCase() !== 'ACTIVE' ? 0.78 : 1 }}>
                  <div class="flex gap-2.5 items-start">
                    <Thumb url={c.thumbnailUrl} format={c.format} />
                    <span class="flex-1 min-w-0 flex flex-col gap-0.5">
                      <span class="block text-[13px] font-semibold leading-snug text-[var(--color-text)] break-words line-clamp-2" title={c.name}>{c.name}</span>
                      <span class="block text-[11.5px] text-[var(--color-text-muted)] truncate" title={c.campaignName}>{c.format || 'Creative'} · {c.campaignName}</span>
                      <span class="text-[11.5px]" style={{ color: st.warn ? WARN : GOOD }}>{st.text}</span>
                    </span>
                  </div>
                  <div class="grid grid-cols-3 gap-1.5 tabular-nums">
                    <Metric label="Chi" value={fmtMoney(c.spend, cur)} />
                    <Metric label={r.noun.charAt(0).toUpperCase() + r.noun.slice(1)} value={fmtInt(c.results)} />
                    <span class="flex flex-col min-w-0">
                      <span class="text-[11px] text-[var(--color-text-muted)]">{r.cpa}</span>
                      <span class="text-[13.5px] font-semibold truncate" style={{ color: cpaTone }}>{finite(c.cpa) ? fmtMoney(c.cpa, cur) : c.spend > 0 ? '0 KQ' : '–'}</span>
                    </span>
                  </div>
                  <div class="relative h-1 rounded-full" style={{ background: TRACK }} role="img" aria-label={`${fmtPct(total ? (c.spend / total) * 100 : null, 0)} chi tiêu creative`}>
                    <span class="block h-1 rounded-full" style={{ width: `${total ? Math.max(1, (c.spend / total) * 100) : 0}%`, background: SERIES }} />
                  </div>
                  <div class={`grid ${isVideo ? 'grid-cols-4' : 'grid-cols-2'} gap-1.5 tabular-nums`}>
                    {isVideo && <Metric label="Hook" value={fmtPct(c.hookRate, 0)} />}
                    {isVideo && <Metric label="Giữ chân" value={fmtPct(c.holdRate, 0)} />}
                    <Metric label="CTR" value={fmtPct(c.ctr, 1)} />
                    <Metric label="Tần suất" value={finite(c.frequency) ? fmtDec(c.frequency, 1) : '–'} />
                  </div>
                  {change !== null && Math.abs(change) >= 10 && (
                    <div class="text-[11.5px] text-[var(--color-text-muted)] tabular-nums">
                      CTR <span style={{ color: change < 0 ? BAD : GOOD }}>{change < 0 ? '▼' : '▲'} {fmtDec(Math.abs(change), 0)}%</span> so với 3 ngày đầu{change <= -30 ? ': creative đang mệt' : ''}
                    </div>
                  )}
                  {m && c.recommendation && c.recommendation.action !== 'keep' && (
                    <div class="flex items-start gap-2">
                      <span class="shrink-0 inline-flex items-center h-[22px] px-2.5 rounded-full text-[12px] font-semibold" style={{ background: m.bg, color: m.fg }}>{m.label}</span>
                      <span class="text-[12px] leading-snug text-[var(--color-text-muted)]">{c.recommendation.reason}</span>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
          <p class="m-0 text-[12px] text-[var(--color-text-muted)]">Thanh xanh = phần chi tiêu của creative trong các creative đang hiện. Hook = xem 3 giây ÷ hiển thị; Giữ chân = xem hết ÷ xem 3 giây (chỉ video).{finite(target) ? ` Giá xanh: dưới mục tiêu ${fmtMoney(target, cur)}; đỏ: trên mục tiêu.` : ''}</p>
        </>
      )}
    </Card>
  );
}

export function PlacementsSection({ placements, account }: { placements: AdsDashboardDto['placements']; account: AdAccountDto }) {
  const r = RESULT_META[account.resultType];
  const target = account.targetCpa;
  const [all, setAll] = useState(false);
  const main = placements.filter((p) => p.spendShare >= 1 || p.results > 0);
  const minor = placements.length - main.length;
  const shown = all ? placements : main;
  const cpas = shown.map((p) => p.cpa).filter(finite);
  const domain = Math.max(1, ...cpas, finite(target) ? target : 0) * 1.15;
  const rows: BarRow[] = shown.map((p) => ({
    key: p.placement,
    label: <span class="block truncate" title={placementLabel(p.placement)}>{placementLabel(p.placement)}</span>,
    ratio: finite(p.cpa) ? p.cpa / domain : null,
    color: !finite(target) || (finite(p.cpa) && p.cpa <= target) ? SERIES : ORANGE,
    main: finite(p.cpa) ? fmtMoney(p.cpa, account.currency) : p.spend > 0 ? '0 KQ' : '–',
    sub: `${fmtInt(p.results)} · ${fmtDec(p.spendShare, 0)}% chi`,
    title: `${placementLabel(p.placement)}: chi ${fmtMoney(p.spend, account.currency)}, ${p.results} ${r.noun}`,
  }));
  const worst = finite(target) && target > 0 ? [...placements].filter((p) => finite(p.cpa) && p.spendShare >= 5).sort((a, b) => (b.cpa as number) - (a.cpa as number))[0] : undefined;
  return (
    <Card class="flex-[1_1_420px]" title={`${r.cpa} theo vị trí hiển thị`} aside={`Thanh = ${r.cpa} · số ${r.noun} · % chi tiêu, 7 ngày`}>
      {placements.length === 0 ? (
        <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Chưa có số liệu theo vị trí hiển thị (kéo theo tuần mỗi giờ).</p>
      ) : (
        <>
          <RowBars rows={rows} marker={finite(target) ? target / domain : null} labelWidth={150} />
          {minor > 0 && <button type="button" class={`${BTN} self-start`} onClick={() => setAll((v) => !v)}>{all ? 'Ẩn vị trí nhỏ' : `Hiện thêm ${minor} vị trí dưới 1% chi tiêu`}</button>}
          <div class="text-[12px] text-[var(--color-text-muted)]">
            {finite(target) ? `Vạch đứt = mục tiêu ${fmtMoney(target, account.currency)}.` : `Đặt ${r.cpa} mục tiêu để có vạch so sánh.`}
            {worst && finite(worst.cpa) && finite(target) && worst.cpa > target * 1.2 && ` ${placementLabel(worst.placement)} đắt gấp ${fmtDec(worst.cpa / target, 1)} lần mục tiêu: cân nhắc loại khỏi nhóm đang chạy.`}
          </div>
        </>
      )}
    </Card>
  );
}

export function OrganicSection({ items, available }: { items: AdsDashboardDto['organicCandidates']; available: boolean }) {
  if (!available) return null;
  return (
    <Card class="flex-[1_1_420px]" title="Bài organic nên đem chạy quảng cáo">
      <p class="m-0 text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">Bài đã chứng minh được hook trên Page là creative ít rủi ro nhất. Lấy từ bài ER cao trong 30 ngày qua, chưa từng chạy ads.</p>
      {items.length === 0 ? (
        <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Chưa có bài nào đủ điều kiện. Cần bài đã đăng có số liệu ER và chưa dùng làm creative.</p>
      ) : (
        <ul class="list-none m-0 p-0 flex flex-col">
          {items.map((o) => (
            <li key={o.postId} class="flex flex-col gap-0.5 py-2 border-t border-[var(--color-border)]">
              <span class="text-[13px] font-semibold text-[var(--color-text)] break-words">{o.title || '(không có tiêu đề)'}</span>
              <span class="text-[12px] text-[var(--color-text-muted)]">
                {FORMAT_META[o.format]?.label ?? o.format} · ER {fmtPct(o.er)}{finite(o.shares) ? ` · ${Math.round(o.shares).toLocaleString('vi-VN')} share` : ''} · {o.pageName}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

