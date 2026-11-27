// Which agent runtimes Open AgenticOS offers. Product decision 27/11: every agent is a GenBot bot. The other adapters
// (claude, codex, grok, hermes) stay in the code but are never offered: not listed for the UI, refused when an agent is
// created or changed to them, and an existing agent on one of them does not run (src/work/engine.ts).
// 'mock' is allowed only under tests (NODE_ENV=test / VITEST) or in mock mode (AIOS_MOCK=1).
import type { RuntimeId } from './types.js';

export const DEFAULT_ALLOWED_RUNTIMES: readonly RuntimeId[] = ['genbot'];

type Env = Record<string, string | undefined>;

/** Tests or mock mode: the only cases where the 'mock' runtime may be used. */
export function mockRuntimeAllowed(env: Env = process.env): boolean {
  return env.NODE_ENV === 'test' || env.VITEST === 'true' || env.AIOS_MOCK === '1';
}

/** The single setting: runtimes an agent may use. Default ['genbot'], plus 'mock' under tests or mock mode. */
export function allowedRuntimes(env: Env = process.env): RuntimeId[] {
  return mockRuntimeAllowed(env) ? [...DEFAULT_ALLOWED_RUNTIMES, 'mock'] : [...DEFAULT_ALLOWED_RUNTIMES];
}

export function isRuntimeAllowed(runtime: string, allowed: readonly string[] = allowedRuntimes()): boolean {
  return allowed.includes(runtime);
}

const LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok', hermes: 'Hermes', mock: 'Mock' };

/** Refusal when an agent is created or changed to a runtime that is not offered. */
export function runtimeRefusal(runtime: string): string {
  return `Runtime "${LABEL[runtime] ?? runtime}" không còn được dùng: Open AgenticOS chỉ chạy agent bằng GenBot. Hãy chọn runtime genbot (thêm bot ở màn Đội AI · Bot).`;
}

/** Why an existing agent on a legacy runtime does not run. */
export function legacyRuntimeMessage(agentName: string, runtime: string): string {
  return `Agent ${agentName} đang dùng ${LABEL[runtime] ?? runtime}, hãy chuyển sang GenBot. Open AgenticOS chỉ chạy agent bằng GenBot; mở Đội AI · Bot hoặc trang Agents và bấm "Chuyển sang GenBot".`;
}

export class RuntimeNotAllowedError extends Error {
  constructor(readonly runtime: string) {
    super(runtimeRefusal(runtime));
    this.name = 'RuntimeNotAllowedError';
  }
}
