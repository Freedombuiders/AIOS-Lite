/**
 * One headless, read-only agent turn for the Analyst (daily explanation and
 * classification of imported posts). Same boundary as src/zalo/agent-turn.ts:
 * the agent's own provider and model, read-only tools, no MCP, no user or
 * project settings, no web, stateless. The agent only returns text (JSON);
 * code validates it and writes to the database.
 */

import { runLeanTurn } from '../agent-run.js';
import { getRuntime } from '../runtime.js';

export interface AgentTextResult {
  text: string;
  model: string;
  costUsd: number;
  error?: string;
}

export interface AgentTurnInput {
  agentId: string;
  /** Token usage bucket, e.g. `fbstudio:analyst:<pageId>`. */
  usageKey: string;
  system: string;
  prompt: string;
}

/** Injectable for tests; the default talks to the real engine. */
export type AgentRunner = (input: AgentTurnInput) => Promise<AgentTextResult>;

const TURN_TIMEOUT_MS = 180_000;

export const runAnalystAgent: AgentRunner = async (input) => {
  const prompt = [input.system, input.prompt].filter(Boolean).join('\n\n---\n\n');
  const r = await runLeanTurn({
    agentId: input.agentId,
    title: 'Phân tích Facebook',
    prompt,
    timeoutMs: TURN_TIMEOUT_MS,
    meta: { kind: 'fb-analyst', usageKey: input.usageKey },
  });
  const model = getRuntime()?.agents.get(input.agentId)?.model ?? input.agentId;
  return { text: r.text, model, costUsd: r.costUsd, ...(r.error ? { error: r.error } : {}) };
};
