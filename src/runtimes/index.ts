// Runtime registry: the GenBot HTTP adapter, plus the mock (tests and AIOS_MOCK=1).
import type { AgentRuntime, RuntimeId } from '../core/types.js';
import { runtimeLabel } from '../core/runtime-policy.js';
import { createGenbotRuntime } from './genbot.js';
import type { CreateRuntimeRegistry, Runtime, RuntimeRegistry, RuntimeRegistryOptions } from './contracts.js';
import { createMockRuntime } from './mock.js';

export const createRuntimeRegistry: CreateRuntimeRegistry = (opts: RuntimeRegistryOptions = {}): RuntimeRegistry => {
  const map = new Map<RuntimeId, Runtime>();
  for (const rt of [createGenbotRuntime(opts.genbot), createMockRuntime()]) map.set(rt.id, rt);
  const find = (id: AgentRuntime | string) => map.get(id as RuntimeId);
  return {
    get(id) {
      const rt = find(id);
      if (!rt) throw new Error(`Runtime không tồn tại: ${runtimeLabel(id)}`);
      return rt;
    },
    find,
    list: () => [...map.values()],
    register(runtime) {
      map.set(runtime.id, runtime);
    },
  };
};

export type { CreateRuntimeRegistry } from './contracts.js';
