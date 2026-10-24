import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAgentRegistry } from '../agents/registry.js';
import { createBrainService } from '../shared/brain.js';
import { createSkillLibrary } from '../shared/skills.js';
import { memDb, REPO_ROOT, sampleBrain, testBus, testLog, tmpDir, writeFile } from '../shared/test-kit.js';
import { createAuditService } from './audit.js';
import { createConnectionsService } from './connections.js';
import { createAccessPolicy } from './policy.js';

function connsFrom(yaml: string, env: NodeJS.ProcessEnv, extra: Partial<Parameters<typeof createConnectionsService>[0]> = {}) {
  const dir = tmpDir();
  writeFile(path.join(dir, 'connections.yaml'), yaml);
  return createConnectionsService({ file: path.join(dir, 'connections.yaml'), envFile: path.join(dir, '.env'), log: testLog, env, ...extra });
}

const YAML = `
connections:
  - { id: composio, type: composio, apiKeyEnv: COMPOSIO_API_KEY }
  - { id: github, type: mcp, command: node, args: [srv.js], env: { TOKEN: $GH_TOKEN } }
  - { id: remote, type: mcp, url: "https://mcp.example.test/x" }
  - { id: openai, type: env, env: { OPENAI_API_KEY: $OPENAI_KEY } }
  - { id: broken, type: nope }
  - { id: github, type: env, env: {} }
`;

describe('connections', () => {
  it('parses valid entries, skips invalid and duplicate ones, resolves env refs', () => {
    const c = connsFrom(YAML, { GH_TOKEN: 'tok' });
    expect(c.list().map((x) => x.id)).toEqual(['composio', 'github', 'remote', 'openai']);
    expect(c.resolveEnv(c.get('github')!)).toEqual({ TOKEN: 'tok' });
    expect(c.resolveEnv(c.get('openai')!)).toEqual({ OPENAI_API_KEY: '' });
    expect(c.secret('GH_TOKEN')).toBe('tok');
    expect(c.secret('NOPE')).toBeUndefined();
  });

  it('loads the .env file without overriding real env', () => {
    const dir = tmpDir();
    writeFile(path.join(dir, '.env'), 'GH_TOKEN=fromfile\nOPENAI_KEY=k\n');
    writeFile(path.join(dir, 'c.yaml'), YAML);
    const env: NodeJS.ProcessEnv = { GH_TOKEN: 'real' };
    const c = createConnectionsService({ file: path.join(dir, 'c.yaml'), envFile: path.join(dir, '.env'), log: testLog, env });
    expect(c.resolveEnv(c.get('github')!).TOKEN).toBe('real');
    expect(c.has('openai')).toBe(true);
  });

  it('has() checks id, type and required env', () => {
    const c = connsFrom(YAML, {});
    expect(c.has('github')).toBe(false);
    expect(c.has('openai')).toBe(false);
    expect(c.has('remote')).toBe(true);
    expect(c.has('mcp')).toBe(true); // remote needs no env
    expect(c.has('composio')).toBe(false);
    expect(connsFrom(YAML, { COMPOSIO_API_KEY: 'ak_x' }).has('composio')).toBe(true);
    expect(connsFrom('connections: []', { COMPOSIO_API_KEY: 'ak_x' }).has('composio')).toBe(true);
    expect(connsFrom('connections: []', {}).has('composio')).toBe(false);
  });

  it('composio() is lazy, cached per key, and needs a key', async () => {
    const make = vi.fn(async (k: string) => ({ key: k }) as never);
    const env: NodeJS.ProcessEnv = {};
    const c = connsFrom(YAML, env, { createComposio: make });
    await expect(c.composio()).rejects.toThrow('COMPOSIO_API_KEY');
    expect(make).not.toHaveBeenCalled();
    env.COMPOSIO_API_KEY = 'k1';
    const a = await c.composio();
    expect(await c.composio()).toBe(a);
    expect(make).toHaveBeenCalledTimes(1);
    env.COMPOSIO_API_KEY = 'k2';
    expect(await c.composio()).not.toBe(a);
    expect(make).toHaveBeenCalledTimes(2);
  });

  it('test(): command on PATH, injected fetch, env presence, composio key', async () => {
    const fetchOk = vi.fn(async () => ({ status: 405 }) as Response);
    const c = connsFrom(YAML, { GH_TOKEN: 't', PATH: path.dirname(process.execPath), COMPOSIO_API_KEY: 'k' }, { fetch: fetchOk as never });
    expect((await c.test('github')).ok).toBe(true);
    expect((await c.test('remote')).ok).toBe(true);
    expect(fetchOk).toHaveBeenCalledOnce();
    expect((await c.test('composio')).ok).toBe(true);
    expect(await c.test('openai')).toMatchObject({ ok: false, message: expect.stringContaining('OPENAI_KEY') });
    expect((await c.test('ghost')).ok).toBe(false);

    const noPath = connsFrom(YAML, { GH_TOKEN: 't', PATH: '/nonexistent' });
    expect(await noPath.test('github')).toMatchObject({ ok: false, message: expect.stringContaining('node') });
    const failing = connsFrom(YAML, {}, { fetch: (async () => { throw new Error('down'); }) as never });
    expect((await failing.test('remote')).ok).toBe(false);
  });
});

