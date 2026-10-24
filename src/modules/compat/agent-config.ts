import fs from 'node:fs';
import path from 'node:path';
import type { AgentConfig } from '../../core/types.js';
import { getDeps } from './state.js';

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
