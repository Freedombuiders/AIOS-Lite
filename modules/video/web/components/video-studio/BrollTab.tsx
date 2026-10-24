// Tab B-roll: cut-in scenes with the reason and source; on/off rebuilds the preview.
import { Film } from 'lucide-preact';
import { formatTimeDec } from '@modules/video/web/lib/video-edit/format';
import { playerControls, savingPlan, setBroll } from '@modules/video/web/lib/video-edit/editor';
import type { PlanModel } from '@modules/video/web/lib/video-edit/plan-geometry';
import type { BrollItem, EditPlan, TranscriptWord } from '@modules/video/web/lib/video-edit/types';

const SOURCE_LABEL: Record<BrollItem['source'], string> = {
  product: 'Ảnh sản phẩm của bạn', library: 'Kho của bạn', ai: 'AI tạo', upload: 'Bạn tải lên', pexels: 'Pexels',
};

export function BrollTab({ plan, words, model, readOnly }: { plan: EditPlan; words: TranscriptWord[]; model: PlanModel; readOnly: boolean }) {
  if (plan.brolls.length === 0) return <p class="vs-muted vs-ed-empty">Kế hoạch này chưa có cảnh B-roll. Đánh dấu “Thêm B-roll” tại chỗ muốn chèn rồi gửi góp ý.</p>;
  return (
    <div class="vs-ed-list">
      <p class="vs-muted vs-ed-note">Cảnh chèn khi nói tới chi tiết. Bật hoặc tắt từng cảnh để xem ngay.</p>
      {plan.brolls.map((b) => {
        const w = words[b.anchorWord];
        const at = w ? model.toOut(w.start) : null;
        return (
          <article key={b.id} class={`vs-ed-card vs-broll${b.enabled ? '' : ' is-off'}`}>
            <span class="vs-broll-icon" aria-hidden="true"><Film size={16} /></span>
            <div class="vs-broll-main">
              <div class="vs-broll-top">
                {at !== null
                  ? <button type="button" class="vs-tr-time" onClick={() => playerControls.seek(at)} title="Tới cảnh này">{formatTimeDec(at)}</button>
                  : <span class="vs-faint vs-mono">đã cắt</span>}
                <b class="vs-broll-title">{b.title}</b>
              </div>
              {b.reason && <div class="vs-muted vs-broll-sub">{b.reason}</div>}
              <div class="vs-row-gap">
                <span class="vs-tag">{SOURCE_LABEL[b.source]}</span>
                <span class="vs-tag">{b.layout === 'full' ? 'Toàn khung' : b.layout === 'cutout' ? 'Tách nền trên đầu' : 'Thẻ nhỏ'}</span>
                {!b.assetId && b.source !== 'ai' && <span class="vs-badge vs-badge-warn">{b.layout === 'cutout' ? 'cần PNG tách nền để xuất' : 'chưa có file, dùng thẻ giữ chỗ'}</span>}
              </div>
            </div>
            <button
              type="button"
              class="vs-btn vs-broll-btn"
              disabled={readOnly || savingPlan.value > 0}
              aria-pressed={b.enabled}
              onClick={() => void setBroll(b.id, !b.enabled)}
            >{b.enabled ? 'Bỏ' : 'Bật'}</button>
          </article>
        );
      })}
    </div>
  );
}
