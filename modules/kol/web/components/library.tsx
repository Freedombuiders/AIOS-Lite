// Library building blocks: tiles, group chips and the item editor. Used by
// KOL Studio › Thư viện and by the Studio slot pickers.

import { useMemo, useState } from 'preact/hooks';
import { type LucideIcon, Camera, Check, Clapperboard, Copy, ImagePlus, MountainSnow, PersonStanding, Scissors, Shirt, Smile, Trash2, Upload, WandSparkles } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { ConfirmModal } from '@/components/ConfirmModal';
import { BTN, BTN_DANGER, BTN_PRIMARY, Field, FilterChip, INPUT, InlineError, TEXTAREA, apiFail } from '@modules/kol/web/components/shared/ops-shared';
import { CameraDiagram } from '@modules/kol/web/components/camera-art';
import { ChipsField } from '@modules/kol/web/components/PersonaFields';
import { FilePreview, KolImg, UploadButton } from '@modules/kol/web/components/ui';
import { invalidateFetchCache } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import {
  LIBRARY_GENDER_LABEL, LIBRARY_KINDS, LIBRARY_KIND_LABEL, groupCounts, kolApi,
  type LibraryGender, type LibraryItemDto, type LibraryKind,
} from '@modules/kol/web/lib/kol';
import { CAMERA_INFO } from '@modules/kol/web/lib/kol-camera';

export const LIBRARY_ICON: Record<LibraryKind, LucideIcon> = {
  outfit: Shirt,
  expression: Smile,
  hair: Scissors,
  scene: MountainSnow,
  pose: PersonStanding,
  look: Clapperboard,
  effect: WandSparkles,
  camera: Camera,
};

const MODEL_KEY = 'kol.previewModel';

/** The model the owner last chose for catalog photos (per browser), if any. */
export function rememberedPreviewModel(): string {
  try { return localStorage.getItem(MODEL_KEY) ?? ''; } catch { return ''; }
}
export function rememberPreviewModel(id: string): void {
  try { localStorage.setItem(MODEL_KEY, id); } catch { /* private mode */ }
}

/** Kinds with a catalog photo (camera setups are drawn as diagrams). */
const PREVIEW_KINDS: LibraryKind[] = ['outfit', 'scene', 'expression', 'pose', 'hair', 'look', 'effect'];

/** Faint per-kind tint behind items that have no picture yet, so a grid still reads as one catalog. */
const KIND_TINT: Record<LibraryKind, string> = {
  outfit: 'var(--color-accent)',
  expression: 'var(--color-priority-medium)',
  hair: 'var(--color-status-done)',
  scene: 'var(--color-status-running)',
  pose: 'var(--color-priority-low)',
  look: 'var(--color-priority-high)',
  effect: 'var(--color-accent)',
  camera: 'var(--color-text-muted)',
};

type ArtItem = Pick<LibraryItemDto, 'kind' | 'name' | 'imageUrl'> & { id?: string; previewUrl?: string | null; previewIsPersona?: boolean };

/** The picture of an item: the KOL itself wearing / doing it, else its reference image, else its catalog photo. */
export function artSrc(item: ArtItem): string | null {
  if (item.previewIsPersona && item.previewUrl) return item.previewUrl;
  return item.imageUrl ?? item.previewUrl ?? null;
}

/**
 * Image tile, the diagram of a builtin camera setup, or a tinted placeholder with the kind's icon.
 * `label` prints the name on the placeholder (tiles that show the name elsewhere leave it off).
 */
export function LibraryArt({ item, class: cls = '', label = false }: { item: ArtItem; class?: string; label?: boolean }) {
  const src = artSrc(item);
  if (src) return <KolImg src={src} alt="" class={`w-full h-full ${cls}`} />;
  const camera = item.kind === 'camera' && item.id ? CAMERA_INFO[item.id] : undefined;
  if (camera) return <span class={`block w-full h-full bg-[var(--color-elevated)] ${cls}`}><CameraDiagram spec={camera.art} /></span>;
  const Icon = LIBRARY_ICON[item.kind];
  const tint = KIND_TINT[item.kind];
  return (
    <span
      class={`w-full h-full flex flex-col items-center justify-center gap-2 px-2 text-center ${cls}`}
      style={{ background: `radial-gradient(120% 90% at 30% 15%, color-mix(in srgb, ${tint} 22%, var(--color-card)), var(--color-elevated) 70%)` }}
    >
      <Icon size={label ? 22 : 18} class="opacity-60" style={{ color: tint }} aria-hidden="true" />
      {label && <span class="text-[12px] font-medium leading-tight text-[var(--color-text-muted)] line-clamp-3 break-words">{item.name}</span>}
    </span>
  );
}

