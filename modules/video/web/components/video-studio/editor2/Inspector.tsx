// Editor v2 inspector: the selected element's form, generated from the template's ComponentDef.props (markup
// title with its word/line count, text, list, number, colour), then entrance preset, sound with Nghe thử and
// volume, and size. Every change is an owner override (state.editElement → PUT /overrides after 400 ms).
// The tools without an element show the captions, the music or the template instead.
import { useEffect, useState } from 'preact/hooks';
import { Eye, EyeOff, Image, Lock, Music, Play } from 'lucide-preact';
import {
  animationOptions, animPatch, clockVi, componentDef, effectiveAnim, effectiveSound, fieldPatch, inspectorFields,
  KIND_COUNT, KIND_LABEL, markupCheck, musicDuckPatch, musicPickPatch, musicState, presetSoundId, scalePatch,
  secondsVi, soundAssetId, soundPatch, wordCount, type EditorElement, type FieldSpec, type TemplateManifest,
} from '@modules/video/web/lib/video-edit/editor2';
import { playerTime } from '@modules/video/web/lib/video-edit/editor';
import type { CaptionChunk } from '@modules/video/web/lib/video-edit/plan-geometry';
import type { BrollItem, EditPlan, ElementSound } from '@modules/video/web/lib/video-edit/types';
import {
  bgmAssets, editElement, editMusic, libraryPanel, overridesDoc, playSound, resetElement, resetMusic, sfxAssets,
  template, tool, type ToolId,
} from './state';

const TOOL_TITLE: Record<ToolId, string> = {
  text: 'Chữ', caption: 'Phụ đề', scene: 'Minh hoạ', broll: 'Cảnh trám', graphic: 'Đồ hoạ', sound: 'Âm thanh', zoom: 'Zoom', template: 'Mẫu',
};
const EMPTY_KIND: Partial<Record<ToolId, string>> = {
  text: 'chữ', scene: 'cảnh minh hoạ', broll: 'cảnh trám', graphic: 'đồ hoạ', zoom: 'zoom',
};

function OwnedNote({ onReset, text = 'Bạn đã sửa tay phần này. Khi nhờ AI sửa lại, AI không ghi đè.' }: { onReset: () => void; text?: string }) {
  return <div class="vs-dn-insp-note">
    <Lock size={16} aria-hidden="true" />
    <div>
      <span>{text}</span>
      <button type="button" class="vs-dn-linkbtn" onClick={onReset}>Trả về như AI dựng</button>
    </div>
  </div>;
}

/** Longest text PUT /overrides takes for the field. */
const maxLength = (f: FieldSpec) => (f.target === 'props' ? 500 : f.key === 'kicker' ? 80 : 200);

/** Field label: the prop label, plus the template font for a beat's title and sub. */
function fieldLabel(item: EditorElement, f: FieldSpec, tpl: TemplateManifest | null): string {
  if (item.kind !== 'beat' || !tpl) return f.def.label;
  if (f.key === 'title') return `${f.def.label} · ${tpl.tokens.fonts.title}`;
  if (f.key === 'sub') return `${f.def.label} · ${tpl.tokens.fonts.sub}`;
  return f.def.label;
}

function MarkupField({ id, label, field, onChange }: { id: string; label: string; field: FieldSpec; onChange: (v: string) => void }) {
  const value = String(field.value ?? '');
  const min = field.key === 'title' && field.def.required ? 2 : 1;
  const check = markupCheck(value, { minWords: min, maxWords: field.def.maxWords, maxLines: field.def.maxLines });
  const rule = field.def.maxWords !== undefined
    ? ` · ${min}–${field.def.maxWords} từ${field.def.maxLines ? `, tối đa ${field.def.maxLines} dòng` : ''}`
    : '';
  return <div class="vs-dn-insp-field">
    <label for={id} class="vs-dn-insp-label">{label}</label>
    <textarea id={id} class="vs-dn-insp-input is-markup" rows={2} value={value} maxLength={maxLength(field)} aria-describedby={`${id}-hint ${id}-count`}
      onInput={(e) => onChange(e.currentTarget.value)} />
    <span id={`${id}-hint`} class="vs-dn-insp-hint">Bọc *từ* để tô nổi bật · dùng | để xuống dòng{rule}</span>
    <span id={`${id}-count`} class={`vs-dn-insp-count${check.ok ? ' is-ok' : ' is-warn'}`} aria-live="polite">{check.label}</span>
  </div>;
}