describe('access policy', () => {
  function setup(agentYaml: Record<string, string>, env: NodeJS.ProcessEnv = { GH_TOKEN: 'secret-token-123', OPENAI_KEY: 'sk-test-openai-key-000000' }, enabledModules = ['care']) {
    const { root, brain } = sampleBrain();
    const agentsDir = path.join(root, 'agents');
    for (const [id, y] of Object.entries(agentYaml)) writeFile(path.join(agentsDir, id, 'agent.yaml'), y);
    const agents = createAgentRegistry({ agentsDir, workspacesDir: path.join(root, 'workspaces') });
    const connections = connsFrom(YAML, env);
    const skills = createSkillLibrary({ dirs: [path.join(REPO_ROOT, 'skills')], log: testLog });
    const policy = createAccessPolicy({ agents, brain, connections, skills, isModuleEnabled: (m) => enabledModules.includes(m) });
    return { root, brain, agents, policy };
  }

  const base = 'name: T\nruntime: mock\n';

  it('default deny: an agent with no access gets nothing', () => {
    const { agents, policy } = setup({ nobody: base });
    const a = policy.resolve(agents.require('nobody'));
    expect(a).toMatchObject({ readDirs: [], writeDirs: [], addDirs: [], mcpServers: [], envVars: {}, skills: [], moduleScopes: {}, memory: { team: false, private: true }, permission: 'safe', tools: 'default' });
  });

  it('done-when: agent without cong-ty-b has no readDir for it and searchForAccess never returns its notes', async () => {
    const { root, brain, agents, policy } = setup({
      sales: `${base}access:\n  brain:\n    cong-ty-a: { read: ["**"] }\n`,
    });
    await brain.reindex();
    const a = policy.resolve(agents.require('sales'));
    expect(a.readDirs.map((d) => d.folderId)).toEqual(['cong-ty-a']);
    expect(a.addDirs).toEqual([path.join(root, 'brain', 'cong-ty-a')]);
    expect(brain.search('khach hang').some((h) => h.folderId === 'cong-ty-b')).toBe(true); // exists in the index
    for (const q of ['khach hang', 'tra sen', 'doanh thu', 'dai ly', 'chiet khau']) {
      expect(brain.searchForAccess(q, a, 20).filter((h) => h.folderId !== 'cong-ty-a'), q).toEqual([]);
    }
    expect(policy.canReadPath('sales', 'cong-ty-b', 'danh-muc-tra-sen.md')).toBe(false);
    expect(policy.canReadPath('sales', 'cong-ty-a', 'bang-gia-noi-that-2026.md')).toBe(true);
    expect(policy.canWritePath('sales', 'cong-ty-a', 'bang-gia-noi-that-2026.md')).toBe(false);
  });

  it('computes narrowest addDirs per grant and handles write grants', () => {
    const { root, agents, policy } = setup({
      multi: `${base}access:\n  brain:\n    cong-ty-a: { read: ["Ban-hang/**", "Quy-trinh/*.md"], write: ["Nhap/**"] }\n    ca-nhan: { read: ["**"] }\n    ghost-folder: { read: ["**"] }\n    cong-ty-b: { read: [] }\n`,
    });
    const a = policy.resolve(agents.require('multi'));
    const A = path.join(root, 'brain', 'cong-ty-a');
    expect(a.readDirs.map((d) => d.folderId)).toEqual(['cong-ty-a', 'ca-nhan']);
    expect(a.writeDirs).toEqual([{ folderId: 'cong-ty-a', root: A, globs: ['Nhap/**'] }]);
    expect(a.addDirs).toEqual([path.join(A, 'Ban-hang'), path.join(A, 'Quy-trinh'), path.join(root, 'brain', 'ca-nhan'), path.join(A, 'Nhap')]);
    expect(policy.canReadPath('multi', 'cong-ty-a', 'Ban-hang/x.md')).toBe(true);
    expect(policy.canReadPath('multi', 'cong-ty-a', 'Ke-toan/x.md')).toBe(false);
    expect(policy.canReadPath('multi', 'cong-ty-a', 'Ban-hang/../Ke-toan/x.md')).toBe(false);
    expect(policy.canWritePath('multi', 'cong-ty-a', 'Nhap/y.md')).toBe(true);
    expect(policy.canReadPath('multi', 'ghost-folder', 'a.md')).toBe(false);
    expect(policy.canReadPath('ghost-agent', 'ca-nhan', 'a.md')).toBe(false);
  });

  it('lean tasks get tools none; skills resolve; memory and permission pass through', () => {
    const { agents, policy } = setup({
      lean: `${base}permission: full\naccess:\n  memory: { team: true, private: false }\n  skills: [review-code, ghost]\n`,
      allskills: `${base}access:\n  skills: all\n`,
    });
    const a = agents.require('lean');
    expect(policy.resolve(a, { contextProfile: 'lean', source: 'module:care' })).toMatchObject({ tools: 'none', permission: 'full', memory: { team: true, private: false } });
    expect(policy.resolve(a, { contextProfile: 'standard', source: 'user' }).tools).toBe('default');
    expect(policy.resolve(a).skills.map((s) => s.id)).toEqual(['review-code']);
    expect(policy.resolve(agents.require('allskills')).skills).toHaveLength(3);
  });

  it('grants mcp servers and env vars only when connections are usable; ignores composio', () => {
    const y = `${base}access:\n  connections:\n    github: ["search_*"]\n    remote: true\n    openai: true\n    composio: true\n    ghost: true\n`;
    const full = setup({ 'agent-a': y });
    const a = full.policy.resolve(full.agents.require('agent-a'));
    expect(a.mcpServers).toEqual([
      { id: 'github', command: 'node', args: ['srv.js'], env: { TOKEN: 'secret-token-123' }, allowedTools: ['search_*'] },
      { id: 'remote', url: 'https://mcp.example.test/x', env: {}, allowedTools: ['*'] },
    ]);
    expect(a.envVars).toEqual({ OPENAI_API_KEY: 'sk-test-openai-key-000000' });

    const bare = setup({ 'agent-a': y }, {});
    const b = bare.policy.resolve(bare.agents.require('agent-a'));
    expect(b.mcpServers.map((m) => m.id)).toEqual(['remote']); // github has an unresolved secret
    expect(b.envVars).toEqual({});
  });

  it('snapshot removes secrets', () => {
    const { agents, policy } = setup({ 'agent-a': `${base}access:\n  connections:\n    github: ["x"]\n    openai: true\n  skills: [review-code]\n` });
    const snap = policy.snapshot(policy.resolve(agents.require('agent-a')));
    expect(snap).toMatchObject({ mcpServers: [{ id: 'github', allowedTools: ['x'] }], envVars: ['OPENAI_API_KEY'], skills: ['review-code'] });
    const text = JSON.stringify(snap);
    expect(text).not.toContain('secret-token-123');
    expect(text).not.toContain('sk-test-openai');
  });

  it('module scopes need an enabled module; can() checks scopes', () => {
    const { agents, policy } = setup({ 'agent-a': `${base}access:\n  modules:\n    care: [inbox.read, "reply.*"]\n    zalo: [messages.read]\n    empty: []\n` }, undefined, ['care', 'empty']);
    expect(policy.resolve(agents.require('agent-a')).moduleScopes).toEqual({ care: ['inbox.read', 'reply.*'] });
    expect(policy.can('agent-a', 'care', 'inbox.read')).toBe(true);
    expect(policy.can('agent-a', 'care', 'reply.draft')).toBe(true);
    expect(policy.can('agent-a', 'care', 'reply')).toBe(false);
    expect(policy.can('agent-a', 'care', 'inbox.write')).toBe(false);
    expect(policy.can('agent-a', 'zalo', 'messages.read')).toBe(false); // module disabled
    expect(policy.can('agent-a', 'empty', 'x')).toBe(false);
    expect(policy.can('ghost', 'care', 'inbox.read')).toBe(false);
  });
});

