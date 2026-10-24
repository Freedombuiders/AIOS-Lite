// Response shapes from docs/dev/API.md that are not in src/core/types.ts.
// Mirrored by hand so the web bundle never imports server-only types.
import type {
  AgentAccessConfig,
  AgentConfig,
  BrainFolder,
  Connection,
  ModuleState,
  Permission,
  RuntimeId,
  Skill,
  TaskStatus,
  Run,
} from '@core/types';

export type Enforcement = 'hard' | 'soft' | 'none';

export interface AccessEnforcement {
  context: 'hard';
  mcp: Enforcement;
  fileRead: Enforcement;
  fileWrite: Enforcement;
  shell: Enforcement;
  note?: string;
}

export interface DirGrant {
  folderId: string;
  root: string;
  globs: string[];
}

export interface AccessSnapshot {
  agentId: string;
  readDirs: DirGrant[];
  writeDirs: DirGrant[];
  addDirs: string[];
  memory: { team: boolean; private: boolean };
  mcpServers: { id: string; allowedTools: string[] }[];
  envVars: string[];
  skills: string[];
  moduleScopes: Record<string, string[]>;
  permission: Permission;
  tools: 'default' | 'none';
}

export interface AgentStats {
  running: number;
  queued: number;
  lastRunAt: string | null;
  costMonthUsd: number;
  runsMonth: number;
}

export type AgentSummary = Omit<AgentConfig, 'persona'> & { stats: AgentStats };
export type AgentDetail = AgentConfig & { stats: AgentStats };
export interface AgentLoadError {
  id: string;
  file: string;
  message: string;
}
export type AgentInput = Partial<Omit<AgentConfig, 'dir' | 'id'>> & { name?: string };

export interface AgentAccessResponse {
  access: AccessSnapshot;
  enforcement: AccessEnforcement;
  runtime: RuntimeId;
}

export interface DoctorCheck {
  code: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  hint?: string;
}
export interface RuntimeCapabilities {
  resume: boolean;
  systemPrompt: 'native' | 'inline';
  reportsCost: boolean;
  images: boolean;
  noTools: boolean;
  enforces: AccessEnforcement;
}
export interface RuntimeReport {
  runtime: RuntimeId;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  version?: string;
  command?: string;
  checks: DoctorCheck[];
  testedAt: string;
  capabilities: RuntimeCapabilities;
}

export interface StatsOverview {
  agents: { total: number; enabled: number; running: number };
  tasks: Record<TaskStatus, number>;
  runsToday: number;
  costMonthUsd: number;
  costByAgent: { agentId: string; costUsd: number; runs: number }[];
  recentRuns: Run[];
}

export interface SettingsDto {
  timezone: string;
  maxParallel: number;
  emergencyStop: boolean;
  version: string;
}

export type ConnectionView = Connection & { ready: boolean; grantedTo: string[] };
export type BrainFolderView = BrainFolder & {
  docs: number;
  exists: boolean;
  isVault?: boolean;
  /** number of .md files on disk */
  mdCount?: number;
  /** agent ids that can read / write this folder */
  readers?: string[];
  writers?: string[];
};
export interface DirEntryView {
  name: string;
  path: string;
  isVault: boolean;
  hasSkills: boolean;
}
export interface DirListing {
  path: string;
  parent: string | null;
  dirs: DirEntryView[];
}
export interface SkillRootView {
  path: string;
  label: string;
  kind: 'env' | 'user' | 'module';
  readOnly: boolean;
  exists: boolean;
  skills: number;
  clashes: string[];
}
export interface SkillRootSuggestion {
  path: string;
  label: string;
  skills: number;
}
export interface BrainTreeNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  children?: BrainTreeNode[];
}
export type SkillView = Skill & { usedBy: string[] };

export interface ModuleSettingSpec {
  label: string;
  type: 'boolean' | 'number' | 'string' | 'select' | 'secret';
  default?: unknown;
  options?: { value: string; label: string }[];
  help?: string;
}
export interface ModuleManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  icon?: string;
  category: 'studio' | 'sales' | 'marketing' | 'finance' | 'ops' | 'other';
  requires?: { modules?: string[]; connections?: string[] };
  enhances?: string[];
  scopes?: Record<string, string>;
  tables: string[];
  agentTemplates?: string[];
  skills?: string[];
  settings?: Record<string, ModuleSettingSpec>;
  license?: string;
}
export interface ModuleRequirement {
  kind: 'module' | 'connection';
  id: string;
  ok: boolean;
  message: string;
}
export interface ModuleInfo {
  manifest: ModuleManifest;
  state: ModuleState;
  requirements: ModuleRequirement[];
  ready: boolean;
  hasServer: boolean;
  hasWeb: boolean;
  agentTemplates: string[];
  error?: string;
}

export type { AgentAccessConfig };
