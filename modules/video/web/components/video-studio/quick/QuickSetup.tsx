// Dựng nhanh › Thiết lập: six steps (video, tự cắt, mẫu, tư liệu, nhạc, ghi chú), the "AI sẽ làm" column,
// and the two ways out: "Bỏ qua — tự chỉnh tay" (mode manual) and "AI edit" (POST /projects/:id/ai-edit).
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  Check, ChevronLeft, Film, Images, LayoutTemplate, Loader2, Music, Pencil, Play, Plus, RefreshCw, Scissors, Sparkles, Upload, X,
} from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { Toggle } from '@/components/Toggle';
import { errorMessage, uploadLibraryAsset, videoEditApi } from '@modules/video/web/lib/video-edit/api';
import { formatClock } from '@modules/video/web/lib/video-edit/format';
import { assetFileUrl } from '@modules/video/web/lib/video-edit/library-api';
import { aiEditBody, quickApi, type QuickForm } from '@modules/video/web/lib/video-edit/quick-api';
import { applyProject, project, projectJobs, upload, uploadFile } from '@modules/video/web/lib/video-edit/studio';
import type { QuickSettings, VideoAsset, VideoProject } from '@modules/video/web/lib/video-edit/types';
import {
  aiPlanLines, CUT_LEVELS, defaultForm, defaultTemplateId, formatSeconds, formFromQuick, MUSIC_MODES, setupSummary,
} from './quick-model';
import { loadTemplates, quickDraft, templateById, templates } from './quick-state';
import { TemplateLibrary, TemplateThumb } from './TemplateLibrary';

interface AssetRow {
  key: string;
  name: string;
  kind: 'image' | 'video';
  status: 'uploading' | 'ready' | 'failed';
  assetId?: string;
  hint: string;
  durationSec?: number;
  file?: File;
}

const RATIOS: [string, number][] = [['9:16', 9 / 16], ['16:9', 16 / 9], ['1:1', 1], ['4:5', 4 / 5]];

function videoMeta(p: VideoProject): string {
  const src = p.source;
  if (!src) return '';
  const turned = src.rotation === 90 || src.rotation === 270;
  const w = turned ? src.height : src.width;
  const h = turned ? src.width : src.height;
  const shape = h > w ? 'dọc' : w > h ? 'ngang' : 'vuông';
  const ratio = RATIOS.find(([, r]) => Math.abs(w / h - r) / r < 0.03)?.[0];
  return `${formatSeconds(src.durationSec)} · ${w}×${h} · ${shape}${ratio ? ` ${ratio}` : ''}`;
}

const fileKind = (f: File): AssetRow['kind'] | null =>
  f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/i.test(f.name) ? 'image'
    : f.type.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(f.name) ? 'video' : null;

function Step({ icon, title, last, children }: { icon: ComponentChildren; title: ComponentChildren; last?: boolean; children: ComponentChildren }) {
  return <li class="vs-dn-step">
    <div class="vs-dn-step-rail" aria-hidden="true">
      <span class="vs-dn-step-icon">{icon}</span>
      {!last && <span class="vs-dn-step-line" />}
    </div>
    <section class="vs-dn-step-body">
      <h3 class="vs-dn-step-title">{title}</h3>
      {children}
    </section>
  </li>;
}

