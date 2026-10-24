// Grok Build adapter: `grok --prompt-file ... --output-format streaming-json`.
// Never passes `--permission-mode dontAsk` (denies every tool in 1.0+).
import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { RunEvent, Usage } from '../core/types.js';
import { log } from '../core/log.js';
import { redactString } from '../core/redact.js';
import type { DoctorCheck, Runtime, RuntimeCapabilities, RunRequest, RunResult } from './contracts.js';
import { clip, describeCommand, num, obj, parseJsonLine, str, type JsonObject } from './jsonl.js';
import { probeCheck } from './probe.js';
import { runProcess } from './process.js';
import {
  allowsAllTools,
  buildChildEnv,
  classifyMessage,
  createRunDir,
  emitSafe,
  execFileText,
  failed,
  findBinary,
  makeReport,
  processFailure,
  runtimeOptionString,
  stderrSummary,
} from './shared.js';

export const GROK_CAPABILITIES: RuntimeCapabilities = {
  resume: true,
  systemPrompt: 'native',
  reportsCost: true,
  images: false,
  documents: false,
  noTools: true,
  enforces: {
    context: 'hard',
    mcp: 'soft',
    fileRead: 'soft',
    fileWrite: 'hard',
    shell: 'hard',
    note: 'Chế độ an toàn tắt shell và chạy trong sandbox "strict" (chỉ đọc/ghi thư mục làm việc và thư mục được cấp; /tmp vẫn đọc được). Khi agent được cấp MCP, Grok không khởi động được MCP trong "strict" nên sandbox chuyển sang "workspace": vẫn chặn ghi nhưng đọc được mọi nơi. MCP chặn cứng ở mức server, lọc từng tool chỉ mềm. Thư mục cấp thêm đi qua hồ sơ sandbox riêng (Grok từ chối --add-dir).',
  },
};

/** Compat scanners of other harnesses stay off so only AIOS-granted config reaches the run. */
export const GROK_ISOLATION_ENV: Record<string, string> = {
  GROK_CLAUDE_MCPS_ENABLED: 'false',
  GROK_CLAUDE_HOOKS_ENABLED: 'false',
  GROK_CLAUDE_AGENTS_ENABLED: 'false',
  GROK_CLAUDE_RULES_ENABLED: 'false',
  GROK_CLAUDE_SKILLS_ENABLED: 'false',
  GROK_CURSOR_MCPS_ENABLED: 'false',
  GROK_CURSOR_HOOKS_ENABLED: 'false',
  GROK_CURSOR_AGENTS_ENABLED: 'false',
  GROK_CURSOR_RULES_ENABLED: 'false',
  GROK_CURSOR_SKILLS_ENABLED: 'false',
};

/** Largest system prompt passed as `--rules` text; beyond this it is prepended to the prompt file. */
const MAX_RULES_ARG = 100_000;

const tomlStr = (s: string) => JSON.stringify(s);
const tomlArr = (a: string[]) => `[${a.map(tomlStr).join(',')}]`;
const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlStr(k));

export interface GrokFile {
  /** run-dir file (prompt) or project file relative to cwd (.grok/...) */
  where: 'run' | 'project';
  name: string;
  content: string;
}

export interface GrokPlan {
  args: string[];
  files: GrokFile[];
  /** project-scope files need a per-cwd lock and `--trust` */
  needsProjectFiles: boolean;
  /** isolation that had to be relaxed for this run (shown as a status event) */
  warnings: string[];
}

export interface GrokArgsOptions {
  runDir: string;
  fresh?: boolean;
  /** custom sandbox profile name used when the run needs extra read/write roots */
  profileName?: string;
}

