import { useRef, useState } from 'preact/hooks';
import { ArrowLeft, ArrowRight, Upload } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { errorMessage, uploadLibraryAsset, videoEditApi, type BriefValues } from '@modules/video/web/lib/video-edit/api';
import {
  activeAspect, addAsset, createProject, currentProfile, patchProject, pendingStyleId, project, sendMessage, styleGroups, styles, uploadFile,
} from '@modules/video/web/lib/video-edit/studio';
import type { VideoStyle } from '@modules/video/web/lib/video-edit/types';
import creatorStudio from '@modules/video/web/assets/video-studio/creator-studio.webp';
import creatorCafe from '@modules/video/web/assets/video-studio/creator-cafe.webp';
import { BriefFieldInput } from './BriefForm';

function TemplateVisual({ style }: { style: VideoStyle }) {
  const image = style.group === 'life' || style.group === 'sell' ? creatorCafe : creatorStudio;
  return <span class={`vs-template-visual ${activeAspect() === '16:9' ? 'is-landscape' : 'is-portrait'}`} aria-hidden="true">
    <img src={image} alt="" loading="lazy" />
    <span class="vs-template-visual-shade" />
    <span class="vs-template-visual-caption" style={{ color: style.palette.text, background: style.palette.bg }}>
      {style.id === 'quyen' ? <>B-ROLL <b style={{ color: style.palette.highlight }}>TRÊN ĐẦU</b></> : <>{style.name.split(' ').slice(0, 3).join(' ')} <b style={{ color: style.palette.highlight }}>●</b></>}
    </span>
  </span>;
}

function TemplateCard({ style, onChoose }: { style: VideoStyle; onChoose: (style: VideoStyle) => void }) {
  return <article class={`vs-template-card ${activeAspect() === '16:9' ? 'is-landscape' : ''}`}>
    <TemplateVisual style={style} />
    <div class="vs-template-card-body"><h3>{style.name}</h3><p>{style.description}</p><button type="button" class="vs-btn" onClick={() => onChoose(style)}>Dùng mẫu <ArrowRight size={14} aria-hidden="true" /></button></div>
  </article>;
}

