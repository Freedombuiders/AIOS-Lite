// Pure view logic for /mission/:id (chi tiết task): labels, tones, thread merge, progress.
// No DOM, no fetch, so it runs under the node vitest environment. Wire shapes mirror
// src/mission-detail/service.ts.

export type TaskStatus = 'queued' | 'waiting' | 'running' | 'review' | 'completed' | 'failed' | 'cancelled';
export type PillTone = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'high' | 'medium' | 'low' | 'neutral' | 'accent';

export interface TaskRef {
  id: string;
  seq?: number | null;
  title: string;
  status: TaskStatus;
  assigned_agent: string | null;
}

export interface DetailTask extends TaskRef {
  prompt: string;
  priority: number;
  created_by: string;
  parent_task_id: string | null;
  result: string | null;
  error: string | null;
  /** Epoch seconds. */
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  available_at: number | null;
}

export interface MissionComment {
  id: number;
  task_id: string;
  author_kind: 'owner' | 'agent' | 'system';
  author_id: string | null;
  body: string;
  created_at: number;
}

export interface MissionRun {
  status: TaskStatus;
  agent: string | null;
  startedAt: number | null;
  completedAt: number | null;
  result: string | null;
  error: string | null;
}

export interface SubtaskProgress { total: number; done: number; running: number; blocked: number; failed: number }

export interface MissionDetail {
  task: DetailTask;
  parent: TaskRef | null;
  children: TaskRef[];
  progress: SubtaskProgress;
  blockedChildIds?: string[];
  blockers: TaskRef[];
  blocking: TaskRef[];
  blocked: boolean;
  comments: MissionComment[];
  runs: MissionRun[];
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: 'Đang chờ',
  waiting: 'Chờ task con',
  review: 'Chờ duyệt',
  running: 'Đang chạy',
  completed: 'Hoàn thành',
  failed: 'Thất bại',
  cancelled: 'Đã hủy',
};

export function statusLabel(status: string, blocked = false): string {
  if (blocked && (status === 'queued' || status === 'waiting')) return 'Bị chặn';
  return STATUS_LABEL[status as TaskStatus] ?? status;
}

export function statusTone(status: string, blocked = false): PillTone {
  if (blocked && (status === 'queued' || status === 'waiting')) return 'medium';
  switch (status) {
    case 'running': return 'running';
    case 'completed': return 'done';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'review': return 'medium';
    case 'waiting': return 'queued';
    default: return 'queued';
  }
}

/** "#12" when the task has a short number, else the first 6 chars of the id. */
export function taskLabel(task: { id: string; seq?: number | null }): string {
  return task.seq ? `#${task.seq}` : task.id.slice(0, 6);
}

export function priorityLabel(priority: number): string {
  if (priority >= 7) return 'Cao';
  if (priority >= 4) return 'Trung bình';
  if (priority > 0) return 'Thấp';
  return 'Không đặt';
}

export function priorityTone(priority: number): PillTone {
  return priority >= 7 ? 'high' : priority >= 4 ? 'medium' : 'low';
}

/** Tasks that can no longer move: nothing more to wait for. */
export function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** Share of sub-tasks completed, 0..100 (a task with no children reports 0). */
export function progressPercent(p: SubtaskProgress): number {
  return p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
}

export function progressSummary(p: SubtaskProgress): string {
  const parts = [`${p.done}/${p.total} xong`, `${p.running} đang chạy`, `${p.blocked} bị chặn`];
  if (p.failed > 0) parts.push(`${p.failed} lỗi/hủy`);
  return parts.join(' · ');
}

/** "vừa xong", "5 phút trước", "3 giờ trước", "2 ngày trước", else the date. */
export function timeAgoVi(unixSeconds: number, nowSec = Math.floor(Date.now() / 1000)): string {
  const diff = nowSec - unixSeconds;
  if (diff < 45) return 'vừa xong';
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))} phút trước`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} ngày trước`;
  return new Date(unixSeconds * 1000).toLocaleDateString('vi-VN');
}

