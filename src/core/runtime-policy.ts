// Which engines run agents. Product decision 27/11: every agent is a GenBot bot; G3 deleted the other adapters.
// 'mock' is allowed only under tests (NODE_ENV=test / VITEST) or in mock mode (AIOS_MOCK=1).
// An agent.yaml written by an earlier version may still name an old engine: it loads, never runs, and raises
// the attention item below until the owner moves it to GenBot. AIOS never rewrites or deletes that file.
import { RUNTIME_IDS, type RuntimeId } from './types.js';

/** Engines of earlier versions that an agent.yaml may still name. They no longer exist in the code. */
export const LEGACY_RUNTIME_IDS = ['claude', 'codex', 'grok', 'hermes'] as const;
export type LegacyRuntimeId = (typeof LEGACY_RUNTIME_IDS)[number];

const LEGACY_LABEL: Record<LegacyRuntimeId, string> = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok', hermes: 'Hermes' };

export function isLegacyRuntime(runtime: string): runtime is LegacyRuntimeId {
  return (LEGACY_RUNTIME_IDS as readonly string[]).includes(runtime);
}

/** Every name an agent.yaml may carry: current runtimes and legacy ones (which load but never run). */
export const KNOWN_RUNTIME_NAMES: readonly string[] = [...RUNTIME_IDS, ...LEGACY_RUNTIME_IDS];

export function isKnownRuntime(runtime: string): boolean {
  return KNOWN_RUNTIME_NAMES.includes(runtime);
}

/** Display name of a runtime id, old or current. */
export function runtimeLabel(runtime: string): string {
  if (isLegacyRuntime(runtime)) return LEGACY_LABEL[runtime];
  return runtime === 'genbot' ? 'GenBot' : runtime === 'mock' ? 'Mock' : runtime;
}

type Env = Record<string, string | undefined>;

/** Tests or mock mode: the only cases where the 'mock' runtime may be used. */
export function mockRuntimeAllowed(env: Env = process.env): boolean {
  return env.NODE_ENV === 'test' || env.VITEST === 'true' || env.AIOS_MOCK === '1';
}

/** Runtimes an agent may use: GenBot, plus 'mock' under tests or mock mode. */
export function allowedRuntimes(env: Env = process.env): RuntimeId[] {
  return mockRuntimeAllowed(env) ? ['genbot', 'mock'] : ['genbot'];
}

export function isRuntimeAllowed(runtime: string, allowed: readonly string[] = allowedRuntimes()): boolean {
  return allowed.includes(runtime);
}

/** Refusal when an agent is created or changed to a runtime that is not offered. */
export function runtimeRefusal(runtime: string): string {
  return `Runtime "${runtimeLabel(runtime)}" không còn được dùng: Open AgenticOS chỉ chạy agent bằng GenBot. Hãy chọn runtime genbot (thêm bot ở màn Đội AI · Bot).`;
}

/** Why an existing agent on a legacy runtime does not run (the attention item; its action is "Chuyển sang GenBot"). */
export function legacyRuntimeMessage(agentName: string, runtime: string): string {
  return `Agent ${agentName} đang dùng ${runtimeLabel(runtime)}, hãy chuyển sang GenBot. Open AgenticOS chỉ chạy agent bằng GenBot; mở Đội AI · Bot và bấm "Chuyển sang GenBot".`;
}

export class RuntimeNotAllowedError extends Error {
  constructor(readonly runtime: string) {
    super(runtimeRefusal(runtime));
    this.name = 'RuntimeNotAllowedError';
  }
}
