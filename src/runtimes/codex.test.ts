import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCodexArgs, createCodexParser, createCodexRuntime } from './codex.js';
import { fixture, makeReq, tmpCwd } from './test-util.js';

const build = (over: Parameters<typeof makeReq>[1] = {}, opts: { fresh?: boolean } = {}) => buildCodexArgs(makeReq('/w', over), opts);
const cfgs = (args: string[]) => args.filter((a, i) => args[i - 1] === '-c');
const after = (args: string[], flag: string) => args.slice(args.indexOf(flag) + 1);

describe('buildCodexArgs', () => {
  it('safe without write grants: read-only, user config/apps/plugins off, prompt via stdin', () => {
    const { args, stdin } = build({ agent: { model: 'gpt-x' } });
    expect(args.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check']);
    expect(after(args, '-C')[0]).toBe('/w');
    expect(after(args, '-s')[0]).toBe('read-only');
    expect(after(args, '-m')[0]).toBe('gpt-x');
    expect(args).toContain('--ignore-user-config');
    expect(args.join(' ')).toContain('--disable apps --disable plugins');
    expect(args[args.length - 1]).toBe('-');
    expect(stdin).toBe('Bạn là trợ lý.\n\n---\n\nxin chào');
  });

  it('safe with write grants: workspace-write plus --add-dir for extra roots', () => {
    const { args } = build({ access: { writeDirs: [{ folderId: 'a', root: '/data/a', globs: ['**'] }, { folderId: 'w', root: '/w', globs: ['**'] }] } });
    expect(after(args, '-s')[0]).toBe('workspace-write');
    expect(args.filter((a, i) => args[i - 1] === '--add-dir')).toEqual(['/data/a']);
  });

  it('full: danger-full-access', () => {
    expect(after(build({ access: { permission: 'full' } }).args, '-s')[0]).toBe('danger-full-access');
  });

  it('shell env policy exposes only core and granted names (no values in argv)', () => {
    const { args } = build({ access: { envVars: { MY_TOKEN: 'super-secret' } } });
    const c = cfgs(args);
    expect(c).toContain('shell_environment_policy.ignore_default_excludes=true');
    const only = c.find((x) => x.startsWith('shell_environment_policy.include_only='))!;
    expect(only).toContain('"MY_TOKEN"');
    expect(only).toContain('"PATH"');
    expect(JSON.stringify(args)).not.toContain('super-secret');
  });

  it('tools none: ephemeral, read-only, shell and web disabled, no MCP/images', () => {
    const { args } = build({ tools: 'none', images: ['/i.png'], access: { permission: 'full', mcpServers: [{ id: 'g', command: 'x', env: {}, allowedTools: ['*'] }] } });
    expect(args).toContain('--ephemeral');
    expect(after(args, '-s')[0]).toBe('read-only');
    expect(args.join(' ')).toContain('--disable shell_tool');
    expect(cfgs(args)).toContain('web_search="disabled"');
    expect(cfgs(args).some((c) => c.startsWith('mcp_servers'))).toBe(false);
    expect(args).not.toContain('-i');
  });

  it('MCP grants: command/args, env names only, enabled_tools for patterns', () => {
    const { args } = build({
      access: { mcpServers: [{ id: 'git-hub', command: 'npx', args: ['gh', '--x'], env: { GH_TOKEN: 'ghp_secret' }, allowedTools: ['search_*'] }, { id: 'all', command: 'c', env: {}, allowedTools: ['*'] }, { id: 'off', command: 'o', env: {}, allowedTools: [] }] },
    });
    const c = cfgs(args);
    expect(c).toContain('mcp_servers.git-hub.command="npx"');
    expect(c).toContain('mcp_servers.git-hub.args=["gh","--x"]');
    expect(c).toContain('mcp_servers.git-hub.env_vars=["GH_TOKEN"]');
    expect(c).toContain('mcp_servers.git-hub.enabled_tools=["search_*"]');
    expect(c).toContain('mcp_servers.git-hub.default_tools_approval_mode="approve"');
    expect(c.some((x) => x.startsWith('mcp_servers.all.enabled_tools'))).toBe(false);
    expect(c.some((x) => x.startsWith('mcp_servers.off'))).toBe(false);
    expect(JSON.stringify(args)).not.toContain('ghp_secret');
  });

  it('images use -i', () => {
    const { args } = build({ images: ['/a.png', '/b.png'] });
    expect(args.filter((_, i) => args[i - 1] === '-i')).toEqual(['/a.png', '/b.png']);
  });

  it('resume: `exec resume <id>`, sandbox via -c (no -C/-s), prompt without system text', () => {
    const { args, stdin } = build({ sessionId: 'thr-1', access: { writeDirs: [{ folderId: 'a', root: '/data/a', globs: ['**'] }] } });
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thr-1']);
    expect(args).not.toContain('-C');
    expect(args).not.toContain('-s');
    expect(args).not.toContain('--add-dir');
    expect(cfgs(args)).toContain('sandbox_mode="workspace-write"');
    expect(cfgs(args)).toContain('sandbox_workspace_write.writable_roots=["/data/a"]');
    expect(stdin).toBe('xin chào');
    expect(build({ sessionId: 'thr-1' }, { fresh: true }).args[1]).toBe('--json');
  });
});

describe('codex parser', () => {
  it('reads the recorded run; input tokens already include cache', async () => {
    const events: unknown[] = [];
    const p = createCodexParser((e) => events.push(e));
    for (const l of (await readFile(fixture('events/codex-hello.jsonl'), 'utf8')).split('\n').filter(Boolean)) p.feed(l);
    const st = p.finish();
    expect(st.threadId).toBeTruthy();
    expect(st.messages).toEqual(['hello']);
    expect(st.completed).toBe(true);
    expect(st.usage).toEqual({ inputTokens: 20685, cachedInputTokens: 12288, outputTokens: 5 });
    expect(events).toContainEqual({ type: 'text', text: 'hello' });
  });

  it('command executions and failures', () => {
    const events: unknown[] = [];
    const p = createCodexParser((e) => events.push(e));
    p.feed(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'ls', exit_code: 2 } }));
    p.feed(JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }));
    expect(events[0]).toMatchObject({ type: 'tool', name: 'shell', status: 'error' });
    expect(p.finish()).toMatchObject({ turnFailed: true, error: 'boom' });
  });
});

