// Recreate templates: upload helpers, cards, editor and the Studio picker.

import { useMemo, useState } from 'preact/hooks';
import { GalleryHorizontalEnd, Images, Trash2, Upload } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { ConfirmModal } from '@/components/ConfirmModal';
import { PageState } from '@/components/PageState';
import { BTN, BTN_DANGER, BTN_PRIMARY, Field, INPUT, InlineError, TEXTAREA, apiFail } from '@modules/kol/web/components/shared/ops-shared';
import { ChipsField } from '@modules/kol/web/components/PersonaFields';
import { DropZone, KolImg, UploadButton, toastError } from '@modules/kol/web/components/ui';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import {
  KOL, fileBaseName, fmtDate, kolApi, newId, templateGroups,
  type TemplateDto, type TemplateGroup,
} from '@modules/kol/web/lib/kol';

export const TEMPLATE_NOTICE = 'Mẫu chỉ dùng để lấy bố cục, dáng, ánh sáng. Không sao chép khuôn mặt hay danh tính người trong ảnh.';

/**
 * Upload files as templates. 'single': one template per file. 'carousel': one
 * set (shared setId, positions in the chosen order). Returns what was saved.
 */
export async function uploadTemplates(files: File[], mode: 'single' | 'carousel'): Promise<TemplateDto[]> {
  const saved: TemplateDto[] = [];
  const setId = mode === 'carousel' ? newId('set') : undefined;
  const setName = fileBaseName(files[0]?.name ?? 'Carousel');
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    try {
      const { template } = await kolApi.uploadTemplate(f, mode === 'carousel'
        ? { kind: 'carousel', setId, position: i, name: `${setName} · ${i + 1}` }
        : { kind: 'single', name: fileBaseName(f.name) });
      saved.push(template);
    } catch (err) {
      toastError(`Không tải được “${f.name}”`, err);
    }
  }
  if (saved.length) {
    invalidateFetchCache(KOL.templates);
    pushToast({ tone: 'success', title: mode === 'carousel' ? `Đã thêm bộ carousel ${saved.length} ảnh` : `Đã thêm ${saved.length} mẫu` });
  }
  return saved;
}

export function TemplateCard({ group, selected, onClick }: { group: TemplateGroup; selected?: boolean; onClick: () => void }) {
  const t = group.cover;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      class={`w-full flex flex-col text-left rounded-lg border overflow-hidden bg-[var(--color-card)] min-w-0 transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-accent)] ${
        selected ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]' : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
      }`}
    >
      <span class="relative block aspect-[4/5] w-full overflow-hidden bg-[var(--color-elevated)]">
        <KolImg src={t.url} alt={t.name} class="w-full h-full" />
        {group.kind === 'carousel' && (
          <span class="absolute top-1.5 right-1.5 inline-flex items-center gap-1 rounded bg-black/60 text-white text-[10.5px] px-1.5 py-0.5">
            <GalleryHorizontalEnd size={11} aria-hidden="true" />{group.items.length}
          </span>
        )}
        {t.source === 'radar' && <span class="absolute top-1.5 left-1.5 rounded bg-black/60 text-white text-[10.5px] px-1.5 py-0.5">Radar</span>}
      </span>
      <span class="px-2 py-1.5 min-w-0">
        <span class="block text-[12.5px] font-medium text-[var(--color-text)] truncate">{group.kind === 'carousel' ? t.name.replace(/ · 1$/, '') : t.name}</span>
        <span class="block text-[11px] text-[var(--color-text-muted)] truncate">{group.kind === 'carousel' ? `Carousel · ${group.items.length} ảnh` : 'Ảnh đơn'} · {fmtDate(group.createdAt)}</span>
      </span>
    </button>
  );
}

