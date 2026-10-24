/** /kol/:id?tab=profile — the full persona form plus the identity pack. Saved with PATCH. */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { Toggle } from '@/components/Toggle';
import { BTN, BTN_PRIMARY, Field, INPUT, InlineError, TEXTAREA, apiFail } from '@modules/kol/web/components/shared/ops-shared';
import { IdentityPack } from '@modules/kol/web/components/IdentityPack';
import { AppearanceFields, ChipsField, IdentitySourceFields, PersonalityFields, PillarsEditor } from '@modules/kol/web/components/PersonaFields';
import { FieldGrid, FormSection, ModelSelect } from '@modules/kol/web/components/ui';
import { useFetch } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import {
  PERSONA_STATUS, PLATFORMS, PLATFORM_META, REALISM_LABEL, REALISM_PRESETS, hasAnchor, kolApi, modelOptions, pillarShareTotal,
  type PersonaDto, type PersonaInput, type PersonaStatus, type RealismPreset,
} from '@modules/kol/web/lib/kol';
import type { WorkspaceTabProps } from './workspace-types';

type Draft = Omit<PersonaDto, 'id' | 'refs' | 'createdAt' | 'updatedAt'>;

function toDraft(p: PersonaDto): Draft {
  const { id: _id, refs: _refs, createdAt: _c, updatedAt: _u, ...rest } = p;
  return JSON.parse(JSON.stringify(rest)) as Draft;
}

const SECTIONS = [
  ['kol-identity', 'Danh tính'],
  ['kol-face', 'Khuôn mặt'],
  ['kol-appearance', 'Ngoại hình'],
  ['kol-personality', 'Tính cách'],
  ['kol-pillars', 'Trụ cột'],
  ['kol-voice', 'Giọng nói'],
  ['kol-disclosure', 'Công bố AI'],
  ['kol-rights', 'Bản quyền'],
  ['kol-models', 'Mô hình'],
  ['kol-budget', 'Ngân sách'],
  ['kol-autopilot', 'Autopilot'],
] as const;

const DISCLOSURE_SUGGESTIONS = [
  'Nhân vật ảo được tạo bằng AI.',
  '#AI · Hình ảnh do AI tạo, nhân vật không có thật.',
  'Virtual influencer · AI-generated.',
];

