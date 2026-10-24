// Persona form groups shared by the new-KOL wizard and the Hồ sơ tab.

import { ArrowDown, ArrowUp, Plus, Scale, X } from 'lucide-preact';
import { BTN_SM, Field, INPUT, TEXTAREA } from '@modules/kol/web/components/shared/ops-shared';
import { Chips } from './shared/chips';
import { FieldGrid } from '@modules/kol/web/components/ui';
import {
  IDENTITY_SOURCE_LABEL, evenShares, newId, pillarShareTotal,
  type Appearance, type IdentitySource, type Personality, type Pillar,
} from '@modules/kol/web/lib/kol';

const val = (e: Event) => (e.target as HTMLInputElement | HTMLTextAreaElement).value;

/** Labelled chips editor (string[]). */
export function ChipsField({ label, hint, value, onChange, placeholder }: {
  label: string; hint?: string; value: string[]; onChange: (v: string[]) => void; placeholder?: string;
}) {
  return (
    <div class="flex flex-col gap-1.5 text-[12px] text-[var(--color-text-muted)] min-w-0">
      <span>{label}</span>
      <Chips label={label} value={value} onChange={onChange} placeholder={placeholder} />
      {hint && <span class="text-[11.5px] text-[var(--color-text-faint)]">{hint}</span>}
    </div>
  );
}

const APPEARANCE_FIELDS: { key: Exclude<keyof Appearance, 'styleKeywords'>; label: string; placeholder: string; long?: boolean }[] = [
  { key: 'gender', label: 'Giới tính', placeholder: 'female' },
  { key: 'ageRange', label: 'Độ tuổi', placeholder: 'early 20s (22–24)' },
  { key: 'ethnicity', label: 'Dân tộc / gốc', placeholder: 'Vietnamese, East Asian' },
  { key: 'face', label: 'Khuôn mặt', placeholder: 'oval face, soft jawline, small straight nose, full lips, high cheekbones', long: true },
  { key: 'eyes', label: 'Mắt', placeholder: 'almond-shaped dark brown eyes, double eyelids, thick natural brows' },
  { key: 'skin', label: 'Da', placeholder: 'fair skin with warm undertone, light natural freckles on the nose' },
  { key: 'hair', label: 'Tóc mặc định', placeholder: 'long straight black hair, middle part, chest length' },
  { key: 'body', label: 'Dáng người', placeholder: 'slim, 165 cm, petite frame' },
  { key: 'marks', label: 'Dấu hiệu luôn có', placeholder: 'small mole under the left eye, dimple on the right cheek', long: true },
  { key: 'signatureLook', label: 'Phong cách nhận diện', placeholder: 'round gold-rim glasses + small gold hoop earrings', long: true },
];

/** The written half of the identity lock. English gives the most faithful results. */
export function AppearanceFields({ value, onChange }: { value: Appearance; onChange: (v: Appearance) => void }) {
  const set = (patch: Partial<Appearance>) => onChange({ ...value, ...patch });
  return (
    <div class="flex flex-col gap-3">
      <p class="text-[12px] text-[var(--color-text-muted)] leading-relaxed">
        Mô tả này được gắn vào mọi lần tạo ảnh để khoá khuôn mặt. Viết bằng tiếng Anh, cụ thể và cố định (không viết “có thể”, “đôi khi”).
        Dấu hiệu như nốt ruồi, lúm đồng tiền giúp giữ nhận diện tốt hơn.
      </p>
      <FieldGrid>
        {APPEARANCE_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} class={f.long ? 'sm:col-span-2' : ''}>
            {f.long
              ? <textarea class={`${TEXTAREA} w-full`} rows={2} placeholder={f.placeholder} value={value[f.key]} onInput={(e) => set({ [f.key]: val(e) } as Partial<Appearance>)} />
              : <input class={`${INPUT} w-full`} placeholder={f.placeholder} value={value[f.key]} onInput={(e) => set({ [f.key]: val(e) } as Partial<Appearance>)} />}
          </Field>
        ))}
        <div class="sm:col-span-2">
          <ChipsField label="Từ khoá phong cách" placeholder="minimal, streetwear… Enter" value={value.styleKeywords} onChange={(styleKeywords) => set({ styleKeywords })} />
        </div>
      </FieldGrid>
    </div>
  );
}

