// Studio composer parts: slot cards + library picker, prompt preview, and
// the "Đang tạo & vừa xong" generation strip.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { AlertTriangle, ChevronDown, ChevronRight, ImagePlus, Info, Pencil, RefreshCw, RotateCcw, Search, SlidersHorizontal, X } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { BTN_SM, FilterChip, INPUT, InlineError, TEXTAREA } from '@modules/kol/web/components/shared/ops-shared';
import { useAssetIndex, useGenerations } from '@modules/kol/web/components/hooks';
import { GroupChips, LIBRARY_ICON, LibraryArt, LibraryTile, artSrc } from '@modules/kol/web/components/library';
import { PreviewStudioModal } from '@modules/kol/web/components/previews';
import { Lightbox } from '@modules/kol/web/components/Lightbox';
import { ConsistencyBadge, KolImg, TonePill, toastError } from '@modules/kol/web/components/ui';
import { useDebouncedValue } from '@/lib/useDebounce';
import { pushToast } from '@/lib/toasts';
import {
  GENERATION_MODE_LABEL, GENERATION_STATUS, LIBRARY_GENDER_LABEL, LIBRARY_KIND_LABEL, REF_ROLE_LABEL, filterLibrary, fitsGender, fmtAgo, fmtClock, fmtEstimate, fmtEta,
  fmtUsd, isActiveGeneration, kolApi,
  type AssetDto, type GenerationDto, type GenerationKind, type LibraryItemDto, type LibraryKind, type PromptPreviewDto,
} from '@modules/kol/web/lib/kol';

// ── Slots ────────────────────────────────────────────────────────────

/**
 * One creative slot. Picked: the item's picture (photo, catalog photo or camera diagram) and name.
 * Default: a muted mosaic of what the kind holds and how many choices there are. Click opens the picker.
 * `label` replaces the item's name (a camera setup names all its picks).
 */
