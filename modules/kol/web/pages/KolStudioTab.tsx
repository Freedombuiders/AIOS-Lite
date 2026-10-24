/**
 * /kol/:id?tab=studio — the image composer.
 *
 * Left: the creative brief (direction, library slots, template to recreate). Right: the
 * render settings (model, aspect, quality, count, realism, seed) and the live prompt
 * preview. A dock pinned to the bottom always shows what one click will make, its price,
 * how long it takes and the quota left, with the button (⌘/Ctrl+Enter). Below: recent
 * generations, each one reusable.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Images, LayoutTemplate, RotateCcw, Wand2, X } from 'lucide-preact';
import { Toggle } from '@/components/Toggle';
import { BTN, BTN_SM, Field, INPUT, InlineError, TEXTAREA, apiFail } from '@modules/kol/web/components/shared/ops-shared';
import { usePreview } from '@modules/kol/web/components/hooks';
import { StudioReadiness } from '@modules/kol/web/components/Readiness';
import { CameraPickerModal } from '@modules/kol/web/components/camera';
import { GenerationStrip, LibraryPickerModal, PromptPreviewPanel, SlotCard } from '@modules/kol/web/components/studio';
import { VideoGallery } from '@modules/kol/web/components/VideoGallery';
import { TemplatePickerModal, uploadTemplates } from '@modules/kol/web/components/templates';
import { AspectPicker, DropZone, KolImg, ModelSelect, Segmented } from '@modules/kol/web/components/ui';
import { matchesModKey, modKeyLabel } from '@modules/kol/web/lib/mod-key';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import {
  ASPECTS, ASPECT_LABEL, GENERATION_MODE_LABEL, KOL, QUALITY_SHORT, REALISM_LABEL, REALISM_PRESETS, SLOTS,
  buildImageRequest, composerFromGeneration, composerMode, etaSeconds, findModel, fitsGender, fmtEstimate, fmtEta, fmtUsd, genderOfText, generateBlocker,
  isInstagramFeedAspect, kolApi, meterColor, meterPercent, modelOptions, pickCount, pickModel, secondsPerImage, splitForParallel,
  supportsSeed,
  type ComposerState, type GenerationDto, type GenerationRequest, type KolSettingsDto, type LibraryItemDto, type LibraryKind,
  type ModelInfo, type PersonaDto, type Quality, type RealismPreset, type TemplateDto,
} from '@modules/kol/web/lib/kol';
import { selectionCameraIds } from '@modules/kol/web/lib/kol-camera';
import type { WorkspaceTabProps } from './workspace-types';

// Kept for the browser session so switching tabs does not lose the composition.
const composerCache = new Map<string, ComposerState>();

const ALL_QUALITIES: Quality[] = ['draft', 'standard', 'high', 'ultra'];

function initialState(persona: PersonaDto): ComposerState {
  return {
    selection: {}, freeform: false, model: '', aspect: '4:5', quality: 'standard', count: 2, seed: '',
    extraPrompt: '', realism: persona.realismPreset, promptOverride: null,
  };
}

/** "ChatGPT Images (gpt-image qua Codex)" → "ChatGPT Images". */
const shortModel = (label: string): string => label.replace(/\s*\([^)]*\)\s*$/, '') || label;