export function PersonalityFields({ value, onChange }: { value: Personality; onChange: (v: Personality) => void }) {
  const set = (patch: Partial<Personality>) => onChange({ ...value, ...patch });
  return (
    <FieldGrid>
      <ChipsField label="Tính cách" placeholder="vui vẻ, tò mò… Enter" value={value.traits} onChange={(traits) => set({ traits })} />
      <ChipsField label="Giá trị theo đuổi" placeholder="sống xanh, tự tin… Enter" value={value.values} onChange={(values) => set({ values })} />
      <Field label="Giọng điệu" hint="Persona nói chuyện thế nào với người theo dõi.">
        <input class={`${INPUT} w-full`} placeholder="thân thiện, hài hước, nói như bạn thân" value={value.voiceTone} onInput={(e) => set({ voiceTone: val(e) })} />
      </Field>
      <Field label="Cách viết" hint="Độ dài câu, tiếng lóng, emoji, xưng hô.">
        <input class={`${INPUT} w-full`} placeholder="câu ngắn, xưng mình – bạn, 1–2 emoji mỗi bài" value={value.writingStyle} onInput={(e) => set({ writingStyle: val(e) })} />
      </Field>
      <Field label="Tiểu sử / câu chuyện" class="sm:col-span-2">
        <textarea class={`${TEXTAREA} w-full`} rows={3} placeholder="Cô gái 23 tuổi ở Đà Lạt, mê cà phê và ảnh phim, đang học làm gốm…" value={value.backstory} onInput={(e) => set({ backstory: val(e) })} />
      </Field>
      <ChipsField label="Câu cửa miệng" placeholder="Enter để thêm" value={value.catchphrases} onChange={(catchphrases) => set({ catchphrases })} />
      <div />
      <ChipsField label="Nên làm" placeholder="kể chuyện đời thường… Enter" value={value.do} onChange={(d) => set({ do: d })} />
      <ChipsField label="Không bao giờ" placeholder="nói về chính trị… Enter" value={value.dont} onChange={(dont) => set({ dont })} />
    </FieldGrid>
  );
}

