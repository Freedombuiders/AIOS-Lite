import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../agents/registry.js';
import type { AgentConfig } from '../core/types.js';
import { createSkillLibrary } from '../shared/skills.js';
import { REPO_ROOT, sampleBrain, testLog, writeFile } from '../shared/test-kit.js';
import { createRuntimeRegistry } from '../runtimes/index.js';
import { createAccessPolicy } from './policy.js';

function setup(withToken = true, runtimeCapabilities?: Parameters<typeof createAccessPolicy>[0]['runtimeCapabilities']) {
  const { root, brain } = sampleBrain();
  const agentsDir = path.join(root, 'agents');
  writeFile(path.join(agentsDir, 'agent-a', 'agent.yaml'), 'name: A\nruntime: mock\n');
  const agents = createAgentRegistry({ agentsDir, workspacesDir: path.join(root, 'workspaces') });
  const skills = createSkillLibrary({ dirs: [path.join(REPO_ROOT, 'skills')], log: testLog });
  const policy = createAccessPolicy({
    agents, brain, skills, connections: { get: () => undefined, resolveEnv: () => ({}) }, isModuleEnabled: () => true,
    apiUrl: 'http://127.0.0.1:4000',
    ...(withToken ? { integrationToken: (a: string, t: string) => `tok-${a}-${t}` } : {}),
    ...(runtimeCapabilities ? { runtimeCapabilities } : {}),
  });
  const withGrants = (integrations: AgentConfig['access']['integrations'], runtime: AgentConfig['runtime'] = 'mock'): AgentConfig => {
    const a = agents.require('agent-a');
    return { ...a, runtime, access: { ...a.access, integrations } };
  };
  return { policy, withGrants };
}

describe('integrations MCP bridge grant', () => {
  it('adds aios-integrations with a run token when the agent has a grant', () => {
    const { policy, withGrants } = setup();
    const access = policy.resolve(withGrants({ pancake: 'read' }), { id: 7, contextProfile: 'standard' });
    const g = access.mcpServers.find((m) => m.id === 'aios-integrations');
    expect(g).toMatchObject({ command: process.execPath, allowedTools: ['*'], env: { AIOS_API_URL: 'http://127.0.0.1:4000', AIOS_RUN_TOKEN: 'tok-agent-a-7' } });
    expect(g?.args?.at(-1)).toMatch(/server\.(ts|js)$/);
    const snap = JSON.stringify(policy.snapshot(access));
    expect(snap).not.toContain('tok-agent-a-7');
    expect(snap).toContain('aios-integrations');
  });

  it('adds nothing for lean turns, off grants, no grants, missing task id or missing token factory', () => {
    const { policy, withGrants } = setup();
    expect(policy.resolve(withGrants({ pancake: 'read' }), { id: 7, contextProfile: 'lean' }).mcpServers).toEqual([]);
    expect(policy.resolve(withGrants({ pancake: 'off', botcake: { grant: 'off' } }), { id: 7 }).mcpServers).toEqual([]);
    expect(policy.resolve(withGrants(undefined), { id: 7 }).mcpServers).toEqual([]);
    expect(policy.resolve(withGrants({ pancake: 'read' })).mcpServers).toEqual([]);
    const noToken = setup(false);
    expect(noToken.policy.resolve(noToken.withGrants({ pancake: 'read' }), { id: 7 }).mcpServers).toEqual([]);
  });

  it('a runtime that cannot take MCP (genbot) gets no aios-integrations; claude still does', () => {
    const caps = (id: string) => createRuntimeRegistry().get(id as never).capabilities;
    const { policy, withGrants } = setup(true, caps);
    const genbot = policy.resolve(withGrants({ pancake: 'read' }, 'genbot'), { id: 7, contextProfile: 'standard' });
    expect(genbot.mcpServers.map((m) => m.id)).not.toContain('aios-integrations');
    expect(genbot.mcpServers).toEqual([]);
    const claude = policy.resolve(withGrants({ pancake: 'read' }, 'claude'), { id: 7, contextProfile: 'standard' });
    expect(claude.mcpServers.map((m) => m.id)).toContain('aios-integrations');
  });

  it('noTools alone does not remove MCP: only the explicit mcp capability does', () => {
    const { policy, withGrants } = setup(true, () => ({ mcp: true }));
    expect(policy.resolve(withGrants({ pancake: 'read' }, 'genbot'), { id: 7 }).mcpServers.map((m) => m.id)).toContain('aios-integrations');
  });

  it('a runtime without MCP also gets no MCP connection grants', () => {
    const { root, brain } = sampleBrain();
    const agentsDir = path.join(root, 'agents');
    writeFile(path.join(agentsDir, 'gb', 'agent.yaml'), 'name: G\nruntime: genbot\naccess:\n  connections: { github: true }\n');
    writeFile(path.join(agentsDir, 'cl', 'agent.yaml'), 'name: C\nruntime: claude\naccess:\n  connections: { github: true }\n');
    const agents = createAgentRegistry({ agentsDir, workspacesDir: path.join(root, 'workspaces') });
    const skills = createSkillLibrary({ dirs: [path.join(REPO_ROOT, 'skills')], log: testLog });
    const connections = { get: () => ({ id: 'github', type: 'mcp' as const, command: 'node', args: ['srv.js'], env: {} }), resolveEnv: () => ({}) };
    const policy = createAccessPolicy({ agents, brain, skills, connections, isModuleEnabled: () => true, runtimeCapabilities: (id) => createRuntimeRegistry().get(id).capabilities });
    expect(policy.resolve(agents.require('gb')).mcpServers).toEqual([]);
    expect(policy.resolve(agents.require('cl')).mcpServers.map((m) => m.id)).toEqual(['github']);
  });
});
