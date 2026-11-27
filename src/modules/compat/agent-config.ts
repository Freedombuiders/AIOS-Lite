import fs from 'node:fs';
import path from 'node:path';
import type { AgentConfig } from '../../core/types.js';
import { DEFAULT_AGENT_ID, botHasKey, pickDefaultAgent } from '../../agents/default-agent.js';
import { genbotKeysFor } from '../../integrations/genbot-keys.js';
import { getDeps, tryDeps } from './state.js';

/**
 * The agent for a module turn that names none (what ported code called 'main'): the Trợ lý bot when it has a key, else
 * the first GenBot bot with a key, else the first bot; DEFAULT_AGENT_ID when unbound or when there is no agent at all,
 * so the turn fails with "không tìm thấy agent" instead of running on someone else.
 */
export function defaultAgentId(): string {
  const deps = tryDeps();
  if (!deps) return DEFAULT_AGENT_ID;
  const keys = genbotKeysFor(deps);
  return pickDefaultAgent(deps.agents.list(), (id) => botHasKey(deps.agents.get(id), keys)) ?? DEFAULT_AGENT_ID;
}

export function listAgentIds(): string[] {
  return getDeps().agents.list().map((a) => a.id);
}

/** Returns the AIOS-Lite AgentConfig (superset of what module code reads: id, name, model, runtime, persona, dir, workspace). */
export function loadAgentConfig(agentId: string): AgentConfig {
  return getDeps().agents.require(agentId);
}

/** Path of the agent's persona file (AIOS-Lite's equivalent of CLAUDE.md), or null when the agent has none. */
export function resolveAgentClaudeMd(agentId: string): string | null {
  const agent = getDeps().agents.get(agentId);
  if (!agent) return null;
  const file = path.join(agent.dir, 'persona.md');
  return fs.existsSync(file) ? file : null;
}

export function resolveAgentDir(agentId: string): string {
  const agent = getDeps().agents.get(agentId);
  return agent?.dir ?? path.join(getDeps().config.agentsDir, agentId);
}
