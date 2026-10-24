// "Phiếu dựng": the 12-step ticket as a vertical timeline.
import { useState } from 'preact/hooks';
import { Check, ChevronRight, Circle, Clock, Loader2, Lock, Minus, X } from 'lucide-preact';
import { ACTOR_LABEL, formatDateTime } from '@modules/video/web/lib/video-edit/format';
import { currentProfile, project, projectJobs } from '@modules/video/web/lib/video-edit/studio';
import type { ProjectStep, StepDef, StepStatus, VideoJob } from '@modules/video/web/lib/video-edit/types';
import { STEP_DEFS } from '@modules/video/web/lib/video-edit/types';

const STATUS_LABEL: Record<StepStatus, string> = {
  pending: 'Chưa làm', running: 'Đang chạy', waiting: 'Chờ bạn', done: 'Xong', failed: 'Lỗi', skipped: 'Bỏ qua', unavailable: 'Chưa có',
};

function StatusIcon({ status }: { status: StepStatus }) {
  const label = STATUS_LABEL[status];
  switch (status) {
    case 'running': return <Loader2 size={16} class="vs-spin" aria-label={label} />;
    case 'waiting': return <Clock size={16} aria-label={label} />;
    case 'done': return <Check size={16} aria-label={label} />;
    case 'failed': return <X size={16} aria-label={label} />;
    case 'skipped': return <Minus size={16} aria-label={label} />;
    case 'unavailable': return <Lock size={14} aria-label={label} />;
    default: return <Circle size={16} aria-label={label} />;
  }
}

export function TicketPanel() {
  const p = project.value;
  if (!p) return <TicketIntro />;
  const profile = currentProfile();
  const done = p.steps.filter((s) => s.status === 'done').length;
  const byKey = new Map<string, ProjectStep>(p.steps.map((s) => [s.key, s]));
  // Latest background job per kind (SSE `job`): drives the progress bar of the step with the same key.
  const jobByKind = new Map<string, VideoJob>();
  for (const j of Object.values(projectJobs.value).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) jobByKind.set(j.kind, j);
  return (
    <div class="vs-ticket">
      <section class="vs-ticket-head" aria-label="Phiếu dựng">
        <div class="vs-eyebrow">Phiếu dựng</div>
        <div class="vs-ticket-code">{p.code}</div>
        <div class="vs-ticket-title">{p.title}</div>
        <div class="vs-ticket-meta">
          {profile && (
            <span class="vs-chip vs-chip-profile">
              <span class="vs-chip-dot" style={{ background: profile.color }} aria-hidden="true" />
              <span class="vs-chip-text">{profile.name}</span>
            </span>
          )}
          <span class="vs-faint">{formatDateTime(p.createdAt)}</span>
          <span class="vs-ticket-count" role="status">{done}/{p.steps.length || STEP_DEFS.length} bước</span>
        </div>
      </section>
      <ol class="vs-steps">
        {STEP_DEFS.map((def) => <StepRow key={def.key} def={def} step={byKey.get(def.key)} job={jobByKind.get(def.key)} />)}
      </ol>
    </div>
  );
}

function logTime(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

function StepLog({ log, startOpen }: { log: NonNullable<ProjectStep['log']>; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const last = log[log.length - 1];
  return (
    <div class="vs-step-log">
      <button type="button" class="vs-step-log-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={12} aria-hidden="true" class={open ? 'is-open' : ''} />
        {open ? `${log.length} dòng bằng chứng` : <span class="vs-step-log-last"><span class="vs-mono">{logTime(last.at)}</span> · {last.text}</span>}
        {!open && log.length > 1 && <span class="vs-faint"> (+{log.length - 1})</span>}
      </button>
      {open && (
        <ol class="vs-step-log-list">
          {log.map((l, i) => <li key={i}><span class="vs-mono vs-faint">{logTime(l.at)}</span> · {l.text}</li>)}
        </ol>
      )}
    </div>
  );
}

function StepRow({ def, step, job }: { def: StepDef; step?: ProjectStep; job?: VideoJob }) {
  const status: StepStatus = step?.status ?? 'pending';
  const liveJob = job && (job.status === 'queued' || job.status === 'running') ? job : undefined;
  const progress = step?.progress ?? (status === 'running' ? liveJob?.progress : undefined);
  const pct = progress !== undefined ? Math.round(progress * 100) : null;
  return (
    <li class={`vs-step vs-step-${status}`}>
      <span class="vs-step-icon"><StatusIcon status={status} /></span>
      <div class="vs-step-body">
        <div class="vs-step-top">
          <span class={`vs-actor vs-actor-${def.actor}`}>{ACTOR_LABEL[def.actor]}</span>
          <span class="vs-step-label">{def.label}</span>
        </div>
        {status === 'running' && pct !== null && (
          <div class="vs-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${def.label}: ${pct}%`}>
            <span style={{ width: `${pct}%` }} />
          </div>
        )}
        {status === 'running' && liveJob?.message && <div class="vs-step-sum">{liveJob.message}</div>}
        {step?.error && <div class="vs-step-err">{step.error}</div>}
        {!step?.error && step?.summary && <div class="vs-step-sum">{step.summary}</div>}
        {step?.log && step.log.length > 0 && <StepLog log={step.log} startOpen={status === 'running' || status === 'failed'} />}
        <div class="vs-step-tools">{def.tools}</div>
      </div>
    </li>
  );
}

function TicketIntro() {
  return (
    <div class="vs-ticket">
      <section class="vs-ticket-head">
        <div class="vs-eyebrow">Phiếu dựng</div>
        <p class="vs-muted vs-ticket-intro">
          Mỗi video là một phiếu 12 bước. Máy làm phần nặng (chép lời, cắt, ghép, xuất file), AI làm đạo diễn, bạn duyệt kế hoạch trước khi dựng.
          Thả video vào để bắt đầu một phiếu.
        </p>
      </section>
      <ol class="vs-steps">
        {STEP_DEFS.map((def, i) => (
          <li key={def.key} class="vs-step vs-step-static">
            <span class="vs-step-icon vs-step-num">{i + 1}</span>
            <div class="vs-step-body">
              <div class="vs-step-top">
                <span class={`vs-actor vs-actor-${def.actor}`}>{ACTOR_LABEL[def.actor]}</span>
                <span class="vs-step-label">{def.label}</span>
                <span class="vs-phase">GĐ{def.phase}</span>
              </div>
              <div class="vs-step-tools">{def.tools}</div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
