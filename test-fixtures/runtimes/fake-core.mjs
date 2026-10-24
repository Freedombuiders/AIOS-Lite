// Fake CLIs for adapter tests. Behaviour comes from env FAKE_SCENARIO; FAKE_RECORD=<file> logs argv/stdin/env.
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scenario = process.env.FAKE_SCENARIO ?? 'ok';
const events = (name) => readFileSync(path.join(here, 'events', name), 'utf8').split('\n').filter(Boolean);
const out = (line) => process.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
}

function record(kind, stdin) {
  if (!process.env.FAKE_RECORD) return;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDE|AIOS_|COMPOSIO|HERMES_|GROK_|GRANTED_|MCP_|EXTRA_|OPENAI)/.test(k)));
  appendFileSync(process.env.FAKE_RECORD, `${JSON.stringify({ kind, argv: process.argv.slice(2), stdin, env, cwd: process.cwd() })}\n`);
}

function handleMeta() {
  const a = process.argv.slice(2);
  if (a.includes('--version')) { console.log('fake-cli 1.2.3'); process.exit(0); }
  if (a[0] === 'auth' && a[1] === 'status') { console.log(JSON.stringify({ loggedIn: scenario !== 'loggedout' })); process.exit(0); }
  if (a[0] === 'status') { console.log(`  Provider:     Rocket Portal\n◆ Auth Providers\n  Nous Portal   ${scenario === 'hermesnologin' ? '✗ not logged in (run: hermes portal)' : '✓ logged in'}`); process.exit(0); }
  if (a[0] === 'acp' && a[1] === '--check') { console.log('Hermes ACP check OK'); process.exit(scenario === 'acpbad' ? 1 : 0); }
}
handleMeta();

const hang = () => new Promise(() => setInterval(() => {}, 1000));

export async function claude() {
  const stdin = await readStdin();
  record('claude', stdin);
  const args = process.argv.slice(2);
  const resuming = args.includes('--resume');
  if (scenario === 'hang') return hang();
  if (scenario === 'resumefail' && resuming) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'No conversation found with session ID: x', session_id: 'dead', errors: ['No conversation found with session ID: x'] });
    process.exit(1);
  }
  if (scenario === 'autherror') {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', session_id: 's', stop_reason: 'stop_sequence' });
    process.exit(1);
  }
  if (scenario === 'refusal') {
    out({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-test' });
    out({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: 's1', stop_reason: 'refusal' });
    process.exit(0);
  }
  if (scenario === 'quota') {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000 } });
    out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your usage limit", session_id: 's' });
    process.exit(1);
  }
  if (scenario === 'crash') {
    process.stderr.write('Segmentation fault ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz\n');
    process.exit(139);
  }
  for (const l of events('claude-hello.jsonl')) out(l);
}

export async function codex() {
  const stdin = await readStdin();
  record('codex', stdin);
  const args = process.argv.slice(2);
  if (scenario === 'hang') return hang();
  if (scenario === 'resumefail' && args[1] === 'resume') {
    process.stderr.write('Error: no rollout found for thread id 123\n');
    process.exit(1);
  }
  if (scenario === 'turnfailed') {
    out({ type: 'thread.started', thread_id: 't1' });
    out({ type: 'turn.failed', error: { message: 'You exceeded your current quota, please check your plan' } });
    process.exit(1);
  }
  for (const l of events('codex-hello.jsonl')) out(l);
}

export async function grok() {
  const args = process.argv.slice(2);
  record('grok', args.includes('--prompt-file') ? readFileSync(args[args.indexOf('--prompt-file') + 1], 'utf8') : '');
  if (scenario === 'hang') return hang();
  if (scenario === 'resumefail' && args.includes('--resume')) {
    out({ type: 'error', message: 'Unknown session: abc' });
    process.exit(1);
  }
  if (scenario === 'tools') {
    out({ type: 'text', data: 'Để tôi xem.' });
    out({ type: 'tool_call', toolCallId: 'c1', toolName: 'read_file', rawInput: { path: 'a.txt' }, status: 'pending' });
    out({ type: 'tool_call_update', toolCallId: 'c1', status: 'completed' });
    out({ type: 'thought', data: 'Xong bước một.' });
    out({ type: 'thought', data: 'Tiếp theo' });
    out({ type: 'text', data: 'Kết quả cuối.' });
    out({ type: 'end', stopReason: 'end_turn', sessionId: 'g1', usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.001 });
    return;
  }
  for (const l of events('grok-hello.jsonl')) out(l);
}

/** Fake ACP agent (hermes acp) and `hermes chat -q`. */
export async function hermes() {
  const args = process.argv.slice(2);
  if (args.includes('chat')) {
    record('hermes-cli', '');
    if (scenario === 'hang') return hang();
    if (scenario === 'nologin') {
      out('Not logged into Rocket Portal. Run `hermes auth add rocket` first. Run `hermes model` to re-authenticate.');
      process.exit(1);
    }
    process.stderr.write('\nsession_id: cli-session-1\nActivated Letta OS memory\n');
    out('hello');
    return;
  }
  record('hermes-acp', '');
  const rl = readline.createInterface({ input: process.stdin });
  const send = (m) => out({ jsonrpc: '2.0', ...m });
  let sessionId = 'acp-session-1';
  const waiters = new Map();
  let nextReq = 100;
  const ask = (method, params) => new Promise((resolve) => { const id = nextReq++; waiters.set(id, resolve); send({ id, method, params }); });
  rl.on('line', async (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.method === undefined && waiters.has(m.id)) { waiters.get(m.id)(m.result); return; }
    if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: scenario !== 'noload' }, agentInfo: { name: 'fake-hermes', version: '0' } } });
    if (m.method === 'session/new') { record('hermes-session-new', JSON.stringify(m.params)); return send({ id: m.id, result: { sessionId } }); }
    if (m.method === 'session/load') {
      if (scenario === 'loadfail') return send({ id: m.id, error: { code: -32602, message: 'Session not found' } });
      sessionId = m.params.sessionId;
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED-HISTORY' } } } });
      return send({ id: m.id, result: {} });
    }
    if (m.method === 'session/prompt') {
      const text = m.params.prompt.map((p) => p.text).join('');
      const upd = (update) => send({ method: 'session/update', params: { sessionId, update } });
      if (scenario === 'hang') return;
      if (scenario === 'perm') {
        const res = await ask('session/request_permission', { sessionId, toolCall: { toolCallId: 't1', title: 'rm -rf', kind: 'execute', rawInput: { command: 'rm -rf /' } }, options: [{ optionId: 'ok', kind: 'allow_once', name: 'Allow' }, { optionId: 'no', kind: 'reject_once', name: 'Reject' }] });
        upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `permission:${res.outcome.outcome}:${res.outcome.optionId ?? ''}` } });
        return send({ id: m.id, result: { stopReason: 'end_turn' } });
      }
      upd({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'nghĩ' } });
      upd({ sessionUpdate: 'tool_call', toolCallId: 'x', title: 'read', kind: 'read', rawInput: { path: '/tmp/a' } });
      upd({ sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'completed' });
      upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Xin ' } });
      upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `chào (${text.length})` } });
      return send({ id: m.id, result: { stopReason: scenario === 'refusal' ? 'refusal' : 'end_turn', usage: { inputTokens: 100, outputTokens: 7, cachedReadTokens: 20 } } });
    }
    if (m.method === 'session/cancel') return;
    if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'nope' } });
  });
}
