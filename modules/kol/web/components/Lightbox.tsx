// Full-screen asset viewer: ←/→ to browse, Esc to close, review actions and metadata.

import { useEffect, useRef, useState } from 'preact/hooks';
import {
  Ban, Check, ChevronLeft, ChevronRight, Download, Film, Heart, Megaphone, ScanFace, Trash2, UserRound, X,
} from 'lucide-preact';
import { ConfirmModal } from '@/components/ConfirmModal';
import { BTN, BTN_DANGER, BTN_SM, INPUT } from '@modules/kol/web/components/shared/ops-shared';
import { ConsistencyBadge, MetaRow, TonePill, toastError } from '@modules/kol/web/components/ui';
import { pushToast } from '@/lib/toasts';
import {
  ASSET_KIND_LABEL, ASSET_STATUS, REF_KINDS, REF_KIND_LABEL, fmtBytes, fmtDateTime, fmtDuration, fmtUsd, kolApi, media,
  type AssetDto, type RefKind, type RefDto,
} from '@modules/kol/web/lib/kol';

interface Props {
  assets: AssetDto[];
  index: number;
  personaId: string;
  onIndex: (i: number) => void;
  onClose: () => void;
  onChanged: (asset: AssetDto) => void;
  onDeleted: (id: string) => void;
  /** New identity ref created from this asset. */
  onRefAdded?: (ref: RefDto) => void;
  onAnimate?: (asset: AssetDto) => void;
  onCreatePost?: (asset: AssetDto) => void;
}

