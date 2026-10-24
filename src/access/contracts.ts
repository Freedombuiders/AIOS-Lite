// Access layer contract: one place decides what an agent may see and do.
import type { Composio } from '@composio/core';
import type { AgentConfig, AuditEntry, Connection, Permission, Skill, Task } from '../core/types.js';

export interface DirGrant {
  folderId: string;
  /** absolute folder root */
  root: string;
  /** globs relative to root; ["**"] = everything */
  globs: string[];
}

export interface McpGrant {
  id: string;
  command?: string;
  args?: string[];
  url?: string;
  /** resolved env (secrets included) — never log this */
  env: Record<string, string>;
  /** tool name patterns; ['*'] = all tools of this server */
  allowedTools: string[];
}

export interface EffectiveAccess {
  agentId: string;
  readDirs: DirGrant[];
  writeDirs: DirGrant[];
  /**
   * Absolute directories to pass to CLIs as extra working dirs (`--add-dir`):
   * the narrowest directory covering each read grant (e.g. root/Ban-hang for ["Ban-hang/**"]).
   */
  addDirs: string[];
  memory: { team: boolean; private: boolean };
  mcpServers: McpGrant[];
  /** env vars from granted `type: env` connections (secrets) */
  envVars: Record<string, string>;
  skills: Skill[];
  /** moduleId → granted scopes (only modules that are enabled) */
  moduleScopes: Record<string, string[]>;
  permission: Permission;
  tools: 'default' | 'none';
}

/** JSON-safe snapshot for runs.access_json (no secrets: env values replaced by key names). */
export type AccessSnapshot = Omit<EffectiveAccess, 'mcpServers' | 'envVars' | 'skills'> & {
  mcpServers: { id: string; allowedTools: string[] }[];
  envVars: string[];
  skills: string[];
};

export interface AccessPolicy {
  /** compute access for one run; lean tasks get tools 'none' */
  resolve(agent: AgentConfig, task?: Pick<Task, 'contextProfile' | 'source'>): EffectiveAccess;
  snapshot(access: EffectiveAccess): AccessSnapshot;
  /** module scope check, e.g. can('sales-a', 'care', 'reply.send') */
  can(agentId: string, moduleId: string, scope: string): boolean;
  canReadPath(agentId: string, folderId: string, relPath: string): boolean;
  canWritePath(agentId: string, folderId: string, relPath: string): boolean;
}

export interface ConnectionsService {
  reload(): void;
  list(): Connection[];
  get(id: string): Connection | undefined;
  /** resolve `$NAME` references against process.env / .env */
  resolveEnv(connection: Connection): Record<string, string>;
  /** read a single secret from env by name */
  secret(name: string): string | undefined;
  /** shared Composio client (key from the first `type: composio` connection or COMPOSIO_API_KEY) */
  composio(): Promise<Composio>;
  /** has a usable connection of this id or type ('composio', 'github', …) */
  has(idOrType: string): boolean;
  test(id: string): Promise<{ ok: boolean; message: string }>;
}

export interface AuditService {
  log(entry: { actor: string; action: string; target?: string | null; runId?: number | null; detail?: Record<string, unknown> | null }): AuditEntry;
  list(filter?: { actor?: string; action?: string; since?: string; limit?: number; beforeId?: number }): AuditEntry[];
}