export function buildGrokArgs(req: RunRequest, opts: GrokArgsOptions): GrokPlan {
  const lean = req.tools === 'none';
  const full = req.access.permission === 'full' && !lean;
  const resume = !opts.fresh && req.sessionId ? req.sessionId : undefined;
  const files: GrokFile[] = [];
  const args: string[] = [];

  let prompt = req.prompt;
  const rules = req.systemPrompt.trim();
  if (!resume && rules) {
    if (rules.length <= MAX_RULES_ARG) args.push('--rules', rules);
    else prompt = `${rules}\n\n---\n\n${prompt}`;
  }
  files.push({ where: 'run', name: 'prompt.md', content: prompt });
  args.push('--prompt-file', `${opts.runDir}/prompt.md`, '--output-format', 'streaming-json', '--cwd', req.cwd);

  if (resume) args.push('--resume', resume);
  if (req.agent.model) args.push('-m', req.agent.model);
  const effort = runtimeOptionString(req, 'reasoningEffort');
  if (effort) args.push('--reasoning-effort', effort);
  const maxTurns = lean ? 1 : Number(req.agent.runtimeOptions?.maxTurns) || 0;
  if (maxTurns) args.push('--max-turns', String(maxTurns));

  let needsProjectFiles = false;
  const warnings: string[] = [];

  if (lean) {
    // todo_write is the only built-in left (plus the empty MCP gateway): no files, no shell
    args.push('--tools', 'todo_write', '--disable-web-search', '--no-subagents', '--no-plan');
    return { args, files, needsProjectFiles, warnings };
  }

  const grants = req.access.mcpServers.filter((g) => g.allowedTools.length > 0);
  if (full) args.push('--always-approve');
  else {
    // headless acceptEdits refuses MCP calls, so MCP runs use always-approve; the sandbox and the missing shell stay in force
    if (grants.length) args.push('--always-approve');
    else args.push('--permission-mode', 'acceptEdits');
    args.push('--disallowed-tools', 'run_terminal_command', '--disable-web-search');
    // MCP servers cannot start under `strict`, so MCP runs use the `workspace` base (reads everywhere, writes confined)
    const base = grants.length ? 'workspace' : 'strict';
    if (grants.length) warnings.push('Grok không chạy được MCP trong sandbox strict: dùng sandbox workspace (đọc được mọi nơi, ghi chỉ trong thư mục được cấp).');
    const readRoots = req.access.addDirs.filter((d) => d !== req.cwd);
    const writeRoots = req.access.writeDirs.map((d) => d.root).filter((r) => r !== req.cwd);
    if (readRoots.length || writeRoots.length) {
      const name = opts.profileName ?? 'aios-run';
      const lines = [`[profiles.${name}]`, `extends = "${base}"`];
      // write roots must stay readable too
      const ro = base === 'strict' ? readRoots.filter((r) => !writeRoots.includes(r)) : [];
      if (ro.length) lines.push(`read_only = ${tomlArr(ro)}`);
      if (writeRoots.length) lines.push(`read_write = ${tomlArr(writeRoots)}`);
      files.push({ where: 'project', name: '.grok/sandbox.toml', content: `${lines.join('\n')}\n` });
      args.push('--sandbox', name);
      needsProjectFiles = true;
    } else args.push('--sandbox', base);
  }

  // granted MCP servers: project config in the run's cwd (compat MCP scanners are off)
  const stdioGrants = grants.filter((g) => !g.url);
  const urlGrants = grants.filter((g) => g.url);
  if (grants.length) {
    const lines: string[] = [];
    for (const g of stdioGrants) {
      const id = tomlKey(g.id);
      lines.push(`[mcp_servers.${id}]`, `command = ${tomlStr(g.command ?? '')}`);
      if (g.args?.length) lines.push(`args = ${tomlArr(g.args)}`);
      const env = Object.entries(g.env);
      if (env.length) lines.push(`env = { ${env.map(([k, v]) => `${tomlKey(k)} = ${tomlStr(v)}`).join(', ')} }`);
    }
    for (const g of urlGrants) lines.push(`[mcp_servers.${tomlKey(g.id)}]`, `url = ${tomlStr(g.url ?? '')}`);
    files.push({ where: 'project', name: '.grok/config.toml', content: `${lines.join('\n')}\n` });
    // project config only loads in a trusted folder
    args.push('--trust');
    needsProjectFiles = true;
  }
  return { args, files, needsProjectFiles, warnings };
}

/** Explicit tool names that cannot be enforced by Grok (patterns other than `*`). */
export function grokSoftToolFilters(req: RunRequest): string[] {
  return req.access.mcpServers.filter((g) => g.allowedTools.length > 0 && !allowsAllTools(g.allowedTools)).map((g) => g.id);
}

// ------------------------------------------------------------------ parsing

