// Provider config of the upstream engine API (AgentTurnInput.provider in agent-engine.ts). AIOS-Lite runs every module
// turn on the agent's own runtime (GenBot) through ModuleContext.runLean, so the provider is only carried along.
export type ProviderType = 'harness' | 'claude' | 'openai' | 'anthropic-compatible' | 'openrouter' | 'gemini' | 'opencode';
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
