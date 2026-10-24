/**
 * One headless agent turn for the Radar analyst, through ctx.agents.runLean (the engine still governs it).
 * Community text reaches the agent wrapped in <untrusted> tags; the agent only returns text (JSON), code validates it.
 */
import { requireContext } from './context.js';

export interface AgentTextResult {
  text: string;
  model: string;
  costUsd: number;
  error?: string;
}

export interface AgentTurnInput {
  agentId: string;
  /** usage label: `radar:<layer>:<step>` */
  usageKey: string;
  system: string;
  prompt: string;
}

/** Injectable for tests; the default goes through runLean. */
export type AgentRunner = (input: AgentTurnInput) => Promise<AgentTextResult>;

const TURN_TIMEOUT_MS = 300_000;

export const runRadarAgent: AgentRunner = async (input) => {
  const ctx = requireContext();
  const res = await ctx.agents.runLean({
    agentId: input.agentId,
    title: `Radar: ${input.usageKey}`,
    prompt: `${input.system}\n\n${input.prompt}`,
    meta: { usageKey: input.usageKey },
    timeoutMs: TURN_TIMEOUT_MS,
  });
  const costUsd = res.usage?.costUsd ?? 0;
  return { text: res.ok ? res.output : '', model: input.agentId, costUsd, ...(res.ok ? {} : { error: res.error ?? 'Agent không trả lời' }) };
};