/**
 * Catalog tile: the picture fills a 4:5 frame, the name sits once on a soft gradient at the bottom,
 * a check marks the pick. Items of one KOL carry a small "Riêng" tag.
 */
export function LibraryTile({ item, selected, onClick, showGroup = true, badge }: {
  item: LibraryItemDto; selected?: boolean; onClick: () => void; showGroup?: boolean;
  /** Small tag at the top left (e.g. "Nữ" on a woman's item shown to a male KOL). */
  badge?: string;
}) {
  const hasArt = !!artSrc(item) || (item.kind === 'camera' && !!CAMERA_INFO[item.id]);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      title={item.prompt}
      class={`group relative block w-full aspect-[4/5] rounded-xl overflow-hidden border bg-[var(--color-elevated)] text-left transition-[border-color,box-shadow] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] ${
        selected ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent)] shadow-lg' : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)] hover:shadow-md'
      }`}
    >
      <LibraryArt item={item} class="transition-transform duration-500 ease-out group-hover:scale-[1.04]" />
      {hasArt && <span class="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/80 via-black/35 to-transparent" aria-hidden="true" />}
      <span class="absolute inset-x-0 bottom-0 px-2.5 pb-2 pt-6 min-w-0">
        <span class={`block text-[12.5px] font-semibold leading-snug line-clamp-2 break-words ${hasArt ? 'text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.5)]' : 'text-[var(--color-text)]'}`}>{item.name}</span>
        {showGroup && <span class={`block mt-0.5 text-[10.5px] truncate ${hasArt ? 'text-white/70' : 'text-[var(--color-text-muted)]'}`}>{item.group || 'Khác'}</span>}
      </span>
      {(item.personaId || badge) && (
        <span class="absolute top-2 left-2 flex gap-1">
          {item.personaId && <span class="rounded-full bg-black/55 backdrop-blur-sm text-white text-[10px] font-medium px-2 py-0.5">Riêng</span>}
          {badge && <span class="rounded-full bg-black/55 backdrop-blur-sm text-white text-[10px] font-medium px-2 py-0.5">{badge}</span>}
        </span>
      )}
      {selected && (
        <span class="absolute top-2 right-2 w-6 h-6 rounded-full bg-[var(--color-accent)] text-[var(--color-on-accent)] flex items-center justify-center shadow" aria-hidden="true">
          <Check size={14} strokeWidth={3} />
        </span>
      )}
    </button>
  );
}

/** "Tất cả" + one chip per group with its count. */
export function GroupChips({ items, value, onChange }: { items: LibraryItemDto[]; value: string; onChange: (g: string) => void }) {
  const groups = useMemo(() => groupCounts(items), [items]);
  if (groups.length < 2) return null;
  return (
    <div role="group" aria-label="Nhóm" class="flex flex-wrap gap-1.5">
      <FilterChip on={value === ''} label="Tất cả" count={items.length} onClick={() => onChange('')} />
      {groups.map((g) => <FilterChip key={g.group} on={value === g.group} label={g.group} count={g.count} onClick={() => onChange(value === g.group ? '' : g.group)} />)}
    </div>
  );
}

export interface LibraryEditorTarget {
  /** Existing item, or null for a new one. */
  item: LibraryItemDto | null;
  kind: LibraryKind;
  /** Pre-filled values for a new item (e.g. "copy of a builtin"). */
  seed?: Partial<Pick<LibraryItemDto, 'group' | 'name' | 'prompt' | 'tags' | 'personaId'>>;
}

/**
 * Add / edit a library item. Builtin items are read-only: the owner makes a
 * copy to change them. `personas` lets the owner keep an item for one KOL.
 */
