// Slim header over the chat column: profile, title, style / aspect / agent chips, tool icons.
import { useEffect, useState } from 'preact/hooks';
import { ClipboardList, Menu, Mic, PanelRightClose, PanelRightOpen, Scissors, UserRound, Wand2 } from 'lucide-preact';
import {
  activeAgentId, activeAspect, activeStyleId, agents, briefModal, currentProfile, openEditor, patchProject, pendingAgentId,
  pendingAspect, profileModal, project, rightOpen, leftDrawerOpen, styleById, styleModal, voiceModal,
  type StudioLayout,
} from '@modules/video/web/lib/video-edit/studio';
import type { VideoAspect } from '@modules/video/web/lib/video-edit/types';

const ASPECTS: VideoAspect[] = ['9:16', '16:9', '1:1', '4:5'];

export function CenterHeader({ layout }: { layout: StudioLayout }) {
  const p = project.value;
  const profile = currentProfile();
  const style = styleById(activeStyleId());
  const [title, setTitle] = useState('');
  useEffect(() => { setTitle(p?.title ?? ''); }, [p?.id, p?.title]);

  const commitTitle = () => {
    const clean = title.trim();
    if (p && clean && clean !== p.title) void patchProject({ title: clean });
    else setTitle(p?.title ?? '');
  };

  return (
    <header class="vs-head">
      {layout === 'narrow' && (
        <button type="button" class="vs-icon-btn" aria-label="Mở danh sách hồ sơ và việc" onClick={() => { leftDrawerOpen.value = true; }}>
          <Menu size={18} aria-hidden="true" />
        </button>
      )}
      {profile && (
        <span class="vs-chip vs-chip-profile" title={`Hồ sơ thương hiệu: ${profile.name}`}>
          <span class="vs-chip-dot" style={{ background: profile.color }} aria-hidden="true" />
          <span class="vs-chip-text">{profile.name}</span>
        </span>
      )}
      {p ? (
        <input
          class="vs-title-input"
          aria-label="Tên việc"
          value={title}
          maxLength={120}
          onInput={(e) => setTitle(e.currentTarget.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.isComposing) e.currentTarget.blur();
            if (e.key === 'Escape') { setTitle(p.title); e.currentTarget.blur(); }
          }}
        />
      ) : (
        <span class="vs-title-ghost">Việc mới</span>
      )}
      <div class="vs-head-chips">
        <button type="button" class="vs-chip vs-chip-btn" onClick={() => { styleModal.value = true; }} title="Chọn phong cách dựng">
          <Wand2 size={13} aria-hidden="true" />
          <span class="vs-chip-text">{style ? <><span class="vs-mono">{style.command}</span> {style.name}</> : 'Phong cách'}</span>
        </button>
        {p && style?.brief && style.brief.length > 0 && (
          <button type="button" class="vs-chip vs-chip-btn" onClick={() => { briefModal.value = true; }} title={`Thông tin bổ sung cho ${style.command}`}>
            <ClipboardList size={13} aria-hidden="true" />
            <span class="vs-chip-text">Thông tin{p.brief && Object.keys(p.brief).length > 0 ? ` (${Object.keys(p.brief).length})` : ''}</span>
          </button>
        )}
        <label class="vs-chip vs-chip-select">
          <span class="sr-only">Tỉ lệ khung hình</span>
          <select
            value={activeAspect()}
            onChange={(e) => {
              const v = e.currentTarget.value as VideoAspect;
              if (p) void patchProject({ aspect: v }); else pendingAspect.value = v;
            }}
          >
            {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label class="vs-chip vs-chip-select">
          <span class="sr-only">Agent dựng</span>
          <select
            value={activeAgentId()}
            disabled={agents.value.length === 0 || !!p?.busy}
            onChange={(e) => {
              const v = e.currentTarget.value;
              if (p) void patchProject({ agentId: v }); else pendingAgentId.value = v;
            }}
          >
            {agents.value.length === 0 && <option value={activeAgentId()}>{activeAgentId() || 'Agent'}</option>}
            {agents.value.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.engineLabel}</option>)}
          </select>
        </label>
      </div>
      <div class="vs-head-tools">
        {p?.plan && (
          <button type="button" class="vs-btn vs-btn-accent vs-head-edit" onClick={openEditor}>
            <Scissors size={14} aria-hidden="true" /> Mở màn chỉnh sửa
          </button>
        )}
        <button type="button" class="vs-icon-btn" aria-label="Giọng nói AI" title="Giọng nói AI" onClick={() => { voiceModal.value = true; }}>
          <Mic size={17} aria-hidden="true" />
        </button>
        <button type="button" class="vs-icon-btn" aria-label="Hồ sơ thương hiệu" title="Hồ sơ thương hiệu" onClick={() => { profileModal.value = profile ? { mode: 'edit' } : { mode: 'create' }; }}>
          <UserRound size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          class="vs-icon-btn"
          aria-label={rightOpen.value ? 'Ẩn bảng bên phải' : 'Hiện bảng bên phải'}
          aria-pressed={rightOpen.value}
          title={rightOpen.value ? 'Ẩn bảng bên phải' : 'Hiện bảng bên phải'}
          onClick={() => { rightOpen.value = !rightOpen.value; }}
        >
          {rightOpen.value ? <PanelRightClose size={17} aria-hidden="true" /> : <PanelRightOpen size={17} aria-hidden="true" />}
        </button>
      </div>
    </header>
  );
}
