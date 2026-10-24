import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, claudeResultFrom, createClaudeParser, createClaudeRuntime } from './claude.js';
import { fixture, makeReq, tmpCwd } from './test-util.js';
import type { McpGrant } from '../access/contracts.js';

const RUN = '/run';
const mcp = (over: Partial<McpGrant> = {}): McpGrant => ({ id: 'github', command: 'npx', args: ['gh-mcp'], env: { GH_TOKEN: 'ghp_secret' }, allowedTools: ['*'], ...over });
const build = (over: Parameters<typeof makeReq>[1] = {}, opts: { fresh?: boolean } = {}) => buildClaudeArgs(makeReq('/w', over), { runDir: RUN, ...opts });
const after = (args: string[], flag: string) => args.slice(args.indexOf(flag) + 1);

describe('buildClaudeArgs', () => {
  it('safe + defaults: restricted, acceptEdits, strict MCP, system prompt file', () => {
    const { args, files } = build({ agent: { model: 'sonnet' } });
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(args).toContain('--restricted');
    expect(after(args, '--permission-mode')[0]).toBe('acceptEdits');
    expect(args).toContain('--strict-mcp-config');
    expect(after(args, '--model')[0]).toBe('sonnet');
    expect(after(args, '--append-system-prompt-file')[0]).toBe(`${RUN}/system.md`);
    expect(files.map((f) => f.name)).toEqual(['system.md']);
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--resume');
  });

  it('full: skips permissions and does not use --restricted', () => {
    const { args } = build({ access: { permission: 'full' } });
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--restricted');
    expect(args).toContain('--strict-mcp-config');
  });

  it('tools none: single lean turn with no built-in tools', () => {
    const { args, files } = build({ tools: 'none', access: { mcpServers: [mcp()], addDirs: ['/data'] } });
    expect(after(args, '--max-turns')[0]).toBe('1');
    expect(args).toContain('--restricted');
    expect(after(args, '--tools')[0]).toBe('');
    expect(args).toContain('--disable-slash-commands');
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--add-dir');
    expect(files.map((f) => f.name)).toEqual(['system.md']);
  });

  it('resume sends the session id and no system prompt; fresh retry sends it again', () => {
    const r = build({ sessionId: 'abc-123' });
    expect(after(r.args, '--resume')[0]).toBe('abc-123');
    expect(r.args).not.toContain('--append-system-prompt-file');
    const f = build({ sessionId: 'abc-123' }, { fresh: true });
    expect(f.args).not.toContain('--resume');
    expect(f.args).toContain('--append-system-prompt-file');
  });

  it('MCP grants: config file with env, allowedTools per pattern', () => {
    const { args, files } = build({ access: { mcpServers: [mcp({ allowedTools: ['search_*', 'get_issue'] }), mcp({ id: 'db', allowedTools: ['*'], env: {} }), mcp({ id: 'off', allowedTools: [] })] } });
    const cfg = JSON.parse(files.find((f) => f.name === 'mcp.json')!.content);
    expect(Object.keys(cfg.mcpServers)).toEqual(['github', 'db']);
    expect(cfg.mcpServers.github.env).toEqual({ GH_TOKEN: 'ghp_secret' });
    expect(after(args, '--mcp-config')[0]).toBe(`${RUN}/mcp.json`);
    const allow = after(args, '--allowedTools');
    expect(allow).toEqual(expect.arrayContaining(['mcp__github__search_*', 'mcp__github__get_issue', 'mcp__db']));
    expect(allow).not.toContain('mcp__off');
    // secrets never appear in argv
    expect(JSON.stringify(args)).not.toContain('ghp_secret');
  });

  it('full + restricted MCP patterns keeps the allow-list in force (no bypass)', () => {
    const { args } = build({ access: { permission: 'full', mcpServers: [mcp({ allowedTools: ['search_*'] })] } });
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(after(args, '--permission-mode')[0]).toBe('acceptEdits');
    expect(after(args, '--allowedTools')).toEqual(expect.arrayContaining(['mcp__github__search_*', 'Bash']));
  });

  it('addDirs become --add-dir; read-only ones are denied for Edit/Write', () => {
    const { args } = build({ access: { addDirs: ['/data/ban-hang', '/data/notes'], writeDirs: [{ folderId: 'n', root: '/data/notes', globs: ['**'] }] } });
    expect(args.filter((a, i) => args[i - 1] === '--add-dir')).toEqual(['/data/ban-hang', '/data/notes']);
    const denied = after(args, '--disallowedTools');
    expect(denied).toContain('Edit(//data/ban-hang/**)');
    expect(denied).toContain('Write(//data/ban-hang/**)');
    expect(denied.join(' ')).not.toContain('/data/notes/');
  });

  it('maxTurns runtime option', () => {
    expect(after(build({ agent: { runtimeOptions: { maxTurns: 7 } } }).args, '--max-turns')[0]).toBe('7');
  });
});

const line = (o: unknown) => JSON.stringify(o);

