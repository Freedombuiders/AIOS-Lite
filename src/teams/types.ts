// Team package format: TEAM.md + schedules.yaml + agents/<id>/{agent.yaml.template, persona.md, skills/, knowledge/}.
import type { RuntimeId } from '../core/types.js';

export const TEAM_SCHEMAS = ['aios-team/v1', 'claudeclaw-team/v1'] as const;
export const TEAM_SCHEMA = 'aios-team/v1';
export const TEAM_ENTRYPOINT = 'TEAM.md';
export const TEAM_SCHEDULES_FILE = 'schedules.yaml';
export const AGENT_YAML_TEMPLATE = 'agent.yaml.template';

export type CollisionStrategy = 'rename' | 'skip';
export type TeamFiles = Map<string, Buffer>;

export interface TeamInputDecl {
  key: string;
  label: string;
  description: string;
  /** secret inputs are substituted but never stored or echoed back */
  kind: 'plain' | 'secret';
  required: boolean;
  defaultValue: string;
}

export interface TeamAgentDecl {
  id: string;
  name: string;
  description: string;
  runtime: RuntimeId | null;
  model: string | null;
  skills: string[];
  fileCount: number;
}

export interface TeamScheduleDecl {
  id: string;
  agent: string;
  cron: string;
  tz: string | null;
  prompt: string;
}

export interface TeamManifest {
  slug: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
  manager: string;
  agents: TeamAgentDecl[];
  schedules: TeamScheduleDecl[];
  /** skill ids that the package expects to exist (bundled or already in the library) */
  requiredSkills: string[];
  prerequisites: string[];
  inputs: TeamInputDecl[];
  body: string;
  fileCount: number;
}

export interface LoadedTeam {
  manifest: TeamManifest;
  files: TeamFiles;
  warnings: string[];
  source: { kind: 'catalog' | 'import'; id: string };
}

export class TeamError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 | 413 | 422 = 400,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'TeamError';
  }
}
