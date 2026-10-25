// "Nhờ AI sửa" under the preview: one line to the AI about the selected element (or the moment at the
// playhead after "Ghim góp ý"). Sent through the existing marks flow (create mark → send marks).
import { useEffect, useRef, useState } from 'preact/hooks';
import { Sparkles } from 'lucide-preact';
import { playerTime } from '@modules/video/web/lib/video-edit/editor';
import { clockVi, type EditorElement } from '@modules/video/web/lib/video-edit/editor2';
import { askAi, askFocus, askScope } from './state';

const PLACEHOLDER: Record<EditorElement['kind'], string> = {
  beat: 'Nhờ AI sửa chữ này: ngắn hơn, đổi thành câu hỏi…',
  scene: 'Nhờ AI sửa cảnh minh hoạ này: thêm một bước, đổi chữ…',
  broll: 'Nhờ AI sửa cảnh trám này: cảnh khác hợp hơn, ngắn hơn…',
  graphic: 'Nhờ AI sửa đồ hoạ này…',
  zoom: 'Nhờ AI sửa zoom này: nhẹ hơn, bỏ đi…',
};

export function AskBox({ item, busy }: { item: EditorElement | null; busy: boolean }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const focus = askFocus.value;
  const seenFocus = useRef(focus);
  useEffect(() => {
    if (focus === seenFocus.current) return;
    seenFocus.current = focus;
    input.current?.focus();
  }, [focus]);

  const send = async () => {
    if (!text.trim() || sending || busy) return;
    setSending(true);
    const ok = await askAi(text, item);
    setSending(false);
    if (ok) setText('');
  };

  return <div class="vs-dn-ask" role="group" aria-label="Nhờ AI sửa">
    <div class="vs-dn-ask-row">
      <label class="vs-dn-ask-field">
        <Sparkles size={15} aria-hidden="true" />
        <span class="vs-dn-sr">{item ? 'Nhờ AI sửa phần đang chọn' : 'Nhờ AI sửa đoạn này'}</span>
        <input ref={input} value={text} placeholder={item ? PLACEHOLDER[item.kind] : `Nhờ AI sửa đoạn tại ${clockVi(playerTime.value)}…`}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void send(); } }} />
      </label>
      <button type="button" class="vs-dn-ask-send" disabled={!text.trim() || sending || busy} onClick={() => void send()}>
        {sending ? 'Đang gửi…' : 'Gửi'}
      </button>
    </div>
    <span class="vs-dn-ask-ctx">
      {item ? <>Gắn với “{item.label}”, {clockVi(item.at)} – {clockVi(item.end)}
        <button type="button" class="vs-dn-linkbtn" onClick={() => { askScope.value = 'time'; }}>Gắn với thời điểm thay vào</button></>
        : <>Gắn với thời điểm {clockVi(playerTime.value)}. AI xem đoạn này rồi sửa thành bản mới.</>}
    </span>
  </div>;
}
