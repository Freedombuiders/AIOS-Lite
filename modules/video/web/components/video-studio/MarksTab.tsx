// Tab Góp ý: the owner's review marks (pinned on the timeline) + the composer. Sent in one batch.
import { useEffect } from 'preact/hooks';
import { Trash2 } from 'lucide-preact';
import { formatRange, formatTimeDec } from '@modules/video/web/lib/video-edit/format';
import { deleteMark, markDraft, playerControls, playerTime, saveMark, startMark } from '@modules/video/web/lib/video-edit/editor';
import { MARK_KINDS, type MarkKind, type VideoMark } from '@modules/video/web/lib/video-edit/types';

const STATUS_LABEL: Record<VideoMark['status'], string> = { draft: 'chưa gửi', sent: 'đã gửi', resolved: 'đã xử lý' };
const kindLabel = (k: MarkKind) => MARK_KINDS.find((m) => m.kind === k)?.label ?? k;

export function MarksTab({ marks, readOnly }: { marks: VideoMark[]; readOnly: boolean }) {
  const d = markDraft.value;
  const composing = !!d;
  useEffect(() => { if (composing) document.getElementById('vs-mark-note')?.focus(); }, [composing]);
  return (
    <div class="vs-ed-list">
      {marks.map((m, i) => (
        <article key={m.id} class="vs-ed-card vs-mark">
          <div class="vs-mark-top">
            <button type="button" class="vs-tl-pin vs-mark-pin" aria-label={`Tới góp ý ${i + 1}`} onClick={() => playerControls.seek(m.start)}>{i + 1}</button>
            <span class="vs-mono vs-mark-time">{formatRange(m.start, m.end)}</span>
            <span class="vs-tag">{kindLabel(m.kind)}</span>
            <span class={`vs-faint vs-mark-status${m.status === 'draft' ? ' is-draft' : ''}`}>{STATUS_LABEL[m.status]}</span>
            <span class="vs-mark-actions">
              {m.status === 'draft' && !readOnly && (
                <button type="button" class="vs-btn vs-mark-edit" onClick={() => startMark({ start: m.start, end: m.end, kind: m.kind, note: m.note, editingId: m.id })}>Sửa</button>
              )}
              <button type="button" class="vs-icon-btn" aria-label={`Xoá góp ý ${i + 1}`} disabled={readOnly} onClick={() => void deleteMark(m.id)}><Trash2 size={15} aria-hidden="true" /></button>
            </span>
          </div>
          <p class="vs-mark-note">{m.note || <span class="vs-faint">(chưa ghi chú)</span>}</p>
        </article>
      ))}

      {d ? (
        <article class="vs-ed-card vs-mark-compose" aria-label="Góp ý mới">
          <div class="vs-mark-top">
            <span class="vs-faint">{d.editingId ? 'Sửa góp ý' : 'Góp ý mới'}</span>
            <span class="vs-mono vs-mark-time">{formatRange(d.start, d.end)}</span>
          </div>
          <div class="vs-row-gap">
            <button type="button" class="vs-btn vs-mark-small" onClick={() => { markDraft.value = { ...d, start: playerTime.value, end: d.end !== undefined && d.end > playerTime.value ? d.end : undefined }; }}>Bắt đầu ở {formatTimeDec(playerTime.value)}</button>
            <button type="button" class="vs-btn vs-mark-small" disabled={playerTime.value <= d.start} onClick={() => { markDraft.value = { ...d, end: playerTime.value }; }}>Kết thúc ở {formatTimeDec(playerTime.value)}</button>
          </div>
          <div class="vs-mark-kinds" role="radiogroup" aria-label="Loại góp ý">
            {MARK_KINDS.map((k) => (
              <button key={k.kind} type="button" role="radio" aria-checked={d.kind === k.kind} class={`vs-mark-kind${d.kind === k.kind ? ' is-on' : ''}`} onClick={() => { markDraft.value = { ...d, kind: k.kind }; }}>{k.label}</button>
            ))}
          </div>
          <label class="vs-field">
            <span class="sr-only">Nội dung góp ý</span>
            <textarea
              id="vs-mark-note"
              class="vs-input"
              rows={3}
              placeholder="VD: chữ to hơn, chèn cảnh hộp sản phẩm khi nói “giảm 50%”…"
              value={d.note}
              onInput={(e) => { markDraft.value = { ...d, note: e.currentTarget.value }; }}
            />
          </label>
          <div class="vs-row-gap">
            <button type="button" class="vs-btn vs-btn-accent" onClick={() => void saveMark()}>Lưu góp ý</button>
            <button type="button" class="vs-btn" onClick={() => { markDraft.value = null; }}>Huỷ</button>
          </div>
        </article>
      ) : (
        <button type="button" class="vs-btn vs-mark-new" disabled={readOnly} onClick={() => startMark({ start: playerTime.value })}>
          + Góp ý mới tại {formatTimeDec(playerTime.value)}
        </button>
      )}
      <p class="vs-muted vs-ed-note">Gửi một lần cả đợt. Agent sửa kế hoạch thành bản mới, chỉ dựng lại phần bị ảnh hưởng.</p>
    </div>
  );
}
