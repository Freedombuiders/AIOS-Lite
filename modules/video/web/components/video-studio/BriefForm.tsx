// Per-style information form ("Thông tin cho /sanpham"): optional extras that make the on-screen text
// exact. Opens from the style chip and right after picking a style that has one. Dismissible.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Plus, Upload, X } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { pushToast } from '@/lib/toasts';
import { errorMessage, uploadLibraryAsset, videoEditApi, type BriefValues } from '@modules/video/web/lib/video-edit/api';
import { briefModal, project, styleById } from '@modules/video/web/lib/video-edit/studio';
import type { BriefField, VideoStyle } from '@modules/video/web/lib/video-edit/types';

const isFilled = (v: string | string[] | undefined) => (Array.isArray(v) ? v.some((x) => x.trim()) : !!v?.trim());

export function BriefForm() {
  const p = project.value;
  const style = styleById(p?.styleId);
  if (!briefModal.value || !p || !style?.brief?.length) return null;
  return <BriefDialog projectId={p.id} style={style} fields={style.brief} />;
}

function BriefDialog({ projectId, style, fields }: { projectId: string; style: VideoStyle; fields: BriefField[] }) {
  const [values, setValues] = useState<BriefValues>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const close = () => { briefModal.value = false; };

  useEffect(() => {
    let live = true;
    const fromProject = project.value?.brief;
    if (fromProject) setValues(fromProject);
    videoEditApi.brief(projectId)
      .then((b) => { if (live && b && typeof b === 'object') setValues(b); })
      .catch(() => { /* an empty form is fine: the brief is optional */ })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [projectId]);

  const set = (key: string, v: string | string[]) => setValues((x) => ({ ...x, [key]: v }));
  const filled = fields.filter((f) => isFilled(values[f.key])).length;

  const save = async () => {
    setSaving(true);
    setError('');
    const clean: BriefValues = {};
    for (const f of fields) {
      const v = values[f.key];
      if (Array.isArray(v)) { const arr = v.map((x) => x.trim()).filter(Boolean); if (arr.length) clean[f.key] = arr; }
      else if (v?.trim()) clean[f.key] = v.trim();
    }
    try {
      await videoEditApi.saveBrief(projectId, clean);
      if (project.value?.id === projectId) project.value = { ...project.value, brief: clean };
      close();
    } catch (e) { setError(errorMessage(e)); }
    finally { setSaving(false); }
  };

  return (
    <Modal
      open
      onClose={close}
      title={`Thông tin cho ${style.command}`}
      width={640}
      footer={
        <>
          <span class="vs-muted vs-brief-count" role="status">Đã điền {filled}/{fields.length} · agent sẽ hỏi phần còn thiếu nếu cần</span>
          <button type="button" class="vs-btn ml-auto" onClick={close}>Bỏ qua</button>
          <button type="button" class="vs-btn vs-btn-accent" disabled={saving || loading} onClick={() => void save()}>{saving ? 'Đang lưu…' : 'Lưu'}</button>
        </>
      }
    >
      <p class="vs-muted vs-brief-intro">Không bắt buộc. Điền thì chữ trên video đúng tên, đúng giá, có ảnh làm B-roll và ảnh bìa. Bỏ qua thì agent tự nghe trong video và hỏi lại khi thiếu.</p>
      {error && <div class="vs-error" role="alert">{error}</div>}
      <form class="vs-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {fields.map((f) => <BriefFieldInput key={f.key} field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />)}
      </form>
    </Modal>
  );
}

export function BriefFieldInput({ field, value, onChange }: { field: BriefField; value: string | string[] | undefined; onChange: (v: string | string[]) => void }) {
  const text = typeof value === 'string' ? value : '';
  const list = Array.isArray(value) ? value : [];
  switch (field.kind) {
    case 'choice':
      return (
        <fieldset class="vs-field vs-brief-set">
          <legend>{field.label}</legend>
          <div class="vs-mark-kinds" role="radiogroup" aria-label={field.label}>
            {(field.options ?? []).map((o) => (
              <button key={o} type="button" role="radio" aria-checked={text === o} class={`vs-mark-kind${text === o ? ' is-on' : ''}`} onClick={() => onChange(text === o ? '' : o)}>{o}</button>
            ))}
          </div>
        </fieldset>
      );
    case 'list': {
      const rows = list.length >= 3 ? list : [...list, ...Array<string>(3 - list.length).fill('')];
      return (
        <fieldset class="vs-field vs-brief-set">
          <legend>{field.label}</legend>
          <div class="vs-brief-list">
            {rows.map((v, i) => (
              <input key={i} class="vs-input" aria-label={`${field.label} ${i + 1}`} placeholder={field.placeholder} value={v}
                onInput={(e) => { const next = [...rows]; next[i] = e.currentTarget.value; onChange(next); }} />
            ))}
            <button type="button" class="vs-btn vs-brief-add" onClick={() => onChange([...rows, ''])}><Plus size={14} aria-hidden="true" /> Thêm dòng</button>
          </div>
        </fieldset>
      );
    }
    case 'media':
      return <MediaField field={field} items={list} onChange={onChange} />;
    case 'money':
    case 'percent':
      return (
        <label class="vs-field"><span>{field.label}</span>
          <span class="vs-brief-unit">
            <input class="vs-input" inputMode="decimal" placeholder={field.placeholder} value={text} onInput={(e) => onChange(e.currentTarget.value)} />
            <span class="vs-faint" aria-hidden="true">{field.kind === 'money' ? 'đ' : '%'}</span>
          </span>
        </label>
      );
    case 'url':
      return (
        <label class="vs-field"><span>{field.label}</span>
          <input class="vs-input" type="url" placeholder={field.placeholder ?? 'https://'} value={text} onInput={(e) => onChange(e.currentTarget.value)} />
        </label>
      );
    default:
      return (
        <label class="vs-field"><span>{field.label}</span>
          <input class="vs-input" placeholder={field.placeholder} value={text} onInput={(e) => onChange(e.currentTarget.value)} />
        </label>
      );
  }
}

/** Library asset ids or file paths; upload goes to the asset library (POST /assets/upload). */
function MediaField({ field, items, onChange }: { field: BriefField; items: string[]; onChange: (v: string[]) => void }) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const add = (ref: string) => { const r = ref.trim(); if (r && !items.includes(r)) onChange([...items, r]); };
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const asset = await uploadLibraryAsset(file, file.type.startsWith('video/') ? 'video' : 'image');
      if (asset) add(asset.id); else pushToast({ tone: 'warn', title: 'Đã tải lên nhưng chưa nhận được mã file' });
    } catch (e) { pushToast({ tone: 'error', title: 'Không tải được file lên kho', description: errorMessage(e), ttlMs: 6000 }); }
    finally { setBusy(false); }
  };
  return (
    <fieldset class="vs-field vs-brief-set">
      <legend>{field.label}</legend>
      {items.length > 0 && (
        <ul class="vs-brief-media">
          {items.map((it) => (
            <li key={it}>
              <span class="vs-chan-url" title={it}>{it}</span>
              <button type="button" class="vs-icon-btn" aria-label={`Bỏ ${it}`} onClick={() => onChange(items.filter((x) => x !== it))}><X size={14} aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      )}
      <div class="vs-row-gap vs-row-nowrap">
        <input class="vs-input" aria-label={`${field.label}: mã file trong kho hoặc đường dẫn`} placeholder={field.placeholder ?? 'Mã file trong kho hoặc đường dẫn'} value={path}
          onInput={(e) => setPath(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add(path); setPath(''); } }} />
        <button type="button" class="vs-btn" disabled={!path.trim()} onClick={() => { add(path); setPath(''); }}>Thêm</button>
        <button type="button" class="vs-btn" disabled={busy} onClick={() => input.current?.click()}><Upload size={14} aria-hidden="true" /> {busy ? 'Đang tải…' : 'Tải lên'}</button>
        <input ref={input} type="file" accept="image/*,video/*" hidden onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) void upload(f); }} />
      </div>
    </fieldset>
  );
}