describe('codex runtime with a fake CLI', () => {
  const rt = (scenario: string, extra: Record<string, string> = {}) => createCodexRuntime(fixture('fake-codex.mjs'), { FAKE_SCENARIO: scenario, ...extra });

  it('runs and reports tokens without cost', async () => {
    const cwd = await tmpCwd();
    const res = await rt('ok').run(makeReq(cwd));
    expect(res).toMatchObject({ ok: true, output: 'hello' });
    expect(res.usage?.costUsd).toBeUndefined();
    expect(res.sessionId).toBeTruthy();
  });

  it('passes MCP env values through the child env, not argv', async () => {
    const cwd = await tmpCwd();
    const rec = path.join(cwd, 'rec.jsonl');
    await rt('ok', { FAKE_RECORD: rec }).run(makeReq(cwd, { access: { mcpServers: [{ id: 'g', command: 'x', env: { MCP_TOKEN: 'abc12345' }, allowedTools: ['*'] }] } }));
    const r = JSON.parse((await readFile(rec, 'utf8')).trim());
    expect(r.env.MCP_TOKEN).toBe('abc12345');
    expect(r.argv.join(' ')).not.toContain('abc12345');
  });

  it('turn.failed maps to quota; resume failure retries fresh', async () => {
    const cwd = await tmpCwd();
    expect((await rt('turnfailed').run(makeReq(cwd))).error?.family).toBe('quota');
    const res = await rt('resumefail').run(makeReq(cwd, { sessionId: 'old' }));
    expect(res).toMatchObject({ ok: true, clearSession: true });
  });

  it('timeout and missing binary', async () => {
    const cwd = await tmpCwd();
    expect((await rt('hang').run(makeReq(cwd, { timeoutMs: 300 }))).error?.family).toBe('timeout');
    expect((await createCodexRuntime('/nonexistent/codex').run(makeReq(cwd))).error?.family).toBe('config');
  });
});
