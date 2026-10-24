import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentConfig, Task } from '../core/types.js';
import type { EffectiveAccess } from '../access/contracts.js';
import { createAgentRegistry } from '../agents/registry.js';
import { createBoardService } from './board.js';
import { createContextBuilder } from './context.js';
import { createMemoryService } from './memory.js';
import { createSkillLibrary } from './skills.js';
import { REPO_ROOT, sampleBrain, testBus, testLog, writeFile } from './test-kit.js';

describe('context: integration guide block', () => {
  const { root, db, brain } = sampleBrain();
  writeFile(path.join(root, 'agents', 'agent-a', 'agent.yaml'), 'name: A\nruntime: claude\n');
  const agents = createAgentRegistry({ agentsDir: path.join(root, 'agents'), workspacesDir: path.join(root, 'ws') });
  const bus = testBus();
  const ctx = createContextBuilder({
    agents, brain, memory: createMemoryService({ db, bus }), board: createBoardService({ db, bus }),
    skills: createSkillLibrary({ dirs: [path.join(REPO_ROOT, 'skills')], log: testLog }),
    listIntegrations: () => [{ id: 'pancake', name: 'Pancake POS', agentGuide: 'Tra đơn hàng\nvà khách.' }],
  });
  const base = agents.require('agent-a');
  const agent: AgentConfig = { ...base, access: { ...base.access, integrations: { pancake: 'ask', botcake: 'off' } } };
  const access = (bridge: boolean): EffectiveAccess => ({
    agentId: 'a', readDirs: [], writeDirs: [], addDirs: [], memory: { team: false, private: false }, envVars: {}, skills: [], moduleScopes: {}, permission: 'safe', tools: 'default',
    mcpServers: bridge ? [{ id: 'aios-integrations', env: {}, allowedTools: ['*'] }] : [],
  });
  const task = { id: 1, title: 't', prompt: 'p', trigger: 'assigned', contextProfile: 'standard' } as Task;

  it('lists granted integrations with their guide', () => {
    const sys = ctx.build({ agent, task, access: access(true), profile: 'standard' }).systemPrompt;
    expect(sys).toContain('## Integration bạn được dùng');
    expect(sys).toContain('- Pancake POS (quyền: ask): Tra đơn hàng và khách.');
    expect(sys).toContain('<integration>__<lệnh>');
    expect(sys).not.toContain('botcake');
  });

  it('is absent without the bridge grant or in lean', () => {
    expect(ctx.build({ agent, task, access: access(false), profile: 'standard' }).systemPrompt).not.toContain('## Integration bạn được dùng');
    expect(ctx.build({ agent, task, access: access(true), profile: 'lean' }).systemPrompt).not.toContain('## Integration bạn được dùng');
  });
});
