// Persistent job queue of the Video Studio pipeline (STORE_DIR/video-edit/jobs.json).
// Two serial lanes: "main" runs the machine steps (ingest, transcribe, analyze, render, cover) one at a
// time; "ai" runs director turns, which wait on the model and should not block a render.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { VideoJob } from '../types.js';
import type { Pipeline } from './runner.js';

export interface JobRecord extends VideoJob {
  /** Handler input (never sent to the UI). */
  args?: Record<string, unknown>;
}

export interface JobContext {
  signal: AbortSignal;
  /** Report 0..1 plus an optional short message. */
  progress: (fraction: number, message?: string) => void;
}

/** A handler may resolve with a short result message that is stored on the job. */
export type JobHandler = (job: JobRecord, ctx: JobContext) => Promise<string | void>;

export type JobLane = 'main' | 'ai';

export interface JobQueueOptions {
  file: string;
  handlers: Partial<Record<VideoJob['kind'], JobHandler>>;
  /** Every visible change (status, progress), already stripped of `args`. */
  onChange?: (job: VideoJob) => void;
  /** A job found "running" at startup: the process died under it. */
  onInterrupted?: (job: JobRecord) => void;
  /** Start working immediately (and resume jobs left queued by a previous run). Default true. */
  autoStart?: boolean;
}

const KEEP_FINISHED = 200;
const PROGRESS_EVERY_MS = 400;

export const laneOf = (kind: VideoJob['kind']): JobLane => (kind === 'direct' ? 'ai' : 'main');

export const publicJob = (j: JobRecord): VideoJob => {
  const { args: _args, ...rest } = j;
  void _args;
  return rest;
};

