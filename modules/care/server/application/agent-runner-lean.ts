/**
 * `AgentRunner` on top of the core's lean turns (`ctx.agents.runLean`).
 *
 * A lean turn is one stateless model call with no tools, no MCP, no hooks and no session, and it still goes through
 * the Engine (permissions, run record, cost). That is exactly the boundary the care agent turn demands, so the
 * boundary is reported as enforced. The JSON output contract ({action, text, ...}) is parsed and validated by
 * the turn (agent-output.ts), never here.
 */
import type { ModuleContext } from '../../../../src/modules/sdk.js';
import { AgentRunnerError, type AgentRunner, type AgentRunOutput, type AgentRunRequest, type AgentToolBoundary, type BoundaryReport } from './agent-ports.js';

type LeanContext = { agents: Pick<ModuleContext['agents'], 'runLean' | 'get'> };

export function createLeanAgentRunner(ctx: LeanContext): AgentRunner {
  return {
    verifyBoundary(boundary: AgentToolBoundary, c?: { agentId: string }): BoundaryReport {
      if (boundary.allowedTools.length !== 0 || boundary.mcpServers !== 'none' || boundary.hooks !== 'none') {
        return { enforced: false, unenforceable: ['boundary_not_empty'] };
      }
      if (c?.agentId && !ctx.agents.get(c.agentId)) return { enforced: false, unenforceable: [`agent_unresolvable:${c.agentId.slice(0, 40)}`] };
      return { enforced: true };
    },
    async run(req: AgentRunRequest): Promise<AgentRunOutput> {
      if (req.signal.aborted) throw new AgentRunnerError('aborted', 'aborted before start');
      const result = await ctx.agents.runLean({
        agentId: req.agentId,
        title: 'Trả lời khách (CSKH)',
        prompt: req.prompt,
        timeoutMs: req.timeoutMs,
        signal: req.signal,
        meta: { runId: req.runId },
      });
      if (req.signal.aborted) throw new AgentRunnerError('aborted', 'aborted');
      if (!result.ok) {
        const timedOut = /timeout|timed out|hết thời gian/i.test(result.error ?? '');
        throw new AgentRunnerError(timedOut ? 'timeout' : 'runner_error', (result.error ?? 'lean run failed').slice(0, 300));
      }
      return {
        text: result.output,
        ...(result.usage ? { costUsd: costOf(result.usage), costSource: 'provider' as const } : {}),
      };
    },
  };
}

function costOf(usage: { costUsd?: number }): number {
  const n = usage.costUsd ?? 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
