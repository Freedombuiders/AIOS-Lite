import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PROJECT_ROOT } from '../paths.js';

export type ToolCall = (name: string, args: Record<string, unknown>) => Promise<string>;
/** One persistent connection: opening a process per poll would exhaust RocketFlow's ports. */
export class RocketFlowBridge {
  private connecting?: Promise<Client>;
  private closing = false;
  constructor(private readonly serverOverride?: string) {}
  /** ROCKETFLOW_MCP_SERVER, or the extension checked out next to the app. */
  get serverPath(): string { return this.serverOverride ?? (process.env.ROCKETFLOW_MCP_SERVER || path.resolve(PROJECT_ROOT, '../rocketflow-extension/rocketflow/mcp-server/index.mjs')); }
  private connect(): Promise<Client> {
    if (!this.connecting) {
      this.connecting = (async () => {
        if (!fs.existsSync(this.serverPath)) throw new Error('Không tìm thấy RocketFlow MCP. Đặt ROCKETFLOW_MCP_SERVER tới file rocketflow/mcp-server/index.mjs rồi khởi động lại ứng dụng.');
        const client = new Client({ name: 'aios-video-studio', version: '1.0.0' });
        const env: Record<string, string> = { ...process.env as Record<string, string>, ROCKETFLOW_APP_LOCAL: '1', ROCKETFLOW_MCP_PORTS: '17898' };
        delete env.ROCKETFLOW_APP_TOKEN;
        const transport = new StdioClientTransport({ env, command: process.execPath, args: [this.serverPath], stderr: 'ignore' });
        try { await client.connect(transport); } catch (e) { await transport.close(); throw e; }
        client.onclose = () => { this.connecting = undefined; };
        return client;
      })().catch(e => { this.connecting = undefined; throw e; });
    }
    return this.connecting;
  }
  call: ToolCall = async (name, args) => {
    if (this.closing) throw new Error('RocketFlow service closing');
    const client = await this.connect();
    // Never retry writes: a timeout may happen after the extension accepted a batch.
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 100_000 });
    const content = result.content as { type: string; text?: string }[];
    const text = content.filter(c => c.type === 'text').map(c => c.text || '').join('\n');
    if (result.isError) throw new Error(text || 'RocketFlow báo lỗi.');
    return text;
  };
  async close() { this.closing = true; const pending = this.connecting; this.connecting = undefined; if (pending) await pending.then(client => client.close()).catch(() => {}); this.closing = false; }
}
