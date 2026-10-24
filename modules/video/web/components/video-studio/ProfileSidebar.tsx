// Left column: channel profiles, their jobs, engine/doctor status.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ChevronDown, ChevronRight, Library, MoreHorizontal, Pencil, Plus, Trash2, Loader2 } from 'lucide-preact';
import { ConfirmModal } from '@/components/ConfirmModal';
import { Modal } from '@/components/Modal';
import { readableOn } from '@modules/video/web/lib/video-edit/format';
import {
  activeAgentId, agentById, agents, deleteProject, doctor, doctorModal, libraryModal, newJob, profileModal, profiles,
  profilesLoaded, projectLists, renameProject, selectedProfileId, selectedProjectId, selectProfile,
  selectProject,
} from '@modules/video/web/lib/video-edit/studio';
import type { VideoProfile, VideoProjectSummary } from '@modules/video/web/lib/video-edit/types';

export function ProfileSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<VideoProjectSummary | null>(null);
  const [deleting, setDeleting] = useState<VideoProjectSummary | null>(null);
  const list = profiles.value;
  const activeId = selectedProfileId.value;

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement | null)?.closest?.('.vs-row-menu, .vs-row-more')) setMenu(null);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc); };
  }, [menu]);

  return (
    <nav class="vs-side" aria-label="Hồ sơ thương hiệu và việc dựng">
      <div class="vs-side-top">
        <button type="button" class="vs-btn vs-btn-accent vs-btn-block" onClick={() => { newJob(); onNavigate?.(); }}>
          <Plus size={16} aria-hidden="true" /> Việc mới
        </button>
      </div>
      <div class="vs-side-scroll">
        <div class="vs-eyebrow">Hồ sơ thương hiệu</div>
        {!profilesLoaded.value && <div class="vs-skel" role="status" aria-label="Đang tải hồ sơ"><span /><span /></div>}
        {profilesLoaded.value && list.length === 0 && (
          <p class="vs-muted vs-side-empty">Chưa có hồ sơ thương hiệu. Tạo một hồ sơ để agent biết gu dựng của bạn.</p>
        )}
        {list.map((p) => (
          <ProfileRow
            key={p.id}
            profile={p}
            active={p.id === activeId}
            menu={menu}
            setMenu={setMenu}
            onRename={setRenaming}
            onDelete={setDeleting}
            onNavigate={onNavigate}
          />
        ))}
        <button type="button" class="vs-side-add" onClick={() => { profileModal.value = { mode: 'create' }; onNavigate?.(); }}>
          <Plus size={14} aria-hidden="true" /> Tạo hồ sơ thương hiệu
        </button>
      </div>
      <div class="vs-side-foot">
        <button type="button" class="vs-btn vs-btn-block" onClick={() => { libraryModal.value = true; onNavigate?.(); }}>
          <Library size={14} aria-hidden="true" /> Quản lý kho
        </button>
      </div>
      <StatusCard />
      <RenameModal job={renaming} onClose={() => setRenaming(null)} />
      <ConfirmModal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => { if (deleting) void deleteProject(deleting.id); }}
        title="Xoá việc dựng?"
        body={deleting ? `"${deleting.title}" sẽ bị xoá cùng video, kế hoạch và lịch sử chat.` : undefined}
        confirmLabel="Xoá"
        cancelLabel="Giữ lại"
        destructive
      />
    </nav>
  );
}