/** Edit name/notes/tags. For a carousel set, the change applies to every image in the set. */
export function TemplateEditor({ group, onClose, onChanged }: { group: TemplateGroup; onClose: () => void; onChanged: () => void }) {
  const first = group.cover;
  const isSet = group.kind === 'carousel';
  const [name, setName] = useState(isSet ? first.name.replace(/ · \d+$/, '') : first.name);
  const [notes, setNotes] = useState(first.notes);
  const [tags, setTags] = useState<string[]>(first.tags);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      for (const t of group.items) {
        await kolApi.updateTemplate(t.id, { name: isSet ? `${name.trim()} · ${t.position + 1}` : name.trim(), notes, tags });
      }
      pushToast({ tone: 'success', title: 'Đã lưu mẫu' });
      invalidateFetchCache(KOL.templates);
      onChanged();
      onClose();
    } catch (err) {
      setError(apiFail(err).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      for (const t of group.items) await kolApi.deleteTemplate(t.id);
      pushToast({ tone: 'success', title: isSet ? 'Đã xoá bộ carousel' : 'Đã xoá mẫu' });
      invalidateFetchCache(KOL.templates);
      onChanged();
      onClose();
    } catch (err) {
      setError(apiFail(err).message);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Modal
        open
        title={isSet ? 'Bộ carousel mẫu' : 'Mẫu tái tạo'}
        width={680}
        onClose={() => { if (!busy) onClose(); }}
        closeDisabled={busy}
        footer={
          <>
            <button type="button" class={BTN_DANGER} disabled={busy} onClick={() => setConfirm(true)}><Trash2 size={13} />{isSet ? 'Xoá cả bộ' : 'Xoá'}</button>
            <div class="ml-auto flex gap-2">
              <button type="button" class={BTN} disabled={busy} onClick={onClose}>Huỷ</button>
              <button type="button" class={BTN_PRIMARY} disabled={busy || !name.trim()} onClick={() => { void save(); }}>{busy ? 'Đang lưu…' : 'Lưu'}</button>
            </div>
          </>
        }
      >
        <div class="flex flex-col gap-3">
          <div class="flex gap-2 overflow-x-auto pb-1">
            {group.items.map((t) => (
              <span key={t.id} class="relative shrink-0 w-28 aspect-[4/5] rounded-md overflow-hidden border border-[var(--color-border)]">
                <KolImg src={t.url} alt={t.name} class="w-full h-full" />
                {isSet && <span class="absolute bottom-1 left-1 rounded bg-black/60 text-white text-[10.5px] px-1">{t.position + 1}</span>}
              </span>
            ))}
          </div>
          <Field label="Tên">
            <input class={`${INPUT} w-full`} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Ghi chú" hint="Muốn giữ gì từ mẫu: dáng ngồi, góc máy, ánh sáng hoàng hôn…">
            <textarea class={`${TEXTAREA} w-full`} rows={3} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
          </Field>
          <ChipsField label="Thẻ" value={tags} onChange={setTags} placeholder="Enter để thêm" />
          {first.sourceUrl && (
            <a href={first.sourceUrl} target="_blank" rel="noopener noreferrer" class="text-[12px] text-[var(--color-accent)] underline break-all">Nguồn: {first.sourceUrl}</a>
          )}
          <p class="text-[12px] text-[var(--color-text-muted)]">{TEMPLATE_NOTICE}</p>
          {error && <InlineError>{error}</InlineError>}
        </div>
      </Modal>
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => { void remove(); }}
        title={isSet ? 'Xoá cả bộ carousel?' : 'Xoá mẫu này?'}
        body="Ảnh đã tạo từ mẫu vẫn được giữ."
        confirmLabel="Xoá"
        cancelLabel="Huỷ"
        destructive
      />
    </>
  );
}

/** Studio picker: choose one template image, or upload your own photo (saved as a template). */
export function TemplatePickerModal({ selectedId, onPick, onClose }: {
  selectedId?: string; onPick: (t: TemplateDto) => void; onClose: () => void;
}) {
  const list = useFetch<{ templates: TemplateDto[] }>(KOL.templates);
  const [busy, setBusy] = useState(false);
  const [openSet, setOpenSet] = useState<string | null>(null);
  const groups = useMemo(() => templateGroups(list.data?.templates ?? []), [list.data]);
  const set = groups.find((g) => g.key === openSet);

  async function upload(files: File[]) {
    setBusy(true);
    const saved = await uploadTemplates(files.slice(0, 1), 'single');
    setBusy(false);
    list.refresh();
    if (saved[0]) { onPick(saved[0]); onClose(); }
  }

  return (
    <Modal open title="Chọn ảnh để tái tạo" width={860} onClose={onClose} bodyClassName="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-3">
      <p class="text-[12px] text-[var(--color-text-muted)]">{TEMPLATE_NOTICE}</p>
      <DropZone disabled={busy} onFiles={(f) => { void upload(f); }}>
        <span>{busy ? 'Đang tải ảnh…' : 'Kéo thả ảnh của bạn vào đây hoặc bấm để chọn (được lưu vào Mẫu tái tạo)'}</span>
      </DropZone>
      {!list.data && <PageState loading={list.loading} error={list.error} />}
      {list.data && groups.length === 0 && <p class="text-[12.5px] text-[var(--color-text-muted)]">Chưa có mẫu nào. Tải một ảnh ở trên để bắt đầu.</p>}
      {set ? (
        <div class="flex flex-col gap-2">
          <button type="button" class={`${BTN} self-start`} onClick={() => setOpenSet(null)}>← Tất cả mẫu</button>
          <p class="text-[12px] text-[var(--color-text-muted)]">Chọn một ảnh trong bộ carousel.</p>
          <ul class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5 list-none m-0 p-0">
            {set.items.map((t) => (
              <li key={t.id}>
                <TemplateCard group={{ ...set, kind: 'single', items: [t], cover: t }} selected={t.id === selectedId} onClick={() => { onPick(t); onClose(); }} />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ul class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5 list-none m-0 p-0">
          {groups.map((g) => (
            <li key={g.key}>
              <TemplateCard
                group={g}
                selected={g.items.some((t) => t.id === selectedId)}
                onClick={() => { if (g.kind === 'carousel') setOpenSet(g.key); else { onPick(g.cover); onClose(); } }}
              />
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/** Upload buttons for the templates screen. */
export function TemplateUploadButtons({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  async function run(files: File[], mode: 'single' | 'carousel') {
    if (mode === 'carousel' && (files.length < 2 || files.length > 10)) {
      pushToast({ tone: 'warn', title: 'Carousel cần 2–10 ảnh', description: 'Chọn nhiều ảnh cùng lúc theo đúng thứ tự.' });
      return;
    }
    setBusy(true);
    await uploadTemplates(files, mode);
    setBusy(false);
    onDone();
  }
  return (
    <div class="flex flex-wrap gap-2">
      <UploadButton class={BTN_PRIMARY} multiple disabled={busy} onFiles={(f) => { void run(f, 'single'); }}><Upload size={14} />{busy ? 'Đang tải…' : 'Tải mẫu đơn'}</UploadButton>
      <UploadButton class={BTN} multiple disabled={busy} onFiles={(f) => { void run([...f].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), 'carousel'); }}><Images size={14} />Tải bộ carousel</UploadButton>
    </div>
  );
}
