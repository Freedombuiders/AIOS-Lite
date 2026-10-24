// Pick assets for a post: approved media of the persona, multi-select in order.

import { useEffect, useState } from 'preact/hooks';
import { Check } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { BTN, BTN_PRIMARY, Checkbox, apiFail } from '@modules/kol/web/components/shared/ops-shared';
import { PageState } from '@/components/PageState';
import { AssetThumb } from '@modules/kol/web/components/ui';
import { kolApi, type AssetDto } from '@modules/kol/web/lib/kol';

export function AssetPickerModal({ personaId, selected, max = 10, onDone, onClose }: {
  personaId: string;
  selected: string[];
  max?: number;
  onDone: (ids: string[], assets: AssetDto[]) => void;
  onClose: () => void;
}) {
  const [all, setAll] = useState(false);
  const [assets, setAssets] = useState<AssetDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>(selected);

  useEffect(() => {
    let cancelled = false;
    setAssets(null);
    kolApi.assets({ personaId, status: all ? '' : 'approved', limit: 100 })
      .then((r) => { if (!cancelled) setAssets(r.assets.filter((a) => a.kind !== 'audio' && a.status !== 'rejected')); })
      .catch((err) => { if (!cancelled) setError(apiFail(err).message); });
    return () => { cancelled = true; };
  }, [personaId, all]);

  function toggle(id: string) {
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= max ? cur : [...cur, id]));
  }

  return (
    <Modal
      open
      title="Chọn ảnh / video cho bài"
      width={860}
      onClose={onClose}
      footer={
        <>
          <span class="text-[12px] text-[var(--color-text-muted)] tabular-nums">Đã chọn {picked.length}/{max} · thứ tự theo lúc bấm</span>
          <div class="ml-auto flex gap-2">
            <button type="button" class={BTN} onClick={onClose}>Huỷ</button>
            <button type="button" class={BTN_PRIMARY} onClick={() => { onDone(picked, (assets ?? []).filter((a) => picked.includes(a.id))); onClose(); }}>Xong</button>
          </div>
        </>
      }
    >
      <div class="flex flex-col gap-3">
        <Checkbox checked={all} onChange={setAll}>Hiện cả ảnh chưa duyệt</Checkbox>
        {!assets && <PageState loading={!error} error={error} />}
        {assets && assets.length === 0 && (
          <p class="text-[12.5px] text-[var(--color-text-muted)]">{all ? 'Chưa có ảnh hay video nào.' : 'Chưa có ảnh đã duyệt. Duyệt ảnh ở Thư viện ảnh, hoặc bật “Hiện cả ảnh chưa duyệt”.'}</p>
        )}
        {assets && assets.length > 0 && (
          <ul class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2 list-none m-0 p-0">
            {assets.map((a) => {
              const n = picked.indexOf(a.id);
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    aria-pressed={n >= 0}
                    aria-label={`${a.kind === 'video' ? 'Video' : 'Ảnh'}${n >= 0 ? `, thứ ${n + 1}` : ''}`}
                    onClick={() => toggle(a.id)}
                    class={`relative block w-full aspect-square rounded-md overflow-hidden border-2 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ${n >= 0 ? 'border-[var(--color-accent)]' : 'border-transparent'}`}
                  >
                    <AssetThumb asset={a} class="w-full h-full" />
                    <span class={`absolute top-1 right-1 w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold tabular-nums ${n >= 0 ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)]' : 'bg-black/45 text-white'}`}>
                      {n >= 0 ? n + 1 : <Check size={12} class="opacity-60" />}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
