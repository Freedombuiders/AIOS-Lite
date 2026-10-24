import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bridgeCommand } from './index.js';

const TOOLS = [
  { name: 'pancake__orders_list', integrationId: 'pancake', command: 'orders list', description: 'Liệt kê đơn.', usage: 'orders list --since 7d', access: 'read', risk: 'read' },
  { name: 'pancake__orders_create', integrationId: 'pancake', command: 'orders create', description: 'Tạo đơn.', usage: 'orders create --json {...}', access: 'write', risk: 'write' },
  { name: 'pancake__orders_delete', integrationId: 'pancake', command: 'orders delete', description: 'Xoá đơn.', usage: 'orders delete --id 1', access: 'write', risk: 'destructive' },
];

let server: http.Server;
let url = '';
const calls: unknown[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer good') {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
      if (req.url === '/api/integrations/tools') return res.end(JSON.stringify({ tools: TOOLS }));
      const b = JSON.parse(body);
      calls.push(b);
      if (b.command === 'orders list') return res.end(JSON.stringify({ ok: true, result: { items: [1, 2] } }));
      if (b.command === 'orders create') return res.end(JSON.stringify({ ok: false, code: 'denied', message: 'Bạn không có quyền ghi.' }));
      return res.end(JSON.stringify({ ok: false, code: 'approval_pending', message: 'x', approvalId: 'ap1' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => void server.close());

function session(token: string) {
  const { command, args } = bridgeCommand();
  const child = spawn(command, args, { env: { ...process.env, AIOS_API_URL: url, AIOS_RUN_TOKEN: token }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiters = new Map<number, (m: any) => void>();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiters.get(m.id)?.(m);
    }
  });
  let n = 0;
  const rpc = (method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      const id = ++n;
      waiters.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return { rpc, notify: (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`), close: () => child.kill() };
}

describe('mcp bridge server', () => {
  it('speaks MCP: initialize, tools/list, tools/call (ok, denied, approval_pending)', async () => {
    const s = session('good');
    try {
      const init = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      expect(init.result.protocolVersion).toBe('2025-06-18');
      expect(init.result.capabilities.tools).toBeTruthy();
      s.notify('notifications/initialized');
      expect((await s.rpc('ping')).result).toEqual({});

      const list = await s.rpc('tools/list');
      expect(list.result.tools.map((t: any) => t.name)).toEqual(TOOLS.map((t) => t.name));
      expect(list.result.tools[0].inputSchema.properties.args.type).toBe('string');

      const ok = await s.rpc('tools/call', { name: 'pancake__orders_list', arguments: { args: '--since 7d' } });
      expect(ok.result.isError).toBeUndefined();
      expect(ok.result.content[0].text).toBe('{"items":[1,2]}');
      expect(calls.at(-1)).toEqual({ integration: 'pancake', command: 'orders list', args: '--since 7d' });

      const denied = await s.rpc('tools/call', { name: 'pancake__orders_create', arguments: {} });
      expect(denied.result).toMatchObject({ isError: true, content: [{ text: 'Bạn không có quyền ghi.' }] });

      const pending = await s.rpc('tools/call', { name: 'pancake__orders_delete', arguments: { args: '--id 1' } });
      expect(pending.result.isError).toBe(true);
      expect(pending.result.content[0].text).toContain('CHƯA chạy');
      expect(pending.result.content[0].text).toContain('ap1');

      expect((await s.rpc('tools/call', { name: 'nope' })).result.isError).toBe(true);
      expect((await s.rpc('resources/list')).error.code).toBe(-32601);
    } finally {
      s.close();
    }
  }, 20000);

  it('reports an error from tools/list when the token is rejected', async () => {
    const s = session('bad');
    try {
      await s.rpc('initialize', {});
      expect((await s.rpc('tools/list')).error.message).toContain('401');
    } finally {
      s.close();
    }
  }, 20000);
});
