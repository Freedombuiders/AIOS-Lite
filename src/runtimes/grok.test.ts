import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyTurnBoundary, buildGrokArgs, createGrokParser, createGrokRuntime, grokSoftToolFilters } from './grok.js';
import { fixture, makeReq, tmpCwd } from './test-util.js';

const build = (over: Parameters<typeof makeReq>[1] = {}, opts: { fresh?: boolean; profileName?: string } = {}) => buildGrokArgs(makeReq('/w', over), { runDir: '/run', ...opts });
const after = (args: string[], flag: string) => args.slice(args.indexOf(flag) + 1);

describe('buildGrokArgs', () => {
  it('safe: strict sandbox, shell off, acceptEdits, never dontAsk, prompt from file', () => {
    const { args, files } = build({ agent: { model: 'grok-4' } });
    expect(after(args, '--prompt-file')[0]).toBe('/run/prompt.md');
    expect(after(args, '--output-format')[0]).toBe('streaming-json');
    expect(after(args, '--cwd')[0]).toBe('/w');
    expect(after(args, '--sandbox')[0]).toBe('strict');
    expect(after(args, '--disallowed-tools')[0]).toBe('run_terminal_command');
    expect(after(args, '--permission-mode')[0]).toBe('acceptEdits');
    expect(args).not.toContain('dontAsk');
    expect(args).not.toContain('--always-approve');
    expect(args).not.toContain('--add-dir');
    expect(after(args, '--rules')[0]).toBe('Bạn là trợ lý.');
    expect(after(args, '-m')[0]).toBe('grok-4');
    expect(files.find((f) => f.name === 'prompt.md')!.content).toBe('xin chào');
  });

  it('full: always-approve and no sandbox', () => {
    const { args } = build({ access: { permission: 'full' } });
    expect(args).toContain('--always-approve');
    expect(args).not.toContain('--sandbox');
    expect(args).not.toContain('--permission-mode');
  });

  it('tools none: only todo_write, one turn, no web', () => {
    const { args } = build({ tools: 'none', access: { permission: 'full', addDirs: ['/d'] } });
    expect(after(args, '--tools')[0]).toBe('todo_write');
    expect(after(args, '--max-turns')[0]).toBe('1');
    expect(args).toContain('--disable-web-search');
    expect(args).not.toContain('--always-approve');
    expect(args).not.toContain('--sandbox');
  });

  it('extra read/write roots go to a custom project sandbox profile', () => {
    const plan = build({ access: { addDirs: ['/data/ro', '/data/rw'], writeDirs: [{ folderId: 'x', root: '/data/rw', globs: ['**'] }] } }, { profileName: 'aios-test' });
    expect(after(plan.args, '--sandbox')[0]).toBe('aios-test');
    expect(plan.needsProjectFiles).toBe(true);
    const toml = plan.files.find((f) => f.name === '.grok/sandbox.toml')!.content;
    expect(toml).toContain('[profiles.aios-test]');
    expect(toml).toContain('extends = "strict"');
    expect(toml).toContain('read_only = ["/data/ro"]');
    expect(toml).toContain('read_write = ["/data/rw"]');
  });

  it('MCP grants: project config + --trust; soft tool filters reported', () => {
    const req = makeReq('/w', { access: { mcpServers: [{ id: 'gh', command: 'npx', args: ['x'], env: { T: 'v"1' }, allowedTools: ['search_*'] }, { id: 'off', command: 'o', env: {}, allowedTools: [] }] } });
    const plan = buildGrokArgs(req, { runDir: '/run' });
    const toml = plan.files.find((f) => f.name === '.grok/config.toml')!.content;
    expect(toml).toContain('[mcp_servers.gh]');
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain('env = { T = "v\\"1" }');
    expect(toml).not.toContain('off');
    expect(plan.args).toContain('--trust');
    // MCP cannot start under strict: always-approve + workspace sandbox, with a visible warning
    expect(plan.args).toContain('--always-approve');
    expect(after(plan.args, '--sandbox')[0]).toBe('workspace');
    expect(plan.warnings[0]).toContain('workspace');
    expect(grokSoftToolFilters(req)).toEqual(['gh']);
  });

  it('resume drops the rules; very long system prompts move into the prompt file', () => {
    const r = build({ sessionId: 's-1' });
    expect(after(r.args, '--resume')[0]).toBe('s-1');
    expect(r.args).not.toContain('--rules');
    const big = build({ systemPrompt: 'x'.repeat(200_000) });
    expect(big.args).not.toContain('--rules');
    expect(big.files.find((f) => f.name === 'prompt.md')!.content.length).toBeGreaterThan(200_000);
  });
});

