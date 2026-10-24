import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHermesAcpPlan, buildHermesCliArgs, createHermesRuntime, decidePermission, hermesMode, parseHermesCliOutput } from './hermes.js';
import type { AcpPermissionRequest } from './acp.js';
import { fixture, makeReq, tmpCwd } from './test-util.js';

const opts = [
  { optionId: 'ok', kind: 'allow_once' },
  { optionId: 'always', kind: 'allow_always' },
  { optionId: 'no', kind: 'reject_once' },
];
const perm = (kind: string, paths: string[] = [], rawInput?: unknown): AcpPermissionRequest => ({ toolCall: { kind, locations: paths.map((path) => ({ path })), rawInput }, options: opts });
const ctx = { permission: 'safe' as const, lean: false, cwd: '/w', readRoots: ['/data/ro'], writeRoots: ['/data/rw'] };

describe('decidePermission', () => {
  it('safe allows read/search/edit inside the granted dirs', () => {
    expect(decidePermission(perm('read', ['/w/a.txt']), ctx)).toEqual({ optionId: 'ok' });
    expect(decidePermission(perm('search', ['/data/ro/x']), ctx)).toEqual({ optionId: 'ok' });
    expect(decidePermission(perm('edit', ['/data/rw/x']), ctx)).toEqual({ optionId: 'ok' });
    expect(decidePermission(perm('fetch'), ctx)).toEqual({ optionId: 'ok' });
    expect(decidePermission(perm('think'), ctx)).toEqual({ optionId: 'ok' });
  });

  it('safe rejects execute, outside paths, read-only edits and path tricks', () => {
    expect(decidePermission(perm('execute'), ctx)).toEqual({ optionId: 'no' });
    expect(decidePermission(perm('delete', ['/w/a']), ctx)).toEqual({ optionId: 'no' });
    expect(decidePermission(perm('read', ['/etc/passwd']), ctx)).toEqual({ optionId: 'no' });
    expect(decidePermission(perm('read', ['/w/../etc/passwd']), ctx)).toEqual({ optionId: 'no' });
    expect(decidePermission(perm('edit', ['/data/ro/x']), ctx)).toEqual({ optionId: 'no' });
    expect(decidePermission(perm('edit'), ctx)).toEqual({ optionId: 'no' });
    expect(decidePermission(perm('read', [], { file_path: '/etc/hosts' }), ctx)).toEqual({ optionId: 'no' });
    expect(decidePermission(perm('read', ['/wx/a']), ctx)).toEqual({ optionId: 'no' });
  });

  it('full allows everything; lean rejects everything but thinking', () => {
    expect(decidePermission(perm('execute'), { ...ctx, permission: 'full' })).toEqual({ optionId: 'ok' });
    expect(decidePermission(perm('read', ['/w/a']), { ...ctx, lean: true })).toEqual({ optionId: 'no' });
    expect(decidePermission(perm('think'), { ...ctx, lean: true })).toEqual({ optionId: 'ok' });
  });

  it('cancels when there is no matching option', () => {
    expect(decidePermission({ toolCall: { kind: 'execute' }, options: [] }, ctx)).toBe('cancel');
  });
});

