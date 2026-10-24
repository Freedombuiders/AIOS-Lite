// "GIỌNG NÓI AI": text-to-speech panel. Phase 0 only reports whether a provider is configured.
import { useEffect, useState } from 'preact/hooks';
import { ChevronRight } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { pushToast } from '@/lib/toasts';
import { errorMessage, videoEditApi, type VoiceResponse } from '@modules/video/web/lib/video-edit/api';
import { voiceModal } from '@modules/video/web/lib/video-edit/studio';

export function VoiceModal() {
  const open = voiceModal.value;
  const [voice, setVoice] = useState<VoiceResponse | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError('');
    videoEditApi.voice().then((r) => { if (live) setVoice(r); }).catch((e) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [open]);

  if (!open) return null;
  const configured = !!voice?.configured;
  const generate = async () => {
    setBusy(true);
    try { await videoEditApi.tts({ text: text.trim(), ...(voiceId ? { voiceId } : {}) }); }
    catch (e) { pushToast({ tone: 'warn', title: 'Chưa tạo được giọng', description: errorMessage(e), ttlMs: 6000 }); }
    finally { setBusy(false); }
  };
  return (
    <Modal
      open
      onClose={() => { voiceModal.value = false; }}
      title="GIỌNG NÓI AI"
      width={560}
      footer={<button type="button" class="vs-btn ml-auto" onClick={() => { voiceModal.value = false; }}>Đóng</button>}
    >
      {error && <div class="vs-error" role="alert">{error}</div>}
      {voice && !configured && (
        <div class="vs-notice" role="status">
          <strong>Chưa cấu hình nhà cung cấp giọng nói.</strong>
          <p>Giọng AI (đọc lời bình, nhân bản giọng của bạn) sẽ có ở giai đoạn 3, qua nhà cung cấp có tiếng Việt như ElevenLabs hoặc FPT.AI.
            Khoá API sẽ nhập trong Cài đặt và không bắt buộc để dựng video.</p>
        </div>
      )}
      <fieldset class="vs-form" disabled={!configured || busy}>
        <label class="vs-field">
          <span>Giọng</span>
          <select class="vs-input" value={voiceId} onChange={(e) => setVoiceId(e.currentTarget.value)}>
            <option value="">{voice?.voices.length ? 'Chọn giọng' : 'Chưa có giọng nào'}</option>
            {voice?.voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
        <label class="vs-field">
          <span>Lời cần đọc</span>
          <textarea class="vs-input" rows={5} placeholder="Gõ lời cần đọc thành giọng…" value={text} onInput={(e) => setText(e.currentTarget.value)} />
        </label>
        <button type="button" class="vs-btn vs-btn-accent" disabled={!text.trim()} onClick={() => void generate()}>Tạo giọng</button>
        <details class="vs-adv">
          <summary><ChevronRight size={13} aria-hidden="true" /> Nhân bản giọng của bạn (nâng cao)</summary>
          <p class="vs-muted">Tải lên 1–3 phút giọng nói sạch, không nhạc nền, để tạo giọng riêng. Cần nhà cung cấp hỗ trợ nhân bản.</p>
          <input type="file" accept="audio/*" disabled />
        </details>
      </fieldset>
    </Modal>
  );
}
