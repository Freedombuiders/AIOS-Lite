// Small process helpers shared by the Video Studio pipeline modules.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childPath, findBin, missingToolHint, MissingToolError } from '../../bin.js';

/** HyperFrames CLI version the studio is built and tested against. Override with VIDEO_EDIT_HF_VERSION. */
export const HYPERFRAMES_VERSION = '0.8.156';
export const hyperframesVersion = () => process.env.VIDEO_EDIT_HF_VERSION?.trim() || HYPERFRAMES_VERSION;
/** GSAP build loaded by the compositions (the same one the HyperFrames docs use). */
/**
 * Music level under the voice in dB. A plan's `music.gainDb` is a fine-tune around the profile level
 * (skill docs: about -6..+3, default 0). Plans saved before that rule stored the level itself (about -18):
 * a value at or below -12 is still read that way so they keep their sound.
 */
export function musicRelDb(gainDb: number | undefined, profileRelDb: number): number {
  if (gainDb === undefined || !Number.isFinite(gainDb)) return profileRelDb;
  return gainDb <= -12 ? gainDb : profileRelDb + gainDb;
}

export const GSAP_URL = 'https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js';

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
    const bare = !path.isAbsolute(cmd);
    const resolved = bare ? findBin(cmd) ?? cmd : cmd;
    if (!path.isAbsolute(resolved) && ['ffmpeg', 'ffprobe', 'whisper-cli', 'npx'].includes(cmd)) {
      reject(new MissingToolError(cmd, missingToolHint(cmd)));
      return;
    }
    const child = spawn(resolved, args, {
      cwd: opts.cwd,
      env: { ...(opts.env ?? process.env), PATH: childPath() },
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
    child.on('error', (err) => done(() => reject((err as NodeJS.ErrnoException).code === 'ENOENT' ? new MissingToolError(cmd, missingToolHint(cmd)) : err)));
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

export const ffmpegBin = () => process.env.VIDEO_EDIT_FFMPEG?.trim() || findBin('ffmpeg') || 'ffmpeg';
export const ffprobeBin = () => process.env.VIDEO_EDIT_FFPROBE?.trim() || findBin('ffprobe') || 'ffprobe';

/** Run ffmpeg; `durationSec` + `onProgress` turn `-progress` output into a 0..1 fraction. */
export async function runFfmpeg(
  args: string[],
  opts: RunOptions & { durationSec?: number; onProgress?: (fraction: number) => void } = {},
): Promise<RunResult> {
  const withProgress = opts.onProgress && opts.durationSec && opts.durationSec > 0;
  const full = ['-hide_banner', '-nostdin', ...(withProgress ? ['-progress', 'pipe:1', '-nostats'] : []), ...args];
  let buf = '';
  return runChecked(ffmpegBin(), full, {
    ...opts,
    onData: (chunk, stream) => {
      opts.onData?.(chunk, stream);
      if (!withProgress || stream !== 'stdout') return;
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m) opts.onProgress!(Math.min(1, Number(m[1]) / 1_000_000 / opts.durationSec!));
      }
    },
  });
}

export async function probeDuration(file: string): Promise<number> {
  const res = await runChecked(ffprobeBin(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeoutMs: 30_000 });
  const n = Number(res.stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

export function findWhisperModel(): string | null {
  const env = process.env.VIDEO_EDIT_WHISPER_MODEL;
  const candidates: string[] = [];
  if (env) candidates.push(env);
  else {
    for (const dir of [path.join(os.homedir(), '.cache', 'whisper-cpp'), '/opt/homebrew/share/whisper-cpp']) {
      try {
        // Prefer the large-v3 family: Vietnamese quality drops fast on smaller models.
        const names = fs.readdirSync(dir).filter((n) => /^ggml-.*\.bin$/.test(n) && !n.startsWith('for-tests'));
        names.sort((a, b) => Number(/large/.test(b)) - Number(/large/.test(a)) || a.localeCompare(b));
        for (const n of names) candidates.push(path.join(dir, n));
      } catch { /* dir missing */ }
    }
  }
  return candidates.find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) ?? null;
}

export const r3 = (n: number) => Math.round(n * 1000) / 1000;
export const r1 = (n: number) => Math.round(n * 10) / 10;

export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