export function KolProfileTab({ persona, status, refreshPersona }: WorkspaceTabProps) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(persona));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agents = useFetch<{ agents: { id: string; name?: string }[] }>('/api/agents');
  const base = useMemo(() => JSON.stringify(toDraft(persona)), [persona]);
  const dirty = JSON.stringify(draft) !== base;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // A refresh from elsewhere (refs, status button) replaces the form only when nothing is being edited.
  useEffect(() => { if (!dirtyRef.current) setDraft(toDraft(persona)); }, [base]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setAuto = (patch: Partial<Draft['autopilot']>) => setDraft((d) => ({ ...d, autopilot: { ...d.autopilot, ...patch } }));
  const val = (e: Event) => (e.target as HTMLInputElement).value;
  const t = draft.consistencyThreshold;

  function validate(): string | null {
    if (!draft.name.trim()) return 'Tên KOL không được trống.';
    if (draft.identitySource === 'licensed' && !draft.consentNote.trim()) return 'Cần ghi chú đồng ý khi dùng khuôn mặt người thật (mục Bản quyền hình ảnh).';
    if (draft.status === 'active' && !draft.disclosureText.trim()) return 'KOL đang hoạt động phải có dòng công bố AI (mục Công bố AI).';
    if (draft.status === 'active' && !hasAnchor(persona)) return 'KOL đang hoạt động phải có ít nhất một ảnh khuôn mặt chính (mục Khuôn mặt).';
    if (pillarShareTotal(draft.pillars) > 100) return 'Tổng tỉ lệ các trụ cột không được vượt 100%.';
    if (draft.handle.trim() && !/^@?[a-zA-Z0-9._]+$/.test(draft.handle.trim())) return 'Handle chỉ gồm chữ, số, dấu chấm và gạch dưới (không dấu, không khoảng trắng).';
    return null;
  }

  async function save() {
    const v = validate();
    setError(v);
    if (v) return;
    setSaving(true);
    try {
      const input: PersonaInput = { ...draft, name: draft.name.trim(), handle: draft.handle.trim().replace(/^@/, '').toLowerCase(), pillars: draft.pillars.filter((p) => p.name.trim()) };
      const { persona: saved } = await kolApi.updatePersona(persona.id, input);
      setDraft(toDraft(saved));
      dirtyRef.current = false;
      refreshPersona();
      pushToast({ tone: 'success', title: 'Đã lưu hồ sơ' });
    } catch (err) {
      setError(apiFail(err).message);
    } finally {
      setSaving(false);
    }
  }

  const imageModels = useMemo(() => modelOptions(status, 'image'), [status]);
  const videoModels = useMemo(() => modelOptions(status, 'video'), [status]);

  return (
    <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4">
      <div class="flex flex-col gap-4">
        <nav aria-label="Các mục hồ sơ" class="flex gap-1.5 overflow-x-auto pb-1 -mb-1">
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
              class="shrink-0 h-7 px-2.5 inline-flex items-center rounded-full border border-[var(--color-border)] text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)]">{label}</a>
          ))}
        </nav>

        <div id="kol-identity" class="scroll-mt-4">
          <FormSection title="Danh tính">
            <FieldGrid>
              <Field label="Tên KOL *"><input class={`${INPUT} w-full`} value={draft.name} onInput={(e) => set({ name: val(e) })} /></Field>
              <Field label="Handle" hint="Chữ thường không dấu, số, dấu chấm, gạch dưới."><input class={`${INPUT} w-full`} placeholder="linhchi.daily" value={draft.handle} onInput={(e) => set({ handle: val(e) })} /></Field>
              <Field label="Lĩnh vực (niche)"><input class={`${INPUT} w-full`} value={draft.niche} onInput={(e) => set({ niche: val(e) })} /></Field>
              <Field label="Câu giới thiệu ngắn"><input class={`${INPUT} w-full`} value={draft.tagline} onInput={(e) => set({ tagline: val(e) })} /></Field>
              <Field label="Trạng thái" hint="“Đang hoạt động” cần dòng công bố AI và khuôn mặt chính.">
                <select class={`${INPUT} w-full`} value={draft.status} onChange={(e) => set({ status: (e.target as HTMLSelectElement).value as PersonaStatus })}>
                  {(Object.keys(PERSONA_STATUS) as PersonaStatus[]).map((s) => <option key={s} value={s}>{PERSONA_STATUS[s].label}</option>)}
                </select>
              </Field>
              <ChipsField label="Ngôn ngữ đăng bài" hint="vi, en…" value={draft.languages} onChange={(languages) => set({ languages })} />
              <Field label="Bio (hiển thị trên kênh)" class="sm:col-span-2">
                <textarea class={`${TEXTAREA} w-full`} rows={2} value={draft.bio} onInput={(e) => set({ bio: val(e) })} />
              </Field>
              <Field label="Khán giả mục tiêu" class="sm:col-span-2">
                <textarea class={`${TEXTAREA} w-full`} rows={2} value={draft.audience} onInput={(e) => set({ audience: val(e) })} />
              </Field>
            </FieldGrid>
          </FormSection>
        </div>

        <div id="kol-face" class="scroll-mt-4"><IdentityPack persona={persona} status={status} onChanged={refreshPersona} /></div>

        <div id="kol-appearance" class="scroll-mt-4">
          <FormSection title="Ngoại hình"><AppearanceFields value={draft.appearance} onChange={(appearance) => set({ appearance })} /></FormSection>
        </div>

        <div id="kol-personality" class="scroll-mt-4">
          <FormSection title="Tính cách & giọng văn" hint="Dùng khi AI viết caption, trả lời bình luận và lập kế hoạch nội dung.">
            <PersonalityFields value={draft.personality} onChange={(personality) => set({ personality })} />
            <Field label="Agent viết nội dung" hint="Viết caption, phân tích tuần và lập kế hoạch autopilot. “ChatGPT (Codex)” chạy bằng gói ChatGPT đã đăng nhập (`codex login`), không cần tạo agent riêng.">
              <select class={`${INPUT} w-full sm:w-80`} value={draft.brainAgent} onChange={(e) => set({ brainAgent: (e.target as HTMLSelectElement).value })}>
                <option value="">Mặc định (agent main)</option>
                <option value="@chatgpt">ChatGPT (Codex) · gói ChatGPT</option>
                {draft.brainAgent && draft.brainAgent !== '@chatgpt' && !(agents.data?.agents ?? []).some((a) => a.id === draft.brainAgent) && <option value={draft.brainAgent}>{draft.brainAgent}</option>}
                {(agents.data?.agents ?? []).map((a) => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
              </select>
            </Field>
          </FormSection>
        </div>

        <div id="kol-pillars" class="scroll-mt-4">
          <FormSection title="Trụ cột nội dung"><PillarsEditor value={draft.pillars} onChange={(pillars) => set({ pillars })} /></FormSection>
        </div>

        <div id="kol-voice" class="scroll-mt-4">
          <FormSection title="Giọng nói" hint="Dùng cho video nói chuyện (ElevenLabs).">
            <Field label="ElevenLabs voice ID" hint={status && !status.voice.configured ? 'Chưa có ElevenLabs API key: thêm ở Kết nối.' : 'Lấy ID ở ElevenLabs › Voices › ID.'}>
              <input class={`${INPUT} w-full sm:w-96 font-mono`} placeholder="21m00Tcm4TlvDq8ikWAM" value={draft.voiceId} onInput={(e) => set({ voiceId: val(e).trim() })} />
            </Field>
            {status && !status.voice.configured && <Link href="/connections" class="text-[12px] text-[var(--color-accent)] underline self-start">Mở Kết nối</Link>}
          </FormSection>
        </div>

        <div id="kol-disclosure" class="scroll-mt-4">
          <FormSection title="Công bố AI" hint="Tự động thêm vào cuối mọi caption khi đăng. Bắt buộc trước khi KOL hoạt động; TikTok còn được gắn nhãn nội dung AI.">
            <textarea class={`${TEXTAREA} w-full`} rows={2} aria-label="Dòng công bố AI" aria-invalid={draft.status === 'active' && !draft.disclosureText.trim()} value={draft.disclosureText} onInput={(e) => set({ disclosureText: val(e) })} />
            <div class="flex flex-wrap gap-1.5">
              {DISCLOSURE_SUGGESTIONS.map((s) => (
                <button key={s} type="button" class="h-7 px-2.5 rounded-full border border-[var(--color-border)] text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)]" onClick={() => set({ disclosureText: s })}>{s}</button>
              ))}
            </div>
          </FormSection>
        </div>

        <div id="kol-rights" class="scroll-mt-4">
          <FormSection title="Bản quyền hình ảnh">
            <IdentitySourceFields source={draft.identitySource} consentNote={draft.consentNote} onChange={(p) => set(p)} />
          </FormSection>
        </div>

        <div id="kol-models" class="scroll-mt-4">
          <FormSection title="Mô hình & chất lượng">
            <FieldGrid>
              <Field label="Mô hình ảnh"><ModelSelect options={imageModels} value={draft.imageModel} onChange={(imageModel) => set({ imageModel })} /></Field>
              <Field label="Mô hình video"><ModelSelect options={videoModels} value={draft.videoModel} onChange={(videoModel) => set({ videoModel })} /></Field>
              <Field label="Độ chân thật mặc định">
                <select class={`${INPUT} w-full`} value={draft.realismPreset} onChange={(e) => set({ realismPreset: (e.target as HTMLSelectElement).value as RealismPreset })}>
                  {REALISM_PRESETS.map((r) => <option key={r} value={r}>{REALISM_LABEL[r]}</option>)}
                </select>
              </Field>
              <div class="flex flex-col gap-1.5 text-[12px] text-[var(--color-text-muted)]">
                <label for="kol-threshold" class="flex justify-between"><span>Ngưỡng giống khuôn mặt</span><b class="tabular-nums text-[var(--color-text)]">{t}</b></label>
                <input id="kol-threshold" type="range" min={50} max={100} step={1} value={t} class="w-full accent-[var(--color-accent)]" onInput={(e) => set({ consistencyThreshold: Number(val(e)) })} />
                <span class="text-[11.5px] text-[var(--color-text-faint)]">
                  <span style={{ color: 'var(--color-status-done)' }}>≥ {t} giống</span> · <span style={{ color: 'var(--color-priority-medium)' }}>{Math.max(0, t - 15)}–{Math.max(0, t - 1)} hơi lệch</span> · <span style={{ color: 'var(--color-status-failed)' }}>&lt; {Math.max(0, t - 15)} lệch</span>
                </span>
              </div>
            </FieldGrid>
            <ToggleRow label="Tự loại ảnh lệch khuôn mặt" desc="Ảnh bị chấm “lệch” chuyển thẳng sang Đã loại." on={draft.autoRejectDrift} onChange={() => set({ autoRejectDrift: !draft.autoRejectDrift })} />
          </FormSection>
        </div>

        <div id="kol-budget" class="scroll-mt-4">
          <FormSection title="Ngân sách" hint="Hạn mức riêng của KOL này mỗi tháng. Để trống thì chỉ áp hạn mức chung của studio.">
            <Field label="Hạn mức tháng (USD)">
              <input
                type="number" min={0} step="1" class={`${INPUT} w-40`} placeholder="Không giới hạn riêng"
                value={draft.monthlyCapUsd ?? ''}
                onInput={(e) => { const s = val(e); set({ monthlyCapUsd: s === '' ? null : Math.max(0, Number(s)) }); }}
              />
            </Field>
          </FormSection>
        </div>

        <div id="kol-autopilot" class="scroll-mt-4">
          <FormSection
            title="Autopilot"
            hint="Mỗi ngày lập kế hoạch để luôn có bài cho vài ngày tới. Bài autopilot dừng ở “Chờ duyệt” trừ khi bạn tắt duyệt."
            aside={<Toggle on={draft.autopilot.enabled} onChange={() => setAuto({ enabled: !draft.autopilot.enabled })} ariaLabel="Bật autopilot" />}
          >
            <div class={draft.autopilot.enabled ? 'flex flex-col gap-3' : 'flex flex-col gap-3 opacity-60'}>
              <div>
                <div class="text-[12px] text-[var(--color-text-muted)] mb-1.5">Số bài mỗi tuần theo kênh</div>
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {PLATFORMS.map((pl) => (
                    <label key={pl} class="flex items-center gap-2 text-[12.5px]">
                      <span class="w-20 truncate">{PLATFORM_META[pl].name}</span>
                      <input
                        type="number" min={0} max={28} class={`${INPUT} w-16`} aria-label={`Bài mỗi tuần trên ${PLATFORM_META[pl].name}`}
                        value={draft.autopilot.postsPerWeek[pl] ?? 0}
                        onInput={(e) => setAuto({ postsPerWeek: { ...draft.autopilot.postsPerWeek, [pl]: Math.max(0, Math.min(28, Math.round(Number(val(e)) || 0))) } })}
                      />
                    </label>
                  ))}
                </div>
              </div>
              <FieldGrid cols={3}>
                <Field label="Lên kế hoạch trước (ngày)">
                  <input type="number" min={1} max={14} class={`${INPUT} w-full`} value={draft.autopilot.leadDays} onInput={(e) => setAuto({ leadDays: Math.max(1, Math.min(14, Number(val(e)) || 1)) })} />
                </Field>
                <Field label="Ảnh tạo cho mỗi bài" hint="Chọn ảnh giống khuôn mặt nhất.">
                  <select class={`${INPUT} w-full`} value={draft.autopilot.imagesPerPost} onChange={(e) => setAuto({ imagesPerPost: Number((e.target as HTMLSelectElement).value) })}>
                    {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </Field>
                <Field label="Ngân sách autopilot / tuần (USD)">
                  <input type="number" min={0} step="0.5" class={`${INPUT} w-full`} value={draft.autopilot.weeklyBudgetUsd} onInput={(e) => setAuto({ weeklyBudgetUsd: Math.max(0, Number(val(e)) || 0) })} />
                </Field>
              </FieldGrid>
              <ToggleRow label="Tự tạo ảnh cho bài đã lên kế hoạch" desc="Tốn tiền, trong giới hạn ngân sách tuần ở trên." on={draft.autopilot.generateMedia} onChange={() => setAuto({ generateMedia: !draft.autopilot.generateMedia })} />
              <ToggleRow label="Cần tôi duyệt trước khi đăng" desc="Khuyên bật. Khi tắt, bài autopilot lên lịch luôn." on={draft.autopilot.requireApproval} onChange={() => setAuto({ requireApproval: !draft.autopilot.requireApproval })} />
            </div>
          </FormSection>
        </div>

        {error && <InlineError>{error}</InlineError>}
        <div class="sticky bottom-0 z-[1] flex flex-wrap items-center gap-2 py-3 bg-[var(--color-bg)] border-t border-[var(--color-border)]">
          <button type="button" class={BTN_PRIMARY} disabled={!dirty || saving} onClick={() => { void save(); }}>{saving ? 'Đang lưu…' : 'Lưu hồ sơ'}</button>
          <button type="button" class={BTN} disabled={!dirty || saving} onClick={() => { setDraft(toDraft(persona)); setError(null); }}>Hoàn tác</button>
          <span class="text-[12px] text-[var(--color-text-muted)]">{dirty ? 'Có thay đổi chưa lưu' : 'Đã lưu'}</span>
        </div>
      </div>
    </div>
  );
}

function ToggleRow({ label, desc, on, onChange }: { label: string; desc?: string; on: boolean; onChange: () => void }) {
  return (
    <div class="flex items-start gap-3">
      <div class="flex-1 min-w-0">
        <div class="text-[13px] text-[var(--color-text)]">{label}</div>
        {desc && <div class="text-[12px] text-[var(--color-text-muted)]">{desc}</div>}
      </div>
      <Toggle on={on} onChange={onChange} ariaLabel={label} />
    </div>
  );
}
