import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { RefreshCw } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Card, KpiTile, SetupNotice } from '@modules/marketing/web/components/fb/common';
import {
  apiFail, BTN, BTN_SM, FbReadiness, FetchError, FilterChip, NoPageNotice, PageSelect, useFbPages,
} from '@modules/marketing/web/components/fb/ops-shared';
import { CommentsTabs, commentsPageId, pickCommentsPage, STEP_COLOR, stepColor } from '@modules/marketing/web/components/fb/comments/shared';
import { apiPost } from '@/lib/api';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import { fmtInt, type CommentLogDto, type CommentLogRowDto, type CommentStatus } from '@modules/marketing/web/lib/fbstudio';

type Kind = 'all' | 'template' | 'agent' | 'other';

const KINDS: { key: Kind; label: string }[] = [
  { key: 'all', label: 'Tất cả' },
  { key: 'template', label: 'Mẫu nhanh' },
  { key: 'agent', label: 'Agent' },
  { key: 'other', label: 'Ẩn, chuyển người' },
];

const ROW_STATUS: Record<CommentStatus, { label: string; bg: string; fg: string }> = {
  new: { label: 'Mới', bg: 'var(--color-elevated)', fg: 'var(--color-text-muted)' },
  queued: { label: 'Chờ gửi', bg: 'rgba(124, 196, 255, 0.14)', fg: '#a9d8ff' },
  sent: { label: 'Đã gửi', bg: 'rgba(74, 222, 128, 0.14)', fg: '#86efac' },
  hidden: { label: 'Đã ẩn', bg: 'var(--color-elevated)', fg: 'var(--color-text-muted)' },
  human: { label: 'Chờ người', bg: 'rgba(251, 191, 36, 0.14)', fg: '#fcd34d' },
  skipped: { label: 'Bỏ qua', bg: 'var(--color-elevated)', fg: 'var(--color-text-muted)' },
  reacted: { label: 'Đã thả cảm xúc', bg: 'var(--color-elevated)', fg: 'var(--color-text-muted)' },
  failed: { label: 'Lỗi gửi', bg: 'rgba(248, 113, 113, 0.14)', fg: '#fca5a5' },
  draft: { label: 'Nháp', bg: 'var(--color-accent-soft)', fg: 'var(--color-accent-hover)' },
};

function fmtMedian(s: number | null): { value: string; unit: string } {
  if (s === null) return { value: '–', unit: '' };
  if (s < 60) return { value: String(Math.round(s)), unit: 'giây' };
  const m = Math.floor(s / 60);
  return { value: `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`, unit: 'phút' };
}