export function formatDateTime(unixSeconds: number | null): string {
  if (!unixSeconds) return '—';
  return new Date(unixSeconds * 1000).toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** "2 phút 5 giây", for a finished run. */
export function formatRunDuration(startedAt: number | null, completedAt: number | null): string | null {
  if (!startedAt || !completedAt || completedAt < startedAt) return null;
  const sec = completedAt - startedAt;
  if (sec < 60) return `${sec} giây`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} phút${sec % 60 ? ` ${sec % 60} giây` : ''}`;
  const hours = Math.floor(min / 60);
  return `${hours} giờ${min % 60 ? ` ${min % 60} phút` : ''}`;
}

export type ThreadEntry =
  | { kind: 'comment'; at: number; key: string; comment: MissionComment }
  | { kind: 'run'; at: number; key: string; run: MissionRun };

/** Comments plus run outcomes in one chronological thread (a finished run sits at its completion time). */
export function buildThread(comments: readonly MissionComment[], runs: readonly MissionRun[]): ThreadEntry[] {
  const entries: ThreadEntry[] = comments.map((comment) => ({
    kind: 'comment', at: comment.created_at, key: `c${comment.id}`, comment,
  }));
  runs.forEach((run, i) => {
    // A run still in progress has no outcome to report yet.
    if (!isTerminal(run.status)) return;
    entries.push({ kind: 'run', at: run.completedAt ?? run.startedAt ?? 0, key: `r${i}`, run });
  });
  return entries.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

/**
 * Tasks the owner may pick as a new blocker: not this task, not already a blocker, not a
 * descendant-blocked loop (the server enforces loops; this just keeps the list sensible).
 */
export function blockerCandidates<T extends { id: string; status: string }>(
  all: readonly T[], selfId: string, existing: readonly { id: string }[], blocking: readonly { id: string }[],
): T[] {
  const skip = new Set<string>([selfId, ...existing.map((b) => b.id), ...blocking.map((b) => b.id)]);
  return all.filter((t) => !skip.has(t.id) && t.status !== 'cancelled');
}

export function authorLabel(c: MissionComment, agentName: (id: string) => string): string {
  if (c.author_kind === 'system') return 'Hệ thống';
  if (c.author_kind === 'owner') return 'Bạn';
  return c.author_id ? agentName(c.author_id) : 'Agent';
}

/** Prompt longer than this is collapsed behind "Xem thêm". */
export const PROMPT_COLLAPSE_CHARS = 700;
export function shouldCollapsePrompt(prompt: string): boolean {
  return prompt.length > PROMPT_COLLAPSE_CHARS;
}

export function blockedByOpen(blockers: readonly TaskRef[]): TaskRef[] {
  return blockers.filter((b) => b.status !== 'completed');
}

// ── AIOS-Lite API adapter ────────────────────────────────────────────

const AIOS_STATUS: Record<string, TaskStatus> = { queued: 'queued', running: 'running', waiting: 'waiting', review: 'review', done: 'completed', failed: 'failed', cancelled: 'cancelled' };
const sec = (iso: string | null | undefined): number | null => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

/** Subset of GET /api/tasks/:id this view reads (src/core/types Task, Run, TaskComment). */
export interface AiosTask {
  id: number; title: string; prompt: string; agentId: string; status: string; priority: number; parentId: number | null; source: string;
  result: string | null; error: string | null; runAfter: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
}
export interface AiosDetailDto {
  task: AiosTask;
  parent: AiosTask | null;
  children: AiosTask[];
  comments: { id: number; taskId: number; author: string; body: string; createdAt: string }[];
  runs: { status: string; agentId: string; output: string | null; error: string | null; startedAt: string; finishedAt: string | null }[];
}

const toStatus = (s: string): TaskStatus => AIOS_STATUS[s] ?? 'queued';
const toRef = (t: AiosTask): TaskRef => ({ id: String(t.id), seq: t.id, title: t.title, status: toStatus(t.status), assigned_agent: t.agentId });

/** Map the AIOS-Lite task detail onto the shape the mission-detail components render. */
export function fromAiosDetail(d: AiosDetailDto): MissionDetail {
  const t = d.task;
  const kids = d.children;
  const failed = kids.filter((k) => k.status === 'failed' || k.status === 'cancelled').length;
  return {
    task: {
      ...toRef(t), prompt: t.prompt, result: t.result, error: t.error, created_by: t.source === 'user' || t.source === 'api' ? 'dashboard' : t.source.replace(/^[a-z]+:/, ''),
      priority: t.priority, created_at: sec(t.createdAt) ?? 0, available_at: sec(t.runAfter), started_at: sec(t.startedAt), completed_at: sec(t.finishedAt),
      parent_task_id: t.parentId === null ? null : String(t.parentId),
    },
    parent: d.parent ? toRef(d.parent) : null,
    children: kids.map(toRef),
    progress: { total: kids.length, done: kids.filter((k) => k.status === 'done').length, running: kids.filter((k) => k.status === 'running').length, blocked: 0, failed },
    blockers: [], blocking: [], blocked: false,
    comments: d.comments.map((c) => ({
      id: c.id, task_id: String(c.taskId), author_kind: c.author === 'user' ? 'owner' : c.author === 'system' ? 'system' : 'agent',
      author_id: c.author.startsWith('agent:') ? c.author.slice(6) : null, body: c.body, created_at: sec(c.createdAt) ?? 0,
    })),
    runs: d.runs.map((r) => ({ status: r.status === 'done' ? 'completed' : (r.status as TaskStatus), agent: r.agentId, startedAt: sec(r.startedAt), completedAt: sec(r.finishedAt), result: r.output, error: r.error })),
  };
}
