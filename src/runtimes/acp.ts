// Minimal Agent Client Protocol client: JSON-RPC 2.0, newline-delimited, over a child process.
import type { JsonObject } from './jsonl.js';
import { arr, num, obj, parseJsonLine, str } from './jsonl.js';
import { startProcess, type ProcessHandle, type ProcessOptions, type ProcessResult } from './process.js';

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

export interface AcpPermissionRequest {
  sessionId?: string;
  toolCall: { toolCallId?: string; title?: string; kind?: string; rawInput?: unknown; locations?: Array<{ path?: string }> };
  options: AcpPermissionOption[];
}

export type AcpPermissionAnswer = { optionId: string } | 'cancel';

export interface AcpClientOptions {
  process: Omit<ProcessOptions, 'onStdoutLine' | 'stdin'>;
  onUpdate?(update: JsonObject, sessionId: string | undefined): void;
  onPermission?(req: AcpPermissionRequest): AcpPermissionAnswer | Promise<AcpPermissionAnswer>;
  /** non-JSON stdout lines (banners from the CLI) */
  onNoise?(line: string): void;
}

interface Pending {
  resolve(v: JsonObject): void;
  reject(e: Error): void;
  timer?: NodeJS.Timeout;
}

export class AcpClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private proc: ProcessHandle;
  private exited: ProcessResult | undefined;
  readonly done: Promise<ProcessResult>;

  constructor(private opts: AcpClientOptions) {
    this.proc = startProcess({ ...opts.process, onStdoutLine: (l) => this.onLine(l) });
    this.done = this.proc.done.then((r) => {
      this.exited = r;
      const err = new AcpError(r.spawnError ? `Không chạy được tiến trình ACP: ${r.spawnError.message}` : 'Tiến trình ACP đã thoát.');
      for (const [, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      return r;
    });
  }

  get result(): ProcessResult | undefined {
    return this.exited;
  }

  request(method: string, params: JsonObject, timeoutMs?: number): Promise<JsonObject> {
    if (this.exited) return Promise.reject(new AcpError('Tiến trình ACP đã thoát.'));
    const id = this.nextId++;
    return new Promise<JsonObject>((resolve, reject) => {
      const p: Pending = { resolve, reject };
      if (timeoutMs) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AcpError(`ACP ${method} quá thời gian (${timeoutMs}ms).`));
        }, timeoutMs);
      }
      this.pending.set(id, p);
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: JsonObject): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  close(): void {
    this.proc.endStdin();
    this.proc.kill();
  }

  private send(msg: JsonObject): void {
    this.proc.write(`${JSON.stringify(msg)}\n`);
  }

  private onLine(line: string): void {
    const m = parseJsonLine(line);
    if (!m || m.jsonrpc !== '2.0') {
      this.opts.onNoise?.(line);
      return;
    }
    const method = str(m.method);
    const id = m.id;
    if (method === undefined && (typeof id === 'number' || typeof id === 'string')) {
      const p = this.pending.get(Number(id));
      if (!p) return;
      this.pending.delete(Number(id));
      if (p.timer) clearTimeout(p.timer);
      const err = obj(m.error);
      if (m.error) p.reject(new AcpError(str(err.message) ?? 'ACP error', num(err.code), err.data));
      else p.resolve(obj(m.result));
      return;
    }
    if (method === undefined) return;
    const params = obj(m.params);
    if (id === undefined) {
      if (method === 'session/update') this.opts.onUpdate?.(obj(params.update), str(params.sessionId));
      return;
    }
    // agent -> client request
    void this.answerRequest(id, method, params);
  }

  private async answerRequest(id: unknown, method: string, params: JsonObject): Promise<void> {
    const reply = (payload: JsonObject) => this.send({ jsonrpc: '2.0', id, ...payload });
    if (method === 'session/request_permission') {
      const call = obj(params.toolCall);
      const req: AcpPermissionRequest = {
        sessionId: str(params.sessionId),
        toolCall: {
          toolCallId: str(call.toolCallId),
          title: str(call.title),
          kind: str(call.kind),
          rawInput: call.rawInput,
          locations: arr(call.locations).map((l) => ({ path: str(obj(l).path) })),
        },
        options: arr(params.options).map((o) => ({ optionId: str(obj(o).optionId) ?? '', name: str(obj(o).name), kind: str(obj(o).kind) })),
      };
      let answer: AcpPermissionAnswer = 'cancel';
      try {
        answer = (await this.opts.onPermission?.(req)) ?? 'cancel';
      } catch {
        answer = 'cancel';
      }
      reply({ result: { outcome: answer === 'cancel' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: answer.optionId } } });
      return;
    }
    // fs/* and terminal/* are not offered (capabilities declare them off)
    reply({ error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

// ------------------------------------------------------------------ one prompt turn

export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface AcpTurnOptions {
  process: AcpClientOptions['process'];
  cwd: string;
  mcpServers: AcpMcpServer[];
  /** continue this session when the agent supports session/load */
  sessionId?: string;
  prompt: string;
  onPermission: AcpClientOptions['onPermission'];
  onUpdate(update: JsonObject): void;
  signal: AbortSignal;
  /** per-request timeout for initialize/session (the prompt itself is bounded by the process timeout) */
  setupTimeoutMs?: number;
}

export interface AcpTurnResult {
  sessionId?: string;
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number };
  /** resume was requested but session/load failed or is unsupported */
  loadFailed?: boolean;
  error?: AcpError;
  process?: ProcessResult;
}

export async function runAcpTurn(o: AcpTurnOptions): Promise<AcpTurnResult> {
  let ready = false;
  const client = new AcpClient({
    process: { ...o.process, signal: o.signal },
    // session/load replays history as updates: ignore everything until the session is ready
    onUpdate: (u) => ready && o.onUpdate(u),
    onPermission: o.onPermission,
  });
  const setup = o.setupTimeoutMs ?? 120_000;
  const out: AcpTurnResult = {};
  const onAbort = () => {
    if (out.sessionId) client.notify('session/cancel', { sessionId: out.sessionId });
  };
  o.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const init = await client.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }, setup);
    const loadSession = obj(init.agentCapabilities).loadSession === true;
    let sessionId: string | undefined;
    if (o.sessionId && loadSession) {
      try {
        await client.request('session/load', { sessionId: o.sessionId, cwd: o.cwd, mcpServers: o.mcpServers }, setup);
        sessionId = o.sessionId;
      } catch (e) {
        if (e instanceof AcpError && e.message.startsWith('Tiến trình ACP')) throw e;
        out.loadFailed = true;
      }
    } else if (o.sessionId) out.loadFailed = true;
    if (!sessionId) {
      const created = await client.request('session/new', { cwd: o.cwd, mcpServers: o.mcpServers }, setup);
      sessionId = str(created.sessionId);
      if (!sessionId) throw new AcpError('session/new không trả về sessionId.');
    }
    out.sessionId = sessionId;
    ready = true;
    const res = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: o.prompt }] });
    out.stopReason = str(res.stopReason);
    const u = obj(res.usage);
    out.usage = { inputTokens: num(u.inputTokens), outputTokens: num(u.outputTokens), cachedReadTokens: num(u.cachedReadTokens) };
  } catch (e) {
    out.error = e instanceof AcpError ? e : new AcpError(e instanceof Error ? e.message : String(e));
  } finally {
    o.signal.removeEventListener('abort', onAbort);
    client.close();
    out.process = await client.done;
  }
  return out;
}
