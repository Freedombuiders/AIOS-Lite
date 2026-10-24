/**
 * Deterministic, pure eligibility checks that run BEFORE any model call, context expansion,
 * summary or send. Same input => same `{eligible, reason}`; the first failing check names the
 * reason, in a fixed order (cheapest and most absolute first). No I/O, no clock, no randomness:
 * the caller injects `nowMs`, kill switches, usage counters and quiet-hours state.
 *
 * Actor / purpose matrix (what each check applies to):
 *   manual_care_reply    a person writes/asks for a draft: lifecycle + kill switches only.
 *                        "Turning AI off does not turn manual chat off": no AI switch on send.
 *   approved_care_draft  a person approved an existing draft: lifecycle + opt-out + staleness
 *                        (a stale reviewed draft needs review again) + provider cooldown/cap.
 *   auto_care_reply      system-initiated: everything (assignment, message gates, pause, human
 *                        reply, staleness, quotas, quiet hours).
 *   marketing            campaign: lifecycle + opt-out + consent + cooldown/cap + quiet hours.
 *
 * Telegram AI is hard-blocked server side (V1: disabled by design). It is checked first, for the
 * conversation's channel AND for the channel of any context-expansion source, at every AI step.
 */

import type { CareAccountRecord, CareChannel, CareConversationKind } from '../../../_lib/care-kit/types.js';
import type { EffectiveRuleResolution } from './assignment-resolver.js';
import { evaluateMessageGates, type GateMessage, type MessageGateInput, type MessageGateReason } from './message-gates.js';

export type CarePolicyActor = 'manual_care_reply' | 'approved_care_draft' | 'auto_care_reply' | 'marketing';
export type EligibilityStep = 'model_call' | 'context_expansion' | 'summary' | 'send';

export const ELIGIBILITY_REASONS = [
  'telegram_ai_blocked',
  'kill_switch_module',
  'kill_switch_ai',
  'kill_switch_auto_send',
  'account_inactive',
  'write_owner_not_core',
  'account_ai_disabled',
  'account_sync_disabled',
  'account_send_disabled',
  'account_unhealthy',
  'context_source_not_permitted',
  'no_assignment',
  'assignment_disabled',
  'observe_only',
  // message-level gates (message-gates.ts)
  'not_inbound',
  'not_live_origin',
  'not_customer_message',
  'trigger_deleted',
  'unsupported_type',
  'not_directed',
  'opted_out',
  'noise',
  'empty_body',
  'internal_sender',
  'own_address',
  'automated',
  'category_not_primary',
  'before_care_since',
  'stale_trigger',
  // conversation state
  'conversation_paused',
  'human_active',
  'stale_context',
  // limits
  'thread_quota',
  'agent_quota',
  'account_quota',
  'cooldown_active',
  'quiet_hours',
  'marketing_consent_missing',
] as const;

export type EligibilityReason = 'eligible' | (typeof ELIGIBILITY_REASONS)[number];

/** How an ELIGIBLE auto reply must be adjusted before delivery. */
export type DeliveryAdjustment =
  | { kind: 'to_draft'; cause: 'quiet_hours' | 'kill_switch_auto_send' }
  | { kind: 'defer'; cause: 'quiet_hours'; notBeforeMs: number | null };

export interface EligibilityResult {
  eligible: boolean;
  reason: EligibilityReason;
  /** Non-sensitive qualifier (kill-switch layer, matched category...). Never customer text. */
  detail?: string;
  adjustment?: DeliveryAdjustment;
}

export interface KillSwitchLayer {
  moduleEnabled?: boolean;
  aiEnabled?: boolean;
  autoSendEnabled?: boolean;
}

/** Layered switches: any layer that says `false` turns the capability off. Injected, never read here. */
export interface KillSwitchState {
  moduleEnabled: boolean;
  aiEnabled: boolean;
  autoSendEnabled: boolean;
  channels?: Partial<Record<CareChannel, KillSwitchLayer>>;
  accounts?: Record<string, KillSwitchLayer>;
}

export type KillSwitchKind = 'module' | 'ai' | 'auto_send';

/** Name of the first layer that has the switch off, or null when it is on everywhere. */
export function killSwitchOffLayer(state: KillSwitchState, kind: KillSwitchKind, channel: CareChannel, accountId: string): string | null {
  const key = kind === 'module' ? 'moduleEnabled' : kind === 'ai' ? 'aiEnabled' : 'autoSendEnabled';
  if (state[key] === false) return 'global';
  if (state.channels?.[channel]?.[key] === false) return `channel:${channel}`;
  if (state.accounts?.[accountId]?.[key] === false) return `account:${accountId}`;
  return null;
}

export type EligibilityAccount = Pick<
  CareAccountRecord,
  'id' | 'desiredState' | 'writeOwner' | 'aiEnabled' | 'syncEnabled' | 'sendEnabled' | 'healthStatus'
