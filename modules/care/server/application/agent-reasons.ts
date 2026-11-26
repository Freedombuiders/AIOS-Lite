/**
 * Every `skip_reason` an agent turn writes on a run that did not draft, besides the eligibility reasons
 * (policy/eligibility.ts ELIGIBILITY_REASONS, which include the message gates). The agent turn types its `skip()`,
 * `fail()` and `finishSkip()` reasons with these two lists, so a new reason does not compile until it is listed here,
 * and the web test (T07) fails until the inbox has a Vietnamese line for it.
 * Pure data.
 */

export const AGENT_TURN_REASONS = [
  'conversation_taken_over', // the owner (or a customer handoff) holds the conversation
  'ai_mode_off', // the owner switched the bot off for this conversation
  'assignment_conflict', // two rules tie: the resolver never picks between equals
  'trigger_not_found', // the message that triggered the run is gone
  'agent_scope_missing', // the agent lacks reply.draft
  'boundary_unverifiable', // the runtime could not prove the empty tool allowlist
  'boundary_unenforced', // the runtime cannot enforce the empty tool allowlist
  'prompt_too_long', // the prompt does not fit the runtime limit
  'media_needs_owner', // only an image / PDF the bot cannot read
  'timeout', // the model did not answer in time
  'runner_error', // the runtime failed
  'restricted_tool_use', // the model tried to use a tool
  'invalid_output', // the answer was not the JSON the module expects
  'agent_skip', // the agent chose not to answer
  'agent_handoff_suggested', // the agent suggested handing over to a person
  'draft_sink_error', // the draft could not be saved
] as const;

export type AgentTurnReason = (typeof AGENT_TURN_REASONS)[number];
