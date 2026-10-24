/**
 * Synthetic fixtures for the CC-10 policy tests. Pure data, no database, no network.
 * Not imported by production code.
 */

import type { CareAssignment, CareChannel } from '../../../_lib/care-kit/types.js';
import type { EligibilityInput, KillSwitchState } from './eligibility.js';
import { resolveEffectiveRule } from './assignment-resolver.js';
import type { GateMessage } from './message-gates.js';

export const NOW = Date.parse('2026-10-09T10:00:00Z');

let seq = 0;
export function assignment(over: Partial<CareAssignment> = {}): CareAssignment {
  seq += 1;
  return {
    id: `asg-${seq}`,
    accountId: 'acc',
    scope: 'account',
    scopeTarget: null,
    channel: null,
    customerId: null,
    priority: 100,
    enabled: true,
    mode: 'draft',
    agentId: 'cskh',
    instructionsRef: null,
    configVersion: 1,
    policyExt: null,
    ...over,
  };
}

export function gateMessage(over: Partial<GateMessage> = {}): GateMessage {
  seq += 1;
  return {
    id: `gm-${seq}`,
    origin: 'live',
    direction: 'in',
    senderRole: 'customer',
    senderKey: 'cust-1',
    sentAtMs: NOW - 60_000,
    text: 'chào shop, cho mình hỏi giá nhé',
    isDeleted: false,
    contentKind: 'text',
    directedAtAccount: false,
    mentionsAll: false,
    ...over,
  };
}

export function emailGateMessage(over: Partial<GateMessage> = {}, email: Partial<NonNullable<GateMessage['email']>> = {}): GateMessage {
  return gateMessage({
    senderKey: 'khach@example.com',
    text: 'Cho mình hỏi giá khoá học nhé',
    email: { from: 'khach@example.com', subject: 'Hỏi giá', headers: {}, category: 'primary', ...email },
    ...over,
  });
}

export function killSwitches(over: Partial<KillSwitchState> = {}): KillSwitchState {
  return { moduleEnabled: true, aiEnabled: true, autoSendEnabled: true, ...over };
}

export function eligibleInput(channel: CareChannel = 'zalo', over: Partial<EligibilityInput> = {}): EligibilityInput {
  const email = channel === 'email';
  const assignments = [
    assignment({ scope: 'account', accountId: 'acc', mode: 'auto', policyExt: null }),
  ];
  const resolution = resolveEffectiveRule(assignments, {
    accountId: 'acc',
    channel,
    conversationKey: 'conv-key',
    conversationKind: email ? 'email_thread' : 'direct',
  });
  return {
    nowMs: NOW,
    actor: 'auto_care_reply',
    step: 'model_call',
    channel,
    account: {
      id: 'acc',
      desiredState: 'active',
      writeOwner: 'core',
      aiEnabled: true,
      syncEnabled: true,
      sendEnabled: true,
      healthStatus: 'healthy',
    },
    conversation: { kind: email ? 'email_thread' : 'direct', isPaused: false, pausedUntilMs: null, isOptedOut: false },
    killSwitches: killSwitches(),
    resolution,
    burst: [email ? emailGateMessage() : gateMessage()],
    messageGate: { staleAfterMs: 72 * 3_600_000, ownAddress: 'shop@gmail.com', internalIdentityKeys: ['shop@gmail.com', 'other@gmail.com'] },
    lastHumanReplyAtMs: null,
    usage: { threadRepliesToday: 0, agentRunsToday: 0 },
    limits: { agentDailyReplyCap: 500 },
    cooldownUntilMs: null,
    quietHours: { active: false },
    ...over,
  };
}
