import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiServer } from './api/server.js';
import { createAccessPolicy } from './access/policy.js';
import { createAuditService } from './access/audit.js';
import { createConnectionsService } from './access/connections.js';
import { createAgentRegistry } from './agents/registry.js';
import { loadConfig, type AppConfig } from './core/config.js';
import { createCipher } from './core/crypto.js';
import { migrateCore, openDb } from './core/db.js';
import type { AppDeps } from './core/deps.js';
import { createEventBus } from './core/events.js';
import { createLogger } from './core/log.js';
import { createModuleManager } from './modules/manager.js';
import { createRuntimeRegistry } from './runtimes/index.js';
import { createBoardService } from './shared/board.js';
import { createBrainService } from './shared/brain.js';
import { createContextBuilder } from './shared/context.js';
import { integrationServiceFor } from './integrations/mount.js';
import { INTEGRATIONS } from './integrations/registry.js';
import { createMemoryService } from './shared/memory.js';
import { createSkillLibrary } from './shared/skills.js';
import { createAttentionService } from './work/attention.js';
import { createChatService } from './work/chat.js';
import { createCommentService } from './work/comments.js';
import { createDispatcher } from './work/dispatcher.js';
import { createEngine } from './work/engine.js';
import { recoverOnBoot } from './work/recovery.js';
import { createRunService } from './work/runs.js';
import { createScheduler } from './work/scheduler.js';
import { createStatsService } from './work/stats.js';
import { createTaskService } from './work/tasks.js';
import { createTeamService } from './work/team.js';

export { recoverOnBoot };

export interface BootstrapOptions {
  rootDir?: string;
  config?: AppConfig;
}

/** Build every service in dependency order. Does not start timers or the API. */
export function bootstrap(opts: BootstrapOptions = {}): AppDeps {
  const config = opts.config ?? loadConfig(opts.rootDir ? { rootDir: opts.rootDir } : {});
  const log = createLogger();
  const db = openDb(config.dbPath);
  migrateCore(db);
  const bus = createEventBus();
  const cipher = createCipher(config.encryptionKey);
  const hooks: AppDeps['hooks'] = { taskFinished: new Set(), moduleContext: new Map(), moduleActions: new Map(), agentContext: new Map() };

  const agents = createAgentRegistry({ agentsDir: config.agentsDir, workspacesDir: config.workspacesDir });
  const runtimes = createRuntimeRegistry();
  const connections = createConnectionsService({ file: config.connectionsFile, envFile: config.envFile, log });
  const audit = createAuditService({ db, bus });
  const brain = createBrainService({ db, configFile: config.brainConfigFile, rootDir: config.rootDir, log });
  const memory = createMemoryService({ db, bus });
  const skills = createSkillLibrary({ dirs: config.skillsDirs, log });
  const board = createBoardService({ db, bus });
  const context = createContextBuilder({
    agents, brain, memory, skills, board,
    listActions: () => [...(hooks.moduleActions?.values() ?? [])],
    listIntegrations: () => INTEGRATIONS.map((d) => ({ id: d.id, name: d.name, agentGuide: d.agentGuide })),
  });

  // modules and dispatcher are created last but referenced lazily by the services built before them
  const lazy: { modules?: AppDeps['modules']; dispatcher?: AppDeps['dispatcher']; deps?: AppDeps } = {};
  const access = createAccessPolicy({
    agents, brain, connections, skills,
    isModuleEnabled: (id) => lazy.modules?.isEnabled(id) ?? false,
    // integrations bridge (MCP server `aios-integrations`): calls back into this API with a per-task token
    apiUrl: `http://${config.host}:${config.port}`,
    integrationToken: (agentId, taskId) => integrationServiceFor(lazy.deps!).createRunToken(agentId, taskId),
  });

  const tasks = createTaskService({ db, bus, agents, abort: (id) => lazy.dispatcher?.abort(id) ?? false });
  const runs = createRunService({ db, bus });
  const comments = createCommentService({ db, bus, tasks });
  const attention = createAttentionService({ db, bus, tasks, runs, agents });
  const team = createTeamService({ tasks, agents, log });
  const scheduler = createScheduler({ db, tasks, agents, log, config });
  const chat = createChatService({ db, bus, tasks, agents });
  const stats = createStatsService({ db, agents, runs, tasks });

  const deps = {
    config, db, bus, log, cipher, hooks, agents, runtimes, connections, access, audit, brain, memory, skills, board, context,
    tasks, runs, comments, attention, team, scheduler, chat, stats,
  } as unknown as AppDeps;
  lazy.deps = deps;
  deps.engine = createEngine(deps);
  deps.dispatcher = createDispatcher({ db, config, agents, tasks, engine: deps.engine, log, bus });
  lazy.dispatcher = deps.dispatcher;
  deps.modules = createModuleManager(deps);
  lazy.modules = deps.modules;

  // approvals and cancellations of children happen outside the engine: wake the parent from here
  bus.on('task', (e) => {
    const t = e.task;
    if (t.parentId != null && (t.status === 'done' || t.status === 'cancelled' || t.status === 'failed')) {
      try {
        team.onTaskFinished(t);
      } catch (err) {
        log.error({ err, taskId: t.id }, 'team.onTaskFinished failed');
      }
    }
  });
  return deps;
}

export interface RunningApp {
  deps: AppDeps;
  stop(): Promise<void>;
}

export async function startApp(opts: BootstrapOptions = {}): Promise<RunningApp> {
  const deps = bootstrap(opts);
  recoverOnBoot(deps);
  await deps.modules.start();
  deps.dispatcher.start();
  deps.scheduler.start();
  const server = await createApiServer(deps).listen();
  deps.log.info({ host: deps.config.host, port: deps.config.port }, 'AIOS-Lite đang chạy');

  // Second Brain: index once at boot, then every 15 minutes (incremental, mtime-based).
  const reindexBrain = () =>
    deps.brain.reindex().then(
      (r) => deps.log.info(r, 'Second Brain đã lập chỉ mục'),
      (err) => deps.log.warn({ err }, 'Lập chỉ mục Second Brain lỗi'),
    );
  void reindexBrain();
  const brainTimer = setInterval(() => void reindexBrain(), 15 * 60 * 1000);
  brainTimer.unref();

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      clearInterval(brainTimer);
      deps.scheduler.stop();
      await server.close();
      await deps.dispatcher.stop();
      await deps.modules.stop();
      deps.db.close();
    })());
  const onSignal = () => {
    void stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return { deps, stop };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startApp().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