describe('claude parser', () => {
  it('reads the recorded real run', async () => {
    const events: unknown[] = [];
    const p = createClaudeParser((e) => events.push(e));
    for (const l of (await readFile(fixture('events/claude-hello.jsonl'), 'utf8')).split('\n').filter(Boolean)) p.feed(l);
    const parsed = p.finish();
    const res = claudeResultFrom(parsed)!;
    expect(res.ok).toBe(true);
    expect(res.output).toBe('hello');
    expect(res.sessionId).toBeTruthy();
    expect(res.model).toBe('claude-sonnet-5-5');
    expect(res.usage?.costUsd).toBeCloseTo(0.0193094);
    // input includes cache read + creation
    expect(res.usage?.inputTokens).toBe(2 + 4564 + 10094);
    expect(res.usage?.cachedInputTokens).toBe(10094);
    expect(events).toContainEqual({ type: 'text', text: 'hello' });
  });

  it('deduplicates assistant usage by message id when there is no result', () => {
    const p = createClaudeParser(() => {});
    const msg = (text: string) => line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text }], usage: { input_tokens: 5, output_tokens: 9 } } });
    p.feed(msg('a'));
    p.feed(msg('b'));
    const parsed = p.finish();
    expect(parsed.assistantUsage).toEqual({ inputTokens: 5, outputTokens: 9 });
    expect(claudeResultFrom(parsed)).toBeUndefined();
  });

  it('refusal with exit 0 is a refusal', () => {
    const p = createClaudeParser(() => {});
    p.feed(line({ type: 'result', subtype: 'success', is_error: false, result: '', stop_reason: 'refusal' }));
    expect(claudeResultFrom(p.finish())).toMatchObject({ ok: false, error: { family: 'refusal' } });
  });

  it('classifies auth/quota only from parsed result fields', () => {
    const run = (result: string) => {
      const p = createClaudeParser(() => {});
      p.feed(line({ type: 'result', subtype: 'success', is_error: true, result }));
      return claudeResultFrom(p.finish())!.error!.family;
    };
    expect(run('Invalid API key · Please run /login')).toBe('auth');
    expect(run("You've hit your usage limit")).toBe('quota');
    // a successful answer that talks about auth stays a success
    const p = createClaudeParser(() => {});
    p.feed(line({ type: 'result', subtype: 'success', is_error: false, result: 'Hãy nhập API key hợp lệ (401 unauthorized) để đăng nhập.' }));
    expect(claudeResultFrom(p.finish())!.ok).toBe(true);
  });

  it('max turns is a failure with a readable message', () => {
    const p = createClaudeParser(() => {});
    p.feed(line({ type: 'result', subtype: 'error_max_turns', is_error: false, result: '' }));
    expect(claudeResultFrom(p.finish())).toMatchObject({ ok: false, error: { family: 'unknown' } });
  });
});

describe('claude runtime with a fake CLI', () => {
  const rt = (scenario: string, extra: Record<string, string> = {}) => createClaudeRuntime(fixture('fake-claude.mjs'), { FAKE_SCENARIO: scenario, ...extra });

  it('runs, streams and cleans the run dir', async () => {
    const cwd = await tmpCwd();
    const req = makeReq(cwd);
    const res = await rt('ok').run(req);
    expect(res).toMatchObject({ ok: true, output: 'hello' });
    expect(req.events.some((e) => e.type === 'usage')).toBe(true);
    expect(await readdir(path.join(cwd, '.aios'))).toEqual([]);
  });

  it('removes CLAUDECODE*/AIOS secrets and passes granted env, prompt on stdin', async () => {
    const cwd = await tmpCwd();
    const rec = path.join(cwd, 'rec.jsonl');
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_SESSION = 'x';
    process.env.AIOS_TOKEN = 'secret-token';
    try {
      await rt('ok', { FAKE_RECORD: rec }).run(makeReq(cwd, { prompt: 'PROMPT-TEXT', access: { envVars: { GRANTED_KEY: 'v1' } } }));
    } finally {
      delete process.env.CLAUDECODE;
      delete process.env.CLAUDE_CODE_SESSION;
      delete process.env.AIOS_TOKEN;
    }
    const r = JSON.parse((await readFile(rec, 'utf8')).trim());
    expect(r.stdin).toBe('PROMPT-TEXT');
    expect(r.env.CLAUDECODE).toBeUndefined();
    expect(r.env.CLAUDE_CODE_SESSION).toBeUndefined();
    expect(r.env.AIOS_TOKEN).toBeUndefined();
    expect(r.env.GRANTED_KEY).toBe('v1');
    expect(r.argv.join(' ')).not.toContain('PROMPT-TEXT');
  });

  it('maps auth, quota and refusal', async () => {
    const cwd = await tmpCwd();
    expect((await rt('autherror').run(makeReq(cwd))).error?.family).toBe('auth');
    const q = await rt('quota').run(makeReq(cwd));
    expect(q.error?.family).toBe('quota');
    expect(q.error?.retryAfter).toBe(new Date(1900000000 * 1000).toISOString());
    expect((await rt('refusal').run(makeReq(cwd))).error?.family).toBe('refusal');
  });

  it('resume failure retries once fresh and asks to clear the session', async () => {
    const cwd = await tmpCwd();
    const rec = path.join(cwd, 'rec.jsonl');
    const res = await rt('resumefail', { FAKE_RECORD: rec }).run(makeReq(cwd, { sessionId: 'dead-session' }));
    expect(res).toMatchObject({ ok: true, clearSession: true });
    const calls = (await readFile(rec, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(calls).toHaveLength(2);
    expect(calls[0].argv).toContain('--resume');
    expect(calls[1].argv).not.toContain('--resume');
    expect(calls[1].argv).toContain('--append-system-prompt-file');
  });

  it('timeout, abort, missing binary and crash', async () => {
    const cwd = await tmpCwd();
    expect((await rt('hang').run(makeReq(cwd, { timeoutMs: 300 }))).error?.family).toBe('timeout');
    const ac = new AbortController();
    const p = rt('hang').run(makeReq(cwd, { signal: ac.signal }));
    setTimeout(() => ac.abort(), 200);
    expect((await p).error?.family).toBe('cancelled');
    const missing = await createClaudeRuntime('/nonexistent/claude').run(makeReq(cwd));
    expect(missing.error?.family).toBe('config');
    const crash = await rt('crash').run(makeReq(cwd));
    expect(crash.ok).toBe(false);
    expect(crash.error?.message).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz');
  });
});
