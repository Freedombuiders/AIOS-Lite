/** /kol/:id?tab=growth — followers, totals, top posts, pillars, best hours, spend, insights. */
import { useState } from 'preact/hooks';
import { BarChart3, ExternalLink, LineChart as LineIcon } from 'lucide-preact';
import { PageState } from '@/components/PageState';
import { Card, KpiTile } from '@modules/kol/web/components/shared/common';
import { BTN, BTN_PRIMARY, FilterChip } from '@modules/kol/web/components/shared/ops-shared';
import { PlatformBadge } from '@/components/social/PlatformBadge';
import { FollowersChart, HourHeatStrip, PillarBars, SpendBars } from '@modules/kol/web/components/charts';
import { EmptyHint, KolImg, Markdown, TonePill, toastError } from '@modules/kol/web/components/ui';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import {
  KOL, PLATFORM_META, POST_FORMAT_LABEL, fmtCompact, fmtDate, fmtInt, fmtRate, kolApi,
  type GrowthDto, type InsightDto,
} from '@modules/kol/web/lib/kol';
import type { WorkspaceTabProps } from './workspace-types';

const PERIODS = [7, 30, 90] as const;

export function KolGrowthTab({ persona, go }: WorkspaceTabProps) {
  const [days, setDays] = useState<number>(30);
  const growth = useFetch<GrowthDto>(KOL.growth(persona.id, days));
  const g = growth.data;

  return (
    <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4 flex flex-col gap-4">
      <div class="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Khoảng thời gian" class="flex gap-1.5">
          {PERIODS.map((d) => <FilterChip key={d} on={days === d} label={`${d} ngày`} onClick={() => setDays(d)} />)}
        </div>
        <button type="button" class={`${BTN} ml-auto`} onClick={growth.refresh}>Làm mới</button>
      </div>

      {!g && <PageState loading={growth.loading} error={growth.error} />}
      {g && (
        <>
          <div class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
            <KpiTile label="Bài đã đăng" value={fmtInt(g.totals.posts)} />
            <KpiTile label="Lượt xem" value={fmtCompact(g.totals.views)} />
            <KpiTile label="Lượt thích" value={fmtCompact(g.totals.likes)} />
            <KpiTile label="Bình luận" value={fmtCompact(g.totals.comments)} />
            <KpiTile label="Chia sẻ" value={fmtCompact(g.totals.shares)} />
            <KpiTile label="Tỉ lệ tương tác" value={fmtRate(g.totals.engagementRate)} />
          </div>

          {g.accounts.length === 0 && g.totals.posts === 0 ? (
            <EmptyHint icon={<LineIcon size={20} />} title="Chưa có số liệu" action={<button type="button" class={BTN_PRIMARY} onClick={() => go('channels')}>Liên kết kênh</button>}>
              Số liệu xuất hiện sau khi {persona.name} có kênh liên kết và bài đã đăng. Người theo dõi cập nhật mỗi ngày, tương tác của bài cập nhật mỗi 30 phút trong 30 ngày đầu.
            </EmptyHint>
          ) : (
            <>
              <Card title="Người theo dõi" aside={g.accounts.map((a) => `${PLATFORM_META[a.platform].name} ${fmtCompact(a.followers)}`).join(' · ')}>
                <FollowersChart accounts={g.accounts} />
              </Card>

              <Card title="Bài nổi bật" aside={`${days} ngày qua`}>
                {g.topPosts.length === 0 ? <p class="text-[12.5px] text-[var(--color-text-muted)]">Chưa có bài nào có số liệu.</p> : (
                  <div class="overflow-x-auto -mx-1">
                    <table class="w-full min-w-[560px] text-[12.5px]">
                      <thead><tr class="text-left text-[11px] uppercase tracking-[0.05em] text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
                        <th class="px-1 py-1.5 font-semibold">Bài</th>
                        <th class="px-2 py-1.5 font-semibold text-right">Xem</th>
                        <th class="px-2 py-1.5 font-semibold text-right">Thích</th>
                        <th class="px-2 py-1.5 font-semibold text-right">Bình luận</th>
                        <th class="px-1 py-1.5" />
                      </tr></thead>
                      <tbody>
                        {g.topPosts.map((p) => (
                          <tr key={`${p.postId}-${p.platform}`} class="border-b border-[var(--color-border)] last:border-b-0">
                            <td class="px-1 py-1.5">
                              <button type="button" class="flex items-center gap-2 text-left min-w-0 hover:underline" onClick={() => go('content', { post: p.postId })}>
                                <span class="shrink-0 w-10 h-12 rounded overflow-hidden bg-[var(--color-elevated)]">{p.thumbUrl && <KolImg src={p.thumbUrl} class="w-full h-full" />}</span>
                                <PlatformBadge platform={p.platform} size={16} />
                                <span class="truncate max-w-[280px]">{p.title || 'Bài chưa đặt tên'}</span>
                              </button>
                            </td>
                            <td class="px-2 py-1.5 text-right tabular-nums">{fmtCompact(p.views)}</td>
                            <td class="px-2 py-1.5 text-right tabular-nums">{fmtCompact(p.likes)}</td>
                            <td class="px-2 py-1.5 text-right tabular-nums">{fmtCompact(p.comments)}</td>
                            <td class="px-1 py-1.5 text-right">
                              {p.permalink && <a href={p.permalink} target="_blank" rel="noopener noreferrer" aria-label="Mở bài trên nền tảng" class="inline-flex text-[var(--color-accent)]"><ExternalLink size={14} /></a>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>

              <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card title="Hiệu quả theo trụ cột" aside="Tương tác trung bình"><PillarBars pillars={g.pillars} /></Card>
                <Card title="Giờ đăng tốt nhất" aside="Theo giờ địa phương"><HourHeatStrip hours={g.hours} /></Card>
              </div>
            </>
          )}

          <Card title="Chi tiêu studio" aside="Ảnh, video, giọng nói, chấm khuôn mặt"><SpendBars spend={g.spend} /></Card>
        </>
      )}

      <Insights personaId={persona.id} go={go} />
    </div>
  );
}

/** Weekly reviews and autopilot plans; "Phân tích tuần" asks the strategist now. */
export function Insights({ personaId, go, limit }: { personaId: string; go: WorkspaceTabProps['go']; limit?: number }) {
  const res = useFetch<{ insights: InsightDto[] }>(KOL.insights(personaId));
  const [busy, setBusy] = useState(false);
  const list = (res.data?.insights ?? []).slice(0, limit ?? 20);

  async function analyse() {
    setBusy(true);
    try {
      await kolApi.runStrategist(personaId);
      pushToast({ tone: 'success', title: 'Đã có phân tích tuần mới' });
      invalidateFetchCache(KOL.insights(personaId));
      res.refresh();
    } catch (err) {
      toastError('Không phân tích được', err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={<span class="inline-flex items-center gap-2"><BarChart3 size={16} />Phân tích & kế hoạch</span>}
      aside={<button type="button" class={BTN} disabled={busy} onClick={() => { void analyse(); }}>{busy ? 'Đang phân tích… (≈ 1 phút)' : 'Phân tích tuần'}</button>}
    >
      {!res.data && <PageState loading={res.loading} error={res.error} />}
      {res.data && list.length === 0 && <p class="text-[12.5px] text-[var(--color-text-muted)]">Chưa có phân tích nào. Bấm “Phân tích tuần” để AI đọc số liệu và đề xuất hướng đi (không tốn tiền tạo ảnh).</p>}
      <ul class="flex flex-col gap-3 list-none m-0 p-0">
        {list.map((ins) => (
          <li key={ins.id} class="rounded-md border border-[var(--color-border)] p-3 flex flex-col gap-2 min-w-0">
            <div class="flex flex-wrap items-center gap-2 text-[12px]">
              <TonePill tone={ins.kind === 'plan' ? 'accent' : 'neutral'}>{ins.kind === 'plan' ? 'Kế hoạch autopilot' : 'Phân tích tuần'}</TonePill>
              <span class="text-[var(--color-text-muted)]">Tuần từ {fmtDate(ins.periodStart)} · tạo {fmtDate(ins.createdAt)}</span>
            </div>
            {ins.summary && <Markdown text={ins.summary} />}
            {ins.ideas.length > 0 && (
              <ol class="flex flex-col gap-1.5 list-decimal pl-5 m-0 text-[12.5px]">
                {ins.ideas.map((idea, i) => (
                  <li key={i}>
                    <span class="font-medium">{idea.title}</span>
                    <span class="text-[var(--color-text-muted)]"> · {POST_FORMAT_LABEL[idea.format] ?? idea.format}{idea.pillar ? ` · ${idea.pillar}` : ''}{idea.when ? ` · ${idea.when}` : ''}</span>
                    {idea.platforms.length > 0 && <span class="inline-flex gap-0.5 ml-1.5 align-middle">{idea.platforms.map((p) => <PlatformBadge key={p} platform={p} size={14} />)}</span>}
                    {ins.postIds[i] && ins.postIds.length === ins.ideas.length && (
                      <button type="button" class="ml-2 text-[var(--color-accent)] underline" onClick={() => go('content', { post: ins.postIds[i] })}>Mở bài</button>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {ins.postIds.length > 0 && ins.postIds.length !== ins.ideas.length && (
              <div class="flex flex-wrap gap-1.5 text-[12px]">
                <span class="text-[var(--color-text-muted)]">Bài đã tạo:</span>
                {ins.postIds.map((id, i) => <button key={id} type="button" class="text-[var(--color-accent)] underline" onClick={() => go('content', { post: id })}>Bài {i + 1}</button>)}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
