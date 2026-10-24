// Claude Code adapter: `claude -p --output-format stream-json --verbose`, prompt on stdin.
import type { RunEvent, Usage } from '../core/types.js';
import { log } from '../core/log.js';
import { redactString } from '../core/redact.js';
import type { DoctorCheck, DoctorReport, Runtime, RuntimeCapabilities, RunRequest, RunResult } from './contracts.js';
import { arr, clip, describeCommand, num, obj, parseJsonLine, str, type JsonObject } from './jsonl.js';
import { runProcess } from './process.js';
import { probeCheck } from './probe.js';
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
  runtimeOptionNumber,
  stderrSummary,
} from './shared.js';

export const CLAUDE_CAPABILITIES: RuntimeCapabilities = {
  resume: true,
  systemPrompt: 'native',
  reportsCost: true,
  images: false,
  noTools: true,
  enforces: {
    context: 'hard',
    mcp: 'hard',
    fileRead: 'hard',
    fileWrite: 'hard',
    shell: 'hard',
    note: 'Chế độ an toàn dùng --restricted: tắt Bash, chỉ đọc/ghi trong thư mục được cấp. Chế độ đầy đủ (full) không chặn gì thêm ngoài MCP.',
  },
};

export interface ClaudeFile {
  name: 'system.md' | 'mcp.json';
  content: string;
}

export interface ClaudeArgs {
  args: string[];
  /** files to create inside the run dir; args reference them as `{{dir}}/<name>` */
  files: ClaudeFile[];
}

export interface ClaudeArgsOptions {
  /** directory that holds the per-run files */
  runDir: string;
  /** ignore req.sessionId (resume retry) */
  fresh?: boolean;
}

/** `Edit(//abs/dir/**)` style rule: leading `//` means absolute path in Claude permission rules. */
function absRule(tool: string, dir: string): string {
  return `${tool}(/${dir.replace(/\/+$/, '')}/**)`;
}

function underAny(dir: string, roots: string[]): boolean {
  return roots.some((r) => dir === r || dir.startsWith(r.replace(/\/+$/, '') + '/'));
}

/** Pure mapping RunRequest -> argv + per-run files. */
export function buildClaudeArgs(req: RunRequest, opts: ClaudeArgsOptions): ClaudeArgs {
  const { runDir } = opts;
  const lean = req.tools === 'none';
  const resume = !opts.fresh && req.sessionId ? req.sessionId : undefined;
  const files: ClaudeFile[] = [];
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];

  if (req.agent.model) args.push('--model', req.agent.model);
  const maxTurns = lean ? 1 : runtimeOptionNumber(req, 'maxTurns');
  if (maxTurns) args.push('--max-turns', String(maxTurns));

  if (resume) args.push('--resume', resume);
  else if (req.systemPrompt.trim()) {
    files.push({ name: 'system.md', content: req.systemPrompt });
    args.push('--append-system-prompt-file', `${runDir}/system.md`);
  }

  // MCP: only the granted servers, never the user's own
  const grants = lean ? [] : req.access.mcpServers.filter((g) => g.allowedTools.length > 0);
  args.push('--strict-mcp-config');
  if (grants.length) {
    const mcpServers: Record<string, unknown> = {};
    for (const g of grants) {
      if (g.url) mcpServers[g.id] = { type: 'http', url: g.url };
      else mcpServers[g.id] = { command: g.command, args: g.args ?? [], env: g.env };
    }
    files.push({ name: 'mcp.json', content: JSON.stringify({ mcpServers }) });
    args.push('--mcp-config', `${runDir}/mcp.json`);
  }
  const mcpAllow = grants.flatMap((g) => (allowsAllTools(g.allowedTools) ? [`mcp__${g.id}`] : g.allowedTools.map((p) => `mcp__${g.id}__${p}`)));
  const patternRestricted = grants.some((g) => !allowsAllTools(g.allowedTools));

  if (lean) {
    // strongest no-tools mode: no built-ins at all, no slash commands/skills, user settings ignored
    args.push('--restricted', '--tools', '', '--disable-slash-commands');
    return { args, files };
  }

  if (req.access.permission === 'safe') {
    args.push('--restricted', '--permission-mode', 'acceptEdits');
    // read-only grants live in --add-dir too, so writes there are denied explicitly
    const writeRoots = req.access.writeDirs.map((d) => d.root);
    const denied = req.access.addDirs.filter((d) => !underAny(d, [req.cwd, ...writeRoots])).flatMap((d) => [absRule('Edit', d), absRule('Write', d), absRule('NotebookEdit', d)]);
    if (denied.length) args.push('--disallowedTools', ...denied);
  } else if (patternRestricted) {
    // bypassPermissions would allow every tool of a granted server, so keep the allow-list in force
    args.push('--permission-mode', 'acceptEdits');
  } else {
    args.push('--dangerously-skip-permissions');
  }
  for (const d of req.access.addDirs) args.push('--add-dir', d);

  const allow = [...mcpAllow];
  if (req.access.permission === 'full' && patternRestricted) allow.push('Bash', 'WebFetch', 'WebSearch', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'Task');
  if (allow.length) args.push('--allowedTools', ...allow);
  return { args, files };
}

