// One lean agent turn through the module SDK (access, runs and cost are handled by the engine).
import type { ModuleContext } from '../../../src/modules/sdk.js';
import { requireRuntime } from './runtime.js';

export interface LeanTurnInput {
  agentId: string;
  title: string;
  prompt: string;
  moduleContext?: string;
  timeoutMs: number;
  meta?: Record<string, unknown>;
}

export interface LeanTurnResult {
  text: string;
  costUsd: number;
  error?: string;
}

/**
 * Marketing settings and rules store 'main' for "the default agent" (code ported from ClaudeClaw). The old sample agent
 * main is gone (G3): unless an agent really has that id, the alias runs on the workspace's default bot (the Trợ lý bot,
 * else the first GenBot bot with a key: src/agents/default-agent.ts).
 */
export const DEFAULT_AGENT_ALIAS = 'main';

export function resolveAgentAlias(ctx: Pick<ModuleContext, 'agents'>, agentId: string): string {
  if (agentId !== DEFAULT_AGENT_ALIAS || ctx.agents.get(agentId)) return agentId;
  return ctx.agents.defaultId?.() ?? agentId;
}

export async function runLeanTurn(input: LeanTurnInput): Promise<LeanTurnResult> {
  const ctx = requireRuntime();
  try {
    const r = await ctx.agents.runLean({
      agentId: resolveAgentAlias(ctx, input.agentId),
      title: input.title,
      prompt: input.prompt,
      moduleContext: input.moduleContext,
      timeoutMs: input.timeoutMs,
      meta: input.meta,
    });
    return { text: r.output ?? '', costUsd: r.usage?.costUsd ?? 0, ...(r.ok ? {} : { error: r.error ?? 'Agent không trả lời được.' }) };
  } catch (err) {
    return { text: '', costUsd: 0, error: String((err as Error)?.message ?? err) };
  }
}
