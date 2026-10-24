// Types of upstream agent-engine/types.ts and EngineFactory (agent-engine/index.ts), backed by ModuleContext.runLean.
import type { Usage } from '../../core/types.js';
import { moduleCompat, getDeps } from './state.js';
import type { LeanRunResult } from '../sdk.js';
import type { ProviderConfig } from './provider.js';

export interface AgentEngineUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  contextTokens?: number;
  costUsd?: number | null;
  [k: string]: unknown;
}

export interface AgentEngineProgressEvent {
  kind?: string;
  message?: string;
  [k: string]: unknown;
}

export interface AgentEngineErrorClassification {
  errorKind?: 'auth' | 'quota' | 'transient' | 'config' | 'refusal' | 'timeout' | 'unknown';
  retryable?: boolean;
  message?: string;
}

export type AgentEngineEvent =
  | { type: 'session'; sessionId: string; raw?: unknown }
  | { type: 'text_delta'; delta: string; accumulatedText: string; raw?: unknown }
  | { type: 'progress'; progress: AgentEngineProgressEvent; raw?: unknown }
  | { type: 'usage'; usage: AgentEngineUsage; raw?: unknown }
  | { type: 'compact'; preCompactTokens: number | null; trigger?: string; raw?: unknown }
  | ({ type: 'result'; text: string | null; usage: AgentEngineUsage | null; stopReason?: string; raw?: unknown } & AgentEngineErrorClassification)
  | { type: 'aborted'; text: string | null; sessionId?: string; usage: AgentEngineUsage | null; raw?: unknown }
  | ({ type: 'error'; error: unknown; raw?: unknown } & AgentEngineErrorClassification);

export interface AgentTurnInput {
  codexAuthMode?: 'chatgpt';
  hostTask?: 'video-create' | 'video-produce';
  harnessPlugins?: Array<{ id: string; entry: string; entryName?: string; files?: Record<string, string>; config: Record<string, unknown> }>;
  skillAgentId?: string;
  skillRestrictions?: boolean;
  skillPolicyFingerprint?: string;
  disabledSkillPaths?: string[];
  prompt: string;
  provider: ProviderConfig;
  sessionId?: string;
  cwd: string;
  model?: string;
  runtimeMode?: string;
  thinkingMode?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens?: number } | { type: 'disabled' };
  maxTurns?: number;
  maxBudgetUsd?: number;
  permissionMode?: 'default' | 'bypassPermissions' | string;
  allowDangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: string[];
  skills?: string[];
  baseInstructions?: string;
  abortSignal?: AbortSignal;
  signal?: AbortSignal;
  /** AIOS-Lite extras */
  agentId?: string;
  moduleContext?: string;
  images?: string[];
  [extra: string]: unknown;
}

export interface AgentEngine {
  invoke(input: AgentTurnInput): AsyncIterable<AgentEngineEvent>;
}

const toUsage = (u?: Usage): AgentEngineUsage | null =>
  u ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cachedInputTokens, costUsd: u.costUsd ?? null } : null;

/** Each turn is a lean Task through the Engine (so access, runs and cost still apply). */
class LeanEngine implements AgentEngine {
  async *invoke(input: AgentTurnInput): AsyncGenerator<AgentEngineEvent> {
    const agentId = input.agentId ?? input.skillAgentId ?? 'main';
    const run = (): Promise<LeanRunResult> => {
      const arg = {
        agentId,
        title: input.prompt.slice(0, 80),
        prompt: input.prompt,
        moduleContext: input.moduleContext,
        images: input.images,
        signal: input.signal ?? input.abortSignal,
      };
      const ctx = input.moduleId ? moduleCompat(String(input.moduleId)) : undefined;
      if (ctx) return ctx.agents.runLean(arg);
      // no module bound: create the task directly under a shared source
      const deps = getDeps();
      const task = deps.tasks.create({ agentId, title: arg.title, prompt: arg.prompt, contextProfile: 'lean', trigger: 'module', source: 'module:compat', meta: { moduleContext: arg.moduleContext, images: arg.images } });
      return deps.tasks.waitFor(task.id, { timeoutMs: deps.config.runTimeoutMs, signal: arg.signal }).then((done) => {
        const r = deps.runs.list({ taskId: task.id, limit: 20 }).sort((a, b) => b.id - a.id)[0];
        const ok = done.status === 'done' || done.status === 'review';
        const usage: Usage = { ...(r?.inputTokens != null ? { inputTokens: r.inputTokens } : {}), ...(r?.outputTokens != null ? { outputTokens: r.outputTokens } : {}), ...(r?.costUsd != null ? { costUsd: r.costUsd } : {}) };
        return { ok, output: r?.output ?? done.result ?? '', taskId: task.id, runId: r?.id ?? null, ...(Object.keys(usage).length ? { usage } : {}), ...(ok ? {} : { error: r?.error ?? done.error ?? done.status }) };
      }, (err: Error) => ({ ok: false, output: '', taskId: task.id, runId: null, error: err.message }));
    };
    yield { type: 'progress', progress: { kind: 'start', message: `agent ${agentId}` } };
    let r: LeanRunResult;
    try {
      r = await run();
    } catch (error) {
      yield { type: 'error', error, errorKind: 'unknown', retryable: false, message: error instanceof Error ? error.message : String(error) };
      return;
    }
    if (!r.ok) {
      yield { type: 'error', error: new Error(r.error ?? 'Lượt chạy thất bại'), errorKind: 'unknown', retryable: false, message: r.error };
      return;
    }
    yield { type: 'text_delta', delta: r.output, accumulatedText: r.output };
    yield { type: 'result', text: r.output, usage: toUsage(r.usage) };
  }
}

export class EngineFactory {
  static forProvider(_provider: ProviderConfig): AgentEngine {
    return new LeanEngine();
  }
}
