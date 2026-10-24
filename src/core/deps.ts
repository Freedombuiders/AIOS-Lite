// The wiring of the whole app. main.ts builds one AppDeps; services receive the parts they need.
import type { AccessPolicy, AuditService, ConnectionsService } from '../access/contracts.js';
import type { AgentRegistry } from '../agents/contracts.js';
import type { ModuleManager } from '../modules/contracts.js';
import type { RuntimeRegistry } from '../runtimes/contracts.js';
import type { BoardService, BrainService, ContextBuilder, MemoryService, SkillLibrary } from '../shared/contracts.js';
import type {
  AttentionService,
  ChatService,
  CommentService,
  Dispatcher,
  Engine,
  Hooks,
  RunService,
  SchedulerService,
  StatsService,
  TaskService,
  TeamService,
} from '../work/contracts.js';
import type { AppConfig } from './config.js';
import type { Cipher } from './crypto.js';
import type { DB } from './db.js';
import type { EventBus } from './events.js';
import type { Logger } from './log.js';

export interface AppDeps {
  config: AppConfig;
  db: DB;
  bus: EventBus;
  log: Logger;
  cipher: Cipher;
  hooks: Hooks;

  agents: AgentRegistry;
  runtimes: RuntimeRegistry;

  connections: ConnectionsService;
  access: AccessPolicy;
  audit: AuditService;

  brain: BrainService;
  memory: MemoryService;
  skills: SkillLibrary;
  board: BoardService;
  context: ContextBuilder;

  tasks: TaskService;
  runs: RunService;
  comments: CommentService;
  attention: AttentionService;
  engine: Engine;
  dispatcher: Dispatcher;
  team: TeamService;
  scheduler: SchedulerService;
  chat: ChatService;
  stats: StatsService;

  modules: ModuleManager;
}

/**
 * Factory naming convention (each in its own file, each takes the subset of AppDeps it needs):
 *   runtimes/index.ts      createRuntimeRegistry(opts)
 *   agents/registry.ts     createAgentRegistry({ agentsDir, workspacesDir })
 *   access/connections.ts  createConnectionsService({ file, envFile, log })
 *   access/policy.ts       createAccessPolicy({ agents, brain, connections, skills, isModuleEnabled })
 *   access/audit.ts        createAuditService({ db, bus })
 *   shared/brain.ts        createBrainService({ db, configFile, rootDir, log })
 *   shared/memory.ts       createMemoryService({ db, bus })
 *   shared/skills.ts       createSkillLibrary({ dirs, log })
 *   shared/board.ts        createBoardService({ db, bus })
 *   shared/context.ts      createContextBuilder({ agents, brain, memory, skills, board })
 *   work/tasks.ts          createTaskService({ db, bus, agents, abort?: (id) => boolean })
 *   work/runs.ts           createRunService({ db, bus })
 *   work/comments.ts       createCommentService({ db, bus, tasks })
 *   work/attention.ts      createAttentionService({ db, bus, tasks, runs, agents })
 *   work/engine.ts         createEngine(deps: AppDeps)
 *   work/dispatcher.ts     createDispatcher({ db, config, agents, tasks, engine, log })
 *   work/team.ts           createTeamService({ tasks, agents, log })
 *   work/scheduler.ts      createScheduler({ db, tasks, agents, log, config })
 *   work/chat.ts           createChatService({ db, bus, tasks, agents })
 *   work/stats.ts          createStatsService({ db, agents, runs, tasks })
 *   modules/manager.ts     createModuleManager(deps: AppDeps)
 *   api/server.ts          createApiServer(deps: AppDeps) → { app, listen(): Promise<{ close(): Promise<void> }> }
 *   main.ts                bootstrap(opts) → AppDeps ; startApp(opts) → running server
 */
export type { AppConfig };
