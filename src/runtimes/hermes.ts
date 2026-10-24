// Hermes ("Rocket Agent") adapter: ACP over stdio, with a `hermes chat -q` fallback (runtimeOptions.mode = 'cli').
import path from 'node:path';
import type { RunEvent, Usage } from '../core/types.js';
import { log } from '../core/log.js';
import { redactString } from '../core/redact.js';
import { runAcpTurn, type AcpMcpServer, type AcpPermissionAnswer, type AcpPermissionRequest } from './acp.js';
import type { DoctorCheck, Runtime, RuntimeCapabilities, RunRequest, RunResult } from './contracts.js';
import { clip, describeCommand, obj, str, type JsonObject } from './jsonl.js';
import { probeCheck } from './probe.js';
import { runProcess } from './process.js';
import { buildChildEnv, classifyMessage, emitSafe, execFileText, failed, findBinary, makeReport, processFailure, runtimeOptionString, stderrSummary } from './shared.js';

export const HERMES_CAPABILITIES: RuntimeCapabilities = {
  resume: true,
  systemPrompt: 'inline',
  reportsCost: false,
  images: false,
  documents: false,
  noTools: true,
  enforces: {
    context: 'hard',
    mcp: 'soft',
    fileRead: 'none',
    fileWrite: 'none',
    shell: 'soft',
    note: 'Hermes ACP chỉ xin quyền cho lệnh nguy hiểm và sửa file, không chặn được shell hay đọc file thường. Chế độ an toàn mặc định chạy `hermes chat -t file,web,todo` (không có công cụ terminal) nên shell bị chặn cứng, nhưng công cụ file đọc/ghi mọi nơi và MCP lấy từ cấu hình của Hermes. Nên đặt runtimeOptions.home hoặc profile riêng, không chứa MCP cá nhân.',
  },
};

const READ_KINDS = new Set(['read', 'search']);
const SAFE_KINDS = new Set(['read', 'search', 'fetch', 'think', 'edit']);

function inside(p: string, roots: string[]): boolean {
  const abs = path.resolve(p);
  return roots.some((r) => {
    const root = path.resolve(r);
    return abs === root || abs.startsWith(root + path.sep);
  });
}

function candidatePaths(req: AcpPermissionRequest): string[] {
  const out = req.toolCall.locations?.map((l) => l.path).filter((p): p is string => !!p) ?? [];
  const raw = obj(req.toolCall.rawInput);
  for (const k of ['path', 'file_path', 'filePath', 'filename', 'file', 'target', 'directory', 'dir']) {
    const v = str(raw[k]);
    if (v && v.startsWith('/')) out.push(v);
  }
  return out;
}

function pick(options: AcpPermissionRequest['options'], kinds: string[]): AcpPermissionAnswer {
  for (const k of kinds) {
    const o = options.find((x) => x.kind === k);
    if (o) return { optionId: o.optionId };
  }
  return 'cancel';
}

/** Permission policy: 'full' allows all; 'safe' allows read/search/fetch/think/edit inside the granted dirs, rejects the rest. */
export function decidePermission(req: AcpPermissionRequest, ctx: { permission: 'safe' | 'full'; lean: boolean; cwd: string; readRoots: string[]; writeRoots: string[] }): AcpPermissionAnswer {
  const allow = () => pick(req.options, ['allow_once', 'allow_always']);
  const reject = () => pick(req.options, ['reject_once', 'reject_always']);
  if (ctx.lean) return req.toolCall.kind === 'think' ? allow() : reject();
  if (ctx.permission === 'full') return allow();
  const kind = req.toolCall.kind ?? 'other';
  if (!SAFE_KINDS.has(kind)) return reject();
  const paths = candidatePaths(req);
  if (kind === 'edit') return paths.length > 0 && paths.every((p) => inside(p, [ctx.cwd, ...ctx.writeRoots])) ? allow() : reject();
  if (READ_KINDS.has(kind) && paths.length > 0) return paths.every((p) => inside(p, [ctx.cwd, ...ctx.readRoots, ...ctx.writeRoots])) ? allow() : reject();
  return allow();
}

/** Toolsets for `hermes chat -t`: no terminal/process/code execution/delegation/browser. */
export const HERMES_SAFE_TOOLSETS = 'file,web,todo';
export const HERMES_LEAN_TOOLSETS = 'todo';

export type HermesMode = 'acp' | 'cli';

/**
 * auto (default): `full` agents and agents with MCP grants use ACP (session mcpServers, streaming);
 * everything else uses the CLI, the only mode where the shell can be switched off.
 */
