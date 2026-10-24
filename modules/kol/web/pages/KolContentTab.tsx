/** /kol/:id?tab=content — posts as a list or a week calendar, the post editor, and Radar ideas. */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { CalendarDays, ExternalLink, Lightbulb, List, Megaphone, Plus } from 'lucide-preact';
import { PageState } from '@/components/PageState';
import { PlatformBadge } from '@/components/social/PlatformBadge';
import { BTN_PRIMARY, BTN_SM, FilterChip } from '@modules/kol/web/components/shared/ops-shared';
import { PostEditor, type PostSeed } from '@modules/kol/web/components/PostEditor';
import { PublishReadiness } from '@modules/kol/web/components/Readiness';
import { WeekCalendar } from '@modules/kol/web/components/WeekCalendar';
import { AssetThumb, EmptyHint, Segmented, TonePill, toastError, toneColor } from '@modules/kol/web/components/ui';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import {
  KOL, POST_FORMAT_LABEL, POST_SOURCE_LABEL, POST_STATUS, TARGET_STATUS, addDays, fmtSlot, kolApi, postSlot, startOfWeek,
  type AccountDto, type KolSettingsDto, type PostDto, type PostStatus, type RadarIdeaDto,
} from '@modules/kol/web/lib/kol';
import type { WorkspaceTabProps } from './workspace-types';

type Filter = 'all' | 'draft' | 'review' | 'scheduled' | 'published' | 'failed' | 'cancelled';
const FILTERS: { key: Filter; label: string; statuses: PostStatus[] }[] = [
  { key: 'all', label: 'Tất cả', statuses: [] },
  { key: 'draft', label: 'Nháp & ý tưởng', statuses: ['idea', 'draft'] },
  { key: 'review', label: 'Chờ duyệt', statuses: ['review'] },
  { key: 'scheduled', label: 'Đã lên lịch', statuses: ['approved', 'scheduled', 'publishing'] },
  { key: 'published', label: 'Đã đăng', statuses: ['published', 'partial'] },
  { key: 'failed', label: 'Lỗi', statuses: ['failed'] },
  { key: 'cancelled', label: 'Đã huỷ', statuses: ['cancelled'] },
];
const matches = (f: Filter, p: PostDto) => (f === 'all' ? p.status !== 'cancelled' : FILTERS.find((x) => x.key === f)!.statuses.includes(p.status));

function readView(): 'list' | 'week' {
  try { return localStorage.getItem('kol-content-view') === 'week' ? 'week' : 'list'; } catch { return 'list'; }
}

