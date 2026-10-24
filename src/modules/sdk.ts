// Module SDK — the ONLY surface a module may use. Modules never import core internals.
//
//   modules/<id>/module.json        → ModuleManifest
//   modules/<id>/server/index.ts    → export default defineModule({...})
//   modules/<id>/migrations/*.sql   → applied in name order on Add (only tables listed in manifest.tables)
//   modules/<id>/agents/<tpl>/      → agent templates (agent.yaml + persona.md)
//   modules/<id>/skills/<skill>/    → skills added to the library while the module is enabled
//   modules/<id>/web/index.tsx      → export default defineWebModule({...}) (see web/src/module-host/contracts.ts)
import type { Composio } from '@composio/core';
import type { Hono } from 'hono';
import type { DB } from '../core/db.js';
import type { Logger } from '../core/log.js';
import type { AgentConfig, BrainHit, Memory, Run, Task, Usage } from '../core/types.js';
import type { CreateTaskInput } from '../work/contracts.js';

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
  /** sidebar group for the module's pages */
  category: 'sales' | 'marketing' | 'ops' | 'other';
  requires?: {
    /** modules that must be added first */
    modules?: string[];
    /** connection ids or types that must exist, e.g. ["composio"] */
    connections?: string[];
  };
  /** modules this one plugs into when present (informational) */
  enhances?: string[];
  /** scope → Vietnamese label, granted per agent in agent.yaml access.modules.<id> */
  scopes?: Record<string, string>;
  /** every table the module's migrations create; Purge drops exactly these */
  tables: string[];
  agentTemplates?: string[];
  skills?: string[];
  settings?: Record<string, ModuleSettingSpec>;
  /** SPDX id when different from the core license (e.g. "AGPL-3.0-only") */
  license?: string;
}

export interface LeanRunInput {
  agentId: string;
  title: string;
  /** the customer message / question; the module's JSON output instructions go here too */
  prompt: string;
  /** module data for this turn (conversation tail, customer profile…), already filtered by scopes */
  moduleContext?: string;
  /** absolute image paths (only used if the agent's runtime supports images) */
  images?: string[];
  priority?: number;
  meta?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LeanRunResult {
  ok: boolean;
  output: string;
  taskId: number;
  runId: number | null;
  error?: string;
  usage?: Usage;
}

export interface ModuleContext {
  id: string;
  manifest: ModuleManifest;
  /** absolute modules/<id> */
  dir: string;
  /** absolute data/modules/<id> (created on demand) for media, sessions, caches */
  dataDir: string;
  /** shared SQLite handle; touch only your own tables */
  db: DB;
  log: Logger;

  tasks: {
    /** source is forced to 'module:<id>' */
    create(input: Omit<CreateTaskInput, 'source'>): Task;
    get(id: number): Task | undefined;
    cancel(id: number): void;
  };
  agents: {
    list(): AgentConfig[];
    get(id: string): AgentConfig | undefined;
    /** create a lean Task (source module:<id>) and wait for it — still goes through the engine */
    runLean(input: LeanRunInput): Promise<LeanRunResult>;
  };
  access: {
    /** scope of THIS module, e.g. can('sales-a', 'reply.send') */
    can(agentId: string, scope: string): boolean;
    /** scope of another module */
    canIn(moduleId: string, agentId: string, scope: string): boolean;
  };
  connections: {
    composio(): Promise<Composio>;
    secret(name: string): string | undefined;
    has(idOrType: string): boolean;
  };
  memory: {
    add(input: { content: string; agentId: string | null; pinned?: boolean }): Memory;
    recall(agentId: string, query: string, limit?: number): Memory[];
  };
  brain: {
    search(query: string, opts?: { folders?: string[]; limit?: number }): BrainHit[];
  };
  settings: {
    get<T = unknown>(key: string, fallback?: T): T;
    set(key: string, value: unknown): void;
    all(): Record<string, unknown>;
  };
  schedule: {
    /** run fn every intervalMs (number) or on a cron expression (string); returns a stop function. Stopped on Remove. */
    every(name: string, when: number | string, fn: () => void | Promise<void>): () => void;
  };
  events: {
    /** emits {type:'custom', name:'<id>:<event>'} to the bus/SSE */
    emit(event: string, payload: unknown): void;
    on(event: string, handler: (payload: unknown) => void): () => void;
  };
  audit: {
    log(action: string, target?: string | null, detail?: Record<string, unknown>, actor?: string): void;
  };
  attention: {
    raise(item: { key: string; title: string; detail?: string; link?: string; severity?: 'info' | 'warn' | 'error'; taskId?: number }): void;
    resolve(key: string): void;
  };
  modules: {
    /** `provides` object of another ENABLED module, or undefined */
    get<T = Record<string, unknown>>(id: string): T | undefined;
    isEnabled(id: string): boolean;
  };
  outbound: {
    /** strip secrets/paths/markup from text before it leaves the system (Zalo, email, Facebook) */
    sanitize(text: string): string;
  };
  crypto: {
    encrypt(plain: string): string;
    decrypt(value: string): string;
  };
}

/**
 * An action agents can call from their final answer:
 *   <aios-action module="<id>" name="<name>">{ ...json payload... }</aios-action>
 * The engine checks the agent holds `scope` for this module, runs the handler, and records the result
 * (task comment + audit). Agents never get shell or API tokens for this.
 */
export interface ModuleAction {
  scope: string;
  /** Vietnamese, shown to agents in their system prompt */
  description: string;
  example?: unknown;
  handler(payload: unknown, call: { agentId: string; taskId: number; runId: number | null }, ctx: ModuleContext): unknown | Promise<unknown>;
}

export interface ModuleDefinition {
  /** mount routes on a Hono sub-app served at /api/m/<id> */
  routes?(app: Hono, ctx: ModuleContext): void;
  /** start workers/pollers/child processes; called on Add and on boot when enabled */
  start?(ctx: ModuleContext): void | Promise<void>;
  /** stop everything started in start(); called on Remove and on shutdown */
  stop?(ctx: ModuleContext): void | Promise<void>;
  /** called for every finished task whose source is 'module:<id>' */
  onTaskFinished?(task: Task, run: Run | null, ctx: ModuleContext): void | Promise<void>;
  /** extra context for this module's lean tasks (in addition to LeanRunInput.moduleContext) */
  contextFor?(task: Task, ctx: ModuleContext): string | Promise<string>;
  /** services exposed to other modules via ctx.modules.get('<id>') */
  provides?(ctx: ModuleContext): Record<string, unknown>;
  /** code migrations after the SQL files (rarely needed) */
  migrate?(ctx: ModuleContext): void;
  /** actions agents can call with <aios-action> (keyed by action name, e.g. 'content.add') */
  actions?: Record<string, ModuleAction>;
  /**
   * Short data block (≤ ~3000 chars) added to ANY run of an agent that holds at least one scope of this module
   * (chat, normal tasks, lean tasks), e.g. page list + latest insights for marketing. Filter by `scopes`.
   */
  agentContext?(input: { agent: AgentConfig; task: Task; scopes: string[] }, ctx: ModuleContext): string | undefined | Promise<string | undefined>;
}

export function defineModule(def: ModuleDefinition): ModuleDefinition {
  return def;
}