export function LibraryItemEditor({ target, groups, personas, onClose, onSaved, onCopy }: {
  target: LibraryEditorTarget;
  groups: string[];
  personas?: { id: string; name: string }[];
  onClose: () => void;
  /** Saved item, or null after a delete. */
  onSaved: (item: LibraryItemDto | null) => void;
  /** Builtin items: open a new editor pre-filled with this item. */
  onCopy: (target: LibraryEditorTarget) => void;
}) {
  const it = target.item;
  const readOnly = !!it?.builtin;
  const [kind, setKind] = useState<LibraryKind>(it?.kind ?? target.kind);
  const [group, setGroup] = useState(it?.group ?? target.seed?.group ?? '');
  const [name, setName] = useState(it?.name ?? target.seed?.name ?? '');
  const [prompt, setPrompt] = useState(it?.prompt ?? target.seed?.prompt ?? '');
  const [tags, setTags] = useState<string[]>(it?.tags ?? target.seed?.tags ?? []);
  const [personaId, setPersonaId] = useState<string>(it?.personaId ?? target.seed?.personaId ?? '');
  const [gender, setGender] = useState<LibraryGender>(it?.gender ?? 'all');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [redrawing, setRedrawing] = useState(false);

  /** Redraws this item's catalog photo with the owner's last preview model (ChatGPT by default). */
  async function redraw() {
    if (!it) return;
    setRedrawing(true);
    try {
      await kolApi.startPreviews({ model: rememberedPreviewModel() || 'chatgpt-image', ids: [it.id], force: true });
      invalidateFetchCache('/api/m/kol/library');
      pushToast({ tone: 'success', title: `Đang vẽ ảnh minh hoạ cho “${it.name}”`, description: 'Ảnh mới hiện ở thư viện khi xong (khoảng 2 phút với ChatGPT).' });
    } catch (err) {
      setError(apiFail(err).message);
    } finally {
      setRedrawing(false);
    }
  }

  async function save() {
    if (!name.trim() || !prompt.trim()) { setError('Cần tên và prompt tiếng Anh.'); return; }
    setBusy(true);
    setError(null);
    try {
      const body = { kind, group: group.trim(), name: name.trim(), prompt: prompt.trim(), tags, personaId: personaId || null, ...(it?.builtin ? {} : { gender: personaId ? 'all' as const : gender }) };
      let saved = it
        ? (await kolApi.updateLibraryItem(it.id, body)).item
        : (await kolApi.createLibraryItem(body)).item;
      if (file) saved = (await kolApi.uploadLibraryImage(saved.id, file)).item;
      pushToast({ tone: 'success', title: it ? 'Đã lưu mục thư viện' : `Đã thêm “${saved.name}”` });
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(apiFail(err).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!it) return;
    setBusy(true);
    try {
      await kolApi.deleteLibraryItem(it.id);
      pushToast({ tone: 'success', title: `Đã xoá “${it.name}”` });
      onSaved(null);
      onClose();
    } catch (err) {
      setError(apiFail(err).message);
    } finally {
      setBusy(false);
    }
  }

  const title = readOnly ? `${LIBRARY_KIND_LABEL[kind]} có sẵn` : it ? `Sửa ${LIBRARY_KIND_LABEL[kind].toLowerCase()}` : `Thêm ${LIBRARY_KIND_LABEL[kind].toLowerCase()}`;

  return (
    <>
      <Modal
        open
        title={title}
        width={620}
        onClose={() => { if (!busy) onClose(); }}
        closeDisabled={busy}
        footer={readOnly ? (
          <>
            <span class="text-[12px] text-[var(--color-text-muted)]">Mục có sẵn không sửa hay xoá được.</span>
            <button
              type="button"
              class={`${BTN_PRIMARY} ml-auto`}
              onClick={() => onCopy({ item: null, kind, seed: { group, name: `${name} (bản sao)`, prompt, tags, personaId: null } })}
            ><Copy size={13} />Tạo bản sao để sửa</button>
          </>
        ) : (
          <>
            {it && <button type="button" class={BTN_DANGER} disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={13} />Xoá</button>}
            <div class="ml-auto flex gap-2">
              <button type="button" class={BTN} disabled={busy} onClick={onClose}>Huỷ</button>
              <button type="button" class={BTN_PRIMARY} disabled={busy} onClick={() => { void save(); }}>{busy ? 'Đang lưu…' : 'Lưu'}</button>
            </div>
          </>
        )}
      >
        <div class="grid grid-cols-1 sm:grid-cols-[150px_1fr] gap-4">
          <div class="flex flex-col gap-2">
            <span class="block w-full aspect-[4/5] rounded-lg overflow-hidden border border-[var(--color-border)]">
              {file ? <FilePreview file={file} class="w-full h-full" /> : <LibraryArt label item={{ id: it?.id, kind, name: name || 'Chưa đặt tên', imageUrl: it?.imageUrl ?? null, previewUrl: it?.previewUrl ?? null, previewIsPersona: it?.previewIsPersona }} />}
            </span>
            {!readOnly && (
              <UploadButton class={BTN} onFiles={(f) => setFile(f[0] ?? null)}><Upload size={13} />{it?.imageUrl || file ? 'Đổi ảnh' : 'Thêm ảnh'}</UploadButton>
            )}
            {it && !it.imageUrl && !file && PREVIEW_KINDS.includes(it.kind) && (
              <button type="button" class={BTN} disabled={redrawing} onClick={() => { void redraw(); }} title="Ảnh minh hoạ chỉ để xem, không gửi cho mô hình">
                <ImagePlus size={13} />{redrawing ? 'Đang gửi…' : it.previewUrl ? 'Vẽ lại ảnh minh hoạ' : 'Vẽ ảnh minh hoạ'}
              </button>
            )}
            <span class="text-[11.5px] text-[var(--color-text-faint)]">
              {it?.imageUrl || file
                ? 'Ảnh tham chiếu: được gửi kèm cho mô hình để bám đúng chi tiết.'
                : it?.previewUrl
                  ? 'Đang hiện ảnh minh hoạ (chỉ để xem, không gửi cho mô hình). Thêm ảnh thật của bạn để mô hình bám đúng chi tiết.'
                  : 'Ảnh tuỳ chọn (ví dụ ảnh bộ đồ). Có ảnh thì mô hình bám chi tiết tốt hơn.'}
            </span>
          </div>
          <div class="flex flex-col gap-3 min-w-0">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Loại">
                <select class={`${INPUT} w-full`} value={kind} disabled={readOnly || !!it} onChange={(e) => setKind((e.target as HTMLSelectElement).value as LibraryKind)}>
                  {LIBRARY_KINDS.map((k) => <option key={k} value={k}>{LIBRARY_KIND_LABEL[k]}</option>)}
                </select>
              </Field>
              <Field label="Nhóm">
                <input class={`${INPUT} w-full`} list="kol-library-groups" disabled={readOnly} placeholder="Ví dụ: Đi biển" value={group} onInput={(e) => setGroup((e.target as HTMLInputElement).value)} />
                <datalist id="kol-library-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
              </Field>
            </div>
            <Field label="Tên hiển thị">
              <input class={`${INPUT} w-full`} disabled={readOnly} placeholder="Váy lụa trắng hai dây" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="Prompt (tiếng Anh)" hint="Đoạn mô tả được chèn vào prompt khi chọn mục này.">
              <textarea class={`${TEXTAREA} w-full font-mono text-[12.5px]`} rows={4} disabled={readOnly} placeholder="white silk slip dress with thin straps, midi length, delicate gold necklace" value={prompt} onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)} />
            </Field>
            {!readOnly && <ChipsField label="Thẻ" placeholder="Enter để thêm" value={tags} onChange={setTags} />}
            {readOnly && gender !== 'all' && <p class="text-[12px] text-[var(--color-text-muted)]">Dành cho: {LIBRARY_GENDER_LABEL[gender]}</p>}
            {!readOnly && !personaId && (
              <Field label="Dành cho" hint="Studio chỉ hiện mục hợp với giới tính của KOL (vẫn xem được cả hai khi cần).">
                <select class={`${INPUT} w-full`} value={gender} onChange={(e) => setGender((e.target as HTMLSelectElement).value as LibraryGender)}>
                  {(['all', 'female', 'male'] as LibraryGender[]).map((g) => <option key={g} value={g}>{LIBRARY_GENDER_LABEL[g]}</option>)}
                </select>
              </Field>
            )}
            {!readOnly && personas && personas.length > 0 && (
              <Field label="Dùng cho">
                <select class={`${INPUT} w-full`} value={personaId} onChange={(e) => setPersonaId((e.target as HTMLSelectElement).value)}>
                  <option value="">Mọi KOL</option>
                  {personas.map((p) => <option key={p.id} value={p.id}>Chỉ {p.name}</option>)}
                </select>
              </Field>
            )}
            {error && <InlineError>{error}</InlineError>}
          </div>
        </div>
      </Modal>
      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => { void remove(); }}
        title="Xoá mục thư viện?"
        body={`“${it?.name ?? ''}” sẽ bị xoá khỏi thư viện. Ảnh đã tạo trước đó không bị ảnh hưởng.`}
        confirmLabel="Xoá"
        cancelLabel="Huỷ"
        destructive
      />
    </>
  );
}