describe('turn boundary', () => {
  it('inserts a newline between glued reasoning turns', () => {
    const st = { last: '', ticks: 0 as 0 | 1 };
    expect(applyTurnBoundary(st, 'Done.')).toBe('Done.');
    expect(applyTurnBoundary(st, 'Next step')).toBe('\nNext step');
    expect(applyTurnBoundary(st, ' and more')).toBe(' and more');
  });
});

describe('grok parser', () => {
  it('reads the recorded run', async () => {
    const events: unknown[] = [];
    const p = createGrokParser((e) => events.push(e));
    for (const l of (await readFile(fixture('events/grok-hello.jsonl'), 'utf8')).split('\n').filter(Boolean)) p.feed(l);
    const st = p.finish();
    expect(st.text).toBe('hello');
    expect(st.ended).toBe(true);
    expect(st.usage).toMatchObject({ inputTokens: 21742, outputTokens: 33 });
    expect(st.usage?.costUsd).toBeGreaterThan(0);
  });

  it('final output is the last turn after tool calls', async () => {
    const cwd = await tmpCwd();
    const req = makeReq(cwd);
    const res = await createGrokRuntime(fixture('fake-grok.mjs'), { FAKE_SCENARIO: 'tools' }).run(req);
    expect(res.output).toBe('Kết quả cuối.');
    expect(res.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, costUsd: 0.001 });
    expect(req.events).toContainEqual({ type: 'tool', name: 'read_file', input: '{"path":"a.txt"}', status: 'start' });
    const thinking = req.events.filter((e) => e.type === 'thinking').map((e) => (e as { text: string }).text).join('');
    expect(thinking).toBe('Xong bước một.\nTiếp theo');
  });
});

describe('grok runtime with a fake CLI', () => {
  const rt = (scenario: string, extra: Record<string, string> = {}) => createGrokRuntime(fixture('fake-grok.mjs'), { FAKE_SCENARIO: scenario, ...extra });

  it('turns off compat MCP scanners and keeps prompt out of argv', async () => {
    const cwd = await tmpCwd();
    const rec = path.join(cwd, 'rec.jsonl');
    const res = await rt('ok', { FAKE_RECORD: rec }).run(makeReq(cwd, { prompt: 'PROMPT-TEXT' }));
    expect(res.ok).toBe(true);
    const r = JSON.parse((await readFile(rec, 'utf8')).trim());
    expect(r.stdin).toBe('PROMPT-TEXT');
    expect(r.argv).not.toContain('PROMPT-TEXT');
    expect(r.env.GROK_CLAUDE_MCPS_ENABLED).toBe('false');
    expect(r.env.GROK_CURSOR_MCPS_ENABLED).toBe('false');
  });

  it('writes project files only for the run and restores the originals', async () => {
    const cwd = await tmpCwd();
    await mkdir(path.join(cwd, '.grok'));
    await writeFile(path.join(cwd, '.grok/config.toml'), '# mine\n');
    const res = await rt('ok').run(makeReq(cwd, { access: { mcpServers: [{ id: 'gh', command: 'x', env: {}, allowedTools: ['*'] }] } }));
    expect(res.ok).toBe(true);
    expect(await readFile(path.join(cwd, '.grok/config.toml'), 'utf8')).toBe('# mine\n');
    const cwd2 = await tmpCwd();
    await rt('ok').run(makeReq(cwd2, { access: { mcpServers: [{ id: 'gh', command: 'x', env: {}, allowedTools: ['*'] }] } }));
    expect(await readdir(cwd2)).toEqual(['.aios']);
  });

  it('unknown session retries fresh with clearSession', async () => {
    const cwd = await tmpCwd();
    const res = await rt('resumefail').run(makeReq(cwd, { sessionId: 'old' }));
    expect(res).toMatchObject({ ok: true, clearSession: true });
  });

  it('timeout and missing binary', async () => {
    const cwd = await tmpCwd();
    expect((await rt('hang').run(makeReq(cwd, { timeoutMs: 300 }))).error?.family).toBe('timeout');
    expect((await createGrokRuntime('/nonexistent/grok').run(makeReq(cwd))).error?.family).toBe('config');
  });
});
