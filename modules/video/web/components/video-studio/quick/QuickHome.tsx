// Dựng nhanh › Trang đầu: the channel's videos, the raw-footage drop zone, a note and the template library.
// "Tiếp tục thiết lập" creates the project (flow quick) and starts the upload, then opens Thiết lập.
import { useRef, useState } from 'preact/hooks';
import { ArrowRight, Plus, Upload, Video } from 'lucide-preact';
import { errorMessage, mediaUrl } from '@modules/video/web/lib/video-edit/api';
import { formatBytes, formatClock } from '@modules/video/web/lib/video-edit/format';
import { quickApi } from '@modules/video/web/lib/video-edit/quick-api';
import {
  currentProfile, defaultAgentId, newJob, profileModal, profiles, profilesLoaded, project, projectLists, refreshProjects,
  selectedProfileId, selectedProjectId, selectProfile, selectProject, uploadFile,
} from '@modules/video/web/lib/video-edit/studio';
import type { VideoProjectSummary } from '@modules/video/web/lib/video-edit/types';
import { defaultTemplateId, projectStatus } from './quick-model';
import { patchDraft, quickDraft, templateById, templates } from './quick-state';
import { TemplateLibrary } from './TemplateLibrary';

const VIDEO_FILE = /\.(mp4|mov|m4v|webm|mkv)$/i;
const isVideo = (f: File) => f.type.startsWith('video/') || VIDEO_FILE.test(f.name);

function ProjectRow({ p, onOpen }: { p: VideoProjectSummary; onOpen: (id: string) => void }) {
  const status = projectStatus(p);
  const [thumb, setThumb] = useState(p.hasSource);
  return <li>
    <button type="button" class={`vs-dn-project${selectedProjectId.value === p.id ? ' is-active' : ''}`} onClick={() => onOpen(p.id)}>
      <span class="vs-dn-project-thumb" aria-hidden="true">
        {thumb && <img src={mediaUrl(p.id, 'thumb', p.updatedAt)} alt="" loading="lazy" onError={() => setThumb(false)} />}
      </span>
      <span class="vs-dn-project-text">
        <span class="vs-dn-project-title">{p.title}</span>
        <span class="vs-dn-project-meta">{p.durationSec ? formatClock(p.durationSec) : 'Chưa có video'} · {p.code}</span>
        <span class={`vs-dn-status is-${status.tone}`}><span aria-hidden="true" />{status.label}</span>
      </span>
    </button>
  </li>;
}

