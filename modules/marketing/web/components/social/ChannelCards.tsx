import { Link } from 'wouter-preact';
import { finite } from '@/components/fb/charts/chart-utils';
import { fmtPct, type ChannelDashboardDto } from '@modules/marketing/web/lib/fbstudio';
import { SOCIAL_FB_PATH, fmtCount } from './social-ui';

const PILL = 'text-[12px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap';

/** YouTube, Instagram, TikTok: no numbers at all in this release, so none are drawn. */
const UNSUPPORTED = ['YouTube', 'Instagram', 'TikTok'];

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <span class="flex flex-col min-w-0">
      <span class="text-[18px] font-semibold tabular-nums text-[var(--color-text)]">{value}</span>
      <span class="text-[12px] text-[var(--color-text-muted)]">{label}</span>
    </span>
  );
}

/** The four channel cards of Tổng quan. Only Facebook has data; the others say so. */
export function ChannelCards({ dto }: { dto: ChannelDashboardDto }) {
  const kpi = (key: string) => dto.kpis.find((k) => k.key === key);
  const followers = kpi('followers');
  const followersValue = finite(followers?.value) ? followers!.value : dto.page.followers;
  const reach = kpi('reach');
  const er = kpi('er');
  const hasAny = finite(followersValue) || finite(reach?.value) || finite(er?.value);
  return (
    <section aria-label="Các kênh của bạn" class="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))' }}>
      <Link href={SOCIAL_FB_PATH} class="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-4 flex flex-col gap-2.5 no-underline text-[var(--color-text)] hover:bg-[var(--color-elevated)]">
        <span class="flex items-center gap-2">
          <span class="flex-1 min-w-0 truncate font-semibold text-[15px]">Facebook · {dto.page.name}</span>
          <span class={PILL} style={{ background: hasAny ? 'color-mix(in srgb, #22c55e 16%, transparent)' : 'var(--color-elevated)', color: hasAny ? 'color-mix(in srgb, #22c55e 55%, var(--color-text))' : 'var(--color-text-muted)' }}>
            {hasAny ? 'Đã kết nối' : 'Chưa có số liệu'}
          </span>
        </span>
        <span class="grid grid-cols-3 gap-2">
          <Stat value={fmtCount(followersValue)} label="Theo dõi" />
          <Stat value={fmtCount(reach?.value ?? null)} label={`Reach ${dto.days} ngày`} />
          <Stat value={fmtPct(er?.value ?? null)} label="ER trung vị" />
        </span>
        {!hasAny && <span class="text-[12px] text-[var(--color-text-muted)]">Chưa lấy số liệu. Bấm “Lấy số liệu mới”.</span>}
        {hasAny && !finite(reach?.value) && (
          <span class="text-[12px] text-[var(--color-text-muted)]">Chưa có reach theo ngày.</span>
        )}
      </Link>
      {UNSUPPORTED.map((name) => (
        <div key={name} class="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-card)] p-4 flex flex-col gap-2.5">
          <span class="flex items-center gap-2">
            <span class="flex-1 min-w-0 font-semibold text-[15px] text-[var(--color-text)]">{name}</span>
            <span class={PILL} style={{ background: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>Chưa hỗ trợ ở bản này</span>
          </span>
          <span class="text-[13px] text-[var(--color-text-muted)]">Bản này chỉ lấy số liệu Facebook. Chưa có số nào của {name}.</span>
        </div>
      ))}
    </section>
  );
}
