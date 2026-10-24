// Codex adapter: `codex exec --json`, prompt on stdin.
import type { RunEvent, Usage } from '../core/types.js';
import { log } from '../core/log.js';
import { redactString } from '../core/redact.js';
import type { DoctorCheck, DoctorReport, Runtime, RuntimeCapabilities, RunRequest, RunResult } from './contracts.js';
import { clip, describeCommand, num, obj, parseJsonLine, str, type JsonObject } from './jsonl.js';
import { probeCheck } from './probe.js';
import { runProcess } from './process.js';
import { allowsAllTools, buildChildEnv, classifyMessage, emitSafe, execFileText, failed, findBinary, makeReport, processFailure, stderrSummary } from './shared.js';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const CODEX_CAPABILITIES: RuntimeCapabilities = {
  resume: true,
  systemPrompt: 'inline',
  reportsCost: false,
  images: true,
  documents: false,
  noTools: true,
  enforces: {
    context: 'hard',
    mcp: 'hard',
    fileRead: 'none',
    fileWrite: 'hard',
    shell: 'soft',
    note: 'Codex không chặn được việc đọc file ngoài thư mục làm việc; chỉ chặn ghi (sandbox) và chỉ nạp MCP được cấp. Shell chạy trong sandbox nhưng vẫn đọc được.',
  },
};

/** Env names the agent's shell may see besides the granted ones. */
const SHELL_CORE_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ'];

const tomlStr = (s: string) => JSON.stringify(s);
const tomlArr = (a: string[]) => `[${a.map(tomlStr).join(',')}]`;
const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlStr(k));

export interface CodexArgs {
  args: string[];
  /** prompt to write to stdin (system prompt is prepended for fresh sessions) */
  stdin: string;
}

export interface CodexArgsOptions {
  fresh?: boolean;
}

export function buildCodexArgs(req: RunRequest, opts: CodexArgsOptions = {}): CodexArgs {
  const lean = req.tools === 'none';
  const resume = !opts.fresh && req.sessionId ? req.sessionId : undefined;
  const args = ['exec'];
  if (resume) args.push('resume', resume);
  args.push('--json', '--skip-git-repo-check');
  // `exec resume` has no -C / -s / --add-dir: the working dir comes from spawn, sandbox via -c
  if (!resume) args.push('-C', req.cwd);
  if (req.agent.model) args.push('-m', req.agent.model);

  const full = req.access.permission === 'full' && !lean;
  const sandbox = lean ? 'read-only' : full ? 'danger-full-access' : req.access.writeDirs.length > 0 ? 'workspace-write' : 'read-only';
  const extraRoots = req.access.writeDirs.map((d) => d.root).filter((r) => r !== req.cwd);
  if (resume) {
    args.push('-c', `sandbox_mode=${tomlStr(sandbox)}`);
    if (sandbox === 'workspace-write' && extraRoots.length) args.push('-c', `sandbox_workspace_write.writable_roots=${tomlArr(extraRoots)}`);
  } else {
    args.push('-s', sandbox);
    if (sandbox === 'workspace-write') for (const d of extraRoots) args.push('--add-dir', d);
  }

  // user config, user MCP servers and account-level connectors (apps/plugins) stay out
  args.push('--ignore-user-config', '--disable', 'apps', '--disable', 'plugins');
  args.push('-c', 'approval_policy="never"');

  // the agent's shell sees only core vars plus granted ones
  const envNames = [...SHELL_CORE_ENV, ...Object.keys(req.access.envVars)];
  args.push('-c', 'shell_environment_policy.inherit="all"', '-c', 'shell_environment_policy.ignore_default_excludes=true', '-c', `shell_environment_policy.include_only=${tomlArr(envNames)}`);

  if (lean) {
    args.push('--ephemeral', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'image_generation', '--disable', 'multi_agent', '-c', 'web_search="disabled"');
  } else {
    for (const g of req.access.mcpServers) {
      if (g.allowedTools.length === 0) continue;
      const id = tomlKey(g.id);
      if (g.url) args.push('-c', `mcp_servers.${id}.url=${tomlStr(g.url)}`);
      else {
        args.push('-c', `mcp_servers.${id}.command=${tomlStr(g.command ?? '')}`);
        if (g.args?.length) args.push('-c', `mcp_servers.${id}.args=${tomlArr(g.args)}`);
        // values travel through the child env (see runtime), only names appear in argv
        const names = Object.keys(g.env);
        if (names.length) args.push('-c', `mcp_servers.${id}.env_vars=${tomlArr(names)}`);
      }
      if (!allowsAllTools(g.allowedTools)) args.push('-c', `mcp_servers.${id}.enabled_tools=${tomlArr(g.allowedTools)}`);
      // exec never prompts: granted tools must be pre-approved or every call is refused
      args.push('-c', `mcp_servers.${id}.default_tools_approval_mode="approve"`);
    }
    for (const img of req.images ?? []) args.push('-i', img);
  }
  args.push('-');

  const stdin = !resume && req.systemPrompt.trim() ? `${req.systemPrompt.trim()}\n\n---\n\n${req.prompt}` : req.prompt;
  return { args, stdin };
}

