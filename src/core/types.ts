// Domain types shared by every layer. Contracts in src/*/contracts.ts build on these.

export type RuntimeId = 'claude' | 'codex' | 'grok' | 'hermes' | 'mock';
export const RUNTIME_IDS: readonly RuntimeId[] = ['claude', 'codex', 'grok', 'hermes', 'mock'];

export type Permission = 'safe' | 'full';
export type ContextProfile = 'standard' | 'lean';

// ---------------------------------------------------------------- agents

/** Globs are relative to the brain folder root. `["**"]` = whole folder. */
export interface FolderGrant {
  read: string[];
  write: string[];
}

export interface AgentAccessConfig {
  /** brain folder id → globs */
  brain: Record<string, FolderGrant>;
  memory: { team: boolean; private: boolean };
  /** skill ids, or 'all' */
  skills: string[] | 'all';
  /** connection id → MCP tool patterns (`["search_*"]`), or `true` for env/composio/all tools */
  connections: Record<string, string[] | true>;
  /** module id → scopes declared by that module (`["inbox.read","reply.draft"]`) */
  modules: Record<string, string[]>;
}

export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  runtime: RuntimeId;
  model?: string;
  runtimeOptions: Record<string, string | number | boolean>;
  permission: Permission;
  context: ContextProfile;
  reportsTo?: string;
  canDelegate: boolean;
  maxConcurrent: number;
  budgetUsdMonth?: number;
  enabled: boolean;
  access: AgentAccessConfig;
  /** persona.md text */
  persona: string;
  /** absolute path of agents/<id> */
  dir: string;
  /** absolute cwd for runs */
  workspace: string;
}

// ---------------------------------------------------------------- work

export type TaskStatus = 'queued' | 'running' | 'waiting' | 'review' | 'done' | 'failed' | 'cancelled';
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['done', 'failed', 'cancelled'];
export type TaskKind = 'task' | 'chat' | 'team';
/** Why the agent is being called; written at the top of the prompt. */
export type TaskTrigger =
  | 'assigned'
  | 'chat'
  | 'schedule'
  | 'children_done'
  | 'commented'
  | 'retry'
  | 'module';

export interface Task {
  id: number;
  title: string;
  prompt: string;
  agentId: string;
  status: TaskStatus;
  kind: TaskKind;
  priority: number;
  parentId: number | null;
  conversationId: number | null;
  /** 'user' | 'api' | 'chat' | 'schedule:<id>' | 'agent:<id>' | 'module:<id>' */
  source: string;
  trigger: TaskTrigger;
  contextProfile: ContextProfile;
  depth: number;
  runAfter: string | null;
  result: string | null;
  error: string | null;
  recoverCount: number;
  /** free-form; team tasks keep {mode, agentIds, mergeBy, round}; modules keep their own keys */
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled';
export type ErrorFamily =
  | 'auth'
  | 'quota'
  | 'transient'
  | 'config'
  | 'refusal'
  | 'timeout'
  | 'budget'
  | 'access'
  | 'cancelled'
  | 'unknown';

/** Missing numbers mean "unknown", never zero. */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

export interface Run {
  id: number;
  taskId: number;
  agentId: string;
  runtime: RuntimeId;
  model: string | null;
  status: RunStatus;
  trigger: TaskTrigger;
  sessionId: string | null;
  output: string | null;
  errorFamily: ErrorFamily | null;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** JSON snapshot of EffectiveAccess used for this run */
  accessJson: string | null;
  /** JSON array of skill ids allowed in this run */
  skillsJson: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export type RunEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; name: string; input?: string; status?: 'start' | 'end' | 'error' }
  | { type: 'status'; message: string }
  | { type: 'usage'; usage: Usage };

export interface StoredRunEvent {
  id: number;
  runId: number;
  ts: string;
  event: RunEvent;
}

export interface TaskComment {
  id: number;
  taskId: number;
  /** 'user' | 'agent:<id>' | 'system' */
  author: string;
  body: string;
  runId: number | null;
  createdAt: string;
}

export interface Schedule {
  id: number;
  name: string;
  agentId: string;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastTaskId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: number;
  agentId: string;
  title: string;
  sessionId: string | null;
  sessionRuntime: RuntimeId | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: number;
  conversationId: number;
  role: 'user' | 'agent' | 'system';
  content: string;
  taskId: number | null;
  createdAt: string;
}

// ---------------------------------------------------------------- shared

export interface Memory {
  id: number;
  /** null = team memory */
  agentId: string | null;
  content: string;
  /** 'user' | 'agent:<id>' */
  source: string;
  sourceTaskId: number | null;
  sourceRunId: number | null;
  pinned: boolean;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface BrainFolder {
  id: string;
  name: string;
  /** absolute, ~ expanded */
  path: string;
  description?: string;
}

export interface BrainHit {
  folderId: string;
  /** relative to the folder root, posix separators */
  path: string;
  title: string;
  snippet: string;
  score: number;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  /** absolute path of SKILL.md */
  path: string;
  dir: string;
  /** 'library' or 'module:<id>' */
  source: string;
}

export interface BoardEntry {
  id: number;
  agentId: string | null;
  taskId: number | null;
  kind: string;
  text: string;
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  ts: string;
  /** 'user' | 'agent:<id>' | 'module:<id>' | 'system' */
  actor: string;
  action: string;
  target: string | null;
  runId: number | null;
  detail: Record<string, unknown> | null;
}

export type AttentionKind = 'review' | 'failed' | 'budget' | 'module';
export interface AttentionItem {
  /** stable key, e.g. 'task:12' or 'module:care:draft:44' */
  key: string;
  kind: AttentionKind;
  title: string;
  detail?: string;
  taskId?: number;
  moduleId?: string;
  /** web path to open */
  link?: string;
  severity: 'info' | 'warn' | 'error';
  createdAt: string;
}

// ---------------------------------------------------------------- connections

export type Connection =
  | {
      id: string;
      type: 'mcp';
      description?: string;
      command?: string;
      args?: string[];
      url?: string;
      /** values may reference .env with `$NAME` */
      env?: Record<string, string>;
    }
  | { id: string; type: 'env'; description?: string; env: Record<string, string> }
  | { id: string; type: 'composio'; description?: string; apiKeyEnv: string; toolkits?: string[] };

// ---------------------------------------------------------------- modules

export interface ModuleState {
  id: string;
  enabled: boolean;
  version: string;
  installedAt: string | null;
  settings: Record<string, unknown>;
}
