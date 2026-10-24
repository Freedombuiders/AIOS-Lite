// Camera setup picker for the Studio and the video composer: one choice per
// axis (device & lens, shot size, angle, movement), each tile with a diagram
// and a Vietnamese hint, plus advice when two picks fight each other.

import { useMemo, useRef, useState } from 'preact/hooks';
import { AlertTriangle, Camera, Check, ChevronDown, ChevronRight, Search, X } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { BTN, BTN_PRIMARY, INPUT } from '@modules/kol/web/components/shared/ops-shared';
import { CameraDiagram } from '@modules/kol/web/components/camera-art';
import { KolImg } from '@modules/kol/web/components/ui';
import { useDebouncedValue } from '@/lib/useDebounce';
import { filterLibrary, type LibraryItemDto } from '@modules/kol/web/lib/kol';
import {
  CAMERA_INFO, cameraAxis, cameraAxisOf, cameraPickOn, cameraSections, cameraWarnings, isVideoOnlyCamera, normalizeCameraPicks,
  toggleCameraPick, type CameraAxisId, type CameraContext,
} from '@modules/kol/web/lib/kol-camera';

/** Arrow keys move focus between the tiles of one grid (radio group). */
function onGridKey(e: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
  const grid = e.currentTarget as HTMLElement;
  const tiles = Array.from(grid.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  const i = tiles.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  const top = tiles[0]?.getBoundingClientRect().top ?? 0;
  const cols = Math.max(1, tiles.filter((t) => Math.abs(t.getBoundingClientRect().top - top) < 2).length);
  const next = e.key === 'ArrowLeft' ? i - 1 : e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowUp' ? i - cols : e.key === 'ArrowDown' ? i + cols : e.key === 'Home' ? 0 : tiles.length - 1;
  if (next >= 0 && next < tiles.length) { e.preventDefault(); tiles[next].focus(); }
}

/** Picture for a camera item: its own image, the builtin diagram, or the camera icon. */
export function CameraArt({ item }: { item: Pick<LibraryItemDto, 'id' | 'imageUrl'> }) {
  if (item.imageUrl) return <KolImg src={item.imageUrl} alt="" class="w-full h-full" />;
  const meta = CAMERA_INFO[item.id];
  if (meta) return <CameraDiagram spec={meta.art} />;
  return <span class="w-full h-full flex items-center justify-center text-[var(--color-accent)]"><Camera size={22} aria-hidden="true" /></span>;
}

function CameraTile({ item, selected, onClick }: { item: LibraryItemDto; selected: boolean; onClick: () => void }) {
  const meta = CAMERA_INFO[item.id];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      title={item.prompt}
      class={`w-full h-full flex flex-col text-left rounded-lg border overflow-hidden bg-[var(--color-card)] min-w-0 transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-accent)] ${
        selected ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]' : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
      }`}
    >
      <span class="relative block w-full aspect-[3/2] overflow-hidden bg-[var(--color-elevated)]">
        <CameraArt item={item} />
        {meta?.spec && <span class="absolute bottom-1 left-1 rounded bg-black/60 text-white text-[10px] font-medium px-1.5 py-0.5 tabular-nums">{meta.spec}</span>}
        {item.personaId && <span class="absolute top-1 left-1 rounded bg-black/60 text-white text-[10px] px-1.5 py-0.5">Riêng</span>}
        {selected && (
          <span class="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-[var(--color-accent)] text-[var(--color-on-accent)] flex items-center justify-center shadow">
            <Check size={12} strokeWidth={3} aria-hidden="true" />
          </span>
        )}
      </span>
      <span class="px-2 pt-1.5 pb-2 flex flex-col gap-0.5 min-w-0">
        <span class="text-[12.5px] font-medium leading-snug text-[var(--color-text)] line-clamp-2">{item.name}</span>
        <span class="text-[11.5px] leading-snug text-[var(--color-text-muted)] line-clamp-2">{meta?.hint ?? (item.group || 'Thiết lập riêng')}</span>
      </span>
    </button>
  );
}

function AutoTile({ selected, axisLabel, onClick }: { selected: boolean; axisLabel: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      class={`w-full h-full min-h-[148px] flex flex-col items-center justify-center gap-1.5 px-3 rounded-lg border border-dashed text-center focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-accent)] ${
        selected ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-border-strong)] hover:bg-[var(--color-control-hover)]'
      }`}
    >
      <span class="text-[13px] font-semibold text-[var(--color-text)]">Mặc định</span>
      <span class="text-[11.5px] leading-snug text-[var(--color-text-muted)]">Để mô hình tự chọn {axisLabel.toLowerCase()}</span>
    </button>
  );
}

const GRID = 'grid grid-cols-2 min-[540px]:grid-cols-3 md:grid-cols-4 gap-2.5 list-none m-0 p-0';

/**
 * Pick a camera setup. `value` and the result are library ids, at most one per
 * axis, in prompt order (device, shot, angle, movement). Images hide the
 * movement axis; video lists it first.
 */
