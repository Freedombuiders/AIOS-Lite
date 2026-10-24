// Message composer: attachments, "/" style command popup, upload entry points, send / stop.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ArrowUp, Library, Plus, Square, Wand2, X } from 'lucide-preact';
import { pushToast } from '@/lib/toasts';
import { errorMessage, uploadLibraryAsset } from '@modules/video/web/lib/video-edit/api';
import { formatBytes } from '@modules/video/web/lib/video-edit/format';
import {
  abortTurn, activeStyleId, addAsset, chooseStyle, composerAssets, composerFocusNonce, draftText, openFilePickerNonce,
  project, removeAsset, rightOpen, rightTab, sendMessage, styleById, styleModal, styles, upload, uploadFile,
} from '@modules/video/web/lib/video-edit/studio';

const MAX_LINES_PX = 22 * 8;

export function Composer({ variant }: { variant: 'hero' | 'dock' }) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);

  const text = draftText.value;
  const busy = !!project.value?.busy;
  const up = upload.value;
  const style = styleById(activeStyleId());
  const canSend = text.trim().length > 0 && !busy && !sending && !up && !attaching;

  const attachFiles = async (files: File[]) => {
    if (!files.length) return;
    const videos = files.filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|mkv|webm)$/i.test(f.name));
    const images = files.filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/i.test(f.name));
    if (videos.length > 1) pushToast({ tone: 'warn', title: 'Mỗi việc dựng nhận một video', description: 'Hãy tạo việc riêng cho các video còn lại.' });
    if (videos[0]) void uploadFile(videos[0]);
    if (!images.length) return;
    setAttaching(true);
    try {
      const slots = Math.max(0, 10 - composerAssets.value.length);
      if (images.length > slots) pushToast({ tone: 'warn', title: 'Tối đa 10 ảnh/tài nguyên trong một tin nhắn' });
      for (const file of images.slice(0, slots)) {
        try {
          const asset = await uploadLibraryAsset(file, 'image');
          if (asset) addAsset({ kind: 'asset', ref: asset.id, label: asset.name });
        } catch (e) {
          pushToast({ tone: 'error', title: `Không tải được ${file.name}`, description: errorMessage(e), ttlMs: 6000 });
        }
      }
    } finally { setAttaching(false); }
  };

  const slashMatch = /^\/(\S*)$/.exec(text);
  const slashItems = slashMatch && !slashDismissed
    ? styles.value.filter((s) => {
      const q = slashMatch[1].toLowerCase();
      return !q || s.command.toLowerCase().includes(q) || s.name.toLowerCase().includes(q);
    }).slice(0, 8)
    : [];

  const resize = () => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_LINES_PX + 4)}px`;
  };
  useEffect(resize, [text]);
  useEffect(() => { setSlashIndex(0); }, [slashMatch?.[1]]);
  useEffect(() => { if (composerFocusNonce.value) textRef.current?.focus(); }, [composerFocusNonce.value]);
  const seenPicker = useRef(openFilePickerNonce.value);
  useEffect(() => {
    if (openFilePickerNonce.value !== seenPicker.current) { seenPicker.current = openFilePickerNonce.value; fileRef.current?.click(); }
  }, [openFilePickerNonce.value]);

  const pickStyle = (command: string) => {
    draftText.value = `${command} `;
    setSlashDismissed(true);
    textRef.current?.focus();
  };

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    try { await sendMessage(text); } finally { setSending(false); }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    if (slashItems.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashItems.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashItems.length) % slashItems.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickStyle(slashItems[slashIndex].command); return; }
      if (e.key === 'Escape') { e.preventDefault(); setSlashDismissed(true); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
  };

  return (
    <div class={`vs-composer vs-composer-${variant}`}>
      {slashItems.length > 0 && (
        <ul class="vs-slash" role="listbox" aria-label="Chọn phong cách">
          {slashItems.map((s, i) => (
            <li key={s.id} role="option" aria-selected={i === slashIndex}>
              <button
                type="button"
                class={i === slashIndex ? 'is-active' : ''}
                onMouseEnter={() => setSlashIndex(i)}
                onMouseDown={(e) => { e.preventDefault(); pickStyle(s.command); }}
              >
                <span class="vs-mono">{s.command}</span>
                <span class="vs-slash-name">{s.name}</span>
                <span class="vs-faint vs-slash-for">{s.bestFor}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div class="vs-composer-card">
        {(up || composerAssets.value.length > 0 || style) && (
          <div class="vs-attach-row">
            {up && (
              <span class="vs-attach vs-attach-upload" role="status">
                <span class="vs-attach-kind">VIDEO</span>
                <span class="vs-attach-name">{up.name}</span>
                <span class="vs-faint">{formatBytes(up.size)}</span>
                <span class="vs-bar" aria-hidden="true"><span style={{ width: `${Math.round(up.fraction * 100)}%` }} /></span>
                <span class="vs-attach-pct">{Math.round(up.fraction * 100)}%</span>
              </span>
            )}
            {composerAssets.value.map((a) => (
              <span key={a.ref} class="vs-attach">
                <span class="vs-attach-kind">KHO</span>
                <span class="vs-attach-name">{a.label}</span>
                <button type="button" class="vs-attach-x" aria-label={`Bỏ ${a.label}`} onClick={() => removeAsset(a.ref)}><X size={12} aria-hidden="true" /></button>
              </span>
            ))}
            {style && (
              <span class="vs-attach vs-attach-style">
                <span class="vs-attach-kind">STYLE</span>
                <span class="vs-attach-name"><span class="vs-mono">{style.command}</span> {style.name}</span>
                <button type="button" class="vs-attach-x" aria-label="Bỏ phong cách" onClick={() => void chooseStyle(null)}><X size={12} aria-hidden="true" /></button>
              </span>
            )}
          </div>
        )}
        <textarea
          ref={textRef}
          class="vs-textarea"
          rows={variant === 'hero' ? 2 : 1}
          placeholder="Thả video quay thô vào đây, hoặc nhập yêu cầu…"
          aria-label="Nội dung tin nhắn"
          value={text}
          onInput={(e) => { draftText.value = e.currentTarget.value; setSlashDismissed(false); }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.length) { e.preventDefault(); void attachFiles(files); }
          }}
        />
        <div class="vs-composer-bar">
          <input
            ref={fileRef}
            type="file"
            accept="video/*,image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.currentTarget.files ?? []);
              e.currentTarget.value = '';
              void attachFiles(files);
            }}
          />
          <button type="button" class="vs-icon-btn" aria-label="Thêm video hoặc ảnh" title="Thêm video hoặc nhiều ảnh" disabled={!!up || attaching} onClick={() => fileRef.current?.click()}>
            <Plus size={18} aria-hidden="true" />
          </button>
          <button type="button" class="vs-tool-btn" onClick={() => { rightTab.value = 'assets'; rightOpen.value = true; }}>
            <Library size={15} aria-hidden="true" /> Kho
          </button>
          <button type="button" class="vs-tool-btn" onClick={() => { styleModal.value = true; }}>
            <Wand2 size={15} aria-hidden="true" /> Phong cách
          </button>
          <span class="vs-hint">Dán video/ảnh · Enter gửi · Shift+Enter xuống dòng</span>
          {busy ? (
            <button type="button" class="vs-send vs-send-stop" aria-label="Dừng agent" title="Dừng agent" onClick={() => void abortTurn()}>
              <Square size={14} fill="currentColor" aria-hidden="true" />
            </button>
          ) : (
            <button type="button" class="vs-send" aria-label="Gửi" title="Gửi (Enter)" disabled={!canSend} onClick={() => void submit()}>
              <ArrowUp size={18} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