export function KolContentTab({ persona, status, go, query }: WorkspaceTabProps) {
  const posts = useFetch<{ posts: PostDto[] }>(KOL.posts({ personaId: persona.id }), 30_000);
  const accounts = useFetch<{ accounts: AccountDto[] }>(KOL.accounts(persona.id));
  const settings = useFetch<{ settings: KolSettingsDto }>(KOL.settings);
  const [view, setView] = useState<'list' | 'week'>(readView);
  const [filter, setFilter] = useState<Filter>('all');
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [editor, setEditor] = useState<{ key: number; post: PostDto | null; seed?: PostSeed } | null>(null);

  useEffect(() => { try { localStorage.setItem('kol-content-view', view); } catch { /* storage may be blocked */ } }, [view]);

  // Deep links: ?new=1, ?compose=<assetId>, ?post=<postId>. Read once, then drop them from the URL.
  const qs = query.toString();
  useEffect(() => {
    const postId = query.get('post');
    const compose = query.get('compose');
    const isNew = query.get('new');
    if (!postId && !compose && !isNew) return;
    go('content', {}, true);
    if (postId) {
      kolApi.post(postId).then((r) => setEditor({ key: Date.now(), post: r.post })).catch((err) => toastError('Không mở được bài', err));
    } else if (compose) {
      kolApi.assets({ personaId: persona.id, limit: 200 })
        .then((r) => {
          const a = r.assets.find((x) => x.id === compose);
          setEditor({ key: Date.now(), post: null, seed: a ? { assets: [a], format: a.kind === 'video' ? 'reel' : 'photo' } : undefined });
        })
        .catch((err) => { toastError('Không tải được ảnh', err); setEditor({ key: Date.now(), post: null }); });
    } else {
      setEditor({ key: Date.now(), post: null });
    }
  }, [qs]);

  const all = posts.data?.posts ?? [];
  const shown = useMemo(() => {
    const now = Date.now() / 1000;
    const list = all.filter((p) => matches(filter, p));
    const upcoming = list.filter((p) => (postSlot(p) ?? 0) >= now && p.status !== 'published').sort((a, b) => (postSlot(a) ?? 0) - (postSlot(b) ?? 0));
    const rest = list.filter((p) => !upcoming.includes(p)).sort((a, b) => (postSlot(b) ?? b.updatedAt) - (postSlot(a) ?? a.updatedAt));
    return [...upcoming, ...rest];
  }, [all, filter]);

  function changed() {
    invalidateFetchCache('/api/m/kol/posts');
    invalidateFetchCache(KOL.personas);
    posts.refresh();
  }

  const accountList = accounts.data?.accounts ?? [];

  return (
    <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4">
      <div class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-4 items-start">
        <div class="flex flex-col gap-3 min-w-0">
          <PublishReadiness status={status} publishEnabled={settings.data?.settings.publishEnabled} />
          <div class="flex flex-wrap items-center gap-2">
            <Segmented
              label="Kiểu xem"
              value={view}
              onChange={setView}
              options={[
                { value: 'list', label: <span class="inline-flex items-center gap-1"><List size={13} />Danh sách</span> },
                { value: 'week', label: <span class="inline-flex items-center gap-1"><CalendarDays size={13} />Lịch tuần</span> },
              ]}
            />
            <button type="button" class={`${BTN_PRIMARY} ml-auto`} onClick={() => setEditor({ key: Date.now(), post: null })}><Plus size={14} />Bài mới</button>
          </div>
          <div role="group" aria-label="Lọc theo trạng thái" class="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <FilterChip key={f.key} on={filter === f.key} label={f.label} count={posts.data ? all.filter((p) => matches(f.key, p)).length : undefined}
                tone={f.key === 'failed' ? 'danger' : undefined} onClick={() => setFilter(f.key)} />
            ))}
          </div>

          {!posts.data && <PageState loading={posts.loading} error={posts.error} />}
          {posts.data && all.length === 0 && (
            <EmptyHint
              icon={<Megaphone size={20} />}
              title="Chưa có bài nào"
              action={<>
                <button type="button" class={BTN_PRIMARY} onClick={() => setEditor({ key: Date.now(), post: null })}><Plus size={14} />Viết bài đầu tiên</button>
                {accountList.length === 0 && <button type="button" class={BTN_SM} onClick={() => go('channels')}>Liên kết kênh trước</button>}
              </>}
            >
              Chọn ảnh đã duyệt, viết caption (hoặc để AI viết bằng giọng của {persona.name}), chọn kênh và giờ đăng. Bật Autopilot trong Hồ sơ để AI tự lên kế hoạch.
            </EmptyHint>
          )}

          {posts.data && all.length > 0 && view === 'week' && (
            <WeekCalendar
              posts={all.filter((p) => matches(filter, p))}
              weekStart={weekStart}
              onShift={(n) => setWeekStart((w) => addDays(w, 7 * n))}
              onToday={() => setWeekStart(startOfWeek(new Date()))}
              onOpen={(p) => setEditor({ key: Date.now(), post: p })}
            />
          )}

          {posts.data && all.length > 0 && view === 'list' && (
            shown.length === 0
              ? <p class="text-[12.5px] text-[var(--color-text-muted)]">Không có bài nào ở mục này.</p>
              : (
                <ul class="flex flex-col gap-2 list-none m-0 p-0">
                  {shown.map((p) => <li key={p.id}><PostRow post={p} onOpen={() => setEditor({ key: Date.now(), post: p })} /></li>)}
                </ul>
              )
          )}
        </div>

        {status?.radar !== false && <RadarIdeas onUse={(idea) => setEditor({ key: Date.now(), post: null, seed: { title: idea.title, brief: `${idea.detail}${idea.url ? `\n\nNguồn: ${idea.url}` : ''}` } })} />}
      </div>

      {editor && (
        <PostEditor
          key={editor.key}
          persona={persona}
          accounts={accountList}
          post={editor.post}
          seed={editor.seed}
          onClose={() => setEditor(null)}
          onChanged={changed}
        />
      )}
    </div>
  );
}