export function CameraPickerModal({ items, loading, value, context, onApply, onClose }: {
  items: LibraryItemDto[];
  /** The library is still loading: say so instead of "empty". */
  loading?: boolean;
  value: string[];
  context: CameraContext;
  onApply: (ids: string[]) => void;
  onClose: () => void;
}) {
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const sections = useMemo(() => cameraSections(items, context), [items, context]);
  const [raw, setRaw] = useState<string[]>(value);
  const picks = useMemo(() => normalizeCameraPicks(raw, byId), [raw, byId]);
  const [active, setActive] = useState<CameraAxisId | null>(null);
  const [query, setQuery] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);
  const dq = useDebouncedValue(query, 120);
  const scrollRef = useRef<HTMLDivElement>(null);

  const current = sections.find((s) => s.axis.id === active) ?? sections[0];
  const usable = useMemo(() => items.filter((i) => context === 'video' || !isVideoOnlyCamera(i)), [items, context]);
  const results = useMemo(() => (dq.trim() ? filterLibrary(usable, '', dq) : []), [usable, dq]);
  const warnings = cameraWarnings(picks);
  const picked = picks.map((id) => byId.get(id)!).filter(Boolean);
  // Picks the context cannot use (a movement chosen for video, then reopened for a photo) are kept out of the result.
  const applied = picked.filter((i) => context === 'video' || !isVideoOnlyCamera(i)).map((i) => i.id);

  const toggle = (item: LibraryItemDto) => setRaw(toggleCameraPick(picks, item, byId));
  const clearAxis = (axis: CameraAxisId) => setRaw(picks.filter((id) => cameraAxisOf(byId.get(id)!) !== axis));
  const goAxis = (axis: CameraAxisId) => {
    setActive(axis);
    setQuery('');
    scrollRef.current?.scrollTo({ top: 0 });
  };

  function grid(list: LibraryItemDto[], label: string, auto?: { axis: CameraAxisId; label: string }) {
    return (
      <ul role="radiogroup" aria-label={label} onKeyDown={onGridKey} class={GRID}>
        {auto && <li><AutoTile selected={!cameraPickOn(picks, auto.axis, byId)} axisLabel={auto.label} onClick={() => clearAxis(auto.axis)} /></li>}
        {list.map((it) => <li key={it.id} class="min-w-0"><CameraTile item={it} selected={picks.includes(it.id)} onClick={() => toggle(it)} /></li>)}
      </ul>
    );
  }

  let body;
  if (sections.length === 0) {
    body = <p class="text-[12.5px] text-[var(--color-text-muted)]">{loading ? 'Đang tải thư viện…' : 'Thư viện chưa có thiết lập máy nào. Thêm ở KOL Studio › Thư viện.'}</p>;
  } else if (dq.trim()) {
    const byAxis = sections
      .map((s) => ({ axis: s.axis, items: results.filter((r) => cameraAxisOf(r) === s.axis.id) }))
      .filter((s) => s.items.length > 0);
    body = byAxis.length === 0
      ? <p class="text-[12.5px] text-[var(--color-text-muted)]">Không có thiết lập khớp “{query.trim()}”.</p>
      : byAxis.map((s) => (
        <section key={s.axis.id} class="flex flex-col gap-2">
          <h3 class="text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--color-text-muted)]">{s.axis.label}</h3>
          {grid(s.items, s.axis.label)}
        </section>
      ));
  } else if (current) {
    const groups = [...new Set(current.items.map((i) => i.group || 'Khác'))];
    body = (
      <section class="flex flex-col gap-3" aria-labelledby="cam-axis-title">
        <div>
          <h3 id="cam-axis-title" class="text-[14px] font-semibold text-[var(--color-text)]">{current.axis.label}</h3>
          <p class="text-[12px] text-[var(--color-text-muted)]">{current.axis.hint}</p>
        </div>
        {groups.length === 1 ? grid(current.items, current.axis.label, { axis: current.axis.id, label: current.axis.label }) : (
          <div role="radiogroup" aria-label={current.axis.label} class="flex flex-col gap-3">
            {groups.map((g, gi) => (
              <div key={g} class="flex flex-col gap-2">
                <h4 class="text-[11.5px] font-semibold uppercase tracking-[0.05em] text-[var(--color-text-faint)]">{g}</h4>
                <ul onKeyDown={onGridKey} class={GRID}>
                  {gi === 0 && <li><AutoTile selected={!cameraPickOn(picks, current.axis.id, byId)} axisLabel={current.axis.label} onClick={() => clearAxis(current.axis.id)} /></li>}
                  {current.items.filter((i) => (i.group || 'Khác') === g).map((it) => (
                    <li key={it.id} class="min-w-0"><CameraTile item={it} selected={picks.includes(it.id)} onClick={() => toggle(it)} /></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  const promptText = picked.filter((i) => applied.includes(i.id)).map((i) => i.prompt.trim().replace(/[\s.;,]+$/, '')).join('; ');

  return (
    <Modal
      open
      title="Thiết lập máy ảnh"
      width={1040}
      height="min(820px, calc(var(--app-height) - 2rem))"
      onClose={onClose}
      bodyClassName="flex-1 min-h-0 flex flex-col sm:flex-row"
      footer={(
        <div class="w-full flex flex-col gap-2 min-w-0">
          {warnings.length > 0 && (
            <ul class="flex flex-col gap-1 list-none m-0 p-0" aria-live="polite">
              {warnings.map((w) => (
                <li key={w} class="flex items-start gap-1.5 text-[12px] text-[var(--color-priority-medium)]"><AlertTriangle size={13} class="shrink-0 mt-0.5" aria-hidden="true" />{w}</li>
              ))}
            </ul>
          )}
          <div class="flex flex-wrap items-center gap-2">
            <div class="flex-1 min-w-[200px] flex flex-wrap items-center gap-1.5" aria-live="polite">
              {picked.length === 0 ? (
                <span class="text-[12.5px] text-[var(--color-text-muted)]">{context === 'video' ? 'Chưa chọn gì: mô hình tự quyết máy, khung hình, góc và chuyển động máy.' : 'Chưa chọn gì: mô hình tự quyết máy, khung hình và góc chụp.'}</span>
              ) : picked.map((it) => {
                const off = !applied.includes(it.id);
                return (
                  <span key={it.id} class={`inline-flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-full text-[12px] max-w-full ${off ? 'bg-[var(--color-elevated)] text-[var(--color-text-faint)] line-through' : 'bg-[var(--color-accent-soft)] text-[var(--color-text)]'}`}
                    title={off ? 'Chỉ dùng cho video, không áp dụng cho ảnh' : undefined}>
                    <span class="text-[var(--color-text-muted)] shrink-0">{cameraAxis(cameraAxisOf(it)).short}</span>
                    <span class="truncate font-medium">{it.name}</span>
                    <button type="button" aria-label={`Bỏ ${it.name}`} onClick={() => setRaw(picks.filter((id) => id !== it.id))}
                      class="w-5 h-5 shrink-0 rounded-full flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)]"><X size={11} /></button>
                  </span>
                );
              })}
            </div>
            {picked.length > 0 && <button type="button" class={BTN} onClick={() => setRaw([])}>Bỏ hết</button>}
            <button type="button" class={BTN} onClick={onClose}>Huỷ</button>
            <button type="button" class={BTN_PRIMARY} onClick={() => { onApply(applied); onClose(); }}>Áp dụng</button>
          </div>
          {promptText && (
            <div class="flex flex-col gap-1">
              <button type="button" aria-expanded={showPrompt} onClick={() => setShowPrompt(!showPrompt)}
                class="self-start inline-flex items-center gap-1 text-[11.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                {showPrompt ? <ChevronDown size={12} /> : <ChevronRight size={12} />}Đoạn prompt gửi cho mô hình
              </button>
              {showPrompt && <p class="m-0 font-mono text-[11.5px] leading-relaxed text-[var(--color-text)] bg-[var(--color-elevated)] rounded-md px-2.5 py-2 break-words">Camera: {promptText}.</p>}
            </div>
          )}
        </div>
      )}
    >
      <nav aria-label="Các phần thiết lập" class="shrink-0 sm:w-[232px] border-b sm:border-b-0 sm:border-r border-[var(--color-border)] p-2 sm:p-3 flex sm:flex-col gap-1 overflow-x-auto sm:overflow-y-auto">
        {sections.map((s, i) => {
          const on = !dq.trim() && s.axis.id === current?.axis.id;
          const pick = cameraPickOn(picks, s.axis.id, byId);
          return (
            <button
              key={s.axis.id}
              type="button"
              aria-current={on ? 'true' : undefined}
              onClick={() => goAxis(s.axis.id)}
              class={`shrink-0 sm:w-full min-w-[150px] sm:min-w-0 flex items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ${
                on ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-control-hover)]'
              }`}
            >
              <span class={`mt-px w-5 h-5 shrink-0 rounded-full flex items-center justify-center text-[11px] font-semibold ${
                pick ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)]' : 'border border-[var(--color-border-strong)] text-[var(--color-text-muted)]'
              }`}>{pick ? <Check size={11} strokeWidth={3} aria-hidden="true" /> : i + 1}</span>
              <span class="min-w-0 flex-1">
                <span class="block text-[12.5px] font-medium text-[var(--color-text)]">{s.axis.label}</span>
                <span class={`block text-[11.5px] truncate ${pick ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-faint)]'}`}>{pick ? pick.name : 'Mặc định'}</span>
              </span>
            </button>
          );
        })}
      </nav>
      <div class="flex-1 min-w-0 min-h-0 flex flex-col">
        <div class="px-4 sm:px-5 pt-3 pb-2.5 border-b border-[var(--color-border)]">
          <label class="relative block">
            <Search size={14} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" aria-hidden="true" />
            <input class={`${INPUT} w-full pl-8`} type="search" aria-label="Tìm thiết lập máy" placeholder="Tìm: 85mm, selfie, toàn thân, góc thấp…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
          </label>
        </div>
        <div ref={scrollRef} class="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-4 flex flex-col gap-5">{body}</div>
      </div>
    </Modal>
  );
}
