// Runtime registry: one adapter per CLI plus the mock.
import type { RuntimeId } from '../core/types.js';
import { createClaudeRuntime } from './claude.js';
import { createCodexRuntime } from './codex.js';
import type { CreateRuntimeRegistry, Runtime, RuntimeRegistry, RuntimeRegistryOptions } from './contracts.js';
import { createGrokRuntime } from './grok.js';
import { createHermesRuntime } from './hermes.js';
import { createMockRuntime } from './mock.js';

export const createRuntimeRegistry: CreateRuntimeRegistry = (opts: RuntimeRegistryOptions = {}): RuntimeRegistry => {
  const cmd = opts.commands ?? {};
  const env = opts.env;
  const map = new Map<RuntimeId, Runtime>();
  for (const rt of [createClaudeRuntime(cmd.claude, env), createCodexRuntime(cmd.codex, env), createGrokRuntime(cmd.grok, env), createHermesRuntime(cmd.hermes, env), createMockRuntime()]) map.set(rt.id, rt);
  return {
    get(id) {
      const rt = map.get(id);
      if (!rt) throw new Error(`Runtime không tồn tại: ${id}`);
      return rt;
    },
    list: () => [...map.values()],
    register(runtime) {
      map.set(runtime.id, runtime);
    },
  };
};

export type { CreateRuntimeRegistry } from './contracts.js';
