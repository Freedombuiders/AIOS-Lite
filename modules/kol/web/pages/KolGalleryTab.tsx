/** /kol/:id?tab=gallery — every generated image/video/audio with review, QA badges and the lightbox. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Heart, ImagePlus, Images, Play, Wand2 } from 'lucide-preact';
import { PageState } from '@/components/PageState';
import { BTN, BTN_PRIMARY, FilterChip, apiFail } from '@modules/kol/web/components/shared/ops-shared';
import { Lightbox } from '@modules/kol/web/components/Lightbox';
import { AssetThumb, ConsistencyBadge, EmptyHint, TonePill } from '@modules/kol/web/components/ui';
import { ASSET_STATUS, kolApi, type AssetDto, type AssetKind, type AssetStatus } from '@modules/kol/web/lib/kol';
import { pushToast } from '@/lib/toasts';
import type { WorkspaceTabProps } from './workspace-types';

const PAGE = 40;
const STATUS_CHIPS: { value: AssetStatus | ''; label: string }[] = [
  { value: '', label: 'Tất cả' }, { value: 'new', label: 'Mới' }, { value: 'approved', label: 'Đã duyệt' }, { value: 'rejected', label: 'Đã loại' },
];
const KIND_CHIPS: { value: AssetKind | ''; label: string }[] = [
  { value: '', label: 'Mọi loại' }, { value: 'image', label: 'Ảnh' }, { value: 'video', label: 'Video' }, { value: 'audio', label: 'Âm thanh' },
];

export function KolGalleryTab({ persona, go, refreshPersona }: WorkspaceTabProps) {
  const [status, setStatus] = useState<AssetStatus | ''>('');
  const [kind, setKind] = useState<AssetKind | ''>('');
  const [fav, setFav] = useState(false);
  const [assets, setAssets] = useState<AssetDto[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const [importing, setImporting] = useState<{ done: number; total: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /** The owner's existing photos/videos of this KOL → gallery, approved, judged in the background. One at a time. */
  async function importFiles(files: File[]) {
    if (!files.length) return;
    setImporting({ done: 0, total: files.length });
    let ok = 0;
    const failed: string[] = [];
    for (const [i, f] of files.entries()) {
      try {
        await kolApi.importAsset(persona.id, f, { status: 'approved' });
        ok++;
      } catch (err) {
        failed.push(`${f.name}: ${apiFail(err).message}`);
      }
      setImporting({ done: i + 1, total: files.length });
    }
    setImporting(null);
    setReload((n) => n + 1);
    pushToast({
      tone: failed.length ? 'warn' : 'success',
      title: `Đã nhập ${ok}/${files.length} tệp`,
      description: failed.length ? failed.slice(0, 3).join(' · ') : 'Ảnh đã được duyệt sẵn. Điểm giống khuôn mặt sẽ hiện dần (chấm lần lượt từng ảnh).',
    });
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    kolApi.assets({ personaId: persona.id, status, kind, favorite: fav, limit: PAGE })
      .then((r) => { if (!cancelled) { setAssets(r.assets); setNext(r.nextBefore); } })
      .catch((err) => { if (!cancelled) setError(apiFail(err).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [persona.id, status, kind, fav, reload]);

  async function more() {
    if (next === null) return;
    setLoadingMore(true);
    try {
      const r = await kolApi.assets({ personaId: persona.id, status, kind, favorite: fav, before: next, limit: PAGE });
      setAssets((cur) => [...cur, ...r.assets.filter((a) => !cur.some((c) => c.id === a.id))]);
      setNext(r.nextBefore);
    } catch (err) {
      setError(apiFail(err).message);
    } finally {
      setLoadingMore(false);
    }
  }

  function removeFromView(id: string) {
    const i = assets.findIndex((x) => x.id === id);
    const out = assets.filter((x) => x.id !== id);
    setAssets(out);
    setOpen(out.length ? Math.min(Math.max(0, i), out.length - 1) : null);
  }

  /** Keep the list consistent with the active filters after an edit in the lightbox. */
  function changed(a: AssetDto) {
    const fits = (!status || a.status === status) && (!fav || a.favorite);
    if (fits) setAssets((cur) => cur.map((x) => (x.id === a.id ? a : x)));
    else removeFromView(a.id);
  }

  const filtered = status !== '' || kind !== '' || fav;

  return (
    <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4 flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label="Trạng thái" class="flex flex-wrap gap-1.5">
          {STATUS_CHIPS.map((c) => <FilterChip key={c.value} on={status === c.value} label={c.label} onClick={() => setStatus(c.value)} />)}
        </div>
        <div role="group" aria-label="Loại" class="flex flex-wrap gap-1.5">
          {KIND_CHIPS.map((c) => <FilterChip key={c.value} on={kind === c.value} label={c.label} onClick={() => setKind(c.value)} />)}
        </div>
        <button type="button" aria-pressed={fav} onClick={() => setFav(!fav)}
          class={`h-8 px-3 rounded-md border text-[12.5px] inline-flex items-center gap-1.5 ${fav ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-text)] font-semibold' : 'border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
          <Heart size={13} fill={fav ? 'currentColor' : 'none'} />Yêu thích
        </button>
        <div class="ml-auto flex items-center gap-2">
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" multiple class="hidden"
            onChange={(e) => { const input = e.target as HTMLInputElement; const files = Array.from(input.files ?? []); input.value = ''; void importFiles(files); }} />
          <button type="button" class={BTN} disabled={!!importing} onClick={() => fileRef.current?.click()} title="Đưa ảnh/video có sẵn của KOL vào thư viện để đăng bài và kiểm tra độ giống">
            <ImagePlus size={14} />{importing ? `Đang nhập ${importing.done}/${importing.total}…` : 'Nhập ảnh có sẵn'}
          </button>
          <button type="button" class={BTN} onClick={() => setReload((n) => n + 1)}>Làm mới</button>
        </div>
      </div>

      {loading && assets.length === 0 && <PageState loading />}
      {error && <PageState error={error} />}
      {!loading && !error && assets.length === 0 && (
        filtered
          ? <EmptyHint icon={<Images size={20} />} title="Không có mục nào khớp bộ lọc">Bỏ bớt bộ lọc để xem thêm.</EmptyHint>
          : <EmptyHint icon={<Images size={20} />} title="Chưa có ảnh nào" action={<button type="button" class={BTN_PRIMARY} onClick={() => go('studio')}><Wand2 size={14} />Tạo ảnh ở Studio</button>}>
              Ảnh và video {persona.name} tạo ra sẽ nằm ở đây, kèm điểm giống khuôn mặt. Duyệt ảnh tốt để dùng cho bài đăng.
            </EmptyHint>
      )}

      {assets.length > 0 && (
        <ul class="columns-2 sm:columns-3 lg:columns-4 2xl:columns-5 gap-3 list-none m-0 p-0">
          {assets.map((a, i) => {
            const st = ASSET_STATUS[a.status];
            const ratio = a.width && a.height ? `${a.width} / ${a.height}` : '4 / 5';
            return (
              <li key={a.id} class="break-inside-avoid mb-3">
                <button
                  type="button"
                  onClick={() => setOpen(i)}
                  aria-label={`Mở ${a.kind === 'video' ? 'video' : 'ảnh'} ${i + 1}, ${st.label}`}
                  class={`relative block w-full rounded-lg overflow-hidden border bg-[var(--color-card)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-accent)] ${a.status === 'rejected' ? 'opacity-55' : ''} ${a.status === 'approved' ? 'border-[var(--color-status-done)]' : 'border-[var(--color-border)]'}`}
                >
                  <span class="block w-full" style={{ aspectRatio: a.kind === 'audio' ? '4 / 3' : ratio }}>
                    <AssetThumb asset={a} class="w-full h-full" />
                  </span>
                  <span class="absolute top-1.5 left-1.5"><ConsistencyBadge c={a.consistency} compact /></span>
                  {a.favorite && <span class="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/55 text-white flex items-center justify-center"><Heart size={12} fill="currentColor" /></span>}
                  {a.status !== 'new' && <span class="absolute bottom-1.5 right-1.5"><TonePill tone={st.tone}>{st.label}</TonePill></span>}
                  {a.kind === 'video' && <span class="absolute inset-0 flex items-center justify-center pointer-events-none"><span class="w-10 h-10 rounded-full bg-black/50 text-white flex items-center justify-center"><Play size={18} /></span></span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {next !== null && assets.length > 0 && (
        <button type="button" class={`${BTN} self-center`} disabled={loadingMore} onClick={() => { void more(); }}>{loadingMore ? 'Đang tải…' : 'Xem thêm'}</button>
      )}

      {open !== null && assets[open] && (
        <Lightbox
          assets={assets}
          index={open}
          personaId={persona.id}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          onChanged={changed}
          onDeleted={removeFromView}
          onRefAdded={refreshPersona}
          onAnimate={(a) => go('video', { asset: a.id })}
          onCreatePost={(a) => go('content', { compose: a.id })}
        />
      )}
    </div>
  );
}