export function createJobQueue(opts: JobQueueOptions) {
  let jobs: JobRecord[] = [];
  const running = new Map<JobLane, { job: JobRecord; abort: AbortController }>();
  const waiters: (() => void)[] = [];
  let started = opts.autoStart !== false;
  const lastProgress = new Map<string, { at: number; value: number }>();

  function persist() {
    try {
      fs.mkdirSync(path.dirname(opts.file), { recursive: true, mode: 0o700 });
      const temp = path.join(path.dirname(opts.file), `.${randomUUID()}.tmp`);
      fs.writeFileSync(temp, JSON.stringify(jobs.slice(-KEEP_FINISHED * 2), null, 2), { mode: 0o600 });
      fs.renameSync(temp, opts.file);
    } catch { /* a queue that cannot persist still runs in memory */ }
  }

  function trim() {
    const finished = jobs.filter((j) => j.status !== 'queued' && j.status !== 'running');
    if (finished.length > KEEP_FINISHED) {
      const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED).map((j) => j.id));
      jobs = jobs.filter((j) => !drop.has(j.id));
    }
  }

  const emit = (j: JobRecord) => opts.onChange?.(publicJob(j));

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(opts.file, 'utf8')) as JobRecord[];
      jobs = Array.isArray(raw) ? raw.filter((j) => j && typeof j.id === 'string' && typeof j.kind === 'string') : [];
    } catch {
      jobs = [];
    }
    for (const j of jobs) {
      if (j.status === 'running') {
        j.status = 'failed';
        j.message = 'Bị gián đoạn do ứng dụng khởi động lại.';
        j.finishedAt = new Date().toISOString();
        opts.onInterrupted?.(j);
      }
    }
    persist();
  }

  function settle() {
    if (running.size === 0 && !jobs.some((j) => j.status === 'queued')) {
      for (const w of waiters.splice(0)) w();
    }
  }

  async function runOne(lane: JobLane, job: JobRecord) {
    const abort = new AbortController();
    running.set(lane, { job, abort });
    job.status = 'running';
    job.progress = 0;
    persist();
    emit(job);
    const handler = opts.handlers[job.kind];
    try {
      if (!handler) throw new Error(`Chưa có bộ xử lý cho bước ${job.kind}.`);
      const message = await handler(job, {
        signal: abort.signal,
        progress: (fraction, text) => {
          const value = Math.max(0, Math.min(1, fraction));
          const last = lastProgress.get(job.id);
          const now = Date.now();
          if (last && value < 1 && (now - last.at < PROGRESS_EVERY_MS || value <= last.value)) {
            if (text) job.message = text;
            return;
          }
          lastProgress.set(job.id, { at: now, value });
          job.progress = value;
          if (text) job.message = text;
          emit(job);
        },
      });
      if (abort.signal.aborted) { job.status = 'cancelled'; job.message = 'Đã dừng theo yêu cầu.'; }
      else { job.status = 'done'; job.progress = 1; if (typeof message === 'string' && message) job.message = message; }
    } catch (err) {
      if (abort.signal.aborted) { job.status = 'cancelled'; job.message = 'Đã dừng theo yêu cầu.'; }
      else { job.status = 'failed'; job.message = String((err as Error)?.message ?? err).slice(0, 600); }
    } finally {
      job.finishedAt = new Date().toISOString();
      lastProgress.delete(job.id);
      running.delete(lane);
      trim();
      persist();
      emit(job);
      pump();
      settle();
    }
  }

  function pump() {
    if (!started) return;
    for (const lane of ['main', 'ai'] as const) {
      if (running.has(lane)) continue;
      const next = jobs.find((j) => j.status === 'queued' && laneOf(j.kind) === lane);
      if (next) void runOne(lane, next);
    }
  }

  load();

  return {
    /** Add a job; an identical queued job (same project, kind and args) is returned instead of a duplicate. */
    enqueue(kind: VideoJob['kind'], projectId: string, args?: Record<string, unknown>): VideoJob {
      const same = jobs.find((j) => j.status === 'queued' && j.kind === kind && j.projectId === projectId
        && JSON.stringify(j.args ?? {}) === JSON.stringify(args ?? {}));
      if (same) return publicJob(same);
      const job: JobRecord = {
        id: randomUUID(), projectId, kind, status: 'queued', createdAt: new Date().toISOString(),
        ...(args ? { args } : {}),
      };
      jobs.push(job);
      persist();
      emit(job);
      pump();
      return publicJob(job);
    },
    list(projectId?: string): VideoJob[] {
      return jobs.filter((j) => !projectId || j.projectId === projectId).map(publicJob);
    },
    get(id: string): VideoJob | null {
      const j = jobs.find((x) => x.id === id);
      return j ? publicJob(j) : null;
    },
    /** Cancel queued jobs of a project and stop its running ones. Returns how many were touched. */
    cancelProject(projectId: string): number {
      let n = 0;
      for (const j of jobs) {
        if (j.projectId !== projectId) continue;
        if (j.status === 'queued') {
          j.status = 'cancelled'; j.message = 'Đã huỷ.'; j.finishedAt = new Date().toISOString(); n++;
          emit(j);
        }
      }
      for (const { job, abort } of running.values()) if (job.projectId === projectId) { abort.abort(); n++; }
      persist();
      settle();
      return n;
    },
    runningFor(projectId: string): VideoJob[] {
      return [...running.values()].filter((r) => r.job.projectId === projectId).map((r) => publicJob(r.job));
    },
    start() { started = true; pump(); },
    /** Shutdown: stop picking up jobs and abort the running ones (they are marked cancelled). */
    stop() { started = false; for (const { abort } of running.values()) abort.abort(); },
    /** Resolves when nothing is queued or running (tests, shutdown). */
    idle(): Promise<void> {
      if (running.size === 0 && !jobs.some((j) => j.status === 'queued')) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

export type JobQueue = ReturnType<typeof createJobQueue>;

// ── Process-wide pipeline, for callers outside the HTTP routes (the approval handler) ──

let active: Pipeline | null = null;

export function setActivePipeline(pipeline: Pipeline | null): void {
  active = pipeline;
}

export type PlanDecision = 'approve' | 'revise' | 'reject';

/** Same logic as POST /projects/:id/plan/decide. Returns promptly: the work is queued. */
export async function decidePlan(projectId: string, action: PlanDecision, note?: string): Promise<unknown> {
  if (!active) throw new Error('Pipeline dựng video chưa chạy.');
  return active.decide(projectId, action, note);
}