describe('hermes plans', () => {
  it('ACP: profile and model before `acp`, MCP grants as mcpServers, system prompt inline on fresh sessions', () => {
    const plan = buildHermesAcpPlan(makeReq('/w', { agent: { model: 'm1', runtimeOptions: { profile: 'sales' } }, access: { mcpServers: [{ id: 'gh', command: 'npx', args: ['x'], env: { T: 'v' }, allowedTools: ['*'] }, { id: 'off', command: 'x', env: {}, allowedTools: [] }] } }));
    expect(plan.args).toEqual(['-p', 'sales', '-m', 'm1', 'acp']);
    expect(plan.mcpServers).toEqual([{ name: 'gh', command: 'npx', args: ['x'], env: [{ name: 'T', value: 'v' }] }]);
    expect(plan.prompt).toBe('Bạn là trợ lý.\n\n---\n\nxin chào');
    expect(buildHermesAcpPlan(makeReq('/w', { sessionId: 's' })).prompt).toBe('xin chào');
    expect(buildHermesAcpPlan(makeReq('/w', { tools: 'none', access: { mcpServers: [{ id: 'gh', command: 'x', env: {}, allowedTools: ['*'] }] } })).mcpServers).toEqual([]);
  });

  it('CLI fallback: chat -q, source tool, resume, system prompt in env', () => {
    const fresh = buildHermesCliArgs(makeReq('/w', { agent: { model: 'm1' } }));
    expect(fresh.args).toEqual(['chat', '-q', 'xin chào', '--source', 'tool', '-Q', '-m', 'm1', '-t', 'file,web,todo']);
    expect(fresh.env).toEqual({ HERMES_EPHEMERAL_SYSTEM_PROMPT: 'Bạn là trợ lý.' });
    const resumed = buildHermesCliArgs(makeReq('/w', { sessionId: 'abc' }));
    expect(resumed.args).toContain('--resume');
    expect(resumed.env).toEqual({});
    const full = buildHermesCliArgs(makeReq('/w', { access: { permission: 'full' } })).args;
    expect(full).toContain('--yolo');
    expect(full).not.toContain('-t');
    const lean = buildHermesCliArgs(makeReq('/w', { tools: 'none', access: { permission: 'full' } })).args;
    expect(lean).not.toContain('--yolo');
    expect(lean.slice(lean.indexOf('-t'))).toEqual(['-t', 'todo']);
    expect(lean).toContain('--max-turns');
    // safe never gets the terminal toolset
    expect(fresh.args.join(' ')).not.toMatch(/terminal|code_execution/);
  });

  it('parses session_id from stderr (or stdout) and keeps it out of the answer', () => {
    expect(parseHermesCliOutput('hello\n', '\nsession_id: 20261024_abc\nActivated Letta\n')).toEqual({ text: 'hello', sessionId: '20261024_abc' });
    expect(parseHermesCliOutput('hello\n\nsession_id: s1\n')).toEqual({ text: 'hello', sessionId: 's1' });
    expect(parseHermesCliOutput('Activated Letta OS memory (workspace: hermes)\nhello\n')).toEqual({ text: 'hello', sessionId: undefined });
  });

  it('mode: auto picks ACP for full or MCP grants, CLI otherwise; explicit option wins', () => {
    expect(hermesMode(makeReq('/w'))).toBe('cli');
    expect(hermesMode(makeReq('/w', { access: { permission: 'full' } }))).toBe('acp');
    expect(hermesMode(makeReq('/w', { tools: 'none', access: { permission: 'full' } }))).toBe('cli');
    expect(hermesMode(makeReq('/w', { access: { mcpServers: [{ id: 'g', command: 'x', env: {}, allowedTools: ['*'] }] } }))).toBe('acp');
    expect(hermesMode(makeReq('/w', { agent: { runtimeOptions: { mode: 'acp' } } }))).toBe('acp');
    expect(hermesMode(makeReq('/w', { access: { permission: 'full' }, agent: { runtimeOptions: { mode: 'cli' } } }))).toBe('cli');
  });
});

describe('hermes failures', () => {
  it('surfaces stdout of a failed CLI run as an auth error with a hint', async () => {
    const cwd = await tmpCwd();
    const rt = createHermesRuntime(fixture('fake-hermes.mjs'), { FAKE_SCENARIO: 'nologin' });
    const res = await rt.run(makeReq(cwd));
    expect(res.ok).toBe(false);
    expect(res.error?.family).toBe('auth');
    expect(res.error?.message).toContain('Not logged into Rocket Portal');
    expect(res.error?.message).toContain('hermes model');
  });

  it('doctor reports a logged-out provider as an error', async () => {
    const rep = await createHermesRuntime(fixture('fake-hermes.mjs'), { FAKE_SCENARIO: 'hermesnologin' }).doctor();
    expect(rep.status).toBe('fail');
    expect(rep.checks.find((c) => c.code === 'hermes.auth')).toMatchObject({ level: 'error' });
    const ok = await createHermesRuntime(fixture('fake-hermes.mjs')).doctor();
    expect(ok.checks.find((c) => c.code === 'hermes.auth')?.level).toBe('info');
  });
});

