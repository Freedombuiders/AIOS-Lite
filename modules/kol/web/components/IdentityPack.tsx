// Hồ sơ › Bộ nhận diện: reference images that lock the face, plus AI helpers
// to create first face candidates (bootstrap) and a 360° character sheet.

import { useMemo, useState } from 'preact/hooks';
import { ArrowDown, ArrowUp, LayoutGrid, Sparkles, Star, Trash2, Upload } from 'lucide-preact';
import { ConfirmModal } from '@/components/ConfirmModal';
import { BTN, BTN_PRIMARY, BTN_SM, INPUT, InlineError } from '@modules/kol/web/components/shared/ops-shared';
import { usePreview, useGeneration, useGenerations } from '@modules/kol/web/components/hooks';
import { Lightbox } from '@modules/kol/web/components/Lightbox';
import { FormSection, KolImg, TonePill, UploadButton, toastError } from '@modules/kol/web/components/ui';
import { pushToast } from '@/lib/toasts';
import {
  GENERATION_MODE_LABEL, GENERATION_STATUS, REF_KINDS, REF_KIND_LABEL, fmtAgo, fmtEstimate, generateBlocker, hasAnchor,
  kolApi, moveRefPatches, pickModel, sortRefs,
  type AssetDto, type GenerationDto, type KolStatusDto, type PersonaDto, type RefDto, type RefKind,
} from '@modules/kol/web/lib/kol';

