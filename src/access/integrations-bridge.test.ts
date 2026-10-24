import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../agents/registry.js';
import type { AgentConfig } from '../core/types.js';
import { createSkillLibrary } from '../shared/skills.js';
import { REPO_ROOT, sampleBrain, testLog, writeFile } from '../shared/test-kit.js';
import { createAccessPolicy } from './policy.js';

function setup(withToken = true) {
  const { root, brain } = sampleBrain();
  const agentsDir = path.join(root, 'agents');
  writeFile(path.join(agentsDir, 'agent-a', 'agent.yaml'), 'name: A\nruntime: mock\n');
  const agents = createAgentRegistry({ agentsDir, workspacesDir: path.join(root, 'workspaces') });
  const skills = createSkillLibrary({ dirs: [path.join(REPO_ROOT, 'skills')], log: testLog });
  const policy = createAccessPolicy({
    agents, brain, skills, connections: { get: () => undefined, resolveEnv: () => ({}) }, isModuleEnabled: () => true,
    apiUrl: 'http://127.0.0.1:4000',
    ...(withToken ? { integrationToken: (a: string, t: string) => `tok-${a}-${t}` } : {}),
  });
  const withGrants = (integrations: AgentConfig['access']['integrations']): AgentConfig => {
    const a = agents.require('agent-a');
    return { ...a, access: { ...a.access, integrations } };
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
});
