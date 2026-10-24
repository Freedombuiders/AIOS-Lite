// Test double of the module context: just what the video module touches. No real agents, no network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentConfig } from '../../../src/core/types.js';
import type { LeanRunInput, LeanRunResult, ModuleContext, ModuleManifest } from '../../../src/modules/sdk.js';

export interface FakeCtxOptions {
  agents?: Partial<AgentConfig>[];
  runLean?: (input: LeanRunInput) => Promise<LeanRunResult> | LeanRunResult;
  settings?: Record<string, unknown>;
  modules?: Record<string, Record<string, unknown>>;
  /** agentId -> scopes granted on the video module */
  grants?: Record<string, string[]>;
  dir?: string;
  dataDir?: string;
}

export type FakeCtx = ModuleContext & {
  emitted: { event: string; payload: unknown }[];
  raised: { key: string; title: string }[];
  resolved: string[];
  leanCalls: LeanRunInput[];
  cleanup(): void;
};

const here = path.dirname(new URL(import.meta.url).pathname);

export function fakeCtx(opts: FakeCtxOptions = {}): FakeCtx {
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'video-module-'));
  const agents = (opts.agents ?? [{ id: 'main', runtime: 'claude' }]).map((a) => ({
    name: a.id, description: '', runtimeOptions: {}, permission: 'safe', context: 'lean', canDelegate: false, maxConcurrent: 1, enabled: true,
    access: { brain: {}, memory: { team: false, private: false }, skills: [], connections: {}, modules: {} }, persona: '', dir: '', workspace: '', ...a,
  })) as AgentConfig[];
  const emitted: FakeCtx['emitted'] = [];
  const raised: FakeCtx['raised'] = [];
  const resolved: string[] = [];
  const leanCalls: LeanRunInput[] = [];
  const store = { ...(opts.settings ?? {}) };
  const stops: (() => void)[] = [];
  const ctx = {
    id: 'video',
    manifest: { id: 'video' } as ModuleManifest,
    dir: opts.dir ?? path.resolve(here, '..'),
    dataDir,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    agents: {
      list: () => agents,
      get: (id: string) => agents.find((a) => a.id === id),
      async runLean(input: LeanRunInput): Promise<LeanRunResult> {
        leanCalls.push(input);
        return opts.runLean ? opts.runLean(input) : { ok: true, output: 'ok', taskId: 1, runId: 1 };
      },
    },
    access: { can: (agentId: string, scope: string) => Boolean(opts.grants?.[agentId]?.includes(scope)), canIn: () => false },
    events: { emit: (event: string, payload: unknown) => emitted.push({ event, payload }), on: () => () => undefined },
    attention: { raise: (i: { key: string; title: string }) => raised.push(i), resolve: (k: string) => resolved.push(k) },
    settings: {
      get: <T,>(key: string, fallback?: T) => (key in store ? store[key] : fallback) as T,
      set: (key: string, value: unknown) => { store[key] = value; },
      all: () => ({ ...store }),
    },
    brain: { search: () => [] },
    schedule: { every: (_n: string, _w: unknown, _fn: unknown) => { const stop = () => undefined; stops.push(stop); return stop; } },
    modules: { get: (id: string) => opts.modules?.[id], isEnabled: (id: string) => Boolean(opts.modules?.[id]) },
    audit: { log() {} },
    connections: { secret: () => undefined, has: () => false },
    emitted, raised, resolved, leanCalls,
    cleanup() { fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
  return ctx as unknown as FakeCtx;
}