function fmtWhen(sec: number): string {
  const d = new Date(sec * 1000);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getDate()}/${d.getMonth() + 1} ${hm}`;
}

export function FbComments() {
  const { pages, enabledPages, loading: pagesLoading, error: pagesError } = useFbPages();
  const page = pickCommentsPage(pages);
  const [kind, setKind] = useState<Kind>('all');
  const [polling, setPolling] = useState(false);

  const path = page && page.enabled
    ? `/api/m/marketing/comments/log?page=${encodeURIComponent(page.id)}&kind=${kind}&limit=50`
    : null;
  const log = useFetch<CommentLogDto>(path, 30_000);
  const d = log.data;

  async function pollNow() {
    if (!page) return;
    setPolling(true);
    try {
      const res = await apiPost<{ ok: true; fetched: number }>('/api/m/marketing/comments/poll-now', { pageId: page.id });
      pushToast({ tone: 'success', title: res.fetched > 0 ? `Đã thu ${res.fetched} bình luận mới` : 'Không có bình luận mới' });
      invalidateFetchCache('/api/m/marketing/comments');
      log.refresh();
    } catch (err) {
      const { status, message } = apiFail(err);
      pushToast({ tone: 'error', title: status === 503 ? 'Composio chưa sẵn sàng' : 'Không thu được bình luận', description: message });
    } finally {
      setPolling(false);
    }
  }

  return (
    <div class="flex flex-col h-full min-h-0">
      <PageHeader
        breadcrumb="Marketing · Facebook"
        title="Bình luận AI"
        actions={
          <>
            {pages.length > 0 && (
              <PageSelect pages={pages} value={page?.id ?? ''} onChange={(id) => { commentsPageId.value = id; setKind('all'); }} />
            )}
            <button type="button" class={BTN} disabled={!page?.enabled || polling} onClick={() => void pollNow()}>
              <RefreshCw size={13} class={polling ? 'animate-spin' : ''} /> {polling ? 'Đang thu…' : 'Thu ngay'}
            </button>
            {d && (
              d.autoReplyEnabled ? (
                <span class="inline-flex items-center gap-2 h-9 px-3 rounded-md border border-[rgba(74,222,128,0.4)] bg-[rgba(74,222,128,0.08)] text-[12.5px] text-[var(--color-status-done)]">
                  <span class="w-[7px] h-[7px] rounded-full bg-[#4ade80]" aria-hidden="true" />
                  Tự trả lời đang bật · thu mỗi {d.pollMinutes} phút
                </span>
              ) : (
                <Link href="/m/marketing/comment-rules" class="inline-flex items-center gap-2 h-9 px-3 rounded-md border border-[var(--color-border-strong)] text-[12.5px] text-[var(--color-text-muted)]">
                  <span class="w-[7px] h-[7px] rounded-full bg-[var(--color-text-faint)]" aria-hidden="true" />
                  Tự trả lời đang tắt · bật ở Cấu hình
                </Link>
              )
            )}
          </>
        }
        tabs={<CommentsTabs />}
      />
      <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-5 flex flex-col gap-4">
        <p class="text-[13px] text-[var(--color-text-muted)] -mb-1">
          Agent tự trả lời bình luận theo luật bạn đặt. Không cần ai trực; đây là nhật ký những gì đã gửi.
        </p>
        <FbReadiness />

        {pagesLoading && pages.length === 0 && <PageState loading />}
        {pagesError && pages.length === 0 && <FetchError error={pagesError} />}
        {!pagesLoading && !pagesError && enabledPages.length === 0 && <NoPageNotice hasPages={pages.length > 0} />}
        {page && !page.enabled && enabledPages.length > 0 && (
          <SetupNotice title={`Page “${page.name}” chưa được bật`}>
            Bật Page này ở <Link href="/m/marketing" class="text-[var(--color-accent)] underline">FB · Cài đặt Page</Link>, hoặc chọn một Page đang bật ở góc trên.
          </SetupNotice>
        )}

        {log.error && !d && <FetchError error={log.error} onRetry={log.refresh} />}
        {log.loading && !d && path && <PageState loading />}

        {d && (
          <>
            {!d.autoReplyEnabled && (
              <SetupNotice title="Tự trả lời đang tắt cho Page này">
                Bình luận chưa được thu và trả lời. Vào <Link href="/m/marketing/comment-rules" class="text-[var(--color-accent)] underline">Cấu hình</Link> để bật và đặt luật.
                Bình luận cũ trước lúc bật sẽ không bị trả lời.
              </SetupNotice>
            )}

            <section aria-label="24 giờ qua" class="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
              <KpiTile label="Bình luận mới 24 giờ" value={fmtInt(d.kpis.new24h)} />
              <KpiTile
                label="Đã tự trả lời"
                value={<>{fmtInt(d.kpis.autoReplied24h)} <span class="text-[13px] font-medium text-[var(--color-text-muted)]">{d.kpis.new24h > 0 ? `${Math.round((d.kpis.autoReplied24h / d.kpis.new24h) * 100)}%` : ''}</span></>}
              />
              <KpiTile label="Bằng mẫu nhanh" value={fmtInt(d.kpis.byTemplate24h)} />
              <KpiTile label="Bằng agent" value={fmtInt(d.kpis.byAgent24h)} />
              <KpiTile label="Ẩn spam · chuyển người" value={`${fmtInt(d.kpis.hidden24h)} · ${fmtInt(d.kpis.human24h)}`} />
              <KpiTile
                label="Phản hồi trung vị"
                value={<>{fmtMedian(d.kpis.medianResponseS).value} <span class="text-[13px] font-medium text-[var(--color-text-muted)]">{fmtMedian(d.kpis.medianResponseS).unit}</span></>}
              />
            </section>

            <div class="flex flex-wrap gap-4">
              <HourlyChart hourly={d.hourly} />
              <Topics topics={d.topics} />
            </div>

            <section aria-label="Nhật ký trả lời" class="rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)] overflow-hidden">
              <div class="flex flex-wrap items-center gap-2 px-3.5 py-3 border-b border-[var(--color-border)]" role="group" aria-label="Lọc nhật ký">
                {KINDS.map((k) => <FilterChip key={k.key} on={kind === k.key} label={k.label} count={d.counts[k.key]} onClick={() => setKind(k.key)} />)}
                <span class="ml-auto text-[13px] text-[var(--color-text-faint)]">
                  {d.lastPollAt ? `Thu lần cuối ${fmtWhen(d.lastPollAt)}` : 'Chưa thu lần nào'}
                </span>
              </div>
              {d.rows.length === 0 ? (
                <PageState
                  empty
                  emptyTitle={d.counts.all === 0 ? 'Chưa có bình luận nào' : 'Không có bình luận ở nhóm này'}
                  emptyDescription={d.counts.all === 0
                    ? 'Khi bài trên Page có bình luận mới, chúng hiện ở đây cùng cách xử lý. Bấm “Thu ngay” để kiểm tra liền.'
                    : 'Chọn nhóm khác để xem.'}
                />
              ) : (
                d.rows.map((r) => <LogRow key={r.id} row={r} onChanged={() => { invalidateFetchCache('/api/m/marketing/comments'); log.refresh(); }} />)
              )}
              <div class="px-3.5 py-2.5 text-[13px] text-[var(--color-text-muted)]">
                Hiển thị {d.rows.length} / {d.counts[kind]} bình luận gần nhất
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function HourlyChart({ hourly }: { hourly: CommentLogDto['hourly'] }) {
  const [hv, setHv] = useState(-1);
  const totals = hourly.map((h) => h.template + h.agent + h.other);
  const peak = Math.max(0, ...totals);
  const max = Math.max(5, Math.ceil(peak / 5) * 5);
  const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
  const peakIdx = peak > 0 ? totals.indexOf(peak) : -1;
  const readout = hv >= 0 && hourly[hv]
    ? `${hh(hourly[hv]!.hour)} – ${totals[hv]} bình luận: ${hourly[hv]!.template} mẫu nhanh, ${hourly[hv]!.agent} agent, ${hourly[hv]!.other} khác`
    : peakIdx >= 0
      ? `Cao nhất lúc ${hh(hourly[peakIdx]!.hour)}: ${peak} bình luận. Rê chuột hoặc Tab vào cột để xem từng giờ.`
      : 'Chưa có bình luận trong 24 giờ qua.';
  const legend: [string, string][] = [[STEP_COLOR.template, 'Mẫu nhanh'], [STEP_COLOR.agent, 'Agent'], [STEP_COLOR.other, 'Ẩn, chuyển người, bỏ qua']];
  return (
    <Card
      class="flex-[2_1_520px] basis-[520px]"
      title="Bình luận 24 giờ qua, theo cách xử lý"
      aside={
        <span class="inline-flex flex-wrap gap-3 text-[13px] text-[var(--color-text-muted)]">
          {legend.map(([c, l]) => (
            <span key={l} class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-[2px]" style={{ background: c }} aria-hidden="true" />{l}</span>
          ))}
        </span>
      }
    >
      <div role="status" class="text-[13px] text-[var(--color-text-muted)] tabular-nums">{readout}</div>
      <div class="flex gap-2" onMouseLeave={() => setHv(-1)}>
        <div aria-hidden="true" class="flex-none w-[22px] h-[140px] flex flex-col justify-between items-end text-[12px] text-[var(--color-text-faint)]">
          <span class="-translate-y-1.5">{max}</span><span>{Math.round(max / 2)}</span><span class="translate-y-1.5">0</span>
        </div>
        <div class="relative flex-1 min-w-0 h-[140px]">
          <div aria-hidden="true" class="absolute inset-0 flex flex-col justify-between">
            <div class="h-px bg-[var(--color-border)]" /><div class="h-px bg-[var(--color-border)]" /><div class="h-px bg-[var(--color-border-strong)]" />
          </div>
          <div class="absolute inset-0 flex items-end">
            {hourly.map((h, i) => {
              const px = (v: number) => (v === 0 ? 0 : Math.max(2, (v / max) * 140 - 2));
              return (
                <button
                  key={i}
                  type="button"
                  aria-label={`${hh(h.hour)}: ${h.template} mẫu nhanh, ${h.agent} agent, ${h.other} khác`}
                  onMouseEnter={() => setHv(i)}
                  onFocus={() => setHv(i)}
                  class="flex-1 h-full px-[2px] border-0 bg-transparent flex flex-col justify-end gap-[2px] cursor-default focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                  style={{ opacity: hv === -1 || hv === i ? 1 : 0.55 }}
                >
                  <span class="block w-full rounded-t-[4px]" style={{ height: px(h.other), background: STEP_COLOR.other }} />
                  <span class="block w-full" style={{ height: px(h.agent), background: STEP_COLOR.agent }} />
                  <span class="block w-full" style={{ height: px(h.template), background: STEP_COLOR.template }} />
                </button>
              );
            })}
          </div>
        </div>
      </div>
      {hourly.length > 0 && (
        <div aria-hidden="true" class="flex justify-between pl-[30px] text-[12px] text-[var(--color-text-faint)]">
          {[0, 6, 12, 18, 23].map((i) => hourly[i] && <span key={i}>{String(hourly[i]!.hour).padStart(2, '0')}h</span>)}
        </div>
      )}
    </Card>
  );
}

function Topics({ topics }: { topics: CommentLogDto['topics'] }) {
  const top = Math.max(1, ...topics.map((t) => t.count));
  return (
    <Card class="flex-[1_1_300px] basis-[300px]" title="Khách hỏi gì nhiều nhất · 7 ngày">
      {topics.length === 0 ? (
        <p class="m-0 text-[12.5px] text-[var(--color-text-muted)]">Chưa có chủ đề nào. Chủ đề được gom khi mẫu nhanh hoặc agent trả lời.</p>
      ) : (
        <ul class="m-0 p-0 list-none grid grid-cols-[1fr_90px_32px] gap-x-2.5 gap-y-2 items-center text-[13px]">
          {topics.map((t) => (
            <li key={t.topic} class="contents">
              <span class="min-w-0 break-words">{t.topic}</span>
              <span class="h-2 rounded-r bg-[var(--color-elevated)]" aria-hidden="true">
                <span class="block h-2 rounded-r" style={{ width: `${(t.count / top) * 100}%`, background: STEP_COLOR.template }} />
              </span>
              <span class="text-right tabular-nums">{t.count}</span>
            </li>
          ))}
        </ul>
      )}
      <p class="m-0 text-[13px] text-[var(--color-text-faint)]">Agent gom chủ đề từ bình luận. Câu hỏi lặp lại là ý tưởng content tốt.</p>
      {topics[0] && (
        <Link
          href={`/m/marketing/library?ask=${encodeURIComponent(`Viết một bài trả lời câu hỏi khách hay hỏi: "${topics[0].topic}"`)}`}
          class="text-[12.5px] text-[var(--color-accent)] underline"
        >
          Nhờ agent viết bài về “{topics[0].topic}”
        </Link>
      )}
    </Card>
  );
}

function LogRow({ row: r, onChanged }: { row: CommentLogRowDto; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const st = ROW_STATUS[r.status] ?? ROW_STATUS.new;
  const muted = r.status === 'human' || r.status === 'hidden' || r.status === 'reacted' || r.status === 'skipped';
  const reply = r.replyText || (r.status === 'hidden' ? 'Đã ẩn bình luận.' : r.status === 'human' ? 'Không tự trả lời. Đã báo cho người phụ trách.' : r.status === 'reacted' ? 'Chỉ thả cảm xúc, không viết trả lời.' : r.status === 'skipped' ? 'Không trả lời.' : '');

  async function act(verb: 'retry' | 'hide' | 'unhide' | 'send', okTitle: string) {
    setBusy(true);
    try {
      await apiPost(`/api/m/marketing/comments/${encodeURIComponent(r.id)}/${verb}`);
      pushToast({ tone: 'success', title: okTitle });
      onChanged();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không thực hiện được', description: apiFail(err).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <article class="flex flex-wrap gap-x-4 gap-y-2.5 px-3.5 py-3 border-b border-[var(--color-border)]">
      <div class="flex-none basis-[52px] text-[12.5px] text-[var(--color-text-muted)] tabular-nums">{fmtWhen(r.createdTime)}</div>
      <div class="flex-[2_1_260px] min-w-0 flex flex-col gap-1">
        <div class="text-[13px] text-[var(--color-text-muted)]">
          <span class="text-[13px] font-semibold text-[var(--color-text)]">{r.authorName || 'Ẩn danh'}</span> · trên bài “{r.postTitle || r.postId}”
        </div>
        <div class="text-[13.5px] leading-snug break-words">{r.message}</div>
        <div class="text-[11.5px] text-[var(--color-text-faint)]">{r.words} từ</div>
      </div>
      <div class="flex-[1_1_180px] min-w-0 flex flex-col gap-1">
        {r.ruleLabel && (
          <span class="self-start inline-flex items-center gap-1.5 h-[22px] px-2 rounded-md bg-[var(--color-elevated)] text-[13px]">
            <span class="w-2 h-2 rounded-[2px]" style={{ background: stepColor(r.step) }} aria-hidden="true" />{r.ruleLabel}
          </span>
        )}
        {r.reason && <span class="text-[11.5px] text-[var(--color-text-muted)]">{r.reason}</span>}
      </div>
      <div
        class={`flex-[2_1_260px] min-w-0 px-2.5 py-2 rounded-lg text-[13px] leading-snug break-words ${muted ? 'text-[var(--color-text-muted)]' : 'bg-[var(--color-elevated)] text-[var(--color-text)]'}`}
      >
        {reply || <span class="text-[var(--color-text-faint)]">Chưa có trả lời.</span>}
        {r.privateText && (
          <div class="mt-1 text-[13px] text-[var(--color-text-muted)]">
            Nhắn riêng {r.privateSent ? '(đã gửi)' : '(chưa gửi)'}: {r.privateText}
          </div>
        )}
        {r.error && <div class="mt-1 text-[13px] text-[var(--color-status-failed)]">{r.error}</div>}
      </div>
      <div class="flex-none basis-[150px] flex flex-col gap-1.5 items-start">
        <span class="inline-flex items-center h-[22px] px-2.5 rounded-full text-[13px] font-medium" style={{ background: st.bg, color: st.fg }}>{st.label}</span>
        <span class="flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
          {r.permalink && <a href={r.permalink} target="_blank" rel="noopener noreferrer" class="text-[var(--color-accent)] underline">Xem trên FB</a>}
        </span>
        <span class="flex flex-wrap gap-1.5">
          {r.status === 'failed' && <button type="button" class={BTN_SM} disabled={busy} onClick={() => void act('retry', 'Đã gửi lại')}>Gửi lại</button>}
          {r.status === 'draft' && <button type="button" class={BTN_SM} disabled={busy} onClick={() => void act('send', 'Đã gửi trả lời')}>Gửi ngay</button>}
          {r.status === 'hidden' && <button type="button" class={BTN_SM} disabled={busy} onClick={() => void act('unhide', 'Đã bỏ ẩn')}>Bỏ ẩn</button>}
          {(r.status === 'sent' || r.status === 'human' || r.status === 'skipped' || r.status === 'failed') && (
            <button type="button" class={BTN_SM} disabled={busy} onClick={() => void act('hide', 'Đã ẩn bình luận')}>Ẩn</button>
          )}
        </span>
      </div>
    </article>
  );
}
