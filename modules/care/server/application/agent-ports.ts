/**
 * Ports and boundary constants for the Care agent turn (CC-10).
 *
 * The turn never talks to a model, a provider SDK or a sender directly. It is given:
 *  - an `AgentRunner`  (CC-later wires EngineFactory behind it; tests use a fake), and
 *  - a `DraftSink`     (CC-11 implements it; the turn only PROPOSES a draft).
 * There is deliberately no send port here: the agent turn cannot send.
 */

import type { CareChannel } from '../../../_lib/care-kit/types.js';
import type { DeliveryAdjustment } from '../policy/eligibility.js';
import type { AutoDelayRange } from '../policy/policy-ext.js';

/** The model may call NO tools: the allowlist is empty and enforced by the runner wrapper. */
export const AGENT_TOOL_ALLOWLIST: readonly string[] = Object.freeze([] as string[]);

/** Defense in depth: names that must never be reachable even if an allowlist were misconfigured. */
export const AGENT_DENIED_TOOLS: readonly string[] = Object.freeze([
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'KillShell',
  'Skill',
  'Task',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'ExitPlanMode',
  'Read',
  'Grep',
  'Glob',
  'LS',
  'Agent',
  'BashOutput',
  'SlashCommand',
  'AskUserQuestion',
  'EnterPlanMode',
  'TodoRead',
  'ListMcpResources',
  'ReadMcpResource',
  'mcp__*',
  'hook:*',
  'care_send',
  'send_message',
  'customer_send',
]);

export interface AgentToolBoundary {
  /** Always empty: no MCP, hook, Bash, Write, Read or customer-send tool. */
  readonly allowedTools: readonly string[];
  readonly deniedTools: readonly string[];
  readonly mcpServers: 'none';
  readonly hooks: 'none';
  /** No user/project settings reach the turn. */
  readonly settingSources: readonly [];
  /** A fresh session per turn; the context is resent, never resumed. */
  readonly session: 'stateless';
}

export function createAgentBoundary(): AgentToolBoundary {
  return Object.freeze({
    allowedTools: AGENT_TOOL_ALLOWLIST,
    deniedTools: AGENT_DENIED_TOOLS,
    mcpServers: 'none',
    hooks: 'none',
    settingSources: Object.freeze([]) as readonly [],
    session: 'stateless',
  });
}

export interface BoundaryReport {
  /** True only when the wrapper enforces the boundary in code (not merely in the prompt). */
  enforced: boolean;
  /** Which parts of the boundary the wrapper cannot enforce. */
  unenforceable?: readonly string[];
}

export interface AgentRunRequest {
  runId: string;
  agentId: string;
  prompt: string;
  boundary: AgentToolBoundary;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface AgentRunOutput {
  /** The model's final text. Treated as untrusted until parsed and sanitized. */
  text: string;
  /** Names of every tool the model tried to use. Any entry is a violation (the allowlist is empty). */
  toolCalls?: readonly string[];
  costUsd?: number;
  costSource?: 'placeholder' | 'provider';
}

export type AgentRunnerErrorCode = 'timeout' | 'aborted' | 'runner_error';

export class AgentRunnerError extends Error {
  constructor(
    public readonly code: AgentRunnerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentRunnerError';
  }
}

export interface AgentRunner {
  /** Can this runner enforce `boundary` itself? If not, the turn refuses to run. */
  verifyBoundary(boundary: AgentToolBoundary, ctx?: { agentId: string }): BoundaryReport | Promise<BoundaryReport>;
  run(request: AgentRunRequest): Promise<AgentRunOutput>;
}

export interface DraftProposal {
  /** Same as `runId`; the sink must be idempotent on it (a crashed turn may propose twice). */
  idempotencyKey: string;
  runId: string;
  /** ALWAYS the originating conversation/account/channel; model output cannot change it. */
  target: { accountId: string; conversationId: string; channel: CareChannel };
  triggerMessageId: string;
  contextRevision: number;
  policyRevision: string;
  agentId: string;
  origin: 'agent';
  /** Sanitized reply body, without signature. */
  text: string;
  /** One entry per answered message (group chats address each asker). `replyToMessageId` is local. */
  replies: Array<{ replyToMessageId: string | null; text: string }>;
  /** Append exactly once when the draft is composed (never duplicated if the text already ends with it). */
  signature: string | null;
  needsReview: boolean;
  reviewReason: string | null;
  delivery: {
    requested: 'draft' | 'auto';
    effective: 'draft' | 'auto';
    adjustment: DeliveryAdjustment | null;
    /** Only meaningful when effective is 'auto'. */
    autoDelay: AutoDelayRange | null;
    reasonCodes: string[];
  };
}

export interface DraftSink {
  propose(proposal: DraftProposal): Promise<{ draftRef: string }> | { draftRef: string };
}