export function TemplateStart({ onFormChange }: { onFormChange?: (open: boolean) => void }) {
  const [selected, setSelected] = useState<VideoStyle | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [group, setGroup] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [values, setValues] = useState<BriefValues>({});
  const [keyPoint, setKeyPoint] = useState('');
  const [outcome, setOutcome] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [direction, setDirection] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const uploadedImages = useRef(new Map<File, { id: string; name: string }>());
  const categories = styleGroups.value;
  const activeGroup = group || categories[0]?.id || 'teach';
  const shown = styles.value.filter((s) => s.group === activeGroup);
  const featured = ['kienthuc', 'sanpham', 'quyen'].map((id) => styles.value.find((style) => style.id === id)).filter((style): style is VideoStyle => !!style);

  const choose = (style: VideoStyle) => {
    setShowAll(false);
    setSelected(style);
    onFormChange?.(true);
    setValues({});
    setFile(null);
    setDirection('');
    setKeyPoint('');
    setOutcome('');
    setImages([]);
    uploadedImages.current.clear();
    setError('');
    (document.querySelector('.vs-empty') as HTMLElement | null)?.scrollTo({ top: 0 });
  };

  const start = async () => {
    if (!selected || !file || busy) return;
    setBusy(true);
    setError('');
    try {
      let p = project.value;
      if (p) {
        await patchProject({ styleId: selected.id });
        if (project.value?.styleId !== selected.id) throw new Error('Không chọn được mẫu. Hãy thử lại.');
      } else {
        pendingStyleId.value = selected.id;
        p = await createProject({ title: file.name.replace(/\.[^.]+$/, '').slice(0, 80) || selected.name });
      }
      if (!p) throw new Error(currentProfile() ? 'Không tạo được việc dựng.' : 'Hãy tạo hồ sơ thương hiệu rồi bấm lại Bắt đầu chat.');

      const brief: BriefValues = {};
      for (const field of selected.brief ?? []) {
        const value = values[field.key];
        if (Array.isArray(value)) {
          const items = value.map((x) => x.trim()).filter(Boolean);
          if (items.length) brief[field.key] = items;
        } else if (value?.trim()) brief[field.key] = value.trim();
      }
      if (Object.keys(brief).length) {
        await videoEditApi.saveBrief(p.id, brief);
        if (project.value?.id === p.id) project.value = { ...project.value, brief };
      }
      if (!project.value?.source && !(await uploadFile(file))) throw new Error('Video chưa tải lên được. Hãy thử lại.');
      for (const image of images) {
        let asset = uploadedImages.current.get(image);
        if (!asset) {
          const uploaded = await uploadLibraryAsset(image, 'image');
          if (!uploaded) throw new Error(`Không tải được ảnh ${image.name}.`);
          asset = { id: uploaded.id, name: uploaded.name };
          uploadedImages.current.set(image, asset);
        }
        addAsset({ kind: 'asset', ref: asset.id, label: asset.name });
      }
      const note = direction.trim();
      const prompt = `Tôi muốn dựng video vừa tải lên theo mẫu “${selected.name}”. Hãy xem video, dùng thông tin tôi đã điền, ảnh đính kèm và hồ sơ thương hiệu để đề xuất kế hoạch dựng. Hỏi tôi trong chat nếu còn thiếu dữ liệu quan trọng.${keyPoint.trim() ? ` Ý chính cần giữ: ${keyPoint.trim()}.` : ''}${outcome.trim() ? ` Mong muốn sau khi xem: ${outcome.trim()}.` : ''}${note ? ` Yêu cầu thêm: ${note}` : ''}`;
      if (!(await sendMessage(prompt))) throw new Error('Chưa mở được cuộc trò chuyện với agent. Hãy thử gửi tin nhắn trong ô chat.');
      setSelected(null);
      onFormChange?.(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (selected) return <div class="vs-template-start vs-template-form-page">
    <button type="button" class="vs-template-back" disabled={busy} onClick={() => { setSelected(null); onFormChange?.(false); }}><ArrowLeft size={16} aria-hidden="true" /> Chọn mẫu khác</button>
    <div class="vs-template-form-head">
      <TemplateVisual style={selected} />
      <div><span class="vs-eyebrow">BẮT ĐẦU TỪ MẪU</span><h2>{selected.name}</h2><p>{selected.description}</p></div>
    </div>
    <p class="vs-template-help">Điền những gì bạn đã có. Sau khi bắt đầu, agent sẽ tiếp tục trao đổi, hỏi phần còn thiếu và gửi kế hoạch để bạn duyệt.</p>
    <div class="vs-template-inputs">
      <div class="vs-field"><span>Video gốc <b aria-hidden="true">*</b></span>
        <button type="button" class="vs-template-upload" onClick={() => fileInput.current?.click()} disabled={busy}>
          <Upload size={18} aria-hidden="true" /> {file ? file.name : 'Chọn video MP4, MOV hoặc WebM'}
        </button>
        <input ref={fileInput} type="file" accept="video/*,.mkv,.m4v" hidden onChange={(e) => { setFile(e.currentTarget.files?.[0] ?? null); setError(''); }} />
      </div>
      <label class="vs-field"><span>Ý chính cần giữ</span><input class="vs-input" placeholder="Một điều người xem cần nhớ" value={keyPoint} onInput={(e) => setKeyPoint(e.currentTarget.value)} /></label>
      <label class="vs-field"><span>Muốn người xem làm gì sau video?</span><input class="vs-input" placeholder="Ví dụ: hiểu vấn đề, bình luận, nhắn tin…" value={outcome} onInput={(e) => setOutcome(e.currentTarget.value)} /></label>
      {(selected.brief ?? []).map((field) => <BriefFieldInput key={field.key} field={field} value={values[field.key]} onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))} />)}
      <div class="vs-field"><span>Ảnh minh hoạ hoặc ảnh sản phẩm (tối đa 10)</span>
        <button type="button" class="vs-template-upload" disabled={busy} onClick={() => imageInput.current?.click()}><Upload size={18} aria-hidden="true" /> {images.length ? `Đã chọn ${images.length} ảnh · Bấm để thay` : 'Chọn ảnh minh hoạ (không bắt buộc)'}</button>
        <input ref={imageInput} type="file" accept="image/*" multiple hidden onChange={(e) => setImages(Array.from(e.currentTarget.files ?? []).slice(0, 10))} />
        {images.length > 0 && <small class="vs-muted">Agent sẽ thấy ảnh trong tin nhắn đầu tiên.</small>}
      </div>
      <label class="vs-field"><span>Muốn agent chú ý thêm điều gì?</span>
        <textarea class="vs-input" rows={3} placeholder="Ví dụ: giữ giọng tự nhiên, mở đầu nhanh, kết thúc bằng lời mời nhắn tin…" value={direction} onInput={(e) => setDirection(e.currentTarget.value)} />
      </label>
    </div>
    {error && <div class="vs-error" role="alert">{error}</div>}
    <div class="vs-template-actions"><button type="button" class="vs-btn vs-btn-accent" disabled={!file || busy} onClick={() => void start()}>
      {busy ? 'Đang chuẩn bị cuộc trò chuyện…' : 'Bắt đầu chat với agent'} <ArrowRight size={15} aria-hidden="true" />
    </button></div>
  </div>;

  return <div class="vs-template-start">
    <div class="vs-template-section-head"><div><span class="vs-eyebrow">HOẶC BẮT ĐẦU TỪ MẪU</span><h2>Chọn mẫu video</h2><p>Mẫu điền nhanh thông tin; agent tiếp tục trao đổi và lên kế hoạch trong chat.</p></div><button type="button" class="vs-template-more" onClick={() => setShowAll(true)}>Xem tất cả {styles.value.length} mẫu <ArrowRight size={15} aria-hidden="true" /></button></div>
    <div class="vs-template-grid vs-template-featured">
      {featured.map((style) => <TemplateCard key={style.id} style={style} onChoose={choose} />)}
    </div>
    <Modal open={showAll} onClose={() => setShowAll(false)} title="Chọn mẫu video" width={960}>
      <div class="vs-template-library">
        <p>Mẫu hiển thị theo tỉ lệ {activeAspect() === '16:9' ? '16:9' : '9:16'} đang chọn. Bấm Dùng mẫu để điền thông tin rồi bắt đầu chat với agent.</p>
        <div class="vs-template-groups" role="tablist" aria-label="Nhóm mẫu video">
          {categories.map((category) => <button key={category.id} type="button" role="tab" aria-selected={activeGroup === category.id} class={activeGroup === category.id ? 'is-active' : ''} onClick={() => setGroup(category.id)}>{category.label}</button>)}
        </div>
        <div class="vs-template-grid">
          {shown.map((style) => <TemplateCard key={style.id} style={style} onChoose={choose} />)}
        </div>
      </div>
    </Modal>
  </div>;
}
