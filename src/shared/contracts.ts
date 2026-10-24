// Shared layer contract: Second Brain, memory, skills, team board, context builder.
import type {
  AgentConfig,
  BoardEntry,
  BrainFolder,
  BrainHit,
  ContextProfile,
  Memory,
  Message,
  Skill,
  Task,
  TaskComment,
} from '../core/types.js';
import type { EffectiveAccess } from '../access/contracts.js';

// ---------------------------------------------------------------- Second Brain

export interface BrainTreeNode {
  name: string;
  /** relative path, posix */
  path: string;
  type: 'dir' | 'file';
  children?: BrainTreeNode[];
}

export interface BrainService {
  /** folders from config/brain.yaml */
  folders(): BrainFolder[];
  reloadConfig(): void;
  /** incremental unless full; only re-reads files whose mtime changed */
  reindex(opts?: { full?: boolean; folderId?: string }): Promise<{ indexed: number; removed: number; durationMs: number }>;
  /** full-text search (accent-insensitive). `folders` limits the search; omit = all folders. */
  search(query: string, opts?: { folders?: string[]; limit?: number }): BrainHit[];
  /** search restricted to what `access.readDirs` allows (folder + glob) */
  searchForAccess(query: string, access: EffectiveAccess, limit?: number): BrainHit[];
  /** read one markdown file; throws on path traversal or unknown folder */
  read(folderId: string, relPath: string): { title: string; content: string; mtimeMs: number };
  tree(folderId: string, opts?: { depth?: number }): BrainTreeNode[];
  /** write a note (used by modules/agents with write grants; caller checks access) */
  write(folderId: string, relPath: string, content: string): void;
}

// ---------------------------------------------------------------- memory

export interface MemoryAddInput {
  content: string;
  /** null = team memory */
  agentId: string | null;
  /** 'user' | 'agent:<id>' */
  source?: string;
  sourceTaskId?: number | null;
  sourceRunId?: number | null;
  pinned?: boolean;
}

export interface MemoryService {
  add(input: MemoryAddInput): Memory;
  get(id: number): Memory | undefined;
  list(filter?: { agentId?: string | null; scope?: 'team' | 'private' | 'all'; q?: string; limit?: number }): Memory[];
  update(id: number, patch: { content?: string; pinned?: boolean }): Memory;
  remove(id: number): void;
  /**
   * Memories for a run: pinned (team + own) first, then FTS matches for `query`.
   * Marks returned rows as used (use_count, last_used_at).
   */
  recall(agentId: string, query: string, opts: { team: boolean; private: boolean; limit: number }): Memory[];
}

// ---------------------------------------------------------------- skills

export interface SkillLibrary {
  reload(): void;
  list(): Skill[];
  get(id: string): Skill | undefined;
  /** SKILL.md text */
  read(id: string): string;
  /** add a skills root (module skills); source = 'module:<id>' */
  addRoot(dir: string, source: string): void;
  removeRoot(dir: string): void;
  /** resolve an agent's allowed list against the library */
  resolve(allowed: string[] | 'all'): Skill[];
  /** symlink the given skills into <workspace>/.claude/skills (and prune stale links AIOS created) */
  linkIntoWorkspace(workspace: string, skills: Skill[]): void;
}

// ---------------------------------------------------------------- team board

export interface BoardService {
  add(entry: { agentId: string | null; taskId?: number | null; kind?: string; text: string }): BoardEntry;
  recent(limit?: number): BoardEntry[];
}

// ---------------------------------------------------------------- context builder

export interface ChildResult {
  taskId: number;
  agentId: string;
  status: Task['status'];
  result: string | null;
  error: string | null;
}

export interface ContextInput {
  agent: AgentConfig;
  task: Task;
  access: EffectiveAccess;
  profile: ContextProfile;
  /** data a module provides for its lean tasks (already filtered by its scopes) */
  moduleContext?: string;
  /** results of finished child tasks (trigger children_done) */
  childResults?: ChildResult[];
  /** user comments since the last run (trigger commented) */
  comments?: TaskComment[];
  /** chat history to inline when the runtime cannot resume */
  history?: Message[];
  /** true when the runtime will resume a session: send only the new message, no persona/skills again */
  resuming?: boolean;
  /** inline system prompt into prompt (runtime capabilities.systemPrompt === 'inline') — the adapter handles it, builder just reports */
}

export interface BuiltContext {
  systemPrompt: string;
  prompt: string;
  recalledMemoryIds: number[];
  brainHits: BrainHit[];
  skillIds: string[];
}

export interface ContextBuilder {
  build(input: ContextInput): BuiltContext;
}

/** Character budgets per block; exported so tests and docs agree. */
export const CONTEXT_LIMITS = {
  standard: { persona: 8000, team: 3000, skills: 4000, memory: 3000, brain: 6000, board: 2000, memoryItems: 8, brainHits: 4, boardItems: 10 },
  lean: { persona: 6000, team: 0, skills: 12000, memory: 1500, brain: 4000, board: 0, memoryItems: 3, brainHits: 3, boardItems: 0 },
} as const;