function ListField({ id, label, field, onChange }: { id: string; label: string; field: FieldSpec; onChange: (v: string[]) => void }) {
  // Raw text kept here so an empty line being typed is not swallowed; the override gets the non-empty lines.
  const joined = Array.isArray(field.value) ? field.value.join('\n') : String(field.value ?? '');
  const [raw, setRaw] = useState(joined);
  const items = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  // Back to the AI's list ("Trả về như AI dựng", a new plan): follow it unless it is what is being typed.
  useEffect(() => { if (items.join('\n') !== joined) setRaw(joined); }, [joined]);
  const max = field.def.maxItems;
  return <div class="vs-dn-insp-field">
    <label for={id} class="vs-dn-insp-label">{label}</label>
    <textarea id={id} class="vs-dn-insp-input" rows={Math.max(3, Math.min(6, items.length + 1))} value={raw}
      onInput={(e) => { const v = e.currentTarget.value; setRaw(v); onChange(v.split('\n').map((l) => l.trim()).filter(Boolean)); }} />
    <span class={`vs-dn-insp-hint${max !== undefined && items.length > max ? ' is-warn' : ''}`}>
      Mỗi dòng một mục · {items.length} mục{max !== undefined ? `, tối đa ${max}` : ''}
    </span>
  </div>;
}

function Field({ item, field, tpl }: { item: EditorElement; field: FieldSpec; tpl: TemplateManifest | null }) {
  const id = `vs-dn-f-${item.id}-${field.key}`;
  const label = fieldLabel(item, field, tpl);
  const change = (v: string | number | string[]) => editElement(item.id, fieldPatch(field, v));
  const { type, maxWords } = field.def;
  if (type === 'markup') return <MarkupField id={id} label={label} field={field} onChange={change} />;
  if (type === 'list') return <ListField id={id} label={label} field={field} onChange={change} />;
  if (type === 'asset') {
    return <div class="vs-dn-insp-field">
      <span class="vs-dn-insp-label">{label}</span>
      <span class="vs-dn-insp-hint">Đổi ảnh ở đây có ở bản sau. Muốn đổi ngay, bấm Nhờ AI sửa.</span>
    </div>;
  }
  if (type === 'number') {
    return <label class="vs-dn-insp-field">
      <span class="vs-dn-insp-label">{label}</span>
      <input id={id} class="vs-dn-insp-input" type="number" value={field.value === undefined ? '' : String(field.value)}
        onInput={(e) => { const n = Number(e.currentTarget.value); if (e.currentTarget.value !== '' && Number.isFinite(n)) change(n); }} />
    </label>;
  }
  if (type === 'color') {
    const v = typeof field.value === 'string' && /^#[0-9a-f]{6}$/i.test(field.value) ? field.value : '#ffffff';
    return <label class="vs-dn-insp-field">
      <span class="vs-dn-insp-label">{label}</span>
      <input id={id} class="vs-dn-insp-color" type="color" value={v} onInput={(e) => change(e.currentTarget.value)} />
    </label>;
  }
  const value = String(field.value ?? '');
  const over = maxWords !== undefined && wordCount(value) > maxWords;
  return <label class="vs-dn-insp-field">
    <span class="vs-dn-insp-label">{label}</span>
    <input id={id} class="vs-dn-insp-input" value={value} maxLength={maxLength(field)} onInput={(e) => change(e.currentTarget.value)} />
    {over && <span class="vs-dn-insp-hint is-warn">Nên tối đa {maxWords} từ</span>}
  </label>;
}

