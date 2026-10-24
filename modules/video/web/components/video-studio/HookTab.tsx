// Tab Hook: the options for the first seconds; choosing one rebuilds the preview.
import { chooseHook, savingPlan } from '@modules/video/web/lib/video-edit/editor';
import type { EditPlan, HookOption, TranscriptWord } from '@modules/video/web/lib/video-edit/types';

const KIND_LABEL: Record<HookOption['kind'], string> = {
  question: 'Câu hỏi', warning: 'Cảnh báo', number: 'Con số', story: 'Kể chuyện', other: 'Khác',
};

function how(h: HookOption, words: TranscriptWord[]): string {
  if (h.mode === 'moved' && h.moveFromWord !== undefined && h.moveToWord !== undefined) {
    const said = words.slice(h.moveFromWord, h.moveToWord + 1).map((w) => w.text).join(' ');
    return `Đưa đoạn “${said}” lên đầu video`;
  }
  return 'Chèn chữ lên cảnh đầu';
}

export function HookTab({ plan, words, readOnly }: { plan: EditPlan; words: TranscriptWord[]; readOnly: boolean }) {
  const options = plan.hook?.options ?? [];
  const chosen = plan.hook?.chosen;
  if (options.length === 0) return <p class="vs-muted vs-ed-empty">Kế hoạch này chưa có hook. Gửi góp ý để agent viết thêm cách mở đầu.</p>;
  return (
    <div class="vs-ed-list">
      <p class="vs-muted vs-ed-note">Cách mở đầu cho vài giây đầu. Chọn một, bản xem trước đổi ngay.</p>
      {options.map((h, i) => {
        const on = h.id === chosen;
        const letter = String.fromCharCode(65 + (i % 26));
        return (
          <article key={h.id} class={`vs-ed-card vs-hook${on ? ' is-on' : ''}`}>
            <div class="vs-hook-thumb" aria-hidden="true"><span>{h.text.length > 22 ? h.text.slice(0, 20) + '…' : h.text}</span></div>
            <div class="vs-hook-main">
              <div class="vs-hook-top"><b>Hook {letter}</b><span class="vs-tag">{KIND_LABEL[h.kind]}</span></div>
              <div class="vs-hook-text">“{h.text}”</div>
              {h.subtext && <div class="vs-muted vs-hook-sub">{h.subtext}</div>}
              <div class="vs-muted vs-hook-sub">{how(h, words)}</div>
              <button
                type="button"
                class={`vs-btn vs-hook-btn${on ? ' vs-btn-hl' : ''}`}
                disabled={readOnly || on || savingPlan.value > 0}
                aria-pressed={on}
                onClick={() => void chooseHook(h.id)}
              >{on ? 'Đang dùng' : 'Dùng hook này'}</button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
