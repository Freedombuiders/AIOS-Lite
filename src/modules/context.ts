import fs from 'node:fs';
import path from 'node:path';
import { Cron } from 'croner';
import type { AppDeps } from '../core/deps.js';
import { redactString } from '../core/redact.js';
import type { Run } from '../core/types.js';
import { integrationServiceFor } from '../integrations/mount.js';
import { sanitizeOutbound } from './outbound.js';
import type { LeanRunInput, LeanRunResult, ModuleContext, ModuleManifest } from './sdk.js';
import type { SettingsStore } from './settings.js';

/** Things a module started through its context; the manager tears them down on Remove. */
export interface ModuleResources {
  stops: Set<() => void>;
}

export interface ContextHelpers {
  settings: SettingsStore;
  provides<T>(id: string): T | undefined;
  isEnabled(id: string): boolean;
}

const latest = (runs: Run[]): Run | null => runs.reduce<Run | null>((a, r) => (!a || r.id > a.id ? r : a), null);

export function createModuleContext(
  deps: AppDeps,
  manifest: ModuleManifest,
  dir: string,
  res: ModuleResources,
  helpers: ContextHelpers,
): ModuleContext {
  const id = manifest.id;
  const source = `module:${id}`;
  const log = deps.log.child({ module: id });
  const dataDir = path.join(deps.config.dataDir, 'modules', id);
  const attnKey = (key: string) => (key.startsWith(`module:${id}:`) ? key : `module:${id}:${key}`);
  const eventName = (e: string) => (e.includes(':') ? e : `${id}:${e}`);

  async function runLean(input: LeanRunInput): Promise<LeanRunResult> {
    const task = deps.tasks.create({
      agentId: input.agentId,
      title: input.title,
      prompt: input.prompt,
      contextProfile: 'lean',
      trigger: 'module',
      source,
      priority: input.priority ?? 5,
      meta: { ...input.meta, moduleContext: input.moduleContext, images: input.images, documents: input.documents },
    });
    try {
      const done = await deps.tasks.waitFor(task.id, { timeoutMs: input.timeoutMs ?? deps.config.runTimeoutMs, signal: input.signal });
      const run = latest(deps.runs.list({ taskId: task.id, limit: 20 }));
      const ok = done.status === 'done' || done.status === 'review';
      const usage = run
        ? {
            ...(run.inputTokens != null ? { inputTokens: run.inputTokens } : {}),
            ...(run.outputTokens != null ? { outputTokens: run.outputTokens } : {}),
            ...(run.costUsd != null ? { costUsd: run.costUsd } : {}),
          }
        : undefined;
      return {
        ok,
        output: run?.output ?? done.result ?? '',
        taskId: task.id,
        runId: run?.id ?? null,
        ...(ok ? {} : { error: run?.error ?? done.error ?? `Việc kết thúc ở trạng thái ${done.status}.` }),
        ...(usage && Object.keys(usage).length ? { usage } : {}),
      };
    } catch (err) {
      try {
        deps.tasks.cancel(task.id);
      } catch {
        /* already finished */
      }
      const aborted = input.signal?.aborted;
      return {
        ok: false,
        output: '',
        taskId: task.id,
        runId: null,
        error: aborted ? 'Đã huỷ.' : `Hết thời gian chờ agent (${redactString(err instanceof Error ? err.message : String(err))}).`,
      };
    }
  }

  const ctx: ModuleContext = {
    id,
    manifest,
    dir,
    get dataDir() {
      fs.mkdirSync(dataDir, { recursive: true });
      return dataDir;
    },
    db: deps.db,
    log,
    tasks: {
      create: (input) => deps.tasks.create({ ...input, source }),
      get: (taskId) => deps.tasks.get(taskId),
      cancel: (taskId) => void deps.tasks.cancel(taskId),
    },
    agents: {
      list: () => deps.agents.list(),
      get: (agentId) => deps.agents.get(agentId),
      runLean,
      attachments: (agentId) => {
        const runtime = deps.agents.get(agentId)?.runtime;
        let caps: { images: boolean; documents: boolean } | undefined;
        try {
          caps = runtime ? deps.runtimes.get(runtime).capabilities : undefined;
        } catch {
          caps = undefined; // runtime not registered
        }
        return { images: caps?.images === true, documents: caps?.documents === true };
      },
    },
    access: {
      can: (agentId, scope) => deps.access.can(agentId, id, scope),
      canIn: (moduleId, agentId, scope) => deps.access.can(agentId, moduleId, scope),
    },
    connections: {
      composio: () => deps.connections.composio(),
      secret: (name) => deps.connections.secret(name),
      has: (idOrType) => deps.connections.has(idOrType),
    },
    memory: {
      add: (input) =>
        deps.memory.add({ content: input.content, agentId: input.agentId, pinned: input.pinned, source: input.agentId ? `agent:${input.agentId}` : 'user' }),
      recall: (agentId, query, limit = 5) => {
        const grant = deps.agents.get(agentId)?.access.memory ?? { team: true, private: true };
        return deps.memory.recall(agentId, query, { ...grant, limit });
      },
    },
    brain: { search: (query, opts) => deps.brain.search(query, opts) },
    settings: {
      get: <T = unknown>(key: string, fallback?: T) => (helpers.settings.all(id)[key] ?? fallback) as T,
      set: (key, value) => helpers.settings.patch(id, { [key]: value }, manifest.version),
      all: () => helpers.settings.all(id),
    },
    schedule: {
      every(name, when, fn) {
        const run = () => {
          try {
            Promise.resolve(fn()).catch((err) => log.error({ err, schedule: name }, 'schedule failed'));
          } catch (err) {
            log.error({ err, schedule: name }, 'schedule failed');
          }
        };
        let stop: () => void;
        if (typeof when === 'number') {
          const t = setInterval(run, Math.max(1, when));
          t.unref?.();
          stop = () => clearInterval(t);
        } else {
          const cron = new Cron(when, { timezone: deps.config.timezone }, run);
          stop = () => cron.stop();
        }
        const wrapped = () => {
          stop();
          res.stops.delete(wrapped);
        };
        res.stops.add(wrapped);
        return wrapped;
      },
    },
    events: {
      emit: (event, payload) => deps.bus.emit({ type: 'custom', name: eventName(event), payload }),
      on(event, handler) {
        const name = eventName(event);
        const off = deps.bus.on('custom', (e) => {
          if (e.name === name) handler(e.payload);
        });
        const wrapped = () => {
          off();
          res.stops.delete(wrapped);
        };
        res.stops.add(wrapped);
        return wrapped;
      },
    },
    audit: {
      log: (action, target = null, detail, actor) =>
        void deps.audit.log({ actor: actor ?? source, action, target, detail: detail ?? null }),
    },
    attention: {
      raise: (item) =>
        void deps.attention.raise({
          key: attnKey(item.key),
          kind: 'module',
          moduleId: id,
          title: item.title,
          detail: item.detail,
          link: item.link,
          severity: item.severity ?? 'info',
          taskId: item.taskId,
        }),
      resolve: (key) => deps.attention.resolve(attnKey(key)),
    },
    modules: {
      get: (moduleId) => helpers.provides(moduleId),
      isEnabled: (moduleId) => helpers.isEnabled(moduleId),
    },
    outbound: { sanitize: sanitizeOutbound },
    integrations: {
      values: (integrationId) => integrationServiceFor(deps).credentials.loadValues(integrationId),
      read: (integrationId, commandLine) => integrationServiceFor(deps).runner.runRead({ integrationId, commandLine, actor: source }),
    },
    crypto: { encrypt: (p) => deps.cipher.encrypt(p), decrypt: (v) => deps.cipher.decrypt(v) },
  };
  return ctx;
}