/** Grok drops the newline between reasoning turns; insert one when a sentence-final chunk meets a capital. */
export function applyTurnBoundary(state: { last: string; ticks: 0 | 1 }, incoming: string): string {
  let out = incoming;
  const prev = state.last;
  if (prev && !/\s$/.test(prev) && !/^\s/.test(incoming) && /^[A-Z]/.test(incoming) && incoming.length >= 2) {
    const lastChar = prev[prev.length - 1]!;
    if (/[.?!:;]/.test(lastChar) || (prev === '`' && state.ticks === 0)) out = `\n${incoming}`;
  }
  state.last = incoming;
  state.ticks = ((state.ticks + (incoming.match(/`/g)?.length ?? 0)) % 2) as 0 | 1;
  return out;
}

export interface GrokParse {
  sessionId?: string;
  /** assistant text of the current (last) turn */
  text: string;
  turns: string[];
  thought: string;
  error?: string;
  stopReason?: string;
  usage?: Usage;
  ended: boolean;
}

export function createGrokParser(onEvent: (e: RunEvent) => void) {
  const st: GrokParse = { text: '', turns: [], thought: '', ended: false };
  const boundary = { last: '', ticks: 0 as 0 | 1 };
  const toolNames = new Map<string, string>();

  function endTurn() {
    if (st.text.trim()) st.turns.push(st.text);
    st.text = '';
  }

  function handle(ev: JsonObject) {
    const type = str(ev.type);
    if (type === 'thought') {
      const d = str(ev.data);
      if (d) {
        const t = applyTurnBoundary(boundary, d);
        st.thought += t;
        onEvent({ type: 'thinking', text: t });
      }
    } else if (type === 'text') {
      const d = str(ev.data);
      if (d) {
        st.text += d;
        onEvent({ type: 'text', text: d });
      }
    } else if (type === 'tool_call') {
      endTurn();
      const id = str(ev.toolCallId) ?? '';
      const name = str(ev.toolName) ?? str(ev.title) ?? 'tool';
      toolNames.set(id, name);
      onEvent({ type: 'tool', name, input: clip(redactString(JSON.stringify(ev.rawInput ?? {}))), status: 'start' });
    } else if (type === 'tool_call_update') {
      const s = str(ev.status);
      if (s === 'completed' || s === 'failed') onEvent({ type: 'tool', name: toolNames.get(str(ev.toolCallId) ?? '') ?? 'tool', status: s === 'failed' ? 'error' : 'end' });
    } else if (type === 'end') {
      st.ended = true;
      st.sessionId = str(ev.sessionId) ?? st.sessionId;
      st.stopReason = str(ev.stopReason) ?? st.stopReason;
      const u = obj(ev.usage);
      const usage: Usage = {};
      if (num(u.input_tokens) !== undefined) usage.inputTokens = num(u.input_tokens);
      if (num(u.output_tokens) !== undefined) usage.outputTokens = num(u.output_tokens);
      if (num(u.cache_read_input_tokens) !== undefined) usage.cachedInputTokens = num(u.cache_read_input_tokens);
      if (num(ev.total_cost_usd) !== undefined) usage.costUsd = num(ev.total_cost_usd);
      if (Object.keys(usage).length) {
        st.usage = usage;
        onEvent({ type: 'usage', usage });
      }
    } else if (type === 'error') {
      const m = str(ev.message) ?? str(ev.error) ?? str(ev.data) ?? str(obj(ev.error).message);
      if (m) st.error = m;
    }
  }

  return {
    feed(line: string) {
      const ev = parseJsonLine(line);
      if (ev) handle(ev);
    },
    finish(): GrokParse {
      const last = st.text.trim() ? st.text : (st.turns[st.turns.length - 1] ?? '');
      return { ...st, text: last.trim() };
    },
  };
}

const RE_UNKNOWN_SESSION = /unknown\s+session|session(?:\s+.*)?\s+not\s+found|resume\s+.*\s+not\s+found|invalid\s+session/i;

// ------------------------------------------------------------------ project files (per-cwd lock + restore)

const projectLocks = new Map<string, Promise<void>>();

async function withProjectFiles<T>(cwd: string, files: GrokFile[], fn: () => Promise<T>): Promise<T> {
  const prev = projectLocks.get(cwd) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  projectLocks.set(cwd, tail);
  await prev;
  const backups: Array<{ file: string; content: string | null }> = [];
  try {
    for (const f of files.filter((x) => x.where === 'project')) {
      const file = path.join(cwd, f.name);
      await mkdir(path.dirname(file), { recursive: true });
      backups.push({ file, content: await readFile(file, 'utf8').catch(() => null) });
      await writeFile(file, f.content, { mode: 0o600 });
    }
    return await fn();
  } finally {
    for (const b of backups) {
      if (b.content === null) await rm(b.file, { force: true }).catch(() => undefined);
      else await writeFile(b.file, b.content).catch(() => undefined);
    }
    // drop an empty .grok dir we created
    await rmdir(path.join(cwd, '.grok')).catch(() => undefined);
    release();
    if (projectLocks.get(cwd) === tail) projectLocks.delete(cwd);
  }
}

export function createGrokRuntime(command = 'grok', extraEnv?: Record<string, string>): Runtime {
  async function runOnce(req: RunRequest, bin: string, fresh: boolean): Promise<{ result: RunResult; resumeFailed: boolean }> {
    const runDir = await createRunDir(req.cwd);
    try {
      const profileName = `aios-${randomBytes(4).toString('hex')}`;
      const plan = buildGrokArgs(req, { runDir: runDir.dir, fresh, profileName });
      for (const f of plan.files.filter((x) => x.where === 'run')) await runDir.write(f.name, f.content);
      const env = buildChildEnv({ envVars: req.access.envVars, extra: { ...GROK_ISOLATION_ENV, ...extraEnv } });
      log.debug({ cmd: describeCommand(bin, plan.args, { promptArgs: req.systemPrompt.trim() ? [req.systemPrompt.trim()] : [] }) }, 'grok run');
      const parser = createGrokParser((e) => emitSafe(req, e));
      for (const w of plan.warnings) emitSafe(req, { type: 'status', message: w });
      const exec = () => runProcess({ command: bin, args: plan.args, cwd: req.cwd, env, stdin: '', timeoutMs: req.timeoutMs, signal: req.signal, onStdoutLine: (l) => parser.feed(l) });
      const proc = plan.needsProjectFiles ? await withProjectFiles(req.cwd, plan.files, exec) : await exec();
      const p = parser.finish();
      const pf = processFailure('Grok', proc, command);
      if (pf) return { result: failed(pf, { sessionId: p.sessionId, output: p.text }), resumeFailed: false };
      const resumeFailed = !fresh && !!req.sessionId && !p.ended && RE_UNKNOWN_SESSION.test(`${p.error ?? ''}\n${proc.stderrTail}`);
      if (p.ended && !p.error) {
        if (p.stopReason === 'refusal') return { result: failed({ family: 'refusal', message: 'Grok từ chối trả lời yêu cầu này.' }, { output: p.text, sessionId: p.sessionId, usage: p.usage }), resumeFailed: false };
        return { result: { ok: true, output: p.text, sessionId: p.sessionId ?? req.sessionId, model: req.agent.model, usage: p.usage }, resumeFailed: false };
      }
      const message = redactString(p.error ?? (stderrSummary(proc) || `Grok kết thúc (mã ${proc.exitCode ?? proc.signal}) mà không có kết quả.`));
      return { result: failed({ family: classifyMessage(message), message }, { output: p.text, sessionId: p.sessionId, usage: p.usage }), resumeFailed };
    } finally {
      await runDir.cleanup().catch(() => undefined);
    }
  }

  return {
    id: 'grok',
    label: 'Grok Build',
    capabilities: GROK_CAPABILITIES,
    async run(req) {
      const bin = (await findBinary(command)) ?? command;
      const first = await runOnce(req, bin, false);
      if (!first.resumeFailed) return first.result;
      const second = await runOnce(req, bin, true);
      return { ...second.result, clearSession: true };
    },
    async doctor(opts) {
      const checks: DoctorCheck[] = [];
      const bin = await findBinary(command);
      if (!bin) {
        checks.push({ code: 'grok.missing', level: 'error', message: `Không tìm thấy lệnh "${command}".`, hint: 'Cài Grok Build (https://x.ai/cli) rồi chạy lại.' });
        return makeReport('grok', checks, { command });
      }
      const env = buildChildEnv({ extra: extraEnv });
      const v = await execFileText(bin, ['--version'], { env });
      const version = v.ok ? v.stdout.trim().split('\n')[0] : undefined;
      checks.push(v.ok ? { code: 'grok.version', level: 'info', message: `Phiên bản: ${version}` } : { code: 'grok.version', level: 'error', message: 'Không đọc được phiên bản (--version lỗi).' });
      const hasKey = !!env.XAI_API_KEY;
      const hasAuthFile = await access(path.join(env.GROK_HOME ?? path.join(homedir(), '.grok'), 'auth.json')).then(() => true, () => false);
      if (hasKey || hasAuthFile) checks.push({ code: 'grok.auth', level: 'info', message: hasAuthFile ? 'Có ~/.grok/auth.json.' : 'Có XAI_API_KEY.' });
      else checks.push({ code: 'grok.auth', level: 'error', message: 'Chưa đăng nhập Grok.', hint: 'Chạy `grok login` hoặc đặt XAI_API_KEY.' });
      checks.push({ code: 'grok.mcp', level: 'info', message: 'MCP: chỉ nạp server được cấp (tắt quét MCP của Claude/Cursor); lọc từng tool chỉ ở mức mềm.' });
      if (opts?.probe && checks.every((c) => c.level !== 'error')) checks.push(await probeCheck('grok', (r) => this.run(r)));
      return makeReport('grok', checks, { version, command: bin });
    },
  } satisfies Runtime;
}