export function hermesMode(req: RunRequest): HermesMode {
  const opt = runtimeOptionString(req, 'mode');
  if (opt === 'acp' || opt === 'cli') return opt;
  if (req.tools === 'none') return 'cli';
  if (req.access.permission === 'full') return 'acp';
  return req.access.mcpServers.some((g) => g.allowedTools.length > 0) ? 'acp' : 'cli';
}

export function hermesHomeEnv(req: RunRequest): Record<string, string> {
  const home = runtimeOptionString(req, 'home');
  return home ? { HERMES_HOME: home } : {};
}

export interface HermesAcpPlan {
  args: string[];
  mcpServers: AcpMcpServer[];
  prompt: string;
}

export function buildHermesAcpPlan(req: RunRequest, opts: { fresh?: boolean } = {}): HermesAcpPlan {
  const args: string[] = [];
  const profile = runtimeOptionString(req, 'profile');
  if (profile) args.push('-p', profile);
  if (req.agent.model) args.push('-m', req.agent.model);
  args.push('acp');
  const lean = req.tools === 'none';
  const mcpServers: AcpMcpServer[] = lean
    ? []
    : req.access.mcpServers
        .filter((g) => g.allowedTools.length > 0 && !g.url)
        .map((g) => ({ name: g.id, command: g.command ?? '', args: g.args ?? [], env: Object.entries(g.env).map(([name, value]) => ({ name, value })) }));
  const fresh = opts.fresh || !req.sessionId;
  const prompt = fresh && req.systemPrompt.trim() ? `${req.systemPrompt.trim()}\n\n---\n\n${req.prompt}` : req.prompt;
  return { args, mcpServers, prompt };
}

export interface HermesCliPlan {
  args: string[];
  env: Record<string, string>;
}

/** Fallback `hermes chat -q`: the system prompt travels in HERMES_EPHEMERAL_SYSTEM_PROMPT. */
export function buildHermesCliArgs(req: RunRequest, opts: { fresh?: boolean } = {}): HermesCliPlan {
  const args: string[] = [];
  const profile = runtimeOptionString(req, 'profile');
  if (profile) args.push('-p', profile);
  args.push('chat', '-q', req.prompt, '--source', 'tool', '-Q');
  if (!opts.fresh && req.sessionId) args.push('--resume', req.sessionId);
  if (req.agent.model) args.push('-m', req.agent.model);
  const lean = req.tools === 'none';
  if (lean) args.push('--max-turns', '1', '-t', HERMES_LEAN_TOOLSETS);
  else if (req.access.permission === 'full') args.push('--yolo');
  else args.push('-t', HERMES_SAFE_TOOLSETS);
  const env: Record<string, string> = {};
  if (req.systemPrompt.trim() && (opts.fresh || !req.sessionId)) env.HERMES_EPHEMERAL_SYSTEM_PROMPT = req.systemPrompt.trim();
  return { args, env };
}

/** `hermes chat -Q` prints the answer on stdout and `session_id: <id>` on stderr (kept out of the answer if it shows up on stdout). */
export function parseHermesCliOutput(stdout: string, stderr = ''): { text: string; sessionId?: string } {
  let sessionId: string | undefined;
  const keep: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*session_id:\s*(\S+)\s*$/i.exec(line);
    if (m) sessionId = m[1];
    else if (!/^Activated .+ memory( \(.*\))?\s*$/.test(line)) keep.push(line);
  }
  for (const line of stderr.split(/\r?\n/)) {
    const m = /^\s*session_id:\s*(\S+)\s*$/i.exec(line);
    if (m) sessionId = sessionId ?? m[1];
  }
  return { text: keep.join('\n').trim(), sessionId };
}

export const HERMES_AUTH_HINT = 'Hermes chưa đăng nhập nhà cung cấp mô hình: chạy `hermes model` hoặc `hermes auth add …`.';

/** Error for a failed Hermes run: classified, with a redacted output tail and a Vietnamese hint for auth. */
export function hermesFailure(label: string, stdout: string, stderr: string): { family: import('../core/types.js').ErrorFamily; message: string } {
  const tail = redactString(`${stdout}\n${stderr}`.replace(/session_id:\s*\S+/g, '').replace(/^Activated .+ memory.*$/gm, '').trim()).slice(-500);
  const family = classifyMessage(tail);
  const base = tail ? `${label}: ${tail}` : label;
  return { family, message: family === 'auth' ? `${HERMES_AUTH_HINT} (${base})` : base };
}

