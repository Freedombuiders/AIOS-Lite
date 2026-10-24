// Work layer contract: Task + Run is the only work model.
import type {
  AgentConfig,
  AttentionItem,
  ContextProfile,
  Conversation,
  Message,
  Run,
  RunEvent,
  RunStatus,
  Schedule,
  StoredRunEvent,
  Task,
  TaskComment,
  TaskKind,
  TaskStatus,
  TaskTrigger,
  Usage,
} from '../core/types.js';

// ---------------------------------------------------------------- tasks

export interface CreateTaskInput {
  prompt: string;
  /** default: first 80 chars of prompt */
  title?: string;
  /** default: 'main' */
  agentId?: string;
  kind?: TaskKind;
  priority?: number;
  parentId?: number | null;
  conversationId?: number | null;
  /** default 'user' */
  source?: string;
  /** default 'assigned' */
  trigger?: TaskTrigger;
  /** default: the agent's `context` setting */
  contextProfile?: ContextProfile;
  /** ISO time; null/undefined = now */
  runAfter?: string | null;
  /** initial status; default 'queued' ('waiting' for team parents) */
  status?: Extract<TaskStatus, 'queued' | 'waiting'>;
  meta?: Record<string, unknown>;
}

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  agentId?: string;
  parentId?: number | null;
  conversationId?: number;
  /** exact match or prefix with trailing '*', e.g. 'module:*' */
  source?: string;
  kind?: TaskKind;
  q?: string;
  limit?: number;
  beforeId?: number;
}

export interface TaskService {
  create(input: CreateTaskInput): Task;
  get(id: number): Task | undefined;
  require(id: number): Task;
  list(filter?: TaskFilter): Task[];
  children(id: number): Task[];
  /** low-level patch; emits a 'task' event */
  update(id: number, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): Task;
  /** cancel a task (and its non-terminal children); aborts a running run via the dispatcher */
  cancel(id: number): Task;
  /** failed/cancelled/done → queued with trigger 'retry' */
  retry(id: number): Task;
  /** review → done */
  approve(id: number): Task;
  /** resolve when the task reaches a terminal status (or 'review'); rejects on timeout/abort */
  waitFor(id: number, opts?: { timeoutMs?: number; signal?: AbortSignal; until?: TaskStatus[] }): Promise<Task>;
  counts(): Record<TaskStatus, number>;
}

// ---------------------------------------------------------------- runs

export interface RunService {
  start(input: { taskId: number; agentId: string; runtime: Run['runtime']; model?: string | null; trigger: TaskTrigger; accessJson?: string; skillsJson?: string }): Run;
  addEvent(runId: number, taskId: number, event: RunEvent): void;
  finish(runId: number, input: { status: Exclude<RunStatus, 'running'>; output?: string | null; sessionId?: string | null; usage?: Usage; errorFamily?: Run['errorFamily']; error?: string | null; model?: string | null }): Run;
  get(id: number): Run | undefined;
  list(filter?: { taskId?: number; agentId?: string; status?: RunStatus; since?: string; limit?: number; beforeId?: number }): Run[];
  events(runId: number, opts?: { afterId?: number; limit?: number }): StoredRunEvent[];
  /** sum of cost_usd for the agent in the current calendar month (UTC); unknown costs ignored */
  monthCost(agentId: string): number;
  /** mark runs still 'running' as failed (boot recovery) */
  failOrphans(reason: string): number;
}

// ---------------------------------------------------------------- comments + attention

export interface CommentService {
  /** a user comment on a finished/review/failed task re-queues it with trigger 'commented' */
  add(taskId: number, author: string, body: string, opts?: { runId?: number | null; requeue?: boolean }): TaskComment;
  list(taskId: number): TaskComment[];
  /** comments added after the given run started (fed to the next run) */
  since(taskId: number, isoTime: string | null): TaskComment[];
}

export interface AttentionService {
  /** derived items (review/failed/budget tasks) + raised items (modules) */
  list(): AttentionItem[];
  raise(item: Omit<AttentionItem, 'createdAt'> & { createdAt?: string }): AttentionItem;
  resolve(key: string): void;
}

// ---------------------------------------------------------------- execution

export type TaskFinishedHook = (task: Task, run: Run | null) => void | Promise<void>;
/** module-provided context for lean tasks whose source is 'module:<id>' */
export type ModuleContextProvider = (task: Task) => string | Promise<string>;

/** A module action agents may call with `<aios-action module="m" name="n">{json}</aios-action>`. */
export interface RegisteredModuleAction {
  moduleId: string;
  name: string;
  /** scope of the module the agent must hold (agent.yaml access.modules.<moduleId>) */
  scope: string;
  /** Vietnamese description shown to agents */
  description: string;
  /** example payload shown to agents */
  example?: unknown;
  run(payload: unknown, call: { agentId: string; taskId: number; runId: number | null }): unknown | Promise<unknown>;
}

export interface Hooks {
  taskFinished: Set<TaskFinishedHook>;
  /** moduleId → provider */
  moduleContext: Map<string, ModuleContextProvider>;
  /** '<moduleId>:<name>' → action (registered while the module is enabled) */
  moduleActions?: Map<string, RegisteredModuleAction>;
  /** moduleId → extra data for ANY run of an agent holding a scope of that module */
  agentContext?: Map<string, (agent: AgentConfig, task: Task, scopes: string[]) => string | undefined | Promise<string | undefined>>;
}

export interface Engine {
  /** run one claimed task to completion (the dispatcher calls this) */
  execute(task: Task, signal: AbortSignal): Promise<void>;
}

export interface Dispatcher {
  start(): void;
  stop(): Promise<void>;
  /** look for work now */
  kick(): void;
  /** abort the run of a running task; false if not running here */
  abort(taskId: number): boolean;
  runningTaskIds(): number[];
}

// ---------------------------------------------------------------- team / scheduler / chat

export interface TeamTaskInput {
  prompt: string;
  title?: string;
  agentIds: string[];
  mode: 'parallel' | 'relay';
  /** parallel only: agent that merges the answers (runs on the parent) */
  mergeBy?: string;
  source?: string;
  priority?: number;
}

export interface TeamService {
  createTeamTask(input: TeamTaskInput): Task;
  /** called by the engine for every finished task: wakes parents, advances relays */
  onTaskFinished(task: Task): void;
}

export interface ScheduleInput {
  name: string;
  agentId: string;
  cron: string;
  timezone?: string;
  prompt: string;
  enabled?: boolean;
}

export interface SchedulerService {
  list(): Schedule[];
  get(id: number): Schedule | undefined;
  create(input: ScheduleInput): Schedule;
  update(id: number, patch: Partial<ScheduleInput>): Schedule;
  remove(id: number): void;
  /** create the task now (ignores skip_if_active) */
  runNow(id: number): Task;
  /** check due schedules once (also called by the timer) */
  tick(now?: Date): Task[];
  start(): void;
  stop(): void;
}

export interface ChatService {
  listConversations(filter?: { agentId?: string; limit?: number }): Conversation[];
  create(input: { agentId: string; title?: string }): Conversation;
  get(id: number): { conversation: Conversation; messages: Message[] } | undefined;
  rename(id: number, title: string): Conversation;
  remove(id: number): void;
  /** store the user message and queue a chat task (priority 10) */
  send(conversationId: number, content: string): { message: Message; task: Task };
}

export interface StatsService {
  overview(): {
    agents: { total: number; enabled: number; running: number };
    tasks: Record<TaskStatus, number>;
    runsToday: number;
    costMonthUsd: number;
    costByAgent: { agentId: string; costUsd: number; runs: number }[];
    recentRuns: Run[];
  };
}
