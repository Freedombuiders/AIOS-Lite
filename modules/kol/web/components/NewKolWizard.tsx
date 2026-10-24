// "Tạo KOL mới": 4-step wizard. Creates the persona, uploads the face photos
// (or queues a bootstrap generation), then opens the workspace Hồ sơ tab.

import { useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { Check, ImagePlus, Sparkles, Clock, X } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { BTN, BTN_PRIMARY, Field, INPUT, InlineError, TEXTAREA, apiFail } from '@modules/kol/web/components/shared/ops-shared';
import { AppearanceFields, ChipsField, IdentitySourceFields, PersonalityFields, PillarsEditor } from '@modules/kol/web/components/PersonaFields';
import { DropZone, FilePreview, useKolStatus } from '@modules/kol/web/components/ui';
import { invalidateFetchCache } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import {
  KOL, emptyAppearance, emptyPersonality, findModel, kolApi, pickModel, pillarShareTotal, suggestHandle,
  type Appearance, type IdentitySource, type Personality, type Pillar,
} from '@modules/kol/web/lib/kol';

type FaceMode = 'upload' | 'bootstrap' | 'later';

const STEPS = ['Thông tin', 'Ngoại hình', 'Tính cách & giọng', 'Khuôn mặt'];

interface Draft {
  name: string;
  handle: string;
  handleTouched: boolean;
  niche: string;
  tagline: string;
  languages: string[];
  audience: string;
  appearance: Appearance;
  identitySource: IdentitySource;
  consentNote: string;
  personality: Personality;
  pillars: Pillar[];
}

const val = (e: Event) => (e.target as HTMLInputElement).value;

export function NewKolWizard({ onClose }: { onClose: () => void }) {
  const [, navigate] = useLocation();
  const status = useKolStatus();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [face, setFace] = useState<FaceMode>('upload');
  const [files, setFiles] = useState<File[]>([]);
  const [d, setD] = useState<Draft>({
    name: '', handle: '', handleTouched: false, niche: '', tagline: '', languages: ['vi'], audience: '',
    appearance: emptyAppearance(), identitySource: 'synthetic', consentNote: '', personality: emptyPersonality(), pillars: [],
  });
  const set = (patch: Partial<Draft>) => setD((cur) => ({ ...cur, ...patch }));

  const imageModel = pickModel(status.data, 'image');
  const modelInfo = findModel(status.data, imageModel);

  function stepError(i: number): string | null {
    if (i === 0 && !d.name.trim()) return 'Đặt tên cho KOL trước.';
    if (i === 0 && d.handle.trim() && !/^@?[a-zA-Z0-9._]+$/.test(d.handle.trim())) return 'Handle chỉ gồm chữ, số, dấu chấm và gạch dưới (không dấu, không khoảng trắng).';
    if (i === 2 && pillarShareTotal(d.pillars) > 100) return 'Tổng tỉ lệ các trụ cột không được vượt 100%.';
    if (i === 1 && d.identitySource === 'licensed' && !d.consentNote.trim()) return 'Cần ghi chú đồng ý khi dùng khuôn mặt người thật.';
    if (i === 3 && face === 'upload' && files.length === 0) return 'Chọn ít nhất một ảnh khuôn mặt, hoặc chọn “Để sau”.';
    return null;
  }

  function next() {
    const err = stepError(step);
    setError(err);
    if (!err) setStep((s) => Math.min(STEPS.length - 1, s + 1));
  }

  async function create() {
    for (let i = 0; i < STEPS.length; i++) {
      const err = stepError(i);
      if (err) { setStep(i); setError(err); return; }
    }
    setBusy(true);
    setError(null);
    let personaId: string | null = null;
    try {
      const { persona } = await kolApi.createPersona({
        name: d.name.trim(),
        handle: d.handle.trim().replace(/^@/, '').toLowerCase(),
        niche: d.niche.trim(),
        tagline: d.tagline.trim(),
        languages: d.languages,
        audience: d.audience.trim(),
        appearance: d.appearance,
        identitySource: d.identitySource,
        consentNote: d.consentNote.trim(),
        personality: d.personality,
        pillars: d.pillars.filter((p) => p.name.trim()),
        status: 'draft',
      });
      personaId = persona.id;
    } catch (err) {
      setError(apiFail(err).message);
      setBusy(false);
      return;
    }

    // The persona exists from here on: problems below are warnings, the owner continues in Hồ sơ.
    if (face === 'upload') {
      let failed = 0;
      for (let i = 0; i < files.length; i++) {
        try {
          const { ref } = await kolApi.uploadRef(personaId, files[i], { kind: i === 0 ? 'anchor' : 'angle', label: i === 0 ? 'Chính diện' : `Góc ${i}` });
          if (i === 0 && !ref.isPrimary) await kolApi.updateRef(ref.id, { isPrimary: true });
        } catch (err) {
          failed++;
          pushToast({ tone: 'warn', title: `Không tải được ảnh “${files[i].name}”`, description: apiFail(err).message, ttlMs: 7000 });
        }
      }
      if (failed < files.length) pushToast({ tone: 'success', title: `Đã tạo ${d.name.trim()}`, description: `Đã thêm ${files.length - failed} ảnh khuôn mặt.` });
    } else if (face === 'bootstrap') {
      try {
        await kolApi.generate({ personaId, mode: 'bootstrap', params: { count: 4, ...(imageModel ? { model: imageModel } : {}) } });
        pushToast({ tone: 'success', title: `Đã tạo ${d.name.trim()}`, description: 'Đang tạo 4 khuôn mặt mẫu. Chọn khuôn mặt ưng ý ở tab Hồ sơ.' });
      } catch (err) {
        pushToast({ tone: 'warn', title: 'Đã tạo KOL nhưng chưa tạo được khuôn mặt', description: apiFail(err).message, ttlMs: 8000 });
      }
    } else {
      pushToast({ tone: 'success', title: `Đã tạo ${d.name.trim()}`, description: 'Thêm ảnh khuôn mặt ở tab Hồ sơ trước khi tạo ảnh.' });
    }
    invalidateFetchCache(KOL.personas);
    setBusy(false);
    onClose();
    navigate(`/m/kol/${encodeURIComponent(personaId)}?tab=profile`);
  }

  const last = step === STEPS.length - 1;

  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose(); }}
      closeDisabled={busy}
      title="Tạo KOL mới"
      dismissOnBackdrop={false}
      width={760}
      footer={
        <>
          <span class="text-[12px] text-[var(--color-text-muted)] tabular-nums">Bước {step + 1}/{STEPS.length}</span>
          <div class="ml-auto flex gap-2">
            {step > 0 && <button type="button" class={BTN} disabled={busy} onClick={() => { setError(null); setStep(step - 1); }}>Quay lại</button>}
            {last
              ? <button type="button" class={BTN_PRIMARY} disabled={busy} onClick={() => { void create(); }}>{busy ? 'Đang tạo…' : 'Tạo KOL'}</button>
              : <button type="button" class={BTN_PRIMARY} onClick={next}>Tiếp tục</button>}
          </div>
        </>
      }
    >
      <ol class="flex flex-wrap gap-x-4 gap-y-1.5 mb-4" aria-label="Các bước">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => { if (i < step || !stepError(step)) { setError(null); setStep(i); } }}
              aria-current={i === step ? 'step' : undefined}
              class={`inline-flex items-center gap-1.5 text-[12.5px] ${i === step ? 'text-[var(--color-text)] font-semibold' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}
            >
              <span class={`w-5 h-5 rounded-full inline-flex items-center justify-center text-[11px] tabular-nums ${
                i < step ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)]' : i === step ? 'border-2 border-[var(--color-accent)] text-[var(--color-accent)]' : 'border border-[var(--color-border-strong)]'
              }`}>{i < step ? <Check size={11} /> : i + 1}</span>
              {s}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Tên KOL *">
            <input
              class={`${INPUT} w-full`}
              placeholder="Linh Chi"
              value={d.name}
              onInput={(e) => { const name = val(e); set({ name, ...(d.handleTouched ? {} : { handle: suggestHandle(name) }) }); }}
            />
          </Field>
          <Field label="Tên người dùng (handle)" hint="Không cần @. Dùng chung cho mọi kênh nếu được.">
            <input class={`${INPUT} w-full`} placeholder="linhchi.daily" value={d.handle} onInput={(e) => set({ handle: val(e), handleTouched: true })} />
          </Field>
          <Field label="Lĩnh vực (niche)">
            <input class={`${INPUT} w-full`} placeholder="Thời trang tối giản, cà phê Đà Lạt" value={d.niche} onInput={(e) => set({ niche: val(e) })} />
          </Field>
          <Field label="Câu giới thiệu ngắn">
            <input class={`${INPUT} w-full`} placeholder="Mặc đẹp mỗi ngày mà không cần nhiều đồ" value={d.tagline} onInput={(e) => set({ tagline: val(e) })} />
          </Field>
          <ChipsField label="Ngôn ngữ đăng bài" hint="Mã ngôn ngữ: vi, en…" value={d.languages} onChange={(languages) => set({ languages })} />
          <Field label="Khán giả mục tiêu" class="sm:col-span-2">
            <textarea class={`${TEXTAREA} w-full`} rows={2} placeholder="Nữ 18–28, sinh viên và nhân viên văn phòng ở thành phố lớn, thích phối đồ giá vừa phải" value={d.audience} onInput={(e) => set({ audience: (e.target as HTMLTextAreaElement).value })} />
          </Field>
        </div>
      )}

      {step === 1 && (
        <div class="flex flex-col gap-4">
          <AppearanceFields value={d.appearance} onChange={(appearance) => set({ appearance })} />
          <div class="flex flex-col gap-1.5">
            <div class="text-[12.5px] font-semibold text-[var(--color-text)]">Bản quyền hình ảnh</div>
            <IdentitySourceFields source={d.identitySource} consentNote={d.consentNote} onChange={(p) => set(p)} />
          </div>
        </div>
      )}

      {step === 2 && (
        <div class="flex flex-col gap-4">
          <PersonalityFields value={d.personality} onChange={(personality) => set({ personality })} />
          <div class="flex flex-col gap-1.5">
            <div class="text-[12.5px] font-semibold text-[var(--color-text)]">Trụ cột nội dung</div>
            <PillarsEditor value={d.pillars} onChange={(pillars) => set({ pillars })} />
          </div>
        </div>
      )}

      {step === 3 && (
        <div class="flex flex-col gap-3">
          <p class="text-[12.5px] text-[var(--color-text-muted)] leading-relaxed">
            Khuôn mặt chính là ảnh tham chiếu được gắn vào mọi lần tạo ảnh. Ảnh tốt nhất: chính diện, sắc nét, ánh sáng đều, không đeo kính râm, không bị tóc che.
          </p>
          <div role="radiogroup" aria-label="Cách có khuôn mặt" class="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {([
              ['upload', ImagePlus, 'Tải ảnh có sẵn', 'Ảnh đầu tiên là khuôn mặt chính, các ảnh sau là góc mặt.'],
              ['bootstrap', Sparkles, 'Tạo khuôn mặt từ mô tả', `AI tạo 4 khuôn mặt từ phần Ngoại hình${modelInfo ? ` (${modelInfo.model.priceNote} mỗi ảnh)` : ''}. Bạn chọn 1 ở tab Hồ sơ.`],
              ['later', Clock, 'Để sau', 'Tạo KOL trước, thêm khuôn mặt sau ở tab Hồ sơ.'],
            ] as const).map(([mode, Icon, title, desc]) => (
              <label
                key={mode}
                class={`flex flex-col gap-1 rounded-md border px-3 py-2.5 cursor-pointer text-[13px] ${
                  face === mode ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-border)] hover:bg-[var(--color-control-hover)]'
                }`}
              >
                <span class="flex items-center gap-2 font-medium text-[var(--color-text)]">
                  <input type="radio" name="face-mode" class="accent-[var(--color-accent)]" checked={face === mode} onChange={() => { setError(null); setFace(mode); }} />
                  <Icon size={15} aria-hidden="true" />{title}
                </span>
                <span class="text-[12px] text-[var(--color-text-muted)]">{desc}</span>
              </label>
            ))}
          </div>

          {face === 'upload' && (
            <div class="flex flex-col gap-2">
              <DropZone multiple onFiles={(f) => setFiles((cur) => [...cur, ...f].slice(0, 8))}>
                <span>Kéo thả 1–8 ảnh khuôn mặt hoặc bấm để chọn (JPG, PNG, WebP; tối đa 25 MB/ảnh)</span>
              </DropZone>
              {files.length > 0 && (
                <ul class="flex flex-wrap gap-2 list-none m-0 p-0">
                  {files.map((f, i) => (
                    <li key={`${f.name}-${i}`} class="relative w-20">
                      <FilePreview file={f} />
                      <span class="block text-[11px] text-[var(--color-text-muted)] truncate mt-0.5">{i === 0 ? 'Chính diện' : `Góc ${i}`}</span>
                      <button
                        type="button"
                        aria-label={`Bỏ ${f.name}`}
                        class="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center"
                        onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
                      ><X size={12} /></button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {face === 'bootstrap' && !imageModel && status.data && (
            <InlineError>Chưa có mô hình ảnh nào có API key. KOL vẫn được tạo; thêm key ở Kết nối rồi tạo khuôn mặt ở tab Hồ sơ.</InlineError>
          )}
        </div>
      )}

      {error && <div class="mt-3"><InlineError>{error}</InlineError></div>}
    </Modal>
  );
}