>;

export interface EligibilityConversation {
  kind: CareConversationKind;
  isPaused: boolean;
  pausedUntilMs: number | null;
  isOptedOut: boolean;
}

export interface EligibilityInput {
  nowMs: number;
  actor: CarePolicyActor;
  step: EligibilityStep;
  /**
   * Does AI authorship/processing take part? Defaults: true for every non-send step, true for
   * an auto reply or an approved draft (fail closed), false for manual replies and marketing.
   */
  aiInvolved?: boolean;
  channel: CareChannel;
  account: EligibilityAccount;
  conversation: EligibilityConversation;
  killSwitches: KillSwitchState;
  /** Effective assignment (auto and manual model steps). */
  resolution?: EffectiveRuleResolution | null;

  // auto-only facts
  burst?: readonly GateMessage[];
  messageGate?: Pick<
    MessageGateInput,
    'staleAfterMs' | 'notBeforeMs' | 'ownAddress' | 'internalIdentityKeys' | 'extraAutomatedPatterns'
  >;
  /** Newest self/operator reply (phone or dashboard) in the conversation. */
  lastHumanReplyAtMs?: number | null;
  /** Post-run recheck: a human reply at/after this instant means the person got there first. */
  humanRepliedSinceMs?: number | null;

  // freshness
  /** A newer message / context revision exists since the trigger the run was built for. */
  contextChanged?: boolean;
  /** Approved draft: its context or policy changed since it was reviewed. */
  draftStale?: boolean;

  // limits
  usage?: { threadRepliesToday?: number; agentRunsToday?: number; accountSendsToday?: number };
  limits?: { agentDailyReplyCap?: number | null; accountDailyCap?: number | null };
  cooldownUntilMs?: number | null;
  quietHours?: { active: boolean; endsAtMs?: number | null };
  marketingConsent?: boolean;

  /** context_expansion: where the extra context comes from and whether the source is permitted. */
  expansion?: { sourceChannel: CareChannel; permitted: boolean };
  /**
   * Telegram BOT group gate verdict (`connectors/telegram-bot/ai-gate.ts`), resolved by the caller for THIS conversation.
   * Only `allowed === true` lifts the Telegram AI block, and only for the conversation's own channel at a non-expansion
   * step. Absent => Telegram AI stays blocked, exactly as before the bot connector existed.
   */
  telegramBotAi?: { allowed: boolean };
}

const ok = (adjustment?: DeliveryAdjustment): EligibilityResult => ({
  eligible: true,
  reason: 'eligible',
  ...(adjustment ? { adjustment } : {}),
});
const deny = (reason: EligibilityReason, detail?: string): EligibilityResult => ({
  eligible: false,
  reason,
  ...(detail ? { detail } : {}),
});

function defaultAiInvolved(actor: CarePolicyActor, step: EligibilityStep): boolean {
  if (step !== 'send') return true;
  return actor === 'auto_care_reply' || actor === 'approved_care_draft';
}