// ------------------------------------------------------------------ parsing

export interface ClaudeParse {
  sessionId?: string;
  model?: string;
  text: string;
  result?: {
    subtype?: string;
    isError: boolean;
    text: string;
    errors: string[];
    stopReason?: string;
    costUsd?: number;
    usage?: Usage;
    model?: string;
  };
  /** assistant usage deduplicated by message id (fallback when no result arrived) */
  assistantUsage: Usage;
  retryAfter?: string;
}

export function createClaudeParser(onEvent: (e: RunEvent) => void) {
  const state: ClaudeParse = { text: '', assistantUsage: {} };
  const perMessage = new Map<string, Usage>();
  let lastRateLimit: { status?: string; resetsAt?: number } = {};

  function usageOf(u: JsonObject): Usage {
    const input = num(u.input_tokens);
    const cacheRead = num(u.cache_read_input_tokens);
    const cacheCreate = num(u.cache_creation_input_tokens);
    const out: Usage = {};
    if (input !== undefined || cacheRead !== undefined || cacheCreate !== undefined) out.inputTokens = (input ?? 0) + (cacheRead ?? 0) + (cacheCreate ?? 0);
    if (cacheRead !== undefined) out.cachedInputTokens = cacheRead;
    const o = num(u.output_tokens);
    if (o !== undefined) out.outputTokens = o;
    return out;
  }

  function handle(ev: JsonObject): void {
    const type = str(ev.type);
    if (type === 'system' && str(ev.subtype) === 'init') {
      state.sessionId = str(ev.session_id) ?? state.sessionId;
      state.model = str(ev.model) ?? state.model;
      return;
    }
    if (type === 'rate_limit_event') {
      const info = obj(ev.rate_limit_info);
      lastRateLimit = { status: str(info.status), resetsAt: num(info.resetsAt) };
      return;
    }
    if (type === 'assistant') {
      const msg = obj(ev.message);
      state.sessionId = str(ev.session_id) ?? state.sessionId;
      const id = str(msg.id);
      if (id) perMessage.set(id, usageOf(obj(msg.usage)));
      for (const raw of arr(msg.content)) {
        const block = obj(raw);
        const bt = str(block.type);
        if (bt === 'text' && str(block.text)) {
          state.text = str(block.text)!;
          onEvent({ type: 'text', text: str(block.text)! });
        } else if (bt === 'thinking' && str(block.thinking)) {
          onEvent({ type: 'thinking', text: str(block.thinking)! });
        } else if (bt === 'tool_use') {
          onEvent({ type: 'tool', name: str(block.name) ?? 'tool', input: clip(redactString(JSON.stringify(block.input ?? {}))), status: 'start' });
        }
      }
      return;
    }
    if (type === 'user') {
      for (const raw of arr(obj(ev.message).content)) {
        const block = obj(raw);
        if (str(block.type) === 'tool_result') onEvent({ type: 'tool', name: 'tool_result', status: block.is_error === true ? 'error' : 'end' });
      }
      return;
    }
    if (type === 'result') {
      const errors = arr(ev.errors).filter((x): x is string => typeof x === 'string');
      const modelUsage = obj(ev.modelUsage);
      const model = Object.keys(modelUsage)[0];
      const usage = usageOf(obj(ev.usage));
      const cost = num(ev.total_cost_usd);
      if (cost !== undefined) usage.costUsd = cost;
      state.sessionId = str(ev.session_id) ?? state.sessionId;
      const subtype = str(ev.subtype);
      state.result = {
        subtype,
        isError: ev.is_error === true || (subtype !== undefined && subtype !== 'success'),
        text: str(ev.result) ?? '',
        errors,
        stopReason: str(ev.stop_reason),
        costUsd: cost,
        usage: Object.keys(usage).length ? usage : undefined,
        model: model ?? state.model,
      };
      if (state.result.usage) onEvent({ type: 'usage', usage: state.result.usage });
    }
  }

  return {
    feed(line: string) {
      const ev = parseJsonLine(line);
      if (ev) handle(ev);
    },
    finish(): ClaudeParse {
      const sum: Usage = {};
      for (const u of perMessage.values()) {
        for (const k of ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const) if (u[k] !== undefined) sum[k] = (sum[k] ?? 0) + u[k]!;
      }
      state.assistantUsage = sum;
      if (lastRateLimit.resetsAt && lastRateLimit.status && lastRateLimit.status !== 'allowed') state.retryAfter = new Date(lastRateLimit.resetsAt * 1000).toISOString();
      return state;
    },
  };
}

