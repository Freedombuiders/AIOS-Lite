// In-test fakes of the other agents' services, enough to build an AppDeps for module + API tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../core/config.js';
import { createCipher } from '../core/crypto.js';
import { migrateCore, nowIso, openDb } from '../core/db.js';
import type { AppDeps } from '../core/deps.js';
import { createEventBus } from '../core/events.js';
import { createLogger } from '../core/log.js';
import type {
  AgentConfig, AttentionItem, AuditEntry, BoardEntry, BrainFolder, Connection, Conversation, Memory, Message,
  Run, Schedule, Skill, Task, TaskComment, TaskStatus,
} from '../core/types.js';
import type { CreateTaskInput, TaskFilter } from '../work/contracts.js';

export const TASK_STATUSES: TaskStatus[] = ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled'];

export function fakeAgent(id: string, extra: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id, name: id, description: '', runtime: 'mock', runtimeOptions: {}, permission: 'safe', context: 'standard',
    canDelegate: false, maxConcurrent: 1, enabled: true, persona: '', dir: `/tmp/agents/${id}`, workspace: `/tmp/ws/${id}`,
    access: { brain: {}, memory: { team: true, private: true }, skills: [], connections: {}, modules: {} },
    ...extra,
  };
}

export interface TestHarness {
  deps: AppDeps;
  root: string;
  fakes: ReturnType<typeof buildFakes>;
  cleanup(): void;
}

function buildFakes(db: ReturnType<typeof openDb>, bus: AppDeps['bus']) {
  let seq = 0;
  const tasks: Task[] = [];
  const runs: Run[] = [];
  const waiters = new Map<number, ((t: Task) => void)[]>();
  const comments: TaskComment[] = [];
  const schedules: Schedule[] = [];
  const conversations: Conversation[] = [];
  const messages: Message[] = [];
  const memories: Memory[] = [];
  const attention = new Map<string, AttentionItem>();
  const agents = new Map<string, AgentConfig>([['main', fakeAgent('main')]]);
  const connections = new Map<string, Connection>();
  const installedTemplates: string[] = [];
  const skillRoots: { dir: string; source: string }[] = [];
  const state = { autoFinish: undefined as undefined | ((t: Task) => { status?: TaskStatus; output?: string; error?: string }) };

  const settle = (task: Task) => {
    for (const w of waiters.get(task.id) ?? []) w(task);
    waiters.delete(task.id);
  };
  const mkTask = (input: CreateTaskInput): Task => {
    const now = nowIso();
    const t: Task = {
      id: ++seq, title: input.title ?? input.prompt.slice(0, 80), prompt: input.prompt, agentId: input.agentId ?? 'main',
      status: input.status ?? 'queued', kind: input.kind ?? 'task', priority: input.priority ?? 5, parentId: input.parentId ?? null,
      conversationId: input.conversationId ?? null, source: input.source ?? 'user', trigger: input.trigger ?? 'assigned',
      contextProfile: input.contextProfile ?? 'standard', depth: 0, runAfter: input.runAfter ?? null, result: null, error: null,
      recoverCount: 0, meta: input.meta ?? {}, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
    };
    tasks.push(t);
    return t;
  };
  const finish = (id: number, status: TaskStatus, output = '', error: string | null = null) => {
    const t = tasks.find((x) => x.id === id)!;
    t.status = status;
    t.result = output || null;
    t.error = error;
    const run: Run = {
      id: ++seq, taskId: id, agentId: t.agentId, runtime: 'mock', model: null, status: status === 'done' ? 'done' : 'failed',
      trigger: t.trigger, sessionId: null, output, errorFamily: null, error, inputTokens: 10, outputTokens: 5, costUsd: null,
      accessJson: null, skillsJson: null, startedAt: nowIso(), finishedAt: nowIso(), durationMs: 1,
    };
    runs.push(run);
    settle(t);
    return t;
  };

  return { tasks, runs, comments, schedules, conversations, messages, memories, attention, agents, connections, installedTemplates, skillRoots, state, finish, mkTask, waiters, settle, bus, db, nextId: () => ++seq };
}