export function SlotCard({ kind, item, label, onOpen, onClear, disabled, choices = [] }: {
  kind: LibraryKind; item: LibraryItemDto | null; label?: string; onOpen: () => void; onClear: () => void; disabled?: boolean;
  /** Every item of the kind, for the default state's mosaic and count. */
  choices?: LibraryItemDto[];
}) {
  const Icon = LIBRARY_ICON[kind];
  const name = item ? (label ?? item.name) : 'Mặc định';
  const pic = !!item && (!!artSrc(item) || kind === 'camera');
  // The KOL's own photos first: the mosaic should show the KOL, not a catalog model.
  const mosaic = item ? [] : choices.filter((c) => artSrc(c)).sort((a, b) => Number(b.previewIsPersona) - Number(a.previewIsPersona)).slice(0, 4);
  const wide = kind === 'camera';
  return (
    <div class={`group relative rounded-xl border bg-[var(--color-card)] min-w-0 transition-[border-color,box-shadow] ${
      item ? 'border-[var(--color-accent)] shadow-[0_0_0_1px_var(--color-accent)]' : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
    } ${disabled ? 'opacity-50' : ''}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={onOpen}
        title={item ? name : undefined}
        aria-label={`${LIBRARY_KIND_LABEL[kind]}: ${name}. Bấm để chọn`}
        class="w-full flex items-center gap-3 p-2 pr-9 text-left rounded-xl hover:bg-[var(--color-control-hover)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] min-w-0"
      >
        <span class={`relative shrink-0 ${wide ? 'w-[76px]' : 'w-12'} h-[60px] rounded-lg overflow-hidden flex items-center justify-center ${
          pic || mosaic.length ? 'bg-[var(--color-elevated)]' : item ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'bg-[var(--color-elevated)] text-[var(--color-text-faint)]'
        }`}>
          {pic && item ? <LibraryArt item={item} />
            : mosaic.length >= 4 ? (
              <span class="grid grid-cols-2 grid-rows-2 w-full h-full gap-px opacity-55 saturate-[0.7]" aria-hidden="true">
                {mosaic.map((m) => <KolImg key={m.id} src={artSrc(m)} class="w-full h-full" />)}
              </span>
            ) : <Icon size={20} aria-hidden="true" />}
          {!item && mosaic.length >= 4 && (
            <span class="absolute inset-0 flex items-center justify-center" aria-hidden="true">
              <span class="w-7 h-7 rounded-full bg-black/45 backdrop-blur-sm text-white flex items-center justify-center"><Icon size={14} /></span>
            </span>
          )}
        </span>
        <span class="min-w-0 flex-1">
          <span class="block text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{LIBRARY_KIND_LABEL[kind]}</span>
          <span class={`block text-[13px] leading-snug line-clamp-2 break-words ${item ? 'font-medium text-[var(--color-text)]' : 'text-[var(--color-text-faint)]'}`}>{name}</span>
          {!item && choices.length > 0 && <span class="block text-[11px] text-[var(--color-text-faint)] tabular-nums">{choices.length} lựa chọn</span>}
        </span>
        {!item && <ChevronRight size={15} class="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)] opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden="true" />}
      </button>
      {item && !disabled && (
        <button type="button" aria-label={`Bỏ chọn ${LIBRARY_KIND_LABEL[kind].toLowerCase()}`} onClick={onClear}
          class="absolute top-1.5 right-1.5 w-6 h-6 rounded-full flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)]"><X size={12} /></button>
      )}
    </div>
  );
}

/** Picker sheet: sticky search and group chips, a 4:5 catalog grid; arrow keys move between tiles. */
export function LibraryPickerModal({ kind, items: allItems, selectedId, onPick, onClose, gender = null, persona = null, onPreviewsChanged }: {
  kind: LibraryKind; items: LibraryItemDto[]; selectedId?: string; onPick: (id: string | undefined) => void; onClose: () => void;
  /** The KOL's gender: items for the other gender stay hidden until the owner asks for them. */
  gender?: 'female' | 'male' | null;
  /** The KOL picking: the footer offers to draw the items on that KOL itself. */
  persona?: { id: string; name: string } | null;
  onPreviewsChanged?: () => void;
}) {
  const [group, setGroup] = useState('');
  const [query, setQuery] = useState('');
  const [drawing, setDrawing] = useState(false);
  const other = gender === 'male' ? 'female' : gender === 'female' ? 'male' : null;
  const hidden = useMemo(() => allItems.filter((i) => !fitsGender(i, gender)), [allItems, gender]);
  // A picked item of the other gender keeps the other gender's items in view.
  const [crossOver, setCrossOver] = useState(() => !!selectedId && hidden.some((i) => i.id === selectedId));
  const items = useMemo(() => (crossOver ? allItems : allItems.filter((i) => fitsGender(i, gender))), [allItems, gender, crossOver]);
  const dq = useDebouncedValue(query, 150);
  const shown = useMemo(() => filterLibrary(items, group, dq), [items, group, dq]);
  const gridRef = useRef<HTMLUListElement>(null);
  // With a KOL, an item still lacks a picture until the KOL itself is in it.
  const bare = kind === 'camera' ? 0 : items.filter((i) => (persona ? !i.previewIsPersona : !artSrc(i))).length;

  function onGridKey(e: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    const buttons = Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const first = buttons[0]?.getBoundingClientRect();
    const cols = Math.max(1, buttons.filter((b) => Math.abs(b.getBoundingClientRect().top - (first?.top ?? 0)) < 2).length);
    const next = e.key === 'ArrowLeft' ? i - 1 : e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowUp' ? i - cols : e.key === 'ArrowDown' ? i + cols : e.key === 'Home' ? 0 : buttons.length - 1;
    if (next >= 0 && next < buttons.length) { e.preventDefault(); buttons[next].focus(); }
  }

  const pick = (id: string | undefined) => { onPick(id); onClose(); };

  return (
    <Modal open title={`Chọn ${LIBRARY_KIND_LABEL[kind].toLowerCase()}`} width={1040} height="min(820px, calc(var(--app-height) - 2rem))" onClose={onClose}
      bodyClassName="flex-1 min-h-0 overflow-y-auto px-5 pb-4 flex flex-col gap-3"
      footer={bare > 0 ? (
        <>
          <span class="text-[12px] text-[var(--color-text-muted)] tabular-nums">{persona ? `${bare}/${items.length} mục chưa có ảnh của ${persona.name}` : `${bare}/${items.length} mục chưa có ảnh minh hoạ`}</span>
          <button type="button" class={`${BTN_SM} ml-auto`} onClick={() => setDrawing(true)}><ImagePlus size={12} class="mr-1" />{persona ? `Vẽ bằng ${persona.name}` : 'Vẽ ảnh minh hoạ'}</button>
        </>
      ) : undefined}>
      <div class="sticky top-0 z-10 -mx-5 px-5 pt-4 pb-3 flex flex-col gap-2.5 bg-[var(--color-card)] border-b border-[var(--color-border)]">
        <label class="relative">
          <Search size={14} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" aria-hidden="true" />
          <input class={`${INPUT} w-full pl-8`} type="search" aria-label="Tìm" placeholder={`Tìm trong ${items.length} mục…`} value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        </label>
        <div class="flex flex-wrap items-center gap-1.5">
          <GroupChips items={items} value={group} onChange={setGroup} />
          {other && hidden.length > 0 && (
            <FilterChip on={crossOver} label={`${crossOver ? 'Đang hiện' : 'Hiện'} cả mục cho ${LIBRARY_GENDER_LABEL[other].toLowerCase()}`} count={hidden.length}
              onClick={() => { setCrossOver(!crossOver); setGroup(''); }} />
          )}
        </div>
      </div>
      <ul ref={gridRef} onKeyDown={onGridKey} class="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2.5 sm:gap-3 list-none m-0 p-0">
        <li>
          <button
            type="button"
            aria-pressed={!selectedId}
            onClick={() => pick(undefined)}
            class={`w-full aspect-[4/5] flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed text-[12.5px] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ${!selectedId ? 'border-[var(--color-accent)] text-[var(--color-text)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:bg-[var(--color-control-hover)]'}`}
          >
            <span class="font-semibold">Mặc định</span>
            <span class="text-[11px] text-[var(--color-text-faint)] px-3 text-center leading-snug">Để mô hình tự chọn theo phong cách của KOL</span>
          </button>
        </li>
        {shown.map((it) => (
          <li key={it.id} class="min-w-0">
            <LibraryTile item={it} selected={it.id === selectedId} showGroup={!group} onClick={() => pick(it.id)}
              badge={crossOver && !fitsGender(it, gender) ? LIBRARY_GENDER_LABEL[it.gender] : undefined} />
          </li>
        ))}
      </ul>
      {shown.length === 0 && <p class="text-[12.5px] text-[var(--color-text-muted)]">{items.length === 0 ? 'Thư viện chưa có mục nào loại này. Thêm ở KOL Studio › Thư viện.' : 'Không có mục khớp.'}</p>}
      {drawing && <PreviewStudioModal persona={persona} onClose={() => setDrawing(false)} onChanged={onPreviewsChanged} />}
    </Modal>
  );
}

// ── Prompt preview ───────────────────────────────────────────────────

export function PromptPreviewPanel({ preview, loading, error, override, onOverride }: {
  preview: PromptPreviewDto | null;
  loading: boolean;
  error: string | null;
  override: string | null;
  onOverride: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 flex flex-col gap-2.5 min-w-0" aria-busy={loading}>
      <div class="flex items-center gap-2">
        <span class="text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--color-text-muted)]">Xem trước</span>
        {loading && <span class="text-[11.5px] text-[var(--color-text-faint)]">đang cập nhật…</span>}
        {preview && preview.refs.length > 0 && <span class="text-[11.5px] text-[var(--color-text-faint)] tabular-nums">· {preview.refs.length} ảnh gửi kèm</span>}
        {preview && <span class="ml-auto text-[12.5px] tabular-nums text-[var(--color-text)]">{fmtEstimate(preview.estimateUsd)}</span>}
      </div>
      {error && <InlineError>{error}</InlineError>}
      {preview && preview.refs.length > 0 && (
        <ul class="flex gap-2 overflow-x-auto list-none m-0 p-0 pb-1" aria-label={`${preview.refs.length} ảnh gửi kèm`}>
          {preview.refs.map((r) => (
            <li key={r.index} class="shrink-0 w-[68px] flex flex-col gap-1">
              <span class="relative block w-[68px] h-[68px] rounded-md overflow-hidden border border-[var(--color-border)] bg-[var(--color-elevated)]">
                <KolImg src={r.url} alt={r.label} class="w-full h-full" />
                <span class="absolute top-0.5 left-0.5 rounded bg-black/65 text-white text-[10px] px-1 tabular-nums">{r.index}</span>
              </span>
              <span class="text-[10.5px] leading-tight text-[var(--color-text-muted)] line-clamp-2" title={r.label}>Ảnh {r.index} · {REF_ROLE_LABEL[r.role]}</span>
            </li>
          ))}
        </ul>
      )}
      {preview && (preview.warnings.length > 0 || (preview.notes?.length ?? 0) > 0) && (
        <ul class="flex flex-col gap-1 list-none m-0 p-0">
          {preview.warnings.map((w, i) => (
            <li key={`w${i}`} class="flex items-start gap-1.5 text-[12px] text-[var(--color-priority-medium)]"><AlertTriangle size={13} class="shrink-0 mt-0.5" aria-hidden="true" />{w}</li>
          ))}
          {(preview.notes ?? []).map((w, i) => (
            <li key={`n${i}`} class="flex items-start gap-1.5 text-[11.5px] text-[var(--color-text-faint)]"><Info size={12} class="shrink-0 mt-0.5" aria-hidden="true" />{w}</li>
          ))}
        </ul>
      )}
      {override !== null ? (
        <div class="flex flex-col gap-1.5">
          <div class="flex items-center gap-2 text-[12px]">
            <span class="font-medium text-[var(--color-text)]">Prompt tự chỉnh</span>
            <span class="text-[var(--color-text-muted)]">· ảnh khuôn mặt vẫn được gắn</span>
            <button type="button" class={`${BTN_SM} ml-auto`} onClick={() => onOverride(null)}><RotateCcw size={12} class="mr-1" />Dùng prompt tự động</button>
          </div>
          <textarea class={`${TEXTAREA} w-full font-mono text-[12px]`} rows={8} aria-label="Prompt tự chỉnh" value={override} onInput={(e) => onOverride((e.target as HTMLTextAreaElement).value)} />
        </div>
      ) : preview && (
        <div class="flex flex-col gap-1.5">
          <div class="flex items-center gap-2">
            <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} class="inline-flex items-center gap-1 text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}Prompt ({preview.prompt.length} ký tự)
            </button>
            <button type="button" class={`${BTN_SM} ml-auto`} onClick={() => onOverride(preview.prompt)}><Pencil size={12} class="mr-1" />Chỉnh prompt</button>
          </div>
          {open && <pre class="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-[var(--color-text)] bg-[var(--color-elevated)] rounded-md p-2 max-h-72 overflow-y-auto">{preview.prompt}</pre>}
        </div>
      )}
      {!preview && !loading && !error && <p class="text-[12px] text-[var(--color-text-faint)]">Chọn mô hình để xem prompt và chi phí.</p>}
    </div>
  );
}

// ── Generation strip ─────────────────────────────────────────────────

/** CSS aspect-ratio of a generation's frames ("4 / 5"); square when unknown. */
const frameRatio = (g: GenerationDto): string => (g.params.aspect ?? '1:1').replace(':', ' / ');

/**
 * Recent generations of `kinds`, polled while any is queued/running, results
 * inline; click a result to open the lightbox. Running cards show a clock against
 * `expectedSec`; `describe` names the picks so a good result can be reused.
 */
export function GenerationStrip({
  personaId, kinds, title, onAnimate, onCreatePost, onRefAdded, onReuse, onRetry, onSettled, onList, describe, expectedSec, modelName,
  limit = 12, refreshKey = 0,
}: {
  personaId: string;
  kinds: GenerationKind[];
  title: string;
  onAnimate?: (a: AssetDto) => void;
  onCreatePost?: (a: AssetDto) => void;
  onRefAdded?: () => void;
  /** Load this generation's settings back into the composer. */
  onReuse?: (g: GenerationDto) => void;
  /** Send a failed or interrupted generation again. */
  onRetry?: (g: GenerationDto) => void;
  /** A generation finished (or failed) since the strip loaded: refresh quotas and spend. */
  onSettled?: () => void;
  /** Every fetched generation of the persona (all kinds), e.g. for time estimates. */
  onList?: (gens: GenerationDto[]) => void;
  /** Short names of the picks behind a generation (outfit, scene…). */
  describe?: (g: GenerationDto) => string[];
  /** Expected run time of a generation, for the progress bar. */
  expectedSec?: (g: GenerationDto) => number | null;
  modelName?: (id: string) => string;
  limit?: number;
  /** Bump to refetch right after queuing a job. */
  refreshKey?: number;
}) {
  const gens = useGenerations(personaId, limit * 2);
  // The row sets overflow-anchor: none, or Chrome keeps the old first card in place and pushes new jobs off to the left.
  const listRef = useRef<HTMLUListElement>(null);
  // A new job lands first in the row: bring the row back to the start so it is in view.
  useEffect(() => {
    if (!refreshKey) return;
    gens.refresh();
    listRef.current?.scrollTo({ left: 0, behavior: 'smooth' });
  }, [refreshKey]);
  useEffect(() => { if (gens.data) onList?.(gens.generations); }, [gens.data]);
  const list = gens.generations.filter((g) => kinds.includes(g.kind)).slice(0, limit);
  const version = list.filter((g) => g.status === 'succeeded').map((g) => g.id).join(',');
  const index = useAssetIndex(personaId, version);
  const flat = useMemo(() => list.flatMap((g) => g.assetIds.map((id) => index.byId.get(id)).filter((a): a is AssetDto => !!a)), [list, index.byId]);
  const [open, setOpen] = useState<number | null>(null);

  // Settled ids: tell the parent when one more job has finished since the first load.
  const settled = list.filter((g) => !isActiveGeneration(g)).map((g) => g.id).join(',');
  const firstSettled = useRef<string | null>(null);
  useEffect(() => {
    if (!gens.data) return;
    if (firstSettled.current === null) { firstSettled.current = settled; return; }
    if (settled !== firstSettled.current) { firstSettled.current = settled; onSettled?.(); }
  }, [settled, !!gens.data]);

  // One clock for every running card.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!gens.anyActive) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [gens.anyActive]);

  async function cancel(g: GenerationDto) {
    try {
      await kolApi.cancelGeneration(g.id);
      pushToast({ tone: 'success', title: 'Đã huỷ lượt tạo' });
      gens.refresh();
    } catch (err) {
      toastError('Không huỷ được', err);
    }
  }

  const running = list.filter((g) => g.status === 'running').length;
  const queued = list.filter((g) => g.status === 'queued').length;

  return (
    <section class="flex flex-col gap-2 min-w-0" aria-live="polite">
      <div class="flex items-center gap-2">
        <h2 class="text-[13.5px] font-semibold text-[var(--color-text)]">{title}</h2>
        {gens.anyActive && (
          <span class="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-status-running)] tabular-nums">
            <span class="w-1.5 h-1.5 rounded-full bg-[var(--color-status-running)] animate-pulse" />
            {running ? `${running} đang tạo` : ''}{running && queued ? ' · ' : ''}{queued ? `${queued} đang chờ` : ''}
          </span>
        )}
      </div>
      {gens.error && <InlineError>{gens.error}</InlineError>}
      {gens.data && list.length === 0 && <p class="text-[12.5px] text-[var(--color-text-muted)]">Chưa có lượt tạo nào. Kết quả sẽ hiện ở đây.</p>}
      {list.length > 0 && (
        <ul ref={listRef} class="flex gap-3 overflow-x-auto pb-2 list-none m-0 p-0 snap-x" style={{ overflowAnchor: 'none' }}>
          {list.map((g) => {
            const st = GENERATION_STATUS[g.status];
            const assets = g.assetIds.map((id) => index.byId.get(id)).filter((a): a is AssetDto => !!a);
            const slots = isActiveGeneration(g) ? Math.max(1, g.params.count ?? 1) : 0;
            const cols = Math.max(slots, assets.length) > 1 ? 'grid-cols-2' : 'grid-cols-1';
            const picks = describe?.(g) ?? [];
            const direction = (g.params.extraPrompt ?? '').trim();
            const elapsed = g.status === 'running' && g.startedAt ? now / 1000 - g.startedAt : null;
            const expected = elapsed !== null ? expectedSec?.(g) ?? null : null;
            const took = g.status === 'succeeded' && g.startedAt && g.finishedAt ? g.finishedAt - g.startedAt : null;
            return (
              <li key={g.id} class="snap-start shrink-0 w-[248px] rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-2.5 flex flex-col gap-2">
                <div class="flex flex-wrap items-center gap-1.5 text-[12px]">
                  <TonePill tone={st.tone}>{st.label}</TonePill>
                  <span class="text-[var(--color-text)] font-medium">{GENERATION_MODE_LABEL[g.mode]}</span>
                  <span class="ml-auto text-[var(--color-text-muted)]">{fmtAgo(g.createdAt)}</span>
                </div>
                <div class="-mt-1 text-[11px] text-[var(--color-text-faint)] truncate tabular-nums" title={g.model}>
                  {modelName?.(g.model) ?? g.model} · {g.status === 'succeeded' ? fmtUsd(g.costUsd) : fmtEstimate(g.estimateUsd)}{took ? ` · ${fmtClock(took)}` : ''}
                </div>
                {slots > 0 && (
                  <div class={`grid ${cols} gap-1.5`}>
                    {Array.from({ length: Math.min(4, slots) }, (_, i) => (
                      <span key={i} class="rounded-md bg-[var(--color-elevated)] animate-pulse max-h-[280px]" style={{ aspectRatio: frameRatio(g) }} />
                    ))}
                  </div>
                )}
                {elapsed !== null && (
                  <div class="flex flex-col gap-1">
                    <div class="h-1 rounded-full bg-[var(--color-elevated)] overflow-hidden" aria-hidden="true">
                      <div class="h-full rounded-full bg-[var(--color-status-running)] transition-[width] duration-1000 ease-linear"
                        style={{ width: `${expected ? Math.min(95, (elapsed / expected) * 100) : 30}%` }} />
                    </div>
                    <span class="text-[11px] text-[var(--color-text-muted)] tabular-nums">
                      {fmtClock(elapsed)}{expected ? (elapsed > expected * 1.15 ? ' · lâu hơn thường lệ' : ` / ${fmtEta(expected)}`) : ''}
                    </span>
                  </div>
                )}
                {assets.length > 0 && (
                  <div class={`grid ${cols} gap-1.5`}>
                    {assets.map((a) => (
                      <button key={a.id} type="button" onClick={() => setOpen(flat.findIndex((x) => x.id === a.id))}
                        class="relative block rounded-md overflow-hidden border border-[var(--color-border)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]" aria-label="Xem lớn">
                        <span class="block w-full max-h-[280px]" style={{ aspectRatio: frameRatio(g) }}><KolImg src={a.thumbUrl ?? a.url} class="w-full h-full" /></span>
                        <span class="absolute bottom-1 left-1"><ConsistencyBadge c={a.consistency} compact /></span>
                      </button>
                    ))}
                  </div>
                )}
                {g.status === 'succeeded' && assets.length === 0 && g.assetIds.length > 0 && <span class="text-[11.5px] text-[var(--color-text-faint)]">Đang tải kết quả…</span>}
                {(picks.length > 0 || direction) && (
                  <div class="flex flex-col gap-1 min-w-0">
                    {picks.length > 0 && (
                      <div class="flex flex-wrap gap-1" title={picks.join(' · ')}>
                        {picks.slice(0, 3).map((p) => <span key={p} class="max-w-full truncate rounded px-1.5 py-0.5 text-[10.5px] bg-[var(--color-elevated)] text-[var(--color-text-muted)]">{p}</span>)}
                        {picks.length > 3 && <span class="rounded px-1.5 py-0.5 text-[10.5px] bg-[var(--color-elevated)] text-[var(--color-text-faint)]">+{picks.length - 3}</span>}
                      </div>
                    )}
                    {direction && <p class="text-[11px] italic text-[var(--color-text-muted)] line-clamp-2" title={direction}>“{direction}”</p>}
                  </div>
                )}
                {g.error && <p class="text-[11.5px] text-[var(--color-status-failed)] line-clamp-3" title={g.error}>{g.error}</p>}
                {g.status === 'unknown' && <p class="text-[11.5px] text-[var(--color-text-muted)]">Máy chủ khởi động lại giữa chừng. Không tự gửi lại để tránh trả tiền hai lần; kiểm tra rồi tạo lại nếu cần.</p>}
                <div class="mt-auto flex items-center justify-end gap-1.5 pt-0.5 empty:hidden">
                  {g.status === 'queued' && <button type="button" class={BTN_SM} onClick={() => { void cancel(g); }}>Huỷ</button>}
                  {onRetry && (g.status === 'failed' || g.status === 'unknown') && (
                    <button type="button" class={BTN_SM} title="Gửi lại đúng thiết lập này" onClick={() => onRetry(g)}><RefreshCw size={12} class="mr-1" />Thử lại</button>
                  )}
                  {onReuse && !isActiveGeneration(g) && (
                    <button type="button" class={`${BTN_SM} px-2`} title="Nạp lại lựa chọn, tỷ lệ, mô hình và chỉ dẫn của lượt này vào khung soạn" aria-label="Dùng lại thiết lập" onClick={() => onReuse(g)}>
                      <SlidersHorizontal size={12} class="mr-1" />Dùng lại
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {open !== null && flat[open] && (
        <Lightbox
          assets={flat}
          index={open}
          personaId={personaId}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          onChanged={index.patch}
          onDeleted={(id) => { index.drop(id); setOpen(null); }}
          onRefAdded={onRefAdded}
          onAnimate={onAnimate}
          onCreatePost={onCreatePost}
        />
      )}
    </section>
  );
}
