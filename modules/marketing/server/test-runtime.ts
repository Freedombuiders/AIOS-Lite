// Fake module context for unit tests: agents.runLean, access, settings and attention are in-memory.
import type { LeanRunInput, LeanRunResult, ModuleContext } from '../../../src/modules/sdk.js';
import { setRuntime } from './runtime.js';

export interface FakeRuntimeOptions {
  runLean?: (input: LeanRunInput) => Promise<LeanRunResult> | LeanRunResult;
  can?: (agentId: string, scope: string) => boolean;
  settings?: Record<string, unknown>;
  models?: Record<string, string>;
}

export interface FakeRuntime {
  ctx: ModuleContext;
  leanCalls: LeanRunInput[];
  raised: Array<{ key: string; title: string; detail?: string; severity?: string; link?: string }>;
  settings: Record<string, unknown>;
}

export function bindFakeRuntime(opts: FakeRuntimeOptions = {}): FakeRuntime {
  const leanCalls: LeanRunInput[] = [];
  const raised: FakeRuntime['raised'] = [];
  const settings = { ...(opts.settings ?? {}) };
  const ctx = {
    id: 'marketing',
    agents: {
      list: () => [],
      get: (id: string) => (opts.models?.[id] ? { id, model: opts.models[id] } : undefined),
      runLean: async (input: LeanRunInput) => {
        leanCalls.push(input);
        return opts.runLean ? opts.runLean(input) : { ok: true, output: '', taskId: 1, runId: 1 };
      },
    },
    access: { can: opts.can ?? (() => true), canIn: () => true },
    settings: {
      get: (key: string, fallback?: unknown) => (key in settings ? settings[key] : fallback),
      set: (key: string, value: unknown) => { settings[key] = value; },
      all: () => settings,
    },
    attention: { raise: (item: FakeRuntime['raised'][number]) => { raised.push(item); }, resolve: () => {} },
    outbound: { sanitize: (text: string) => text.trim() },
    connections: { secret: () => undefined, has: () => false },
  } as unknown as ModuleContext;
  setRuntime(ctx);
  return { ctx, leanCalls, raised, settings };
}

export function unbindFakeRuntime(): void {
  setRuntime(null);
}