// ------------------------------------------------------------------ parsing

export interface CodexParse {
  threadId?: string;
  messages: string[];
  usage?: Usage;
  error?: string;
  turnFailed: boolean;
  completed: boolean;
}

export function createCodexParser(onEvent: (e: RunEvent) => void) {
  const st: CodexParse = { messages: [], turnFailed: false, completed: false };

  function handle(ev: JsonObject) {
    const type = str(ev.type);
    if (type === 'thread.started') st.threadId = str(ev.thread_id) ?? st.threadId;
    else if (type === 'item.started' || type === 'item.completed') {
      const item = obj(ev.item);
      const it = str(item.type);
      const done = type === 'item.completed';
      if (it === 'agent_message' && done) {
        const t = str(item.text) ?? '';
        if (t) {
          st.messages.push(t);
          onEvent({ type: 'text', text: t });
        }
      } else if (it === 'reasoning' && done) {
        const t = str(item.text);
        if (t) onEvent({ type: 'thinking', text: t });
      } else if (it === 'command_execution') {
        const failedCmd = done && typeof item.exit_code === 'number' && item.exit_code !== 0;
        onEvent({ type: 'tool', name: 'shell', input: clip(redactString(str(item.command) ?? '')), status: !done ? 'start' : failedCmd ? 'error' : 'end' });
      } else if (it === 'file_change' || it === 'mcp_tool_call' || it === 'web_search') {
        const name = it === 'mcp_tool_call' ? `${str(item.server) ?? 'mcp'}.${str(item.tool) ?? 'tool'}` : it;
        onEvent({ type: 'tool', name, status: !done ? 'start' : str(item.status) === 'failed' ? 'error' : 'end' });
      } else if (it === 'error' && done) st.error = str(item.message) ?? st.error;
    } else if (type === 'turn.completed') {
      st.completed = true;
      const u = obj(ev.usage);
      const input = num(u.input_tokens);
      const cached = num(u.cached_input_tokens);
      const out = num(u.output_tokens);
      const usage: Usage = {};
      // codex input_tokens already includes the cached part: do not add them
      if (input !== undefined) usage.inputTokens = input;
      if (cached !== undefined) usage.cachedInputTokens = cached;
      if (out !== undefined) usage.outputTokens = out;
      if (Object.keys(usage).length) {
        st.usage = usage;
        onEvent({ type: 'usage', usage });
      }
    } else if (type === 'turn.failed') {
      st.turnFailed = true;
      st.error = str(obj(ev.error).message) ?? str(ev.message) ?? st.error;
    } else if (type === 'error') {
      st.error = str(ev.message) ?? st.error;
    }
  }

  return {
    feed(line: string) {
      const ev = parseJsonLine(line);
      if (ev) handle(ev);
    },
    finish: () => st,
  };
}

const RE_RESUME_FAIL = /no (rollout|session|conversation|thread) (found|matching)|session .* not found|unknown session|invalid (session|thread)|failed to (find|resume)/i;

