// In-test fakes for the other layers + real work services on an in-memory DB.
import { loadConfig, type AppConfig } from '../core/config.js';
import { migrateCore, nowIso, openDb, type DB } from '../core/db.js';
import type { AppDeps } from '../core/deps.js';
import { createEventBus } from '../core/events.js';
import { createLogger } from '../core/log.js';
import type { AgentConfig, BoardEntry, Memory } from '../core/types.js';
import type { Runtime, RunRequest, RunResult } from '../runtimes/contracts.js';
import { createAttentionService } from './attention.js';
import { createChatService } from './chat.js';
import { createCommentService } from './comments.js';
import { createDispatcher } from './dispatcher.js';
import { createEngine } from './engine.js';
import { createRunService } from './runs.js';
import { createScheduler } from './scheduler.js';
import { createStatsService } from './stats.js';
import { createTaskService } from './tasks.js';
import { createTeamService } from './team.js';

export function agent(id: string, extra: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id, name: id, description: '', runtime: 'mock', runtimeOptions: {}, permission: 'safe', context: 'standard',
    canDelegate: false, maxConcurrent: 1, enabled: true, persona: '', dir: `/tmp/agents/${id}`, workspace: `/tmp/aios-test-ws/${id}`,
    access: { brain: {}, memory: { team: true, private: true }, skills: [], connections: {}, modules: {} },
    ...extra,
  };
}

export type Script = (req: RunRequest, call: number) => RunResult | Promise<RunResult>;

export interface Kit {
  deps: AppDeps;
  db: DB;
  agentMap: Map<string, AgentConfig>;
  requests: RunRequest[];
  prompts: string[];
  memories: Memory[];
  board: BoardEntry[];
  script: { current: Script };
  calls: { linked: string[]; contexts: Parameters<AppDeps['context']['build']>[0][] };
  settle(timeoutMs?: number): Promise<void>;
}

export function makeKit(agents: AgentConfig[], opts: { config?: Partial<AppConfig>; runtimeCaps?: Partial<Runtime['capabilities']> } = {}): Kit {
  const db = openDb(':memory:');
  migrateCore(db);
  const bus = createEventBus();
  const log = createLogger({ level: 'silent' });
  const config: AppConfig = { ...loadConfig({ rootDir: '/tmp/aios-test', env: {}, loadDotEnv: false }), dispatcherPollMs: 100, ...opts.config };
  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const agentsReg = {
    reload() {}, list: () => [...agentMap.values()], get: (id: string) => agentMap.get(id),
    require(id: string) { const a = agentMap.get(id); if (!a) throw new Error(id); return a; },
    create() { throw new Error('n/a'); }, update() { throw new Error('n/a'); }, archive() {}, installTemplate() { throw new Error('n/a'); }, errors: () => [],
  } as unknown as AppDeps['agents'];

  const requests: RunRequest[] = [];
  const script: { current: Script } = { current: (req) => ({ ok: true, output: `echo: ${req.prompt.slice(0, 40)}` }) };
  let callNo = 0;
  const runtime: Runtime = {
    id: 'mock', label: 'mock',
    capabilities: { resume: true, systemPrompt: 'native', reportsCost: true, images: true, documents: true, noTools: true, enforces: { context: 'hard', mcp: 'none', fileRead: 'none', fileWrite: 'none', shell: 'none' }, ...opts.runtimeCaps },
    async doctor() { return { runtime: 'mock', status: 'pass', checks: [], testedAt: nowIso() }; },
    async run(req) { requests.push(req); return script.current(req, ++callNo); },
  };
  const runtimes = { get: () => runtime, list: () => [runtime], register() {} } as AppDeps['runtimes'];

  const memories: Memory[] = [];
  const boardEntries: BoardEntry[] = [];
  const prompts: string[] = [];
  const calls: Kit['calls'] = { linked: [], contexts: [] };

  const tasks = createTaskService({ db, bus, agents: agentsReg, abort: (id) => deps.dispatcher.abort(id) });
  const runs = createRunService({ db, bus });
  const comments = createCommentService({ db, bus, tasks });
  const attention = createAttentionService({ db, bus, tasks, runs, agents: agentsReg });
  const team = createTeamService({ tasks, agents: agentsReg, log });

  const deps = {
    config, db, bus, log, hooks: { taskFinished: new Set(), moduleContext: new Map() },
    agents: agentsReg, runtimes,
    access: {
      resolve: (a: AgentConfig) => ({ agentId: a.id, readDirs: [], writeDirs: [], addDirs: [], memory: a.access.memory, mcpServers: [], envVars: {}, skills: [], moduleScopes: {}, permission: a.permission, tools: 'default' }),
      snapshot: (x: { agentId: string }) => ({ agentId: x.agentId }),
      can: () => true, canReadPath: () => true, canWritePath: () => true,
    },
    audit: { log: (e: object) => ({ id: 1, ts: nowIso(), ...e }), list: () => [] },
    memory: { add: (i: Partial<Memory>) => { const m = { id: memories.length + 1, pinned: false, useCount: 0, lastUsedAt: null, createdAt: nowIso(), source: 'user', sourceTaskId: null, sourceRunId: null, ...i } as Memory; memories.push(m); return m; } },
    skills: { linkIntoWorkspace: (ws: string) => { calls.linked.push(ws); } },
    board: { add: (e: { agentId: string | null; taskId?: number | null; kind?: string; text: string }) => { const b = { id: boardEntries.length + 1, taskId: null, kind: 'note', createdAt: nowIso(), ...e } as BoardEntry; boardEntries.push(b); return b; }, recent: () => boardEntries },
    context: {
      build: (input: Kit['calls']['contexts'][number]) => {
        calls.contexts.push(input);
        const parts = [`[trigger:${input.task.trigger}]`, input.task.prompt];
        for (const c of input.childResults ?? []) parts.push(`child ${c.agentId}: ${c.result ?? c.error}`);
        for (const c of input.comments ?? []) parts.push(`comment: ${c.body}`);
        if (input.moduleContext) parts.push(`module: ${input.moduleContext}`);
        if (input.history) parts.push(`history:${input.history.length}`);
        const prompt = parts.join('\n');
        prompts.push(prompt);
        return { systemPrompt: 'sys', prompt, recalledMemoryIds: [], brainHits: [], skillIds: ['s1'] };
      },
    },
    tasks, runs, comments, attention, team,
    scheduler: createScheduler({ db, tasks, agents: agentsReg, log, config }),
    chat: createChatService({ db, bus, tasks, agents: agentsReg }),
    stats: createStatsService({ db, agents: agentsReg, runs, tasks }),
  } as unknown as AppDeps;
  deps.engine = createEngine(deps);
  deps.dispatcher = createDispatcher({ db, config, agents: agentsReg, tasks, engine: deps.engine, log, bus, stopTimeoutMs: 500 });
  bus.on('task', (e) => {
    const t = e.task;
    if (t.parentId != null && (t.status === 'done' || t.status === 'cancelled' || t.status === 'failed')) team.onTaskFinished(t);
  });

  const settle = async (timeoutMs = 3000) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const busy = tasks.list({ status: ['queued', 'running'], limit: 500 }).length;
      if (!busy && !deps.dispatcher.runningTaskIds().length) return;
      if (Date.now() > end) throw new Error(`not settled: ${JSON.stringify(tasks.counts())}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { deps, db, agentMap, requests, prompts, memories, board: boardEntries, script, calls, settle };
}
