// Dựng nhanh › Đang dựng: the AI edit steps with their evidence lines (project.steps + SSE step/job
// events), Dừng (POST /abort) and "Mở editor" (Editor v2 for a Dựng nhanh project; QuickStudio decides).
import { useState } from 'preact/hooks';
import { ArrowRight, Check, ChevronLeft, Minus, X } from 'lucide-preact';
import { errorMessage, videoEditApi } from '@modules/video/web/lib/video-edit/api';
import { project, projectJobs } from '@modules/video/web/lib/video-edit/studio';
import type { VideoProject } from '@modules/video/web/lib/video-edit/types';
import { PreviewPlayer } from '../PreviewPlayer';
import { progressRows, progressStage, type ProgressStage, type RowState } from './quick-model';

const HEAD: Record<ProgressStage, { title: string; lead: string }> = {
  running: { title: 'AI đang dựng video của bạn', lead: 'Thường mất vài phút. Bạn có thể rời trang, AI báo trong mục “Cần tôi” khi xong.' },
  ready: { title: 'Bản dựng đã sẵn sàng', lead: 'Mở editor để xem, chỉnh tay rồi bấm Xuất.' },
  failed: { title: 'Có bước chưa chạy được', lead: 'Xem dòng báo lỗi bên dưới. Bạn có thể quay lại Thiết lập và bấm AI edit lần nữa.' },
  stopped: { title: 'Đã dừng dựng', lead: 'Phần đã làm vẫn giữ. Quay lại Thiết lập để bấm AI edit lần nữa, hoặc vào chỉnh tay.' },
};

const STATE_LABEL: Record<RowState, string> = {
  done: 'Xong', running: 'Đang chạy', waiting: 'Đang chờ', pending: 'Chưa chạy', failed: 'Lỗi', skipped: 'Bỏ qua',
};

function RowIcon({ state }: { state: RowState }) {
  return <span class={`vs-dn-row-icon is-${state}`} role="img" aria-label={STATE_LABEL[state]}>
    {state === 'done' && <Check size={14} strokeWidth={3} aria-hidden="true" />}
    {state === 'failed' && <X size={14} strokeWidth={3} aria-hidden="true" />}
    {state === 'skipped' && <Minus size={14} strokeWidth={3} aria-hidden="true" />}
    {state === 'running' && <span class="vs-dn-row-dot" aria-hidden="true" />}
  </span>;
}

export function QuickProgress({ onSetup, onOpenEditor }: { onSetup: () => void; onOpenEditor: () => void }) {
  const p = project.value as VideoProject;
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const jobs = Object.values(projectJobs.value);
  const rows = progressRows(p, jobs);
  const stage = progressStage(p, rows, jobs);
  const head = HEAD[stage];

  const stop = async () => {
    setStopping(true);
    setError('');
    try { await videoEditApi.abort(p.id); } catch (e) { setError(errorMessage(e)); } finally { setStopping(false); }
  };

  return <div class="vs-dn-page">
    <div class="vs-dn-bar">
      <button type="button" class="vs-dn-back" onClick={onSetup}><ChevronLeft size={16} aria-hidden="true" /> Thiết lập</button>
      <span class="vs-dn-crumb">Dựng nhanh › {p.title}</span>
    </div>

    <div class="vs-dn-layout vs-dn-progress">
      <section class="vs-dn-preview" aria-label="Bản xem trước">
        {stage === 'ready' && p.plan
          ? <PreviewPlayer projectId={p.id} version={p.planVersion} aspect={p.aspect} total={p.plan.outputDurationSec} readOnly />
          : <>
            <div class={`vs-dn-preview-frame is-${p.aspect === '16:9' ? 'wide' : p.aspect === '1:1' ? 'square' : 'tall'}`} aria-hidden="true">
              <svg viewBox="0 0 100 100"><circle cx="50" cy="40" r="17" /><path d="M14 100c0-22 16-38 36-38s36 16 36 38z" /></svg>
              <span class="vs-dn-preview-lines"><span /><span /><span /></span>
            </div>
            <p class="vs-muted">Bản xem trước hiện ở đây khi AI dựng xong.</p>
          </>}
      </section>

      <div class="vs-dn-form">
        <div>
          <h2 class="vs-dn-title">{head.title}</h2>
          <p class="vs-muted vs-dn-lead">{head.lead}</p>
        </div>

        <ol class="vs-dn-rows" aria-label="Các bước dựng">
          {rows.map((r) => <li key={r.id} class={`vs-dn-row is-${r.state}`}>
            <RowIcon state={r.state} />
            <div class="vs-dn-row-body">
              <div class="vs-dn-row-top">
                <strong>{r.title}</strong>
                {r.when && <span class="vs-faint vs-dn-small">{r.when}</span>}
              </div>
              <span class={r.state === 'failed' ? 'vs-dn-state is-failed' : 'vs-muted'}>{r.evidence}</span>
              {r.state === 'running' && r.percent !== undefined && <span class="vs-bar" role="progressbar" aria-label={`${r.title}: ${r.percent}%`} aria-valuenow={r.percent} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${r.percent}%` }} />
              </span>}
            </div>
          </li>)}
        </ol>

        {error && <div class="vs-error" role="alert">{error}</div>}
        <div class="vs-dn-actions">
          {stage === 'running' && <>
            <button type="button" class="vs-btn vs-btn-danger vs-dn-stop" disabled={stopping} onClick={() => void stop()}>{stopping ? 'Đang dừng…' : 'Dừng'}</button>
            <span class="vs-muted vs-dn-summary">Dừng không mất phần đã làm. Bạn có thể vào chỉnh tay luôn.</span>
          </>}
          {stage !== 'running' && <button type="button" class="vs-btn" onClick={onSetup}>Về Thiết lập</button>}
          <button type="button" class="vs-btn vs-btn-accent vs-dn-primary" disabled={!p.plan} title={p.plan ? undefined : 'Chưa có bản dựng để mở'} onClick={onOpenEditor}>
            Mở editor <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  </div>;
}