export function createCodexRuntime(command = 'codex', extraEnv?: Record<string, string>): Runtime {
  async function runOnce(req: RunRequest, bin: string, fresh: boolean): Promise<{ result: RunResult; resumeFailed: boolean }> {
    const built = buildCodexArgs(req, { fresh });
    // MCP env values go into the child env under their own names; env_vars forwards them to the server only
    const mcpEnv: Record<string, string> = {};
    if (req.tools !== 'none') for (const g of req.access.mcpServers) if (g.allowedTools.length && !g.url) Object.assign(mcpEnv, g.env);
    const env = buildChildEnv({ envVars: req.access.envVars, extra: { ...extraEnv, ...mcpEnv } });
    log.debug({ cmd: describeCommand(bin, built.args) }, 'codex run');
    const parser = createCodexParser((e) => emitSafe(req, e));
    const proc = await runProcess({ command: bin, args: built.args, cwd: req.cwd, env, stdin: built.stdin, timeoutMs: req.timeoutMs, signal: req.signal, onStdoutLine: (l) => parser.feed(l) });
    const p = parser.finish();
    const pf = processFailure('Codex', proc, command);
    const output = p.messages[p.messages.length - 1] ?? '';
    if (pf) return { result: failed(pf, { sessionId: p.threadId, output }), resumeFailed: false };
    const resumeFailed = !fresh && !!req.sessionId && !p.completed && RE_RESUME_FAIL.test(`${p.error ?? ''}\n${proc.stderrTail}`);
    if (p.completed && !p.turnFailed && !p.error) return { result: { ok: true, output, sessionId: p.threadId ?? req.sessionId, model: req.agent.model, usage: p.usage }, resumeFailed: false };
    const message = redactString(p.error ?? (stderrSummary(proc) || `Codex kết thúc (mã ${proc.exitCode ?? proc.signal}) mà không hoàn tất lượt.`));
    return { result: failed({ family: classifyMessage(message), message }, { output, sessionId: p.threadId, usage: p.usage }), resumeFailed };
  }

  return {
    id: 'codex',
    label: 'Codex',
    capabilities: CODEX_CAPABILITIES,
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
        checks.push({ code: 'codex.missing', level: 'error', message: `Không tìm thấy lệnh "${command}".`, hint: 'Cài Codex (npm i -g @openai/codex) rồi chạy lại.' });
        return makeReport('codex', checks, { command });
      }
      const env = buildChildEnv({ extra: extraEnv });
      const v = await execFileText(bin, ['--version'], { env });
      const version = v.ok ? v.stdout.trim().split('\n')[0] : undefined;
      checks.push(v.ok ? { code: 'codex.version', level: 'info', message: `Phiên bản: ${version}` } : { code: 'codex.version', level: 'error', message: 'Không đọc được phiên bản (--version lỗi).' });
      const hasKey = !!env.OPENAI_API_KEY;
      const hasAuthFile = await access(path.join(env.CODEX_HOME ?? path.join(homedir(), '.codex'), 'auth.json')).then(() => true, () => false);
      if (hasKey || hasAuthFile) checks.push({ code: 'codex.auth', level: 'info', message: hasAuthFile ? 'Có ~/.codex/auth.json.' : 'Có OPENAI_API_KEY.' });
      else checks.push({ code: 'codex.auth', level: 'error', message: 'Chưa đăng nhập Codex.', hint: 'Chạy `codex login` hoặc đặt OPENAI_API_KEY.' });
      checks.push({ code: 'codex.read', level: 'warn', message: 'Codex không chặn được việc đọc file ngoài thư mục làm việc.', hint: 'Chỉ cấp thư mục cho agent Codex khi chấp nhận giới hạn này.' });
      if (opts?.probe && checks.every((c) => c.level !== 'error')) checks.push(await probeCheck('codex', (r) => this.run(r)));
      return makeReport('codex', checks, { version, command: bin });
    },
  } satisfies Runtime;
}

export type { DoctorReport };
