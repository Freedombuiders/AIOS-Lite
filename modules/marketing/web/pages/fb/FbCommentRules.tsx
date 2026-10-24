import { useEffect, useMemo, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { Plus } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Toggle } from '@/components/Toggle';
import { Card, SetupNotice } from '@modules/marketing/web/components/fb/common';
import {
  apiFail, BTN, BTN_PRIMARY, BTN_SM, Checkbox, ConnDot, FbReadiness, FetchError, Field, INPUT, LABEL_CAPS, NoPageNotice,
  PageSelect, TEXTAREA, useFbPages,
} from '@modules/marketing/web/components/fb/ops-shared';
import { CommentsTabs, commentsPageId, pickCommentsPage } from '@modules/marketing/web/components/fb/comments/shared';
import { KeywordChips } from '@modules/marketing/web/components/fb/comments/KeywordChips';
import { TemplateEditor } from '@modules/marketing/web/components/fb/comments/TemplateEditor';
import { apiDelete, apiPatch, apiPost, apiPut } from '@/lib/api';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { useDebouncedValue } from '@/lib/useDebounce';
import { pushToast } from '@/lib/toasts';
import type {
  CommentStep, FbPageDto, FbStatusDto, ReplyRuleConfig, ReplyRulesDto, ReplyTemplateDto, RuleTestResult,
} from '@modules/marketing/web/lib/fbstudio';

const STEP_NO: Record<CommentStep, number> = { spam: 1, complaint: 2, template: 3, agent: 4, skip: 5 };
const SAMPLES = ['AI', 'xin tài liệu với ạ', 'Link bấm không vào được', 'hay quá', 'Khóa này dùng cho ngành spa được không ạ?'];

export function FbCommentRules() {
  const { pages, enabledPages, loading: pagesLoading, error: pagesError } = useFbPages();
  const page = pickCommentsPage(pages);
  const [scope, setScope] = useState<'page' | 'post'>('page');
  const [postId, setPostId] = useState('');

  // Posts for the per-post picker come with the rules of the Page.
  const pageRules = useFetch<ReplyRulesDto>(page?.enabled ? `/api/m/marketing/comments/rules?page=${encodeURIComponent(page.id)}` : null);
  const posts = pageRules.data?.posts ?? [];
  const activePost = scope === 'post' ? (postId && posts.some((p) => p.postId === postId) ? postId : posts[0]?.postId ?? '') : '';

  const path = page?.enabled
    ? `/api/m/marketing/comments/rules?page=${encodeURIComponent(page.id)}${activePost ? `&post=${encodeURIComponent(activePost)}` : ''}`
    : null;
  const rules = useFetch<ReplyRulesDto>(scope === 'post' && !activePost ? null : path);
  const d = rules.data;

  function refreshRules() {
    invalidateFetchCache('/api/m/marketing/comments/rules');
    rules.refresh();
    pageRules.refresh();
  }

  return (
    <div class="flex flex-col h-full min-h-0">
      <>
        {/* The Lưu button lives in RulesEditor's own header row so it can see the draft. */}
        {!page || !page.enabled || !d ? (
          <PageHeader
            breadcrumb="Marketing · Facebook"
            title="Bình luận AI"
            actions={pages.length > 0 ? <PageSelect pages={pages} value={page?.id ?? ''} onChange={(id) => { commentsPageId.value = id; setScope('page'); setPostId(''); }} /> : undefined}
            tabs={<CommentsTabs />}
          />
        ) : null}
        <div class={`${d && page?.enabled ? 'contents' : 'flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-5 flex flex-col gap-4'}`}>
          {pagesLoading && pages.length === 0 && <PageState loading />}
          {pagesError && pages.length === 0 && <FetchError error={pagesError} />}
          {!pagesLoading && !pagesError && enabledPages.length === 0 && (
            <>
              <FbReadiness />
              <NoPageNotice hasPages={pages.length > 0} />
            </>
          )}
          {page && !page.enabled && enabledPages.length > 0 && (
            <SetupNotice title={`Page “${page.name}” chưa được bật`}>
              Bật Page này ở <Link href="/m/marketing" class="text-[var(--color-accent)] underline">FB · Cài đặt Page</Link>, hoặc chọn một Page đang bật ở góc trên.
            </SetupNotice>
          )}
          {page?.enabled && rules.error && !d && <FetchError error={rules.error} onRetry={rules.refresh} />}
          {page?.enabled && rules.loading && !d && scope === 'page' && <PageState loading />}

          {page?.enabled && d && (
            <RulesEditor
              key={`${page.id}:${activePost}:${JSON.stringify(d.effective)}:${JSON.stringify(d.overrides)}`}
              page={page}
              pages={pages}
              data={d}
              scope={scope}
              setScope={setScope}
              postId={activePost}
              setPostId={setPostId}
              posts={posts}
              onPageChange={(id) => { commentsPageId.value = id; setScope('page'); setPostId(''); }}
              onChanged={refreshRules}
            />
          )}
          {page?.enabled && scope === 'post' && posts.length === 0 && pageRules.data && (
            <SetupNotice title="Chưa có bài nào để đặt luật riêng">
              Danh sách bài lấy từ các bài đã đăng gần đây của Page. Khi Page có bài đăng, chọn bài ở đây để ghi đè luật.
              <div class="mt-2"><button type="button" class={BTN_SM} onClick={() => setScope('page')}>Quay lại luật toàn Page</button></div>
            </SetupNotice>
          )}
        </div>
      </>
    </div>
  );
}