function ProfileRow({ profile, active, menu, setMenu, onRename, onDelete, onNavigate }: {
  profile: VideoProfile;
  active: boolean;
  menu: string | null;
  setMenu: (id: string | null) => void;
  onRename: (p: VideoProjectSummary) => void;
  onDelete: (p: VideoProjectSummary) => void;
  onNavigate?: () => void;
}) {
  const jobs = projectLists.value[profile.id] ?? [];
  const count = profile.projectCount ?? jobs.length;
  return (
    <div class={`vs-profile${active ? ' is-active' : ''}`}>
      <button
        type="button"
        class="vs-profile-head"
        aria-expanded={active}
        onClick={() => void selectProfile(profile.id)}
      >
        <span class="vs-tile" style={{ background: profile.color, color: readableOn(profile.color) }} aria-hidden="true">{profile.initials}</span>
        <span class="vs-profile-text">
          <span class="vs-profile-name">{profile.name}</span>
        </span>
        <span class="vs-profile-count" aria-label={`${count} việc`}>{count}</span>
        {active ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      </button>
      {active && (
        <div class="vs-jobs">
          {jobs.length === 0 && <p class="vs-muted vs-jobs-empty">Chưa có việc nào.</p>}
          {jobs.map((j) => (
            <div key={j.id} class={`vs-job${j.id === selectedProjectId.value ? ' is-active' : ''}`}>
              <button
                type="button"
                class="vs-job-main"
                title={`${j.code} · ${j.title}`}
                aria-current={j.id === selectedProjectId.value ? 'true' : undefined}
                onClick={() => { void selectProject(j.id); onNavigate?.(); }}
              >
                {j.busy ? <Loader2 size={12} class="vs-spin" aria-label="Đang chạy" /> : <span class={`vs-dot vs-dot-${j.status}`} aria-hidden="true" />}
                <span class="vs-job-title">{j.title}</span>
              </button>
              <button
                type="button"
                class="vs-row-more"
                aria-label={`Tuỳ chọn cho ${j.title}`}
                aria-haspopup="menu"
                aria-expanded={menu === j.id}
                onClick={() => setMenu(menu === j.id ? null : j.id)}
              >
                <MoreHorizontal size={15} aria-hidden="true" />
              </button>
              {menu === j.id && (
                <div class="vs-row-menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => { setMenu(null); onRename(j); }}><Pencil size={13} aria-hidden="true" /> Đổi tên</button>
                  <button type="button" role="menuitem" class="is-danger" onClick={() => { setMenu(null); onDelete(j); }}><Trash2 size={13} aria-hidden="true" /> Xoá</button>
                </div>
              )}
            </div>
          ))}
          <button
            type="button"
            class="vs-link"
            onClick={() => { profileModal.value = { mode: 'edit', tab: 'info' }; onNavigate?.(); }}
          >
            Hồ sơ, gu, học từ video →
          </button>
        </div>
      )}
    </div>
  );
}

function RenameModal({ job, onClose }: { job: VideoProjectSummary | null; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (job) { setTitle(job.title); setTimeout(() => ref.current?.select(), 30); } }, [job?.id]);
  if (!job) return null;
  const submit = () => { if (title.trim()) { void renameProject(job.id, title); onClose(); } };
  return (
    <Modal
      open
      onClose={onClose}
      title="Đổi tên việc"
      width={420}
      footer={<>
        <button type="button" class="vs-btn" onClick={onClose}>Huỷ</button>
        <button type="button" class="vs-btn vs-btn-accent ml-auto" disabled={!title.trim()} onClick={submit}>Lưu</button>
      </>}
    >
      <label class="vs-field">
        <span>Tên việc</span>
        <input ref={ref} class="vs-input" maxLength={120} value={title} onInput={(e) => setTitle(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.isComposing) submit(); }} />
      </label>
    </Modal>
  );
}

function StatusCard() {
  const d = doctor.value;
  const agent = agentById(activeAgentId()) ?? agents.value.find((a) => a.isDefault) ?? agents.value[0];
  const engineChecks = d?.checks.filter((c) => /engine|claude|codex/i.test(c.id)) ?? [];
  const engineBad = engineChecks.some((c) => !c.ok);
  const engineTone = !agent ? 'warn' : engineBad ? 'bad' : 'ok';
  const engineText = !agent ? 'Chưa có agent' : engineBad ? `${agent.engineLabel} chưa sẵn sàng` : `${agent.engineLabel} sẵn sàng · ${agent.name}`;
  const doctorTone = !d ? 'idle' : !d.requiredOk ? 'bad' : d.ok < d.total ? 'warn' : 'ok';
  return (
    <div class="vs-status" role="status">
      <div class="vs-status-line"><span class={`vs-led vs-led-${engineTone}`} aria-hidden="true" /><span class="vs-status-text">{engineText}</span></div>
      <button type="button" class="vs-status-line vs-status-btn" onClick={() => { doctorModal.value = true; }} aria-label="Mở kiểm tra máy">
        <span class={`vs-led vs-led-${doctorTone}`} aria-hidden="true" />
        <span class="vs-status-text">{d ? `Máy ổn ${d.ok}/${d.total} mục` : 'Kiểm tra máy…'}</span>
      </button>
      <div class="vs-status-line"><span class="vs-led vs-led-idle" aria-hidden="true" /><span class="vs-status-text vs-muted">Video Studio · GĐ1</span></div>
    </div>
  );
}