export function evaluateEligibility(i: EligibilityInput): EligibilityResult {
  const ai = i.aiInvolved ?? defaultAiInvolved(i.actor, i.step);
  const modelStep = i.step !== 'send';
  const auto = i.actor === 'auto_care_reply';
  const rule = i.resolution?.status === 'active' ? i.resolution.rule : null;
  const wantsAutoSend = auto && rule?.mode === 'auto';
  const sending = i.step === 'send' || wantsAutoSend;

  // 1. Telegram AI: absolute, for the conversation and for any expansion source. The ONLY opening is an explicitly
  //    enabled Telegram BOT group (per-group gate, default off); context expansion from or into Telegram stays denied.
  if (ai) {
    if (i.step === 'context_expansion' && (i.channel === 'telegram' || i.expansion?.sourceChannel === 'telegram')) {
      return deny('telegram_ai_blocked');
    }
    if (i.channel === 'telegram' && i.telegramBotAi?.allowed !== true) return deny('telegram_ai_blocked');
  }

  // 2. Kill switches (injected, layered).
  const moduleOff = killSwitchOffLayer(i.killSwitches, 'module', i.channel, i.account.id);
  if (moduleOff) return deny('kill_switch_module', moduleOff);
  if (ai && (modelStep || auto)) {
    const aiOff = killSwitchOffLayer(i.killSwitches, 'ai', i.channel, i.account.id);
    if (aiOff) return deny('kill_switch_ai', aiOff);
  }
  let adjustment: DeliveryAdjustment | undefined;
  if (auto) {
    const autoOff = killSwitchOffLayer(i.killSwitches, 'auto_send', i.channel, i.account.id);
    if (autoOff) {
      // Nothing may be sent automatically; drafting for a person stays possible before send.
      if (i.step === 'send') return deny('kill_switch_auto_send', autoOff);
      if (wantsAutoSend) adjustment = { kind: 'to_draft', cause: 'kill_switch_auto_send' };
    }
  }

  // 3. Source / account gates.
  if (i.account.desiredState !== 'active') return deny('account_inactive', i.account.desiredState);
  if (i.account.writeOwner !== 'core') return deny('write_owner_not_core', i.account.writeOwner);
  if (ai && (modelStep || auto) && !i.account.aiEnabled) return deny('account_ai_disabled');
  if (auto && !i.account.syncEnabled) return deny('account_sync_disabled');
  if (sending && !adjustment && !i.account.sendEnabled) return deny('account_send_disabled');
  if (wantsAutoSend && !adjustment && i.account.healthStatus === 'error') return deny('account_unhealthy');

  // 4. Context-expansion source permission.
  if (i.step === 'context_expansion' && !i.expansion?.permitted) return deny('context_source_not_permitted');

  // 5. Assignment (system-initiated and manual model steps).
  if (modelStep && (auto || i.actor === 'manual_care_reply')) {
    if (!i.resolution || i.resolution.status === 'none') return deny('no_assignment');
    if (i.resolution.status === 'denied') return deny('assignment_disabled', i.resolution.rule.tier);
    if (auto && i.resolution.rule.mode === 'observe') return deny('observe_only');
  }

  // 6. Message-level gates over the customer burst (auto trigger only).
  if (auto && i.step === 'model_call' && rule) {
    const gate = evaluateMessageGates({
      channel: i.channel,
      conversationKind: i.conversation.kind,
      policy: rule.policy.values,
      burst: i.burst ?? [],
      nowMs: i.nowMs,
      ...i.messageGate,
    });
    if (!gate.ok) return deny(gate.reason satisfies MessageGateReason, gate.detail);
  }

  // 7. Conversation state.
  const optedOutApplies = auto || i.actor === 'approved_care_draft' || i.actor === 'marketing';
  if (optedOutApplies && i.conversation.isOptedOut) return deny('opted_out', 'conversation');
  if (auto) {
    const paused = i.conversation.isPaused && (i.conversation.pausedUntilMs === null || i.conversation.pausedUntilMs > i.nowMs);
    if (paused) return deny('conversation_paused');
    const pauseMin = rule?.policy.values.humanPauseMinutes ?? 0;
    const humanAt = i.lastHumanReplyAtMs ?? null;
    if (pauseMin > 0 && humanAt !== null && i.nowMs - humanAt < pauseMin * 60_000) return deny('human_active', 'pause_window');
    if (i.humanRepliedSinceMs !== undefined && i.humanRepliedSinceMs !== null && humanAt !== null && humanAt >= i.humanRepliedSinceMs) {
      return deny('human_active', 'during_run');
    }
  }

  // 8. Freshness.
  if ((auto || i.actor === 'approved_care_draft') && i.contextChanged) return deny('stale_context', 'context_changed');
  if (i.actor === 'approved_care_draft' && i.draftStale) return deny('stale_context', 'draft_stale');

  // 9. Consent (marketing).
  if (i.actor === 'marketing' && i.step === 'send' && i.marketingConsent !== true) return deny('marketing_consent_missing');

  // 10. Quotas, cooldown (model-time quotas only count at model_call so a run does not count twice).
  if (auto && i.step === 'model_call' && rule) {
    const max = rule.policy.values.maxRepliesPerThreadDay;
    if (max !== null && (i.usage?.threadRepliesToday ?? 0) >= max) return deny('thread_quota');
    const cap = i.limits?.agentDailyReplyCap;
    if (cap !== undefined && cap !== null && (i.usage?.agentRunsToday ?? 0) >= cap) return deny('agent_quota');
  }
  if (sending && !adjustment) {
    const cap = i.limits?.accountDailyCap;
    const applies = i.actor !== 'manual_care_reply';
    if (applies && cap !== undefined && cap !== null && (i.usage?.accountSendsToday ?? 0) >= cap) return deny('account_quota');
    if (i.cooldownUntilMs !== undefined && i.cooldownUntilMs !== null && i.cooldownUntilMs > i.nowMs) {
      return deny('cooldown_active', String(i.cooldownUntilMs));
    }
  }

  // 11. Quiet hours.
  if (i.quietHours?.active) {
    if (i.actor === 'marketing' && i.step === 'send') return deny('quiet_hours');
    if (wantsAutoSend && !adjustment) {
      const mode = rule!.policy.values.quietHoursMode;
      if (mode === 'block') return deny('quiet_hours');
      adjustment =
        mode === 'defer'
          ? { kind: 'defer', cause: 'quiet_hours', notBeforeMs: i.quietHours.endsAtMs ?? null }
          : { kind: 'to_draft', cause: 'quiet_hours' };
    }
  }

  return ok(adjustment);
}
