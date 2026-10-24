// Small process helper (no shell) and ffmpeg/ffprobe binary names used to stage KOL media.
// The VIDEO_EDIT_FFMPEG / VIDEO_EDIT_FFPROBE environment variables point at non-default binaries.
import { spawn } from 'node:child_process';
import path from 'node:path';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with each stdout/stderr chunk (for progress parsing). */
  onData?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  env?: NodeJS.ProcessEnv;
}

const MAX_CAPTURE = 4 * 1024 * 1024;

/** Run a command without a shell. Resolves with the exit code; rejects only when it cannot start. */
export function runCommand(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs)
      : null;
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const clip = (acc: string, chunk: string) => (acc.length > MAX_CAPTURE ? acc.slice(-MAX_CAPTURE / 2) + chunk : acc + chunk);
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout = clip(stdout, d); opts.onData?.(d, 'stdout'); });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr = clip(stderr, d); opts.onData?.(d, 'stderr'); });
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    child.on('error', (err) => done(() => reject(err)));
    child.on('close', (code) => done(() => {
      if (timedOut) reject(new Error(`${cmd} quá thời gian`));
      else resolve({ code: code ?? -1, stdout, stderr });
    }));
  });
}

/** Run and throw a readable error (last stderr lines) on a non-zero exit. */
export async function runChecked(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const res = await runCommand(cmd, args, opts);
  if (res.code !== 0) {
    const tail = (res.stderr || res.stdout).trim().split('\n').slice(-6).join(' | ');
    throw new Error(`${path.basename(cmd)} lỗi (${res.code}): ${tail.slice(0, 600)}`);
  }
  return res;
}

export const ffmpegBin = () => process.env.VIDEO_EDIT_FFMPEG?.trim() || 'ffmpeg';
export const ffprobeBin = () => process.env.VIDEO_EDIT_FFPROBE?.trim() || 'ffprobe';
