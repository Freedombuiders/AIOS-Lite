// "Kho": searchable catalog; a click attaches the item to the next message.
import { useEffect, useState } from 'preact/hooks';
import { Check, Eye, Library, Search } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { errorMessage, videoEditApi, type AssetsResponse } from '@modules/video/web/lib/video-edit/api';
import { assetFileUrl } from '@modules/video/web/lib/video-edit/library-api';
import { addAsset, composerAssets, libraryModal } from '@modules/video/web/lib/video-edit/studio';
import type { AssetKind, VideoAsset } from '@modules/video/web/lib/video-edit/types';
import { AssetVisual } from './AssetVisual';

export function AssetPanel() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [kind, setKind] = useState<AssetKind | ''>('');
  const [data, setData] = useState<AssetsResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<VideoAsset | null>(null);

  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    videoEditApi.assets({ kind, q: debounced })
      .then((r) => { if (live) { setData(r); setError(''); } })
      .catch((e) => { if (live) setError(errorMessage(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [kind, debounced]);

  const total = data?.kinds.reduce((a, k) => a + k.count, 0) ?? 0;
  const attached = new Set(composerAssets.value.map((a) => a.ref));

  return (
    <div class="vs-assets">
      <div class="vs-assets-head">
        <span class="vs-eyebrow">Kho tài nguyên</span>
        <button type="button" class="vs-btn" onClick={() => { libraryModal.value = true; }}><Library size={14} aria-hidden="true" /> Quản lý kho</button>
      </div>
      <label class="vs-search">
        <Search size={15} aria-hidden="true" />
        <span class="sr-only">Tìm trong kho</span>
        <input type="search" placeholder="Tìm: whoosh, hồi hộp, so sánh…" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      </label>
      <div class="vs-kinds" role="group" aria-label="Loại mục">
        <button type="button" class={`vs-kind${kind === '' ? ' is-active' : ''}`} aria-pressed={kind === ''} onClick={() => setKind('')}>
          Tất cả <span>{total}</span>
        </button>
        {data?.kinds.map((k) => (
          <button key={k.kind} type="button" class={`vs-kind${kind === k.kind ? ' is-active' : ''}`} aria-pressed={kind === k.kind} onClick={() => setKind(kind === k.kind ? '' : k.kind)}>
            {k.label} <span>{k.count}</span>
          </button>
        ))}
      </div>
      <p class="vs-muted vs-assets-hint">Chạm hình để xem mẫu lớn; bấm Dùng để đính mục vào tin nhắn.</p>
      {error && <div class="vs-error" role="alert">{error}</div>}
      {loading && !data && <div class="vs-skel" role="status" aria-label="Đang tải kho"><span /><span /><span /></div>}
      {data && data.assets.length === 0 && !loading && <p class="vs-muted">Không có mục nào khớp.</p>}
      <ol class="vs-asset-list">
        {data?.assets.map((a, i) => (
          <li key={a.id}>
            <div class={`vs-asset${attached.has(a.id) ? ' is-attached' : ''}`}>
              <button type="button" class="vs-asset-thumb" aria-label={`Xem mẫu ${a.name}`} onClick={() => setPreview(a)}>
                <AssetVisual asset={a} />
                <span class="vs-asset-zoom"><Eye size={13} aria-hidden="true" /></span>
              </button>
              <span class="vs-asset-main">
                <span class="vs-asset-name"><span class="vs-asset-idx">{attached.has(a.id) ? <Check size={12} aria-hidden="true" /> : i + 1}</span>{a.name}</span>
                {a.description && <span class="vs-asset-desc">{a.description}</span>}
                <span class="vs-asset-tags">
                  {a.source === 'library' && <span class="vs-badge vs-badge-lib">Kho của bạn</span>}
                  {(a.kind === 'effect' || a.kind === 'caption') && <span class="vs-badge">Mẫu minh hoạ</span>}
                  {!a.available && a.kind !== 'effect' && a.kind !== 'caption' && <span class="vs-badge vs-badge-warn">chưa có file</span>}
                  {a.tags.slice(0, 2).map((t) => <span key={t} class="vs-tag">{t}</span>)}
                </span>
                <button type="button" class="vs-asset-use" aria-pressed={attached.has(a.id)} onClick={() => addAsset({ kind: 'asset', ref: a.id, label: a.name })}>
                  {attached.has(a.id) ? 'Đã chọn' : 'Dùng mục này'}
                </button>
              </span>
            </div>
          </li>
        ))}
      </ol>
      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.name ?? 'Xem mẫu'} width={450}>
        {preview && <div class="vs-asset-detail">
          <AssetVisual asset={preview} large />
          <div class="vs-asset-detail-copy">
            {preview.description && <p>{preview.description}</p>}
            {(preview.kind === 'effect' || preview.kind === 'caption') && <p class="vs-muted">Đây là hình minh hoạ cách trình bày. Kết quả xuất video phụ thuộc cảnh quay, nội dung và khả năng dựng hiện có.</p>}
            {preview.file && (preview.kind === 'bgm' || preview.kind === 'sfx') && <audio controls src={assetFileUrl(preview.id, preview.updatedAt)} />}
            {preview.file && preview.kind === 'video' && <video controls src={assetFileUrl(preview.id, preview.updatedAt)} />}
            <button type="button" class="vs-btn vs-asset-detail-use" onClick={() => { addAsset({ kind: 'asset', ref: preview.id, label: preview.name }); setPreview(null); }}>Dùng mục này</button>
          </div>
        </div>}
      </Modal>
    </div>
  );
}
