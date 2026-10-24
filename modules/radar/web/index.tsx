import { Radar } from 'lucide-preact';
import { Link } from 'wouter-preact';
import { useFetch } from '@/lib/useFetch';
import { defineWebModule, type WebNavItem } from '@/module-host/contracts';
import { RadarHome } from './pages/radar/RadarHome';
import { RadarReportPage } from './pages/radar/RadarReportPage';

const icon = (c: unknown) => c as WebNavItem['icon'];

interface LatestDto {
  latest: { dateLabel: string; layerLabel: string; headline: string; newPosts: number; newPains: number; link: string } | null;
}

/** Dashboard widget: headline of the newest Radar report. */
function LatestReportWidget() {
  const { data, error } = useFetch<LatestDto>('/api/m/radar/latest', 120_000);
  if (error) return <div class="text-sm text-[var(--color-text-muted)]">Chưa đọc được báo cáo Radar.</div>;
  if (!data) return <div class="text-sm text-[var(--color-text-muted)]">Đang tải…</div>;
  const l = data.latest;
  if (!l) return <div class="text-sm text-[var(--color-text-muted)]">Chưa có báo cáo nào. <Link href="/m/radar" class="underline">Mở Radar thị trường</Link></div>;
  return (
    <Link href={l.link} class="flex flex-col gap-1 no-underline text-[var(--color-text)]">
      <span class="text-[11.5px] text-[var(--color-text-muted)]">{l.dateLabel} · {l.layerLabel}</span>
      <span class="text-[13px] leading-snug">{l.headline}</span>
    </Link>
  );
}

export default defineWebModule({
  id: 'radar',
  nav: [{ group: 'marketing', label: 'Radar thị trường', path: '/m/radar', icon: icon(Radar) }],
  routes: [
    { path: '/m/radar/:date/:layer', component: RadarReportPage },
    { path: '/m/radar', component: RadarHome },
  ],
  widgets: [{ slot: 'dashboard', id: 'radar-latest', title: 'Radar thị trường', component: LatestReportWidget, order: 50 }],
  agentAccess: [{ scope: 'radar.read', label: 'Đọc báo cáo Radar thị trường' }],
});