describe('audit', () => {
  it('logs with redaction, emits, filters and pages', () => {
    const bus = testBus();
    const seen: string[] = [];
    bus.on('audit', (e) => seen.push(e.entry.action));
    const audit = createAuditService({ db: memDb(), bus });
    const e = audit.log({ actor: 'agent:a', action: 'run.start', target: 'task:1', runId: 3, detail: { token: 'abcdefgh12345', note: 'dùng key sk-ant-abcdefghijklmnop1234', n: 2 } });
    expect(e.detail).toEqual({ token: '[redacted]', note: 'dùng key [redacted]', n: 2 });
    expect(e).toMatchObject({ actor: 'agent:a', runId: 3, target: 'task:1' });
    audit.log({ actor: 'user', action: 'agent.update' });
    audit.log({ actor: 'user', action: 'agent.update', detail: null });
    expect(seen).toEqual(['run.start', 'agent.update', 'agent.update']);
    expect(audit.list().map((x) => x.id)).toEqual([3, 2, 1]);
    expect(audit.list({ actor: 'user' })).toHaveLength(2);
    expect(audit.list({ action: 'run.start' })[0]!.id).toBe(1);
    expect(audit.list({ limit: 1, beforeId: 3 }).map((x) => x.id)).toEqual([2]);
    expect(audit.list({ since: '2999-01-01T00:00:00Z' })).toEqual([]);
  });
});
