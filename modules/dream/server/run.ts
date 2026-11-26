// Running external tools for Dream 100. Every command goes through execFile with an argument array: no shell, so a
// video link (data from the network) is one argument and nothing in it is ever interpreted. Each call has a timeout;
// on timeout the tool is killed, and first its own children (yt-dlp starts ffmpeg to merge), best effort with pkill.
import { execFile } from 'node:child_process';
import { childPath } from '../../_lib/media-tools/index.js';

export const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
export const FFMPEG_TIMEOUT_MS = 2 * 60_000;
const MAX_BUFFER = 32 * 1024 * 1024;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The command ran longer than its limit and was killed. */
export class ToolTimeoutError extends Error {
  constructor(readonly tool: string, readonly timeoutMs: number) {
    super(`${tool} chạy quá ${Math.round(timeoutMs / 1000)} giây nên đã bị dừng.`);
    this.name = 'ToolTimeoutError';
  }
}

/** The command could not start (not installed, not executable). */
export class ToolStartError extends Error {
  constructor(readonly tool: string, cause: string) {
    super(`Không chạy được ${tool}: ${cause}`);
    this.name = 'ToolStartError';
  }
}

export interface ExecOptions {
  timeoutMs: number;
  cwd?: string;
  signal?: AbortSignal;
  /** name shown in errors (defaults to the file name) */
  label?: string;
}

/**
 * Run `file` with `args` (never through a shell). Resolves with the exit code and output, also for a non-zero exit;
 * rejects with ToolTimeoutError after `timeoutMs`, or ToolStartError when the program cannot start.
 */
export function execTool(file: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  const label = opts.label ?? file.split('/').pop() ?? file;
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let aborted = false;
    const child = execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, PATH: childPath() },
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
      },
      (err: Error | null, stdout: string, stderr: string) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (timedOut) return reject(new ToolTimeoutError(label, opts.timeoutMs));
        if (aborted) return reject(new Error(`${label} đã bị dừng vì module tắt.`));
        const e = err as (NodeJS.ErrnoException & { code?: string | number }) | null;
        if (e && (e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'ENOTDIR')) return reject(new ToolStartError(label, e.code));
        const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
    const killTool = () => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    const kill = () => {
      // children first, while the tool still exists to name them as its children; then the tool itself
      if (!child.pid || process.platform === 'win32') return killTool();
      try {
        execFile('pkill', ['-KILL', '-P', String(child.pid)], { timeout: 5000 }, () => killTool());
      } catch {
        killTool();
      }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
    const onAbort = () => { aborted = true; kill(); };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
