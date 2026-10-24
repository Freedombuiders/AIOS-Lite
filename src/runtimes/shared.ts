// Helpers shared by every adapter: child env, per-run temp dir, binary lookup, error mapping.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as fsc } from 'node:fs';
import { access, chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ErrorFamily, RunEvent, RuntimeId, Usage } from '../core/types.js';
import { redactString } from '../core/redact.js';
import type { DoctorCheck, DoctorReport, RunError, RunRequest, RunResult } from './contracts.js';
import type { ProcessResult } from './process.js';

// ------------------------------------------------------------------ env

/** Never reach a child process, whatever the agent was granted. */
const ALWAYS_STRIP = ['AIOS_TOKEN', 'AIOS_ENCRYPTION_KEY', 'COMPOSIO_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION', 'CLAUDE_CODE_PARENT_SESSION'];
/** CLAUDE_CODE_* vars that configure auth/provider rather than mark a nested session. */
const KEEP_CLAUDE_CODE = /^CLAUDE_CODE_(OAUTH_TOKEN|USE_(BEDROCK|VERTEX|FOUNDRY))$/;

export interface ChildEnvInput {
  /** granted `type: env` connections */
  envVars?: Record<string, string>;
  /** RuntimeRegistryOptions.env */
  extra?: Record<string, string>;
  /** adapter specific additions (e.g. HERMES_EPHEMERAL_SYSTEM_PROMPT) */
  adapter?: Record<string, string>;
  base?: NodeJS.ProcessEnv;
}

/**
 * Child env = process env minus nested-session markers and AIOS secrets
 * (and any name listed in AIOS_STRIP_ENV), plus the agent's granted env vars.
 */
export function buildChildEnv(input: ChildEnvInput = {}): Record<string, string> {
  const base = input.base ?? process.env;
  const strip = new Set(ALWAYS_STRIP);
  for (const n of (base.AIOS_STRIP_ENV ?? '').split(',')) if (n.trim()) strip.add(n.trim());
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || strip.has(k)) continue;
    if (k.startsWith('CLAUDE_CODE_') && !KEEP_CLAUDE_CODE.test(k)) continue;
    env[k] = v;
  }
  // granted vars are applied after stripping, so an agent can be given e.g. COMPOSIO_API_KEY explicitly
  return { ...env, ...input.extra, ...input.adapter, ...input.envVars };
}

// ------------------------------------------------------------------ per-run temp dir

export interface RunDir {
  dir: string;
  /** write a 0600 file inside the run dir, returns its absolute path */
  write(name: string, content: string): Promise<string>;
  cleanup(): Promise<void>;
}