export function QuickSetup({ onHome, onStarted }: { onHome: () => void; onStarted: () => void }) {
  const p = project.value as VideoProject;
  const draft = quickDraft.value;
  const [form, setForm] = useState<QuickForm>(() => (p.quick
    ? formFromQuick(p.quick)
    : defaultForm(draft.templateId ?? defaultTemplateId(templates.value), draft.projectId === p.id ? draft.note : '')));
  const [rows, setRows] = useState<AssetRow[]>(() => (p.quick?.assets ?? []).map((a) => ({
    key: a.assetId, name: a.assetId, kind: 'image', status: 'ready', assetId: a.assetId, hint: a.hint ?? '',
  })));
  const [tracks, setTracks] = useState<VideoAsset[] | null>(null);
  const [tracksError, setTracksError] = useState('');
  const [picking, setPicking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState<QuickSettings['mode'] | null>(null);
  const [error, setError] = useState('');
  const videoInput = useRef<HTMLInputElement>(null);
  const assetInput = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);

  const set = (patch: Partial<QuickForm>) => setForm((f) => ({ ...f, ...patch }));
  const setMusic = (patch: Partial<QuickForm['music']>) => setForm((f) => ({ ...f, music: { ...f.music, ...patch } }));
  const patchRow = (key: string, patch: Partial<AssetRow>) => setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  // The template list may arrive after this screen opens.
  useEffect(() => {
    if (!form.templateId && templates.value.length) set({ templateId: defaultTemplateId(templates.value) });
  }, [templates.value]);

  // Reopened after an AI edit: name the footage that was sent last time.
  useEffect(() => {
    if (!rows.some((r) => r.name === r.assetId)) return;
    void videoEditApi.assets().then(({ assets }) => {
      const byId = new Map(assets.map((a) => [a.id, a]));
      setRows((list) => list.map((r) => {
        const a = r.assetId ? byId.get(r.assetId) : undefined;
        return a ? { ...r, name: a.name, kind: a.kind === 'video' ? 'video' : 'image', durationSec: a.durationSec } : r;
      }));
    }).catch(() => { /* ids stay as names */ });
  }, []);

  useEffect(() => {
    if (form.music.mode !== 'pick' || tracks) return;
    void videoEditApi.assets({ kind: 'bgm' })
      .then(({ assets }) => setTracks(assets.filter((a) => a.available !== false && a.enabled !== false)))
      .catch((e) => { setTracks([]); setTracksError(errorMessage(e)); });
  }, [form.music.mode]);

  const sendFile = (key: string, file: File, kind: AssetRow['kind']) => {
    patchRow(key, { status: 'uploading' });
    uploadLibraryAsset(file, kind)
      .then((asset) => patchRow(key, asset ? { status: 'ready', assetId: asset.id, durationSec: asset.durationSec } : { status: 'failed' }))
      .catch(() => patchRow(key, { status: 'failed' }));
  };

  const addFiles = (files: File[]) => {
    const added: AssetRow[] = [];
    for (const file of files) {
      const kind = fileKind(file);
      if (!kind) continue;
      added.push({ key: `new-${nextKey.current++}`, name: file.name, kind, status: 'uploading', hint: '', file });
    }
    if (added.length < files.length) setError('Tư liệu chỉ nhận ảnh hoặc video. Một số file đã bị bỏ qua.');
    if (!added.length) return;
    setRows((list) => [...list, ...added]);
    for (const row of added) sendFile(row.key, row.file!, row.kind);
  };

  const template = templateById(form.templateId);
  const ready = rows.filter((r) => r.status === 'ready' && r.assetId);
  const current: QuickForm = { ...form, assets: ready.map((r) => ({ assetId: r.assetId!, hint: r.hint })) };
  const uploading = !p.source && !!upload.value;
  const transcribe = p.steps.find((s) => s.key === 'transcribe');
  const failedStep = p.steps.find((s) => (s.key === 'ingest' || s.key === 'transcribe') && s.status === 'failed');

  const blocker = !p.source ? (uploading ? 'Đợi video tải lên xong.' : 'Tải video lên trước.')
    : rows.some((r) => r.status === 'uploading') ? 'Đợi tư liệu tải lên xong.'
      : !form.templateId ? 'Chọn một mẫu edit.'
        : form.music.mode === 'pick' && !form.music.assetId ? 'Chọn một bài nhạc hoặc để AI chọn.'
          : p.busy ? 'AI đang chạy một lượt khác trên video này. Chờ xong hoặc bấm Dừng.' : '';

  const submit = async (mode: QuickSettings['mode']) => {
    if (blocker || submitting) { if (blocker) setError(blocker); return; }
    setSubmitting(mode);
    setError('');
    try {
      const body = aiEditBody(current, mode);
      const chosen = templateById(body.templateId);
      // Using a template installs it (GĐ1 keeps a list only); a failure here must not block the edit.
      if (chosen && !chosen.installed) await quickApi.installTemplate(chosen.id).then(() => loadTemplates(true)).catch(() => undefined);
      const r = await quickApi.aiEdit(p.id, body);
      applyProject(r.project);
      if (r.job) projectJobs.value = { ...projectJobs.value, [r.job.id]: r.job };
      onStarted();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(null);
    }
  };

  const level = CUT_LEVELS.find((l) => l.id === form.cutLevel) ?? CUT_LEVELS[1];
  const pickedTrack = tracks?.find((t) => t.id === form.music.assetId);

  return <div class="vs-dn-page">
    <div class="vs-dn-bar">
      <button type="button" class="vs-dn-back" onClick={onHome}><ChevronLeft size={16} aria-hidden="true" /> Trang đầu</button>
      <span class="vs-dn-crumb">Dựng nhanh › {p.title}</span>
    </div>

    <div class="vs-dn-layout">
      <div class="vs-dn-form">
        <h2 class="vs-dn-title">Thiết lập trước khi AI edit</h2>
        <p class="vs-muted vs-dn-lead">Chỉ phần Video là bắt buộc. Mọi thứ khác để trống thì AI tự quyết theo mẫu.</p>

        <ol class="vs-dn-steps">
          <Step icon={<Film size={18} />} title="Video">
            <div class="vs-dn-box vs-dn-video">
              <span class="vs-dn-video-thumb" aria-hidden="true"><Film size={18} /></span>
              <div class="vs-dn-video-text">
                {p.source ? <>
                  <strong class="vs-dn-file-name">{p.source.fileName}</strong>
                  <span class="vs-muted">{videoMeta(p)}</span>
                  {failedStep ? <span class="vs-dn-state is-failed" role="alert">{failedStep.error || 'Máy chưa xử lý được video này.'}</span>
                    : <span class="vs-dn-state is-done"><Check size={14} strokeWidth={3} aria-hidden="true" />
                      {transcribe?.status === 'done' ? 'Đã tải lên và chép lời xong' : 'Đã tải lên, máy đang chép lời trong nền'}</span>}
                </> : uploading ? <>
                  <strong class="vs-dn-file-name">{upload.value!.name}</strong>
                  <span class="vs-muted">Đang tải lên… {Math.round(upload.value!.fraction * 100)}%</span>
                  <span class="vs-bar" role="progressbar" aria-label="Tải video lên" aria-valuenow={Math.round(upload.value!.fraction * 100)} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: `${Math.round(upload.value!.fraction * 100)}%` }} />
                  </span>
                </> : <>
                  <strong>Chưa có video</strong>
                  <span class="vs-muted">Chọn video quay thô (MP4, MOV hoặc WebM).</span>
                </>}
              </div>
              <button type="button" class="vs-btn" disabled={uploading || p.busy} onClick={() => videoInput.current?.click()}>
                {p.source ? 'Đổi video' : <><Upload size={14} aria-hidden="true" /> Chọn video</>}
              </button>
              <input ref={videoInput} type="file" accept="video/*,.mkv,.m4v" hidden onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) void uploadFile(f); }} />
            </div>
          </Step>

          <Step icon={<Scissors size={18} />} title="Cắt video">
            <div class="vs-dn-box vs-dn-stack">
              <div class="vs-dn-switch">
                <div>
                  <span class="vs-eyebrow">Tự cắt</span>
                  <strong>Cắt chỗ vấp, nói lặp và khoảng lặng</strong>
                </div>
                <Toggle on={form.autoCut} onChange={() => set({ autoCut: !form.autoCut })} ariaLabel="Tự cắt chỗ vấp, nói lặp và khoảng lặng" />
              </div>
              {form.autoCut && <>
                <div class="vs-dn-levels">
                  <span class="vs-muted">Mức cắt</span>
                  <div class="vs-seg vs-dn-seg" role="group" aria-label="Mức cắt">
                    {CUT_LEVELS.map((l) => <button key={l.id} type="button" aria-pressed={form.cutLevel === l.id} class={form.cutLevel === l.id ? 'is-active' : ''} onClick={() => set({ cutLevel: l.id })}>{l.label}</button>)}
                  </div>
                  <span class="vs-muted vs-dn-small">{level.hint}</span>
                </div>
                <p class="vs-muted vs-dn-small">Khi bạn nói lại một câu, AI giữ lần nói tốt nhất. Mỗi chỗ cắt hiện trong lời chép để bạn bật lại được.</p>
              </>}
            </div>
          </Step>

          <Step icon={<LayoutTemplate size={18} />} title="Áp dụng mẫu edit">
            <div class="vs-dn-box vs-dn-template">
              {template ? <TemplateThumb template={template} small /> : <span class="vs-dn-thumb is-small" aria-hidden="true" />}
              <div class="vs-dn-template-text">
                <span class="vs-eyebrow">Mẫu</span>
                <strong>{template?.name ?? 'Chưa chọn mẫu'}</strong>
                {template && <p class="vs-muted">{template.description}</p>}
              </div>
              <button type="button" class="vs-btn" onClick={() => setPicking(true)}><Pencil size={14} aria-hidden="true" /> Đổi mẫu</button>
            </div>
          </Step>

          <Step icon={<Images size={18} />} title={<>Thêm tư liệu <span class="vs-muted vs-dn-optional">(cảnh trám, ảnh · không bắt buộc)</span></>}>
            <div class="vs-dn-box vs-dn-stack">
              {rows.map((r) => <div key={r.key} class="vs-dn-asset">
                <span class="vs-dn-asset-thumb" aria-hidden="true">
                  {r.kind === 'image' && r.assetId ? <img src={assetFileUrl(r.assetId)} alt="" loading="lazy" /> : r.kind === 'video' ? <Play size={16} fill="currentColor" /> : <Images size={16} />}
                </span>
                <div class="vs-dn-asset-name">
                  <strong title={r.name}>{r.name}</strong>
                  <span class="vs-dn-tag">{r.kind === 'image' ? 'Ảnh' : `Video${r.durationSec ? ` · ${formatClock(r.durationSec)}` : ''}`}</span>
                  {r.status === 'uploading' && <span class="vs-muted vs-dn-small" role="status"><Loader2 size={12} class="vs-spin" aria-hidden="true" /> Đang tải lên…</span>}
                  {r.status === 'failed' && <span class="vs-dn-state is-failed">Chưa tải lên được.{r.file && <button type="button" class="vs-dn-linkbtn" onClick={() => sendFile(r.key, r.file!, r.kind)}><RefreshCw size={12} aria-hidden="true" /> Thử lại</button>}</span>}
                </div>
                <label class="vs-dn-asset-hint">
                  <span>Mô tả cho AI</span>
                  <textarea class={`vs-input${r.hint.trim() ? ' has-text' : ''}`} rows={2} value={r.hint}
                    placeholder="Ví dụ: chèn khi nói “gửi video vừa quay”. Để trống: AI tự chọn chỗ hợp."
                    onInput={(e) => patchRow(r.key, { hint: e.currentTarget.value })} />
                </label>
                <button type="button" class="vs-icon-btn vs-dn-remove" aria-label={`Bỏ ${r.name}`} onClick={() => setRows((list) => list.filter((x) => x.key !== r.key))}><X size={16} aria-hidden="true" /></button>
              </div>)}

              <button type="button" class={`vs-dn-add${dragging ? ' is-over' : ''}`} onClick={() => assetInput.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(Array.from(e.dataTransfer?.files ?? [])); }}>
                <Plus size={16} aria-hidden="true" /> Thêm file · kéo thả nhiều ảnh hoặc video vào đây
              </button>
              <input ref={assetInput} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => { addFiles(Array.from(e.currentTarget.files ?? [])); e.currentTarget.value = ''; }} />

              <div class="vs-dn-switch vs-dn-switch-top">
                <div>
                  <strong>Tìm thêm cảnh trám khi thiếu</strong>
                  <span class="vs-muted vs-dn-small">Thứ tự: tư liệu bạn gửi → Kho của tôi → Pexels. Cảnh Pexels được ghi công tác giả.</span>
                </div>
                <Toggle on={form.stock} onChange={() => set({ stock: !form.stock })} ariaLabel="Tìm thêm cảnh trám khi thiếu" />
              </div>
            </div>
          </Step>

          <Step icon={<Music size={18} />} title="Nhạc nền">
            <div class="vs-dn-box vs-dn-stack" role="radiogroup" aria-label="Nhạc nền">
              {MUSIC_MODES.map((m) => <button key={m.id} type="button" role="radio" aria-checked={form.music.mode === m.id}
                class={`vs-dn-radio${form.music.mode === m.id ? ' is-active' : ''}`} onClick={() => setMusic({ mode: m.id })}>
                <span class="vs-dn-radio-dot" aria-hidden="true" />
                <span class="vs-dn-radio-text"><strong>{m.label}</strong><span class="vs-muted vs-dn-small">{m.hint}</span></span>
              </button>)}
              {form.music.mode === 'pick' && <div class="vs-dn-tracks">
                {!tracks && <div class="vs-muted vs-dn-small" role="status">Đang tải danh sách nhạc…</div>}
                {tracksError && <div class="vs-dn-state is-failed">{tracksError}</div>}
                {tracks && !tracks.length && !tracksError && <p class="vs-muted vs-dn-small">Kho chưa có bài nhạc nào. Thêm nhạc trong Thư viện của tab Video quay sẵn, hoặc để AI chọn.</p>}
                {tracks && tracks.length > 0 && <div role="radiogroup" aria-label="Chọn bài nhạc" class="vs-dn-track-list">
                  {tracks.map((t) => <button key={t.id} type="button" role="radio" aria-checked={form.music.assetId === t.id}
                    class={`vs-dn-track${form.music.assetId === t.id ? ' is-active' : ''}`} onClick={() => setMusic({ assetId: t.id })}>
                    <span class="vs-dn-track-name">{t.name}</span>
                    <span class="vs-muted vs-dn-small">{[t.mood, t.genre, t.bpm ? `${Math.round(t.bpm)} BPM` : '', t.durationSec ? formatClock(t.durationSec) : ''].filter(Boolean).join(' · ')}</span>
                  </button>)}
                </div>}
                {pickedTrack && <audio class="vs-dn-audio" controls preload="none" src={assetFileUrl(pickedTrack.id)} aria-label={`Nghe thử ${pickedTrack.name}`} />}
              </div>}
              {form.music.mode !== 'none' && <label class="vs-dn-check">
                <input type="checkbox" checked={form.music.duck} onChange={(e) => setMusic({ duck: e.currentTarget.checked })} />
                Tự giảm nhạc khi đang nói
              </label>}
            </div>
          </Step>

          <Step icon={<Sparkles size={18} />} title={<label for="vs-dn-note">Ghi chú cho AI</label>} last>
            <textarea id="vs-dn-note" class="vs-input vs-dn-note" rows={3} value={form.note}
              placeholder="Bạn muốn edit thế nào? Ví dụ: giữ đoạn mở đầu, thêm logo cuối video, chữ ít thôi…"
              onInput={(e) => set({ note: e.currentTarget.value })} />
          </Step>
        </ol>

        {error && <div class="vs-error" role="alert">{error}</div>}
        <div class="vs-dn-actions">
          <button type="button" class="vs-dn-linkbtn vs-dn-skip" disabled={!!submitting} onClick={() => void submit('manual')}>
            {submitting === 'manual' ? 'Đang chuẩn bị…' : 'Bỏ qua — tự chỉnh tay'}
          </button>
          <span class={blocker ? 'vs-faint vs-dn-summary' : 'vs-muted vs-dn-summary'}>{blocker || setupSummary(current)}</span>
          <button type="button" class="vs-btn vs-btn-accent vs-dn-primary vs-dn-go" disabled={!!blocker || !!submitting} onClick={() => void submit('ai')}>
            {submitting === 'ai' ? <Loader2 size={18} class="vs-spin" aria-hidden="true" /> : <Sparkles size={18} aria-hidden="true" />} AI edit
          </button>
        </div>
      </div>

      <aside class="vs-dn-aside" aria-labelledby="vs-dn-plan-title">
        <h3 id="vs-dn-plan-title">AI sẽ làm</h3>
        <ul class="vs-dn-plan">
          {aiPlanLines(current, template).map((line) => <li key={line.label} class={line.on ? 'is-on' : 'is-off'}>
            <span class="vs-dn-plan-icon" aria-hidden="true"><Check size={13} strokeWidth={3} /></span>
            <span class="vs-dn-plan-text"><span class="vs-dn-plan-label">{line.label}</span><span class="vs-muted vs-dn-small">{line.hint}</span></span>
          </li>)}
        </ul>
        <p class="vs-dn-aside-note">Chưa xuất video cho tới khi bạn bấm Xuất. Sau khi AI dựng, mọi thứ sửa tay được trên timeline.</p>
      </aside>
    </div>

    <Modal open={picking} onClose={() => setPicking(false)} title="Đổi mẫu edit" width={1040}>
      <TemplateLibrary headingLevel={3} selectedId={form.templateId} onPick={(t) => { set({ templateId: t.id }); setPicking(false); }} />
    </Modal>
  </div>;
}