export function Lightbox({ assets, index, personaId, onIndex, onClose, onChanged, onDeleted, onRefAdded, onAnimate, onCreatePost }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const a = assets[index];
  const [busy, setBusy] = useState<string | null>(null);
  const [refKind, setRefKind] = useState<RefKind>('angle');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const stateRef = useRef({ index, count: assets.length, onIndex, onClose });
  stateRef.current = { index, count: assets.length, onIndex, onClose };

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    const prevFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    function onKey(e: KeyboardEvent) {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== ref.current) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { if (e.key !== 'Escape') return; }
      const s = stateRef.current;
      if (e.key === 'Escape') { e.preventDefault(); s.onClose(); }
      else if (e.key === 'ArrowLeft' && s.index > 0) { e.preventDefault(); s.onIndex(s.index - 1); }
      else if (e.key === 'ArrowRight' && s.index < s.count - 1) { e.preventDefault(); s.onIndex(s.index + 1); }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey);
      if (prevFocus?.isConnected) prevFocus.focus();
    };
  }, []);

  if (!a) return null;

  async function run<T>(key: string, fn: () => Promise<T>, ok: (r: T) => void, failTitle: string) {
    setBusy(key);
    try { ok(await fn()); } catch (err) { toastError(failTitle, err); } finally { setBusy(null); }
  }

  const setStatus = (status: AssetDto['status']) => run('status', () => kolApi.updateAsset(a.id, { status }), (r) => {
    onChanged(r.asset);
    pushToast({ tone: 'success', title: status === 'approved' ? 'Đã duyệt' : status === 'rejected' ? 'Đã loại' : 'Đã bỏ duyệt' });
  }, 'Không đổi được trạng thái');

  const toggleFav = () => run('fav', () => kolApi.updateAsset(a.id, { favorite: !a.favorite }), (r) => onChanged(r.asset), 'Không lưu được yêu thích');

  const recheck = () => run('recheck', () => kolApi.recheckAsset(a.id), (r) => {
    onChanged(r.asset);
    pushToast({ tone: 'success', title: 'Đã chấm lại khuôn mặt', description: r.asset.consistency.score !== null ? `Điểm mới: ${Math.round(r.asset.consistency.score)}/100` : undefined });
  }, 'Không chấm lại được');

  const useAsRef = () => run('ref', () => kolApi.refFromAsset(personaId, a.id, refKind), (r) => {
    onRefAdded?.(r.ref);
    pushToast({ tone: 'success', title: `Đã thêm vào bộ nhận diện (${REF_KIND_LABEL[refKind]})` });
  }, 'Không thêm được ảnh tham chiếu');

  const remove = () => run('delete', () => kolApi.deleteAsset(a.id), () => {
    pushToast({ tone: 'success', title: 'Đã xoá' });
    onDeleted(a.id);
  }, 'Không xoá được');

  const st = ASSET_STATUS[a.status];
  const isImage = a.kind === 'image';

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={`${ASSET_KIND_LABEL[a.kind]} ${index + 1}/${assets.length}`}
      tabIndex={-1}
      class="viewport-overlay fixed inset-0 z-[88] bg-black/85 flex flex-col lg:flex-row outline-none"
    >
      <div class="relative flex-1 min-h-0 min-w-0 flex items-center justify-center p-3 lg:p-6">
        {a.kind === 'video' && <video key={a.id} src={media(a.url)} controls playsInline class="max-w-full max-h-full rounded-md" poster={a.thumbUrl ? media(a.thumbUrl) : undefined} />}
        {a.kind === 'audio' && <audio key={a.id} src={media(a.url)} controls class="w-full max-w-[520px]" />}
        {isImage && <img key={a.id} src={media(a.url)} alt={a.prompt ? a.prompt.slice(0, 120) : 'Ảnh đã tạo'} class="max-w-full max-h-full object-contain rounded-md" />}
        <button type="button" aria-label="Đóng" onClick={onClose} class="absolute top-3 right-3 w-10 h-10 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80"><X size={18} /></button>
        {index > 0 && (
          <button type="button" aria-label="Ảnh trước" onClick={() => onIndex(index - 1)} class="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80"><ChevronLeft size={20} /></button>
        )}
        {index < assets.length - 1 && (
          <button type="button" aria-label="Ảnh sau" onClick={() => onIndex(index + 1)} class="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80"><ChevronRight size={20} /></button>
        )}
        <span class="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 text-white text-[12px] px-2.5 py-0.5 tabular-nums">{index + 1} / {assets.length}</span>
      </div>

      <aside class="shrink-0 w-full lg:w-[360px] max-h-[45vh] lg:max-h-none overflow-y-auto bg-[var(--color-card)] border-t lg:border-t-0 lg:border-l border-[var(--color-border)] p-4 flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-1.5">
          <TonePill tone={st.tone}>{st.label}</TonePill>
          <ConsistencyBadge c={a.consistency} />
          {a.favorite && <TonePill tone="accent">Yêu thích</TonePill>}
        </div>
        {a.consistency.notes && <p class="text-[12px] text-[var(--color-text-muted)] leading-relaxed">{a.consistency.notes}</p>}

        <div class="flex flex-wrap gap-1.5">
          <button type="button" class={BTN} aria-pressed={a.status === 'approved'} disabled={!!busy} onClick={() => setStatus(a.status === 'approved' ? 'new' : 'approved')}>
            <Check size={14} />{a.status === 'approved' ? 'Bỏ duyệt' : 'Duyệt'}
          </button>
          <button type="button" class={BTN} aria-pressed={a.status === 'rejected'} disabled={!!busy} onClick={() => setStatus(a.status === 'rejected' ? 'new' : 'rejected')}>
            <Ban size={14} />{a.status === 'rejected' ? 'Bỏ loại' : 'Loại'}
          </button>
          <button type="button" class={BTN} aria-pressed={a.favorite} disabled={!!busy} onClick={toggleFav} aria-label={a.favorite ? 'Bỏ yêu thích' : 'Yêu thích'}>
            <Heart size={14} fill={a.favorite ? 'currentColor' : 'none'} />
          </button>
          <a href={media(a.url)} download class={BTN} aria-label="Tải xuống"><Download size={14} /></a>
        </div>

        {(isImage || onCreatePost) && (
          <div class="flex flex-col gap-1.5">
            {isImage && onAnimate && <button type="button" class={`${BTN} justify-start`} onClick={() => onAnimate(a)}><Film size={14} />Tạo video từ ảnh này</button>}
            {onCreatePost && <button type="button" class={`${BTN} justify-start`} onClick={() => onCreatePost(a)}><Megaphone size={14} />Tạo bài đăng</button>}
            {isImage && <button type="button" class={`${BTN} justify-start`} disabled={!!busy} onClick={recheck}><ScanFace size={14} />{busy === 'recheck' ? 'Đang chấm…' : 'Kiểm tra lại khuôn mặt'}</button>}
          </div>
        )}

        {isImage && (
          <div class="rounded-md border border-[var(--color-border)] p-2.5 flex flex-col gap-2">
            <div class="text-[12px] font-medium text-[var(--color-text)] inline-flex items-center gap-1.5"><UserRound size={13} />Dùng làm ảnh tham chiếu</div>
            <div class="flex gap-1.5">
              <select class={`${INPUT} h-8 flex-1`} aria-label="Loại ảnh tham chiếu" value={refKind} onChange={(e) => setRefKind((e.target as HTMLSelectElement).value as RefKind)}>
                {REF_KINDS.map((k) => <option key={k} value={k}>{REF_KIND_LABEL[k]}</option>)}
              </select>
              <button type="button" class={BTN_SM} disabled={!!busy} onClick={useAsRef}>{busy === 'ref' ? '…' : 'Thêm'}</button>
            </div>
          </div>
        )}

        <div>
          <MetaRow label="Loại">{ASSET_KIND_LABEL[a.kind]}</MetaRow>
          <MetaRow label="Mô hình">{a.model || '–'}</MetaRow>
          <MetaRow label="Nhà cung cấp">{a.provider || '–'}</MetaRow>
          <MetaRow label="Chi phí">{fmtUsd(a.costUsd)}</MetaRow>
          <MetaRow label="Tạo lúc">{fmtDateTime(a.createdAt)}</MetaRow>
          <MetaRow label="Kích thước">{a.width && a.height ? `${a.width}×${a.height}` : '–'} · {fmtBytes(a.bytes)}</MetaRow>
          {a.durationSec !== null && <MetaRow label="Thời lượng">{fmtDuration(a.durationSec)}</MetaRow>}
          {a.tags.length > 0 && <MetaRow label="Thẻ">{a.tags.join(', ')}</MetaRow>}
        </div>

        {a.prompt && (
          <details class="text-[12px]">
            <summary class="cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Prompt đã dùng</summary>
            <pre class="mt-1.5 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-[var(--color-text)] bg-[var(--color-elevated)] rounded-md p-2">{a.prompt}</pre>
          </details>
        )}

        <button type="button" class={`${BTN_DANGER} mt-auto`} disabled={!!busy} onClick={() => setConfirmDelete(true)}><Trash2 size={14} />Xoá</button>
      </aside>

      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => { void remove(); }}
        title="Xoá file này?"
        body="File bị xoá khỏi máy chủ và không khôi phục được. Không xoá được nếu một bài đăng đang dùng nó."
        confirmLabel="Xoá"
        cancelLabel="Huỷ"
        destructive
      />
    </div>
  );
}
