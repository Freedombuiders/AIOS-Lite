// Add / edit one quick-reply template (step 3 of the pipeline).

import { useState } from 'preact/hooks';
import { Modal } from '@/components/Modal';
import { apiFail, BTN, BTN_DANGER, BTN_PRIMARY, Field, INPUT, InlineError, TEXTAREA } from '@modules/marketing/web/components/fb/ops-shared';
import { KeywordChips } from '@modules/marketing/web/components/fb/comments/KeywordChips';
import { apiDelete, apiPatch, apiPost } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import type { ReplyTemplateDto, ReplyTemplateInput } from '@modules/marketing/web/lib/fbstudio';

export function TemplateEditor({ template, pageId, postId, onClose, onChanged }: {
  /** null = create a new template. */
  template: ReplyTemplateDto | null;
  pageId: string;
  /** Set when the screen is in per-post scope: new templates apply to that post only. */
  postId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState(template?.name ?? '');
  const [keywords, setKeywords] = useState<string[]>(template?.keywords ?? []);
  const [matchMode, setMatchMode] = useState<'exact' | 'contains'>(template?.matchMode ?? 'contains');
  const [variants, setVariants] = useState((template?.variants ?? ['']).join('\n'));
  const [privateText, setPrivateText] = useState(template?.privateText ?? '');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');

  const variantList = variants.split('\n').map((v) => v.trim()).filter(Boolean);
  const valid = name.trim().length > 0 && keywords.length > 0 && variantList.length > 0;

  async function save() {
    setBusy(true);
    setError('');
    const body: ReplyTemplateInput = {
      pageId,
      postId: template ? template.postId : postId,
      name: name.trim(),
      keywords,
      matchMode,
      variants: variantList,
      privateText: privateText.trim(),
    };
    try {
      if (template) await apiPatch(`/api/m/marketing/comments/templates/${template.id}`, body);
      else await apiPost('/api/m/marketing/comments/templates', { ...body, enabled: true });
      pushToast({ tone: 'success', title: template ? 'Đã lưu mẫu' : 'Đã thêm mẫu' });
      onChanged();
      onClose();
    } catch (err) {
      setError(apiFail(err).message);
      setBusy(false);
    }
  }

  async function remove() {
    if (!template) return;
    setBusy(true);
    try {
      await apiDelete(`/api/m/marketing/comments/templates/${template.id}`);
      pushToast({ tone: 'success', title: 'Đã xóa mẫu' });
      onChanged();
      onClose();
    } catch (err) {
      setError(apiFail(err).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      closeDisabled={busy}
      title={template ? 'Sửa mẫu trả lời nhanh' : 'Thêm mẫu trả lời nhanh'}
      width={640}
      footer={
        <div class="flex flex-wrap items-center gap-2 w-full">
          {template && (
            confirmDelete ? (
              <>
                <span class="text-[12.5px]">Xóa mẫu này?</span>
                <button type="button" class={BTN_DANGER} disabled={busy} onClick={() => void remove()}>Xóa</button>
                <button type="button" class={BTN} disabled={busy} onClick={() => setConfirmDelete(false)}>Không</button>
              </>
            ) : (
              <button type="button" class={BTN_DANGER} disabled={busy} onClick={() => setConfirmDelete(true)}>Xóa mẫu</button>
            )
          )}
          <div class="ml-auto flex gap-2">
            <button type="button" class={BTN} onClick={onClose} disabled={busy}>Hủy</button>
            <button type="button" class={BTN_PRIMARY} onClick={() => void save()} disabled={!valid || busy}>{busy ? 'Đang lưu…' : 'Lưu mẫu'}</button>
          </div>
        </div>
      }
    >
      <div class="flex flex-col gap-4">
        <Field label="Tên mẫu (hiện trong nhật ký và thống kê chủ đề)">
          <input class={INPUT} value={name} maxLength={80} placeholder="Ví dụ: học phí" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </Field>
        <div class="flex flex-col gap-1.5 text-[12px] text-[var(--color-text-muted)]">
          Từ khóa
          <KeywordChips value={keywords} onChange={setKeywords} label="Từ khóa của mẫu" />
        </div>
        <fieldset class="border-0 p-0 m-0 flex flex-col gap-1">
          <legend class="text-[12px] text-[var(--color-text-muted)] pb-1">Cách khớp</legend>
          {([
            ['exact', 'Đúng nguyên văn', 'Cả bình luận chỉ gồm từ khóa, ví dụ “AI” hoặc “ib”.'],
            ['contains', 'Chứa từ', 'Từ khóa xuất hiện như một từ trọn vẹn trong bình luận.'],
          ] as const).map(([v, label, hint]) => (
            <label key={v} class="flex items-start gap-2.5 text-[13px] py-0.5">
              <input type="radio" name="tpl-match" checked={matchMode === v} class="mt-0.5 w-4 h-4 accent-[var(--color-accent)]" onChange={() => setMatchMode(v)} />
              <span>{label} <span class="block text-[11.5px] text-[var(--color-text-faint)]">{hint}</span></span>
            </label>
          ))}
        </fieldset>
        <Field
          label="Trả lời công khai (mỗi dòng một cách viết, xoay vòng)"
          hint="Dùng {ten} cho tên người bình luận. Nhiều cách viết giúp Page không bị lặp."
        >
          <textarea class={TEXTAREA} rows={5} value={variants} onInput={(e) => setVariants((e.target as HTMLTextAreaElement).value)} />
        </Field>
        <Field label="Nhắn riêng (để trống = không nhắn riêng)" hint="Gửi vào inbox của người bình luận. Cần quyền nhắn tin của Page.">
          <textarea class={TEXTAREA} rows={3} value={privateText} onInput={(e) => setPrivateText((e.target as HTMLTextAreaElement).value)} />
        </Field>
        {error && <InlineError>{error}</InlineError>}
      </div>
    </Modal>
  );
}
