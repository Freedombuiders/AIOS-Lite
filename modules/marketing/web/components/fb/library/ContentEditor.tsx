// Create / edit one Kho content row, with the status actions that apply to it
// (send for review, approve, return, unschedule, publish now, delete).

import { useState } from 'preact/hooks';
import { ExternalLink } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { ConfirmModal } from '@/components/ConfirmModal';
import { FormatChip, StatusPill } from '@modules/marketing/web/components/fb/common';
import {
  apiFail, BTN, BTN_DANGER, BTN_PRIMARY, Field, fmtDayLong, fromLocalInput, INPUT, InlineError, TEXTAREA, toLocalInput,
} from '@modules/marketing/web/components/fb/ops-shared';
import { apiDelete, apiPatch, apiPost } from '@/lib/api';
import { useFetch } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import {
  FORMAT_META,
  type FbContentDto, type FbContentInput, type FbContentStatus, type FbFormat, type FbPageDto, type FbPublishLogDto,
} from '@modules/marketing/web/lib/fbstudio';

type Detail = FbContentDto & { log?: FbPublishLogDto[] };
type Confirm = 'publish' | 'remote' | 'delete' | null;

const LOCKED: FbContentStatus[] = ['publishing', 'published', 'deleted'];

export function ContentEditor({ contentId, pages, onClose, onChanged }: {
  contentId: number | 'new';
  pages: FbPageDto[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const detail = useFetch<Detail>(contentId === 'new' ? null : `/api/m/marketing/content/${contentId}`);

  if (contentId !== 'new' && !detail.data) {
    return (
      <Modal open onClose={onClose} title="Chi tiết content" width={760}>
        {detail.error ? (
          <InlineError>Không tải được content: {detail.error}</InlineError>
        ) : (
          <div class="py-10 text-center text-[12px] text-[var(--color-text-faint)]">Đang tải…</div>
        )}
      </Modal>
    );
  }
  return (
    <EditorBody
      key={detail.data ? `${detail.data.id}:${detail.data.updatedAt}` : 'new'}
      content={detail.data}
      pages={pages}
      onClose={onClose}
      onChanged={() => { detail.refresh(); onChanged(); }}
    />
  );
}

function EditorBody({ content, pages, onClose, onChanged }: {
  content: Detail | null;
  pages: FbPageDto[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const isNew = content === null;
  const status: FbContentStatus = content?.status ?? 'draft';
  const locked = LOCKED.includes(status);
  const enabledPages = pages.filter((p) => p.enabled);
  const pageChoices = pages.filter((p) => p.enabled || p.id === content?.pageId);

  const [pageId, setPageId] = useState(content?.pageId ?? enabledPages[0]?.id ?? '');
  const [title, setTitle] = useState(content?.title ?? '');
  const [caption, setCaption] = useState(content?.caption ?? '');
  const [format, setFormat] = useState<FbFormat>(content?.format ?? 'text');
  const [pillar, setPillar] = useState(content?.pillar ?? '');
  const [hookType, setHookType] = useState(content?.hookType ?? '');
  const [cta, setCta] = useState(content?.cta ?? '');
  const [campaign, setCampaign] = useState(content?.campaign ?? '');
  const [linkUrl, setLinkUrl] = useState(content?.linkUrl ?? '');
  const [hooks, setHooks] = useState((content?.hooks ?? []).join('\n'));
  const [when, setWhen] = useState(toLocalInput(content?.scheduledAt));
  const [feedback, setFeedback] = useState('');
  const [returning, setReturning] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<Confirm>(null);

  const page = pages.find((p) => p.id === pageId);
  const needsLink = format === 'link';
  const whenSec = fromLocalInput(when);
  const canSave = !busy && title.trim().length > 0 && (!isNew || pageId !== '');

  function payload(): FbContentInput {
    const body: FbContentInput = {
      pageId: pageId || null,
      title: title.trim(),
      caption,
      format,
      pillar: pillar.trim(),
      hookType: hookType.trim(),
      cta: cta.trim(),
      campaign: campaign.trim(),
      linkUrl: linkUrl.trim(),
      hooks: hooks.split('\n').map((h) => h.trim()).filter(Boolean),
    };
    if (isNew) {
      if (whenSec) body.scheduledAt = whenSec;
    } else if (whenSec !== (content!.scheduledAt ?? null)) {
      body.scheduledAt = whenSec;
    }
    return body;
  }

  async function run(key: string, fn: () => Promise<unknown>, okTitle: string, closeAfter = false) {
    setBusy(key);
    setError('');
    try {
      await fn();
      pushToast({ tone: 'success', title: okTitle });
      onChanged();
      if (closeAfter) onClose();
    } catch (err) {
      setError(apiFail(err).message);
    } finally {
      setBusy('');
    }
  }

  const save = () =>
    run('save', () => (isNew ? apiPost('/api/m/marketing/content', payload()) : apiPatch(`/api/m/marketing/content/${content!.id}`, payload())),
      isNew ? 'Đã thêm vào Kho' : 'Đã lưu content', isNew);

  // Save pending edits first so the approval acts on what the owner sees.
  const approve = () =>
    run('approve', async () => {
      await apiPatch(`/api/m/marketing/content/${content!.id}`, payload());
      await apiPost(`/api/m/marketing/content/${content!.id}/approve`, whenSec ? { scheduledAt: whenSec } : {});
    }, whenSec ? 'Đã duyệt và xếp lịch' : 'Đã duyệt');

  const act = (path: string, okTitle: string, body?: unknown, closeAfter = false) =>
    run(path, () => apiPost(`/api/m/marketing/content/${content!.id}/${path}`, body), okTitle, closeAfter);

  const setStatus = (next: FbContentStatus, okTitle: string) =>
    run(next, () => apiPatch(`/api/m/marketing/content/${content!.id}`, { status: next }), okTitle);

  const footer = (
    <div class="flex flex-wrap items-center gap-2 w-full">
      {!isNew && status !== 'publishing' && status !== 'deleted' && (
        <button type="button" class={BTN_DANGER} disabled={!!busy} onClick={() => setConfirm('delete')}>Xóa khỏi Kho</button>
      )}
      <div class="ml-auto flex flex-wrap items-center justify-end gap-2">
        <button type="button" class={BTN} onClick={onClose} disabled={!!busy}>{locked ? 'Đóng' : 'Hủy'}</button>
        {status === 'published' && (
          <button type="button" class={BTN_DANGER} disabled={!!busy} onClick={() => setConfirm('remote')}>Xóa bài khỏi Facebook</button>
        )}
        {!isNew && status === 'scheduled' && (
          <button type="button" class={BTN} disabled={!!busy} onClick={() => void act('unschedule', 'Đã bỏ lịch, bài về trạng thái Đã duyệt')}>Bỏ lịch</button>
        )}
        {!isNew && (status === 'approved' || status === 'scheduled' || status === 'failed' || status === 'missed') && (
          <button type="button" class={BTN} disabled={!!busy} onClick={() => setConfirm('publish')}>
            {status === 'failed' || status === 'missed' ? 'Đăng lại ngay' : 'Đăng ngay'}
          </button>
        )}
        {!isNew && status === 'review' && (
          <button type="button" class={BTN} disabled={!!busy} onClick={() => setReturning((v) => !v)} aria-expanded={returning}>Trả lại</button>
        )}
        {!isNew && status === 'idea' && (
          <button type="button" class={BTN} disabled={!!busy} onClick={() => void setStatus('draft', 'Đã chuyển sang Bản nháp')}>Chuyển sang bản nháp</button>
        )}
        {!isNew && status === 'draft' && (
          <button type="button" class={BTN} disabled={!!busy} onClick={() => void setStatus('review', 'Đã gửi chờ duyệt')}>Gửi chờ duyệt</button>
        )}
        {!locked && (
          <button type="button" class={BTN} onClick={() => void save()} disabled={!canSave}>
            {busy === 'save' ? 'Đang lưu…' : isNew ? 'Thêm vào Kho' : 'Lưu'}
          </button>
        )}
        {!isNew && (status === 'review' || status === 'draft' || status === 'idea') && (
          <button type="button" class={BTN_PRIMARY} disabled={!canSave} onClick={() => void approve()}>
            {busy === 'approve' ? 'Đang duyệt…' : whenSec ? 'Duyệt và xếp lịch' : 'Duyệt'}
          </button>
        )}
        {!isNew && status === 'approved' && whenSec && whenSec !== content!.scheduledAt && (
          <button type="button" class={BTN_PRIMARY} disabled={!canSave} onClick={() => void approve()}>Xếp lịch</button>
        )}
      </div>
    </div>
  );

  return (
    <>
      <Modal
        open
        onClose={onClose}
        closeDisabled={!!busy}
        title={isNew ? 'Thêm content' : 'Chi tiết content'}
        width={820}
        footer={footer}
      >
        <div class="flex flex-col gap-4">
          {!isNew && (
            <div class="flex flex-wrap items-center gap-3">
              <StatusPill status={status} />
              <FormatChip format={content!.format} />
              <span class="text-[12px] text-[var(--color-text-muted)]">
                Nguồn: <span class="font-mono">{content!.source === 'user' ? 'Bạn' : content!.source}</span>
                {content!.origin === 'imported' && ' · nhập từ Facebook'}
              </span>
              {content!.permalink && (
                <a
                  href={content!.permalink}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="ml-auto inline-flex items-center gap-1 text-[12.5px] text-[var(--color-accent)] underline"
                >
                  Mở bài trên Facebook <ExternalLink size={12} />
                </a>
              )}
            </div>
          )}

          {content?.lastError && (
            <InlineError>
              <div class="font-medium">Lỗi gần nhất{content.attempts > 0 ? ` (lần thử ${content.attempts})` : ''}</div>
              {content.lastError}
            </InlineError>
          )}
          {content?.feedback && status !== 'published' && (
            <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[12.5px]">
              <div class="text-[11.5px] text-[var(--color-text-muted)] mb-0.5">Góp ý đã trả lại cho agent</div>
              {content.feedback}
            </div>
          )}
          {page && !page.enabled && (
            <InlineError>Page “{page.name}” đang tắt, nên chưa đăng được. Bật ở FB · Cài đặt Page.</InlineError>
          )}
          {isNew && enabledPages.length === 0 && (
            <InlineError>Chưa có Page nào được bật. Bật một Page ở FB · Cài đặt Page trước khi thêm content.</InlineError>
          )}

          <div class="grid gap-3 grid-cols-1 sm:grid-cols-2">
            <Field label="Tiêu đề" class="sm:col-span-2">
              <input class={INPUT} value={title} disabled={locked} maxLength={200} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="Page">
              <select class={INPUT} value={pageId} disabled={locked} onChange={(e) => setPageId((e.target as HTMLSelectElement).value)}>
                {isNew && <option value="">Chọn Page…</option>}
                {pageChoices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Format">
              <select class={INPUT} value={format} disabled={locked} onChange={(e) => setFormat((e.target as HTMLSelectElement).value as FbFormat)}>
                {(Object.keys(FORMAT_META) as FbFormat[]).map((f) => <option key={f} value={f}>{FORMAT_META[f].label}</option>)}
              </select>
            </Field>
            <Field label="Caption" class="sm:col-span-2">
              <textarea class={TEXTAREA} rows={7} value={caption} disabled={locked} onInput={(e) => setCaption((e.target as HTMLTextAreaElement).value)} />
            </Field>
            {needsLink && (
              <Field label="Link" class="sm:col-span-2">
                <input type="url" class={INPUT} value={linkUrl} disabled={locked} placeholder="https://" onInput={(e) => setLinkUrl((e.target as HTMLInputElement).value)} />
              </Field>
            )}
            <Field label="Tuyến content">
              <input class={INPUT} list="fb-pillars" value={pillar} disabled={locked} onInput={(e) => setPillar((e.target as HTMLInputElement).value)} />
              <datalist id="fb-pillars">
                {(page?.pillars ?? []).map((p) => <option key={p.name} value={p.name} />)}
              </datalist>
            </Field>
            <Field label="Kiểu hook">
              <input class={INPUT} value={hookType} disabled={locked} placeholder="con số, câu hỏi, kể chuyện…" onInput={(e) => setHookType((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="CTA">
              <input class={INPUT} value={cta} disabled={locked} placeholder="bấm link, comment, nhắn tin…" onInput={(e) => setCta((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="Chiến dịch">
              <input class={INPUT} value={campaign} disabled={locked} onInput={(e) => setCampaign((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="Các hook đề xuất (mỗi dòng một hook)" class="sm:col-span-2">
              <textarea class={TEXTAREA} rows={3} value={hooks} disabled={locked} onInput={(e) => setHooks((e.target as HTMLTextAreaElement).value)} />
            </Field>
            <Field
              label="Giờ đăng"
              hint={page ? `Theo giờ trên máy bạn. Luật của Page: tối đa ${page.maxPostsPerDay} bài/ngày, cách nhau ≥ ${Math.round(page.minGapMinutes / 60 * 10) / 10} giờ, trong khung ${page.windowStart}–${page.windowEnd}.` : undefined}
            >
              <input type="datetime-local" class={INPUT} value={when} disabled={locked} onInput={(e) => setWhen((e.target as HTMLInputElement).value)} />
            </Field>
            <div class="text-[12px] text-[var(--color-text-muted)] flex flex-col gap-1">
              Media
              {content && content.media.length > 0 ? (
                <ul class="m-0 pl-4 list-disc text-[12px] text-[var(--color-text)]">
                  {content.media.map((m) => (
                    <li key={m.path} class="break-all">
                      {m.kind === 'video' ? 'Video' : 'Ảnh'} · {m.path.split('/').pop()}
                      {m.durationS ? ` · ${Math.round(m.durationS)} giây` : ''}
                    </li>
                  ))}
                </ul>
              ) : (
                <span class="text-[var(--color-text-faint)]">
                  {format === 'text' || format === 'link' ? 'Không cần media.' : 'Chưa có media. Nhờ agent thêm file bằng content-cli.'}
                </span>
              )}
            </div>
          </div>

          {content?.scheduledAt && status !== 'published' && (
            <div class="text-[12px] text-[var(--color-text-muted)]">Lịch hiện tại: {fmtDayLong(content.scheduledAt)}</div>
          )}
          {content?.publishedAt && (
            <div class="text-[12px] text-[var(--color-text-muted)]">
              Đăng lúc {fmtDayLong(content.publishedAt)}{content.publishedAs && content.publishedAs !== content.format ? ` (đăng dạng ${content.publishedAs})` : ''}
            </div>
          )}

          {returning && (
            <div class="rounded-lg border border-[var(--color-border-strong)] p-3 flex flex-col gap-2">
              <Field label="Góp ý cho agent (bài sẽ về Bản nháp)">
                <textarea class={TEXTAREA} rows={3} value={feedback} onInput={(e) => setFeedback((e.target as HTMLTextAreaElement).value)} />
              </Field>
              <div class="flex justify-end gap-2">
                <button type="button" class={BTN} onClick={() => setReturning(false)}>Hủy</button>
                <button
                  type="button"
                  class={BTN_PRIMARY}
                  disabled={!feedback.trim() || !!busy}
                  onClick={() => void act('return', 'Đã trả lại cho agent', { feedback: feedback.trim() }, true)}
                >
                  Trả lại
                </button>
              </div>
            </div>
          )}

          {error && <InlineError>{error}</InlineError>}

          {content?.log && content.log.length > 0 && (
            <details class="text-[12px]">
              <summary class="cursor-pointer text-[var(--color-text-muted)]">Nhật ký đăng ({content.log.length})</summary>
              <ul class="m-0 mt-2 pl-0 list-none flex flex-col gap-1">
                {content.log.map((l) => (
                  <li key={l.id} class="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11.5px]">
                    <span class="text-[var(--color-text-faint)]">{new Date(l.createdAt * 1000).toLocaleString('vi-VN')}</span>
                    <span class={l.ok ? 'text-[var(--color-status-done)]' : 'text-[var(--color-status-failed)]'}>{l.ok ? 'OK' : 'LỖI'}</span>
                    <span>{l.action}</span>
                    {l.detail && <span class="text-[var(--color-text-muted)] break-all">{l.detail}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </Modal>

      <ConfirmModal
        open={confirm === 'publish'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void act('publish-now', 'Đang đăng lên Facebook…')}
        title="Đăng ngay lên Facebook?"
        body={`Bài “${content?.title ?? ''}” sẽ được đăng lên ${content?.pageName ?? 'Page'} ngay bây giờ, không chờ lịch.`}
        detail="Bài đã đăng chỉ gỡ được bằng cách xóa trên Facebook."
        confirmLabel="Đăng ngay"
        cancelLabel="Hủy"
      />
      <ConfirmModal
        open={confirm === 'remote'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void act('delete-remote', 'Đã xóa bài khỏi Facebook')}
        title="Xóa bài khỏi Facebook?"
        body="Bài sẽ bị xóa khỏi Page trên Facebook. Không hoàn tác được."
        detail="Số liệu đã thu vẫn giữ trong dashboard."
        confirmLabel="Xóa khỏi Facebook"
        cancelLabel="Hủy"
        destructive
      />
      <ConfirmModal
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        onConfirm={() => void run('delete', () => apiDelete(`/api/m/marketing/content/${content!.id}`), 'Đã xóa khỏi Kho', true)}
        title="Xóa content khỏi Kho?"
        body={`“${content?.title ?? ''}” sẽ bị xóa khỏi Kho.`}
        detail={status === 'published' ? 'Bài đã đăng vẫn còn trên Facebook; dùng “Xóa bài khỏi Facebook” nếu muốn gỡ.' : undefined}
        confirmLabel="Xóa"
        cancelLabel="Hủy"
        destructive
      />
    </>
  );
}
