// Tab Hiệu ứng: overlays, zooms, music and sound effects of the plan. "Góp ý" pins a mark of kind effect.
import { MessageSquarePlus } from 'lucide-preact';
import { formatTimeDec } from '@modules/video/web/lib/video-edit/format';
import { effectLabel } from '@modules/video/web/lib/video-edit/plan-geometry';
import { playerControls, startMark } from '@modules/video/web/lib/video-edit/editor';
import type { EditPlan } from '@modules/video/web/lib/video-edit/types';

function propsText(props: EditPlan['overlays'][number]['props']): string {
  return Object.values(props).map((v) => (Array.isArray(v) ? v.join(' · ') : String(v))).filter(Boolean).join(' / ');
}

export function EffectsTab({ plan, readOnly }: { plan: EditPlan; readOnly: boolean }) {
  const overlays = [...plan.overlays].sort((a, b) => a.at - b.at);
  return (
    <div class="vs-ed-list">
      {overlays.length === 0 && <p class="vs-muted vs-ed-empty">Chưa có hiệu ứng chữ nào.</p>}
      <ol class="vs-fx-list">
        {overlays.map((o) => (
          <li key={o.id} class="vs-ed-card vs-fx">
            <button type="button" class="vs-tr-time" onClick={() => playerControls.seek(o.at)} title="Tới hiệu ứng này">{formatTimeDec(o.at)}</button>
            <span class="vs-fx-main">
              <b>{effectLabel(o.effect)}</b>
              <span class="vs-muted vs-fx-text">{propsText(o.props) || '—'}</span>
            </span>
            <button
              type="button"
              class="vs-btn vs-fx-btn"
              disabled={readOnly}
              onClick={() => startMark({ start: o.at, end: o.at + o.duration, kind: 'effect', note: `${effectLabel(o.effect)}: ` })}
            ><MessageSquarePlus size={14} aria-hidden="true" /> Góp ý</button>
          </li>
        ))}
      </ol>
      <dl class="vs-fx-sum">
        <div><dt>Zoom</dt><dd>{plan.zooms.length} lần</dd></div>
        <div><dt>Nhạc</dt><dd>{plan.music ? `${plan.music.mood}, ${plan.music.gainDb} dB${plan.music.duck ? ', tự nhỏ khi có lời' : ''}` : 'Không dùng'}</dd></div>
        <div><dt>Tiếng động</dt><dd>{plan.sfx.length} chỗ</dd></div>
        <div><dt>Phụ đề</dt><dd>{plan.captions.position === 'bottom' ? 'Dưới' : plan.captions.position === 'middle' ? 'Giữa' : 'Sau lưng người'} · tối đa {plan.captions.maxWordsPerChunk} từ/cụm · tô {plan.captions.highlight.length} từ khoá</dd></div>
      </dl>
    </div>
  );
}
