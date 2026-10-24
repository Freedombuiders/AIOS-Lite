import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** How to reach an MCP server: a remote endpoint (optional bearer token) or a local command. */
export interface McpTarget {
  url?: string;
  token?: string;
  command?: string;
}

/** Minimal client surface the syncs use; tests pass a fake. */
export interface McpSession {
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

export type McpConnector = (target: McpTarget) => Promise<{ session: McpSession; close(): Promise<void> }>;

export class McpConfigError extends Error {}

export function hasTarget(t: McpTarget): boolean {
  return !!(t.url?.trim() || t.command?.trim());
}

/** Split `cmd arg "two words"` into argv; no shell is involved. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

export const connectMcp: McpConnector = async (target) => {
  let transport;
  if (target.url?.trim()) {
    let url: URL;
    try { url = new URL(target.url.trim()); } catch { throw new McpConfigError('Địa chỉ MCP không hợp lệ.'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new McpConfigError('Địa chỉ MCP phải bắt đầu bằng http:// hoặc https://.');
    transport = new StreamableHTTPClientTransport(url, {
      requestInit: target.token ? { headers: { Authorization: `Bearer ${target.token}` } } : undefined,
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
  } else if (target.command?.trim()) {
    const [command, ...args] = splitCommand(target.command);
    if (!command) throw new McpConfigError('Lệnh MCP đang trống.');
    transport = new StdioClientTransport({ command, args });
  } else {
    throw new McpConfigError('Chưa cấu hình kết nối MCP.');
  }
  const client = new Client({ name: 'aios-finance', version: '1.0.0' });
  await client.connect(transport, { timeout: 20_000 });
  return {
    session: { callTool: (name, args, timeoutMs = 60_000) => client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }) },
    close: async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); },
  };
};

/** Parse the text content of an MCP tool result as JSON. Throws on tool errors. */
export function parseToolResult(result: unknown): unknown {
  const r = result as { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: unknown } | null;
  const text = (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  if (r?.isError) throw new Error(text.slice(0, 200) || 'Công cụ MCP trả lỗi');
  if (r?.structuredContent) return r.structuredContent;
  return text ? JSON.parse(text) : null;
}
