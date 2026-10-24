/** /kol/:id — overview: KPIs, next steps, upcoming posts, latest media, autopilot, latest insight. */
import { useState } from 'preact/hooks';
import { Bot, CheckCircle2, Circle, Play } from 'lucide-preact';
import { Card, KpiTile } from '@modules/kol/web/components/shared/common';
import { BTN, BTN_PRIMARY, BTN_SM } from '@modules/kol/web/components/shared/ops-shared';
import { PlatformBadge } from '@/components/social/PlatformBadge';
import { Lightbox } from '@modules/kol/web/components/Lightbox';
import { AssetThumb, ConsistencyBadge, Meter, TonePill, toastError } from '@modules/kol/web/components/ui';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import {
  KOL, PLATFORM_META, POST_STATUS, fmtCompact, fmtDate, fmtInt, fmtRate, fmtSlot, hasAnchor, kolApi,
  type AccountDto, type AssetDto, type GrowthDto, type InsightDto, type KolSettingsDto, type PersonaSummaryDto, type Platform, type PostDto,
} from '@modules/kol/web/lib/kol';
import type { WorkspaceTabProps, WorkspaceTab } from './workspace-types';
import { Insights } from './KolGrowthTab';

export function KolOverviewTab({ persona, status, go, refreshPersona }: WorkspaceTabProps) {
  const summaries = useFetch<{ personas: PersonaSummaryDto[] }>(KOL.personas);
  const growth = useFetch<GrowthDto>(KOL.growth(persona.id, 30));
  const scheduled = useFetch<{ posts: PostDto[] }>(KOL.posts({ personaId: persona.id, status: 'scheduled' }), 60_000);
  // Over-fetch a little so rejected media (kept in the gallery for the record) never shows here.
  const latest = useFetch<{ assets: AssetDto[]; nextBefore: number | null }>(KOL.assets({ personaId: persona.id, limit: 16 }));
  const accounts = useFetch<{ accounts: AccountDto[] }>(KOL.accounts(persona.id));
  const settings = useFetch<{ settings: KolSettingsDto }>(KOL.settings);
  const insights = useFetch<{ insights: InsightDto[] }>(KOL.insights(persona.id));
  const [open, setOpen] = useState<number | null>(null);
  const [assets, setAssets] = useState<AssetDto[] | null>(null);
  const [running, setRunning] = useState(false);

  const s = summaries.data?.personas.find((p) => p.id === persona.id) ?? null;
  const cap = persona.monthlyCapUsd ?? status?.spend.monthlyCapUsd ?? null;
  const upcoming = (scheduled.data?.posts ?? []).filter((p) => p.scheduledAt).sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0)).slice(0, 5);
  const media = (assets ?? latest.data?.assets ?? []).filter((a) => a.status !== 'rejected').slice(0, 8);
  const accountList = accounts.data?.accounts ?? [];
  const lastPlan = insights.data?.insights.find((i) => i.kind === 'plan') ?? null;
  const globalAutopilot = settings.data?.settings.autopilotEnabled;

  const steps: { done: boolean; label: string; tab: WorkspaceTab; cta: string }[] = [
    { done: hasAnchor(persona), label: 'Có ảnh khuôn mặt chính', tab: 'profile', cta: 'Thêm khuôn mặt' },
    { done: persona.refs.some((r) => r.kind === 'sheet'), label: 'Có bảng nhân vật 360°', tab: 'profile', cta: 'Tạo bảng 360°' },
    { done: !!persona.disclosureText.trim(), label: 'Có dòng công bố AI', tab: 'profile', cta: 'Viết công bố' },
    { done: (s?.assetCount ?? 0) > 0, label: 'Đã tạo ảnh đầu tiên', tab: 'studio', cta: 'Mở Studio' },
    { done: accountList.length > 0, label: 'Đã liên kết ít nhất một kênh', tab: 'channels', cta: 'Liên kết kênh' },
    { done: persona.status === 'active', label: 'KOL đang hoạt động', tab: 'profile', cta: 'Kích hoạt trong Hồ sơ' },
  ];
  const pending = steps.filter((x) => !x.done);

  async function runAutopilot() {
    setRunning(true);
    try {
      const { insight } = await kolApi.runAutopilot(persona.id);
      pushToast({ tone: 'success', title: 'Autopilot đã lập kế hoạch', description: insight.postIds.length ? `Đã tạo ${insight.postIds.length} bài. Xem ở Nội dung.` : 'Không cần thêm bài lúc này.' });
      invalidateFetchCache(KOL.insights(persona.id));
      invalidateFetchCache('/api/m/kol/posts');
      insights.refresh();
      scheduled.refresh();
    } catch (err) {
      toastError('Không chạy được autopilot', err);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4 flex flex-col gap-4">
      <div class="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KpiTile label="Người theo dõi" value={fmtCompact(s?.followers ?? null)} delta={accountList.length ? `${accountList.length} kênh` : 'chưa có kênh'} />
        <KpiTile label="Bài 30 ngày" value={fmtInt(s?.postsPublished30d ?? null)} delta={`${fmtInt(s?.postsScheduled ?? 0)} đang chờ đăng`} />
        <KpiTile label="Tỉ lệ tương tác" value={fmtRate(growth.data?.totals.engagementRate ?? null)} delta="30 ngày" />
        <KpiTile label="Giống khuôn mặt TB" value={s?.avgConsistency === null || !s ? '–' : `${Math.round(s.avgConsistency)}/100`} delta={`ngưỡng ${persona.consistencyThreshold}`} />
        <div class="col-span-2 lg:col-span-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3.5 py-3 flex flex-col justify-center">
          <Meter label="Chi tháng này" used={s?.spendMonthUsd ?? 0} cap={cap} hint={persona.monthlyCapUsd ? 'Hạn mức riêng của KOL' : 'Theo hạn mức chung'} />
        </div>
      </div>

      {pending.length > 0 && (
        <Card title="Bước tiếp theo" aside={`${steps.length - pending.length}/${steps.length} đã xong`}>
          <ul class="grid grid-cols-1 md:grid-cols-2 gap-1.5 list-none m-0 p-0">
            {steps.map((x) => (
              <li key={x.label} class="flex items-center gap-2 text-[13px] min-h-9">
                {x.done ? <CheckCircle2 size={16} class="text-[var(--color-status-done)] shrink-0" /> : <Circle size={16} class="text-[var(--color-text-faint)] shrink-0" />}
                <span class={x.done ? 'text-[var(--color-text-muted)] line-through' : 'text-[var(--color-text)]'}>{x.label}</span>
                {!x.done && <button type="button" class={`${BTN_SM} ml-auto`} onClick={() => go(x.tab)}>{x.cta}</button>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <Card title="Sắp đăng" aside={<button type="button" class="underline" onClick={() => go('content')}>Xem tất cả</button>}>
          {scheduled.error && <p class="text-[12px] text-[var(--color-status-failed)]">{scheduled.error}</p>}
          {scheduled.data && upcoming.length === 0 && (
            <p class="text-[12.5px] text-[var(--color-text-muted)]">Chưa có bài nào được lên lịch. <button type="button" class="text-[var(--color-accent)] underline" onClick={() => go('content', { new: '1' })}>Viết bài mới</button>.</p>
          )}
          <ul class="flex flex-col gap-1.5 list-none m-0 p-0">
            {upcoming.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => go('content', { post: p.id })} class="w-full flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left hover:bg-[var(--color-control-hover)] min-w-0">
                  {p.assets[0] ? <AssetThumb asset={p.assets[0]} class="shrink-0 w-9 h-11 rounded" /> : <span class="shrink-0 w-9 h-11 rounded bg-[var(--color-elevated)]" />}
                  <span class="flex-1 min-w-0">
                    <span class="block text-[13px] truncate">{p.title || 'Bài chưa đặt tên'}</span>
                    <span class="block text-[12px] text-[var(--color-text-muted)] tabular-nums">{fmtSlot(p.scheduledAt)}</span>
                  </span>
                  <span class="flex gap-0.5">{[...new Set(p.targets.map((t) => t.platform))].map((pl) => <PlatformBadge key={pl} platform={pl} size={16} />)}</span>
                  <TonePill tone={POST_STATUS[p.status].tone}>{POST_STATUS[p.status].label}</TonePill>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <Card
          title={<span class="inline-flex items-center gap-2"><Bot size={16} />Autopilot</span>}
          aside={<TonePill tone={persona.autopilot.enabled && globalAutopilot !== false ? 'done' : 'neutral'}>{persona.autopilot.enabled ? (globalAutopilot === false ? 'Bật (studio đang tắt)' : 'Đang bật') : 'Đang tắt'}</TonePill>}
        >
          <p class="text-[12.5px] text-[var(--color-text-muted)]">
            {persona.autopilot.enabled
              ? `Giữ lịch đủ ${persona.autopilot.leadDays} ngày tới · ${Object.entries(persona.autopilot.postsPerWeek).filter(([, n]) => (n ?? 0) > 0).map(([pl, n]) => `${n}/tuần ${PLATFORM_META[pl as Platform].name}`).join(', ') || 'chưa đặt số bài/tuần'} · ${persona.autopilot.requireApproval ? 'cần bạn duyệt' : 'tự lên lịch'}${persona.autopilot.generateMedia ? ` · tự tạo ảnh (≤ $${persona.autopilot.weeklyBudgetUsd}/tuần)` : ''}.`
              : 'Autopilot lập kế hoạch bài theo trụ cột và số bài mỗi tuần. Bật và cấu hình trong Hồ sơ › Autopilot.'}
          </p>
          {lastPlan && <p class="text-[12px] text-[var(--color-text-muted)]">Kế hoạch gần nhất: {fmtDate(lastPlan.createdAt)} · {lastPlan.ideas.length} ý tưởng · {lastPlan.postIds.length} bài đã tạo.</p>}
          <div class="flex flex-wrap gap-2">
            <button type="button" class={BTN_PRIMARY} disabled={running} onClick={() => { void runAutopilot(); }}><Play size={14} />{running ? 'Đang lập kế hoạch…' : 'Chạy autopilot ngay'}</button>
            <button type="button" class={BTN} onClick={() => go('profile')}>Cấu hình</button>
          </div>
        </Card>
      </div>

      <Card title="Ảnh & video mới nhất" aside={<button type="button" class="underline" onClick={() => go('gallery')}>Thư viện ảnh</button>}>
        {latest.error && <p class="text-[12px] text-[var(--color-status-failed)]">{latest.error}</p>}
        {latest.data && media.length === 0 && (
          <p class="text-[12.5px] text-[var(--color-text-muted)]">Chưa có ảnh nào. <button type="button" class="text-[var(--color-accent)] underline" onClick={() => go('studio')}>Tạo ảnh ở Studio</button>.</p>
        )}
        {media.length > 0 && (
          <ul class="grid grid-cols-4 sm:grid-cols-8 gap-2 list-none m-0 p-0">
            {media.map((a, i) => (
              <li key={a.id}>
                <button type="button" onClick={() => setOpen(i)} aria-label="Xem lớn" class="relative block w-full aspect-[4/5] rounded-md overflow-hidden border border-[var(--color-border)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]">
                  <AssetThumb asset={a} class="w-full h-full" />
                  <span class="absolute bottom-1 left-1"><ConsistencyBadge c={a.consistency} compact /></span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Insights personaId={persona.id} go={go} limit={1} />

      {open !== null && media[open] && (
        <Lightbox
          assets={media}
          index={open}
          personaId={persona.id}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          onChanged={(a) => setAssets(media.map((x) => (x.id === a.id ? a : x)))}
          onDeleted={(id) => { setAssets(media.filter((x) => x.id !== id)); setOpen(null); }}
          onRefAdded={refreshPersona}
          onAnimate={(a) => go('video', { asset: a.id })}
          onCreatePost={(a) => go('content', { compose: a.id })}
        />
      )}
    </div>
  );
}