describe('hermes runtime with fake CLIs', () => {
  const rt = (scenario: string, extra: Record<string, string> = {}) => {
    const r = createHermesRuntime(fixture('fake-hermes.mjs'), { FAKE_SCENARIO: scenario, ...extra });
    // ACP tests force the transport; the safe default would use the CLI
    return { ...r, run: (req: Parameters<typeof r.run>[0]) => r.run({ ...req, agent: { ...req.agent, runtimeOptions: { mode: 'acp', ...req.agent.runtimeOptions } } }) };
  };

  it('ACP run: last assistant message only, usage with cache, session id', async () => {
    const cwd = await tmpCwd();
    const req = makeReq(cwd);
    const res = await rt('ok').run(req);
    expect(res.ok).toBe(true);
    expect(res.output).toBe('Xin chào (' + 'Bạn là trợ lý.\n\n---\n\nxin chào'.length + ')');
    expect(res.sessionId).toBe('acp-session-1');
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 7, cachedInputTokens: 20 });
    expect(req.events.map((e) => e.type)).toEqual(expect.arrayContaining(['thinking', 'tool', 'text', 'usage']));
  });

  it('sends mcpServers in session/new', async () => {
    const cwd = await tmpCwd();
    const rec = path.join(cwd, 'rec.jsonl');
    await rt('ok', { FAKE_RECORD: rec }).run(makeReq(cwd, { access: { mcpServers: [{ id: 'gh', command: 'npx', env: { T: 'v' }, allowedTools: ['*'] }] } }));
    const lines = (await readFile(rec, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const created = JSON.parse(lines.find((l) => l.kind === 'hermes-session-new').stdin);
    expect(created.mcpServers).toEqual([{ name: 'gh', command: 'npx', args: [], env: [{ name: 'T', value: 'v' }] }]);
    expect(created.cwd).toBe(cwd);
  });

  it('resume loads the session; a failed load asks to clear it', async () => {
    const cwd = await tmpCwd();
    const ok = await rt('ok').run(makeReq(cwd, { sessionId: 'prev' }));
    expect(ok).toMatchObject({ ok: true, sessionId: 'prev' });
    expect(ok.clearSession).toBeUndefined();
    expect(ok.output).not.toContain('REPLAYED');
    const bad = await rt('loadfail').run(makeReq(cwd, { sessionId: 'prev' }));
    expect(bad).toMatchObject({ ok: true, clearSession: true, sessionId: 'acp-session-1' });
  });

  it('rejects execute requests in safe mode', async () => {
    const cwd = await tmpCwd();
    expect((await rt('perm').run(makeReq(cwd))).output).toBe('permission:selected:no');
    expect((await rt('perm').run(makeReq(cwd, { access: { permission: 'full' } }))).output).toBe('permission:selected:ok');
  });

  it('refusal stop reason, timeout and missing binary', async () => {
    const cwd = await tmpCwd();
    expect((await rt('refusal').run(makeReq(cwd))).error?.family).toBe('refusal');
    expect((await rt('hang').run(makeReq(cwd, { timeoutMs: 400 }))).ok).toBe(false);
    expect((await createHermesRuntime('/nonexistent/hermes').run(makeReq(cwd))).error?.family).toBe('config');
  });

  it('cli mode runs hermes chat and reads the session id', async () => {
    const cwd = await tmpCwd();
    const rec = path.join(cwd, 'rec.jsonl');
    const res = await rt('ok', { FAKE_RECORD: rec }).run(makeReq(cwd, { agent: { runtimeOptions: { mode: 'cli', home: '/iso/home' } } }));
    expect(res).toMatchObject({ ok: true, sessionId: 'cli-session-1', output: 'hello' });
    expect(res.output).not.toContain('session_id');
    const r = JSON.parse((await readFile(rec, 'utf8')).trim());
    expect(r.env.HERMES_EPHEMERAL_SYSTEM_PROMPT).toBe('Bạn là trợ lý.');
    expect(r.env.HERMES_HOME).toBe('/iso/home');
    expect(r.argv).toContain('file,web,todo');
  });
});
