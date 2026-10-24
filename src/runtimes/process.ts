// Shared child-process runner for CLI adapters (and the long-lived ACP process).
// No shell, own process group, line-buffered stdout, capped stderr, SIGTERM -> SIGKILL on timeout/abort.
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface ProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** written to stdin, then stdin is closed (omit to keep stdin open for `write`) */
  stdin?: string;
  timeoutMs?: number;
  /** wait between SIGTERM and SIGKILL (default 5000) */
  graceMs?: number;
  signal?: AbortSignal;
  onStdoutLine?(line: string): void;
  onStderr?(chunk: string): void;
  /** stderr tail kept in the result (default 16 KiB) */
  maxStderrBytes?: number;
  /** a single stdout line longer than this is dropped (default 8 MiB) */
  maxLineBytes?: number;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  stderrTail: string;
  /** set when the process could not be started (ENOENT, EACCES, ...) */
  spawnError?: { code?: string; message: string };
}

export interface ProcessHandle {
  child: ChildProcess;
  /** write one raw chunk to stdin (no-op after stdin closed) */
  write(data: string): void;
  endStdin(): void;
  /** SIGTERM the process group, SIGKILL after graceMs */
  kill(): void;
  done: Promise<ProcessResult>;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** Splits a byte stream into lines; the last partial line is flushed on `end`. */
export function createLineSplitter(onLine: (line: string) => void, maxLineBytes = 8 * 1024 * 1024) {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  let dropping = false;
  const feed = (text: string) => {
    buf += text;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (dropping) dropping = false;
      else if (line) onLine(line);
    }
    if (buf.length > maxLineBytes) {
      buf = '';
      dropping = true;
    }
  };
  return {
    push(chunk: Buffer) {
      feed(decoder.write(chunk));
    },
    end() {
      feed(decoder.end());
      const rest = buf.replace(/\r$/, '');
      buf = '';
      if (rest && !dropping) onLine(rest);
    },
  };
}

export function startProcess(opts: ProcessOptions): ProcessHandle {
  const graceMs = opts.graceMs ?? 5000;
  const maxStderr = opts.maxStderrBytes ?? 16 * 1024;
  let stderrTail = '';
  let timedOut = false;
  let aborted = false;
  let spawnError: ProcessResult['spawnError'];
  let killTimer: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;

  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    shell: false,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const kill = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    killGroup(child, 'SIGTERM');
    if (!killTimer) {
      killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), graceMs);
      killTimer.unref();
    }
  };

  const lines = createLineSplitter((l) => opts.onStdoutLine?.(l), opts.maxLineBytes);
  child.stdout?.on('data', (c: Buffer) => lines.push(c));
  child.stderr?.on('data', (c: Buffer) => {
    const text = c.toString('utf8');
    opts.onStderr?.(text);
    stderrTail = (stderrTail + text).slice(-maxStderr);
  });
  child.stdin?.on('error', () => {
    /* EPIPE when the child exits before reading the prompt */
  });

  if (opts.stdin !== undefined) {
    child.stdin?.write(opts.stdin);
    child.stdin?.end();
  }

  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
  }

  const onAbort = () => {
    aborted = true;
    kill();
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  const done = new Promise<ProcessResult>((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      lines.end();
      resolve({ exitCode, signal, timedOut, aborted, stderrTail, spawnError });
    };
    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnError = { code: err.code, message: err.message };
      finish(null, null);
    });
    // 'close' fires after stdio is drained, so every stdout line has been delivered
    child.on('close', (code, signal) => {
      // a leaked grandchild in the group must not outlive the run
      if (!timedOut && !aborted) killGroup(child, 'SIGKILL');
      finish(code, signal);
    });
  });

  return {
    child,
    write(data) {
      if (child.stdin && !child.stdin.destroyed && child.stdin.writable) child.stdin.write(data);
    },
    endStdin() {
      if (child.stdin && !child.stdin.destroyed) child.stdin.end();
    },
    kill,
    done,
  };
}

/** One-shot run: prompt on stdin, stdout parsed line by line. */
export function runProcess(opts: ProcessOptions): Promise<ProcessResult> {
  return startProcess({ ...opts, stdin: opts.stdin ?? '' }).done;
}
