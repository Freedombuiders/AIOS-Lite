// Agent layer contract: agents are folders agents/<id>/{agent.yaml, persona.md}.
import type { AgentConfig } from '../core/types.js';

/** Fields accepted when creating/updating (camelCase; persona is the persona.md text). */
export type AgentInput = Partial<Omit<AgentConfig, 'dir' | 'id'>> & { name?: string };

export interface AgentLoadError {
  id: string;
  file: string;
  message: string;
}

export interface AgentRegistry {
  /** re-read agents/ from disk */
  reload(): void;
  list(): AgentConfig[];
  get(id: string): AgentConfig | undefined;
  /** throws if missing */
  require(id: string): AgentConfig;
  /** id: lowercase kebab-case, unique. Writes agent.yaml + persona.md. */
  create(id: string, input: AgentInput & { name: string; runtime: AgentConfig['runtime'] }): AgentConfig;
  update(id: string, patch: AgentInput): AgentConfig;
  /** moves the folder to agents/_archive/<id>-<timestamp> */
  archive(id: string): void;
  /** copy a template folder (module agent template) into agents/<id>; returns the new agent */
  installTemplate(templateDir: string, id?: string): AgentConfig;
  /** yaml files that failed validation */
  errors(): AgentLoadError[];
}

export interface AgentRegistryOptions {
  agentsDir: string;
  workspacesDir: string;
}