const RE_RESUME_FAIL = /no conversation found|unknown session|not a valid uuid|session .* not found/i;

/** Turn a parsed stream into the final RunResult (exported for tests). */
export function claudeResultFrom(parsed: ClaudeParse): RunResult | undefined {
  const r = parsed.result;
  if (!r) return undefined;
  const output = r.text || parsed.text;
  const base = { output, sessionId: parsed.sessionId, model: r.model ?? parsed.model, usage: r.usage };
  if (r.stopReason === 'refusal') return { ...base, ok: false, error: { family: 'refusal', message: 'Claude từ chối trả lời yêu cầu này.' } };
  if (r.isError) {
    const message = redactString([r.text, ...r.errors].filter(Boolean).join(' | ') || `Claude kết thúc với lỗi (${r.subtype ?? 'unknown'}).`);
    if (r.subtype === 'error_max_turns') return { ...base, ok: false, error: { family: 'unknown', message: 'Claude dừng vì hết số lượt tối đa.' } };
    const family = classifyMessage(message);
    return { ...base, ok: false, error: { family, message, retryAfter: family === 'quota' ? parsed.retryAfter : undefined } };
  }
  return { ...base, ok: true };
}

// ------------------------------------------------------------------ runtime

export function createClaudeRuntime(command = 'claude', extraEnv?: Record<string, string>): Runtime {
  async function runOnce(req: RunRequest, bin: string, fresh: boolean): Promise<{ result: RunResult; resumeFailed: boolean }> {
    const runDir = await createRunDir(req.cwd);
    try {
      const built = buildClaudeArgs(req, { runDir: runDir.dir, fresh });
      for (const f of built.files) await runDir.write(f.name, f.content);
      const env = buildChildEnv({ envVars: req.access.envVars, extra: extraEnv });
      log.debug({ cmd: describeCommand(bin, built.args) }, 'claude run');
      const parser = createClaudeParser((e) => emitSafe(req, e));
      const proc = await runProcess({
        command: bin,
        args: built.args,
        cwd: req.cwd,
        env,
        stdin: req.prompt,
        timeoutMs: req.timeoutMs,
        signal: req.signal,
        onStdoutLine: (l) => parser.feed(l),
      });
      const parsed = parser.finish();
      const pf = processFailure('Claude', proc, command);
      if (pf) return { result: failed(pf, { sessionId: parsed.sessionId, output: parsed.text }), resumeFailed: false };
      const fromResult = claudeResultFrom(parsed);
      if (fromResult) {
        const resumeFailed = !fresh && !!req.sessionId && !fromResult.ok && RE_RESUME_FAIL.test(`${fromResult.error?.message ?? ''}\n${proc.stderrTail}`);
        return { result: fromResult, resumeFailed };
      }
      const resumeFailed = !fresh && !!req.sessionId && RE_RESUME_FAIL.test(proc.stderrTail);
      const detail = stderrSummary(proc);
      const usage = Object.keys(parsed.assistantUsage).length ? parsed.assistantUsage : undefined;
      return {
        result: failed({ family: 'unknown', message: `Claude kết thúc (mã ${proc.exitCode ?? proc.signal}) mà không có kết quả.${detail ? ` ${detail}` : ''}` }, { sessionId: parsed.sessionId, output: parsed.text, usage }),
        resumeFailed,
      };
    } finally {
      await runDir.cleanup().catch(() => undefined);
    }
  }

  return {
    id: 'claude',
    label: 'Claude Code',
    capabilities: CLAUDE_CAPABILITIES,
    async run(req) {
      const bin = (await findBinary(command)) ?? command;
      const first = await runOnce(req, bin, false);
      if (!first.resumeFailed) return first.result;
      const second = await runOnce(req, bin, true);
      return { ...second.result, clearSession: true };
    },
    async doctor(opts) {
      return claudeDoctor(command, extraEnv, opts?.probe === true, (req) => this.run(req));
    },
  };
}

