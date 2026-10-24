// Module manager contract (core side of the module system).
import type { Hono } from 'hono';
import type { ModuleState } from '../core/types.js';
import type { ModuleManifest } from './sdk.js';

export interface ModuleRequirement {
  kind: 'module' | 'connection';
  id: string;
  ok: boolean;
  message: string;
}

export interface ModuleInfo {
  manifest: ModuleManifest;
  state: ModuleState;
  requirements: ModuleRequirement[];
  /** all requirements ok */
  ready: boolean;
  hasServer: boolean;
  hasWeb: boolean;
  /** agent template ids shipped by the module */
  agentTemplates: string[];
  /** last start() error, if any */
  error?: string;
}

export interface AddOptions {
  /** copy agent templates into agents/ (skips ids that already exist) */
  installAgents?: boolean;
}

export interface AddResult {
  module: ModuleInfo;
  migrationsApplied: string[];
  agentsInstalled: string[];
}

export interface ModuleManager {
  /** scan modules/ (folders starting with '_' are templates, not listed) */
  discover(): ModuleInfo[];
  list(): ModuleInfo[];
  get(id: string): ModuleInfo | undefined;
  add(id: string, opts?: AddOptions): Promise<AddResult>;
  /** disable: stop(), hide routes/nav, KEEP data */
  remove(id: string): Promise<ModuleInfo>;
  /** drop the module's declared tables + data dir; `confirm` must equal the module id */
  purge(id: string, confirm: string): Promise<void>;
  isEnabled(id: string): boolean;
  provides<T = Record<string, unknown>>(id: string): T | undefined;
  /** mount /api/m/:id/* on the app, returning 404 for disabled modules */
  mount(app: Hono): void;
  /** boot: load + start every enabled module */
  start(): Promise<void>;
  stop(): Promise<void>;
  settings(id: string): Record<string, unknown>;
  updateSettings(id: string, patch: Record<string, unknown>): Record<string, unknown>;
}