/** Content pillars with a target share; warns when the total is not 100%. */
export function PillarsEditor({ value, onChange }: { value: Pillar[]; onChange: (v: Pillar[]) => void }) {
  const total = pillarShareTotal(value);
  const setAt = (i: number, patch: Partial<Pillar>) => onChange(value.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div class="flex flex-col gap-2 min-w-0">
      {value.length === 0 && (
        <p class="text-[12.5px] text-[var(--color-text-muted)]">
          Trụ cột là 3–5 chủ đề lớn persona hay nói tới (ví dụ: Phối đồ hằng ngày 40%, Cà phê & quán xinh 30%, Hậu trường 30%). Autopilot chia bài theo tỉ lệ này.
        </p>
      )}
      {value.map((p, i) => (
        <div key={p.id} class="rounded-md border border-[var(--color-border)] p-2.5 flex flex-col gap-2 min-w-0">
          <div class="flex flex-wrap items-center gap-2 min-w-0">
            <input class={`${INPUT} flex-1 min-w-[140px]`} aria-label={`Tên trụ cột ${i + 1}`} placeholder="Tên trụ cột" value={p.name} onInput={(e) => setAt(i, { name: val(e) })} />
            <label class="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
              <input
                type="number" min={0} max={100} class={`${INPUT} w-20`} aria-label={`Tỉ lệ trụ cột ${i + 1} (%)`}
                value={p.share}
                onInput={(e) => setAt(i, { share: Math.max(0, Math.min(100, Number(val(e)) || 0)) })}
              />%
            </label>
            <div class="flex items-center gap-1 ml-auto">
              <button type="button" class={`${BTN_SM} px-1.5`} aria-label="Lên" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={13} /></button>
              <button type="button" class={`${BTN_SM} px-1.5`} aria-label="Xuống" disabled={i === value.length - 1} onClick={() => move(i, 1)}><ArrowDown size={13} /></button>
              <button type="button" class={`${BTN_SM} px-1.5`} aria-label={`Xoá trụ cột ${p.name || i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}><X size={13} /></button>
            </div>
          </div>
          <input class={`${INPUT} w-full`} aria-label={`Mô tả trụ cột ${i + 1}`} placeholder="Nội dung gì, cho ai, giọng ra sao" value={p.description} onInput={(e) => setAt(i, { description: val(e) })} />
        </div>
      ))}
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class={BTN_SM} onClick={() => onChange([...value, { id: newId('pillar'), name: '', description: '', share: 0 }])}>
          <Plus size={12} class="mr-1" />Thêm trụ cột
        </button>
        {value.length > 1 && (
          <button type="button" class={BTN_SM} onClick={() => onChange(evenShares(value))}><Scale size={12} class="mr-1" />Chia đều</button>
        )}
        {value.length > 0 && (
          <span class={`text-[12px] tabular-nums ${total > 100 ? 'text-[var(--color-status-failed)]' : total === 100 ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-priority-medium)]'}`} role="status">
            Tổng {total}%{total > 100 ? ' · vượt 100%, giảm bớt' : total < 100 ? ` · còn ${100 - total}% chưa chia` : ''}
          </span>
        )}
      </div>
    </div>
  );
}

/** Synthetic vs licensed identity; licensed requires a consent note. */
export function IdentitySourceFields({ source, consentNote, onChange }: {
  source: IdentitySource; consentNote: string; onChange: (patch: { identitySource?: IdentitySource; consentNote?: string }) => void;
}) {
  const missing = source === 'licensed' && !consentNote.trim();
  return (
    <div class="flex flex-col gap-2.5">
      <div role="radiogroup" aria-label="Nguồn khuôn mặt" class="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {(['synthetic', 'licensed'] as IdentitySource[]).map((s) => (
          <label
            key={s}
            class={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 cursor-pointer text-[13px] ${
              source === s ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-border)] hover:bg-[var(--color-control-hover)]'
            }`}
          >
            <input type="radio" name="identity-source" class="mt-0.5 accent-[var(--color-accent)]" checked={source === s} onChange={() => onChange({ identitySource: s })} />
            <span class="min-w-0">
              <span class="block font-medium text-[var(--color-text)]">{IDENTITY_SOURCE_LABEL[s]}</span>
              <span class="block text-[12px] text-[var(--color-text-muted)]">
                {s === 'synthetic' ? 'Khuôn mặt không thuộc về người thật nào. Khuyên dùng.' : 'Dựa trên một người thật đã đồng ý bằng văn bản.'}
              </span>
            </span>
          </label>
        ))}
      </div>
      {source === 'licensed' && (
        <Field label="Ghi chú đồng ý (bắt buộc)" hint="Người đó là ai, đồng ý ngày nào, văn bản lưu ở đâu.">
          <textarea
            class={`${TEXTAREA} w-full`}
            rows={2}
            aria-invalid={missing}
            placeholder="Nguyễn Văn A, đồng ý bằng hợp đồng ký 01/10/2026, bản scan ở Drive › Hợp đồng › KOL"
            value={consentNote}
            onInput={(e) => onChange({ consentNote: val(e) })}
          />
        </Field>
      )}
      {missing && <p class="text-[12px] text-[var(--color-status-failed)]" role="alert">Cần ghi chú đồng ý khi dùng khuôn mặt người thật.</p>}
    </div>
  );
}