async function claudeDoctor(command: string, extraEnv: Record<string, string> | undefined, probe: boolean, run: (req: RunRequest) => Promise<RunResult>): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const bin = await findBinary(command);
  if (!bin) {
    checks.push({ code: 'claude.missing', level: 'error', message: `Không tìm thấy lệnh "${command}".`, hint: 'Cài Claude Code (npm i -g @anthropic-ai/claude-code) rồi chạy lại.' });
    return makeReport('claude', checks, { command });
  }
  const env = buildChildEnv({ extra: extraEnv });
  const v = await execFileText(bin, ['--version'], { env });
  const version = v.ok ? v.stdout.trim().split('\n')[0] : undefined;
  checks.push(v.ok ? { code: 'claude.version', level: 'info', message: `Phiên bản: ${version}` } : { code: 'claude.version', level: 'error', message: 'Không đọc được phiên bản (--version lỗi).' });
  if (env.ANTHROPIC_API_KEY) checks.push({ code: 'claude.auth', level: 'info', message: 'Có ANTHROPIC_API_KEY.' });
  else {
    const a = await execFileText(bin, ['auth', 'status'], { env });
    let loggedIn: boolean | undefined;
    try {
      loggedIn = (JSON.parse(a.stdout) as { loggedIn?: boolean }).loggedIn;
    } catch {
      loggedIn = undefined;
    }
    if (loggedIn === true) checks.push({ code: 'claude.auth', level: 'info', message: 'Đã đăng nhập Claude.' });
    else if (loggedIn === false) checks.push({ code: 'claude.auth', level: 'error', message: 'Chưa đăng nhập Claude.', hint: 'Chạy `claude auth login` hoặc đặt ANTHROPIC_API_KEY.' });
    else checks.push({ code: 'claude.auth', level: 'warn', message: 'Không xác định được trạng thái đăng nhập.', hint: 'Chạy `claude auth status` để kiểm tra.' });
  }
  if (probe && checks.every((c) => c.level !== 'error')) checks.push(await probeCheck('claude', run));
  return makeReport('claude', checks, { version, command: bin });
}
