import { getDeps } from './state.js';

export type ProviderType = 'harness' | 'claude' | 'acp' | 'opencode' | 'gemini' | 'acp-codex' | 'openrouter' | 'openai' | 'anthropic-compatible' | 'hermes-gateway';
export type ProviderRuntimeMode = string;
export type ProviderThinkingMode = string;
export interface OpenAiCompatEndpoint {
  baseUrl: string;
  apiKeyEnv?: string;
  model?: string;
}

export interface ProviderConfig {
  type: ProviderType;
  model?: string;
  runtimeMode?: ProviderRuntimeMode;
  thinkingMode?: ProviderThinkingMode;
  command?: string;
  args?: string[];
  baseUrl?: string;
  endpoint?: OpenAiCompatEndpoint;
  dangerouslySkipPermissions?: boolean;
}

export const DEFAULT_PROVIDER: ProviderConfig = { type: 'claude' };

const BY_RUNTIME: Record<string, ProviderType> = { claude: 'claude', codex: 'acp-codex', grok: 'harness', hermes: 'hermes-gateway', mock: 'harness' };

/** Provider of the "main" agent, derived from its AIOS-Lite runtime. */
export function getMainProviderConfig(): ProviderConfig {
  const main = getDeps().agents.get('main');
  if (!main) return { ...DEFAULT_PROVIDER };
  return { type: BY_RUNTIME[main.runtime] ?? 'claude', ...(main.model ? { model: main.model } : {}) };
}

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';

export function defaultModelForProvider(provider: ProviderConfig, claudeDefault: string = DEFAULT_CLAUDE_MODEL): string | undefined {
  if (provider.model) return provider.model;
  if (provider.endpoint?.model) return provider.endpoint.model;
  return provider.type === 'claude' ? claudeDefault : undefined;
}

const RUNNABLE: ReadonlySet<ProviderType> = new Set(['harness', 'claude', 'acp-codex', 'hermes-gateway']);

/** Which provider types AIOS-Lite can run (through its four CLI runtimes). */
export function providerRunnable(type: ProviderType): boolean {
  return RUNNABLE.has(type);
}