function SoundField({ item, tpl }: { item: EditorElement; tpl: TemplateManifest | null }) {
  const s = effectiveSound(item);
  const [picking, setPicking] = useState(s.mode === 'asset');
  const sfx = sfxAssets.value;
  const id = `vs-dn-snd-${item.id}`;
  const set = (next: ElementSound) => editElement(item.id, soundPatch(item, next));
  const autoId = presetSoundId(tpl, effectiveAnim(item));
  const autoName = autoId ? sfx.find((a) => a.id === autoId)?.name ?? autoId.replace(/^sfx:/, '') : '';
  const playing = soundAssetId(item, tpl);
  return <div class="vs-dn-insp-field">
    <label for={id} class="vs-dn-insp-label">Âm thanh</label>
    <div class="vs-dn-insp-row">
      <select id={id} class="vs-dn-insp-input" value={picking ? 'asset' : s.mode} onChange={(e) => {
        const mode = e.currentTarget.value as ElementSound['mode'];
        if (mode === 'asset') { setPicking(true); return; }
        setPicking(false);
        set({ mode, volume: s.volume });
      }}>
        <option value="auto">Tự động{autoName ? ` (${autoName})` : ' theo mẫu'}</option>
        <option value="none">Không có tiếng</option>
        <option value="asset">Chọn trong thư viện…</option>
      </select>
      <button type="button" class="vs-btn vs-dn-insp-play" disabled={!playing} onClick={() => playing && playSound(playing, s.volume)}>
        <Play size={12} aria-hidden="true" fill="currentColor" /> Nghe thử
      </button>
    </div>
    {picking && (
      <select class="vs-dn-insp-input" aria-label="Tiếng động trong thư viện" value={s.mode === 'asset' ? s.assetId ?? '' : ''}
        onChange={(e) => { const assetId = e.currentTarget.value; if (assetId) set({ mode: 'asset', assetId, volume: s.volume }); }}>
        <option value="">{sfx.length ? 'Chọn tiếng động…' : 'Thư viện chưa có tiếng động'}</option>
        {sfx.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
    )}
    <label class="vs-dn-insp-range">
      <span class="vs-dn-insp-label"><span>Âm lượng</span><span class="vs-dn-insp-value">{Math.round(s.volume * 100)}%</span></span>
      <input type="range" min={0} max={200} step={5} value={Math.round(s.volume * 100)} disabled={s.mode === 'none'}
        onInput={(e) => set({ ...s, volume: Number(e.currentTarget.value) / 100 })} />
    </label>
  </div>;
}

function ElementInspector({ item }: { item: EditorElement }) {
  const tpl = template.value;
  const def = componentDef(tpl, item);
  const fields = inspectorFields(item, def);
  const anims = animationOptions(tpl, def);
  const anim = effectiveAnim(item);
  const scale = Math.round((item.override?.s ?? 1) * 100);
  const broll = item.kind === 'broll' ? item.el as BrollItem : null;
  return <>
    <div class="vs-dn-insp-head">
      <h2 id="vs-dn-insp-title" class="vs-dn-ed-eyebrow is-accent">{KIND_LABEL[item.kind]}</h2>
      <span class="vs-muted">{KIND_COUNT[item.kind]} {item.n}/{item.count} · {clockVi(item.at)} · {secondsVi(item.end - item.at)}</span>
    </div>
    {item.override && <OwnedNote onReset={() => void resetElement(item.id)} />}
    {item.hidden && <p class="vs-dn-insp-hint is-warn" role="status">Phần này đang ẩn khỏi video.</p>}

    {broll && <div class="vs-dn-insp-broll">
      <span class="vs-dn-insp-label">Cảnh đang dùng</span>
      <strong>{item.label}</strong>
      {broll.query?.description && <span class="vs-muted vs-dn-small">AI tìm theo mô tả: {broll.query.description}</span>}
      <button type="button" class="vs-btn" onClick={() => { libraryPanel.value = { tab: 'broll', brollId: item.id }; }}>
        <Image size={15} aria-hidden="true" /> Đổi cảnh khác
      </button>
    </div>}

    {fields.map((f) => <Field key={`${item.id}:${f.key}`} item={item} field={f} tpl={tpl} />)}

    {anims.length > 0 && <label class="vs-dn-insp-field">
      <span class="vs-dn-insp-label">Hiệu ứng vào</span>
      <select class="vs-dn-insp-input" value={anim ?? ''} onChange={(e) => editElement(item.id, animPatch(item, e.currentTarget.value))}>
        {!anim && <option value="">Theo mẫu</option>}
        {anims.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
      </select>
    </label>}

    {item.kind !== 'zoom' && <SoundField key={item.id} item={item} tpl={tpl} />}

    {item.kind !== 'zoom' && <label class="vs-dn-insp-range">
      <span class="vs-dn-insp-label"><span>{item.kind === 'beat' ? 'Cỡ chữ' : 'Cỡ'}</span><span class="vs-dn-insp-value">{scale}%</span></span>
      <input type="range" min={80} max={140} step={2} value={scale} onInput={(e) => editElement(item.id, scalePatch(Number(e.currentTarget.value)))} />
    </label>}

    <button type="button" class="vs-btn vs-dn-insp-hide" onClick={() => editElement(item.id, { hidden: item.hidden ? null : true })}>
      {item.hidden ? <><Eye size={15} aria-hidden="true" /> Hiện lại trong video</> : <><EyeOff size={15} aria-hidden="true" /> Ẩn khỏi video</>}
    </button>
  </>;
}

function MusicInspector({ plan }: { plan: EditPlan }) {
  const doc = overridesDoc.value;
  const m = musicState(plan, doc);
  const track = m.assetId ? bgmAssets.value.find((a) => a.id === m.assetId) : undefined;
  const name = m.off ? 'Không dùng nhạc' : track?.name ?? m.mood ?? 'Nhạc AI chọn';
  return <>
    <div class="vs-dn-insp-head"><h2 id="vs-dn-insp-title" class="vs-dn-ed-eyebrow is-accent">Âm thanh</h2></div>
    {m.edited && <OwnedNote text="Bạn đã đổi nhạc nền. Khi nhờ AI sửa lại, AI không đổi nhạc của bạn." onReset={() => void resetMusic()} />}
    <div class="vs-dn-insp-broll">
      <span class="vs-dn-insp-label">Nhạc nền</span>
      <strong>{name}</strong>
      <button type="button" class="vs-btn" onClick={() => { libraryPanel.value = { tab: 'music' }; }}><Music size={15} aria-hidden="true" /> Đổi nhạc nền</button>
    </div>
    <label class="vs-dn-insp-check">
      <input type="checkbox" checked={m.duck} disabled={m.off} onChange={(e) => editMusic(musicDuckPatch(plan, e.currentTarget.checked))} />
      <span>Tự giảm nhạc khi đang nói</span>
    </label>
    {m.off
      ? doc.music?.off && <button type="button" class="vs-btn" onClick={() => editMusic({ off: null })}>Bật lại nhạc</button>
      : <button type="button" class="vs-btn" onClick={() => editMusic(musicPickPatch(plan, null))}>Không dùng nhạc</button>}
    <p class="vs-muted vs-dn-small">Tiếng động của từng chữ, cảnh chỉnh ở mục âm thanh khi chọn phần đó.</p>
  </>;
}

function CaptionInfo({ captions }: { captions: CaptionChunk[] }) {
  const tpl = template.value;
  const t = playerTime.value;
  const cap = captions.find((c) => t >= c.s - 0.001 && t < c.e);
  return <>
    <div class="vs-dn-insp-head"><h2 id="vs-dn-insp-title" class="vs-dn-ed-eyebrow is-accent">Phụ đề</h2><span class="vs-muted">{captions.length} cụm</span></div>
    <div class="vs-dn-insp-broll">
      <span class="vs-dn-insp-label">Đang hiện</span>
      <strong>{cap ? cap.text : 'Không có phụ đề ở đây'}</strong>
    </div>
    <p class="vs-muted vs-dn-small">
      {tpl ? `Phụ đề theo kiểu của mẫu “${tpl.name}”: chữ ${tpl.captions.font.family}, tối đa ${tpl.captions.maxWordsPerChunk} từ mỗi cụm.` : 'Phụ đề theo kiểu của mẫu.'}
      {' '}Muốn sửa lời trong phụ đề, bấm Nhờ AI sửa.
    </p>
  </>;
}

function TemplateInfo() {
  const tpl = template.value;
  return <>
    <div class="vs-dn-insp-head"><h2 id="vs-dn-insp-title" class="vs-dn-ed-eyebrow is-accent">Mẫu</h2></div>
    <div class="vs-dn-insp-broll">
      <strong>{tpl?.name ?? 'Mẫu cơ bản'}</strong>
      {tpl?.description && <span class="vs-muted vs-dn-small">{tpl.description}</span>}
    </div>
    <p class="vs-muted vs-dn-small">Đổi mẫu ở bước Thiết lập rồi bấm AI edit lại. Phần bạn đã sửa tay được giữ nguyên.</p>
  </>;
}

export function Inspector({ item, plan, captions }: { item: EditorElement | null; plan: EditPlan; captions: CaptionChunk[] }) {
  const current = tool.value;
  let body;
  if (current === 'caption') body = <CaptionInfo captions={captions} />;
  else if (current === 'sound') body = <MusicInspector plan={plan} />;
  else if (current === 'template') body = <TemplateInfo />;
  else if (item) body = <ElementInspector item={item} />;
  else {
    body = <>
      <div class="vs-dn-insp-head"><h2 id="vs-dn-insp-title" class="vs-dn-ed-eyebrow is-accent">{TOOL_TITLE[current]}</h2></div>
      <p class="vs-muted">Video này chưa có {EMPTY_KIND[current] ?? 'phần nào'}. Thêm phần mới có ở bản sau; bây giờ bạn có thể bấm Nhờ AI sửa.</p>
    </>;
  }
  return <section class="vs-dn-insp" aria-labelledby="vs-dn-insp-title">{body}</section>;
}