function PostRow({ post: p, onOpen }: { post: PostDto; onOpen: () => void }) {
  const st = POST_STATUS[p.status];
  const slot = postSlot(p);
  return (
    <button
      type="button"
      onClick={onOpen}
      class="w-full flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-2 text-left hover:border-[var(--color-border-strong)] hover:bg-[var(--color-control-hover)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] min-w-0"
      style={{ borderLeft: `3px solid ${toneColor(st.tone)}` }}
    >
      {p.assets[0]
        ? <AssetThumb asset={p.assets[0]} class="shrink-0 w-14 h-[70px] rounded-md" />
        : <span class="shrink-0 w-14 h-[70px] rounded-md bg-[var(--color-elevated)] flex items-center justify-center text-[10.5px] text-[var(--color-text-faint)]">{POST_FORMAT_LABEL[p.format]}</span>}
      <span class="flex-1 min-w-0 flex flex-col gap-1">
        <span class="flex flex-wrap items-center gap-1.5 min-w-0">
          <span class="text-[13.5px] font-medium text-[var(--color-text)] truncate max-w-full">{p.title || 'Bài chưa đặt tên'}</span>
          <TonePill tone={st.tone}>{st.label}</TonePill>
          {p.source !== 'owner' && <TonePill tone="accent">{POST_SOURCE_LABEL[p.source]}</TonePill>}
        </span>
        <span class="text-[12px] text-[var(--color-text-muted)] truncate">
          {POST_FORMAT_LABEL[p.format]}{p.pillar ? ` · ${p.pillar}` : ''}{p.assets.length > 1 ? ` · ${p.assets.length} file` : ''}{p.caption ? ` · ${p.caption.slice(0, 80)}` : ''}
        </span>
        <span class="flex flex-wrap items-center gap-2 text-[12px]">
          <span class="tabular-nums text-[var(--color-text)]">{slot ? fmtSlot(slot) : 'Chưa có giờ'}</span>
          {p.targets.map((t) => (
            <span key={t.id} class="inline-flex items-center gap-1" title={`${t.handle}: ${TARGET_STATUS[t.status].label}${t.error ? ` — ${t.error}` : ''}`}>
              <PlatformBadge platform={t.platform} size={16} />
              <span class="w-1.5 h-1.5 rounded-full" style={{ background: toneColor(TARGET_STATUS[t.status].tone) }} aria-hidden="true" />
            </span>
          ))}
        </span>
      </span>
    </button>
  );
}

function RadarIdeas({ onUse }: { onUse: (idea: RadarIdeaDto) => void }) {
  const ideas = useFetch<{ ideas: RadarIdeaDto[] }>(KOL.radarIdeas(10));
  const list = ideas.data?.ideas ?? [];
  return (
    <aside class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-3 flex flex-col gap-2.5 min-w-0 xl:sticky xl:top-0" aria-label="Ý tưởng từ Radar">
      <div class="flex items-center gap-2">
        <Lightbulb size={15} class="text-[var(--color-accent)]" aria-hidden="true" />
        <h2 class="text-[13.5px] font-semibold">Ý tưởng từ Radar</h2>
        <Link href="/m/radar" class="ml-auto text-[12px] text-[var(--color-text-muted)] underline">Mở Radar</Link>
      </div>
      {ideas.error && <p class="text-[12px] text-[var(--color-status-failed)]">{ideas.error}</p>}
      {ideas.loading && !ideas.data && <p class="text-[12px] text-[var(--color-text-faint)]">Đang tải…</p>}
      {ideas.data && list.length === 0 && <p class="text-[12px] text-[var(--color-text-muted)]">Chưa có ý tưởng mới. Radar quét thị trường mỗi ngày; ý tưởng hợp sẽ hiện ở đây.</p>}
      <ul class="flex flex-col gap-2 list-none m-0 p-0">
        {list.map((idea) => (
          <li key={idea.key} class="rounded-md border border-[var(--color-border)] p-2.5 flex flex-col gap-1.5">
            <span class="text-[11px] text-[var(--color-text-faint)]">{idea.layer} · {idea.day}</span>
            <span class="text-[12.5px] font-medium text-[var(--color-text)]">{idea.title}</span>
            {idea.detail && <span class="text-[12px] text-[var(--color-text-muted)] line-clamp-3">{idea.detail}</span>}
            <span class="flex items-center gap-2">
              {idea.url && <a href={idea.url} target="_blank" rel="noopener noreferrer" class="text-[11.5px] text-[var(--color-accent)] underline inline-flex items-center gap-0.5">Nguồn<ExternalLink size={10} /></a>}
              <button type="button" class={`${BTN_SM} ml-auto`} onClick={() => { onUse(idea); pushToast({ tone: 'info', title: 'Đã mở bài mới từ ý tưởng' }); }}>Tạo bài từ ý tưởng</button>
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