export function KolStudioTab({ persona, status, go, refreshPersona }: WorkspaceTabProps) {
  const [s, setS] = useState<ComposerState>(() => composerCache.get(persona.id) ?? initialState(persona));
  const [picker, setPicker] = useState<LibraryKind | null>(null);
  const [templatePicker, setTemplatePicker] = useState(false);
  const [pickedTemplate, setPickedTemplate] = useState<TemplateDto | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [history, setHistory] = useState<GenerationDto[]>([]);
  const directionRef = useRef<HTMLTextAreaElement>(null);

  const lib = useFetch<{ items: LibraryItemDto[] }>(KOL.library({ personaId: persona.id }));
  const templates = useFetch<{ templates: TemplateDto[] }>(KOL.templates);
  const settings = useFetch<{ settings: KolSettingsDto }>(KOL.settings);

  useEffect(() => { composerCache.set(persona.id, s); }, [s, persona.id]);
  const set = (patch: Partial<ComposerState>) => setS((cur) => ({ ...cur, ...patch }));
  const setSel = (patch: Partial<ComposerState['selection']>) => setS((cur) => ({ ...cur, selection: { ...cur.selection, ...patch } }));

  // Default model once providers are known; keep quality/aspect within what the model allows.
  const options = useMemo(() => modelOptions(status, 'image'), [status]);
  useEffect(() => {
    if (!status) return;
    const current = findModel(status, s.model);
    if (!s.model || !current || !current.configured) {
      const next = pickModel(status, 'image', [persona.imageModel]);
      if (next && next !== s.model) set({ model: next });
    }
  }, [status, persona.imageModel]);
  const model = findModel(status, s.model)?.model ?? null;
  const qualities = model?.qualities.length ? model.qualities : ALL_QUALITIES;
  const aspects = model?.aspects.length ? model.aspects : ASPECTS;
  useEffect(() => {
    const patch: Partial<ComposerState> = {};
    if (!qualities.includes(s.quality)) patch.quality = qualities.includes('standard') ? 'standard' : qualities[0];
    if (!aspects.includes(s.aspect)) patch.aspect = aspects.includes('4:5') ? '4:5' : aspects[0];
    if (Object.keys(patch).length) set(patch);
  }, [s.model, model]);

  const items = lib.data?.items ?? [];
  // The KOL's wardrobe: items for her/his gender, items for everyone and her/his own. The pickers can still show the rest.
  const gender = genderOfText(persona.appearance.gender);
  const byKind = useMemo(() => {
    const m = new Map<LibraryKind, LibraryItemDto[]>();
    for (const it of items) (m.get(it.kind) ?? m.set(it.kind, []).get(it.kind)!).push(it);
    return m;
  }, [items]);
  const fitting = (kind: LibraryKind) => (byKind.get(kind) ?? []).filter((i) => fitsGender(i, gender));
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const cameraPicks = selectionCameraIds(s.selection).map((id) => itemById.get(id)).filter((i): i is LibraryItemDto => !!i);
  const setCamera = (ids: string[]) => setSel({ cameraId: undefined, cameraIds: ids.length ? ids : undefined });

  const allTemplates = templates.data?.templates ?? [];
  const templateId = s.selection.templateId;
  const template = templateId
    ? (allTemplates.find((t) => t.id === templateId) ?? (pickedTemplate?.id === templateId ? pickedTemplate : null))
    : null;
  const recentTemplates = useMemo(
    () => allTemplates.filter((t) => t.kind === 'single').sort((a, b) => b.createdAt - a.createdAt).slice(0, 6),
    [allTemplates],
  );

  const mode = composerMode(templateId, s.freeform);
  const req = useMemo(() => buildImageRequest(persona.id, s), [persona.id, s]);
  const pv = usePreview(req, 400);
  const estimate = pv.preview?.estimateUsd ?? null;
  const picks = pickCount(s.selection);
  const dirty = picks > 0 || !!templateId || !!s.extraPrompt.trim() || s.promptOverride !== null;

  const parallel = settings.data?.settings.chatgptParallel ?? 3;
  const perImage = (m: Pick<ModelInfo, 'id' | 'provider'>) => secondsPerImage(history, m);
  const eta = model ? etaSeconds(perImage(model), s.count, model.provider, parallel) : null;

  const blocker = generateBlocker({ status, persona, mode, model: s.model })
    ?? (s.freeform && !s.extraPrompt.trim() && !s.promptOverride?.trim() ? 'Chế độ prompt tự do: viết prompt trước khi tạo.' : null);

  /** Queue a request; ChatGPT batches go out as parallel one-image jobs. */
  async function submit(base: GenerationRequest) {
    const provider = findModel(status, base.params?.model ?? '')?.model.provider ?? null;
    const parts = splitForParallel(base, provider);
    const images = base.params?.count ?? 1;
    setBusy(true);
    setGenError(null);
    let sent = 0;
    let usd = 0;
    let failure: unknown = null;
    for (const part of parts) {
      try {
        const { generation } = await kolApi.generate(part);
        sent += part.params?.count ?? 1;
        usd += generation.estimateUsd;
      } catch (err) {
        failure = err;
        break;
      }
    }
    setBusy(false);
    if (sent > 0) {
      setRefreshKey((k) => k + 1);
      invalidateFetchCache(KOL.status);
      const m = findModel(status, base.params?.model ?? '')?.model;
      const time = m ? fmtEta(etaSeconds(perImage(m), sent, m.provider, parallel)) : '';
      pushToast({
        tone: 'success',
        title: `Đang tạo ${sent} ảnh${parts.length > 1 ? ' song song' : ''}`,
        description: [GENERATION_MODE_LABEL[base.mode], fmtEstimate(usd), time].filter(Boolean).join(' · '),
      });
    }
    if (failure) {
      const f = apiFail(failure);
      const prefix = f.status === 402 ? 'Vượt hạn mức chi tiêu' : f.status === 409 ? (/ChatGPT/.test(f.message) ? 'Hết lượt ChatGPT hôm nay' : 'Studio đang tắt hoặc bị khoá') : f.status === 412 ? 'Thiếu API key' : 'Không tạo được';
      const partial = sent > 0 ? ` (đã gửi ${sent}/${images} ảnh)` : '';
      setGenError(`${prefix}${partial}: ${f.message}`);
      pushToast({ tone: f.status === 402 || f.status === 409 ? 'warn' : 'error', title: `${prefix}${partial}`, description: f.message, ttlMs: 8000 });
    }
  }

  const canRun = !blocker && !busy;
  const runRef = useRef<() => void>(() => {});
  runRef.current = () => { if (canRun) void submit(req); };

  // ⌘/Ctrl+Enter generates from anywhere in the tab, except inside a dialog.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Enter' || !matchesModKey(e) || e.repeat) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      runRef.current();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function reuse(g: GenerationDto) {
    setS((cur) => composerFromGeneration(g, cur));
    if (g.mode !== 'recreate') setPickedTemplate(null);
    // Scrolling back to the filled composer is the confirmation (a toast would cover the dock button).
    directionRef.current?.closest('[data-studio-top]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    directionRef.current?.focus({ preventScroll: true });
  }

  /** Same picks, format and model as the failed run, with its own image count. */
  function retry(g: GenerationDto) {
    void submit(buildImageRequest(persona.id, { ...composerFromGeneration(g, s), count: g.params.count ?? 1 }));
  }

  function reset() {
    set({ selection: {}, extraPrompt: '', promptOverride: null, seed: '' });
    setPickedTemplate(null);
  }

  /** Short names of what a past generation picked, in slot order. */
  function describe(g: GenerationDto): string[] {
    const out: string[] = [];
    for (const { key } of SLOTS) {
      const id = g.selection[key];
      const it = id ? itemById.get(id) : null;
      if (it) out.push(it.name);
    }
    for (const id of g.selection.cameraIds ?? []) { const it = itemById.get(id); if (it) out.push(it.name); }
    const t = g.selection.templateId ? allTemplates.find((x) => x.id === g.selection.templateId) : null;
    if (t) out.unshift(`Mẫu: ${t.name}`);
    return out;
  }

  async function uploadOwn(files: File[]) {
    setUploading(true);
    const saved = await uploadTemplates(files.slice(0, 1), 'single');
    setUploading(false);
    if (saved[0]) {
      setPickedTemplate(saved[0]);
      setSel({ templateId: saved[0].id });
      templates.refresh();
    }
  }

  const spend = status?.spend;
  const chatgpt = status?.chatgpt;
  const isChatgpt = model?.provider === 'chatgpt';

  return (
    <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 pt-4 flex flex-col gap-4">
      <StudioReadiness status={status} />

      <div data-studio-top class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(340px,440px)] gap-4 items-start">
        {/* ── Creative brief ── */}
        <section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4 flex flex-col gap-4 min-w-0" aria-labelledby="kol-creative">
          <div class="flex flex-wrap items-center gap-2">
            <h2 id="kol-creative" class="text-[14px] font-semibold">Sáng tạo của bạn</h2>
            <span class="inline-flex items-center h-6 px-2 rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent)] text-[11.5px] font-medium">{GENERATION_MODE_LABEL[mode]}</span>
            {!s.freeform && picks > 0 && <span class="text-[12px] text-[var(--color-text-muted)] tabular-nums">{picks} lựa chọn</span>}
            <div class="ml-auto flex items-center gap-3">
              {dirty && <button type="button" class={BTN_SM} onClick={reset} title="Bỏ mọi lựa chọn, ảnh mẫu và chỉ dẫn; giữ mô hình và định dạng"><RotateCcw size={12} class="mr-1" />Đặt lại</button>}
              <label class="inline-flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">
                Chỉ dùng prompt của tôi
                <Toggle size="sm" on={s.freeform} onChange={() => set({ freeform: !s.freeform })} ariaLabel="Chế độ prompt tự do" />
              </label>
            </div>
          </div>

          <Field
            label={s.freeform ? 'Prompt của bạn' : 'Chỉ dẫn thêm (tuỳ chọn)'}
            hint={s.freeform
              ? `Chỉ gắn ảnh khuôn mặt và prompt này; các lựa chọn bên dưới bị bỏ qua. ${modKeyLabel()}+Enter để tạo.`
              : `Khoảnh khắc, hành động, cảm xúc… bằng tiếng Việt hoặc tiếng Anh. ${modKeyLabel()}+Enter để tạo.`}
          >
            <textarea
              ref={directionRef}
              class={`${TEXTAREA} w-full`}
              rows={s.freeform ? 5 : 2}
              placeholder={s.freeform ? 'Cô ấy ngồi bên cửa sổ quán cà phê lúc mưa, cầm ly latte, ánh sáng xám dịu…' : 'Ví dụ: cười nhẹ nhìn ra cửa sổ, tay cầm ly cà phê'}
              value={s.extraPrompt}
              onInput={(e) => set({ extraPrompt: (e.target as HTMLTextAreaElement).value })}
            />
          </Field>

          <div class={`grid grid-cols-1 sm:grid-cols-2 gap-2 ${s.freeform ? 'opacity-50' : ''}`}>
            {SLOTS.map(({ kind, key }) => (kind === 'camera' ? (
              <SlotCard
                key={kind}
                kind={kind}
                disabled={s.freeform}
                item={cameraPicks[0] ?? null}
                choices={fitting(kind)}
                label={cameraPicks.map((i) => i.name).join(' · ')}
                onOpen={() => setPicker(kind)}
                onClear={() => setCamera([])}
              />
            ) : (
              <SlotCard
                key={kind}
                kind={kind}
                disabled={s.freeform}
                item={s.selection[key] ? itemById.get(s.selection[key]!) ?? null : null}
                choices={fitting(kind)}
                onOpen={() => setPicker(kind)}
                onClear={() => setSel({ [key]: undefined })}
              />
            )))}
          </div>
          {lib.error && <InlineError>{lib.error}</InlineError>}

          <div class={`flex flex-col gap-2 ${s.freeform ? 'opacity-50 pointer-events-none' : ''}`}>
            <div class="flex flex-wrap items-baseline gap-x-2">
              <h3 class="text-[13px] font-semibold">Ảnh để tái tạo</h3>
              <span class="text-[11.5px] text-[var(--color-text-muted)]">Lấy bố cục, dáng, ánh sáng; không lấy khuôn mặt.</span>
            </div>
            {template ? (
              <div class="flex items-center gap-3 rounded-lg border border-[var(--color-accent)] p-2">
                <span class="w-16 h-20 shrink-0 rounded-md overflow-hidden"><KolImg src={template.url} alt={template.name} class="w-full h-full" /></span>
                <div class="min-w-0 flex-1">
                  <div class="text-[13px] font-medium truncate">{template.name}</div>
                  {template.notes && <div class="text-[12px] text-[var(--color-text-muted)] line-clamp-2">{template.notes}</div>}
                </div>
                <div class="flex flex-col gap-1.5">
                  <button type="button" class={BTN_SM} onClick={() => setTemplatePicker(true)}>Đổi</button>
                  <button type="button" class={BTN_SM} onClick={() => setSel({ templateId: undefined })}><X size={12} class="mr-1" />Bỏ</button>
                </div>
              </div>
            ) : templateId ? (
              <div class="flex items-center gap-2 text-[12.5px] text-[var(--color-text-muted)]">
                Đang tải mẫu…<button type="button" class={BTN_SM} onClick={() => setSel({ templateId: undefined })}>Bỏ</button>
              </div>
            ) : (
              <>
                <div class="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 items-stretch">
                  <DropZone disabled={uploading} onFiles={(f) => { void uploadOwn(f); }}>
                    <span>{uploading ? 'Đang tải ảnh…' : 'Kéo thả ảnh của bạn hoặc bấm để chọn'}</span>
                  </DropZone>
                  <button type="button" class={`${BTN} h-auto min-h-9`} onClick={() => setTemplatePicker(true)}><LayoutTemplate size={14} />Chọn từ Mẫu tái tạo</button>
                </div>
                {recentTemplates.length > 0 && (
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="shrink-0 text-[11.5px] text-[var(--color-text-faint)]">Gần đây</span>
                    <ul class="flex gap-1.5 overflow-x-auto list-none m-0 p-0">
                      {recentTemplates.map((t) => (
                        <li key={t.id} class="shrink-0">
                          <button type="button" title={t.name} aria-label={`Dùng mẫu ${t.name}`} onClick={() => { setPickedTemplate(t); setSel({ templateId: t.id }); }}
                            class="block w-11 h-14 rounded-md overflow-hidden border border-[var(--color-border)] hover:border-[var(--color-accent)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]">
                            <KolImg src={t.url} alt="" class="w-full h-full" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        {/* ── Render settings ── */}
        <section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4 flex flex-col gap-4 min-w-0" aria-labelledby="kol-render">
          <h2 id="kol-render" class="text-[14px] font-semibold">Thiết lập ảnh</h2>
          <Field label="Mô hình" hint={model ? `${model.priceNote} · tối đa ${model.maxRefs} ảnh tham chiếu` : undefined}>
            <ModelSelect options={options} value={s.model} allowEmpty={false} compact onChange={(m) => set({ model: m })} label="Mô hình ảnh" />
          </Field>
          {status && options.length > 0 && !options.some((o) => o.configured) && (
            <p class="-mt-2 text-[12px] text-[var(--color-status-failed)]">Chưa có nhà cung cấp nào có API key.</p>
          )}

          <div class="flex flex-col gap-1.5 min-w-0">
            <div class="flex items-baseline justify-between gap-2 text-[12px] text-[var(--color-text-muted)]">
              <span>Tỷ lệ</span>
              <span class="text-[11.5px] text-[var(--color-text-faint)] truncate">{ASPECT_LABEL[s.aspect].split(' · ')[1] ?? ''}</span>
            </div>
            <AspectPicker aspects={aspects} value={s.aspect} labels={ASPECT_LABEL} onChange={(aspect) => set({ aspect })} />
            <p class={`text-[11.5px] ${isInstagramFeedAspect(s.aspect) ? 'text-[var(--color-text-faint)]' : 'text-[var(--color-priority-medium)]'}`}>
              {s.aspect === '4:5'
                ? '4:5 chiếm nhiều chỗ nhất trên feed Instagram.'
                : isInstagramFeedAspect(s.aspect)
                  ? 'Đăng được lên feed Instagram (4:5 đến 1.91:1).'
                  : 'Không vừa feed Instagram (cần 4:5 đến 1.91:1); hợp với Reels, TikTok, Shorts hoặc YouTube.'}
            </p>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2 gap-3">
            <div class="flex flex-col gap-1.5 text-[12px] text-[var(--color-text-muted)] min-w-0">
              Chất lượng
              <Segmented label="Chất lượng" fill value={s.quality} onChange={(quality) => set({ quality })} options={qualities.map((q) => ({ value: q, label: QUALITY_SHORT[q] }))} />
            </div>
            <div class="flex flex-col gap-1.5 text-[12px] text-[var(--color-text-muted)] min-w-0">
              Số ảnh
              <Segmented label="Số ảnh" fill value={String(s.count)} onChange={(v) => set({ count: Number(v) })} options={['1', '2', '3', '4'].map((v) => ({ value: v, label: v }))} />
            </div>
          </div>
          {isChatgpt && s.count > 1 && (
            <p class="-mt-2 text-[11.5px] text-[var(--color-text-faint)]">
              ChatGPT: {s.count} ảnh chạy song song (tối đa {parallel} cùng lúc), mỗi ảnh được chấm điểm khuôn mặt riêng.
            </p>
          )}

          <div class={`grid gap-3 ${supportsSeed(model) ? 'grid-cols-[minmax(0,1fr)_120px]' : 'grid-cols-1'}`}>
            <Field label="Độ chân thật">
              <select class={`${INPUT} w-full`} value={s.realism} onChange={(e) => set({ realism: (e.target as HTMLSelectElement).value as RealismPreset })}>
                {REALISM_PRESETS.map((r) => <option key={r} value={r}>{REALISM_LABEL[r]}{r === persona.realismPreset ? ' (mặc định của KOL)' : ''}</option>)}
              </select>
            </Field>
            {supportsSeed(model) && (
              <Field label="Seed">
                <input class={`${INPUT} w-full tabular-nums`} inputMode="numeric" placeholder="Ngẫu nhiên" title="Giữ cùng seed để ra kết quả gần giống khi chỉ đổi một chi tiết."
                  value={s.seed} onInput={(e) => set({ seed: (e.target as HTMLInputElement).value.replace(/[^\d]/g, '') })} />
              </Field>
            )}
          </div>

          <PromptPreviewPanel preview={pv.preview} loading={pv.loading} error={pv.error} override={s.promptOverride} onOverride={(promptOverride) => set({ promptOverride })} />
          {genError && <InlineError>{genError}</InlineError>}
        </section>
      </div>

      {/* ── Video Library & Campaigns ── */}
      {/* shrink-0: in this scrolling flex column an overflow-hidden section otherwise collapses to 0px. */}
      <section class="shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)]" aria-labelledby="kol-videos">
        <div class="p-4">
          <h2 id="kol-videos" class="text-[14px] font-semibold mb-3">Video chiến dịch</h2>
          <VideoGallery kolId={persona.id} />
        </div>
      </section>

      <GenerationStrip
        personaId={persona.id}
        kinds={['image']}
        title="Đang tạo & vừa xong"
        refreshKey={refreshKey}
        onRefAdded={refreshPersona}
        onAnimate={(a) => go('video', { asset: a.id })}
        onCreatePost={(a) => go('content', { compose: a.id })}
        onReuse={reuse}
        onRetry={retry}
        onSettled={() => invalidateFetchCache(KOL.status)}
        onList={setHistory}
        describe={describe}
        expectedSec={(g) => secondsPerImage(history, { id: g.model, provider: g.provider }) * Math.max(1, g.params.count ?? 1)}
        modelName={(id) => { const m = findModel(status, id)?.model; return m ? shortModel(m.label) : id; }}
      />
      <button type="button" class={`${BTN} self-start`} onClick={() => go('gallery')}><Images size={14} />Mở thư viện ảnh</button>

      {/* ── Dock: what one click makes ── */}
      <div class="sticky bottom-0 z-20 -mx-4 md:-mx-6 mt-auto border-t border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg)_90%,transparent)] backdrop-blur-md">
        <div class="px-4 md:px-6 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-2">
          <div class="min-w-0 flex-1 flex flex-col gap-0.5">
            <div class="text-[12.5px] text-[var(--color-text)] truncate">
              <b class="font-semibold">{GENERATION_MODE_LABEL[mode]}</b>
              <span class="text-[var(--color-text-muted)]">
                {' · '}{s.freeform ? 'prompt của bạn' : template ? `mẫu “${template.name}”` : picks ? `${picks} lựa chọn` : 'mặc định'}
                {' · '}{s.count} ảnh {s.aspect} · {QUALITY_SHORT[s.quality]}{model ? ` · ${shortModel(model.label)}` : ''}
              </span>
            </div>
            {blocker
              ? <div class="text-[11.5px] text-[var(--color-priority-medium)] truncate" role="status">{blocker}</div>
              : (
                <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-[var(--color-text-muted)]">
                  {isChatgpt && chatgpt && <Quota label="ChatGPT hôm nay" used={chatgpt.imagesToday} cap={chatgpt.dailyLimit} unit="ảnh" />}
                  {spend && <Quota label="Chi hôm nay" used={spend.todayUsd} cap={spend.dailyCapUsd} money />}
                  {status && status.queue.running + status.queue.queued > 0 && (
                    <span class="tabular-nums">Hàng đợi {status.queue.running} chạy · {status.queue.queued} chờ</span>
                  )}
                </div>
              )}
          </div>
          <div class="flex items-center gap-3 ml-auto">
            <div class="flex flex-col items-end leading-tight tabular-nums" aria-live="polite">
              <span class="text-[13px] font-semibold text-[var(--color-text)]">{estimate !== null ? fmtEstimate(estimate) : '–'}</span>
              {eta ? <span class="text-[11px] text-[var(--color-text-muted)]">{fmtEta(eta)}</span> : null}
            </div>
            <button
              type="button"
              disabled={!canRun}
              onClick={() => runRef.current()}
              title={`${modKeyLabel()}+Enter`}
              class="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg bg-[var(--color-accent)] text-[14px] font-semibold text-[var(--color-on-accent)] shadow-sm hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
            >
              <Wand2 size={17} />{busy ? 'Đang gửi…' : `Tạo ${s.count} ảnh`}
              <kbd class="hidden md:inline-flex items-center h-5 px-1.5 rounded bg-black/20 text-[10.5px] font-medium tracking-wide">{modKeyLabel()}↵</kbd>
            </button>
          </div>
        </div>
      </div>

      {picker === 'camera' && (
        <CameraPickerModal
          items={byKind.get('camera') ?? []}
          loading={lib.loading}
          value={selectionCameraIds(s.selection)}
          context="image"
          onApply={setCamera}
          onClose={() => setPicker(null)}
        />
      )}
      {picker && picker !== 'camera' && (
        <LibraryPickerModal
          kind={picker}
          items={byKind.get(picker) ?? []}
          gender={gender}
          persona={{ id: persona.id, name: persona.name }}
          onPreviewsChanged={lib.refresh}
          selectedId={s.selection[SLOTS.find((x) => x.kind === picker)!.key]}
          onPick={(id) => setSel({ [SLOTS.find((x) => x.kind === picker)!.key]: id })}
          onClose={() => setPicker(null)}
        />
      )}
      {templatePicker && (
        <TemplatePickerModal
          selectedId={templateId}
          onPick={(t) => { setPickedTemplate(t); setSel({ templateId: t.id }); }}
          onClose={() => setTemplatePicker(false)}
        />
      )}
    </div>
  );
}

/** "ChatGPT hôm nay 12/60 ảnh" with a hairline bar that turns amber at 80 %, red at 100 %. */
function Quota({ label, used, cap, unit, money }: { label: string; used: number; cap: number; unit?: string; money?: boolean }) {
  const pct = meterPercent(used, cap);
  const value = money ? `${fmtUsd(used)}${cap ? ` / ${fmtUsd(cap)}` : ''}` : `${used}${cap ? `/${cap}` : ''}${unit ? ` ${unit}` : ''}`;
  return (
    <span class="inline-flex items-center gap-1.5 tabular-nums" title={cap ? `${label}: ${value}` : `${label}: ${value} · không giới hạn`}>
      {label} <b class="font-medium text-[var(--color-text)]">{value}</b>
      {cap > 0 && (
        <span class="w-10 h-1 rounded-full bg-[var(--color-elevated)] overflow-hidden" aria-hidden="true">
          <span class="block h-full rounded-full" style={{ width: `${pct}%`, background: meterColor(pct) }} />
        </span>
      )}
    </span>
  );
}