export function IdentityPack({ persona, status, onChanged }: { persona: PersonaDto; status: KolStatusDto | null; onChanged: () => void }) {
  const refs = useMemo(() => sortRefs(persona.refs), [persona.refs]);
  const anchor = hasAnchor(persona);
  const [uploadKind, setUploadKind] = useState<RefKind | ''>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<RefDto | null>(null);
  const gens = useGenerations(persona.id, 30);
  const model = pickModel(status, 'image', [persona.imageModel]);
  const effectiveUploadKind: RefKind = uploadKind || (anchor ? 'angle' : 'anchor');

  const bootstrapReq = useMemo(() => ({ personaId: persona.id, mode: 'bootstrap' as const, params: { count: 4, ...(model ? { model } : {}) } }), [persona.id, model]);
  const sheetReq = useMemo(() => ({ personaId: persona.id, mode: 'sheet' as const, params: { count: 1, aspect: '16:9' as const, ...(model ? { model } : {}) } }), [persona.id, model]);
  const bootPrev = usePreview(status ? bootstrapReq : null, 0);
  const sheetPrev = usePreview(status && anchor ? sheetReq : null, 0);

  const candidates = gens.generations.filter((g) => g.mode === 'bootstrap' || g.mode === 'sheet').slice(0, 3);

  async function upload(files: File[]) {
    setBusy('upload');
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      const kind: RefKind = i === 0 ? effectiveUploadKind : effectiveUploadKind === 'anchor' ? 'angle' : effectiveUploadKind;
      try {
        const { ref } = await kolApi.uploadRef(persona.id, files[i], { kind, label: '' });
        if (kind === 'anchor' && !anchor && i === 0 && !ref.isPrimary) await kolApi.updateRef(ref.id, { isPrimary: true });
        ok++;
      } catch (err) {
        toastError(`Không tải được “${files[i].name}”`, err);
      }
    }
    setBusy(null);
    if (ok) { pushToast({ tone: 'success', title: `Đã thêm ${ok} ảnh tham chiếu` }); onChanged(); }
  }

  async function patch(ref: RefDto, p: { kind?: RefKind; label?: string; isPrimary?: boolean }, msg?: string) {
    setBusy(ref.id);
    try {
      await kolApi.updateRef(ref.id, p);
      if (msg) pushToast({ tone: 'success', title: msg });
      onChanged();
    } catch (err) {
      toastError('Không lưu được ảnh tham chiếu', err);
    } finally {
      setBusy(null);
    }
  }

  async function move(ref: RefDto, dir: -1 | 1) {
    const patches = moveRefPatches(persona.refs, ref.id, dir);
    if (!patches.length) return;
    setBusy(ref.id);
    try {
      for (const p of patches) await kolApi.updateRef(p.id, { sort: p.sort });
      onChanged();
    } catch (err) {
      toastError('Không đổi được thứ tự', err);
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function remove(ref: RefDto) {
    setBusy(ref.id);
    try {
      await kolApi.deleteRef(ref.id);
      pushToast({ tone: 'success', title: 'Đã xoá ảnh tham chiếu' });
      onChanged();
    } catch (err) {
      toastError('Không xoá được', err);
    } finally {
      setBusy(null);
    }
  }

  async function start(mode: 'bootstrap' | 'sheet') {
    setBusy(mode);
    try {
      await kolApi.generate(mode === 'bootstrap' ? bootstrapReq : sheetReq);
      pushToast({ tone: 'success', title: mode === 'bootstrap' ? 'Đang tạo 4 khuôn mặt mẫu' : 'Đang tạo bảng nhân vật 360°', description: 'Kết quả hiện bên dưới khi xong (thường 20–60 giây).' });
      gens.refresh();
    } catch (err) {
      toastError('Không tạo được', err);
    } finally {
      setBusy(null);
    }
  }

  const blockBoot = generateBlocker({ status, persona, mode: 'bootstrap', model });
  const blockSheet = generateBlocker({ status, persona, mode: 'sheet', model });

  return (
    <FormSection
      title="Bộ nhận diện khuôn mặt"
      hint={<>
        Mọi lần tạo ảnh đều gắn các ảnh này (khuôn mặt chính trước, rồi bảng 360°, rồi các góc) để giữ một khuôn mặt.
        Tốt nhất: <b>1 ảnh chính diện sắc nét</b> + <b>1 bảng 360°</b> + <b>2–4 ảnh góc nghiêng</b>. Nhiều ảnh mờ hoặc khác nhau làm khuôn mặt bị “trôi”.
      </>}
    >
      <div class="flex flex-wrap items-center gap-2">
        <label class="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
          Tải lên dưới dạng
          <select class={`${INPUT} h-8`} value={effectiveUploadKind} onChange={(e) => setUploadKind((e.target as HTMLSelectElement).value as RefKind)}>
            {REF_KINDS.map((k) => <option key={k} value={k}>{REF_KIND_LABEL[k]}</option>)}
          </select>
        </label>
        <UploadButton class={BTN} multiple disabled={busy === 'upload'} onFiles={(f) => { void upload(f); }}>
          <Upload size={14} />{busy === 'upload' ? 'Đang tải…' : 'Tải ảnh lên'}
        </UploadButton>
        <span class="hidden sm:inline w-px h-6 bg-[var(--color-border)]" aria-hidden="true" />
        <button type="button" class={anchor ? BTN : BTN_PRIMARY} disabled={!!blockBoot || busy === 'bootstrap'} title={blockBoot ?? undefined} onClick={() => { void start('bootstrap'); }}>
          <Sparkles size={14} />Tạo khuôn mặt từ mô tả{bootPrev.preview ? ` · ${fmtEstimate(bootPrev.preview.estimateUsd)}` : ''}
        </button>
        <button type="button" class={BTN} disabled={!!blockSheet || busy === 'sheet'} title={blockSheet ?? undefined} onClick={() => { void start('sheet'); }}>
          <LayoutGrid size={14} />Tạo bảng nhân vật 360°{sheetPrev.preview ? ` · ${fmtEstimate(sheetPrev.preview.estimateUsd)}` : ''}
        </button>
      </div>
      {(blockBoot && status && status.enabled && status.killSwitches.generate) && <p class="text-[12px] text-[var(--color-text-muted)]">{blockBoot}</p>}

      {refs.length === 0 ? (
        <div class="rounded-md border border-dashed border-[var(--color-border-strong)] px-4 py-6 text-center text-[12.5px] text-[var(--color-text-muted)]">
          Chưa có ảnh nào. Tải 1 ảnh chính diện của KOL, hoặc bấm “Tạo khuôn mặt từ mô tả” để AI đề xuất 4 khuôn mặt từ phần Ngoại hình bên dưới.
        </div>
      ) : (
        <ul class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 list-none m-0 p-0">
          {refs.map((r, i) => (
            <li key={r.id} class={`rounded-lg border bg-[var(--color-card)] overflow-hidden flex flex-col min-w-0 ${r.isPrimary ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
              <span class="relative block aspect-square bg-[var(--color-elevated)]">
                <KolImg src={r.url} alt={r.label || REF_KIND_LABEL[r.kind]} class="w-full h-full" fit={r.kind === 'sheet' ? 'contain' : 'cover'} />
                <span class="absolute top-1 left-1 rounded bg-black/60 text-white text-[10.5px] px-1.5 py-0.5 tabular-nums">{i + 1}</span>
                <button
                  type="button"
                  aria-pressed={r.isPrimary}
                  aria-label={r.isPrimary ? 'Khuôn mặt chính' : 'Đặt làm khuôn mặt chính'}
                  title={r.isPrimary ? 'Khuôn mặt chính' : 'Đặt làm khuôn mặt chính'}
                  disabled={busy === r.id || r.isPrimary}
                  onClick={() => { void patch(r, { isPrimary: true, ...(r.kind === 'anchor' ? {} : { kind: 'anchor' as const }) }, 'Đã đặt làm khuôn mặt chính'); }}
                  class={`absolute top-1 right-1 w-8 h-8 rounded-full flex items-center justify-center ${r.isPrimary ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)]' : 'bg-black/55 text-white hover:bg-black/75'}`}
                ><Star size={14} fill={r.isPrimary ? 'currentColor' : 'none'} /></button>
              </span>
              <div class="p-2 flex flex-col gap-1.5 min-w-0">
                <select
                  class={`${INPUT} h-8 text-[12px] w-full`}
                  aria-label="Loại ảnh"
                  value={r.kind}
                  disabled={busy === r.id}
                  onChange={(e) => { void patch(r, { kind: (e.target as HTMLSelectElement).value as RefKind }); }}
                >
                  {REF_KINDS.map((k) => <option key={k} value={k}>{REF_KIND_LABEL[k]}</option>)}
                </select>
                <input
                  class={`${INPUT} h-8 text-[12px] w-full`}
                  aria-label="Nhãn"
                  placeholder="Nhãn (vd. nghiêng trái)"
                  defaultValue={r.label}
                  onBlur={(e) => { const v = (e.target as HTMLInputElement).value.trim(); if (v !== r.label) void patch(r, { label: v }); }}
                />
                <div class="flex items-center gap-1">
                  <button type="button" class={`${BTN_SM} px-1.5`} aria-label="Lên trước" disabled={i === 0 || busy === r.id} onClick={() => { void move(r, -1); }}><ArrowUp size={13} /></button>
                  <button type="button" class={`${BTN_SM} px-1.5`} aria-label="Xuống sau" disabled={i === refs.length - 1 || busy === r.id} onClick={() => { void move(r, 1); }}><ArrowDown size={13} /></button>
                  <button type="button" class={`${BTN_SM} px-1.5 ml-auto`} aria-label="Xoá ảnh" disabled={busy === r.id} onClick={() => setToDelete(r)}><Trash2 size={13} /></button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {candidates.length > 0 && (
        <div class="flex flex-col gap-3 pt-1">
          <h3 class="text-[13px] font-semibold text-[var(--color-text)]">Kết quả tạo gần đây</h3>
          {candidates.map((g) => <Candidates key={g.id} gen={g} persona={persona} onChanged={onChanged} />)}
        </div>
      )}
      {gens.error && <InlineError>{gens.error}</InlineError>}

      <ConfirmModal
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => { if (toDelete) void remove(toDelete); }}
        title="Xoá ảnh tham chiếu?"
        body={toDelete?.isPrimary ? 'Đây là khuôn mặt chính. Sau khi xoá, chọn khuôn mặt chính khác trước khi tạo ảnh.' : 'Ảnh này sẽ không còn được gắn vào các lần tạo sau.'}
        confirmLabel="Xoá"
        cancelLabel="Huỷ"
        destructive
      />
    </FormSection>
  );
}

/** One bootstrap/sheet generation: status while running, then pick buttons under each result. */
function Candidates({ gen, persona, onChanged }: { gen: GenerationDto; persona: PersonaDto; onChanged: () => void }) {
  const detail = useGeneration(gen.id);
  const g = detail.data?.generation ?? gen;
  const [assets, setAssets] = useState<AssetDto[] | null>(null);
  const list = assets ?? detail.data?.assets ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const used = new Set(persona.refs.map((r) => r.assetId).filter(Boolean));
  const st = GENERATION_STATUS[g.status];
  const isSheet = g.mode === 'sheet';

  async function useAs(a: AssetDto) {
    setBusy(a.id);
    try {
      const { ref } = await kolApi.refFromAsset(persona.id, a.id, isSheet ? 'sheet' : 'anchor');
      if (!isSheet && !ref.isPrimary) await kolApi.updateRef(ref.id, { isPrimary: true });
      pushToast({ tone: 'success', title: isSheet ? 'Đã thêm bảng 360° vào bộ nhận diện' : 'Đã đặt làm khuôn mặt chính' });
      onChanged();
    } catch (err) {
      toastError('Không thêm được', err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div class="rounded-md border border-[var(--color-border)] p-3 flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span class="font-medium">{GENERATION_MODE_LABEL[g.mode]}</span>
        <TonePill tone={st.tone}>{st.label}</TonePill>
        <span class="text-[var(--color-text-muted)]">{fmtAgo(g.createdAt)}</span>
      </div>
      {g.error && <p class="text-[12px] text-[var(--color-status-failed)]">{g.error}</p>}
      {(g.status === 'queued' || g.status === 'running') && (
        <div class={`grid ${isSheet ? 'grid-cols-1 max-w-[420px]' : 'grid-cols-2 sm:grid-cols-4'} gap-2`}>
          {Array.from({ length: isSheet ? 1 : Math.max(1, g.params.count ?? 4) }, (_, i) => (
            <span key={i} class={`${isSheet ? 'aspect-video' : 'aspect-square'} rounded-md bg-[var(--color-elevated)] animate-pulse`} />
          ))}
        </div>
      )}
      {list.length > 0 && (
        <ul class={`grid ${isSheet ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-2 sm:grid-cols-4'} gap-2 list-none m-0 p-0`}>
          {list.map((a, i) => (
            <li key={a.id} class="flex flex-col gap-1.5 min-w-0">
              <button type="button" class="block rounded-md overflow-hidden border border-[var(--color-border)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]" onClick={() => setOpen(i)} aria-label="Xem lớn">
                <KolImg src={a.thumbUrl ?? a.url} class={`w-full ${isSheet ? 'aspect-video' : 'aspect-square'}`} fit={isSheet ? 'contain' : 'cover'} />
              </button>
              {used.has(a.id)
                ? <span class="text-[12px] text-[var(--color-status-done)] text-center">Đã dùng</span>
                : <button type="button" class={BTN_SM} disabled={!!busy} onClick={() => { void useAs(a); }}>{busy === a.id ? '…' : isSheet ? 'Dùng làm bảng 360°' : 'Dùng làm khuôn mặt chính'}</button>}
            </li>
          ))}
        </ul>
      )}
      {open !== null && (
        <Lightbox
          assets={list}
          index={open}
          personaId={persona.id}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          onChanged={(a) => setAssets(list.map((x) => (x.id === a.id ? a : x)))}
          onDeleted={(id) => { setAssets(list.filter((x) => x.id !== id)); setOpen(null); }}
          onRefAdded={onChanged}
        />
      )}
    </div>
  );
}