/** `<cwd>/.aios/run-<random>/`; removed after the run. */
export async function createRunDir(cwd: string): Promise<RunDir> {
  const dir = path.join(cwd, '.aios', `run-${randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return {
    dir,
    async write(name, content) {
      const p = path.join(dir, name);
      await writeFile(p, content, { mode: 0o600 });
      await chmod(p, 0o600);
      return p;
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// ------------------------------------------------------------------ binaries

const FALLBACK_DIRS = () => [path.join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(homedir(), '.grok/bin')];

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, fsc.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path, a name found on PATH, or one of the well-known install dirs. */
export async function findBinary(nameOrPath: string, pathEnv: string | undefined = process.env.PATH): Promise<string | undefined> {
  if (nameOrPath.includes('/')) return (await isExecutable(nameOrPath)) ? nameOrPath : undefined;
  const dirs = [...(pathEnv ?? '').split(path.delimiter).filter(Boolean), ...FALLBACK_DIRS()];
  for (const d of dirs) {
    const p = path.join(d, nameOrPath);
    if (await isExecutable(p)) return p;
  }
  return undefined;
}

export function execFileText(command: string, args: string[], opts: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { timeout: opts.timeoutMs ?? 15_000, env: opts.env ?? buildChildEnv(), maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end();
  });
}

// ------------------------------------------------------------------ errors

const RE_AUTH = /(not logged in|please (run )?.*login|invalid (api )?key|invalid x-api-key|authentication[_ ]?(error|failed|required)|unauthori[sz]ed|\b401\b|oauth token .*(expired|invalid)|credentials? (are )?(missing|invalid|expired)|no api key|sign in|not logged (in|into)|auth add|re-?authenticate|\\bapi key\\b)/i;
const RE_QUOTA = /(rate.?limit|usage limit|quota|credit balance|insufficient (credits|funds)|out of credits|\b429\b|too many requests|limit reached|billing)/i;
const RE_TRANSIENT = /(overloaded|\b5\d\d\b|temporar|timed? ?out|ECONNRESET|ECONNREFUSED|ENOTFOUND|network|socket hang up|service unavailable|try again)/i;
const RE_REFUSAL = /(refus|cannot assist|can't assist|content policy|safety)/i;

/** Map an error message that came from a parsed CLI result (never raw stderr) to a family. */
export function classifyMessage(message: string): ErrorFamily {
  if (RE_AUTH.test(message)) return 'auth';
  if (RE_QUOTA.test(message)) return 'quota';
  if (RE_REFUSAL.test(message)) return 'refusal';
  if (RE_TRANSIENT.test(message)) return 'transient';
  return 'unknown';
}

/** Failure that has no parsed result: spawn error, timeout, abort, or a bare non-zero exit. */
export function processFailure(runtime: string, proc: ProcessResult, label: string): RunError | undefined {
  if (proc.spawnError) {
    const missing = proc.spawnError.code === 'ENOENT';
    return {
      family: 'config',
      message: missing ? `Không tìm thấy lệnh ${label}. Hãy cài CLI hoặc chỉnh đường dẫn.` : `Không chạy được ${label}: ${redactString(proc.spawnError.message)}`,
    };
  }
  if (proc.aborted) return { family: 'cancelled', message: 'Lượt chạy đã bị huỷ.' };
  if (proc.timedOut) return { family: 'timeout', message: `${runtime} quá thời gian cho phép.` };
  return undefined;
}

export function stderrSummary(proc: ProcessResult, max = 400): string {
  const t = redactString(proc.stderrTail.trim());
  return t ? t.slice(-max) : '';
}

export function failed(error: RunError, extra: Partial<RunResult> = {}): RunResult {
  return { ok: false, output: '', error, ...extra };
}

// ------------------------------------------------------------------ misc

export function emitSafe(req: RunRequest, event: RunEvent): void {
  try {
    req.onEvent(event);
  } catch {
    /* a listener failure must never break a run */
  }
}

export function sumUsage(usage: Usage | undefined): Usage | undefined {
  if (!usage) return undefined;
  const out: Usage = {};
  for (const k of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'costUsd'] as const) if (usage[k] !== undefined) out[k] = usage[k];
  return Object.keys(out).length ? out : undefined;
}

export function runtimeOption(req: RunRequest, key: string): string | number | boolean | undefined {
  return req.agent.runtimeOptions?.[key];
}

export function runtimeOptionNumber(req: RunRequest, key: string): number | undefined {
  const v = runtimeOption(req, key);
  return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined;
}

export function runtimeOptionString(req: RunRequest, key: string): string | undefined {
  const v = runtimeOption(req, key);
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Compose the standard doctor report from checks. */
export function makeReport(runtime: RuntimeId, checks: DoctorCheck[], extra: { version?: string; command?: string } = {}): DoctorReport {
  const status = checks.some((c) => c.level === 'error') ? 'fail' : checks.some((c) => c.level === 'warn') ? 'warn' : 'pass';
  return { runtime, status, version: extra.version, command: extra.command, checks, testedAt: new Date().toISOString() };
}

/** ['*'] means every tool of the server; an empty list means none. */
export function allowsAllTools(patterns: string[]): boolean {
  return patterns.includes('*');
}