export function QuickHome({ onSetup, onOpen }: { onSetup: (projectId: string) => void; onOpen: (projectId: string) => void }) {
  const draft = quickDraft.value;
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const profile = currentProfile();
  const list = profile ? projectLists.value[profile.id] ?? [] : [];
  const templateId = draft.templateId ?? defaultTemplateId(templates.value);
  const template = templateById(templateId);

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    if (!isVideo(file)) { setError('Chỉ nhận video MP4, MOV, M4V, WebM hoặc MKV.'); return; }
    setError('');
    patchDraft({ file });
  };

  const start = async () => {
    const file = draft.file;
    if (!file || !templateId || busy) return;
    if (!profile) { profileModal.value = { mode: 'create' }; return; }
    setBusy(true);
    setError('');
    try {
      const { project: created } = await quickApi.createProject({
        profileId: profile.id,
        title: file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Video mới',
        aspect: profile.defaultAspect,
        ...(profile.defaultStyleId ? { styleId: profile.defaultStyleId } : {}),
        ...(defaultAgentId.value ? { agentId: defaultAgentId.value } : {}),
      });
      await selectProject(created.id);
      if (project.value?.id !== created.id) throw new Error('Không mở được dự án vừa tạo. Hãy thử lại.');
      void refreshProjects(profile.id);
      patchDraft({ file: null, templateId, projectId: created.id });
      onSetup(created.id);
      // The chain (nhận video → chép lời → soi chỗ lặng) runs while the owner fills Thiết lập.
      void uploadFile(file);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const newVideo = () => {
    newJob();
    patchDraft({ file: null, note: '', projectId: null });
    setError('');
  };

  return <div class="vs-dn-home">
    <aside class="vs-dn-projects" aria-label="Dự án">
      <div class="vs-dn-channel">
        {profiles.value.length > 0 ? <label>
          <span class="vs-muted">Kênh:</span>
          <select class="vs-input" value={selectedProfileId.value ?? ''} onChange={(e) => void selectProfile(e.currentTarget.value)}>
            {profiles.value.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label> : profilesLoaded.value && <button type="button" class="vs-btn vs-btn-block" onClick={() => { profileModal.value = { mode: 'create' }; }}>
          <Plus size={14} aria-hidden="true" /> Tạo hồ sơ kênh
        </button>}
      </div>
      <button type="button" class="vs-dn-new" onClick={newVideo}><Plus size={16} strokeWidth={2.4} aria-hidden="true" /> Video mới</button>
      <div class="vs-eyebrow">Gần đây</div>
      {list.length ? <ul class="vs-dn-project-list">
        {list.map((p) => <ProjectRow key={p.id} p={p} onOpen={onOpen} />)}
      </ul> : <p class="vs-muted vs-dn-empty">{profile ? 'Chưa có video nào. Thả video quay thô vào khung bên cạnh để bắt đầu.' : 'Tạo hồ sơ kênh để lưu các video của bạn.'}</p>}
    </aside>

    <div class="vs-dn-main">
      <section class="vs-dn-hero" aria-labelledby="vs-dn-hero-title">
        <div>
          <h2 id="vs-dn-hero-title" class="vs-dn-title">Dựng video từ footage thô</h2>
          <p class="vs-muted vs-dn-lead">Thêm video quay thô và chọn một mẫu edit. AI dựng xong, bạn chỉnh tay.</p>
        </div>

        <div
          class={`vs-dn-drop${dragging ? ' is-over' : ''}${draft.file ? ' has-file' : ''}`}
          onDragOver={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); pickFile(Array.from(e.dataTransfer?.files ?? [])[0]); }}
        >
          <span class="vs-dn-drop-icon" aria-hidden="true">{draft.file ? <Video size={24} /> : <Upload size={24} />}</span>
          {draft.file ? <>
            <strong class="vs-dn-file-name">{draft.file.name}</strong>
            <span class="vs-muted">{formatBytes(draft.file.size)} · tải lên khi bạn bấm Tiếp tục thiết lập</span>
            <button type="button" class="vs-btn" onClick={() => fileInput.current?.click()}>Đổi video</button>
          </> : <>
            <strong>Kéo thả video quay thô vào đây</strong>
            <span class="vs-muted">MP4, MOV hoặc WebM. Video không rời máy của bạn.</span>
            <button type="button" class="vs-btn" onClick={() => fileInput.current?.click()}>Chọn video</button>
          </>}
          <input ref={fileInput} type="file" accept="video/*,.mkv,.m4v" hidden onChange={(e) => { pickFile(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
        </div>

        <label class="vs-dn-field">
          <span>Bạn muốn edit thế nào? <span class="vs-muted">(không bắt buộc)</span></span>
          <textarea class="vs-input" rows={2} placeholder="Ví dụ: giữ đoạn mở đầu, nhấn mạnh 3 bước, thêm logo cuối video…"
            value={draft.note} onInput={(e) => patchDraft({ note: e.currentTarget.value })} />
        </label>

        <div class="vs-dn-cta">
          <span class="vs-muted">Mẫu đang chọn:</span>
          <span class="vs-dn-pill">
            <span class="vs-dn-swatch" style={{ background: template?.sample?.color }} aria-hidden="true" />
            {template?.name ?? 'Chưa chọn mẫu'}
          </span>
          <button type="button" class="vs-btn vs-btn-accent vs-dn-primary" disabled={!draft.file || !templateId || busy} onClick={() => void start()}>
            {busy ? 'Đang tạo dự án…' : 'Tiếp tục thiết lập'} <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
        {!draft.file && <p class="vs-faint vs-dn-hint">Chọn video trước, rồi bấm Tiếp tục thiết lập.</p>}
        {error && <div class="vs-error" role="alert">{error}</div>}
      </section>

      <TemplateLibrary selectedId={templateId} onPick={(t) => patchDraft({ templateId: t.id })} />
    </div>
  </div>;
}