export function createTestHarness(opts: { modulesDir?: string; env?: Record<string, string> } = {}): TestHarness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-test-'));
  const config = loadConfig({
    rootDir: root,
    loadDotEnv: false,
    env: { AIOS_MODULES_DIR: opts.modulesDir ?? path.join(root, 'modules'), AIOS_RUN_TIMEOUT_SEC: '5', ...opts.env },
  });
  const db = openDb(':memory:');
  migrateCore(db);
  const bus = createEventBus();
  const log = createLogger({ level: 'silent' });
  const f = buildFakes(db, bus);

  const audit = {
    log(e: { actor: string; action: string; target?: string | null; runId?: number | null; detail?: Record<string, unknown> | null }): AuditEntry {
      const r = db
        .prepare('INSERT INTO audit_log (actor, action, target, run_id, detail) VALUES (?,?,?,?,?)')
        .run(e.actor, e.action, e.target ?? null, e.runId ?? null, e.detail ? JSON.stringify(e.detail) : null);
      const entry: AuditEntry = { id: Number(r.lastInsertRowid), ts: nowIso(), actor: e.actor, action: e.action, target: e.target ?? null, runId: e.runId ?? null, detail: e.detail ?? null };
      bus.emit({ type: 'audit', entry });
      return entry;
    },
    list(filter: { actor?: string; action?: string; limit?: number; beforeId?: number } = {}): AuditEntry[] {
      const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(filter.limit ?? 50) as Record<string, unknown>[];
      return rows
        .filter((r) => (!filter.actor || r.actor === filter.actor) && (!filter.action || r.action === filter.action))
        .map((r) => ({ id: r.id as number, ts: r.ts as string, actor: r.actor as string, action: r.action as string, target: (r.target as string) ?? null, runId: (r.run_id as number) ?? null, detail: r.detail ? JSON.parse(r.detail as string) : null }));
    },
  };

  const hooks: AppDeps['hooks'] = { taskFinished: new Set(), moduleContext: new Map() };

  const tasks: AppDeps['tasks'] = {
    create: (input) => {
      const t = f.mkTask(input);
      bus.emit({ type: 'task', task: t });
      if (f.state.autoFinish) {
        const r = f.state.autoFinish(t);
        queueMicrotask(() => f.finish(t.id, r.status ?? 'done', r.output ?? '', r.error ?? null));
      }
      return t;
    },
    get: (id) => f.tasks.find((t) => t.id === id),
    require(id) {
      const t = f.tasks.find((x) => x.id === id);
      if (!t) throw new Error(`task ${id} not found`);
      return t;
    },
    list(filter: TaskFilter = {}) {
      const st = filter.status ? (Array.isArray(filter.status) ? filter.status : [filter.status]) : null;
      return f.tasks
        .filter((t) => (!st || st.includes(t.status)) && (!filter.agentId || t.agentId === filter.agentId) && (!filter.source || (filter.source.endsWith('*') ? t.source.startsWith(filter.source.slice(0, -1)) : t.source === filter.source)))
        .slice(-(filter.limit ?? 50))
        .reverse();
    },
    children: (id) => f.tasks.filter((t) => t.parentId === id),
    update(id, patch) {
      const t = f.tasks.find((x) => x.id === id)!;
      Object.assign(t, patch);
      return t;
    },
    cancel(id) {
      const t = f.tasks.find((x) => x.id === id);
      if (!t) throw new Error(`task ${id} not found`);
      t.status = 'cancelled';
      f.settle(t);
      return t;
    },
    retry(id) {
      const t = tasks.require(id);
      t.status = 'queued';
      t.trigger = 'retry';
      return t;
    },
    approve(id) {
      const t = tasks.require(id);
      t.status = 'done';
      return t;
    },
    waitFor(id, o = {}) {
      return new Promise<Task>((resolve, reject) => {
        const t = tasks.require(id);
        if (['done', 'failed', 'cancelled', 'review'].includes(t.status)) return resolve(t);
        const timer = o.timeoutMs ? setTimeout(() => reject(new Error(`timeout ${o.timeoutMs}ms`)), o.timeoutMs) : undefined;
        o.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        const list = f.waiters.get(id) ?? [];
        list.push((x) => {
          clearTimeout(timer);
          resolve(x);
        });
        f.waiters.set(id, list);
      });
    },
    counts() {
      const c = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
      for (const t of f.tasks) c[t.status]++;
      return c;
    },
  };

  const deps = {
    config,
    db,
    bus,
    log,
    cipher: createCipher('test-secret'),
    hooks,
    agents: {
      reload() {},
      list: () => [...f.agents.values()],
      get: (id: string) => f.agents.get(id),
      require(id: string) {
        const a = f.agents.get(id);
        if (!a) throw new Error(`agent ${id} not found`);
        return a;
      },
      create(id: string, input: Partial<AgentConfig> & { name: string; runtime: AgentConfig['runtime'] }) {
        if (f.agents.has(id)) throw new Error('exists');
        const a = fakeAgent(id, input);
        f.agents.set(id, a);
        return a;
      },
      update(id: string, patch: Partial<AgentConfig>) {
        const a = Object.assign(f.agents.get(id)!, patch);
        return a;
      },
      archive(id: string) {
        f.agents.delete(id);
      },
      installTemplate(dir: string, id?: string) {
        const aid = id ?? path.basename(dir);
        f.installedTemplates.push(aid);
        const a = fakeAgent(aid);
        f.agents.set(aid, a);
        return a;
      },
      errors: () => [],
    },
    runtimes: { get: () => { throw new Error('no runtime'); }, list: () => [], register() {} },
    connections: {
      reload() {},
      list: () => [...f.connections.values()],
      get: (id: string) => f.connections.get(id),
      resolveEnv: () => ({}),
      secret: (n: string) => (n === 'SECRET_A' ? 'sekret' : undefined),
      composio: async () => { throw new Error('no composio'); },
      has: (x: string) => [...f.connections.values()].some((c) => c.id === x || c.type === x),
      test: async () => ({ ok: true, message: 'ok' }),
    },
    access: { resolve: () => { throw new Error('n/a'); }, snapshot: () => { throw new Error('n/a'); }, can: (a: string, m: string, s: string) => f.agents.get(a)?.access.modules[m]?.includes(s) ?? false, canReadPath: () => true, canWritePath: () => true },
    audit,
    brain: { folders: () => [] as BrainFolder[], search: () => [], reloadConfig() {}, reindex: async () => ({ indexed: 0, removed: 0, durationMs: 0 }), searchForAccess: () => [], read: () => ({ title: '', content: '', mtimeMs: 0 }), tree: () => [], write() {} },
    memory: {
      add(input: { content: string; agentId: string | null; source?: string; pinned?: boolean }) {
        const m: Memory = { id: f.nextId(), agentId: input.agentId, content: input.content, source: input.source ?? 'user', sourceTaskId: null, sourceRunId: null, pinned: !!input.pinned, useCount: 0, lastUsedAt: null, createdAt: nowIso() };
        f.memories.push(m);
        return m;
      },
      get: (id: number) => f.memories.find((m) => m.id === id),
      list: () => f.memories,
      update(id: number, p: { content?: string; pinned?: boolean }) {
        return Object.assign(f.memories.find((m) => m.id === id)!, p);
      },
      remove(id: number) {
        const i = f.memories.findIndex((m) => m.id === id);
        if (i >= 0) f.memories.splice(i, 1);
      },
      recall: () => f.memories,
    },
    skills: {
      reload() {},
      list: () => [] as Skill[],
      get: () => undefined,
      read: () => '',
      addRoot: (dir: string, source: string) => void f.skillRoots.push({ dir, source }),
      removeRoot(dir: string) {
        const i = f.skillRoots.findIndex((r) => r.dir === dir);
        if (i >= 0) f.skillRoots.splice(i, 1);
      },
      resolve: () => [] as Skill[],
      linkIntoWorkspace() {},
    },
    board: { add: (e: { agentId: string | null; text: string }) => ({ id: 1, agentId: e.agentId, taskId: null, kind: 'note', text: e.text, createdAt: nowIso() }) as BoardEntry, recent: () => [] as BoardEntry[] },
    context: { build: () => { throw new Error('n/a'); } },
    tasks,
    runs: {
      start: () => { throw new Error('n/a'); },
      addEvent() {},
      finish: () => { throw new Error('n/a'); },
      get: (id: number) => f.runs.find((r) => r.id === id),
      list: (filter: { taskId?: number } = {}) => f.runs.filter((r) => !filter.taskId || r.taskId === filter.taskId),
      events: () => [],
      monthCost: () => 0,
      failOrphans: () => 0,
    },
    comments: {
      add(taskId: number, author: string, body: string) {
        const c: TaskComment = { id: f.nextId(), taskId, author, body, runId: null, createdAt: nowIso() };
        f.comments.push(c);
        return c;
      },
      list: (taskId: number) => f.comments.filter((c) => c.taskId === taskId),
      since: () => [],
    },
    attention: {
      list: () => [...f.attention.values()],
      raise(item: Omit<AttentionItem, 'createdAt'>) {
        const a = { ...item, createdAt: nowIso() } as AttentionItem;
        f.attention.set(a.key, a);
        return a;
      },
      resolve(key: string) {
        f.attention.delete(key);
      },
    },
    engine: { execute: async () => {} },
    dispatcher: { start() {}, stop: async () => {}, kick() {}, abort: () => false, runningTaskIds: () => [] },
    team: { createTeamTask: (i: { prompt: string }) => f.mkTask({ prompt: i.prompt, kind: 'team' }), onTaskFinished() {} },
    scheduler: {} as unknown,
    chat: {} as unknown,
    stats: {} as unknown,
    modules: undefined as unknown,
  } as unknown as AppDeps;

  return { deps, root, fakes: f, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
