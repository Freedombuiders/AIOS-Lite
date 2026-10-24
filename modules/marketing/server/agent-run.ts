// One lean agent turn through the module SDK (access, runs and cost are handled by the engine).
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

export async function runLeanTurn(input: LeanTurnInput): Promise<LeanTurnResult> {
  const ctx = requireRuntime();
  try {
    const r = await ctx.agents.runLean({
      agentId: input.agentId,
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
