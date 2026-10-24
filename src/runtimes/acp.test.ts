import { describe, expect, it } from 'vitest';
import { AcpClient, runAcpTurn } from './acp.js';
import { fixture, tmpCwd } from './test-util.js';

const env = (scenario: string) => ({ PATH: process.env.PATH ?? '', FAKE_SCENARIO: scenario });
const proc = async (scenario: string) => ({ command: fixture('fake-hermes.mjs'), args: ['acp'], cwd: await tmpCwd(), env: env(scenario), timeoutMs: 15_000 });

describe('AcpClient', () => {
  it('initialize / session/new round trip and unknown agent methods', async () => {
    const c = new AcpClient({ process: await proc('ok') });
    const init = await c.request('initialize', { protocolVersion: 1 });
    expect(init.protocolVersion).toBe(1);
    const created = await c.request('session/new', { cwd: '/x', mcpServers: [] });
    expect(created.sessionId).toBe('acp-session-1');
    await expect(c.request('nope', {})).rejects.toMatchObject({ code: -32601 });
    c.close();
    await c.done;
  });

  it('rejects pending requests when the process dies', async () => {
    const c = new AcpClient({ process: { ...(await proc('ok')), command: '/nonexistent/hermes' } });
    await expect(c.request('initialize', {})).rejects.toThrow();
    await c.done;
  });
});

describe('runAcpTurn', () => {
  const run = async (scenario: string, extra: Partial<Parameters<typeof runAcpTurn>[0]> = {}) => {
    const updates: string[] = [];
    const p = await proc(scenario);
    const res = await runAcpTurn({
      process: p,
      cwd: p.cwd,
      mcpServers: [],
      prompt: 'xin chào',
      onPermission: () => 'cancel',
      onUpdate: (u) => updates.push(String(u.sessionUpdate)),
      signal: new AbortController().signal,
      ...extra,
    });
    return { res, updates };
  };

  it('new session, updates and usage', async () => {
    const { res, updates } = await run('ok');
    expect(res.error).toBeUndefined();
    expect(res.sessionId).toBe('acp-session-1');
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 7, cachedReadTokens: 20 });
    expect(updates).toEqual(['agent_thought_chunk', 'tool_call', 'tool_call_update', 'agent_message_chunk', 'agent_message_chunk']);
  });

  it('session/load: replayed history is ignored', async () => {
    const { res, updates } = await run('ok', { sessionId: 'old-1' });
    expect(res.sessionId).toBe('old-1');
    expect(res.loadFailed).toBeUndefined();
    expect(updates).not.toContain('REPLAYED');
    expect(updates.filter((u) => u === 'agent_message_chunk')).toHaveLength(2);
  });

  it('load failure or missing loadSession falls back to a new session', async () => {
    const a = await run('loadfail', { sessionId: 'old-1' });
    expect(a.res).toMatchObject({ loadFailed: true, sessionId: 'acp-session-1' });
    const b = await run('noload', { sessionId: 'old-1' });
    expect(b.res).toMatchObject({ loadFailed: true, sessionId: 'acp-session-1' });
  });

  it('answers permission requests', async () => {
    const seen: string[] = [];
    const { res } = await run('perm', { onPermission: (r) => (seen.push(`${r.toolCall.kind}:${r.options.length}`), { optionId: 'no' }) });
    expect(res.error).toBeUndefined();
    expect(seen).toEqual(['execute:2']);
  });
});
