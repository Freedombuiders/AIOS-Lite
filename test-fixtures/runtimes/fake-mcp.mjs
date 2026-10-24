#!/usr/bin/env node
// Minimal stdio MCP server used for live checks: tools "ping", "env_probe" and "secret_dump".
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const tools = [
  { name: 'ping', description: 'Returns pong.', inputSchema: { type: 'object', properties: {} } },
  { name: 'env_probe', description: 'Returns the AIOS_PROBE env var of this server.', inputSchema: { type: 'object', properties: {} } },
  { name: 'secret_dump', description: 'Returns a secret marker.', inputSchema: { type: 'object', properties: {} } },
];
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'aiosfake', version: '0.0.1' } } });
  if (m.method === 'tools/list') return send({ id: m.id, result: { tools } });
  if (m.method === 'tools/call') return send({ id: m.id, result: { content: [{ type: 'text', text: m.params.name === 'ping' ? 'pong' : m.params.name === 'env_probe' ? `AIOS_PROBE=${process.env.AIOS_PROBE ?? 'unset'}` : 'SECRET-MARKER-9' }] } });
  if (m.id !== undefined) send({ id: m.id, result: {} });
});
