import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const serverPath = path.resolve('../rocketflow-extension/rocketflow/mcp-server/index.mjs');
// Optional sibling checkout integration; no Chrome/provider or paid requests.
describe.skipIf(!fs.existsSync(serverPath))('paired extension protocol', () => {
  it('rejects unpaired peers, reuses queue protocol, surfaces disconnect and cleans up subprocess', async () => {
    const require = createRequire(serverPath); const { WebSocket } = require('ws');
    const port = 22000 + Math.floor(Math.random() * 10000); const token = randomBytes(32).toString('hex');
    const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], stderr: 'ignore', env: { ...process.env as Record<string, string>, ROCKETFLOW_APP_TOKEN: token, ROCKETFLOW_MCP_PORTS: String(port) } });
    const client = new Client({ name: 'mock-extension-test', version: '1' });
    const sockets: any[] = [];
    try {
      await client.connect(transport);
      const connect = () => { const ws = new WebSocket(`ws://127.0.0.1:${port}/rocketflow`, { origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }); sockets.push(ws); return ws; };
      const rogue = connect(); await new Promise<void>(resolve => rogue.once('open', () => { rogue.send(JSON.stringify({ type: 'hello' })); rogue.once('close', () => resolve()); }));
      const offline = await client.callTool({ name: 'rocketflow_status', arguments: {} }); expect(JSON.stringify(offline)).toContain('CHƯA'); expect(JSON.stringify(offline)).not.toContain('null');
      const ws = connect(); const nonce = randomBytes(32).toString('hex'); let enqueues = 0; let reads = 0;
      const mac = (value: string) => createHmac('sha256', token).update(value).digest('hex');
      const paired = new Promise<void>(resolve => ws.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'pair') { expect(msg.proof).toBe(mac(`server:${nonce}:${msg.nonce}`)); ws.send(JSON.stringify({ type: 'hello', version: 'test', proof: mac(`client:${nonce}:${msg.nonce}`) })); }
        if (msg.type === 'paired') resolve();
        if (msg.type === 'cmd') {
          if (msg.cmd === 'enqueue') { enqueues++; ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, batchId: 'mock-batch', added: 1 })); }
          if (msg.cmd === 'job') { reads++; if (reads === 1) ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, batchId: 'mock-batch', done: true, items: [{ batchId: 'mock-batch', provider: 'flow', type: 'video', prompt: 'mock only', status: 'done', results: [{ kind: 'video', path: '/fixture/download.mp4' }] }] })); else ws.close(); }
        }
      }));
      await new Promise<void>(resolve => ws.once('open', () => { ws.send(JSON.stringify({ type: 'hello', nonce })); resolve(); })); await paired;
      const result = await client.callTool({ name: 'generate_video', arguments: { prompts: ['mock only'], wait_seconds: 0 } });
      expect(JSON.stringify(result)).toContain('mock-batch'); expect(enqueues).toBe(1);
      const details = await client.callTool({ name: 'get_job_details', arguments: { job_id: 'mock-batch' } });
      expect(details.isError).not.toBe(true); expect(JSON.stringify(details)).toContain('/fixture/download.mp4');
      const disconnected = await client.callTool({ name: 'get_job', arguments: { job_id: 'mock-batch', wait_seconds: 0 } });
      expect(disconnected.isError).toBe(true); expect(JSON.stringify(disconnected)).toContain('disconnected'); expect(enqueues).toBe(1);
    } finally { sockets.forEach(ws => ws.terminate()); await client.close(); }
  }, 15_000);
});

describe.skipIf(!fs.existsSync(serverPath))('automatic local extension connection', () => {
  it('rejects web origins and mismatched extension identity, connects without pairing credentials', async () => {
    const require = createRequire(serverPath); const { WebSocket } = require('ws');
    const port = 22000 + Math.floor(Math.random() * 10000);
    const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], stderr: 'ignore', env: { ...process.env as Record<string,string>, ROCKETFLOW_APP_LOCAL: '1', ROCKETFLOW_MCP_PORTS: String(port) } });
    const client = new Client({ name: 'local-test', version: '1' }); const sockets: any[] = [];
    try {
      await client.connect(transport);
      const open = (origin: string) => { const s = new WebSocket(`ws://127.0.0.1:${port}/rocketflow`, { origin }); sockets.push(s); return s; };
      const web = open('http://127.0.0.1:5173'); await new Promise<void>(resolve => web.once('close', () => resolve()));
      const wrong = open(`chrome-extension://${'a'.repeat(32)}`);
      await new Promise<void>(resolve => { wrong.once('close', () => resolve()); wrong.once('open', () => wrong.send(JSON.stringify({type:'hello',extId:'b'.repeat(32)}))); });
      const good = open(`chrome-extension://${'a'.repeat(32)}`);
      const ready = await new Promise<any>(resolve => { good.once('message', (raw: Buffer) => resolve(JSON.parse(raw.toString()))); good.once('open', () => good.send(JSON.stringify({type:'hello',extId:'a'.repeat(32),version:'test'}))); });
      expect(ready).toEqual({ type: 'app_ready', protocol: 1 });
    } finally { sockets.forEach(s => s.terminate()); await client.close(); }
  });
});