export function createHermesRuntime(command = 'hermes', extraEnv?: Record<string, string>): Runtime {
  async function runAcp(req: RunRequest, bin: string, fresh: boolean): Promise<RunResult & { loadFailed?: boolean }> {
    const plan = buildHermesAcpPlan(req, { fresh });
    const env = buildChildEnv({ envVars: req.access.envVars, extra: extraEnv, adapter: hermesHomeEnv(req) });
    if (req.access.permission === 'safe') emitSafe(req, { type: 'status', message: 'Hermes ACP không chặn được shell và đọc file; chỉ chặn sửa file ngoài thư mục được cấp.' });
    log.debug({ cmd: describeCommand(bin, plan.args) }, 'hermes acp run');
    const ctx = {
      permission: req.access.permission,
      lean: req.tools === 'none',
      cwd: req.cwd,
      readRoots: [...req.access.readDirs.map((d) => d.root), ...req.access.addDirs],
      writeRoots: req.access.writeDirs.map((d) => d.root),
    };
    let current = '';
    const turns: string[] = [];
    const toolNames = new Map<string, string>();
    const endTurn = () => {
      if (current.trim()) turns.push(current);
      current = '';
    };
    const onUpdate = (u: JsonObject) => {
      const kind = str(u.sessionUpdate);
      const text = str(obj(u.content).text);
      if (kind === 'agent_message_chunk' && text) {
        current += text;
        emitSafe(req, { type: 'text', text } satisfies RunEvent);
      } else if (kind === 'agent_thought_chunk' && text) emitSafe(req, { type: 'thinking', text });
      else if (kind === 'tool_call') {
        endTurn();
        const name = str(u.title) ?? str(u.kind) ?? 'tool';
        toolNames.set(str(u.toolCallId) ?? '', name);
        emitSafe(req, { type: 'tool', name, input: u.rawInput === undefined ? undefined : clip(redactString(JSON.stringify(u.rawInput))), status: 'start' });
      } else if (kind === 'tool_call_update') {
        const s = str(u.status);
        if (s === 'completed' || s === 'failed') emitSafe(req, { type: 'tool', name: toolNames.get(str(u.toolCallId) ?? '') ?? 'tool', status: s === 'failed' ? 'error' : 'end' });
      } else if (kind === 'plan') emitSafe(req, { type: 'status', message: 'Hermes cập nhật kế hoạch.' });
    };
    const turn = await runAcpTurn({
      process: { command: bin, args: plan.args, cwd: req.cwd, env, timeoutMs: req.timeoutMs },
      cwd: req.cwd,
      mcpServers: plan.mcpServers,
      sessionId: fresh ? undefined : req.sessionId,
      prompt: plan.prompt,
      onPermission: (r) => decidePermission(r, ctx),
      onUpdate,
      signal: req.signal,
    });
    const output = (current.trim() ? current : (turns[turns.length - 1] ?? '')).trim();
    const proc = turn.process!;
    const pf = processFailure('Hermes', proc, command);
    if (pf) return { ...failed(pf, { sessionId: turn.sessionId, output }), loadFailed: turn.loadFailed };
    if (turn.error) {
      const f = hermesFailure(turn.error.message || 'Hermes ACP lỗi', '', proc.stderrTail);
      return { ...failed(f, { sessionId: turn.sessionId, output }), loadFailed: turn.loadFailed };
    }
    const usage: Usage = {};
    if (turn.usage?.inputTokens !== undefined) usage.inputTokens = turn.usage.inputTokens;
    if (turn.usage?.outputTokens !== undefined) usage.outputTokens = turn.usage.outputTokens;
    if (turn.usage?.cachedReadTokens !== undefined) usage.cachedInputTokens = turn.usage.cachedReadTokens;
    const hasUsage = Object.keys(usage).length > 0;
    if (hasUsage) emitSafe(req, { type: 'usage', usage });
    if (turn.stopReason === 'refusal') return { ...failed({ family: 'refusal', message: 'Hermes từ chối trả lời yêu cầu này.' }, { output, sessionId: turn.sessionId }), loadFailed: turn.loadFailed };
    if (turn.stopReason === 'cancelled') return { ...failed({ family: 'cancelled', message: 'Lượt chạy đã bị huỷ.' }, { output, sessionId: turn.sessionId }), loadFailed: turn.loadFailed };
    return { ok: true, output, sessionId: turn.sessionId, model: req.agent.model, usage: hasUsage ? usage : undefined, loadFailed: turn.loadFailed };
  }

  async function runCli(req: RunRequest, bin: string): Promise<RunResult> {
    const attempt = async (fresh: boolean) => {
      const plan = buildHermesCliArgs(req, { fresh });
      const env = buildChildEnv({ envVars: req.access.envVars, extra: extraEnv, adapter: { ...plan.env, ...hermesHomeEnv(req) } });
      log.debug({ cmd: describeCommand(bin, plan.args, { promptArgs: [req.prompt] }) }, 'hermes cli run');
      let stdout = '';
      let stderr = '';
      const proc = await runProcess({
        command: bin,
        args: plan.args,
        cwd: req.cwd,
        env,
        stdin: '',
        timeoutMs: req.timeoutMs,
        signal: req.signal,
        onStdoutLine: (l) => (stdout += `${l}\n`),
        onStderr: (c) => (stderr = (stderr + c).slice(0, 65_536)),
      });
      return { proc, stdout, stderr };
    };
    let { proc, stdout, stderr } = await attempt(false);
    let clear = false;
    if (req.sessionId && proc.exitCode !== 0 && /session.*(not found|unknown|invalid)|no such session/i.test(`${stdout}\n${proc.stderrTail}`)) {
      ({ proc, stdout, stderr } = await attempt(true));
      clear = true;
    }
    const pf = processFailure('Hermes', proc, command);
    const parsed = parseHermesCliOutput(stdout, stderr);
    if (pf) return failed(pf, { sessionId: parsed.sessionId });
    if (proc.exitCode !== 0) {
      const f = hermesFailure(`Hermes kết thúc với mã ${proc.exitCode}`, stdout, stderr);
      return failed(f, { sessionId: parsed.sessionId });
    }
    emitSafe(req, { type: 'text', text: parsed.text });
    return { ok: true, output: parsed.text, sessionId: parsed.sessionId ?? req.sessionId, model: req.agent.model, clearSession: clear || undefined };
  }

  return {
    id: 'hermes',
    label: 'Hermes (Rocket Agent)',
    capabilities: HERMES_CAPABILITIES,
    async run(req) {
      const bin = (await findBinary(command)) ?? command;
      if (hermesMode(req) === 'cli') return runCli(req, bin);
      const first = await runAcp(req, bin, false);
      if (!first.loadFailed) return first;
      // session/load failed: the turn already ran in a new session, tell the caller to forget the old id
      return { ...first, clearSession: true };
    },
    async doctor(opts) {
      const checks: DoctorCheck[] = [];
      const bin = await findBinary(command);
      if (!bin) {
        checks.push({ code: 'hermes.missing', level: 'error', message: `Không tìm thấy lệnh "${command}".`, hint: 'Cài Hermes / Rocket Agent rồi chạy lại.' });
        return makeReport('hermes', checks, { command });
      }
      const env = buildChildEnv({ extra: extraEnv });
      const v = await execFileText(bin, ['--version'], { env });
      const version = v.ok ? v.stdout.trim().split('\n')[0] : undefined;
      checks.push(v.ok ? { code: 'hermes.version', level: 'info', message: `Phiên bản: ${version}` } : { code: 'hermes.version', level: 'error', message: 'Không đọc được phiên bản (--version lỗi).' });
      const acp = await execFileText(bin, ['acp', '--check'], { env, timeoutMs: 30_000 });
      checks.push(acp.ok ? { code: 'hermes.acp', level: 'info', message: 'ACP sẵn sàng (hermes acp --check).' } : { code: 'hermes.acp', level: 'error', message: 'hermes acp --check thất bại.', hint: 'Chạy `hermes doctor` để xem phụ thuộc còn thiếu; hoặc dùng runtimeOptions.mode = cli.' });
      const st = await execFileText(bin, ['status'], { env, timeoutMs: 30_000 });
      const provider = /Provider:\s*(.+)/.exec(st.stdout)?.[1]?.trim();
      if (provider) {
        const key = /rocket|nous/i.test(provider) ? 'Nous Portal' : provider.split(/\s+/)[0]!;
        const line = st.stdout.split('\n').find((l) => l.includes(key) && /(✓|✗)/.test(l) && l !== `  Provider:     ${provider}`);
        if (line && line.includes('✗')) checks.push({ code: 'hermes.auth', level: 'error', message: `Nhà cung cấp mô hình "${provider}" chưa đăng nhập.`, hint: HERMES_AUTH_HINT });
        else if (line) checks.push({ code: 'hermes.auth', level: 'info', message: `Đã đăng nhập nhà cung cấp "${provider}".` });
      }
      checks.push({ code: 'hermes.mcp', level: 'warn', message: 'Hermes nạp MCP trong cấu hình của nó khi khởi động, bất kể mcpServers của phiên (và có thể mở trình duyệt xin đăng nhập MCP).', hint: 'Đặt runtimeOptions.home (HERMES_HOME riêng) hoặc profile không có MCP cá nhân.' });
      checks.push({ code: 'hermes.shell', level: 'warn', message: 'ACP của Hermes không chặn được shell; chế độ an toàn dùng `hermes chat -t file,web,todo` để bỏ công cụ terminal.', hint: 'Agent cần MCP hoặc quyền full sẽ chạy qua ACP: shell không bị chặn.' });
      if (opts?.probe && checks.every((c) => c.level !== 'error')) checks.push(await probeCheck('hermes', (r) => this.run(r)));
      return makeReport('hermes', checks, { version, command: bin });
    },
  } satisfies Runtime;
}

