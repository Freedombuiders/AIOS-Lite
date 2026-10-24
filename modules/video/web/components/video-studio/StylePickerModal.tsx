// "Phong cách dựng": style packs grouped by tab; picking one sets the project (or pending) style.
import { useState } from 'preact/hooks';
import { Check } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { activeStyleId, chooseStyle, styleGroups, styleModal, styles } from '@modules/video/web/lib/video-edit/studio';
import type { VideoStyle } from '@modules/video/web/lib/video-edit/types';

export function StylePickerModal() {
  const [group, setGroup] = useState<string>('');
  if (!styleModal.value) return null;
  const groups = styleGroups.value;
  const current = group || groups[0]?.id || '';
  const list = styles.value.filter((s) => s.group === current);
  const active = activeStyleId();
  const pick = async (id: string | null) => { styleModal.value = false; await chooseStyle(id); };
  return (
    <Modal
      open
      onClose={() => { styleModal.value = false; }}
      title="Phong cách dựng"
      width={880}
      footer={
        <>
          <button type="button" class="vs-btn" disabled={!active} onClick={() => void pick(null)}>Bỏ chọn phong cách</button>
          <button type="button" class="vs-btn ml-auto" onClick={() => { styleModal.value = false; }}>Đóng</button>
        </>
      }
    >
      <div class="vs-seg vs-seg-wrap" role="tablist" aria-label="Nhóm phong cách">
        {groups.map((g) => (
          <button key={g.id} type="button" role="tab" aria-selected={current === g.id} class={current === g.id ? 'is-active' : ''} onClick={() => setGroup(g.id)}>
            {g.label} <span class="vs-faint">{styles.value.filter((s) => s.group === g.id).length}</span>
          </button>
        ))}
      </div>
      {styles.value.length === 0 && <p class="vs-muted vs-pad">Chưa tải được danh sách phong cách.</p>}
      <div class="vs-style-grid" role="list">
        {list.map((s) => <StyleCard key={s.id} style={s} selected={s.id === active} onPick={() => void pick(s.id)} />)}
      </div>
    </Modal>
  );
}

function StyleCard({ style, selected, onPick }: { style: VideoStyle; selected: boolean; onPick: () => void }) {
  return (
    <button type="button" role="listitem" class={`vs-style${selected ? ' is-selected' : ''}`} aria-pressed={selected} onClick={onPick}>
      <span class="vs-style-preview" style={{ background: style.palette.bg, color: style.palette.text, fontFamily: style.id === 'quyen' ? 'Inter, sans-serif' : style.fontHeading }} aria-hidden="true">
        {style.id === 'quyen'
          ? <span style={{ fontSize: '15px', lineHeight: '1.3' }}>PEXELS <b style={{ color: style.palette.highlight }}>TRÊN ĐẦU</b><br />PHỤ ĐỀ VÀNG</span>
          : <span>Chốt <b style={{ color: style.palette.highlight }}>đơn</b> nhanh</span>}
      </span>
      {selected && <span class="vs-style-check" aria-label="Đang chọn"><Check size={13} aria-hidden="true" /></span>}
      <span class="vs-style-meta">
        <span class="vs-mono vs-style-cmd">{style.command}</span>
        <span class="vs-style-name">{style.name}</span>
        <span class="vs-style-for">{style.bestFor}</span>
      </span>
    </button>
  );
}