function RulesEditor({ page, pages, data, scope, setScope, postId, setPostId, posts, onPageChange, onChanged }: {
  page: FbPageDto;
  pages: FbPageDto[];
  data: ReplyRulesDto;
  scope: 'page' | 'post';
  setScope: (s: 'page' | 'post') => void;
  postId: string;
  setPostId: (id: string) => void;
  posts: ReplyRulesDto['posts'];
  onPageChange: (id: string) => void;
  onChanged: () => void;
}) {
  const status = useFetch<FbStatusDto>('/api/m/marketing/status', 120_000);
  const [cfg, setCfg] = useState<ReplyRuleConfig>(data.effective);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<ReplyTemplateDto | 'new' | null>(null);

  const set = <K extends keyof ReplyRuleConfig>(k: K, v: ReplyRuleConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const dirty = JSON.stringify(cfg) !== JSON.stringify(data.effective);
  const inPost = scope === 'post' && postId !== '';

  async function save() {
    setSaving(true);
    try {
      const changed: Partial<ReplyRuleConfig> = {};
      for (const k of Object.keys(cfg) as (keyof ReplyRuleConfig)[]) {
        if (JSON.stringify(cfg[k]) !== JSON.stringify(data.effective[k])) (changed as Record<string, unknown>)[k] = cfg[k];
      }
      // On a post, send the existing overrides plus what changed now; on the Page, the whole config.
      const config = inPost ? { ...(data.overrides ?? {}), ...changed } : cfg;
      await apiPut('/api/m/marketing/comments/rules', { pageId: page.id, ...(inPost ? { postId } : {}), config });
      pushToast({ tone: 'success', title: 'Đã lưu cấu hình bình luận AI' });
      onChanged();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không lưu được', description: apiFail(err).message });
    } finally {
      setSaving(false);
    }
  }

  async function dropOverride() {
    try {
      await apiDelete(`/api/m/marketing/comments/rules?page=${encodeURIComponent(page.id)}&post=${encodeURIComponent(postId)}`);
      pushToast({ tone: 'success', title: 'Bài này đã dùng lại luật của Page' });
      onChanged();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không xóa được cấu hình riêng', description: apiFail(err).message });
    }
  }

  async function toggleTemplate(t: ReplyTemplateDto) {
    try {
      await apiPatch(`/api/m/marketing/comments/templates/${t.id}`, { enabled: !t.enabled });
      onChanged();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không đổi được trạng thái mẫu', description: apiFail(err).message });
    }
  }

  const agentIds = useMemo(() => {
    const ids = [...data.agents];
    if (cfg.agentId && !ids.includes(cfg.agentId)) ids.unshift(cfg.agentId);
    if (!ids.includes('main')) ids.push('main');
    return ids;
  }, [data.agents, cfg.agentId]);
  const skillIds = useMemo(() => {
    const ids = [...data.skills];
    if (cfg.skill && !ids.includes(cfg.skill)) ids.unshift(cfg.skill);
    return ids;
  }, [data.skills, cfg.skill]);

  const overriddenPosts = posts.filter((p) => p.hasOverride).length;
  const conn = status.data?.composio;
  const readsPerDay = Math.round((24 * 60) / Math.max(1, cfg.pollMinutes));
  const fmtPostDate = (s: number | null) => (s ? `${new Date(s * 1000).getDate()}/${new Date(s * 1000).getMonth() + 1}` : '');

  return (
    <>
      <PageHeader
        breadcrumb="Marketing · Facebook"
        title="Bình luận AI"
        actions={
          <>
            <PageSelect pages={pages} value={page.id} onChange={onPageChange} />
            {dirty && <span class="text-[13px] text-[var(--color-priority-medium)]">Chưa lưu thay đổi</span>}
            <button type="button" class={BTN_PRIMARY} disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? 'Đang lưu…' : 'Lưu cấu hình'}
            </button>
          </>
        }
        tabs={<CommentsTabs />}
      />
      <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-5 flex flex-col gap-4 pb-8">
        <p class="text-[13px] text-[var(--color-text-muted)] -mb-1">Đặt luật một lần cho cả Page, hoặc ghi đè cho từng bài.</p>
        <FbReadiness />

        <section aria-label="Phạm vi áp dụng" class="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3.5 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)]">
          <div role="group" aria-label="Áp dụng cho" class="flex items-center gap-2.5 text-[13px]">
            <span class="text-[var(--color-text-muted)]">Áp dụng cho</span>
            <div class="flex rounded-md border border-[var(--color-border-strong)] overflow-hidden">
              <button type="button" aria-pressed={scope === 'page'} onClick={() => setScope('page')} class={`h-9 px-3.5 text-[13px] font-semibold ${scope === 'page' ? 'bg-[var(--color-accent-soft)] text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`}>Toàn Page</button>
              <button type="button" aria-pressed={scope === 'post'} onClick={() => setScope('post')} class={`h-9 px-3.5 text-[13px] font-semibold border-l border-[var(--color-border-strong)] ${scope === 'post' ? 'bg-[var(--color-accent-soft)] text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`}>Từng bài</button>
            </div>
          </div>
          {scope === 'page' ? (
            <span class="text-[13px] text-[var(--color-text-muted)]">
              Mọi bài trên {page.name} dùng luật dưới đây{overriddenPosts > 0 ? `, trừ ${overriddenPosts} bài có cấu hình riêng` : ''}.
            </span>
          ) : (
            <>
              <label class="flex items-center gap-2 text-[13px] text-[var(--color-text-muted)]">
                Bài
                <select class={`${INPUT} max-w-[360px]`} value={postId} onChange={(e) => setPostId((e.target as HTMLSelectElement).value)}>
                  {posts.map((p) => (
                    <option key={p.postId} value={p.postId}>{p.title || p.postId}{p.publishedAt ? ` · ${fmtPostDate(p.publishedAt)}` : ''} · {p.hasOverride ? 'riêng' : 'theo Page'}</option>
                  ))}
                </select>
              </label>
              <span class="text-[13px] text-[var(--color-text-muted)]">
                {data.overrides && Object.keys(data.overrides).length > 0
                  ? `Bài này ghi đè ${Object.keys(data.overrides).length} mục; các mục khác kế thừa từ Page.`
                  : 'Bài này đang kế thừa mọi thứ từ Page. Sửa và lưu để tạo cấu hình riêng.'}
              </span>
              {data.overrides && <button type="button" class={BTN_SM} onClick={() => void dropOverride()}>Dùng lại luật của Page</button>}
            </>
          )}
          <label class="ml-auto flex items-center gap-2.5 text-[13px]">
            Tự trả lời
            <Toggle on={cfg.enabled} ariaLabel="Bật tự trả lời bình luận" onChange={() => set('enabled', !cfg.enabled)} />
          </label>
        </section>
        {cfg.enabled && !data.effective.enabled && (
          <p class="m-0 text-[13px] text-[var(--color-text-muted)]">
            Khi bật lần đầu, chỉ bình luận mới được xử lý. Bình luận cũ được đánh dấu “bỏ qua” để không trả lời dồn.
          </p>
        )}

        <PipelineBox cfg={cfg} pageId={page.id} postId={inPost ? postId : ''} dirty={dirty} />

        <Card
          title="Bước 3 · Mẫu trả lời nhanh"
          aside={<button type="button" class={BTN} onClick={() => setEditing('new')}><Plus size={13} /> Thêm mẫu</button>}
        >
          <p class="m-0 text-[13px] text-[var(--color-text-muted)] -mt-1">
            Không tốn lượt gọi agent. {'{ten}'} = tên người bình luận. Mỗi mẫu xoay vòng các cách viết để không trùng lặp.
          </p>
          {data.templates.length === 0 ? (
            <p class="m-0 text-[13px] text-[var(--color-text-muted)]">
              Chưa có mẫu nào. Bấm “Thêm mẫu” cho những câu lặp lại như “AI”, “ib”, “học phí”: trả lời tức thì, không cần agent.
            </p>
          ) : (
            <div class="overflow-x-auto -mx-4">
              <div class="min-w-[860px]">
                <div class="grid grid-cols-[170px_120px_minmax(240px,1fr)_90px_110px_64px] gap-3 px-4 py-2 text-[11.5px] text-[var(--color-text-muted)]">
                  <span>Từ khóa</span><span>Cách khớp</span><span>Trả lời công khai</span><span>Nhắn riêng</span><span>Áp dụng</span><span>Bật</span>
                </div>
                {data.templates.map((t) => (
                  <div
                    key={t.id}
                    class={`grid grid-cols-[170px_120px_minmax(240px,1fr)_90px_110px_64px] gap-3 items-center px-4 py-2.5 border-t border-[var(--color-border)] text-[13px] ${t.enabled ? '' : 'opacity-55'}`}
                  >
                    <span class="flex flex-wrap gap-1">
                      {t.keywords.map((k) => <span key={k} class="inline-flex items-center h-6 px-2 rounded-md bg-[var(--color-elevated)] font-mono text-[13px]">{k}</span>)}
                    </span>
                    <span class="text-[var(--color-text-muted)]">{t.matchMode === 'exact' ? 'Đúng nguyên văn' : 'Chứa từ'}</span>
                    <span class="leading-snug min-w-0">
                      <button type="button" class="text-left hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] rounded" onClick={() => setEditing(t)} aria-label={`Sửa mẫu ${t.name}`}>
                        {t.variants[0] ?? ''}
                      </button>{' '}
                      <span class="text-[13px] text-[var(--color-text-faint)]">· {t.variants.length} cách viết · dùng {t.uses} lần</span>
                    </span>
                    <span class="text-[var(--color-text-muted)]">{t.privateText ? 'Có' : 'Không'}</span>
                    <span class="text-[var(--color-text-muted)]">{t.postId ? 'Riêng bài' : 'Toàn Page'}</span>
                    <Toggle on={t.enabled} ariaLabel={`Bật mẫu ${t.name}`} onChange={() => void toggleTemplate(t)} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        <div class="flex flex-wrap gap-4 items-start">
          <Card title="Bước 4 · Trả lời bằng agent" class="flex-[3_1_560px] basis-[560px] gap-4">
            <p class="m-0 text-[13px] text-[var(--color-text-muted)] -mt-2">Chỉ chạy khi không khớp mẫu nhanh nào. Agent dùng chung với Workspace › Agents.</p>

            <fieldset class="border-0 p-0 m-0 flex flex-col gap-1.5">
              <legend class={`${LABEL_CAPS} pb-2`}>Gọi agent khi</legend>
              <div class="flex flex-wrap items-center gap-2.5 min-h-9 text-[13.5px]">
                Bình luận có ít nhất
                <input type="number" min={1} aria-label="Số từ tối thiểu" class={`${INPUT} w-16 h-8 px-2`} value={cfg.minWords} onInput={(e) => set('minWords', Math.max(1, Number((e.target as HTMLInputElement).value) || 1))} />
                từ
              </div>
              <Checkbox checked={cfg.questionMark} onChange={(v) => set('questionMark', v)}>hoặc có dấu hỏi “?”</Checkbox>
              <Checkbox checked={cfg.onlyIfNotRepliedHours !== null} onChange={(v) => set('onlyIfNotRepliedHours', v ? 24 : null)}>
                Chỉ với người chưa được trả lời trong
                <input
                  type="number"
                  min={1}
                  aria-label="Số giờ chưa được trả lời"
                  disabled={cfg.onlyIfNotRepliedHours === null}
                  class={`${INPUT} w-16 h-8 px-2`}
                  value={cfg.onlyIfNotRepliedHours ?? 24}
                  onInput={(e) => set('onlyIfNotRepliedHours', Math.max(1, Number((e.target as HTMLInputElement).value) || 24))}
                />
                giờ
              </Checkbox>
            </fieldset>

            <div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
              <Field label="Agent trả lời">
                <select class={INPUT} value={cfg.agentId} onChange={(e) => set('agentId', (e.target as HTMLSelectElement).value)}>
                  {agentIds.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </Field>
              <Field label="Skill dùng để trả lời">
                <select class={INPUT} value={cfg.skill} onChange={(e) => set('skill', (e.target as HTMLSelectElement).value)}>
                  <option value="">Không dùng skill</option>
                  {skillIds.map((s) => <option key={s} value={s}>/{s}</option>)}
                </select>
              </Field>
            </div>

            <fieldset class="border-0 p-0 m-0 flex flex-col gap-0.5">
              <legend class={`${LABEL_CAPS} pb-2`}>Gửi kèm cho agent</legend>
              <Checkbox checked={cfg.contextPost} onChange={(v) => set('contextPost', v)}>Nội dung bài viết đang được bình luận</Checkbox>
              <Checkbox checked={cfg.contextVoice} onChange={(v) => set('contextVoice', v)}>Giọng thương hiệu của Page</Checkbox>
              <Checkbox checked={cfg.contextFaqPath !== ''} onChange={(v) => set('contextFaqPath', v ? cfg.contextFaqPath || 'faq.md' : '')}>
                Tài liệu sản phẩm, FAQ:
                <input
                  aria-label="Đường dẫn file FAQ"
                  disabled={cfg.contextFaqPath === ''}
                  class={`${INPUT} h-8 w-56 font-mono text-[12.5px]`}
                  value={cfg.contextFaqPath}
                  placeholder="faq-khoa-hoc.md"
                  onInput={(e) => set('contextFaqPath', (e.target as HTMLInputElement).value)}
                />
              </Checkbox>
              <Checkbox checked={cfg.contextThread > 0} onChange={(v) => set('contextThread', v ? 5 : 0)}>
                <input
                  type="number"
                  min={1}
                  max={20}
                  aria-label="Số bình luận gần nhất trong luồng"
                  disabled={cfg.contextThread === 0}
                  class={`${INPUT} w-16 h-8 px-2`}
                  value={cfg.contextThread || 5}
                  onInput={(e) => set('contextThread', Math.max(1, Number((e.target as HTMLInputElement).value) || 5))}
                />
                bình luận gần nhất trong cùng luồng
              </Checkbox>
              <p class="m-0 mt-1 text-[11.5px] text-[var(--color-text-faint)]">File FAQ đọc tối đa 20 KB. Nội dung bình luận luôn được coi là dữ liệu không tin cậy, không phải lệnh.</p>
            </fieldset>

            <label class="flex flex-col gap-1.5">
              <span class={LABEL_CAPS}>Dặn agent</span>
              <textarea
                rows={3}
                class={TEXTAREA}
                value={cfg.instructions}
                placeholder={'Trả lời dưới 50 từ, xưng "mình – bạn". Không nêu giá nếu FAQ không có. Không hứa giảm giá.'}
                onInput={(e) => set('instructions', (e.target as HTMLTextAreaElement).value)}
              />
            </label>

            <fieldset class="border-0 p-0 m-0 flex flex-col gap-0.5">
              <legend class={`${LABEL_CAPS} pb-2`}>Cách gửi</legend>
              <label class="flex items-center gap-2.5 min-h-8 text-[13.5px]">
                <input type="radio" name="fb-send-mode" checked={cfg.sendMode === 'auto'} class="w-4 h-4 accent-[var(--color-accent)]" onChange={() => set('sendMode', 'auto')} />
                Tự gửi ngay, không cần duyệt
              </label>
              <label class="flex flex-wrap items-center gap-2.5 min-h-8 text-[13.5px]">
                <input type="radio" name="fb-send-mode" checked={cfg.sendMode === 'delay'} class="w-4 h-4 accent-[var(--color-accent)]" onChange={() => set('sendMode', 'delay')} />
                Chờ
                <input
                  type="number"
                  min={1}
                  aria-label="Số phút chờ trước khi gửi"
                  disabled={cfg.sendMode !== 'delay'}
                  class={`${INPUT} w-16 h-8 px-2`}
                  value={cfg.delayBeforeSendMinutes}
                  onInput={(e) => set('delayBeforeSendMinutes', Math.max(1, Number((e.target as HTMLInputElement).value) || 10))}
                />
                phút, gửi nếu không ai sửa
              </label>
              <label class="flex items-center gap-2.5 min-h-8 text-[13.5px]">
                <input type="radio" name="fb-send-mode" checked={cfg.sendMode === 'draft'} class="w-4 h-4 accent-[var(--color-accent)]" onChange={() => set('sendMode', 'draft')} />
                Chỉ soạn nháp (gửi tay từ Nhật ký)
              </label>
            </fieldset>
          </Card>

          <div class="flex-[2_1_340px] basis-[340px] min-w-0 flex flex-col gap-4">
            <Card title="Bước 1–2 · Lọc spam và phàn nàn">
              <div class="flex flex-col gap-1.5">
                <span class="text-[13px] font-semibold text-[var(--color-text-muted)]">Ẩn bình luận khi có</span>
                <Checkbox checked={cfg.hideLinks} onChange={(v) => set('hideLinks', v)}>đường link lạ (http…)</Checkbox>
                <KeywordChips value={cfg.spamKeywords} onChange={(v) => set('spamKeywords', v)} label="Từ khóa spam" />
              </div>
              <div class="flex flex-col gap-1.5">
                <span class="text-[13px] font-semibold text-[var(--color-text-muted)]">Không tự trả lời, báo người khi có</span>
                <KeywordChips value={cfg.complaintKeywords} onChange={(v) => set('complaintKeywords', v)} label="Từ khóa phàn nàn" />
                <label class="flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">
                  Báo qua
                  <select class={`${INPUT} h-8`} value={cfg.notify} onChange={(e) => set('notify', (e.target as HTMLSelectElement).value as ReplyRuleConfig['notify'])}>
                    <option value="telegram">Telegram</option>
                    <option value="zalo">Zalo</option>
                    <option value="none">Không báo</option>
                  </select>
                </label>
              </div>
            </Card>

            <Card title="Giới hạn an toàn">
              <NumRow label="Tối đa trả lời mỗi giờ" value={cfg.maxPerHour} min={1} onChange={(v) => set('maxPerHour', v)} />
              <div class="flex items-center justify-between gap-2.5 text-[13px]">
                Trễ ngẫu nhiên trước khi gửi
                <span class="flex items-center gap-1.5">
                  <input type="number" min={0} aria-label="Trễ tối thiểu (phút)" class={`${INPUT} w-14 h-8 px-2`} value={cfg.delayMinMinutes} onInput={(e) => set('delayMinMinutes', Math.max(0, Number((e.target as HTMLInputElement).value) || 0))} />
                  –
                  <input type="number" min={0} aria-label="Trễ tối đa (phút)" class={`${INPUT} w-14 h-8 px-2`} value={cfg.delayMaxMinutes} onInput={(e) => set('delayMaxMinutes', Math.max(0, Number((e.target as HTMLInputElement).value) || 0))} />
                  phút
                </span>
              </div>
              {cfg.delayMaxMinutes < cfg.delayMinMinutes && <div class="text-[13px] text-[var(--color-priority-medium)]">Trễ tối đa nên lớn hơn hoặc bằng trễ tối thiểu.</div>}
              <NumRow label="Tối đa trả lời một người mỗi bài" value={cfg.maxPerUserPerPost} min={1} onChange={(v) => set('maxPerUserPerPost', v)} />
              <p class="m-0 text-[13px] text-[var(--color-text-faint)]">Không bao giờ trả lời bình luận của chính Page.</p>
            </Card>

            <Card
              title="Kết nối Composio"
              aside={conn ? <span class="inline-flex items-center gap-1.5 text-[12.5px]"><ConnDot status={conn.facebook} />Facebook {conn.facebook}</span> : undefined}
            >
              <label class="flex items-center justify-between gap-2.5 text-[13px]">
                Thu bình luận mới mỗi
                <select class={`${INPUT} h-8`} value={cfg.pollMinutes} onChange={(e) => set('pollMinutes', Number((e.target as HTMLSelectElement).value))}>
                  {withValue([5, 10, 30], cfg.pollMinutes).map((n) => <option key={n} value={n}>{n} phút</option>)}
                </select>
              </label>
              <label class="flex items-center justify-between gap-2.5 text-[13px]">
                Cho bài đăng trong
                <select class={`${INPUT} h-8`} value={cfg.maxPostAgeDays} onChange={(e) => set('maxPostAgeDays', Number((e.target as HTMLSelectElement).value))}>
                  {withValue([3, 7, 14], cfg.maxPostAgeDays).map((n) => <option key={n} value={n}>{n} ngày</option>)}
                </select>
              </label>
              <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-1.5 text-[13px]">
                <dt class="text-[var(--color-text-muted)]">Đọc</dt><dd class="m-0 font-mono text-[11.5px]">FACEBOOK_GET_PAGE_POSTS, FACEBOOK_GET_COMMENTS</dd>
                <dt class="text-[var(--color-text-muted)]">Trả lời</dt><dd class="m-0 font-mono text-[11.5px]">FACEBOOK_CREATE_COMMENT</dd>
                <dt class="text-[var(--color-text-muted)]">Ẩn, nhắn riêng</dt><dd class="m-0">Graph API qua composio proxy</dd>
              </dl>
              <p class="m-0 text-[13px] text-[var(--color-text-faint)]">
                Ước tính {readsPerDay} lượt đọc mỗi ngày cho Page này, cộng một lượt cho mỗi bài có bình luận mới. Tổng ngân sách chỉnh ở Modules › Marketing Facebook.
              </p>
            </Card>
          </div>
        </div>
      </div>

      {editing !== null && (
        <TemplateEditor
          template={editing === 'new' ? null : editing}
          pageId={page.id}
          postId={inPost ? postId : null}
          onClose={() => setEditing(null)}
          onChanged={onChanged}
        />
      )}
    </>
  );
}

function withValue(options: number[], current: number): number[] {
  return options.includes(current) ? options : [...options, current].sort((a, b) => a - b);
}

function NumRow({ label, value, min, onChange }: { label: string; value: number; min: number; onChange: (v: number) => void }) {
  return (
    <label class="flex items-center justify-between gap-2.5 text-[13px]">
      {label}
      <input type="number" min={min} aria-label={label} class={`${INPUT} w-16 h-8 px-2`} value={value} onInput={(e) => onChange(Math.max(min, Number((e.target as HTMLInputElement).value) || min))} />
    </label>
  );
}

/** The 5-step pipeline with a test box that lights up the step the sentence lands on. */
function PipelineBox({ cfg, pageId, postId, dirty }: { cfg: ReplyRuleConfig; pageId: string; postId: string; dirty: boolean }) {
  const [text, setText] = useState('');
  const dText = useDebouncedValue(text, 350);
  const [result, setResult] = useState<RuleTestResult | null>(null);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!dText.trim()) { setResult(null); setError(''); setTesting(false); return; }
    let cancelled = false;
    setTesting(true);
    apiPost<RuleTestResult>('/api/m/marketing/comments/test', { pageId, ...(postId ? { postId } : {}), text: dText })
      .then((r) => { if (!cancelled) { setResult(r); setError(''); } })
      .catch((e) => { if (!cancelled) { setResult(null); setError(apiFail(e).message); } })
      .finally(() => { if (!cancelled) setTesting(false); });
    return () => { cancelled = true; };
  }, [dText, pageId, postId]);

  const active = result ? STEP_NO[result.step] : 0;
  const steps: [string, string][] = [
    ['Lọc spam', 'Link lạ, quảng cáo: ẩn bình luận'],
    ['Phàn nàn', 'Từ khóa nhạy cảm: báo người, không tự trả lời'],
    ['Mẫu nhanh', 'Khớp từ khóa: trả lời bằng mẫu'],
    ['Agent', `Từ ${cfg.minWords} từ${cfg.questionMark ? ' hoặc có “?”' : ''}: agent viết trả lời`],
    ['Bỏ qua', 'Còn lại: không trả lời'],
  ];

  return (
    <>
      <section aria-label="Thứ tự xử lý" class="rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)] p-4 flex flex-col gap-3">
        <div class="flex flex-wrap justify-between gap-2">
          <h2 class="m-0 text-[14px] font-semibold">Mỗi bình luận đi qua 5 bước, dừng ở bước đầu tiên khớp</h2>
          <span class="text-[13px] text-[var(--color-text-muted)]">Ô sáng = bước khớp với câu ở mục Thử luật</span>
        </div>
        <ol class="m-0 p-0 list-none flex flex-wrap items-stretch gap-2">
          {steps.map(([title, desc], i) => {
            const on = active === i + 1;
            return (
              <li key={title} class="flex-1 basis-[160px] min-w-0 flex items-center gap-2" aria-current={on ? 'step' : undefined}>
                <div
                  class="flex-1 min-w-0 h-full box-border p-3 rounded-[10px] flex flex-col gap-1"
                  style={{
                    border: on ? '2px solid var(--color-accent)' : '1px solid var(--color-border-strong)',
                    background: on ? 'var(--color-accent-soft)' : 'var(--color-sidebar)',
                  }}
                >
                  <span class="text-[11.5px] text-[var(--color-text-muted)]">Bước {i + 1}{on ? ' · khớp' : ''}</span>
                  <span class="text-[13.5px] font-semibold">{title}</span>
                  <span class="text-[13px] leading-snug text-[var(--color-text-muted)]">{desc}</span>
                </div>
                {i < 4 && <span aria-hidden="true" class="text-[16px] text-[var(--color-text-faint)]">→</span>}
              </li>
            );
          })}
        </ol>
      </section>

      <section aria-label="Thử luật" class="rounded-[10px] border border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] bg-[var(--color-accent-soft)] p-4 flex flex-col gap-2.5">
        <label class="flex flex-col gap-1.5 text-[13px] font-semibold">
          Thử luật với một bình luận
          <input
            type="text"
            value={text}
            placeholder="Gõ một bình luận, ví dụ: Khóa này dùng cho ngành spa được không ạ?"
            class={`${INPUT} h-10 text-[14px] font-normal`}
            onInput={(e) => setText((e.target as HTMLInputElement).value)}
          />
        </label>
        <div class="flex flex-wrap items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
          Thử nhanh:
          {SAMPLES.map((s) => (
            <button key={s} type="button" onClick={() => setText(s)} class="h-7 px-2.5 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-card)] text-[13px] text-[var(--color-text)] hover:bg-[var(--color-control-hover)]">
              {s}
            </button>
          ))}
        </div>
        <div role="status" class="text-[13.5px] leading-relaxed min-h-[1.5em]">
          {!text.trim() && <><strong class="font-semibold">Chưa có câu.</strong> Gõ một bình luận để xem nó đi tới bước nào.</>}
          {text.trim() && error && <span class="text-[var(--color-status-failed)]">Không thử được: {error}</span>}
          {text.trim() && !error && result && <><strong class="font-semibold">{result.head}</strong> {result.body}</>}
          {text.trim() && !error && !result && testing && <span class="text-[var(--color-text-faint)]">Đang thử…</span>}
        </div>
        {dirty && text.trim() && <div class="text-[11.5px] text-[var(--color-text-faint)]">Thử luật dùng cấu hình đã lưu. Bấm “Lưu cấu hình” để thấy ảnh hưởng của thay đổi vừa sửa.</div>}
      </section>
    </>
  );
}
