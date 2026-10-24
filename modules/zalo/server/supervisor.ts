/**
 * AIOS-process side of the zalo daemon: spawn it on module start, restart it with backoff if it dies, stop it on module stop.
 *
 * The daemon is a plain child (not detached): Add starts it, Remove/shutdown stops it, a crash of the unofficial zca-js
 * library restarts only the child. Sessions live in the database, so a restarted daemon reconnects every nick by itself.
 * A daemon left behind by a hard AIOS crash is found through its pid file and terminated before the new one starts.
 *
 * The control token is generated here per supervisor start and travels through the child's environment (no token file).
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isProcessAlive, killProcess } from './compat.js';
import { callZaloDaemon, configureZaloControl } from './control.js';
import { ZALO_LOG_FILE, ZALO_PID_FILE } from './paths.js';

export interface SupervisorLogger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

export interface SupervisorOptions {
  rootDir: string;
  dataDir: string;
  dbPath: string;
  port: number;
  log: SupervisorLogger;
  /** Extra environment for the child (settings that only matter at spawn: ZALO_CARE_QUOTE, ZALO_MARKETING_ENABLED...). */
  env?: Record<string, string>;
  /** Override `node` arguments of the daemon entry (tests point this at a fake daemon script). */
  entryArgs?: string[];
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** Delays between restart attempts after a crash; the last value repeats. */
  backoffMs?: number[];
  /** A child that lived at least this long resets the backoff. */
  stableAfterMs?: number;
  /** How long stop() waits after SIGTERM before SIGKILL. */
  killAfterMs?: number;
}

export interface ZaloSupervisor {
  start(): void;
  stop(): Promise<void>;
  restart(): Promise<void>;
  /** Pid of the running child, or null. */
  pid(): number | null;
  /** Number of automatic restarts since start(). */
  restarts(): number;
  /** Resolves true once the daemon answers its control channel. */
  waitReady(timeoutMs?: number): Promise<boolean>;
}

const DEFAULT_BACKOFF = [1_000, 2_000, 5_000, 15_000, 30_000];

/** `--import tsx <daemon.ts>` when this file runs from source, `<daemon.js>` once compiled. */
export function defaultEntryArgs(): string[] {
  const here = fileURLToPath(import.meta.url);
  if (here.endsWith('.ts')) return ['--import', 'tsx', path.join(path.dirname(here), 'daemon.ts')];
  return [path.join(path.dirname(here), 'daemon.js')];
}

/** Working directory of the child: from source it must be where `tsx` resolves (the repo root that holds node_modules). */
function defaultCwd(rootDir: string): string {
  const here = fileURLToPath(import.meta.url);
  return here.endsWith('.ts') ? path.resolve(path.dirname(here), '..', '..', '..') : rootDir;
}

function readPid(file: string): number | null {
  try {
    const pid = parseInt(fs.readFileSync(file, 'utf-8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function terminatePid(pid: number, killAfterMs: number): Promise<void> {
  killProcess(pid);
  const deadline = Date.now() + killAfterMs;
  while (isProcessAlive(pid) && Date.now() < deadline) await sleep(50);
  if (isProcessAlive(pid)) killProcess(pid, true);
}

export function createZaloSupervisor(opts: SupervisorOptions): ZaloSupervisor {
  const spawnFn = opts.spawnImpl ?? ((c, a, o) => spawn(c, a, o));
  const backoff = opts.backoffMs?.length ? opts.backoffMs : DEFAULT_BACKOFF;
  const stableAfterMs = opts.stableAfterMs ?? 60_000;
  const killAfterMs = opts.killAfterMs ?? 5_000;
  const { log } = opts;

  let child: ChildProcess | null = null;
  let stopping = true;
  let restartTimer: NodeJS.Timeout | null = null;
  let attempt = 0;
  let restartCount = 0;
  let startedAt = 0;
  let token = '';

  function launch(): void {
    if (stopping || child) return;
    fs.mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
    const out = fs.openSync(ZALO_LOG_FILE, 'a');
    try {
      const c = spawnFn(process.execPath, opts.entryArgs ?? defaultEntryArgs(), {
        cwd: opts.entryArgs ? opts.rootDir : defaultCwd(opts.rootDir),
        stdio: ['ignore', out, out],
        windowsHide: true,
        env: {
          ...process.env,
          NODE_ENV: process.env.NODE_ENV || 'production',
          ...opts.env,
          ZALO_CONTROL_PORT: String(opts.port),
          ZALO_CONTROL_TOKEN: token,
          ZALO_DATA_DIR: opts.dataDir,
          ZALO_DB_PATH: opts.dbPath,
        },
      });
      child = c;
      startedAt = Date.now();
      log.info({ pid: c.pid }, 'zalo daemon started');
      c.once('error', (err) => {
        log.error({ err: String(err) }, 'zalo daemon failed to spawn');
        onExit(c, null, null);
      });
      c.once('exit', (code, signal) => onExit(c, code, signal));
    } finally {
      try { fs.closeSync(out); } catch { /* already closed */ }
    }
  }

  function onExit(c: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (child !== c) return;
    child = null;
    if (stopping) return;
    if (Date.now() - startedAt >= stableAfterMs) attempt = 0;
    const delay = backoff[Math.min(attempt, backoff.length - 1)];
    attempt++;
    restartCount++;
    log.warn({ code, signal, retryInMs: delay }, 'zalo daemon exited, restarting');
    restartTimer = setTimeout(() => {
      restartTimer = null;
      launch();
    }, delay);
    restartTimer.unref?.();
  }

  async function killOrphan(): Promise<void> {
    const old = readPid(ZALO_PID_FILE);
    if (old && old !== process.pid && isProcessAlive(old)) {
      log.warn({ pid: old }, 'terminating a zalo daemon left behind by a previous run');
      await terminatePid(old, killAfterMs);
    }
  }

  const supervisor: ZaloSupervisor = {
    start() {
      if (!stopping) return;
      stopping = false;
      attempt = 0;
      restartCount = 0;
      token = crypto.randomBytes(24).toString('hex');
      configureZaloControl({ port: opts.port, token });
      void killOrphan().then(() => launch(), () => launch());
    },

    async stop() {
      stopping = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      const c = child;
      child = null;
      if (c && c.exitCode === null && c.signalCode === null) {
        const exited = new Promise<void>((resolve) => c.once('exit', () => resolve()));
        c.kill('SIGTERM');
        const timer = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, killAfterMs);
        await exited;
        clearTimeout(timer);
      }
      const leftover = readPid(ZALO_PID_FILE);
      if (leftover && isProcessAlive(leftover)) await terminatePid(leftover, killAfterMs);
      configureZaloControl(null);
    },

    async restart() {
      await supervisor.stop();
      supervisor.start();
    },

    pid() {
      return child && child.exitCode === null && child.signalCode === null ? child.pid ?? null : null;
    },

    restarts: () => restartCount,

    async waitReady(timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const res = await callZaloDaemon('GET', '/status', { timeoutMs: 1_000 });
          if (res.status === 200) return true;
        } catch { /* not up yet */ }
        await sleep(100);
      }
      return false;
    },
  };
  return supervisor;
}
