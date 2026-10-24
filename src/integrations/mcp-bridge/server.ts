// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0) that exposes the integrations an agent may use.
// Runs as a child of the agent runtime; it holds only a per-run token, never the integration keys.
// Node built-ins only, so it runs with plain `node` from dist and with `node --import tsx` from source.
import readline from 'node:readline';

const PROTOCOL_VERSION = '2025-06-18';

interface BridgeTool {
  name: string;
  integrationId: string;
  command: string;
  description: string;
  usage: string;
  access: string;
  risk: string;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface BridgeServerOptions {
  apiUrl: string;
  token: string;
  input?: NodeJS.ReadableStream;
  output?: { write(chunk: string): unknown };
  fetchImpl?: typeof fetch;
}

const ARGS_HELP = 'Tham số dạng dòng lệnh, ví dụ: --search 0901234567 --since 30d';

function riskNote(t: BridgeTool): string {
  if (t.risk === 'destructive') return 'Lệnh nguy hiểm: luôn phải chờ chủ duyệt.';
  if (t.risk === 'write' || t.access === 'write') return 'Lệnh ghi: có thể phải chờ chủ duyệt tuỳ quyền của bạn.';
  return 'Lệnh chỉ đọc.';
}

function toMcpTool(t: BridgeTool): McpTool {
  return {
    name: t.name,
    description: `${t.description} Cách dùng: ${t.usage}. ${riskNote(t)}`,
    inputSchema: { type: 'object', properties: { args: { type: 'string', description: ARGS_HELP } }, additionalProperties: false },
  };
}

const text = (s: string, isError = false) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) });

export function startBridgeServer(opts: BridgeServerOptions): { done: Promise<void> } {
  const doFetch = opts.fetchImpl ?? fetch;
  const out = opts.output ?? process.stdout;
  const base = opts.apiUrl.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' };
  let tools: BridgeTool[] | null = null;
  let toolsError = '';

  const send = (msg: object) => out.write(`${JSON.stringify(msg)}\n`);
  const reply = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result });
  const fail = (id: unknown, code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });

  async function loadTools(): Promise<BridgeTool[]> {
    if (tools) return tools;
    try {
      const res = await doFetch(`${base}/api/integrations/tools`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { tools?: BridgeTool[] };
      tools = Array.isArray(body.tools) ? body.tools : [];
      toolsError = '';
    } catch (e) {
      toolsError = e instanceof Error ? e.message : String(e);
      return [];
    }
    return tools;
  }

  async function callTool(name: string, args: unknown) {
    const list = await loadTools();
    const tool = list.find((t) => t.name === name);
    if (!tool) return text(`Không có công cụ "${name}" trong quyền của bạn.`, true);
    const argStr = args && typeof args === 'object' && typeof (args as { args?: unknown }).args === 'string' ? (args as { args: string }).args : '';
    let body: { ok?: boolean; result?: unknown; code?: string; message?: string; approvalId?: string };
    try {
      const res = await doFetch(`${base}/api/integrations/call`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ integration: tool.integrationId, command: tool.command, args: argStr }),
      });
      body = (await res.json()) as typeof body;
      if (!res.ok && body.ok !== false) body = { ok: false, code: 'api', message: `Máy chủ trả lỗi HTTP ${res.status}.` };
    } catch (e) {
      return text(`Không gọi được AIOS: ${e instanceof Error ? e.message : String(e)}`, true);
    }
    if (body.ok) return text(JSON.stringify(body.result ?? null));
    if (body.code === 'approval_pending') {
      const id = body.approvalId ? ` (mã ${body.approvalId})` : '';
      return text(`Lệnh CHƯA chạy: đã gửi chủ duyệt${id}. Chủ sẽ quyết định; kết quả sẽ được thêm vào việc này dưới dạng bình luận. Đừng gọi lại lệnh này, hãy kết thúc lượt hoặc làm phần việc khác.`, true);
    }
    return text(body.message || `Lệnh thất bại (${body.code ?? 'lỗi không rõ'}).`, true);
  }

  async function handle(msg: { id?: unknown; method?: string; params?: Record<string, unknown> }) {
    const { id, method } = msg;
    const isRequest = id !== undefined && id !== null;
    if (!method) return;
    if (!isRequest) return; // notifications (initialized, cancelled, ...) need no reply
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'aios-integrations', version: '1.0.0' },
        });
      case 'ping':
        return reply(id, {});
      case 'tools/list': {
        const list = await loadTools();
        if (!list.length && toolsError) return fail(id, -32603, `Không lấy được danh sách công cụ: ${toolsError}`);
        return reply(id, { tools: list.map(toMcpTool) });
      }
      case 'tools/call': {
        const p = msg.params ?? {};
        if (typeof p.name !== 'string') return fail(id, -32602, 'Thiếu tên công cụ.');
        return reply(id, await callTool(p.name, p.arguments));
      }
      default:
        return fail(id, -32601, `Không hỗ trợ phương thức ${method}.`);
    }
  }

  const rl = readline.createInterface({ input: opts.input ?? process.stdin });
  const pending = new Set<Promise<unknown>>();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      fail(null, -32700, 'JSON không hợp lệ.');
      return;
    }
    const p = handle(msg)
      .catch((e) => fail(msg.id ?? null, -32603, e instanceof Error ? e.message : String(e)))
      .finally(() => pending.delete(p));
    pending.add(p);
  });
  const done = new Promise<void>((resolve) => rl.on('close', () => void Promise.allSettled([...pending]).then(() => resolve())));
  return { done };
}

// Entry point when run as a process.
const apiUrl = process.env.AIOS_API_URL;
const token = process.env.AIOS_RUN_TOKEN;
if (process.argv[1] && /mcp-bridge[\\/]server\.(ts|js)$/.test(process.argv[1])) {
  if (!apiUrl || !token) {
    process.stderr.write('Thiếu AIOS_API_URL hoặc AIOS_RUN_TOKEN.\n');
    process.exit(1);
  }
  void startBridgeServer({ apiUrl, token }).done.then(() => process.exit(0));
}
